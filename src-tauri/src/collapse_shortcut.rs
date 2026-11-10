//! 「收起面板」全局快捷键。
//!
//! 和 wake_shortcut 是同一套 message-only window + RegisterHotKey 结构，
//! 只是动作反过来：按下后让主窗口收起展开的云朵面板（回到只显示小狗）。
use crate::clipboard_history::{parse_shortcut_binding, ShortcutBinding};
use std::sync::{mpsc, Mutex, OnceLock};
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
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

const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Shift+C";
const HOTKEY_ID: i32 = 0x4D43;
const CHANGE_HOTKEY_MESSAGE: u32 = WM_APP + 0x65;
const RETRY_HOTKEY_MESSAGE: u32 = WM_APP + 0x67;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HOTKEY_WINDOW: Mutex<Option<isize>> = Mutex::new(None);
static ACTIVE_BINDING: Mutex<Option<ShortcutBinding>> = Mutex::new(None);
// 想注册的组合键。开机自启或自动更新时，上一个实例可能还没释放热键，
// 注册会失败；这里记住目标组合键，后台定时重试，避免整场会话快捷键都失效。
static DESIRED_BINDING: Mutex<Option<ShortcutBinding>> = Mutex::new(None);
static PENDING_BINDING: Mutex<Option<(ShortcutBinding, mpsc::Sender<Result<String, String>>)>> =
    Mutex::new(None);

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        thread::spawn(|| {
            if let Err(error) = run_hotkey_loop() {
                eprintln!("failed to initialize Maltese collapse shortcut: {error}");
            }
        });
    }
}

#[tauri::command]
pub fn set_collapse_shortcut(shortcut: String) -> Result<String, String> {
    let binding = parse_shortcut_binding(&shortcut)
        .ok_or_else(|| "快捷键无效，请使用至少一个修饰键。".to_string())?;
    let hwnd = HOTKEY_WINDOW
        .lock()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "收起快捷键服务尚未准备好。".to_string())?;
    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = PENDING_BINDING.lock().map_err(|error| error.to_string())?;
        if pending.is_some() {
            return Err("快捷键正在更新。".to_string());
        }
        *pending = Some((binding, sender));
    }
    unsafe {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            CHANGE_HOTKEY_MESSAGE,
            WPARAM(0),
            LPARAM(0),
        )
        .map_err(|error| error.to_string())?;
    }
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| format!("快捷键更新超时：{error}"))?
}

fn run_hotkey_loop() -> Result<(), String> {
    unsafe {
        let class_name = w!("MalteseCollapseHotkey");
        let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(hotkey_window_proc),
            hInstance: instance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("无法注册 Maltese 收起快捷键窗口。".to_string());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Maltese Collapse Hotkey"),
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
        if let Some(binding) = parse_shortcut_binding(DEFAULT_SHORTCUT) {
            *DESIRED_BINDING.lock().map_err(|error| error.to_string())? = Some(binding.clone());
            if register_binding(hwnd, &binding).is_ok() {
                *ACTIVE_BINDING.lock().map_err(|error| error.to_string())? = Some(binding);
            }
        }
        *HOTKEY_WINDOW.lock().map_err(|error| error.to_string())? = Some(hwnd.0 as isize);
        start_retry_loop(hwnd);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
    }
    Ok(())
}

// 热键没注册上时（多半是上一个实例还占着），每 2 秒重试一次，最多 30 次。
fn start_retry_loop(hwnd: HWND) {
    let raw = hwnd.0 as isize;
    thread::spawn(move || {
        for _ in 0..30 {
            thread::sleep(Duration::from_secs(2));
            if ACTIVE_BINDING.lock().map(|slot| slot.is_some()).unwrap_or(false) {
                return;
            }
            unsafe {
                let _ = PostMessageW(
                    Some(HWND(raw as *mut _)),
                    RETRY_HOTKEY_MESSAGE,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }
    });
}

fn retry_register(hwnd: HWND) {
    if ACTIVE_BINDING.lock().map(|slot| slot.is_some()).unwrap_or(true) {
        return;
    }
    let desired = DESIRED_BINDING.lock().ok().and_then(|slot| slot.clone());
    if let Some(binding) = desired {
        if register_binding(hwnd, &binding).is_ok() {
            if let Ok(mut active) = ACTIVE_BINDING.lock() {
                *active = Some(binding);
            }
        }
    }
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

unsafe extern "system" fn hotkey_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_HOTKEY && wparam.0 == HOTKEY_ID as usize {
        if let Some(app) = APP.get() {
            // 前端收到后把展开态收成收起态；窗口隐藏时不处理。
            if app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false)
            {
                let _ = app.emit_to("main", "maltese-collapse-panel", serde_json::json!({}));
            }
        }
        return LRESULT(0);
    }

    if message == RETRY_HOTKEY_MESSAGE {
        retry_register(hwnd);
        return LRESULT(0);
    }
    if message == CHANGE_HOTKEY_MESSAGE {
        let pending = PENDING_BINDING.lock().ok().and_then(|mut value| value.take());
        if let Some((binding, sender)) = pending {
            let previous = ACTIVE_BINDING.lock().ok().and_then(|mut value| value.take());
            if previous.is_some() {
                let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
            }
            if let Ok(mut desired) = DESIRED_BINDING.lock() {
                *desired = Some(binding.clone());
            }
            let result = register_binding(hwnd, &binding).map(|()| binding.label.clone());
            if let Ok(mut active) = ACTIVE_BINDING.lock() {
                *active = if result.is_ok() {
                    Some(binding)
                } else {
                    previous.and_then(|old| register_binding(hwnd, &old).ok().map(|()| old))
                };
            }
            let _ = sender.send(result);
        }
        return LRESULT(0);
    }

    DefWindowProcW(hwnd, message, wparam, lparam)
}
