// 额外的桌宠窗口：陪玩狗、Bongo 模式、鼠标跟随宠。
//
// 主窗口只负责“主狗”；陪玩狗、Bongo 和跟随宠按设置懒创建为独立的透明窗口
// （见 `window_factory`），这里只按设置显示/隐藏和定位。默认配置下
// （1 只狗、Bongo 关闭、不跟随鼠标）启动时一只额外窗口都不会创建。

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
// 主桌宠被快捷键/托盘隐藏时，桌上其它小狗（陪伴狗、跟随鼠标的小狗）也要一起消失。
static PETS_HIDDEN: AtomicBool = AtomicBool::new(false);
// 全屏避让时 Bongo 单独一档：和主狗/陪伴狗解耦，用户可以自己选全屏时它留不留在桌上。
static BONGO_HIDDEN: AtomicBool = AtomicBool::new(false);
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

fn bongo_hidden() -> bool {
    BONGO_HIDDEN.load(Ordering::SeqCst)
}

/// 全屏避让时只藏 Bongo；Bongo 的显隐独立于主狗和陪伴狗。
pub fn hide_bongo(app: &AppHandle) {
    BONGO_HIDDEN.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(BONGO_LABEL) {
        let _ = window.hide();
    }
}

/// 全屏结束后按最近的配置把 Bongo 放回原位（开关没开就继续保持隐藏）。
pub fn restore_bongo(app: &AppHandle) {
    BONGO_HIDDEN.store(false, Ordering::SeqCst);
    let config = LAST_CONFIG.lock().ok().and_then(|slot| slot.clone());
    let Some(config) = config else {
        return;
    };
    let _ = sync_bongo(app, &config);
}

const COMPANION_LABELS: [&str; 5] = [
    "companion-1",
    "companion-2",
    "companion-3",
    "companion-4",
    CURSOR_LABEL,
];

