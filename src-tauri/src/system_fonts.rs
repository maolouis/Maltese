//! 检测 Windows 当前系统现用 UI 字体与本机已安装可用字体列表。
//!
//! - `activeFont`：通过 `SystemParametersInfoW(SPI_GETNONCLIENTMETRICS)` 读取系统消息/界面现用字体
//!   （例如 `Microsoft YaHei UI` 或用户在系统级替换后的现用字体）；
//! - `fonts`：通过内存设备上下文 `CreateCompatibleDC` + `EnumFontFamiliesExW(DEFAULT_CHARSET)`
//!   枚举本机所有可用字体族名（过滤 `@` 竖排变体与纯符号图标字体），现用字体与中文字体排在前面。

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::Serialize;
use windows::Win32::{
    Foundation::LPARAM,
    Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW, DEFAULT_CHARSET, FONT_CHARSET, LOGFONTW,
        TEXTMETRICW,
    },
    UI::WindowsAndMessaging::{
        SystemParametersInfoW, NONCLIENTMETRICSW, SPI_GETNONCLIENTMETRICS,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    },
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontsSnapshot {
    /// Windows 当前正在使用的系统界面字体名（如 "Microsoft YaHei UI"）。
    pub active_font: String,
    /// 标题栏/菜单现用字体（若与 active_font 不同则一并列出供快速选择）。
    pub active_variants: Vec<String>,
    /// 本机已安装的全部可用字体族名（已去重、去竖排 `@` 变体、去纯符号字体）。
    pub fonts: Vec<String>,
}

const SYMBOL_ONLY_FONTS: &[&str] = &[
    "Marlett",
    "Symbol",
    "Webdings",
    "Wingdings",
    "Wingdings 2",
    "Wingdings 3",
    "Bookshelf Symbol 7",
    "MS Outlook",
    "MS Reference Specialty",
    "MT Extra",
    "HoloLens MDL2 Assets",
    "Segoe MDL2 Assets",
    "Segoe Fluent Icons",
];

fn utf16_face_name(buf: &[u16]) -> String {
    let len = buf.iter().position(|&ch| ch == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().to_string()
}

fn is_usable_font_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('@') {
        return false;
    }
    !SYMBOL_ONLY_FONTS
        .iter()
        .any(|skip| skip.eq_ignore_ascii_case(name))
}

fn has_non_ascii(name: &str) -> bool {
    !name.is_ascii()
}

/// 读取 Windows 当前非客户区现用字体（消息字体、标题字体、菜单字体）。
pub fn detect_active_windows_fonts() -> (String, Vec<String>) {
    let mut ncm = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETNONCLIENTMETRICS,
            ncm.cbSize,
            Some((&mut ncm as *mut NONCLIENTMETRICSW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if ok.is_err() {
        return ("Microsoft YaHei UI".to_string(), vec!["Microsoft YaHei UI".to_string()]);
    }
    let message = utf16_face_name(&ncm.lfMessageFont.lfFaceName);
    let caption = utf16_face_name(&ncm.lfCaptionFont.lfFaceName);
    let menu = utf16_face_name(&ncm.lfMenuFont.lfFaceName);
    let status = utf16_face_name(&ncm.lfStatusFont.lfFaceName);

    let active = if !message.is_empty() {
        message.clone()
    } else if !caption.is_empty() {
        caption.clone()
    } else {
        "Microsoft YaHei UI".to_string()
    };

    let mut variants = Vec::new();
    for candidate in [message, caption, menu, status] {
        if is_usable_font_name(&candidate) && !variants.contains(&candidate) {
            variants.push(candidate);
        }
    }
    if variants.is_empty() {
        variants.push(active.clone());
    }
    (active, variants)
}

unsafe extern "system" fn enum_font_callback(
    lpelfe: *const LOGFONTW,
    _lpntme: *const TEXTMETRICW,
    _font_type: u32,
    lparam: LPARAM,
) -> i32 {
    if lpelfe.is_null() || lparam.0 == 0 {
        return 1;
    }
    let set = &mut *(lparam.0 as *mut BTreeSet<String>);
    let name = utf16_face_name(&(*lpelfe).lfFaceName);
    if is_usable_font_name(&name) {
        set.insert(name);
    }
    1
}

/// 枚举本机可用字体并按「现用系统字体 → 中文/本地化字体 → 英文字体」排序。
pub fn collect_system_fonts() -> SystemFontsSnapshot {
    let (active_font, active_variants) = detect_active_windows_fonts();
    let mut raw_set = BTreeSet::<String>::new();

    unsafe {
        let hdc = CreateCompatibleDC(None);
        if !hdc.0.is_null() {
            let query = LOGFONTW {
                lfCharSet: FONT_CHARSET(DEFAULT_CHARSET.0 as u8),
                ..Default::default()
            };
            let _ = EnumFontFamiliesExW(
                hdc,
                &query,
                Some(enum_font_callback),
                LPARAM((&mut raw_set as *mut BTreeSet<String>) as isize),
                0,
            );
            let _ = DeleteDC(hdc);
        }
    }

    for v in &active_variants {
        if is_usable_font_name(v) {
            raw_set.insert(v.clone());
        }
    }

    let mut prioritized = Vec::with_capacity(raw_set.len());
    for v in &active_variants {
        if raw_set.contains(v) && !prioritized.contains(v) {
            prioritized.push(v.clone());
        }
    }
    // 中文/本地化命名字体排在前面，方便中文用户一眼找到
    for name in &raw_set {
        if has_non_ascii(name) && !prioritized.contains(name) {
            prioritized.push(name.clone());
        }
    }
    for name in &raw_set {
        if !prioritized.contains(name) {
            prioritized.push(name.clone());
        }
    }

    SystemFontsSnapshot {
        active_font,
        active_variants,
        fonts: prioritized,
    }
}

#[tauri::command]
pub fn list_system_fonts(refresh: Option<bool>) -> SystemFontsSnapshot {
    static CACHE: OnceLock<SystemFontsSnapshot> = OnceLock::new();
    if refresh.unwrap_or(false) {
        return collect_system_fonts();
    }
    CACHE.get_or_init(collect_system_fonts).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_vertical_and_symbol_fonts() {
        assert!(!is_usable_font_name(""));
        assert!(!is_usable_font_name("@Microsoft YaHei"));
        assert!(!is_usable_font_name("Wingdings"));
        assert!(!is_usable_font_name("Segoe MDL2 Assets"));
        assert!(is_usable_font_name("Microsoft YaHei UI"));
        assert!(is_usable_font_name("霞鹜文楷"));
    }

    #[test]
    fn collects_non_empty_windows_fonts() {
        let snapshot = collect_system_fonts();
        assert!(!snapshot.active_font.is_empty());
        assert!(!snapshot.fonts.is_empty());
        assert!(snapshot.fonts.iter().all(|f| !f.starts_with('@')));
    }
}
