use crate::{
    wechat_ocr::{self, ChatPreview},
    wechat_reminder_source::{
        installed_executable, normalized_path, ReminderListener, ReminderSignal,
    },
};
use serde::Serialize;
use std::{
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{BOOL, PWSTR},
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND, LPARAM},
        System::Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowPlacement, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, WINDOWPLACEMENT,
        },
    },
};

static SERVICE: OnceLock<Arc<ReminderService>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSnapshot {
    revision: u64,
    enabled: bool,
    status: String,
    pending: bool,
    last_attention_at: Option<u64>,
    error: Option<String>,
    title: Option<String>,
    body: Option<String>,
    content_error: Option<String>,
    read_content: bool,
}

impl Default for ReminderSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            enabled: false,
            status: "disabled".into(),
            pending: false,
            last_attention_at: None,
            error: None,
            title: None,
            body: None,
            content_error: None,
            read_content: true,
        }
    }
}

struct ReminderState {
    snapshot: ReminderSnapshot,
    generation: u64,
    read_content: bool,
}

impl Default for ReminderState {
    fn default() -> Self {
        Self {
            snapshot: ReminderSnapshot::default(),
            generation: 0,
            // 默认开启本地 OCR；图像只在内存中处理，不落盘、不上传。
            read_content: true,
        }
    }
}

impl ReminderState {
    fn set_enabled(&mut self, enabled: bool) -> bool {
        if self.snapshot.enabled == enabled {
            return false;
        }
        self.generation += 1;
        self.snapshot = ReminderSnapshot {
            revision: self.snapshot.revision + 1,
            enabled,
            status: if enabled { "waiting" } else { "disabled" }.into(),
            read_content: self.read_content,
            ..Default::default()
        };
        true
    }

    #[cfg(test)]
    fn apply(&mut self, generation: u64, signal: ReminderSignal, now: u64) -> bool {
        self.apply_with_content(generation, signal, now, None)
    }

    fn apply_with_content(
        &mut self,
        generation: u64,
        signal: ReminderSignal,
        now: u64,
        content: Option<ChatPreview>,
    ) -> bool {
        if !self.snapshot.enabled || self.generation != generation {
            return false;
        }
        match signal {
            ReminderSignal::Attention => {
                let first = !self.snapshot.pending;
                let title = content.as_ref().map(|item| item.title.clone());
                let body = content.as_ref().map(|item| item.body.clone());
                if first {
                    self.snapshot.pending = true;
                    self.snapshot.last_attention_at = Some(now);
                    self.snapshot.content_error = None;
                }
                let changed = first
                    || (title.is_some()
                        && (self.snapshot.title != title || self.snapshot.body != body));
                if changed {
                    if title.is_some() {
                        self.snapshot.title = title;
                        self.snapshot.body = body;
                        self.snapshot.content_error = None;
                    }
                } else if !first {
                    return false;
                }
            }
            ReminderSignal::Activated if self.snapshot.pending => self.snapshot.pending = false,
            _ => return false,
        }
        self.snapshot.revision += 1;
        true
    }

    fn set_read_content(&mut self, enabled: bool) -> bool {
        if self.read_content == enabled {
            return false;
        }
        self.read_content = enabled;
        self.snapshot.read_content = enabled;
        if !enabled {
            self.snapshot.title = None;
            self.snapshot.body = None;
            self.snapshot.content_error = None;
        }
        self.snapshot.revision += 1;
        true
    }
}

struct ReminderService {
    app: AppHandle,
    state: Mutex<ReminderState>,
    wake: mpsc::SyncSender<()>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }
    let (wake, receiver) = mpsc::sync_channel(1);
    let service = Arc::new(ReminderService {
        app: app.clone(),
        state: Mutex::new(ReminderState::default()),
        wake,
    });
    let worker = service.clone();
    thread::Builder::new()
        .name("wechat-reminders".into())
        .spawn(move || monitor(worker, receiver))
        .map_err(|error| format!("无法启动微信提醒监听：{error}"))?;
    SERVICE
        .set(service)
        .map_err(|_| "微信提醒服务已启动。".to_string())
}

