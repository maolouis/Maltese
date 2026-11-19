//! 刷视频插件的纯规则：标题匹配、浏览器识别、按键决策、配置校验。
//!
//! 刻意不依赖 Tauri / Win32，方便单独编译测试。

use super::model::{ChannelType, Platform};

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
pub fn title_matches(title: &str, platform: Platform) -> bool {
    let title = title.to_lowercase();
    let keywords: &[&str] = match platform {
        Platform::Douyin => &["抖音", "douyin"],
        Platform::Bilibili => &["bilibili", "哔哩哔哩", "b站"],
        Platform::Xiaohongshu => &["小红书", "xiaohongshu", "rednote"],
    };
    keywords.iter().any(|keyword| title.contains(keyword))
}

/// 该进程是不是刷视频认可的「播放器」（浏览器或对应桌面客户端）。
pub fn is_browser_process(executable: &str, platform: Platform) -> bool {
    let executable = executable.to_lowercase();
    if BROWSER_EXES.contains(&executable.as_str()) {
        return true;
    }
    match platform {
        Platform::Douyin => executable == "douyin.exe",
        Platform::Bilibili => executable == "bilibili.exe",
        Platform::Xiaohongshu => false,
    }
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
    /// CDP 可用：在专用浏览器里用脚本驱动翻页。
    DrivePage,
    /// 往目标窗口发一次翻页按键（仅在 CDP 不可用、窗口在前台时）。
    SendKey,
    /// 页面里有用户输入或用户接管，本轮不翻页。
    WaitForUser,
    /// 浏览器不在前台 / 窗口对不上，只等待。
    Wait,
}

/// 决策：CDP 可用时永远走页面脚本；否则只有目标窗口在前台才发按键。
pub fn next_action(
    cdp_ready: bool,
    target_alive: bool,
    foreground_is_target: bool,
    user_takeover: bool,
) -> Action {
    if user_takeover {
        Action::WaitForUser
    } else if cdp_ready {
        Action::DrivePage
    } else if target_alive && foreground_is_target {
        Action::SendKey
    } else {
        Action::Wait
    }
}

/// 翻页键：B 站用 PageDown，抖音用 ↓。
pub fn page_key(platform: Platform) -> &'static str {
    match platform {
        Platform::Douyin => "ArrowDown",
        Platform::Bilibili => "PageDown",
        Platform::Xiaohongshu => "PageDown",
    }
}

/// 通道按能力从高到低排列。
pub fn channel_chain() -> &'static [ChannelType] {
    &[
        ChannelType::Cdp,
        ChannelType::Extension,
        ChannelType::Uia,
        ChannelType::Smtc,
        ChannelType::WindowTitle,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_provider_window_titles() {
        assert!(title_matches("【测试】 - 哔哩哔哩_bilibili", Platform::Bilibili));
        assert!(title_matches("哔哩哔哩 (゜-゜)つロ 干杯~", Platform::Bilibili));
        assert!(title_matches("抖音 - 记录美好生活", Platform::Douyin));
        assert!(title_matches("Douyin - Make Your Day", Platform::Douyin));
        assert!(!title_matches("微信", Platform::Douyin));
        assert!(!title_matches("Bilibili", Platform::Douyin));
    }

    #[test]
    fn recognizes_mainstream_browsers_and_desktop_clients() {
        assert!(is_browser_process("chrome.exe", Platform::Bilibili));
        assert!(is_browser_process("360se.exe", Platform::Douyin));
        assert!(is_browser_process("msedge.exe", Platform::Douyin));
        assert!(is_browser_process("douyin.exe", Platform::Douyin));
        assert!(!is_browser_process("douyin.exe", Platform::Bilibili));
        assert!(!is_browser_process("notepad.exe", Platform::Bilibili));
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
    fn sends_key_only_as_fallback_in_foreground() {
        assert_eq!(next_action(true, true, true, false), Action::DrivePage);
        assert_eq!(next_action(true, false, false, false), Action::DrivePage);
        assert_eq!(next_action(false, true, true, false), Action::SendKey);
        assert_eq!(next_action(false, true, false, false), Action::Wait);
        assert_eq!(next_action(false, false, true, false), Action::Wait);
        assert_eq!(next_action(true, true, true, true), Action::WaitForUser);
        assert_eq!(next_action(false, true, true, true), Action::WaitForUser);
        assert_eq!(next_action(false, false, false, false), Action::Wait);
    }

    #[test]
    fn picks_provider_specific_key() {
        assert_eq!(page_key(Platform::Bilibili), "PageDown");
        assert_eq!(page_key(Platform::Douyin), "ArrowDown");
    }

    #[test]
    fn channel_chain_has_five_levels() {
        assert_eq!(channel_chain().len(), 5);
        assert_eq!(channel_chain()[0], ChannelType::Cdp);
        assert_eq!(channel_chain()[4], ChannelType::WindowTitle);
    }
}