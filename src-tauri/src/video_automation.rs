use serde::{Deserialize, Serialize};
use std::{
    os::windows::process::CommandExt,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use windows::{
    core::{BOOL, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, RECT},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            Input::KeyboardAndMouse::{
                keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_DOWN, VK_NEXT,
            },
            WindowsAndMessaging::{
                EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowTextW,
                GetWindowThreadProcessId, IsWindow, IsWindowVisible,
            },
        },
    },
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
/// 首次翻页前给浏览器启动/加载留时间；之后使用用户配置的间隔。
const FIRST_ACTION_DELAY: u64 = 6;

const BROWSER_EXES: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "vivaldi.exe",
    "opera.exe",
    "opera_gx.exe",
    // 国内常见壳浏览器
    "360se.exe",
    "360chrome.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
    "liebao.exe",
    "2345explorer.exe",
    "maxthon.exe",
    "ucbrowser.exe",
];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAutomationConfig {
    pub interval_seconds: u64,
    pub max_minutes: u64,
}

impl Default for VideoAutomationConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 45,
            max_minutes: 30,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAutomationState {
    pub provider: String,
    pub running: bool,
    pub interval_seconds: u64,
    pub max_minutes: u64,
    pub steps: u64,
    pub started_at: Option<u64>,
    pub last_action_at: Option<u64>,
    pub current_url: String,
    pub waiting_for_browser: bool,
    pub foreground_title: String,
    pub foreground_process: String,
    pub error: Option<String>,
    /// 启动后捕获到的目标浏览器窗口；只在后端使用，不暴露给前端。
    #[serde(skip)]
    target_window: isize,
}

