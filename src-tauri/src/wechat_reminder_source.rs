use std::{cell::RefCell, path::PathBuf};
use windows::{
    core::{w, Error, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::{
            LibraryLoader::GetModuleHandleW,
            Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DeregisterShellHookWindow, DestroyWindow,
            DispatchMessageW, GetForegroundWindow, GetWindowThreadProcessId, PeekMessageW,
            RegisterClassW, RegisterShellHookWindow, RegisterWindowMessageW, TranslateMessage,
            UnregisterClassW, HSHELL_REDRAW, HSHELL_WINDOWACTIVATED, HSHELL_WINDOWCREATED, MSG,
            PM_REMOVE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        },
    },
};

const HSHELL_FLASH: u32 = HSHELL_REDRAW | 0x8000;
const HSHELL_RUDEAPPACTIVATED: u32 = HSHELL_WINDOWACTIVATED | 0x8000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReminderSignal {
    Attention,
    Activated,
    Redraw,
    WindowCreated,
}

#[derive(Clone, Copy, Default)]
pub struct SourceStats {
    pub shell_events: u64,
    pub metadata_errors: u64,
}

struct ListenerContext {
    message: u32,
    executable: String,
    callback: Box<dyn FnMut(ReminderSignal)>,
    stats: SourceStats,
}

thread_local! {
    static CONTEXT: RefCell<Option<ListenerContext>> = const { RefCell::new(None) };
}

fn read_registry_path(hive: windows::Win32::System::Registry::HKEY, key: &str) -> Option<PathBuf> {
    let key = windows::core::HSTRING::from(key);
    let mut data = [0u16; 2048];
    let mut bytes = (data.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            hive,
            &key,
            w!("InstallPath"),
            RRF_RT_REG_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut bytes),
        )
    };
    if result.is_err() {
        return None;
    }
    let length = data
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(data.len());
    let mut text = String::from_utf16_lossy(&data[..length])
        .trim()
        .trim_matches('"')
        .to_string();
    // 微信 4.x 的 InstallPath 常见为 "E:\\Weixin\\"（末尾带反斜杠）。
    // 保留它再 join 会在路径中间留下重复分隔符，导致和进程路径比较失败。
    while text.len() > 3 && (text.ends_with('\\') || text.ends_with('/')) {
        text.pop();
    }
    let path = PathBuf::from(text);
    (path.is_absolute()).then_some(path)
}

fn is_wechat_executable(path: &PathBuf, name: &str) -> bool {
    path.is_absolute() && path.is_file()
        && path
            .file_name()
            .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name))
}

