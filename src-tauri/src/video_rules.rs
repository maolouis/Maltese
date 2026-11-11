//! 刷视频插件的纯逻辑：标题匹配、浏览器识别、按键决策、配置校验。
//!
//! 这里刻意不依赖 Tauri / Win32，方便单独编译测试
//! （`rustc --test video_rules.rs` 就能跑，不需要链接 WebView2）。

/// 常见浏览器进程名。
pub const BROWSER_EXES: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "vivaldi.exe",
    "opera.exe",
    "opera_gx.exe",
    "360se.exe",
    "360chrome.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
    "liebao.exe",
    "2345explorer.exe",
    "maxthon.exe",
    "ucbrowser.exe",
];

/// 窗口标题里出现这些词就算目标站点。
pub fn title_matches(title: &str, provider: &str) -> bool {
    let title = title.to_lowercase();
    let keywords: &[&str] = if provider == "douyin" {
        &["抖音", "douyin"]
    } else {
        &["bilibili", "哔哩哔哩", "b站"]
    };
    keywords.iter().any(|keyword| title.contains(keyword))
}

/// 该进程是不是刷视频认可的「播放器」（浏览器或对应桌面客户端）。
pub fn is_browser_process(executable: &str, provider: &str) -> bool {
    let executable = executable.to_lowercase();
    if BROWSER_EXES.contains(&executable.as_str()) {
        return true;
    }
    (provider == "douyin" && executable == "douyin.exe")
        || (provider == "bilibili" && executable == "bilibili.exe")
}

/// 配置区间：翻页间隔 15–600 秒，单次上限 1–240 分钟。
pub fn validate_config(interval_seconds: u64, max_minutes: u64) -> Result<(), &'static str> {
    if !(15..=600).contains(&interval_seconds) {
        return Err("翻页间隔需要在 15 到 600 秒之间。");
    }
    if !(1..=240).contains(&max_minutes) {
        return Err("每日观看上限需要在 1 到 240 分钟之间。");
    }
    Ok(())
}

/// 平台只支持 bilibili / douyin。
pub fn normalize_provider(provider: &str) -> Result<&'static str, &'static str> {
    match provider.trim().to_lowercase().as_str() {
        "bilibili" => Ok("bilibili"),
        "douyin" => Ok("douyin"),
        _ => Err("只支持 bilibili 或 douyin。"),
    }
}

/// 这一轮该做什么。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    /// 往目标窗口发一次翻页按键。
    SendKey,
    /// 浏览器不在前台 / 窗口对不上，只等待，不抢焦点也不乱按键。
    Wait,
}

/// 决策：能定位到目标窗口并且它就在前台才发按键。
///
/// * `target_alive` —— 之前捕获的窗口句柄还有效；
/// * `foreground_is_target` —— 前台窗口就是它；
/// * `foreground_is_provider` —— 前台是浏览器/客户端且标题对得上（句柄失效时的兜底）；
pub fn next_action(target_alive: bool, foreground_is_target: bool, foreground_is_provider: bool) -> Action {
    if target_alive {
        if foreground_is_target {
            Action::SendKey
        } else {
            Action::Wait
        }
    } else if foreground_is_provider {
        Action::SendKey
    } else {
        Action::Wait
    }
}

/// 翻页键：B 站用 PageDown，抖音用 ↓。
pub fn page_key(provider: &str) -> &'static str {
    if provider == "douyin" {
        "ArrowDown"
    } else {
        "PageDown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_provider_window_titles() {
        assert!(title_matches("【测试】 - 哔哩哔哩_bilibili", "bilibili"));
        assert!(title_matches("哔哩哔哩 (゜-゜)つロ 干杯~", "bilibili"));
        assert!(title_matches("抖音 - 记录美好生活", "douyin"));
        assert!(title_matches("Douyin - Make Your Day", "douyin"));
        assert!(!title_matches("微信", "douyin"));
        assert!(!title_matches("Bilibili", "douyin"));
    }

    #[test]
    fn recognizes_mainstream_browsers_and_desktop_clients() {
        assert!(is_browser_process("chrome.exe", "bilibili"));
        assert!(is_browser_process("360se.exe", "douyin"));
        assert!(is_browser_process("msedge.exe", "douyin"));
        assert!(is_browser_process("douyin.exe", "douyin"));
        assert!(!is_browser_process("douyin.exe", "bilibili"));
        assert!(!is_browser_process("notepad.exe", "bilibili"));
    }

    #[test]
    fn validates_interval_and_duration_bounds() {
        assert!(validate_config(15, 1).is_ok());
        assert!(validate_config(600, 240).is_ok());
        assert!(validate_config(14, 30).is_err());
        assert!(validate_config(601, 30).is_err());
        assert!(validate_config(45, 0).is_err());
        assert!(validate_config(45, 241).is_err());
    }

    #[test]
    fn accepts_only_supported_providers() {
        assert_eq!(normalize_provider("Bilibili"), Ok("bilibili"));
        assert_eq!(normalize_provider(" douyin "), Ok("douyin"));
        assert!(normalize_provider("youtube").is_err());
        assert!(normalize_provider("").is_err());
    }

    #[test]
    fn sends_key_only_when_target_is_in_foreground() {
        // 句柄还在、窗口在前台 → 发按键
        assert_eq!(next_action(true, true, false), Action::SendKey);
        // 句柄还在、但用户切走了 → 只等待，不抢焦点
        assert_eq!(next_action(true, false, true), Action::Wait);
        // 句柄失效、但前台仍是浏览器且标题对得上 → 发按键
        assert_eq!(next_action(false, false, true), Action::SendKey);
        // 完全对不上 → 等待
        assert_eq!(next_action(false, false, false), Action::Wait);
    }

    #[test]
    fn picks_provider_specific_key() {
        assert_eq!(page_key("bilibili"), "PageDown");
        assert_eq!(page_key("douyin"), "ArrowDown");
    }
}