impl Default for VideoAutomationState {
    fn default() -> Self {
        Self {
            provider: "bilibili".to_string(),
            running: false,
            interval_seconds: 45,
            max_minutes: 30,
            steps: 0,
            started_at: None,
            last_action_at: None,
            current_url: String::new(),
            waiting_for_browser: false,
            foreground_title: String::new(),
            foreground_process: String::new(),
            error: None,
            target_window: 0,
        }
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<VideoAutomationState>> = OnceLock::new();
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static RUN_ID: AtomicU64 = AtomicU64::new(0);

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let _ = STATE.set(Mutex::new(VideoAutomationState::default()));
}

fn state() -> &'static Mutex<VideoAutomationState> {
    STATE.get_or_init(|| Mutex::new(VideoAutomationState::default()))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_video_automation_state() -> Result<VideoAutomationState, String> {
    state()
        .lock()
        .map(|value| value.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_video_automation_config(config: VideoAutomationConfig) -> Result<VideoAutomationState, String> {
    if !(15..=600).contains(&config.interval_seconds) {
        return Err("翻页间隔需要在 15 到 600 秒之间。".to_string());
    }
    if !(1..=240).contains(&config.max_minutes) {
        return Err("每日观看上限需要在 1 到 240 分钟之间。".to_string());
    }
    let mut current = state().lock().map_err(|error| error.to_string())?;
    current.interval_seconds = config.interval_seconds;
    current.max_minutes = config.max_minutes;
    Ok(current.clone())
}

#[tauri::command]
pub fn start_video_automation(provider: String) -> Result<VideoAutomationState, String> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider != "bilibili" && provider != "douyin" {
        return Err("只支持 bilibili 或 douyin。".to_string());
    }
    let (interval_seconds, max_minutes) = {
        let mut current = state().lock().map_err(|error| error.to_string())?;
        if current.running {
            return Ok(current.clone());
        }
        current.provider = provider.clone();
        current.running = true;
        current.steps = 0;
        current.started_at = Some(now_seconds());
        current.last_action_at = None;
        current.current_url = if provider == "bilibili" {
            "https://www.bilibili.com/".to_string()
        } else {
            "https://www.douyin.com/".to_string()
        };
        current.waiting_for_browser = false;
        current.foreground_title.clear();
        current.foreground_process.clear();
        current.target_window = 0;
        current.error = None;
        (current.interval_seconds, current.max_minutes)
    };

    let url = if provider == "bilibili" {
        "https://www.bilibili.com/"
    } else {
        "https://www.douyin.com/"
    };
    if let Err(error) = open_url(url) {
        if let Ok(mut current) = state().lock() {
            current.running = false;
            current.error = Some(error.clone());
        }
        return Err(error);
    }

    STOP_REQUESTED.store(false, Ordering::Relaxed);
    let run_id = RUN_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let app = APP.get().cloned();
    thread::spawn(move || {
        let mut wait_seconds = FIRST_ACTION_DELAY;
        loop {
            thread::sleep(Duration::from_secs(wait_seconds.max(1)));
            wait_seconds = interval_seconds;
            if STOP_REQUESTED.load(Ordering::Relaxed) || RUN_ID.load(Ordering::Relaxed) != run_id {
                break;
            }

            let foreground = foreground_info();
            let should_stop = {
                let mut current = match state().lock() {
                    Ok(current) => current,
                    Err(_) => break,
                };
                if !current.running {
                    true
                } else if let Some(started_at) = current.started_at {
                    if now_seconds().saturating_sub(started_at) >= max_minutes.saturating_mul(60) {
                        current.running = false;
                        current.waiting_for_browser = false;
                        current.target_window = 0;
                        current.error = None;
                        true
                    } else {
                        if let Some(info) = foreground.as_ref() {
                            current.foreground_title = info.title.clone();
                            current.foreground_process = info.executable.clone();
                        }

                        // 第一次执行时捕获目标窗口；之后即使页面标题变化（例如抖音
                        // 切到单个视频后标题不再含“抖音”），也继续认同一个窗口。
                        if current.target_window == 0 {
                            current.target_window =
                                find_target_browser(&current.provider).map(|h| h.0 as isize).unwrap_or(0);
                        }

                        let target = HWND(current.target_window as *mut _);
                        let target_alive = !target.is_invalid()
                            && unsafe { IsWindow(Some(target)).as_bool() };
                        let active = if target_alive {
                            foreground.as_ref().is_some_and(|info| info.hwnd == target)
                        } else {
                            current.target_window = 0;
                            foreground.as_ref().is_some_and(|info| {
                                is_browser_process(&info.executable, &current.provider)
                                    && title_matches(&info.title, &current.provider)
                            })
                        };

                        if active {
                            let key = if current.provider == "douyin" {
                                VK_DOWN
                            } else {
                                VK_NEXT
                            };
                            unsafe {
                                keybd_event(key.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
                                keybd_event(key.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                            }
                            if current.target_window == 0 {
                                if let Some(info) = foreground.as_ref() {
                                    current.target_window = info.hwnd.0 as isize;
                                }
                            }
                            current.waiting_for_browser = false;
                            current.steps = current.steps.saturating_add(1);
                            current.last_action_at = Some(now_seconds());
                        } else {
                            // 浏览器不在前台/标题不匹配时只等待，不抢焦点、不乱按键。
                            current.waiting_for_browser = true;
                        }
                        false
                    }
                } else {
                    true
                }
            };
            if let Some(app) = app.as_ref() {
                if let Ok(snapshot) = get_video_automation_state() {
                    let _ = app.emit("video-automation-updated", snapshot);
                }
            }
            if should_stop {
                break;
            }
        }
    });

    get_video_automation_state()
}

#[tauri::command]
pub fn stop_video_automation() -> Result<VideoAutomationState, String> {
    STOP_REQUESTED.store(true, Ordering::Relaxed);
    RUN_ID.fetch_add(1, Ordering::Relaxed);
    let mut current = state().lock().map_err(|error| error.to_string())?;
    current.running = false;
    current.started_at = None;
    current.waiting_for_browser = false;
    current.target_window = 0;
    get_video_automation_state()
}

struct WindowInfo {
    hwnd: HWND,
    title: String,
    executable: String,
}

fn window_title(window: HWND) -> String {
    let mut title = [0u16; 512];
    let length = unsafe { GetWindowTextW(window, &mut title) } as usize;
    String::from_utf16_lossy(&title[..length.min(title.len())])
}

fn process_executable(window: HWND) -> Option<String> {
    unsafe {
        let mut process_id = 0;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        let readable = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !readable {
            return None;
        }
        std::path::Path::new(&String::from_utf16_lossy(&path[..length as usize]))
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
    }
}

fn foreground_info() -> Option<WindowInfo> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let executable = process_executable(hwnd)?;
        Some(WindowInfo {
            hwnd,
            title: window_title(hwnd),
            executable,
        })
    }
}

fn is_browser_process(executable: &str, provider: &str) -> bool {
    if BROWSER_EXES.contains(&executable) {
        return true;
    }
    (provider == "douyin" && executable == "douyin.exe")
        || (provider == "bilibili" && executable == "bilibili.exe")
}

fn title_matches(title: &str, provider: &str) -> bool {
    let title = title.to_ascii_lowercase();
    let keywords: &[&str] = if provider == "douyin" {
        &["抖音", "douyin"]
    } else {
        &["bilibili", "哔哩哔哩", "b站"]
    };
    keywords.iter().any(|keyword| title.contains(keyword))
}

struct TargetSearch<'a> {
    provider: &'a str,
    found: Option<HWND>,
}

unsafe extern "system" fn find_target_window(window: HWND, context: LPARAM) -> BOOL {
    let search = &mut *(context.0 as *mut TargetSearch);
    if !IsWindowVisible(window).as_bool() {
        return true.into();
    }
    if !title_matches(&window_title(window), search.provider) {
        return true.into();
    }
    let Some(executable) = process_executable(window) else {
        return true.into();
    };
    if !is_browser_process(&executable, search.provider) {
        return true.into();
    }
    let mut rect = RECT::default();
    if GetWindowRect(window, &mut rect).is_err()
        || rect.right - rect.left < 500
        || rect.bottom - rect.top < 300
    {
        return true.into();
    }
    search.found = Some(window);
    false.into()
}

fn find_target_browser(provider: &str) -> Option<HWND> {
    let mut search = TargetSearch {
        provider,
        found: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(find_target_window),
            LPARAM((&mut search as *mut TargetSearch) as isize),
        );
    }
    search.found
}

fn open_url(url: &str) -> Result<(), String> {
    Command::new("cmd.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开视频浏览器：{error}"))
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
    #[ignore = "Requires an open browser window whose title contains 哔哩哔哩/Bilibili"]
    fn finds_live_bilibili_browser_window() {
        assert!(find_target_browser("bilibili").is_some());
    }
}