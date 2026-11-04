// 从文件路径提取系统图标（快捷方式 / exe / 脚本），转成 PNG 的 data URL。
use base64::Engine;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
    SelectObject,
    BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

#[tauri::command]
pub fn get_shortcut_icon(path: String) -> Result<Option<String>, String> {
    Ok(read_icon_png(&path))
}

fn read_icon_png(path: &str) -> Option<String> {
    if !Path::new(path).exists() {
        return None;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            Default::default(),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if result == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = icon_to_png(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        png
    }
}

fn icon_to_png(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    unsafe {
        let mut icon_info = ICONINFO::default();
        GetIconInfo(icon, &mut icon_info).ok()?;
        let color_bitmap = icon_info.hbmColor;
        let mask_bitmap = icon_info.hbmMask;

        let mut bitmap = BITMAP::default();
        let got = GetObjectW(
            color_bitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut BITMAP as *mut core::ffi::c_void),
        );
        if got == 0 {
            let _ = DeleteObject(color_bitmap.into());
            let _ = DeleteObject(mask_bitmap.into());
            return None;
        }

        let width = bitmap.bmWidth.max(1);
        let height = bitmap.bmHeight.max(1);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负数 = 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buffer = vec![0u8; (width * height * 4) as usize];

        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let old = SelectObject(mem_dc, color_bitmap.into());
        let lines = GetDIBits(
            mem_dc,
            color_bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut core::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
        let _ = DeleteObject(color_bitmap.into());
        let _ = DeleteObject(mask_bitmap.into());

        if lines == 0 {
            return None;
        }

        // BGRA -> RGBA，并清理全透明像素的底色
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if pixel[3] == 0 {
                pixel[0] = 0;
                pixel[1] = 0;
                pixel[2] = 0;
            }
        }

        let image = image::RgbaImage::from_raw(width as u32, height as u32, buffer)?;
        let mut png: Vec<u8> = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        Some(format!("data:image/png;base64,{encoded}"))
    }
}