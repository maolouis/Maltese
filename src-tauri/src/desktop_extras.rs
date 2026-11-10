// 额外的桌宠窗口：陪玩狗、Bongo 模式、鼠标跟随宠。
//
// 主窗口只负责“主狗”；陪玩狗、Bongo 和跟随宠在 tauri.conf.json 里
// 预声明为隐藏的独立透明窗口，这里只按设置显示/隐藏和定位，避免在
// 命令线程里临时创建 WebView 造成启动卡死。

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, Once};
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Position,
};
use windows::Win32::{
    Foundation::POINT,
    UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::GetCursorPos},
};

const COMPANION_PREFIX: &str = "companion-";
const COMPANION_MAX: u32 = 4;
const BONGO_LABEL: &str = "bongo-pet";
const CURSOR_LABEL: &str = "cursor-pet";
const BONGO_RATIO: f64 = 1037.0 / 1276.0;

static CURSOR_ENABLED: AtomicBool = AtomicBool::new(false);
static CURSOR_SIZE: AtomicU32 = AtomicU32::new(75);
static CURSOR_LOOP: Once = Once::new();
// 主桌宠被快捷键/托盘隐藏时，桌上其它小狗（Bongo、陪伴狗、跟随鼠标的小狗）也要一起消失。
static PETS_HIDDEN: AtomicBool = AtomicBool::new(false);
// 最近一次同步用的配置，用于「显示回来」时按原样恢复，而不是回到默认值。
static LAST_CONFIG: Mutex<Option<DesktopExtrasConfig>> = Mutex::new(None);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopExtrasConfig {
    pub pet_count: u32,
    pub bongo_enabled: bool,
    pub bongo_size: u32,
    pub bongo_opacity: u32,
    pub bongo_mirror: bool,
    pub bongo_click_through: bool,
    pub follow_mouse: bool,
    pub cursor_pet_size: u32,
    /// Bongo 的默认落点；旧配置里没有这个字段时按底部居中处理。
    #[serde(default)]
    pub bongo_position: String,
}

fn pets_hidden() -> bool {
    PETS_HIDDEN.load(Ordering::SeqCst)
}

/// 主桌宠被隐藏时调用：Bongo、陪伴狗、跟随鼠标的小狗一起消失。
pub fn hide_extra_pets(app: &AppHandle) {
    PETS_HIDDEN.store(true, Ordering::SeqCst);
    let labels = [
        BONGO_LABEL,
        CURSOR_LABEL,
        "companion-1",
        "companion-2",
        "companion-3",
        "companion-4",
    ];
    for label in labels {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

/// 主桌宠重新出现时调用：按最近一次同步的配置把其它小狗放回去。
pub fn restore_extra_pets(app: &AppHandle) {
    PETS_HIDDEN.store(false, Ordering::SeqCst);
    let config = LAST_CONFIG.lock().ok().and_then(|slot| slot.clone());
    let Some(config) = config else {
        return;
    };
    let _ = sync_companions(app, config.pet_count);
    let _ = sync_bongo(app, &config);
    let _ = sync_cursor(app, &config);
}
fn work_area(app: &AppHandle) -> (i32, i32, i32, i32, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        return (
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
            monitor.scale_factor(),
        );
    }
    (0, 0, 1920, 1080, 1.0)
}

fn sync_companions(app: &AppHandle, count: u32) -> Result<(), String> {
    let wanted = count.saturating_sub(1).min(COMPANION_MAX);
    let (left, top, width, height, scale) = work_area(app);
    for index in 1..=COMPANION_MAX {
        let label = format!("{COMPANION_PREFIX}{index}");
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        if index <= wanted && !pets_hidden() {
            let physical_w = (200.0 * scale).round() as i32;
            let physical_h = (180.0 * scale).round() as i32;
            let x = (left + (80.0 * scale) as i32 + (index as i32 - 1) * physical_w)
                .min(left + width - physical_w);
            let y = (top + height - physical_h).max(top);
            let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(200.0, 180.0)));
            let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            let _ = window.show();
        } else {
            // 预声明的窗口只隐藏不销毁，下次加回数量时可以直接复用。
            let _ = window.hide();
        }
    }
    Ok(())
}

fn sync_bongo(app: &AppHandle, config: &DesktopExtrasConfig) -> Result<(), String> {
    let Some(window) = app.get_webview_window(BONGO_LABEL) else {
        // 启动早期窗口可能还没注册完，交给调用方稍后重试。
        return Err("Bongo 窗口还没准备好".to_string());
    };
    let width = config.bongo_size.clamp(220, 700) as f64;
    let height = (width * BONGO_RATIO).round();
    let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(width, height)));
    let _ = window.set_ignore_cursor_events(config.bongo_click_through);
    if config.bongo_enabled && !pets_hidden() {
        let (left, top, screen_w, screen_h, scale) = work_area(app);
        let phys_w = (width * scale).round() as i32;
        let phys_h = (height * scale).round() as i32;
        let margin = (24.0 * scale).round() as i32;
        let max_x = (left + screen_w - phys_w).max(left);
        let max_y = (top + screen_h - phys_h).max(top);
        let (x, y) = match config.bongo_position.as_str() {
            "bottomLeft" => (left + margin, max_y),
            "bottomRight" => (max_x - margin, max_y),
            "topCenter" => (left + ((screen_w - phys_w) / 2).max(0), top + margin),
            _ => (left + ((screen_w - phys_w) / 2).max(0), max_y),
        };
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            x.clamp(left, max_x),
            y.clamp(top, max_y),
        )));
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
    Ok(())
}

