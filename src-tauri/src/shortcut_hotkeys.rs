// 每个快捷方式单独绑定全局热键。
//
// 这里不复用“唤醒岛”的那个热键窗口：唤醒热键只有一个，而快捷方式
// 数量会变化，需要整组重新注册。窗口仍是 message-only window，逻辑
// 与 wake_shortcut 保持一致，避免全局键盘钩子带来的权限和性能问题。

use crate::clipboard_history::{parse_shortcut_binding, ShortcutBinding};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT},
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
            RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
            WM_APP, WM_HOTKEY, WNDCLASSW,
        },
    },
};

const FIRST_HOTKEY_ID: i32 = 0x6200;
const MAX_SHORTCUT_HOTKEYS: usize = 64;
const UPDATE_HOTKEYS_MESSAGE: u32 = WM_APP + 0x66;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutHotkeyRequest {
    pub path: String,
    pub shortcut: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutHotkeyIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutHotkeyResult {
    pub registered: usize,
    pub issues: Vec<ShortcutHotkeyIssue>,
}

#[derive(Clone)]
struct ActiveHotkey {
    id: i32,
    path: String,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static HOTKEY_WINDOW: Mutex<Option<isize>> = Mutex::new(None);
static ACTIVE: Mutex<Vec<ActiveHotkey>> = Mutex::new(Vec::new());
static PENDING: Mutex<
    Option<(
        Vec<ShortcutHotkeyRequest>,
        mpsc::Sender<ShortcutHotkeyResult>,
    )>,
> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        thread::spawn(|| {
            if let Err(error) = run_hotkey_loop() {
                eprintln!("failed to initialize shortcut hotkeys: {error}");
            }
        });
    }
}

#[tauri::command]
pub fn set_shortcut_hotkeys(
    bindings: Vec<ShortcutHotkeyRequest>,
) -> Result<ShortcutHotkeyResult, String> {
    // 启动早期热键线程可能还没创建窗口，短暂等待，避免前端首次同步失败。
    let mut hwnd = None;
    for _ in 0..30 {
        hwnd = *HOTKEY_WINDOW.lock().map_err(|error| error.to_string())?;
        if hwnd.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let hwnd = hwnd.ok_or_else(|| "快捷方式热键服务尚未准备好。".to_string())?;

    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = PENDING.lock().map_err(|error| error.to_string())?;
        if pending.is_some() {
            return Err("快捷方式热键正在更新。".to_string());
        }
        *pending = Some((bindings.into_iter().take(MAX_SHORTCUT_HOTKEYS).collect(), sender));
    }
    unsafe {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            UPDATE_HOTKEYS_MESSAGE,
            WPARAM(0),
            LPARAM(0),
        )
        .map_err(|error| error.to_string())?;
    }
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| format!("快捷方式热键更新超时：{error}"))
}

fn run_hotkey_loop() -> Result<(), String> {
    unsafe {
        let class_name = w!("MalteseShortcutHotkeys");
        let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(hotkey_window_proc),
            hInstance: instance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("无法注册快捷方式热键窗口。".to_string());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Maltese Shortcut Hotkeys"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )
        .map_err(|error| error.to_string())?;
        *HOTKEY_WINDOW.lock().map_err(|error| error.to_string())? = Some(hwnd.0 as isize);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        clear_hotkeys(hwnd);
    }
    Ok(())
}

fn clear_hotkeys(hwnd: HWND) {
    let active = ACTIVE.lock().map(|mut items| std::mem::take(&mut *items));
    if let Ok(items) = active {
        unsafe {
            for item in items {
                let _ = UnregisterHotKey(Some(hwnd), item.id);
            }
        }
    }
}

fn apply_hotkeys(hwnd: HWND, requests: Vec<ShortcutHotkeyRequest>) -> ShortcutHotkeyResult {
    clear_hotkeys(hwnd);

    let mut seen_paths = HashSet::new();
    let mut issues = Vec::new();
    let mut registered = 0usize;

    for (index, request) in requests.into_iter().enumerate() {
        let path = request.path.trim().to_string();
        let shortcut = request.shortcut.trim().to_string();
        if path.is_empty() || shortcut.is_empty() {
            continue;
        }
        if !seen_paths.insert(path.clone()) {
            continue;
        }
        let Some(binding) = parse_shortcut_binding(&shortcut) else {
            issues.push(ShortcutHotkeyIssue {
                path,
                message: "热键无效，请使用至少一个修饰键加一个按键。".to_string(),
            });
            continue;
        };
        let id = FIRST_HOTKEY_ID + index as i32;
        let result = unsafe {
            RegisterHotKey(
                Some(hwnd),
                id,
                HOT_KEY_MODIFIERS(binding.modifiers | MOD_NOREPEAT.0),
                binding.key_code,
            )
        };
        match result {
            Ok(()) => {
                if let Ok(mut active) = ACTIVE.lock() {
                    active.push(ActiveHotkey { id, path });
                }
                registered += 1;
            }
            Err(error) => issues.push(ShortcutHotkeyIssue {
                path,
                message: format!("热键 {} 已被占用或无法注册：{error}", binding.label),
            }),
        }
    }

    ShortcutHotkeyResult {
        registered,
        issues,
    }
}

unsafe extern "system" fn hotkey_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_HOTKEY {
        let id = wparam.0 as i32;
        let target = ACTIVE
            .lock()
            .ok()
            .and_then(|items| items.iter().find(|item| item.id == id).cloned());
        if let Some(target) = target {
            if let Err(error) = crate::launch_shortcut_path(PathBuf::from(&target.path)) {
                eprintln!("failed to launch shortcut hotkey target: {error}");
                if let Some(app) = APP.get() {
                    let _ = app.emit(
                        "maltese-shortcut-hotkey-error",
                        serde_json::json!({ "path": target.path, "message": error }),
                    );
                }
            }
        }
        return LRESULT(0);
    }

    if message == UPDATE_HOTKEYS_MESSAGE {
        let pending = PENDING.lock().ok().and_then(|mut value| value.take());
        if let Some((requests, sender)) = pending {
            let result = apply_hotkeys(hwnd, requests);
            let _ = sender.send(result);
        }
        return LRESULT(0);
    }

    DefWindowProcW(hwnd, message, wparam, lparam)
}