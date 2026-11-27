//! 主窗口 WebView2 用户数据目录守卫（P1-B：主窗口遇 `ERROR_BUSY 0x800700AA` 自动退避重试与备用目录自愈）。
//!
//! 背景：
//! - `tauri.conf.json` 中的 `main` 窗口由 `tauri::Builder::build` 在进入 `.setup()` 之前同步创建；
//! - Windows 下 WebView2 默认使用 `%LOCALAPPDATA%\<identifier>\EBWebView`，并以独占文件句柄持有
//!   `EBWebView\lockfile`；
//! - 当上一实例的 `msedgewebview2.exe` 仍在退出（100~900ms 窗口），或残留进程/只读权限锁死默认目录时，
//!   wry 建窗直接失败（`0x800700AA` / `os error 5`），只在 manager 留下无句柄死壳，导致主窗口永远不出现。
//!
//! 方案：
//! 1. 在 `tauri::Builder` 建窗前检测目标目录可写性及 `EBWebView\lockfile` 是否被其它进程占用；
//! 2. 若被占用，按 `150ms -> 350ms -> 700ms` 退避重试，优先等旧进程释放以保留用户原 localStorage；
//! 3. 若退避后仍被锁死或无写权限，自动切换到 `<data_root>\webview2-fallback-<1..4>`（再兜底 `%TEMP%`）
//!    设置 `WEBVIEW2_USER_DATA_FOLDER`，保证主窗口 100% 能建立并显示，同时落盘诊断日志。

use std::{
    fs::{self, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const BACKOFF_MS: [u64; 3] = [150, 350, 700];
const FALLBACK_SLOTS: usize = 4;

/// 解析默认（未覆盖时）主窗口使用的 WebView2 用户数据根目录。
pub fn default_webview2_user_data_dir(identifier: &str) -> PathBuf {
    if let Some(explicit) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return explicit;
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
}

/// 检测指定 WebView2 用户数据目录当前是否可写且未被其它 WebView2 进程独占锁定。
pub fn probe_webview2_dir_available(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("create_dir_all({}): {error}", dir.display()))?;

    let write_probe = dir.join(format!(".maltese-wv2-probe-{}", std::process::id()));
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&write_probe)
        .map_err(|error| format!("write_probe({}): {error}", write_probe.display()))?;
    let _ = fs::remove_file(&write_probe);

    // Chromium / WebView2 运行期间始终持有 `<user_data_dir>\EBWebView\lockfile`（或直接 `<dir>\lockfile`）句柄。
    // 用 `share_mode(0)` 尝试独占打开：只要系统里有任何进程还握着该文件句柄，Windows 立即返回
    // `ERROR_SHARING_VIOLATION (os error 32)`；无人持有则瞬间打开并立即 drop 释放，不影响后续建窗。
    for lock_candidate in [dir.join("EBWebView").join("lockfile"), dir.join("lockfile")] {
        if !lock_candidate.exists() {
            continue;
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&lock_candidate)
            .map_err(|error| format!("lockfile_busy({}): {error}", lock_candidate.display()))?;
    }

    Ok(())
}

/// 生成候选备用 profile 目录列表（优先 `<data_root>\webview2-fallback-N`，兜底 `%TEMP%`）。
pub fn fallback_candidates(data_root: &Path, identifier: &str) -> Vec<PathBuf> {
    let mut list = Vec::with_capacity(FALLBACK_SLOTS * 2);
    for index in 1..=FALLBACK_SLOTS {
        list.push(data_root.join(format!("webview2-fallback-{index}")));
    }
    let temp = std::env::temp_dir();
    for index in 1..=FALLBACK_SLOTS {
        list.push(temp.join(format!("{identifier}-webview2-fallback-{index}")));
    }
    list
}

/// 在 `tauri::Builder` 建主窗口之前确保 WebView2 用户数据目录可用；必要时自动切到备用目录。
pub fn ensure_main_webview2_profile(identifier: &str, data_root: &Path) -> PathBuf {
    let primary = default_webview2_user_data_dir(identifier);
    let mut last_error = String::new();

    for attempt in 0..=BACKOFF_MS.len() {
        if attempt > 0 {
            let wait_ms = BACKOFF_MS[attempt - 1];
            eprintln!(
                "MAIN_WEBVIEW2_PROFILE phase=retry attempt={attempt} backoffMs={wait_ms} dir={} reason={last_error}",
                primary.display()
            );
            thread::sleep(Duration::from_millis(wait_ms));
        }
        match probe_webview2_dir_available(&primary) {
            Ok(()) => {
                if attempt > 0 {
                    crate::paths::startup_log(&format!(
                        "MAIN_WEBVIEW2_PROFILE status=recovered-primary attempts={} dir={}",
                        attempt + 1,
                        primary.display()
                    ));
                } else {
                    eprintln!(
                        "MAIN_WEBVIEW2_PROFILE status=primary dir={}",
                        primary.display()
                    );
                }
                return primary;
            }
            Err(error) => {
                last_error = error;
            }
        }
    }

    for (index, candidate) in fallback_candidates(data_root, identifier)
        .into_iter()
        .enumerate()
    {
        if candidate == primary {
            continue;
        }
        if probe_webview2_dir_available(&candidate).is_ok() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &candidate);
            crate::paths::startup_log(&format!(
                "MAIN_WEBVIEW2_PROFILE status=fallback slot={} primary={} fallback={} reason={last_error}",
                index + 1,
                primary.display(),
                candidate.display()
            ));
            return candidate;
        }
    }

    crate::paths::startup_log(&format!(
        "MAIN_WEBVIEW2_PROFILE status=exhausted dir={} reason={last_error}",
        primary.display()
    ));
    primary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_detects_exclusive_lock_on_ebwebview_lockfile() {
        let dir = std::env::temp_dir().join(format!("maltese-wv2-test-{}", std::process::id()));
        let eb = dir.join("EBWebView");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&eb).expect("create EBWebView");
        let lock_path = eb.join("lockfile");

        // 模拟另一个 WebView2 进程正持有 lockfile（即使允许共享读，share_mode(0) 探测也能立即识别占用）。
        let held = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .share_mode(1)
            .open(&lock_path)
            .expect("hold lockfile");

        let busy = probe_webview2_dir_available(&dir);
        assert!(busy.is_err(), "held lockfile must be detected as busy");

        drop(held);
        let free = probe_webview2_dir_available(&dir);
        assert!(free.is_ok(), "released lockfile must pass probe: {free:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fallback_candidates_prioritize_data_root() {
        let root = PathBuf::from(r"E:\Maltese\data");
        let list = fallback_candidates(&root, "com.maolouis.maltese");
        assert!(list.len() >= 4);
        assert_eq!(list[0], root.join("webview2-fallback-1"));
    }
}
