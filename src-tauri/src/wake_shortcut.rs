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

const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Shift+M";
const HOTKEY_ID: i32 = 0x4D41;
const CHANGE_HOTKEY_MESSAGE: u32 = WM_APP + 0x64;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HOTKEY_WINDOW: Mutex<Option<isize>> = Mutex::new(None);
static ACTIVE_BINDING: Mutex<Option<ShortcutBinding>> = Mutex::new(None);
static PENDING_BINDING: Mutex<Option<(ShortcutBinding, mpsc::Sender<Result<String, String>>)>> =
    Mutex::new(None);

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        thread::spawn(|| {
            if let Err(error) = run_hotkey_loop() {
                eprintln!("failed to initialize Maltese wake shortcut: {error}");
            }
        });
    }
}

#[tauri::command]
pub fn set_wake_shortcut(shortcut: String) -> Result<String, String> {
    let binding = parse_shortcut_binding(&shortcut)
        .ok_or_else(|| "快捷键无效，请使用至少一个修饰键。".to_string())?;
    let hwnd = HOTKEY_WINDOW
        .lock()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "唤醒快捷键服务尚未准备好。".to_string())?;
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
        let class_name = w!("MalteseWakeHotkey");
        let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(hotkey_window_proc),
            hInstance: instance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("无法注册 Maltese 唤醒快捷键窗口。".to_string());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Maltese Wake Hotkey"),
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
            if register_binding(hwnd, &binding).is_ok() {
                *ACTIVE_BINDING.lock().map_err(|error| error.to_string())? = Some(binding);
            }
        }
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

unsafe extern "system" fn hotkey_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_HOTKEY && wparam.0 == HOTKEY_ID as usize {
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    crate::hide_island(app);
                } else if crate::show_island(app).is_ok() {
                    // 从缩边或隐藏状态回来时，让前端退出缩边，真正露出桌宠。
                    let _ = app.emit_to(
                        "main",
                        "maltese-hotkey-toggle",
                        serde_json::json!({ "visible": true }),
                    );
                }
            }
        }
        return LRESULT(0);
    }
    if message == CHANGE_HOTKEY_MESSAGE {
        let pending = PENDING_BINDING.lock().ok().and_then(|mut value| value.take());
        if let Some((binding, sender)) = pending {
            let previous = ACTIVE_BINDING.lock().ok().and_then(|mut value| value.take());
            if previous.is_some() {
                let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
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