fn sync_cursor(app: &AppHandle, config: &DesktopExtrasConfig) -> Result<(), String> {
    CURSOR_ENABLED.store(config.follow_mouse, Ordering::SeqCst);
    CURSOR_SIZE.store(config.cursor_pet_size.clamp(30, 180), Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(CURSOR_LABEL) {
        let _ = window.set_ignore_cursor_events(true);
        if config.follow_mouse && !pets_hidden() {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
    }
    CURSOR_LOOP.call_once(|| {
        let app = app.clone();
        std::thread::spawn(move || loop {
            let enabled = CURSOR_ENABLED.load(Ordering::SeqCst);
            let Some(window) = app.get_webview_window(CURSOR_LABEL) else {
                std::thread::sleep(Duration::from_millis(120));
                continue;
            };
            if !enabled {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                }
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_err() {
                std::thread::sleep(Duration::from_millis(80));
                continue;
            }
            let size = CURSOR_SIZE.load(Ordering::SeqCst) as f64;
            let (left, top, width, height, scale) = work_area(&app);
            let phys = (size * scale).round() as i32;
            let mut x = point.x + (10.0 * scale) as i32;
            let mut y = point.y + (12.0 * scale) as i32;
            if x + phys > left + width - (4.0 * scale) as i32 {
                x = point.x - phys - (10.0 * scale) as i32;
            }
            if y + phys > top + height - (4.0 * scale) as i32 {
                y = point.y - phys - (12.0 * scale) as i32;
            }
            let x = x.clamp(left, (left + width - phys).max(left));
            let y = y.clamp(top, (top + height - phys).max(top));
            let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(size, size)));
            let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            if !window.is_visible().unwrap_or(false) && !pets_hidden() {
                let _ = window.show();
            }
            std::thread::sleep(Duration::from_millis(16));
        });
    });
    Ok(())
}

#[tauri::command]
pub async fn sync_desktop_extras(
    app: AppHandle,
    config: DesktopExtrasConfig,
) -> Result<(), String> {
    // 窗口已经在 tauri.conf.json 里预声明，但 Tauri 是在启动过程中
    // 逐个注册这些窗口的；React 首次同步往往早于窗口注册完成。
    // 在后台线程里等它们出现，再显示/隐藏/定位，避免“设置是 3 只，
    // 桌面却一只都没有”。
    if let Ok(mut slot) = LAST_CONFIG.lock() {
        *slot = Some(config.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..40 {
            let ready = app.get_webview_window("companion-1").is_some()
                && app.get_webview_window(BONGO_LABEL).is_some()
                && app.get_webview_window(CURSOR_LABEL).is_some();
            if ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // 三项互不阻断：多宠物失败时，Bongo 和鼠标跟随仍然要生效。
        let _ = sync_companions(&app, config.pet_count);
        let _ = sync_bongo(&app, &config);
        let _ = sync_cursor(&app, &config);

        // 启动时 Bongo 窗口注册得比主窗口晚，或者 show 被系统窗口状态吞掉，
        // 都会表现为“开了 Bongo 但开机没出现”。这里补几轮，直到它真的可见。
        if config.bongo_enabled {
            for _ in 0..16 {
                let visible = app
                    .get_webview_window(BONGO_LABEL)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if visible {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
                let _ = sync_bongo(&app, &config);
            }
        }
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_pressed_keys() -> Vec<String> {
    const KEYS: &[(&str, i32)] = &[
        ("A", 0x41), ("B", 0x42), ("C", 0x43), ("D", 0x44), ("E", 0x45),
        ("F", 0x46), ("G", 0x47), ("H", 0x48), ("I", 0x49), ("J", 0x4A),
        ("K", 0x4B), ("L", 0x4C), ("M", 0x4D), ("N", 0x4E), ("O", 0x4F),
        ("P", 0x50), ("Q", 0x51), ("R", 0x52), ("S", 0x53), ("T", 0x54),
        ("U", 0x55), ("V", 0x56), ("W", 0x57), ("X", 0x58), ("Y", 0x59),
        ("Z", 0x5A),
        ("0", 0x30), ("1", 0x31), ("2", 0x32), ("3", 0x33), ("4", 0x34),
        ("5", 0x35), ("6", 0x36), ("7", 0x37), ("8", 0x38), ("9", 0x39),
        ("space", 0x20), ("Enter", 0x0D), ("Bksp", 0x08), ("Tab", 0x09),
        ("Caps", 0x14), ("Esc", 0x1B),
        ("Up", 0x26), ("Ddn", 0x28), ("Lft", 0x25), ("Rgt", 0x27),
        ("LSh", 0xA0), ("RSh", 0xA1), ("LCt", 0xA2), ("RCt", 0xA3),
        ("LAl", 0xA4), ("RAl", 0xA5), ("LWn", 0x5B), ("RWn", 0x5C),
        (";", 0xBA), ("=", 0xBB), (",", 0xBC), ("-", 0xBD), (".", 0xBE),
        ("/", 0xBF), ("`", 0xC0), ("[", 0xDB), ("\\", 0xDC), ("]", 0xDD),
        ("'", 0xDE),
    ];
    KEYS.iter()
        .filter(|(_, code)| unsafe { GetAsyncKeyState(*code) } < 0)
        .map(|(name, _)| (*name).to_string())
        .collect()
}