fn service() -> Result<&'static Arc<ReminderService>, String> {
    SERVICE.get().ok_or_else(|| "微信提醒服务尚未就绪。".into())
}

fn publish(service: &ReminderService, snapshot: ReminderSnapshot) {
    let visible = service
        .app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    let _ = service.app.emit_to(
        "main",
        "wechat-reminder-changed",
        serde_json::json!({"snapshot": snapshot, "windowVisible": visible}),
    );
}

#[tauri::command]
pub fn get_wechat_reminder_state() -> Result<ReminderSnapshot, String> {
    Ok(service()?
        .state
        .lock()
        .map_err(|_| "微信提醒状态不可用。")?
        .snapshot
        .clone())
}

pub(crate) fn diagnostic_state() -> Result<serde_json::Value, String> {
    let state = service()?
        .state
        .lock()
        .map_err(|_| "微信提醒状态不可用。")?;
    Ok(serde_json::json!({
        "enabled": state.snapshot.enabled,
        "status": state.snapshot.status,
        "pending": state.snapshot.pending,
        "lastAttentionAt": state.snapshot.last_attention_at,
        "error": state.snapshot.error,
    }))
}

#[tauri::command]
pub fn set_wechat_reminders_enabled(enabled: bool) -> Result<ReminderSnapshot, String> {
    let service = service()?;
    let (snapshot, changed) = {
        let mut state = service.state.lock().map_err(|_| "微信提醒状态不可用。")?;
        let changed = state.set_enabled(enabled);
        (state.snapshot.clone(), changed)
    };
    if changed {
        publish(service, snapshot.clone());
        let _ = service.wake.try_send(());
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn set_wechat_read_content(enabled: bool) -> Result<ReminderSnapshot, String> {
    let service = service()?;
    let (snapshot, changed) = {
        let mut state = service.state.lock().map_err(|_| "微信提醒状态不可用。")?;
        let changed = state.set_read_content(enabled);
        (state.snapshot.clone(), changed)
    };
    if changed {
        publish(service, snapshot.clone());
    }
    Ok(snapshot)
}

fn signal(service: &ReminderService, generation: u64, event: ReminderSignal) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    // 先尝试读取会话列表，再把“有新消息”和真实内容放在同一次事件里发出，
    // 避免先弹一条通用气泡、一秒后又弹一条带内容的。
    let should_read = event == ReminderSignal::Attention
        && service.state.lock().is_ok_and(|state| {
            state.snapshot.enabled
                && state.generation == generation
                && (!state.snapshot.pending || state.snapshot.title.is_none())
                && state.read_content
        });
    let mut content_error = None;
    let content = if should_read {
        match content_window() {
            Some(window) => match wechat_ocr::read_chat_preview(window) {
                Ok(preview) => {
                    if preview.is_none() {
                        content_error = Some(
                            "微信窗口已最小化，无法读取会话预览；保持微信窗口打开即可显示正文。"
                                .to_string(),
                        );
                    }
                    preview
                }
                Err(error) => {
                    content_error = Some(error);
                    None
                }
            },
            None => {
                content_error = Some(
                    "未找到已打开的微信主窗口；请从任务栏打开微信后重试。".to_string(),
                );
                None
            }
        }
    } else {
        None
    };
    let snapshot = {
        let Ok(mut state) = service.state.lock() else {
            return;
        };
        if !state.apply_with_content(generation, event, now, content) {
            return;
        }
        if event == ReminderSignal::Attention && content_error.is_some() {
            state.snapshot.content_error = content_error;
        }
        state.snapshot.clone()
    };
    publish(service, snapshot);
}

fn content_window() -> Option<HWND> {
    let executable = installed_executable().ok()?;
    let search = existing_wechat_windows(&executable).ok()?;
    preferred_window(&search.found).map(|window| window.handle)
}

fn connection(service: &ReminderService, generation: u64, error: Option<String>) {
    let snapshot = {
        let Ok(mut state) = service.state.lock() else {
            return;
        };
        if !state.snapshot.enabled || state.generation != generation {
            return;
        }
        let status = if error.is_some() {
            "error"
        } else {
            "listening"
        };
        if state.snapshot.status == status && state.snapshot.error == error {
            return;
        }
        state.snapshot.status = status.into();
        state.snapshot.error = error;
        state.snapshot.revision += 1;
        state.snapshot.clone()
    };
    publish(service, snapshot);
}

fn monitor(service: Arc<ReminderService>, receiver: mpsc::Receiver<()>) {
    loop {
        let (enabled, generation) = match service.state.lock() {
            Ok(state) => (state.snapshot.enabled, state.generation),
            Err(_) => return,
        };
        if !enabled {
            if receiver.recv().is_err() {
                return;
            }
            continue;
        }
        let callback_service = service.clone();
        let listener = installed_executable().and_then(|executable| {
            ReminderListener::new(executable, move |event| {
                signal(&callback_service, generation, event)
            })
        });
        match listener {
            Ok(listener) => {
                connection(&service, generation, None);
                loop {
                    if !service
                        .state
                        .lock()
                        .is_ok_and(|state| state.snapshot.enabled && state.generation == generation)
                    {
                        break;
                    }
                    listener.poll();
                    let _ = listener.stats();
                    if receiver.recv_timeout(Duration::from_millis(50))
                        == Err(mpsc::RecvTimeoutError::Disconnected)
                    {
                        return;
                    }
                }
            }
            Err(error) => {
                connection(&service, generation, Some(error));
                if receiver.recv_timeout(Duration::from_secs(5))
                    == Err(mpsc::RecvTimeoutError::Disconnected)
                {
                    return;
                }
            }
        }
    }
}

#[tauri::command]
pub async fn open_wechat() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let executable = installed_executable()?;
        if activate_existing_wechat(&executable)? {
            return Ok(());
        }
        Err("未找到正在运行的微信窗口，请先打开并登录桌面版微信。".into())
    })
    .await
    .map_err(|error| format!("打开微信的线程失败：{error}"))?
}

