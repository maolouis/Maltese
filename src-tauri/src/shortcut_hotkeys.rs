// 快捷面板的系统级热键：只负责打开整个快捷方式面板，不再给每个入口
// 单独注册热键。窗口仍是 message-only window，逻辑与 wake_shortcut 一致，
// 避免全局键盘钩子带来的权限和性能问题。

use crate::clipboard_history::{parse_shortcut_binding, ShortcutBinding};
use std::{
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

const HOTKEY_ID: i32 = 0x6300;
const UPDATE_HOTKEY_MESSAGE: u32 = WM_APP + 0x66;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HOTKEY_WINDOW: Mutex<Option<isize>> = Mutex::new(None);
static ACTIVE: Mutex<Option<ShortcutBinding>> = Mutex::new(None);
static PENDING: Mutex<Option<(String, mpsc::Sender<Result<String, String>>)>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        thread::spawn(|| {
            if let Err(error) = run_hotkey_loop() {
                eprintln!("failed to initialize shortcut panel hotkey: {error}");
            }
        });
    }
}

#[tauri::command]
pub fn set_shortcut_panel_hotkey(shortcut: String) -> Result<String, String> {
    // 启动早期热键线程可能还没创建窗口，短暂等待，避免前端首次同步失败。
    let mut hwnd = None;
    for _ in 0..30 {
        hwnd = *HOTKEY_WINDOW.lock().map_err(|error| error.to_string())?;
        if hwnd.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let hwnd = hwnd.ok_or_else(|| "快捷面板热键服务尚未准备好。".to_string())?;

    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = PENDING.lock().map_err(|error| error.to_string())?;
        if pending.is_some() {
            return Err("快捷面板热键正在更新。".to_string());
        }
        *pending = Some((shortcut, sender));
    }
    unsafe {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            UPDATE_HOTKEY_MESSAGE,
            WPARAM(0),
            LPARAM(0),
        )
        .map_err(|error| error.to_string())?;
    }
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| format!("快捷面板热键更新超时：{error}"))?
}

fn run_hotkey_loop() -> Result<(), String> {
    unsafe {
        let class_name = w!("MalteseShortcutPanelHotkey");
        let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(hotkey_window_proc),
            hInstance: instance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("无法注册 Maltese 快捷面板热键窗口。".to_string());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Maltese Shortcut Panel Hotkey"),
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
        let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
    }
    Ok(())
}

fn register_binding(hwnd: HWND, binding: &ShortcutBinding) -> Result<(), String> {
    unsafe {
        RegisterHotKey(
            Some(hwnd),
            HOTKEY_ID,
            HOT_KEY_MODIFIERS(binding.modifiers | MOD_NOREPEAT.0),
            binding.key_code,
        )
        .map_err(|error| format!("快捷键 {} 已被占用或无法注册：{error}", binding.label))
    }
}

fn apply_hotkey(hwnd: HWND, shortcut: String) -> Result<String, String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        let previous = ACTIVE.lock().map_err(|error| error.to_string())?.take();
        if previous.is_some() {
            unsafe {
                let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
            }
        }
        return Ok(String::new());
    }

    let binding = parse_shortcut_binding(&shortcut)
        .ok_or_else(|| "快捷键无效，请至少使用一个修饰键。".to_string())?;

    // 重复提交同一个组合键时保持原注册不变，避免前端启动同步和页面内校验互相抢注册。
    {
        let active = ACTIVE.lock().map_err(|error| error.to_string())?;
        if let Some(current) = active.as_ref() {
            if current.label == binding.label {
                return Ok(current.label.clone());
            }
        }
    }

    let previous = ACTIVE.lock().map_err(|error| error.to_string())?.take();
    if previous.is_some() {
        unsafe {
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
        }
    }

    match register_binding(hwnd, &binding) {
        Ok(()) => {
            let label = binding.label.clone();
            *ACTIVE.lock().map_err(|error| error.to_string())? = Some(binding);
            Ok(label)
        }
        Err(error) => {
            // 新组合键注册失败时恢复旧热键，避免用户原来的设置被误清除。
            if let Some(old) = previous {
                if register_binding(hwnd, &old).is_ok() {
                    if let Ok(mut active) = ACTIVE.lock() {
                        *active = Some(old);
                    }
                }
            }
            Err(error)
        }
    }
}

unsafe extern "system" fn hotkey_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_HOTKEY && wparam.0 == HOTKEY_ID as usize {
        if let Some(app) = APP.get() {
            if crate::show_island(app).is_ok() {
                let _ = app.emit_to("main", "maltese-open-shortcut-panel", serde_json::json!({}));
            }
        }
        return LRESULT(0);
    }

    if message == UPDATE_HOTKEY_MESSAGE {
        let pending = PENDING.lock().ok().and_then(|mut value| value.take());
        if let Some((shortcut, sender)) = pending {
            let result = apply_hotkey(hwnd, shortcut);
            let _ = sender.send(result);
        }
        return LRESULT(0);
    }

    DefWindowProcW(hwnd, message, wparam, lparam)
}