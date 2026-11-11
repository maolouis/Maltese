//! 桌宠「手脚」：读写剪贴板、把文字打进当前焦点窗口。
//!
//! 这几件事只能由原生层做：
//! - 剪贴板要用 Win32 Clipboard API（`navigator.clipboard` 在 WebView 里需要额外权限且不可靠）；
//! - 打字要模拟 Unicode 键盘事件，才能把中文送进浏览器评论框这类控件。
use std::{thread, time::Duration};
use windows::Win32::{
    Foundation::{HANDLE, HGLOBAL},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
            OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY,
    },
};
use windows::Win32::System::Ole::CF_UNICODETEXT;

fn clipboard_open() -> Result<(), String> {
    // 别的程序可能正占着剪贴板，重试几次再放弃。
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(30));
    }
    Err("剪贴板被其它程序占用，稍后再试。".to_string())
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    clipboard_open()?;
    let result = (|| -> Result<String, String> {
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32) }.is_err() {
            return Ok(String::new());
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32) }
            .map_err(|error| format!("读取剪贴板失败：{error}"))?;
        let global = HGLOBAL(handle.0);
        let pointer = unsafe { GlobalLock(global) } as *const u16;
        if pointer.is_null() {
            return Err("剪贴板内容无法锁定。".to_string());
        }
        let mut length = 0usize;
        unsafe {
            while *pointer.add(length) != 0 {
                length += 1;
            }
            let slice = std::slice::from_raw_parts(pointer, length);
            let text = String::from_utf16_lossy(slice);
            let _ = GlobalUnlock(global);
            Ok(text)
        }
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

#[tauri::command]
pub fn set_clipboard_text(text: String) -> Result<(), String> {
    clipboard_open()?;
    let result = (|| -> Result<(), String> {
        unsafe {
            EmptyClipboard().map_err(|error| format!("清空剪贴板失败：{error}"))?;
        }
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * std::mem::size_of::<u16>();
        unsafe {
            let global = GlobalAlloc(GMEM_MOVEABLE, bytes)
                .map_err(|error| format!("分配剪贴板内存失败：{error}"))?;
            let pointer = GlobalLock(global) as *mut u16;
            if pointer.is_null() {
                return Err("剪贴板内存无法锁定。".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            let _ = GlobalUnlock(global);
            SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0)))
                .map_err(|error| format!("写入剪贴板失败：{error}"))?;
        }
        Ok(())
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

/// 把一段文字用 Unicode 键盘事件打进当前焦点窗口。
/// 中文/emoji 都靠 `KEYEVENTF_UNICODE`，不依赖输入法状态。
#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: unit,
                        dwFlags: KEYBD_EVENT_FLAGS(flags.0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Err("输入文字失败：当前窗口不接受键盘模拟。".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn utf16_roundtrip_for_chinese_comment() {
        let text = "这个视频真不错👍";
        let wide: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(String::from_utf16_lossy(&wide), text);
    }
}