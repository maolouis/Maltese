//! 浏览器实例管理：发现、启动、端口与退出检测。
//!
//! 小狗使用独立 `--user-data-dir` 的有窗口浏览器；除首次登录外不调用任何
//! 前景化 API，也不使用无界面模式。

use super::model::{now_seconds, Platform};
use super::{VideoError, VideoResult};
use serde::{Deserialize, Serialize};
use std::{
    net::TcpListener,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::Duration,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
pub const DEFAULT_PORT: u16 = 9333;
pub const MIN_MAJOR_VERSION: u32 = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHandle {
    pub pid: u32,
    pub port: u16,
    pub profile_dir: String,
    pub started_at: u64,
    pub executable: String,
}

pub struct BrowserProcess {
    pub handle: BrowserHandle,
    child: Child,
}

impl BrowserProcess {
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn close(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn working_set_mb(&self) -> Option<u64> {
        working_set_mb(self.handle.pid)
    }

    pub fn occupancy(&self) -> &'static str {
        occupancy_level(self.working_set_mb().unwrap_or(0))
    }
}

pub fn occupancy_level(working_set_mb: u64) -> &'static str {
    if working_set_mb < 400 {
        "low"
    } else if working_set_mb <= 900 {
        "mid"
    } else {
        "high"
    }
}

pub fn profile_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Maltese")
        .join("video-profile")
}

pub fn candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = std::env::var_os("MALTESE_TEST_BROWSER_PATH") {
        candidates.push(PathBuf::from(value));
    }
    for root in [
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        let root = PathBuf::from(root);
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Programs/Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
    }
    candidates
}

pub fn find_browser() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| path.is_file())
}

/// 从文件版本信息读主版本；读取失败返回 None（不阻塞启动）。
pub fn browser_major_version(path: &Path) -> Option<u32> {
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductMajorPart"
    );
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// 端口占用时换备用端口，最多重试 5 次。
pub fn pick_port(preferred: u16) -> VideoResult<u16> {
    for offset in 0..=5u16 {
        let candidate = preferred.saturating_add(offset);
        if candidate == 0 {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }
    Err(VideoError::new(
        "PORT_BUSY",
        "本机调试端口被占用，无法启动小狗浏览器。",
    ))
}

pub fn launch(
    platform: Platform,
    port: u16,
    profile: &Path,
    login_window: bool,
) -> VideoResult<BrowserProcess> {
    let executable = find_browser().ok_or_else(|| {
        VideoError::new(
            "BROWSER_UNAVAILABLE",
            "没有找到 Chrome 或 Edge（需要 120 及以上版本）。",
        )
    })?;
    if let Some(major) = browser_major_version(&executable) {
        if major < MIN_MAJOR_VERSION {
            return Err(VideoError::with_detail(
                "BROWSER_UNAVAILABLE",
                "浏览器版本过低，需要 Chrome/Edge 120 及以上。",
                format!("检测到主版本 {major}"),
            ));
        }
    }
    if profile.as_os_str().is_empty() {
        return Err(VideoError::new("START_FAILED", "登录 profile 目录无效。"));
    }
    std::fs::create_dir_all(profile).map_err(|error| {
        VideoError::with_detail("START_FAILED", "无法创建登录 profile 目录。", error.to_string())
    })?;

    let mut command = Command::new(&executable);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--remote-allow-origins=http://127.0.0.1:{port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(if login_window {
            platform.feed_url()
        } else {
            "about:blank"
        });
    if login_window {
        command.arg("--new-window");
    }
    let child = command.spawn().map_err(|error| {
        VideoError::with_detail("START_FAILED", "无法启动小狗浏览器。", error.to_string())
    })?;

    Ok(BrowserProcess {
        handle: BrowserHandle {
            pid: child.id(),
            port,
            profile_dir: profile.to_string_lossy().to_string(),
            started_at: now_seconds(),
            executable: executable.to_string_lossy().to_string(),
        },
        child,
    })
}

#[cfg(windows)]
fn working_set_mb(pid: u32) -> Option<u64> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let ok = K32GetProcessMemoryInfo(
            process,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        let _ = CloseHandle(process);
        if ok.as_bool() {
            Some(counters.WorkingSetSize as u64 / 1024 / 1024)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn working_set_mb(_pid: u32) -> Option<u64> {
    None
}

pub fn wait_for_process_exit(process: &mut BrowserProcess, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if !process.is_alive() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// 仅用于「打开登录窗」这一显式路径；其他流程不得调用前景化 API。
#[cfg(windows)]
pub fn focus_browser_window(platform: Platform) -> bool {
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
                SetForegroundWindow,
            },
        },
    };

    struct Search {
        platform: Platform,
        found: Option<HWND>,
    }

    unsafe extern "system" fn callback(window: HWND, context: LPARAM) -> BOOL {
        let search = &mut *(context.0 as *mut Search);
        if !IsWindowVisible(window).as_bool() {
            return true.into();
        }
        let mut title = [0u16; 512];
        let length = GetWindowTextW(window, &mut title) as usize;
        let title = String::from_utf16_lossy(&title[..length.min(title.len())]);
        if !super::rules::title_matches(&title, search.platform) {
            return true.into();
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == 0 {
            return true.into();
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return true.into();
        };
        let mut path = [0u16; 32768];
        let mut path_length = path.len() as u32;
        let readable = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !readable {
            return true.into();
        }
        let executable = std::path::Path::new(&String::from_utf16_lossy(
            &path[..path_length as usize],
        ))
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
        if super::rules::is_browser_process(&executable, search.platform) {
            search.found = Some(window);
            return false.into();
        }
        true.into()
    }

    let mut search = Search {
        platform,
        found: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(callback),
            LPARAM((&mut search as *mut Search) as isize),
        );
    }
    match search.found {
        Some(window) => unsafe { SetForegroundWindow(window).as_bool() },
        None => false,
    }
}

#[cfg(not(windows))]
pub fn focus_browser_window(_platform: Platform) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occupancy_levels_are_split_at_expected_boundaries() {
        assert_eq!(occupancy_level(399), "low");
        assert_eq!(occupancy_level(400), "mid");
        assert_eq!(occupancy_level(900), "mid");
        assert_eq!(occupancy_level(901), "high");
    }

    #[test]
    fn candidate_paths_include_chrome_and_edge() {
        let paths = candidate_paths();
        assert!(paths.iter().any(|path| path.ends_with("chrome.exe")));
        assert!(paths.iter().any(|path| path.ends_with("msedge.exe")));
    }

    #[test]
    fn profile_dir_is_under_local_app_data() {
        let dir = profile_dir();
        assert!(dir.ends_with("video-profile"));
    }

    #[test]
    fn pick_port_returns_available_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let picked = pick_port(port).expect("port");
        assert!(picked >= port);
    }

    #[test]
    fn launch_without_browser_returns_stable_code() {
        std::env::set_var("MALTESE_TEST_BROWSER_PATH", "Z:\\definitely-missing\\chrome.exe");
        let result = launch(Platform::Bilibili, 9333, &profile_dir(), false);
        std::env::remove_var("MALTESE_TEST_BROWSER_PATH");
        let error = result.expect_err("missing browser");
        assert_eq!(error.code, "BROWSER_UNAVAILABLE");
    }
}