fn hide_companion_windows(app: &AppHandle) {
    for label in COMPANION_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

/// 全屏避让：只收陪伴狗和跟随小狗，Bongo 由 `hide_bongo` 单独决定。
pub fn hide_companion_pets(app: &AppHandle) {
    PETS_HIDDEN.store(true, Ordering::SeqCst);
    hide_companion_windows(app);
}

/// 全屏结束：把陪伴狗和跟随小狗放回去（Bongo 由 `restore_bongo` 单独恢复）。
pub fn restore_companion_pets(app: &AppHandle) {
    PETS_HIDDEN.store(false, Ordering::SeqCst);
    let config = LAST_CONFIG.lock().ok().and_then(|slot| slot.clone());
    let Some(config) = config else {
        return;
    };
    let _ = sync_companions(app, config.pet_count);
    let _ = sync_cursor(app, &config);
}

/// 主桌宠被隐藏时调用：Bongo、陪伴狗、跟随鼠标的小狗一起消失。
pub fn hide_extra_pets(app: &AppHandle) {
    PETS_HIDDEN.store(true, Ordering::SeqCst);
    BONGO_HIDDEN.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(BONGO_LABEL) {
        let _ = window.hide();
    }
    hide_companion_windows(app);
}

/// 主桌宠重新出现时调用：按最近一次同步的配置把其它小狗放回去。
pub fn restore_extra_pets(app: &AppHandle) {
    PETS_HIDDEN.store(false, Ordering::SeqCst);
    BONGO_HIDDEN.store(false, Ordering::SeqCst);
    let config = LAST_CONFIG.lock().ok().and_then(|slot| slot.clone());
    let Some(config) = config else {
        return;
    };
    let _ = sync_companions(app, config.pet_count);
    let _ = sync_bongo(app, &config);
    let _ = sync_cursor(app, &config);
}
fn work_area(app: &AppHandle, monitor_key: Option<&str>) -> (i32, i32, i32, i32, f64) {
    // 多屏放置：优先用户指定的那块屏（指纹匹配），拿不到再回主屏。
    if let Some(monitor) = crate::find_extras_monitor(app, monitor_key) {
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

/// 最近一次同步用的配置（用于「切屏 / 显示回来」时按原样重排）。
pub fn last_config() -> Option<DesktopExtrasConfig> {
    LAST_CONFIG.lock().ok().and_then(|slot| slot.clone())
}

/// 立刻按配置重排一次（切屏后不需要等前端重新下发设置）。
pub fn sync_extras_now(app: &AppHandle, config: &DesktopExtrasConfig) -> Result<(), String> {
    sync_companions(app, config.pet_count)?;
    sync_bongo(app, config)?;
    let _ = sync_cursor(app, config);
    Ok(())
}

fn sync_companions(app: &AppHandle, count: u32) -> Result<(), String> {
    let wanted = count.saturating_sub(1).min(COMPANION_MAX);
    let target = crate::extras_target_monitor_key(app);
    let (left, top, width, height, scale) = work_area(app, target.as_deref());
    for index in 1..=COMPANION_MAX {
        let label = format!("{COMPANION_PREFIX}{index}");
        let window = if index <= wanted && !pets_hidden() {
            // 需要显示时才懒创建；创建失败按“没有这只狗”处理，不影响其它狗。
            crate::window_factory::ensure_if_known(app, &label)
        } else {
            app.get_webview_window(&label)
        };
        let Some(window) = window else {
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
            // 窗口创建过就复用，只隐藏不销毁。
            let _ = window.hide();
        }
    }
    Ok(())
}

fn sync_bongo(app: &AppHandle, config: &DesktopExtrasConfig) -> Result<(), String> {
    let wants_visible = config.bongo_enabled && !bongo_hidden() && !pets_hidden();
    let window = if wants_visible {
        crate::window_factory::ensure_if_known(app, BONGO_LABEL)
    } else {
        app.get_webview_window(BONGO_LABEL)
    };
    let Some(window) = window else {
        // 开关没开 / 窗口从未创建：没有可同步的窗口。
        return Ok(());
    };
    let width = config.bongo_size.clamp(220, 700) as f64;
    let height = (width * BONGO_RATIO).round();
    let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(width, height)));
    let _ = window.set_ignore_cursor_events(config.bongo_click_through);
    if wants_visible {
        // Bongo 优先放「Bongo 屏幕」，没单独指定就跟随主岛所在屏。
        let target = crate::extras_target_monitor_key(app);
        let (left, top, screen_w, screen_h, scale) = work_area(app, target.as_deref());
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
    let wants_visible = config.follow_mouse && !pets_hidden();
    let window = if wants_visible {
        crate::window_factory::ensure_if_known(app, CURSOR_LABEL)
    } else {
        app.get_webview_window(CURSOR_LABEL)
    };
    if let Some(window) = window {
        let _ = window.set_ignore_cursor_events(true);
        if wants_visible {
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
            // 跟随宠跟着光标走，工作区用光标所在屏即可（这里用当前屏等效的 primary）；
            // 多屏时它本来就在光标旁边，不需要额外偏好。
            let (left, top, width, height, scale) = work_area(&app, None);
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
    // 记住最近一次配置：主狗隐藏/显示回来时按原样恢复其它小狗。
    if let Ok(mut slot) = LAST_CONFIG.lock() {
        *slot = Some(config.clone());
    }
    // 窗口不再预声明，由 `sync_*` 按配置懒创建：默认配置下这里
    // 一只额外 WebView 都不会建；开启 Bongo / 跟随鼠标 / 多只狗时才创建。
    tauri::async_runtime::spawn_blocking(move || {
        // 三项互不阻断：多宠物失败时，Bongo 和鼠标跟随仍然要生效。
        let _ = sync_companions(&app, config.pet_count);
        let _ = sync_bongo(&app, &config);
        let _ = sync_cursor(&app, &config);

        // 懒创建出来的 Bongo 窗口可能还在加载，或 show 被系统窗口状态吞掉，
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