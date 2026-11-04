//! 本地读取微信会话列表（仅在窗口可见/未最小化时）。
//!
//! 微信 4.x 的主窗口是 Qt，UI Automation 读不到聊天内容，系统通知监听也拿不到
//! 微信 toast。这里用 `PrintWindow` 把窗口画到内存位图，再交给 Windows 自带 OCR。
//! 图像只在内存中停留，不落盘、不上传；设置里可以随时关闭。

use windows::{
    Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
    Media::Ocr::OcrEngine,
    Security::Cryptography::CryptographicBuffer,
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
            SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        },
        System::WinRT::RoInitialize,
        UI::WindowsAndMessaging::{GetWindowRect, IsIconic},
    },
};

#[link(name = "user32")]
extern "system" {
    fn PrintWindow(window: HWND, hdc: windows::Win32::Graphics::Gdi::HDC, flags: u32)
        -> windows::core::BOOL;
}

#[derive(Clone, Debug, Default)]
pub struct ChatPreview {
    pub title: String,
    pub body: String,
}

/// 读取微信左侧会话列表最上面一条（最新）的发送者和摘要。
///
/// 返回 `Ok(None)` 表示窗口最小化、尺寸异常或 OCR 没识别到文字；
/// `Err` 表示真正的系统调用失败（调用方可以选择静默忽略）。
pub fn read_chat_preview(window: HWND) -> Result<Option<ChatPreview>, String> {
    unsafe {
        if IsIconic(window).as_bool() {
            return Ok(None);
        }
        let mut rect = RECT::default();
        GetWindowRect(window, &mut rect).map_err(|error| format!("无法读取微信窗口位置：{error}"))?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if !(320..=5000).contains(&width) || !(240..=4000).contains(&height) {
            return Ok(None);
        }

        // Windows 8+ 的 PW_RENDERFULLCONTENT 能抓到被遮挡的 Qt 窗口，且不会抢焦点。
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("无法获取屏幕绘图上下文。".into());
        }
        let memory = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|error| format!("无法创建微信截图位图：{error}"))?;
        let old = SelectObject(memory, bitmap.into());
        let printed = PrintWindow(window, memory, 2).as_bool();
        if !printed || bits.is_null() {
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return Ok(None);
        }

        // 只取左侧会话列表：跳过标题栏、搜索框和右侧聊天正文。
        let crop_left = (width as f32 * 0.05).round() as usize;
        let crop_right = (width as f32 * 0.44).round() as usize;
        let crop_top = (height as f32 * 0.07).round() as usize;
        let crop_bottom = (height as f32 * 0.97).round() as usize;
        let crop_width = crop_right.saturating_sub(crop_left);
        let crop_height = crop_bottom.saturating_sub(crop_top);
        if crop_width < 80 || crop_height < 100 {
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return Ok(None);
        }
        let pixels = std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize);
        let mut cropped = vec![0u8; crop_width * crop_height * 4];
        for y in 0..crop_height {
            let src_y = y + crop_top;
            let src = (src_y * width as usize + crop_left) * 4;
            let dst = y * crop_width * 4;
            cropped[dst..dst + crop_width * 4]
                .copy_from_slice(&pixels[src..src + crop_width * 4]);
        }

        let initialized = RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED).is_ok();
        let result = (|| -> Result<Option<ChatPreview>, String> {
            let buffer = CryptographicBuffer::CreateFromByteArray(&cropped)
                .map_err(|error| format!("无法创建 OCR 图像缓冲：{error}"))?;
            let software = SoftwareBitmap::CreateCopyFromBuffer(
                &buffer,
                BitmapPixelFormat::Bgra8,
                crop_width as i32,
                crop_height as i32,
            )
            .map_err(|error| format!("无法创建 OCR 位图：{error}"))?;
            let engine = OcrEngine::TryCreateFromUserProfileLanguages()
                .map_err(|error| format!("系统 OCR 不可用（请安装中文语言包）：{error}"))?;
            let result = engine
                .RecognizeAsync(&software)
                .map_err(|error| format!("OCR 识别失败：{error}"))?
                .get()
                .map_err(|error| format!("OCR 识别失败：{error}"))?;
            let mut lines: Vec<(f32, f32, String)> = Vec::new();
            for line in result
                .Lines()
                .map_err(|error| format!("无法读取 OCR 行：{error}"))?
            {
                let Ok(words) = line.Words() else {
                    continue;
                };
                let Ok(first) = words.GetAt(0) else {
                    continue;
                };
                let Ok(bounds) = first.BoundingRect() else {
                    continue;
                };
                let text = line
                    .Text()
                    .map(|text| text.to_string_lossy())
                    .unwrap_or_default();
                let text = compact_cjk(&text);
                if text.is_empty() || text.chars().all(|ch| ch.is_ascii_digit() || ch == ':') {
                    continue;
                }
                // 过滤左侧导航栏、时间和滚动条附近的噪声。
                if bounds.X < crop_width as f32 * 0.14 || bounds.Y < 12.0 {
                    continue;
                }
                lines.push((bounds.Y, bounds.X, text));
            }
            lines.sort_by(|left, right| left.0.total_cmp(&right.0));
            let Some((title_y, _, title)) = lines.first().cloned() else {
                return Ok(None);
            };
            // 会话行高约 60px。只取紧挨着标题的 1~2 行，避免把下一条会话的
            // 名称/摘要也拼进正文；阈值按裁剪高度缩放，兼容不同 DPI。
            let max_gap = (crop_height as f32 * 0.08).max(40.0);
            let body = lines
                .iter()
                .skip(1)
                .filter(|(y, _, _)| *y > title_y && *y - title_y <= max_gap)
                .take(2)
                .map(|(_, _, text)| text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            Ok(Some(ChatPreview { title, body }))
        })();

        if initialized {
            windows::Win32::System::WinRT::RoUninitialize();
        }
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        result
    }
}

/// OCR 会在汉字之间插空格；中文为主的文本直接去掉空格，英文/数字保留词间空格。
#[cfg(test)]
mod tests {
    use super::*;

    /// 实机校准：设置 WECHAT_HWND 为微信主窗口句柄后运行。
    #[test]
    #[ignore]
    fn live_read_chat_preview() {
        let handle: isize = std::env::var("WECHAT_HWND")
            .expect("WECHAT_HWND")
            .parse()
            .expect("numeric HWND");
        let preview = read_chat_preview(HWND(handle as *mut _)).unwrap();
        println!("{preview:?}");
    }
}

fn compact_cjk(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let cjk = chars.iter().filter(|ch| !ch.is_ascii()).count();
    if cjk * 2 < chars.len() {
        return text.trim().to_string();
    }
    chars
        .into_iter()
        .filter(|ch| *ch != ' ')
        .collect::<String>()
        .trim()
        .to_string()
}