struct WeChatWindow {
    handle: HWND,
    started_at: u64,
    main_sized: bool,
    visible: bool,
}

struct WindowSearch {
    executable: String,
    found: Vec<WeChatWindow>,
    running: bool,
}

fn preferred_window(windows: &[WeChatWindow]) -> Option<&WeChatWindow> {
    // Only full main windows qualify; prefer the visible window, then the older instance.
    windows
        .iter()
        .filter(|window| window.main_sized)
        .min_by_key(|window| (!window.visible, window.started_at))
}

unsafe extern "system" fn find_wechat_window(window: HWND, context: LPARAM) -> BOOL {
    let search = &mut *(context.0 as *mut WindowSearch);
    let mut process_id = 0;
    GetWindowThreadProcessId(window, Some(&mut process_id));
    let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
        return true.into();
    };
    let mut path = [0u16; 32768];
    let mut length = path.len() as u32;
    let matches = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut length,
    )
    .is_ok()
        && normalized_path(&String::from_utf16_lossy(&path[..length as usize]))
            == normalized_path(&search.executable);
    let mut started = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let started_at = if matches
        && GetProcessTimes(process, &mut started, &mut exited, &mut kernel, &mut user).is_ok()
    {
        ((started.dwHighDateTime as u64) << 32) | started.dwLowDateTime as u64
    } else {
        u64::MAX
    };
    let _ = CloseHandle(process);
    if !matches {
        return true.into();
    }
    search.running = true;
    let mut title = [0u16; 32];
    let length = GetWindowTextW(window, &mut title) as usize;
    let title = String::from_utf16_lossy(&title[..length]);
    // 有未读时标题可能变成“微信(3)”或“微信 - ...”，不能只做完全相等匹配，
    // 否则 OCR 和“打开微信”都会找不到主窗口。
    let title = title.trim();
    let is_wechat_main = ["微信", "WeChat", "Weixin"]
        .iter()
        .any(|base| title == *base || title.starts_with(&format!("{base}(")) || title.starts_with(&format!("{base} -")));
    if !is_wechat_main {
        return true.into();
    }
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    let main_sized = GetWindowPlacement(window, &mut placement).is_ok()
        && placement.rcNormalPosition.right - placement.rcNormalPosition.left >= 500
        && placement.rcNormalPosition.bottom - placement.rcNormalPosition.top >= 300;
    search.found.push(WeChatWindow {
        handle: window,
        started_at,
        main_sized,
        visible: IsWindowVisible(window).as_bool(),
    });
    true.into()
}

