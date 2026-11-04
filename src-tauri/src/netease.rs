// 网易云音乐本机状态读取（不依赖系统媒体会话 SMTC）：
// 1) 枚举 cloudmusic.exe 的窗口标题，解析「歌名 - 歌手」；
// 2) 通过媒体键控制播放/上一首/下一首（网易云会响应全局媒体键）；
// 3) 一键把网易云窗口切到前台，用来挑歌单。
use crate::messenger_activation::activate_existing_window;
use serde::Serialize;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetEaseTrack {
    pub title: String,
    pub artist: String,
    pub window_title: String,
}

struct WindowSearch {
    titles: Vec<(String, i64, bool)>,
}

unsafe extern "system" fn collect_window(window: HWND, context: LPARAM) -> BOOL {
    let search = &mut *(context.0 as *mut WindowSearch);
    let mut process_id = 0u32;
    GetWindowThreadProcessId(window, Some(&mut process_id));
    let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
        return true.into();
    };
    let mut path_buffer = [0u16; 32768];
    let mut length = path_buffer.len() as u32;
    let matches = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path_buffer.as_mut_ptr()),
        &mut length,
    )
    .is_ok()
        && String::from_utf16_lossy(&path_buffer[..length as usize])
            .to_ascii_lowercase()
            .ends_with("cloudmusic.exe");
    let _ = CloseHandle(process);
    if !matches {
        return true.into();
    }
    let mut title_buffer = [0u16; 512];
    let length = GetWindowTextW(window, &mut title_buffer);
    let title = String::from_utf16_lossy(&title_buffer[..length as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return true.into();
    }
    let mut rect = Default::default();
    let area = if GetWindowRect(window, &mut rect).is_ok() {
        (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64
    } else {
        0
    };
    let visible = IsWindowVisible(window).as_bool();
    search.titles.push((title, area, visible));
    true.into()
}

fn window_titles() -> Vec<(String, i64, bool)> {
    let mut search = WindowSearch {
        titles: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            LPARAM(&mut search as *mut WindowSearch as isize),
        );
    }
    search.titles
}

fn parse_title(raw: &str) -> Option<(String, String)> {
    let mut cleaned = raw.trim();
    for suffix in [" - 网易云音乐", "- 网易云音乐", " - 网易云", " - NetEase Cloud Music"] {
        if let Some(stripped) = cleaned.strip_suffix(suffix) {
            cleaned = stripped.trim();
        }
    }
    if cleaned.is_empty() || cleaned == "网易云音乐" || cleaned == "NetEase Cloud Music" {
        return None;
    }
    // 网易云的标题一般形如「歌名 - 歌手」；有时带第三段（专辑 / 客户端名），忽略。
    let parts: Vec<&str> = cleaned
        .split(" - ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    match parts.as_slice() {
        [] => None,
        [only] => Some((only.to_string(), String::new())),
        [title, artist, ..] => Some((title.to_string(), artist.to_string())),
    }
}

// 当前正在播放（或最近播放）的歌曲：优先选可见且面积最大的窗口标题。
pub fn current_track() -> Option<NetEaseTrack> {
    let mut titled: Vec<(String, i64, bool, (String, String))> = window_titles()
        .into_iter()
        .filter_map(|(title, area, visible)| parse_title(&title).map(|parsed| (title, area, visible, parsed)))
        .collect();
    titled.sort_by_key(|(_, area, visible, _)| (std::cmp::Reverse(*visible), std::cmp::Reverse(*area)));
    titled
        .into_iter()
        .next()
        .map(|(window_title, _, _, (title, artist))| NetEaseTrack {
            title,
            artist,
            window_title,
        })
}

fn send_key(vk: u16) {
    unsafe {
        let down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let mut up = down;
        up.Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(&[down], std::mem::size_of::<INPUT>() as i32);
        SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
    }
}

// command: toggle / next / previous / stop
#[tauri::command]
pub fn media_press_key(command: String) -> Result<(), String> {
    match command.as_str() {
        "toggle" => send_key(0xB3),   // VK_MEDIA_PLAY_PAUSE
        "next" => send_key(0xB0),     // VK_MEDIA_NEXT_TRACK
        "previous" => send_key(0xB1), // VK_MEDIA_PREV_TRACK
        "stop" => send_key(0xB2),     // VK_MEDIA_STOP
        other => return Err(format!("未知的媒体操作：{other}")),
    }
    Ok(())
}

// 把网易云主窗口切到前台，方便在客户端里选歌单。
#[tauri::command]
pub fn netease_focus() -> Result<(), String> {
    struct Find {
        best: Option<(isize, i64, bool)>,
    }
    unsafe extern "system" fn pick(window: HWND, context: LPARAM) -> BOOL {
        let find = &mut *(context.0 as *mut Find);
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return true.into();
        };
        let mut path_buffer = [0u16; 32768];
        let mut length = path_buffer.len() as u32;
        let matches = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path_buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok()
            && String::from_utf16_lossy(&path_buffer[..length as usize])
                .to_ascii_lowercase()
                .ends_with("cloudmusic.exe");
        let _ = CloseHandle(process);
        if !matches {
            return true.into();
        }
        let mut rect = Default::default();
        let area = if GetWindowRect(window, &mut rect).is_ok() {
            (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64
        } else {
            0
        };
        let visible = IsWindowVisible(window).as_bool();
        let better = match find.best {
            None => true,
            Some((_, best_area, best_visible)) => (visible, area) > (best_visible, best_area),
        };
        if better {
            find.best = Some((window.0 as isize, area, visible));
        }
        true.into()
    }
    let mut find = Find { best: None };
    unsafe {
        let _ = EnumWindows(
            Some(pick),
            LPARAM(&mut find as *mut Find as isize),
        );
    }
    let Some((handle, _, _)) = find.best else {
        return Err("没有找到正在运行的网易云音乐，请先打开客户端。".into());
    };
    activate_existing_window(HWND(handle as *mut _), "网易云音乐")
}