/// 依次尝试注册表（当前用户 / 本机 / 32 位视图）和常见安装目录，
/// 尽量兼容微信 3.x（WeChat.exe）与 4.x（Weixin.exe）的安装方式。
pub fn installed_executable() -> Result<PathBuf, String> {
    let registry_keys = [
        (HKEY_CURRENT_USER, "Software\\Tencent\\Weixin"),
        (HKEY_CURRENT_USER, "Software\\Tencent\\WeChat"),
        (HKEY_LOCAL_MACHINE, "Software\\Tencent\\Weixin"),
        (HKEY_LOCAL_MACHINE, "Software\\Tencent\\WeChat"),
        (HKEY_LOCAL_MACHINE, "Software\\WOW6432Node\\Tencent\\Weixin"),
        (HKEY_LOCAL_MACHINE, "Software\\WOW6432Node\\Tencent\\WeChat"),
    ];
    for (hive, key) in registry_keys {
        let Some(dir) = read_registry_path(hive, key) else {
            continue;
        };
        for name in ["Weixin.exe", "WeChat.exe"] {
            let candidate = dir.join(name);
            if is_wechat_executable(&candidate, name) {
                return Ok(candidate);
            }
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable) {
            roots.push(PathBuf::from(root));
        }
    }
    for root in roots {
        for relative in [
            "Tencent\\Weixin\\Weixin.exe",
            "Tencent\\WeChat\\WeChat.exe",
            "Tencent\\Weixin\\Weixin.exe",
        ] {
            let candidate = root.join(relative);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("未找到微信安装路径，请确认已安装 Windows 版微信。".into())
}

pub(crate) fn normalized_path(path: &str) -> String {
    // 统一分隔符并折叠重复反斜杠：注册表里可能写 E:\\Weixin\\，
    // 而 QueryFullProcessImageNameW 返回单反斜杠的完整进程路径。
    let mut normalized = String::with_capacity(path.len());
    let mut previous_separator = false;
    for character in path.trim_start_matches(r"\\?\").chars() {
        let character = if character == '/' { '\\' } else { character };
        if character == '\\' {
            if previous_separator {
                continue;
            }
            previous_separator = true;
        } else {
            previous_separator = false;
        }
        normalized.push(character.to_ascii_lowercase());
    }
    normalized
}

unsafe fn matches_window(window: HWND, executable: &str) -> Result<bool, ()> {
    if window.is_invalid() {
        return Ok(false);
    }
    let mut process_id = 0;
    GetWindowThreadProcessId(window, Some(&mut process_id));
    let process =
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).map_err(|_| ())?;
    let mut path = [0u16; 32768];
    let mut length = path.len() as u32;
    let result = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut length,
    );
    let _ = CloseHandle(process);
    result.map_err(|_| ())?;
    Ok(normalized_path(&String::from_utf16_lossy(&path[..length as usize])) == executable)
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    kind: WPARAM,
    target: LPARAM,
) -> LRESULT {
    CONTEXT.with(|slot| {
        let Ok(mut context) = slot.try_borrow_mut() else {
            return;
        };
        let Some(context) = context.as_mut() else {
            return;
        };
        if message != context.message {
            return;
        }
        context.stats.shell_events += 1;
        let signal = match kind.0 as u32 {
            HSHELL_FLASH => ReminderSignal::Attention,
            HSHELL_WINDOWACTIVATED | HSHELL_RUDEAPPACTIVATED => ReminderSignal::Activated,
            HSHELL_REDRAW => ReminderSignal::Redraw,
            HSHELL_WINDOWCREATED => ReminderSignal::WindowCreated,
            _ => return, // Other messages may contain pointers instead of window handles.
        };
        match matches_window(HWND(target.0 as *mut _), &context.executable) {
            Ok(true) => {
                if signal == ReminderSignal::Attention
                    && matches_window(GetForegroundWindow(), &context.executable).unwrap_or(false)
                {
                    return;
                }
                (context.callback)(signal);
            }
            Err(()) => context.stats.metadata_errors += 1,
            Ok(false) => {}
        }
    });
    DefWindowProcW(window, message, kind, target)
}

pub struct ReminderListener {
    window: HWND,
    instance: HINSTANCE,
}

impl ReminderListener {
    pub fn new(
        executable: PathBuf,
        callback: impl FnMut(ReminderSignal) + 'static,
    ) -> Result<Self, String> {
        if CONTEXT.with(|slot| slot.borrow().is_some()) {
            return Err("微信提醒监听器已在此线程运行。".into());
        }
        let executable = executable
            .canonicalize()
            .map_err(|error| format!("无法确认微信安装路径：{error}"))?;
        unsafe {
            let message = RegisterWindowMessageW(w!("SHELLHOOK"));
            if message == 0 {
                return Err(format!("无法注册微信提醒事件：{}", Error::from_win32()));
            }
            let instance = HINSTANCE(GetModuleHandleW(None).map_err(|error| error.to_string())?.0);
            let class = WNDCLASSW {
                hInstance: instance,
                lpszClassName: w!("FocuSDWeChatReminderSource"),
                lpfnWndProc: Some(window_proc),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return Err(Error::from_win32().to_string());
            }
            let window = match CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class.lpszClassName,
                w!(""),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance),
                None,
            ) {
                Ok(window) => window,
                Err(error) => {
                    let _ = UnregisterClassW(class.lpszClassName, Some(instance));
                    return Err(format!("无法创建微信提醒接收器：{error}"));
                }
            };
            CONTEXT.with(|slot| {
                *slot.borrow_mut() = Some(ListenerContext {
                    message,
                    executable: normalized_path(&executable.to_string_lossy()),
                    callback: Box::new(callback),
                    stats: SourceStats::default(),
                })
            });
            let listener = Self { window, instance };
            RegisterShellHookWindow(window)
                .ok()
                .map_err(|error| format!("无法监听微信任务栏提醒：{error}"))?;
            Ok(listener)
        }
    }

    pub fn poll(&self) {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    pub fn stats(&self) -> SourceStats {
        CONTEXT.with(|slot| {
            slot.borrow()
                .as_ref()
                .map(|context| context.stats)
                .unwrap_or_default()
        })
    }
}

impl Drop for ReminderListener {
    fn drop(&mut self) {
        unsafe {
            let _ = DeregisterShellHookWindow(self.window);
            let _ = DestroyWindow(self.window);
            let _ = UnregisterClassW(w!("FocuSDWeChatReminderSource"), Some(self.instance));
        }
        CONTEXT.with(|slot| *slot.borrow_mut() = None);
    }
}