fn existing_wechat_windows(executable: &std::path::Path) -> Result<WindowSearch, String> {
    let mut search = WindowSearch {
        executable: executable.to_string_lossy().into_owned(),
        found: Vec::new(),
        running: false,
    };
    unsafe {
        EnumWindows(
            Some(find_wechat_window),
            LPARAM((&mut search as *mut WindowSearch) as isize),
        )
        .map_err(|error| format!("无法查找已运行的微信窗口：{error}"))?;
    }
    Ok(search)
}

fn activate_existing_wechat(executable: &std::path::Path) -> Result<bool, String> {
    let search = existing_wechat_windows(executable)?;
    if !search.running {
        return Ok(false);
    }
    let original = preferred_window(&search.found)
        .ok_or("微信已在运行，但未定位到主窗口，请先从系统托盘打开并登录微信。")?;
    let mut expected_process = 0;
    unsafe {
        GetWindowThreadProcessId(original.handle, Some(&mut expected_process));
    }
    // The registered handler restores Qt's own UI state. Showing its HWND directly can leave it blank.
    tauri_plugin_opener::open_url("weixin://", None::<&str>).map_err(|error| {
        format!("无法通过微信注册入口唤回客户端，请从系统托盘打开微信：{error}")
    })?;
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(50));
        let current = existing_wechat_windows(executable)?;
        if let Some(window) = preferred_window(&current.found) {
            let mut process_id = 0;
            unsafe {
                GetWindowThreadProcessId(window.handle, Some(&mut process_id));
            }
            if process_id == expected_process
                && window.visible
                && !unsafe { IsIconic(window.handle) }.as_bool()
            {
                return Ok(true);
            }
        }
    }
    Err("微信未能恢复原来的主窗口，请双击系统托盘中的微信图标。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_main_is_preferred_and_login_windows_are_not_restored() {
        let windows = [
            WeChatWindow {
                handle: HWND::default(),
                started_at: 1,
                main_sized: true,
                visible: false,
            },
            WeChatWindow {
                handle: HWND::default(),
                started_at: 2,
                main_sized: false,
                visible: true,
            },
            WeChatWindow {
                handle: HWND::default(),
                started_at: 3,
                main_sized: true,
                visible: true,
            },
        ];
        assert_eq!(preferred_window(&windows).unwrap().started_at, 3);
        assert_eq!(preferred_window(&windows[..2]).unwrap().started_at, 1);
        assert!(preferred_window(&windows[1..2]).is_none());
    }

    #[test]
    #[ignore = "Activates the registered weixin protocol and verifies the original main process"]
    fn window_activation_reuses_the_existing_wechat_process() {
        let executable = installed_executable().unwrap();
        let before = existing_wechat_windows(&executable).unwrap();
        let original = preferred_window(&before.found).expect("WeChat main window is required");
        let mut expected_process = 0;
        unsafe {
            GetWindowThreadProcessId(original.handle, Some(&mut expected_process));
        }
        assert_ne!(expected_process, 0);
        for _ in 0..2 {
            assert!(activate_existing_wechat(&executable).unwrap());
            let after = existing_wechat_windows(&executable).unwrap();
            let window =
                preferred_window(&after.found).expect("The existing main window must be visible");
            let mut process_id = 0;
            unsafe {
                GetWindowThreadProcessId(window.handle, Some(&mut process_id));
            }
            assert_eq!(process_id, expected_process);
            assert!(!unsafe { IsIconic(window.handle) }.as_bool());
        }
    }

    #[test]
    fn repeated_flashes_create_one_reminder_and_activation_acknowledges_it() {
        let mut state = ReminderState::default();
        state.set_enabled(true);
        let generation = state.generation;
        assert!(state.apply(generation, ReminderSignal::Attention, 1000));
        assert!(!state.apply(generation, ReminderSignal::Attention, 2000));
        assert_eq!(state.snapshot.last_attention_at, Some(1000));
        assert!(state.apply(generation, ReminderSignal::Activated, 3000));
        assert!(!state.snapshot.pending);
        assert!(state.apply(generation, ReminderSignal::Attention, 4000));
    }

    #[test]
    fn disabling_clears_pending_state_and_rejects_old_listener_events() {
        let mut state = ReminderState::default();
        state.set_enabled(true);
        let old = state.generation;
        state.apply(old, ReminderSignal::Attention, 1000);
        state.set_enabled(false);
        assert!(!state.snapshot.pending);
        assert!(!state.apply(old, ReminderSignal::Attention, 2000));
        state.set_enabled(true);
        assert!(!state.apply(old, ReminderSignal::Attention, 3000));
        assert!(state.apply(state.generation, ReminderSignal::Attention, 4000));
    }

    #[test]
    fn redraws_and_window_creation_are_not_messages() {
        let mut state = ReminderState::default();
        state.set_enabled(true);
        let generation = state.generation;
        assert!(!state.apply(generation, ReminderSignal::Redraw, 1000));
        assert!(!state.apply(generation, ReminderSignal::WindowCreated, 2000));
        assert!(!state.snapshot.pending);
    }

    #[test]
    fn opening_wechat_prefers_main_window_over_an_older_login_window() {
        let windows = [
            WeChatWindow {
                handle: HWND::default(),
                started_at: 10,
                main_sized: false,
                visible: true,
            },
            WeChatWindow {
                handle: HWND::default(),
                started_at: 20,
                main_sized: true,
                visible: true,
            },
        ];
        assert_eq!(preferred_window(&windows).unwrap().started_at, 20);
    }

    #[test]
    fn opening_wechat_reuses_the_older_main_window_instead_of_a_new_instance() {
        let windows = [
            WeChatWindow {
                handle: HWND::default(),
                started_at: 20,
                main_sized: true,
                visible: true,
            },
            WeChatWindow {
                handle: HWND::default(),
                started_at: 10,
                main_sized: true,
                visible: true,
            },
        ];
        assert_eq!(preferred_window(&windows).unwrap().started_at, 10);
    }

    #[test]
    #[ignore = "Requires a visible WeChat desktop session; captures the conversation preview"]
    fn reads_live_wechat_chat_preview() {
        let window = content_window().expect("A visible WeChat main window is required");
        let preview = wechat_ocr::read_chat_preview(window)
            .expect("OCR should run")
            .expect("A visible WeChat conversation is required");
        println!("{preview:?}");
        assert!(!preview.title.is_empty());
    }

    #[test]
    #[ignore = "Requires a running WeChat desktop session; reads window metadata only"]
    fn finds_existing_wechat_main_window_without_launching() {
        let search = existing_wechat_windows(&installed_executable().unwrap()).unwrap();
        let selected =
            preferred_window(&search.found).expect("An existing WeChat window is required");
        assert!(
            selected.main_sized,
            "The existing main window must be preferred over a login window"
        );
    }
}
