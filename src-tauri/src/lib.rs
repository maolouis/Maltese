mod activity;
mod clipboard_history;
mod netease;
mod desktop_extras;
mod dsh_api;
mod dsh_chat;
mod local_chat;
mod icons;
mod lyrics;
mod media_control;
mod messenger_activation;
mod notification_diagnostics;
mod pet_gifs;
mod plugins;
mod qq_notifications;
mod qq_mail;
mod wechat_reminder_source;
mod wechat_ocr;
mod wechat_reminders;
mod translation;
mod wake_shortcut;
mod shortcut_hotkeys;
mod video_automation;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::VecDeque,
    env, fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    Position, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::SetWindowRgn,
    UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
    UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetCursorPos, GetWindowRect, IsWindowVisible, ShowWindow,
        SW_HIDE, SW_SHOW, SW_SHOWNORMAL,
    },
};
use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;

const WINDOW_LABEL: &str = "main";
const DEFAULT_MARGIN_Y: f64 = 0.0;
const DEFAULT_COLLAPSED_SCALE: f64 = 0.89;
const DEFAULT_EXPANDED_SCALE: f64 = 0.91;
const MIN_COLLAPSED_ISLAND_WIDTH: f64 = 160.0;
const COLLAPSED_ISLAND_WIDTH: f64 = 180.0;
const COLLAPSED_ISLAND_HEIGHT: f64 = 128.0;
const COLLAPSED_RADIUS: f64 = 76.0;
const EXPANDED_ISLAND_WIDTH: f64 = 560.0;
const DEFAULT_EXPANDED_ISLAND_HEIGHT: f64 = 306.0;
const MIN_EXPANDED_ISLAND_HEIGHT: f64 = 220.0;
const EXPANDED_ISLAND_HEIGHT_RANGE: f64 = 240.0;
const EXPANDED_RADIUS: f64 = 30.0;
const STAGE_WINDOW_PADDING_Y: f64 = 24.0;
const TUCKED_VISIBLE_EDGE_HEIGHT: f64 = 10.0;
// 展开态（云朵面板）固定尺寸：小狗槽 + 8px 间隙 + 面板。
const EXPANDED_PANEL_WIDTH: f64 = 460.0;
const EXPANDED_PANEL_HEIGHT: f64 = 520.0;
const EXPANDED_PANEL_GAP: f64 = 8.0;
// 缩边睡姿默认/可调范围：露出小狗的高度（逻辑像素）。
const DEFAULT_TUCKED_VISIBLE_HEIGHT: f64 = 80.0;
const MIN_TUCKED_VISIBLE_HEIGHT: f64 = 24.0;
const MAX_TUCKED_VISIBLE_HEIGHT: f64 = 140.0;
const POSITION_ANIMATION_DURATION: Duration = Duration::from_millis(320);
const STARTUP_REGISTRY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_REGISTRY_VALUE: &str = "Maltese Desktop Assistant";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const AGENT_STATUS_FILE_NAME: &str = "agent-status.json";
const CODEX_RUNNING_MARKER_FILE_NAME: &str = "agent-codex-running.flag";
const CODEX_RUNNING_HOLD_FILE_NAME: &str = "agent-codex-running-hold.flag";
const CLAUDE_CODE_RUNNING_MARKER_FILE_NAME: &str = "agent-claudeCode-running.flag";
const CLAUDE_CODE_RUNNING_HOLD_FILE_NAME: &str = "agent-claudeCode-running-hold.flag";
const AGENT_RUNNING_SCRIPT_FILE_NAME: &str = "focusd-agent-running.cmd";
const AGENT_STATUS_SCRIPT_FILE_NAME: &str = "focusd-agent-status.ps1";
const AGENT_RUNNING_STALE_AFTER_MS: i64 = 10 * 60 * 1000;
const FOCUSD_AGENT_HOOK_BLOCK_BEGIN: &str = "# BEGIN FocuSD Agent Status Hooks";
const FOCUSD_AGENT_HOOK_BLOCK_END: &str = "# END FocuSD Agent Status Hooks";
const FOCUSD_AGENT_HOOK_SIGNATURE: &str = "focusd-agent-";
const AGENT_RUNNING_SCRIPT: &str = include_str!("../../scripts/focusd-agent-running.cmd");
const AGENT_STATUS_SCRIPT: &str = include_str!("../../scripts/focusd-agent-status.ps1");

static WINDOW_STATE: OnceLock<Mutex<IslandWindowState>> = OnceLock::new();
static POSITION_ANIMATION_GENERATION: AtomicU64 = AtomicU64::new(0);
static NATIVE_GLASS_INITIALIZED: OnceLock<()> = OnceLock::new();

#[derive(Clone, Copy, PartialEq)]
enum IslandMode {
    Collapsed,
    Expanded,
}

impl IslandMode {
    fn from_value(value: &str) -> Result<Self, String> {
        match value {
            "collapsed" => Ok(Self::Collapsed),
            "expanded" => Ok(Self::Expanded),
            _ => Err(format!("Unsupported island mode: {value}")),
        }
    }

    fn base_size(self, collapsed_width: f64, expanded_height: f64) -> (f64, f64) {
        match self {
            Self::Collapsed => (collapsed_width, COLLAPSED_ISLAND_HEIGHT),
            Self::Expanded => (EXPANDED_ISLAND_WIDTH, expanded_height),
        }
    }

    fn corner_radius(self) -> f64 {
        match self {
            Self::Collapsed => COLLAPSED_RADIUS,
            Self::Expanded => EXPANDED_RADIUS,
        }
    }
}

#[derive(Clone, Copy)]
struct IslandWindowState {
    mode: IslandMode,
    is_tucked: bool,
    collapsed_scale: f64,
    expanded_scale: f64,
    margin_y: f64,
    tucked_visible_height: f64,
    collapsed_width: f64,
    expanded_height: f64,
    custom_position: Option<IslandPosition>,
    is_dragging: bool,
    glass_enabled: bool,
    glass_intensity: f64,
    glass_tint: (u8, u8, u8),
}

impl IslandWindowState {
    fn is_detached(self) -> bool {
        self.custom_position.is_some() || self.margin_y > 0.0
    }

    fn top_corner_radius(self) -> f64 {
        if !self.is_detached() {
            return 0.0;
        }
        match self.mode {
            IslandMode::Collapsed => 14.0,
            IslandMode::Expanded => 22.0,
        }
    }

    fn active_scale(self) -> f64 {
        match self.mode {
            IslandMode::Collapsed => self.collapsed_scale,
            IslandMode::Expanded => self.expanded_scale,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
struct IslandPosition {
    x: i32,
    y: i32,
}

impl Default for IslandWindowState {
    fn default() -> Self {
        Self {
            mode: IslandMode::Collapsed,
            is_tucked: false,
            collapsed_scale: DEFAULT_COLLAPSED_SCALE,
            expanded_scale: DEFAULT_EXPANDED_SCALE,
            margin_y: DEFAULT_MARGIN_Y,
            tucked_visible_height: DEFAULT_TUCKED_VISIBLE_HEIGHT,
            collapsed_width: COLLAPSED_ISLAND_WIDTH,
            expanded_height: DEFAULT_EXPANDED_ISLAND_HEIGHT,
            custom_position: None,
            is_dragging: false,
            glass_enabled: false,
            glass_intensity: 72.0,
            glass_tint: (47, 47, 55),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IslandLayout {
    collapsed_scale: f64,
    expanded_scale: f64,
    margin_y: f64,
    #[serde(default = "default_tucked_visible_height")]
    tucked_visible_height: f64,
}

fn default_tucked_visible_height() -> f64 {
    DEFAULT_TUCKED_VISIBLE_HEIGHT
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveTodoMarkdownResult {
    file_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskStatus {
    #[serde(default = "default_agent_phase")]
    phase: String,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    updated_at: i64,
}

impl Default for AgentTaskStatus {
    fn default() -> Self {
        Self {
            phase: default_agent_phase(),
            task_id: None,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAgentStatus {
    #[serde(default)]
    codex: AgentTaskStatus,
    #[serde(default)]
    claude_code: AgentTaskStatus,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatusSnapshot {
    codex: AgentTaskStatus,
    claude_code: AgentTaskStatus,
    updated_at: i64,
    status_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHooksInstallResult {
    scripts_dir: String,
    status_path: String,
    codex_config_path: String,
    claude_config_path: String,
    installed_at: i64,
}

fn default_agent_phase() -> String {
    "idle".to_string()
}

#[tauri::command]
fn get_system_idle_seconds() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            let now = GetTickCount();
            return u64::from(now.saturating_sub(info.dwTime)) / 1000;
        }
    }
    0
}

#[tauri::command]
fn set_island_layout(app: AppHandle, layout: IslandLayout) -> Result<(), String> {
    let window = main_window(&app)?;
    let state = mutate_window_state(|state| {
        state.collapsed_scale = layout.collapsed_scale.clamp(0.5, 1.8);
        state.expanded_scale = layout.expanded_scale.clamp(0.75, 1.4);
        state.margin_y = layout.margin_y.clamp(0.0, 160.0);
        state.tucked_visible_height = layout
            .tucked_visible_height
            .clamp(MIN_TUCKED_VISIBLE_HEIGHT, MAX_TUCKED_VISIBLE_HEIGHT);
        *state
    });
    apply_stage_geometry(&window, state, false)
}

#[tauri::command]
fn set_island_interaction(
    app: AppHandle,
    mode: String,
    collapsed_scale: f64,
    expanded_scale: f64,
    margin_y: Option<f64>,
    tucked_visible_height: Option<f64>,
    expanded_height: Option<f64>,
    collapsed_width: Option<f64>,
    custom_position: Option<IslandPosition>,
    is_tucked: Option<bool>,
    animate_position: Option<bool>,
    glass_enabled: Option<bool>,
    glass_intensity: Option<f64>,
    glass_tint: Option<String>,
) -> Result<String, String> {
    let window = main_window(&app)?;
    let mode = IslandMode::from_value(&mode)?;
    let previous_state = read_window_state();
    let restored_custom_position = previous_state.custom_position.or_else(|| {
        custom_position.filter(|position| {
            monitor_for_island_position(&window, *position, previous_state.collapsed_scale)
                .ok()
                .flatten()
                .is_some()
        })
    });
    if previous_state.mode != mode {
        // 切模式时丢弃可能残留的浮层快照，避免几何被跳过导致小狗停在错误位置/看不到。
        OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = OVERLAY_SNAPSHOT.lock() {
            *slot = None;
        }
    }
    let state = mutate_window_state(|state| {
        state.mode = mode;
        state.is_tucked = is_tucked.unwrap_or(false);
        state.collapsed_scale = collapsed_scale.clamp(0.5, 1.8);
        state.expanded_scale = expanded_scale.clamp(0.75, 1.4);
        if let Some(margin_y) = margin_y {
            state.margin_y = margin_y.clamp(0.0, 160.0);
        }
        if let Some(tucked_visible_height) = tucked_visible_height {
            state.tucked_visible_height = tucked_visible_height
                .clamp(MIN_TUCKED_VISIBLE_HEIGHT, MAX_TUCKED_VISIBLE_HEIGHT);
        }
        if let Some(expanded_height) = expanded_height {
            state.expanded_height = expanded_height.clamp(
                MIN_EXPANDED_ISLAND_HEIGHT,
                DEFAULT_EXPANDED_ISLAND_HEIGHT + EXPANDED_ISLAND_HEIGHT_RANGE,
            );
        }
        if let Some(collapsed_width) = collapsed_width {
            state.collapsed_width =
                collapsed_width.clamp(MIN_COLLAPSED_ISLAND_WIDTH, COLLAPSED_ISLAND_WIDTH);
        }
        if state.custom_position.is_none() {
            state.custom_position = restored_custom_position;
        }
        state.glass_enabled = glass_enabled.unwrap_or(false);
        if let Some(glass_intensity) = glass_intensity {
            state.glass_intensity = glass_intensity.clamp(25.0, 100.0);
        }
        if let Some(glass_tint) = glass_tint.as_deref().and_then(parse_hex_color) {
            state.glass_tint = glass_tint;
        }
        *state
    });
    apply_stage_geometry(
        &window,
        state,
        animate_position.unwrap_or(true) && previous_state.is_tucked != state.is_tucked,
    )?;
    let glass = apply_glass_material(&window, state);
    ensure_island_on_screen(&window);
    glass
}

// 保险：几何应用后窗口如果完全跑到工作区之外（多屏切换 / 异常位置），
// 清掉自定义位置、回到默认锚点并显示，避免“点一下小狗就整个不见了”。
fn ensure_island_on_screen(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let work = monitor.work_area();
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let intersects = position.x < work.position.x + work.size.width as i32
        && position.x + size.width as i32 > work.position.x
        && position.y < work.position.y + work.size.height as i32
        && position.y + size.height as i32 > work.position.y;
    if intersects {
        return;
    }
    let state = mutate_window_state(|state| {
        state.custom_position = None;
        state.is_tucked = false;
        *state
    });
    let _ = apply_stage_geometry(window, state, false);
    let _ = window.show();
}

#[tauri::command]
fn start_island_drag(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    hide_pet_bubble_silent(&app);
    let current_state = read_window_state();

    if !matches!(current_state.mode, IslandMode::Collapsed)
        || current_state.is_tucked
        || current_state.is_dragging
    {
        return Ok(());
    }

    let position = window.outer_position().map_err(|error| error.to_string())?;
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    mutate_window_state(|state| {
        state.custom_position = Some(IslandPosition {
            x: position.x,
            y: position.y,
        });
        state.is_dragging = true;
        *state
    });

    if let Err(error) = window.start_dragging() {
        mutate_window_state(|state| {
            state.is_dragging = false;
            state.custom_position = current_state.custom_position;
            *state
        });
        return Err(error.to_string());
    }

    thread::spawn(move || {
        while unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0 {
            thread::sleep(Duration::from_millis(8));
        }
        thread::sleep(Duration::from_millis(8));

        let final_position = window.outer_position().ok().map(|position| IslandPosition {
            x: position.x,
            y: position.y,
        });
        let did_finish_drag = {
            let mut state = window_state().lock().expect("window state poisoned");
            if !state.is_dragging {
                false
            } else {
                state.is_dragging = false;
                if let Some(position) = final_position {
                    state.custom_position = Some(position);
                }
                true
            }
        };

        if did_finish_drag {
            if let Some(position) = final_position {
                let _ = window.emit("island-position-changed", position);
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn reset_island_position(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let state = mutate_window_state(|state| {
        state.custom_position = None;
        state.is_dragging = false;
        *state
    });

    apply_stage_geometry(&window, state, false)
}

#[tauri::command]
fn minimize_island(app: AppHandle) -> Result<(), String> {
    hide_island(&app);
    Ok(())
}

// 全屏避让：检测前台窗口是否铺满整个显示器（游戏/视频全屏）。
// 排除自身窗口、桌面与壳层窗口，避免误判。
#[tauri::command]
fn is_foreground_fullscreen(app: AppHandle) -> Result<bool, String> {
    let own_hwnd = main_window(&app)
        .and_then(|window| window.hwnd().map_err(|error| error.to_string()))
        .map(|hwnd| hwnd.0 as isize)
        .ok();
    Ok(detect_foreground_fullscreen(own_hwnd))
}

// 主窗口内的桌宠浮层：hover 面板 / 云朵消息 / 右键菜单。
// 通过临时放大主窗口在旁边留出位置，不再依赖额外的气泡窗口。
#[derive(Clone, Copy)]
struct OverlaySnapshot {
    anchor_x: i32,
    anchor_y: i32,
    base_w: f64,
    base_h: f64,
}

static OVERLAY_SNAPSHOT: std::sync::Mutex<Option<OverlaySnapshot>> = std::sync::Mutex::new(None);
// 浮层请求按前端递增的 generation 串行执行：快速收起/重新弹出时，
// 迟到的旧请求不能覆盖新请求，否则窗口会被旧 close 缩回去，气泡只剩下一条。
static OVERLAY_REQUEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static OVERLAY_REQUEST_GENERATION: AtomicU64 = AtomicU64::new(0);
// 浮层打开时主窗口需要正常接收鼠标事件，暂停“鼠标不在岛内就穿透”的逻辑。
static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_island_overlay(
    app: AppHandle,
    overlay: Option<String>,
    generation: Option<u64>,
) -> Result<(), String> {
    let _request_guard = OVERLAY_REQUEST_LOCK
        .lock()
        .map_err(|_| "浮层请求状态不可用".to_string())?;
    if let Some(generation) = generation {
        let previous = OVERLAY_REQUEST_GENERATION.fetch_max(generation, Ordering::SeqCst);
        if generation < previous {
            return Ok(());
        }
    }
    let window = main_window(&app)?;
    let state = read_window_state();
    // 必须和 apply_stage_geometry 用同一块显示器：多屏时 current_monitor() 可能是错的，
    // 误用会导致浮层锚点算错、关掉后小狗瞬移。
    let monitor = state
        .custom_position
        .and_then(|position| {
            monitor_for_island_position(&window, position, state.collapsed_scale)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "没有可用的显示器".to_string())?;
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let mon_pos = work_area.position;
    let mon_size = work_area.size;
    let mon_left = mon_pos.x;
    let mon_right = mon_pos.x + mon_size.width as i32;
    let mon_bottom = mon_pos.y + mon_size.height as i32;
    // 与 apply_stage_geometry 保持一致：尺寸走 Logical，避免高 DPI 下窗口比 CSS 预期小。
    let (base_w, base_h) = stage_dimensions(state);

    match overlay.as_deref() {
        None => {
            OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
            let snapshot = OVERLAY_SNAPSHOT.lock().ok().and_then(|mut slot| slot.take());
            if let Some(snapshot) = snapshot {
                // 浮层打开时窗口向上展开（小狗锚定在底部），收起时连同位置一起恢复，小狗不移动。
                let _ = window.set_size(Size::Logical(LogicalSize::new(
                    snapshot.base_w.max(1.0),
                    snapshot.base_h.max(1.0),
                )));
                // 原样恢复小狗槽锚点。这里不要按“展开后的窗口尺寸”再 clamp 一次，
                // 否则靠屏幕边缘的小狗每开合一次气泡都会被往内挤一点，越飘越远。
                let _ = window.set_position(Position::Physical(PhysicalPosition::new(
                    snapshot.anchor_x,
                    snapshot.anchor_y,
                )));
            }
            // 缩回后再按最新状态套一次几何（浮层期间可能改过大小/位置）。
            let state = read_window_state();
            apply_stage_geometry(&window, state, false)
        }
        Some(mode) => {
            // 面板高度按真实内容留足空间：云朵气泡可能带标题 + 4 行文字 + 缩略图，
            // hover 面板是 9 个竖排按钮。高度不够时内容会被窗口裁掉。
            let (panel_w, panel_h): (f64, f64) = match mode {
                "hover" => (320.0, 540.0),
                "menu" => (210.0, 260.0),
                _ => (300.0, 400.0),
            };
            OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
            let gap = 8.0;

            // 注意：读快照时必须先释放锁再调用 apply_stage_geometry，
            // 否则它会尝试再锁 OVERLAY_SNAPSHOT（死锁，整个窗口会卡死）。
            let existing_snapshot = {
                let slot = OVERLAY_SNAPSHOT
                    .lock()
                    .map_err(|_| "浮层状态不可用".to_string())?;
                *slot
            };
            let snapshot = match existing_snapshot {
                Some(snapshot) => snapshot,
                None => {
                    // 先把窗口“落定”到目标位置（取消可能还在跑的位移动画），
                    // 否则会把动画中间位置当成锚点，关浮层后小狗就瞬移。
                    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
                    let settled_state = read_window_state();
                    let _ = apply_stage_geometry(&window, settled_state, false);
                    // 位移动画可能还没把原生窗口挪到位；custom_position 记录的是
                    // 小狗槽的最终左上角，用它当锚点才能避免“浮层按旧位置选上下”。
                    let position = window.outer_position().map_err(|error| error.to_string())?;
                    let anchor = settled_state.custom_position.unwrap_or(IslandPosition {
                        x: position.x,
                        y: position.y,
                    });
                    let snapshot = OverlaySnapshot {
                        anchor_x: anchor.x,
                        anchor_y: anchor.y,
                        base_w,
                        base_h,
                    };
                    if let Ok(mut slot) = OVERLAY_SNAPSHOT.lock() {
                        *slot = Some(snapshot);
                    }
                    snapshot
                }
            };

            // 优先朝右/上长；右侧放不下就翻到左侧。小狗的屏幕位置不变，
            // 所以这里不能 clamp 窗口位置，否则小狗会跟着窗口跳。
            let base_w_phys = (snapshot.base_w * scale).round() as i32;
            let base_h_phys = (snapshot.base_h * scale).round() as i32;
            let desired_w_phys = ((snapshot.base_w + gap + panel_w) * scale).round() as i32;
            let panel_side = expanded_panel_side(
                snapshot.anchor_x,
                base_w_phys,
                desired_w_phys,
                mon_left,
                mon_right,
            );
            let side_space = if panel_side == "right" {
                (mon_right - snapshot.anchor_x).max(0)
            } else {
                (snapshot.anchor_x + base_w_phys - mon_left).max(0)
            };
            let desired_h_phys = (panel_h * scale).round() as i32;
            // 主窗口里的浮层和独立气泡窗口不同：翻到下方时，小狗槽仍占窗口顶部，
            // 面板只能从槽位下方开始。因此窗口高度必须把槽高和间隙一起算进去，
            // 否则面板会被窗口底边裁掉一截（表现为“向下显示不全”）。
            let panel_vertical = overlay_panel_vertical(
                snapshot.anchor_y,
                base_h_phys,
                (gap * scale).round() as i32,
                desired_h_phys,
                mon_pos.y,
                mon_bottom,
            );
            let avail_v = if panel_vertical == "above" {
                ((snapshot.anchor_y + base_h_phys - mon_pos.y) as f64 / scale)
                    .max(snapshot.base_h)
            } else {
                ((mon_bottom - snapshot.anchor_y) as f64 / scale).max(snapshot.base_h)
            };
            let width = (snapshot.base_w + gap + panel_w)
                .min((side_space as f64) / scale)
                .max(snapshot.base_w + gap + 120.0);
            let height = overlay_window_height(
                panel_vertical,
                snapshot.base_h,
                gap,
                panel_h,
                avail_v,
            );
            let phys_w = (width * scale).round() as i32;
            let phys_h = (height * scale).round() as i32;
            let x = if panel_side == "left" {
                snapshot.anchor_x + base_w_phys - phys_w
            } else {
                snapshot.anchor_x
            };
            let y = if panel_vertical == "above" {
                snapshot.anchor_y + base_h_phys - phys_h
            } else {
                snapshot.anchor_y
            };
            let _ = window.emit("maltese-panel-side", panel_side);
            let _ = window.emit("maltese-panel-vertical", panel_vertical);
            window
                .set_size(Size::Logical(LogicalSize::new(width, height)))
                .map_err(|error| error.to_string())?;
            window
                .set_position(Position::Physical(PhysicalPosition::new(x, y)))
                .map_err(|error| error.to_string())?;
            Ok(())
        }
    }
}

// 设置窗口点 X 时只隐藏，避免窗口被销毁后再也打不开。
fn attach_settings_close(window: &WebviewWindow) {
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = target.hide();
        }
    });
}

fn build_settings_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Maltese · 桌宠设置")
    .inner_size(560.0, 780.0)
    .min_inner_size(460.0, 560.0)
    .resizable(true)
    .center()
    .visible(false)
    .build()
    .map_err(|error| format!("无法创建设置窗口：{error}"))?;
    attach_settings_close(&window);
    Ok(window)
}

// 独立的桌宠设置窗口：简单、浅色、改完即生效。
#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("settings") {
        Some(window) => window,
        None => build_settings_window(&app)?,
    };
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_island_no_focus(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    // 窗口已经显示时不要再套用收起态几何：云朵浮层/面板可能正把窗口放大，
    // 这里再 resize 一次会把刚展开的浮层瞬间缩回去（表现为浮窗出不来、频闪）。
    let visible = window.is_visible().unwrap_or(false);
    if !visible {
        apply_stage_geometry(&window, read_window_state(), false)?;
    }
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

// ---------- 桌宠气泡窗口与内嵌服务窗口 ----------

const BUBBLE_WINDOW_LABEL: &str = "bubble";

// 气泡窗口的内容缓存：窗口冷启动/事件早于监听器注册时，前端可以主动补取。
static BUBBLE_PAYLOAD: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

// 在小狗侧边显示气泡（mode: "hover" 互动面板 / "cloud" 云朵消息框）。
#[tauri::command]
fn show_pet_bubble(
    app: AppHandle,
    mode: String,
    title: Option<String>,
    body: Option<String>,
    ttl_ms: Option<u64>,
) -> Result<(), String> {
    let main = main_window(&app)?;
    let bubble = app
        .get_webview_window(BUBBLE_WINDOW_LABEL)
        .ok_or_else(|| "气泡窗口未注册".to_string())?;

    // 小狗被隐藏/最小化时，先让它在桌面上出现（不抢焦点），再浮出气泡。
    if !main.is_visible().unwrap_or(true) {
        let _ = apply_stage_geometry(&main, read_window_state(), false);
        let _ = main.show();
    }

    // 不同形态用不同窗口尺寸：互动面板是竖排按钮，云朵/菜单保持小窗。
    let desired = match mode.as_str() {
        "hover" => LogicalSize::new(320.0, 500.0),
        "menu" => LogicalSize::new(240.0, 232.0),
        _ => LogicalSize::new(300.0, 224.0),
    };
    let _ = bubble.set_size(Size::Logical(desired));

    let main_pos = main
        .outer_position()
        .map_err(|error| error.to_string())?;
    let main_size = main.outer_size().map_err(|error| error.to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "没有可用的显示器".to_string())?;
    let work_area = monitor.work_area();
    let mon_pos = work_area.position;
    let mon_size = work_area.size;
    let scale = monitor.scale_factor();
    let bubble_width = (desired.width * scale).round() as i32;
    let bubble_height = (desired.height * scale).round() as i32;

    // 优先放在小狗右侧，放不下则翻到左侧；上下也自动翻：
    // 上方不够就贴到小狗下方，下方不够就贴到小狗上方。
    let gap = 8i32;
    let mut x = main_pos.x + main_size.width as i32 + gap;
    if x + bubble_width > mon_pos.x + mon_size.width as i32 {
        x = main_pos.x - bubble_width - gap;
    }
    x = x.clamp(mon_pos.x, mon_pos.x + mon_size.width as i32 - bubble_width);
    let vertical = expanded_panel_vertical(
        main_pos.y,
        main_size.height as i32,
        bubble_height,
        mon_pos.y,
        mon_pos.y + mon_size.height as i32,
    );
    let desired_y = if vertical == "above" {
        main_pos.y + main_size.height as i32 - bubble_height
    } else {
        main_pos.y
    };
    let y = desired_y.clamp(
        mon_pos.y,
        mon_pos.y + mon_size.height as i32 - bubble_height,
    );

    bubble
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())?;
    let payload = json!({ "mode": mode, "title": title, "body": body, "ttlMs": ttl_ms });
    if let Ok(mut cached) = BUBBLE_PAYLOAD.lock() {
        *cached = Some(payload.clone());
    }
    bubble.show().map_err(|error| error.to_string())?;
    bubble
        .emit("pet-bubble-content", payload)
        .map_err(|error| error.to_string())?;
    Ok(())
}

// 前端（气泡窗口）启动后补取最后一次气泡内容，避免冷启动丢事件。
#[tauri::command]
fn get_pet_bubble_payload() -> Option<serde_json::Value> {
    BUBBLE_PAYLOAD.lock().ok().and_then(|payload| payload.clone())
}

// 随机闲逛：在显示器范围内左右挪一小步，带回弹动画。
#[tauri::command]
fn roam_island_step(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    if !window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let state = read_window_state();
    if !matches!(state.mode, IslandMode::Collapsed) || state.is_tucked || state.is_dragging {
        return Ok(());
    }
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "没有可用的显示器".to_string())?;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let scale = monitor.scale_factor();
    let (stage_width, stage_height) = stage_dimensions(state);
    let width = (stage_width * scale).round() as i32;
    let height = (stage_height * scale).round() as i32;
    let current = window.outer_position().map_err(|error| error.to_string())?;

    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as i64)
        .unwrap_or(0);
    let offset = ((seed % 361) - 180) as i32;
    let max_x = mon_pos.x + mon_size.width as i32 - width;
    let max_y = mon_pos.y + mon_size.height as i32 - height;
    let x = (current.x + offset).clamp(mon_pos.x, max_x.max(mon_pos.x));
    let y = current.y.clamp(mon_pos.y, max_y.max(mon_pos.y));

    let next = mutate_window_state(|state| {
        state.custom_position = Some(IslandPosition { x, y });
        *state
    });
    apply_stage_geometry(&window, next, true)
}

// 把桌宠固定到屏幕某个角落（tl/tr/bl/br），空字符串表示解除固定。
#[tauri::command]
fn lock_island_corner(app: AppHandle, corner: String) -> Result<(), String> {
    let window = main_window(&app)?;
    if corner.is_empty() {
        let state = mutate_window_state(|state| {
            state.custom_position = None;
            *state
        });
        return apply_stage_geometry(&window, state, false);
    }
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "没有可用的显示器".to_string())?;
    let scale = monitor.scale_factor();
    let state = read_window_state();
    // custom_position 是“小狗槽”的左上角，不是展开面板窗口的左上角。
    // 这里必须用收起态槽位尺寸，否则面板展开时会把小狗放到屏幕中间。
    let slot_width = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_height = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    const MARGIN: i32 = 16;
    let work = monitor.work_area();
    let x = match corner.as_str() {
        "tl" | "bl" => work.position.x + MARGIN,
        _ => work.position.x + work.size.width as i32 - slot_width - MARGIN,
    };
    let y = match corner.as_str() {
        "tl" | "tr" => work.position.y + MARGIN,
        _ => work.position.y + work.size.height as i32 - slot_height - MARGIN,
    };
    let position = IslandPosition { x, y };
    let state = mutate_window_state(|state| {
        state.custom_position = Some(position);
        state.is_dragging = false;
        *state
    });
    let result = apply_stage_geometry(&window, state, false);
    if result.is_ok() {
        // 让前端把新位置写进 localStorage，避免下次启动被旧拖拽位置覆盖。
        let _ = window.emit("island-position-changed", position);
    }
    result
}

#[tauri::command]
fn hide_pet_bubble(app: AppHandle) -> Result<(), String> {
    if let Some(bubble) = app.get_webview_window(BUBBLE_WINDOW_LABEL) {
        let _ = bubble.hide();
    }
    Ok(())
}

fn hide_pet_bubble_silent(app: &AppHandle) {
    if let Some(bubble) = app.get_webview_window(BUBBLE_WINDOW_LABEL) {
        let _ = bubble.hide();
    }
}

fn detect_foreground_fullscreen(own_hwnd: Option<isize>) -> bool {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, IsWindowVisible,
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return false;
        }
        if own_hwnd.is_some_and(|hwnd| hwnd == foreground.0 as isize) {
            return false;
        }
        if foreground == GetDesktopWindow() || foreground == GetShellWindow() {
            return false;
        }
        if !IsWindowVisible(foreground).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(foreground, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let bounds = info.rcMonitor;
        const TOLERANCE: i32 = 2;
        rect.left <= bounds.left + TOLERANCE
            && rect.top <= bounds.top + TOLERANCE
            && rect.right >= bounds.right - TOLERANCE
            && rect.bottom >= bounds.bottom - TOLERANCE
    }
}


#[tauri::command]
fn show_ready_island(app: AppHandle) -> Result<(), String> {
    show_island(&app)
}

#[tauri::command]
fn get_launch_at_startup() -> Result<bool, String> {
    let mut command = Command::new("reg");
    let status = command
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", STARTUP_REGISTRY_KEY, "/v", STARTUP_REGISTRY_VALUE])
        .status()
        .map_err(|error| format!("Failed to query startup registry: {error}"))?;

    Ok(status.success())
}

#[tauri::command]
fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    let status = if enabled {
        let current_exe = std::env::current_exe()
            .map_err(|error| format!("Failed to resolve current executable: {error}"))?;
        let startup_value = format!("\"{}\"", current_exe.display());

        let mut command = Command::new("reg");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "add",
                STARTUP_REGISTRY_KEY,
                "/v",
                STARTUP_REGISTRY_VALUE,
                "/t",
                "REG_SZ",
                "/d",
            ])
            .arg(startup_value)
            .arg("/f")
            .status()
    } else {
        let mut command = Command::new("reg");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "delete",
                STARTUP_REGISTRY_KEY,
                "/v",
                STARTUP_REGISTRY_VALUE,
                "/f",
            ])
            .status()
    }
    .map_err(|error| format!("Failed to update startup registry: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Startup registry command failed.".to_string())
    }
}

fn spawn_detached(mut command: Command) -> Result<(), String> {
    command
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.display()));
    }

    let mut command = Command::new("explorer.exe");
    command.arg(path);
    spawn_detached(command)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommonScript {
    name: String,
    path: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredShortcut {
    label: String,
    path: String,
    kind: String,
    category: String,
}

fn system_app_roots() -> Vec<PathBuf> {
    let user_profile = env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Administrator"));
    let app_data = env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| user_profile.join("AppData\\Roaming"));
    let program_data = env::var("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\ProgramData"));
    vec![
        user_profile.join("Desktop"),
        app_data.join("Microsoft\\Windows\\Start Menu\\Programs"),
        program_data.join("Microsoft\\Windows\\Start Menu\\Programs"),
    ]
}

fn shortcut_scan_roots(scan_dir: Option<&str>) -> Vec<PathBuf> {
    if let Some(scan_dir) = scan_dir.map(str::trim).filter(|value| !value.is_empty()) {
        // 用户指定目录后只扫描这个目录，不再遍历开始菜单、Program Files
        // 等系统目录；这样既快，也不会把整台电脑的启动项都混进来。
        return vec![PathBuf::from(scan_dir)];
    }
    // 默认读取桌面 + 开始菜单：这些是 Windows 自己识别并展示给用户的
    // 软件入口，不递归 Program Files，也不扫整块磁盘。
    system_app_roots()
}

fn classify_shortcut(label: &str) -> &'static str {
    let normalized = label.to_ascii_lowercase();
    if label.contains("豆包") || normalized.contains("doubao") {
        "doubao"
    } else if normalized.contains("clash") {
        "clash"
    } else if normalized.contains("watt") {
        "watt"
    } else if normalized.contains("powertoys") || label.contains("PowerToys") {
        "powertoys"
    } else if normalized.contains("geek") || label.contains("卸载") {
        "geek"
    } else if normalized.contains("bilibili") || label.contains("哔哩") {
        "bilibili"
    } else if normalized.contains("douyin") || label.contains("抖音") {
        "douyin"
    } else {
        "other"
    }
}

fn scan_shortcuts(
    roots: Vec<PathBuf>,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<DiscoveredShortcut>, String> {
    if roots.is_empty() {
        return Err("快捷方式扫描目录不可用。".to_string());
    }
    let missing = roots
        .iter()
        .find(|root| !root.is_dir())
        .map(|root| root.to_string_lossy().to_string());
    let roots = roots.into_iter().filter(|root| root.is_dir()).collect::<Vec<_>>();
    if roots.is_empty() {
        return Err(format!(
            "快捷方式扫描目录不存在：{}",
            missing.unwrap_or_default()
        ));
    }
    let needle = query.map(|value| value.trim().to_lowercase()).filter(|value| !value.is_empty());
    let mut queue: VecDeque<(PathBuf, u8)> = roots.into_iter().map(|root| (root, 0)).collect();
    let mut discovered = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut seen_paths = std::collections::HashSet::new();
    while let Some((directory, depth)) = queue.pop_front() {
        let canonical = directory.canonicalize().unwrap_or(directory.clone());
        if !visited.insert(canonical.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&canonical) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if depth < 2 {
                    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
                    if !name.starts_with('.') && !matches!(name, "node_modules" | "WindowsApps" | "System32") {
                        queue.push_back((path, depth + 1));
                    }
                }
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
            if !matches!(extension.as_str(), "lnk" | "url" | "exe" | "bat" | "cmd" | "ps1" | "py") {
                continue;
            }
            let label = path.file_stem().and_then(|value| value.to_str()).unwrap_or("应用").to_string();
            let lower_label = label.to_lowercase();
            // 开始菜单里常有“卸载 / Uninstall”入口，不能当成应用加入快捷入口。
            if label.contains("卸载") || lower_label.contains("uninstall") {
                continue;
            }
            if let Some(needle) = needle.as_deref() {
                if !label.to_lowercase().contains(needle) {
                    continue;
                }
            }
            let path_text = path.to_string_lossy().to_string();
            if !seen_paths.insert(path_text.to_lowercase()) {
                continue;
            }
            discovered.push(DiscoveredShortcut {
                category: classify_shortcut(&label).to_string(),
                label,
                path: path_text,
                kind: extension,
            });
            if discovered.len() >= limit {
                discovered.sort_by(|left, right| left.label.to_lowercase().cmp(&right.label.to_lowercase()));
                return Ok(discovered);
            }
        }
    }
    discovered.sort_by(|left, right| left.label.to_lowercase().cmp(&right.label.to_lowercase()));
    Ok(discovered)
}

#[tauri::command]
fn discover_shortcuts(scan_dir: Option<String>) -> Result<Vec<DiscoveredShortcut>, String> {
    scan_shortcuts(shortcut_scan_roots(scan_dir.as_deref()), None, 240)
}

#[tauri::command]
fn discover_installed_apps(query: Option<String>) -> Result<Vec<DiscoveredShortcut>, String> {
    // 系统开始菜单/桌面里的入口就是 Windows 识别并展示的应用；
    // 搜索只在这个范围内进行，不扫描磁盘。
    scan_shortcuts(system_app_roots(), query.as_deref(), 200)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartApp {
    label: String,
    app_id: String,
}

/// 读取 Windows 登记的“开始菜单应用”清单（含 Microsoft Store / MSIX 应用）。
///
/// 商店应用不会在开始菜单目录里生成 .lnk，文件扫描永远找不到，
/// 例如 ChatGPT 只有 `WindowsApps\chatgpt-desktop.exe` 这个执行别名，
/// 所以这里走 Get-StartApps 拿到 Name + AppID，启动时用 shell:AppsFolder。
#[tauri::command]
fn discover_start_apps(query: Option<String>) -> Result<Vec<StartApp>, String> {
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
             Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ])
        .creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("无法读取开始菜单应用：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|error| format!("开始菜单应用清单解析失败：{error}"))?;
    let rows = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    let needle = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let mut apps = Vec::new();
    for row in rows {
        let label = row
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let app_id = row
            .get("AppID")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if label.is_empty() || app_id.is_empty() {
            continue;
        }
        if let Some(needle) = needle.as_deref() {
            if !label.to_lowercase().contains(needle) {
                continue;
            }
        }
        apps.push(StartApp { label, app_id });
        if apps.len() >= 60 {
            break;
        }
    }
    Ok(apps)
}

/// 启动 shell:AppsFolder 里的应用（Store / MSIX 应用都走这里）。
#[tauri::command]
fn launch_start_app(app_id: String) -> Result<(), String> {
    let app_id = app_id.trim();
    if app_id.is_empty() || app_id.contains('"') {
        return Err("应用标识无效。".to_string());
    }
    let mut command = Command::new("explorer.exe");
    command.arg(format!("shell:AppsFolder\\{app_id}"));
    spawn_detached(command)
}

/// 找到桌面图标所在的 SysListView32。
///
/// Win10/11 有两种挂载方式：直接挂在 Progman 下，或者挂在某个 WorkerW 下，
/// 两种都要试一遍，否则切换桌面图标会“成功”但没有任何变化。
fn desktop_icon_view() -> Option<HWND> {
    unsafe {
        let mut view = HWND::default();
        if let Ok(progman) = FindWindowW(w!("Progman"), None) {
            view = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None)
                .unwrap_or_default();
        }
        if view.0.is_null() {
            let mut worker = HWND::default();
            loop {
                worker = match FindWindowExW(None, Some(worker), w!("WorkerW"), None) {
                    Ok(next) if !next.0.is_null() => next,
                    _ => break,
                };
                view = FindWindowExW(Some(worker), None, w!("SHELLDLL_DefView"), None)
                    .unwrap_or_default();
                if !view.0.is_null() {
                    break;
                }
            }
        }
        if view.0.is_null() {
            return None;
        }
        let list = FindWindowExW(Some(view), None, w!("SysListView32"), None).ok()?;
        (!list.0.is_null()).then_some(list)
    }
}

#[tauri::command]
fn get_desktop_icons_visible() -> Result<bool, String> {
    match desktop_icon_view() {
        Some(list) => Ok(unsafe { IsWindowVisible(list).as_bool() }),
        None => Err("找不到桌面图标视图。".to_string()),
    }
}

#[tauri::command]
fn set_desktop_icons_visible(visible: bool) -> Result<bool, String> {
    let list = desktop_icon_view().ok_or("找不到桌面图标视图。")?;
    unsafe {
        let _ = ShowWindow(list, if visible { SW_SHOW } else { SW_HIDE });
        Ok(IsWindowVisible(list).as_bool())
    }
}

/// 用 ShellExecute 直接打开文件。
///
/// 之前走 `cmd.exe /C start`：每次点击都要先拉起一个 cmd 控制台，再转给
/// shell 打开目标，多出来的进程启动是点击到窗口出现之间最明显的那段延迟，
/// 而且会闪一下黑框。ShellExecute 本身就是资源管理器双击的入口，快得多。
fn shell_execute(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 返回值 <= 32 表示失败（这是 Win32 的约定）。
    if result.0 as isize <= 32 {
        return Err(format!("无法打开：{}", path.display()));
    }
    Ok(())
}

fn launch_canonical_path(canonical_path: &Path) -> Result<(), String> {
    let extension = canonical_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "ps1" => {
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(canonical_path);
            spawn_detached(command)
        }
        "py" => {
            let mut command = Command::new("py.exe");
            command.arg(canonical_path);
            spawn_detached(command)
        }
        // .lnk / .url / .bat / .cmd / .exe 都交给 ShellExecute，
        // 和资源管理器双击同一条路径，省掉 cmd 这一跳。
        _ => shell_execute(canonical_path),
    }
}

/// 打开用户明确指定的入口。桌面发现的入口走白名单校验；
/// 自定义快捷方式和用户为快捷方式绑定的全局热键走这里。
pub(crate) fn launch_shortcut_path(path: PathBuf) -> Result<(), String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("无法读取快捷入口：{error}"))?;
    launch_canonical_path(&canonical_path)
}

#[tauri::command]
fn launch_discovered_shortcut(
    path: String,
    scan_dir: Option<String>,
) -> Result<(), String> {
    let requested = PathBuf::from(path.trim());
    let canonical_path = requested.canonicalize().map_err(|error| format!("无法读取快捷入口：{error}"))?;
    let allowed = shortcut_scan_roots(scan_dir.as_deref())
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical_path.starts_with(root));
    if !allowed {
        return Err("只能打开自动发现目录中的入口。".to_string());
    }
    launch_canonical_path(&canonical_path)
}

/// 自定义快捷方式允许任意本机路径（由用户主动添加），
/// 不复用“只能打开自动发现目录”的限制。
#[tauri::command]
fn launch_custom_shortcut(path: String) -> Result<(), String> {
    launch_shortcut_path(PathBuf::from(path.trim()))
}

fn common_scripts_directory() -> PathBuf {
    env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Administrator"))
        .join("Desktop")
        .join("常用脚本")
}

#[tauri::command]
fn list_common_scripts() -> Result<Vec<CommonScript>, String> {
    let directory = common_scripts_directory();
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut scripts = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "bat" | "cmd" | "ps1" | "py" | "lnk") {
            continue;
        }
        scripts.push(CommonScript {
            name: path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("脚本")
                .to_string(),
            path: path.to_string_lossy().to_string(),
            kind: extension,
        });
    }
    scripts.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(scripts)
}

#[tauri::command]
fn run_common_script(path: String) -> Result<(), String> {
    let requested = PathBuf::from(path.trim());
    let directory = common_scripts_directory();
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("无法读取脚本目录：{error}"))?;
    let canonical_path = requested
        .canonicalize()
        .map_err(|error| format!("无法读取脚本：{error}"))?;
    if !canonical_path.starts_with(&canonical_directory) {
        return Err("只能运行常用脚本目录中的文件。".to_string());
    }
    let extension = canonical_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "ps1" => {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
            command.arg(canonical_path);
            spawn_detached(command)
        }
        "py" => {
            let mut command = Command::new("py.exe");
            command.arg(canonical_path);
            spawn_detached(command)
        }
        "bat" | "cmd" | "lnk" => {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "start", "", canonical_path.to_string_lossy().as_ref()]);
            spawn_detached(command)
        }
        _ => Err("不支持的脚本类型。".to_string()),
    }
}

#[tauri::command]
fn launch_tool(tool: String) -> Result<(), String> {
    let normalized = tool.trim().to_ascii_lowercase();
    if normalized == "calculator" {
        return spawn_detached(Command::new("calc.exe"));
    }
    if normalized == "scripts" {
        let desktop = env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Administrator"));
        return open_local_path(desktop.join("Desktop").join("常用脚本").to_string_lossy().to_string());
    }

    let program_files = env::var("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Program Files"));
    let local_app_data = env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Administrator\\AppData\\Local"));
    let program_files_x86 = env::var("ProgramFiles(x86)")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Program Files (x86)"));
    let candidates: Vec<PathBuf> = match normalized.as_str() {
        "youdaodict" => vec![
            program_files_x86.join("Youdao\\Dict\\YoudaoDict.exe"),
            program_files.join("Youdao\\Dict\\YoudaoDict.exe"),
            local_app_data.join("Youdao\\Dict\\Application\\YoudaoDict.exe"),
            program_files_x86.join("Youdao\\DesktopDict\\YoudaoDict.exe"),
        ],
        "clash" => vec![
            program_files.join("Clash Verge\\Clash Verge.exe"),
            program_files.join("Clash for Windows\\Clash for Windows.exe"),
            local_app_data.join("Programs\\Clash Verge\\Clash Verge.exe"),
        ],
        "watt" => vec![
            program_files.join("Watt Toolkit\\Watt Toolkit.exe"),
            local_app_data.join("Watt Toolkit\\Watt Toolkit.exe"),
        ],
        "geek" => vec![
            program_files.join("Geek Uninstaller\\geek.exe"),
            program_files.join("Geek Uninstaller\\geek.exe"),
        ],
        "powertoys" => vec![
            program_files.join("PowerToys\\PowerToys.exe"),
            local_app_data.join("Microsoft\\WindowsApps\\PowerToys.exe"),
        ],
        "netease" => vec![
            program_files_x86.join("Netease\\CloudMusic\\cloudmusic.exe"),
            program_files.join("Netease\\CloudMusic\\cloudmusic.exe"),
            program_files_x86.join("NetEase\\CloudMusic\\cloudmusic.exe"),
            program_files.join("NetEase\\CloudMusic\\cloudmusic.exe"),
            local_app_data.join("Netease\\CloudMusic\\cloudmusic.exe"),
            local_app_data.join("Programs\\Netease\\CloudMusic\\cloudmusic.exe"),
        ],
        "doubao" => vec![
            local_app_data.join("Programs\\Doubao\\Doubao.exe"),
            local_app_data.join("Doubao\\Doubao.exe"),
            program_files.join("Doubao\\Doubao.exe"),
            program_files_x86.join("Doubao\\Doubao.exe"),
        ],
        _ => return Err(format!("未知工具：{tool}")),
    };

    let path = candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("没有找到 {tool}，可在设置中补充安装路径。"))?;
    spawn_detached(Command::new(path))
}


const INTERNET_SETTINGS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

fn registry_value(key: &str, value: &str) -> Option<String> {
    let output = Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", key, "/v", value])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains(value))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
}

fn normalize_proxy(raw: &str) -> String {
    let entries: Vec<&str> = raw.split(';').map(str::trim).filter(|entry| !entry.is_empty()).collect();
    let server = ["https=", "http="]
        .iter()
        .find_map(|prefix| entries.iter().find_map(|entry| entry.strip_prefix(prefix)))
        .unwrap_or_else(|| entries.first().copied().unwrap_or(""));

    if server.contains("://") {
        server.to_string()
    } else {
        format!("http://{server}")
    }
}

/// Proxy for the updater: explicit env vars win, else the Windows system proxy.
#[tauri::command]
fn get_updater_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(normalize_proxy(value));
            }
        }
    }

    if registry_value(INTERNET_SETTINGS_KEY, "ProxyEnable")?.trim() != "0x1" {
        return None;
    }

    let server = registry_value(INTERNET_SETTINGS_KEY, "ProxyServer")?;
    if server.trim().is_empty() {
        return None;
    }

    Some(normalize_proxy(&server))
}

/// Whether this build carries an updater public key. Only release builds do:
/// the key is injected at build time, so a plain `tauri build` (and dev runs)
/// cannot check for updates and the settings panel hides the action.
#[tauri::command]
fn updater_configured(app: AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|value| value.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

#[tauri::command]
fn save_todo_markdown(
    directory: String,
    date: String,
    content: String,
) -> Result<SaveTodoMarkdownResult, String> {
    let directory = directory.trim();

    if directory.is_empty() {
        return Err("Todo save path is empty.".to_string());
    }

    if !date.chars().all(|ch| ch.is_ascii_digit() || ch == '-') {
        return Err("Todo date contains invalid filename characters.".to_string());
    }

    let directory_path = PathBuf::from(directory);
    fs::create_dir_all(&directory_path).map_err(|error| error.to_string())?;

    let file_path = directory_path.join(format!("{date}.md"));
    fs::write(&file_path, content).map_err(|error| error.to_string())?;

    Ok(SaveTodoMarkdownResult {
        file_path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn get_default_todo_save_directory() -> Result<String, String> {
    let home_dir = windows_home_dir()?;
    Ok(home_dir
        .join("Documents")
        .join("FocuSD")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
async fn get_agent_status(app: AppHandle) -> Result<AgentStatusSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || read_agent_status(app))
        .await
        .map_err(|error| format!("Failed to join the agent status task: {error}"))?
}

fn read_agent_status(app: AppHandle) -> Result<AgentStatusSnapshot, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    let status_path = app_dir.join(AGENT_STATUS_FILE_NAME);
    let status_path_display = status_path.to_string_lossy().to_string();
    let mut snapshot = match fs::read_to_string(&status_path) {
        Ok(content) => match serde_json::from_str::<PersistedAgentStatus>(&content) {
            Ok(persisted) => agent_status_snapshot_from_persisted(persisted, status_path_display),
            Err(_) => default_agent_status_snapshot(status_path_display),
        },
        Err(_) => default_agent_status_snapshot(status_path_display),
    };
    apply_agent_running_markers(&app_dir, &mut snapshot);

    Ok(snapshot)
}

#[tauri::command]
fn clear_agent_status(app: AppHandle, provider: String) -> Result<AgentStatusSnapshot, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    let status_path = app_dir.join(AGENT_STATUS_FILE_NAME);
    let status_path_display = status_path.to_string_lossy().to_string();
    let mut persisted = match fs::read_to_string(&status_path) {
        Ok(content) => serde_json::from_str::<PersistedAgentStatus>(&content)
            .unwrap_or_else(|_| default_persisted_agent_status()),
        Err(_) => default_persisted_agent_status(),
    };

    let now = current_unix_millis();
    let cleared_status = AgentTaskStatus {
        phase: default_agent_phase(),
        task_id: None,
        updated_at: now,
    };

    match provider.as_str() {
        "codex" => {
            persisted.codex = cleared_status;
            remove_agent_marker_files(
                &app_dir,
                CODEX_RUNNING_MARKER_FILE_NAME,
                CODEX_RUNNING_HOLD_FILE_NAME,
            );
        }
        "claudeCode" => {
            persisted.claude_code = cleared_status;
            remove_agent_marker_files(
                &app_dir,
                CLAUDE_CODE_RUNNING_MARKER_FILE_NAME,
                CLAUDE_CODE_RUNNING_HOLD_FILE_NAME,
            );
        }
        _ => {
            return Err("Unsupported agent provider.".to_string());
        }
    }

    persisted.updated_at = now;
    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Failed to serialize agent status: {error}"))?;
    write_text_file(&status_path, &content)?;

    Ok(agent_status_snapshot_from_persisted(
        persisted,
        status_path_display,
    ))
}

#[tauri::command]
fn install_agent_status_hooks(app: AppHandle) -> Result<AgentHooksInstallResult, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    install_agent_hook_scripts(&app_dir)?;

    let running_script_path = app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME);
    let status_script_path = app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME);
    let home_dir = windows_home_dir()?;
    let codex_config_path = home_dir.join(".codex").join("config.toml");
    let claude_config_path = home_dir.join(".claude").join("settings.json");

    install_codex_status_hooks(
        &codex_config_path,
        &running_script_path,
        &status_script_path,
    )?;
    install_claude_code_status_hooks(
        &claude_config_path,
        &running_script_path,
        &status_script_path,
    )?;

    Ok(AgentHooksInstallResult {
        scripts_dir: app_dir.to_string_lossy().to_string(),
        status_path: app_dir
            .join(AGENT_STATUS_FILE_NAME)
            .to_string_lossy()
            .to_string(),
        codex_config_path: codex_config_path.to_string_lossy().to_string(),
        claude_config_path: claude_config_path.to_string_lossy().to_string(),
        installed_at: current_unix_millis(),
    })
}

#[tauri::command]
async fn get_media_state(
    target: Option<String>,
) -> Result<media_control::MediaState, String> {
    tauri::async_runtime::spawn_blocking(move || media_control::get_state(target))
        .await
        .map_err(|error| format!("Failed to join the media state task: {error}"))?
}

#[tauri::command]
async fn get_audio_level() -> Result<media_control::AudioLevel, String> {
    tauri::async_runtime::spawn_blocking(media_control::get_audio_level)
        .await
        .map_err(|error| format!("Failed to join the audio level task: {error}"))?
}

#[tauri::command]
async fn media_play_pause(target: Option<String>) -> Result<media_control::MediaState, String> {
    run_media_command(media_control::MediaCommand::PlayPause, target).await
}

#[tauri::command]
async fn media_next(target: Option<String>) -> Result<media_control::MediaState, String> {
    run_media_command(media_control::MediaCommand::Next, target).await
}

#[tauri::command]
async fn media_previous(target: Option<String>) -> Result<media_control::MediaState, String> {
    run_media_command(media_control::MediaCommand::Previous, target).await
}

#[tauri::command]
async fn media_toggle_shuffle(
    target: Option<String>,
) -> Result<media_control::MediaState, String> {
    run_media_command(media_control::MediaCommand::ToggleShuffle, target).await
}

#[tauri::command]
async fn media_cycle_repeat(target: Option<String>) -> Result<media_control::MediaState, String> {
    run_media_command(media_control::MediaCommand::CycleRepeat, target).await
}

#[tauri::command]
async fn media_seek(
    position_ms: i64,
    target: Option<String>,
) -> Result<media_control::MediaState, String> {
    tauri::async_runtime::spawn_blocking(move || media_control::seek(position_ms, target))
        .await
        .map_err(|error| format!("Failed to join the media seek task: {error}"))?
}

#[tauri::command]
async fn media_set_volume(level: f32) -> Result<media_control::MediaState, String> {
    tauri::async_runtime::spawn_blocking(move || media_control::set_volume(level))
        .await
        .map_err(|error| format!("Failed to join the media volume task: {error}"))?
}

async fn run_media_command(
    command: media_control::MediaCommand,
    target: Option<String>,
) -> Result<media_control::MediaState, String> {
    tauri::async_runtime::spawn_blocking(move || media_control::run_command(command, target))
        .await
        .map_err(|error| format!("Failed to join the media command task: {error}"))?
}

fn default_agent_status_snapshot(status_path: String) -> AgentStatusSnapshot {
    AgentStatusSnapshot {
        codex: AgentTaskStatus::default(),
        claude_code: AgentTaskStatus::default(),
        updated_at: current_unix_millis(),
        status_path,
    }
}

fn default_persisted_agent_status() -> PersistedAgentStatus {
    PersistedAgentStatus {
        codex: AgentTaskStatus::default(),
        claude_code: AgentTaskStatus::default(),
        updated_at: current_unix_millis(),
    }
}

fn agent_status_snapshot_from_persisted(
    persisted: PersistedAgentStatus,
    status_path: String,
) -> AgentStatusSnapshot {
    AgentStatusSnapshot {
        codex: normalize_agent_task_status(persisted.codex),
        claude_code: normalize_agent_task_status(persisted.claude_code),
        updated_at: if persisted.updated_at > 0 {
            persisted.updated_at
        } else {
            current_unix_millis()
        },
        status_path,
    }
}

fn apply_agent_running_markers(app_dir: &Path, snapshot: &mut AgentStatusSnapshot) {
    let now = current_unix_millis();

    if let Some(marker_status) = active_agent_running_marker_status(
        app_dir,
        &snapshot.codex,
        CODEX_RUNNING_MARKER_FILE_NAME,
        CODEX_RUNNING_HOLD_FILE_NAME,
        now,
    ) {
        snapshot.codex.phase = marker_status.phase;
        snapshot.codex.updated_at = marker_status.updated_at;
    }

    if let Some(marker_status) = active_agent_running_marker_status(
        app_dir,
        &snapshot.claude_code,
        CLAUDE_CODE_RUNNING_MARKER_FILE_NAME,
        CLAUDE_CODE_RUNNING_HOLD_FILE_NAME,
        now,
    ) {
        snapshot.claude_code.phase = marker_status.phase;
        snapshot.claude_code.updated_at = marker_status.updated_at;
    }
}

fn active_agent_running_marker_status(
    app_dir: &Path,
    status: &AgentTaskStatus,
    running_file_name: &str,
    hold_file_name: &str,
    now: i64,
) -> Option<AgentTaskStatus> {
    let running_path = app_dir.join(running_file_name);
    if running_path.is_file() {
        let marker_updated_at = file_modified_unix_millis(&running_path).unwrap_or(now);
        if status.phase != "running"
            && status.updated_at > 0
            && status.updated_at >= marker_updated_at
        {
            return None;
        }

        let phase = if now.saturating_sub(marker_updated_at) >= AGENT_RUNNING_STALE_AFTER_MS {
            "stale"
        } else {
            "running"
        };

        return Some(AgentTaskStatus {
            phase: phase.to_string(),
            task_id: status.task_id.clone(),
            updated_at: marker_updated_at,
        });
    }

    let hold_path = app_dir.join(hold_file_name);
    let visible_until = fs::read_to_string(hold_path)
        .ok()
        .and_then(|content| content.trim().parse::<i64>().ok())?;
    if visible_until > now {
        Some(AgentTaskStatus {
            phase: "running".to_string(),
            task_id: status.task_id.clone(),
            updated_at: now,
        })
    } else {
        None
    }
}

fn remove_agent_marker_files(app_dir: &Path, running_file_name: &str, hold_file_name: &str) {
    fs::remove_file(app_dir.join(running_file_name)).ok();
    fs::remove_file(app_dir.join(hold_file_name)).ok();
}

fn normalize_agent_task_status(mut status: AgentTaskStatus) -> AgentTaskStatus {
    if !matches!(
        status.phase.as_str(),
        "idle" | "running" | "completed" | "failed" | "stale"
    ) {
        status.phase = default_agent_phase();
    }

    status
}

fn install_agent_hook_scripts(app_dir: &Path) -> Result<(), String> {
    write_text_file(
        &app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME),
        &normalize_windows_line_endings(AGENT_RUNNING_SCRIPT),
    )?;
    write_text_file(
        &app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME),
        &normalize_windows_line_endings(AGENT_STATUS_SCRIPT),
    )
}

fn install_codex_status_hooks(
    config_path: &Path,
    running_script_path: &Path,
    status_script_path: &Path,
) -> Result<(), String> {
    let content = fs::read_to_string(config_path).unwrap_or_default();
    let content = remove_managed_codex_hook_block(&content);
    let block = build_codex_hook_block(running_script_path, status_script_path);
    let mut next_content = content.trim_end().to_string();
    if !next_content.is_empty() {
        next_content.push_str("\n\n");
    }
    next_content.push_str(&block);

    write_text_file(config_path, &next_content)
}

fn install_claude_code_status_hooks(
    config_path: &Path,
    running_script_path: &Path,
    status_script_path: &Path,
) -> Result<(), String> {
    let mut config = match fs::read_to_string(config_path) {
        Ok(content) if !content.trim().is_empty() => serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Failed to parse Claude Code settings.json: {error}"))?,
        _ => json!({}),
    };

    let Some(root) = config.as_object_mut() else {
        return Err("Claude Code settings.json must contain a JSON object.".to_string());
    };

    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "Failed to prepare Claude Code hooks object.".to_string())?;

    install_claude_code_hook_event(
        hooks,
        "UserPromptSubmit",
        claude_code_running_hook_entry(running_script_path),
    );
    install_claude_code_hook_event(
        hooks,
        "PreToolUse",
        claude_code_match_all_hook_entry(claude_code_running_hook_entry(running_script_path)),
    );
    install_claude_code_hook_event(
        hooks,
        "Stop",
        claude_code_status_hook_entry(status_script_path, "completed"),
    );
    install_claude_code_hook_event(
        hooks,
        "StopFailure",
        claude_code_status_hook_entry(status_script_path, "failed"),
    );

    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize Claude Code settings.json: {error}"))?;
    write_text_file(config_path, &json)
}

fn install_claude_code_hook_event(hooks: &mut Map<String, Value>, event_name: &str, entry: Value) {
    let mut entries = hooks
        .remove(event_name)
        .and_then(|value| match value {
            Value::Array(entries) => Some(entries),
            _ => None,
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(remove_managed_claude_code_hooks)
        .collect::<Vec<_>>();

    entries.push(entry);
    hooks.insert(event_name.to_string(), Value::Array(entries));
}

fn remove_managed_claude_code_hooks(mut entry: Value) -> Option<Value> {
    let Value::Object(entry_object) = &mut entry else {
        return Some(entry);
    };

    let Some(hooks_value) = entry_object.get_mut("hooks") else {
        return Some(entry);
    };

    let Value::Array(hooks) = hooks_value else {
        return Some(entry);
    };

    hooks.retain(|hook| !value_contains_focusd_hook_signature(hook));
    if hooks.is_empty() {
        None
    } else {
        Some(entry)
    }
}

fn value_contains_focusd_hook_signature(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains(FOCUSD_AGENT_HOOK_SIGNATURE),
        Value::Array(values) => values.iter().any(value_contains_focusd_hook_signature),
        Value::Object(values) => values.values().any(value_contains_focusd_hook_signature),
        _ => false,
    }
}

fn claude_code_match_all_hook_entry(mut entry: Value) -> Value {
    if let Value::Object(object) = &mut entry {
        object.insert("matcher".to_string(), Value::String("*".to_string()));
    }

    entry
}

fn claude_code_running_hook_entry(script_path: &Path) -> Value {
    claude_code_hook_entry(
        "cmd.exe",
        vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            format!("\"{}\" claudeCode", script_path.to_string_lossy()),
        ],
        1,
    )
}

fn claude_code_status_hook_entry(script_path: &Path, phase: &str) -> Value {
    claude_code_hook_entry(
        "powershell.exe",
        vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script_path.to_string_lossy().to_string(),
            "claudeCode".to_string(),
            phase.to_string(),
        ],
        5,
    )
}

fn claude_code_hook_entry(command: &str, args: Vec<String>, timeout: i64) -> Value {
    json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "args": args,
                "timeout": timeout
            }
        ]
    })
}

fn build_codex_hook_block(running_script_path: &Path, status_script_path: &Path) -> String {
    let submit_command = agent_running_command(running_script_path, "codex");
    let stop_command = agent_status_command(status_script_path, "codex", "completed");

    format!(
        r#"{begin}

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = {submit_command}
command_windows = {submit_command}
timeout = 1
statusMessage = "Updating FocuSD agent status"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = {stop_command}
command_windows = {stop_command}
timeout = 5
statusMessage = "Updating FocuSD agent status"

{end}"#,
        begin = FOCUSD_AGENT_HOOK_BLOCK_BEGIN,
        end = FOCUSD_AGENT_HOOK_BLOCK_END,
        submit_command = toml_basic_string(&submit_command),
        stop_command = toml_basic_string(&stop_command),
    )
}

fn remove_managed_codex_hook_block(content: &str) -> String {
    let mut remaining = content;
    let mut next_content = String::new();

    while let Some(start) = remaining.find(FOCUSD_AGENT_HOOK_BLOCK_BEGIN) {
        next_content.push_str(&remaining[..start]);
        let after_begin = &remaining[start..];
        let Some(end) = after_begin.find(FOCUSD_AGENT_HOOK_BLOCK_END) else {
            remaining = "";
            break;
        };

        remaining = &after_begin[end + FOCUSD_AGENT_HOOK_BLOCK_END.len()..];
        if let Some(stripped) = remaining.strip_prefix("\r\n") {
            remaining = stripped;
        } else if let Some(stripped) = remaining.strip_prefix('\n') {
            remaining = stripped;
        }
    }

    next_content.push_str(remaining);
    remove_legacy_codex_focusd_hooks(&next_content)
}

fn remove_legacy_codex_focusd_hooks(content: &str) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let mut next_lines: Vec<&str> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if let Some(hook_path) = codex_hook_event_path(trimmed) {
            let start = index;
            index += 1;

            while index < lines.len() && !lines[index].trim().starts_with('[') {
                index += 1;
            }

            let metadata_end = index;
            let mut kept_child_ranges = Vec::new();
            let mut removed_managed_child = false;

            while index < lines.len() {
                let candidate = lines[index].trim();
                if !is_codex_nested_hook_header_for(candidate, &hook_path) {
                    break;
                }

                let child_start = index;
                index += 1;
                while index < lines.len() && !lines[index].trim().starts_with('[') {
                    index += 1;
                }

                let child_block = lines[child_start..index].join("\n");
                if child_block.contains(FOCUSD_AGENT_HOOK_SIGNATURE) {
                    removed_managed_child = true;
                } else {
                    kept_child_ranges.push(child_start..index);
                }
            }

            if !removed_managed_child {
                next_lines.extend_from_slice(&lines[start..index]);
                continue;
            }

            if kept_child_ranges.is_empty() {
                continue;
            }

            next_lines.extend_from_slice(&lines[start..metadata_end]);
            for range in kept_child_ranges {
                next_lines.extend_from_slice(&lines[range]);
            }
            continue;
        }

        next_lines.push(lines[index]);
        index += 1;
    }

    next_lines.join("\n")
}

fn codex_hook_event_path(header: &str) -> Option<String> {
    if !header.starts_with("[[hooks.") || !header.ends_with("]]") {
        return None;
    }

    let hook_path = header.strip_prefix("[[")?.strip_suffix("]]")?;
    if hook_path.ends_with(".hooks") {
        return None;
    }

    Some(hook_path.to_string())
}

fn is_codex_nested_hook_header_for(header: &str, hook_path: &str) -> bool {
    header == format!("[[{hook_path}.hooks]]")
}

fn agent_running_command(script_path: &Path, provider: &str) -> String {
    format!(
        "cmd.exe /d /s /c \"\"{}\" {}\"",
        script_path.to_string_lossy(),
        provider
    )
}

fn agent_status_command(script_path: &Path, provider: &str, phase: &str) -> String {
    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\" {} {}",
        script_path.to_string_lossy(),
        provider,
        phase
    )
}

fn toml_basic_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let temporary_path = path.with_extension("tmp");
    fs::write(&temporary_path, content)
        .map_err(|error| format!("Failed to write {}: {error}", temporary_path.display()))?;
    fs::rename(&temporary_path, path)
        .or_else(|_| {
            fs::remove_file(path).ok();
            fs::rename(&temporary_path, path)
        })
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

fn normalize_windows_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn windows_home_dir() -> Result<PathBuf, String> {
    if let Ok(user_profile) = env::var("USERPROFILE") {
        let user_profile = user_profile.trim();
        if !user_profile.is_empty() {
            return Ok(PathBuf::from(user_profile));
        }
    }

    match (env::var("HOMEDRIVE"), env::var("HOMEPATH")) {
        (Ok(home_drive), Ok(home_path)) if !home_drive.is_empty() && !home_path.is_empty() => {
            Ok(PathBuf::from(format!("{home_drive}{home_path}")))
        }
        _ => Err("Failed to resolve the Windows user profile directory.".to_string()),
    }
}

fn file_modified_unix_millis(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    system_time_to_unix_millis(modified)
}

fn current_unix_millis() -> i64 {
    system_time_to_unix_millis(SystemTime::now()).unwrap_or_default()
}

fn system_time_to_unix_millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .ok()
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "Main island window was not found.".to_string())
}

fn show_island(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    apply_stage_geometry(&window, read_window_state(), false)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn hide_island(app: &AppHandle) {
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    hide_pet_bubble_silent(app);
    if let Ok(window) = main_window(app) {
        let _ = window.hide();
    }
}

fn window_state() -> &'static Mutex<IslandWindowState> {
    WINDOW_STATE.get_or_init(|| Mutex::new(IslandWindowState::default()))
}

fn mutate_window_state(
    update: impl FnOnce(&mut IslandWindowState) -> IslandWindowState,
) -> IslandWindowState {
    let mut state = window_state().lock().expect("window state poisoned");
    update(&mut state)
}

fn read_window_state() -> IslandWindowState {
    *window_state().lock().expect("window state poisoned")
}

fn parse_hex_color(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }

    Some((
        u8::from_str_radix(&hex[0..2], 16).ok()?,
        u8::from_str_radix(&hex[2..4], 16).ok()?,
        u8::from_str_radix(&hex[4..6], 16).ok()?,
    ))
}

fn clear_window_glass_region(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    if unsafe { SetWindowRgn(hwnd, None, true) } == 0 {
        return Err("Failed to clear the liquid glass window region.".to_string());
    }
    Ok(())
}

fn apply_glass_material(
    window: &WebviewWindow,
    state: IslandWindowState,
) -> Result<String, String> {
    // Keep the native surface clear. The collapsed desktop pet is rendered as
    // the dog sprite itself; expanded pages own their card styling in CSS.
    // CSS owns the material for the lifetime of the main window. Reapplying
    // these native resets on every toggle needlessly invalidates its surface.
    if NATIVE_GLASS_INITIALIZED.get().is_none() {
        let _ = window_vibrancy::clear_acrylic(window);
        clear_window_glass_region(window)?;
        let _ = NATIVE_GLASS_INITIALIZED.set(());
    }

    if state.glass_enabled {
        Ok("css-fallback".to_string())
    } else {
        Ok("disabled".to_string())
    }
}

fn apply_stage_geometry(
    window: &WebviewWindow,
    state: IslandWindowState,
    animate_position: bool,
) -> Result<(), String> {
    // 浮层打开期间窗口尺寸/位置由 set_island_overlay 独占管理，
    // 其他调用（设置同步、显示窗口等）不要插队把窗口缩回去。
    if OVERLAY_SNAPSHOT
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let generation = POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (stage_width, stage_height) = stage_dimensions(state);
    let stage_size = LogicalSize::new(stage_width, stage_height);
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    // 展开态要按“小狗右侧/上方可用空间”压缩面板尺寸，尺寸留到算完锚点再设。
    if !matches!(state.mode, IslandMode::Expanded)
        && window.inner_size().map_err(|error| error.to_string())?
            != stage_size.to_physical::<u32>(scale_factor)
    {
        window
            .set_size(Size::Logical(stage_size))
            .map_err(|error| error.to_string())?;
    }

    let current_monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    let primary_monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let custom_monitor = state
        .custom_position
        .and_then(|position| {
            monitor_for_island_position(window, position, state.collapsed_scale)
                .ok()
                .flatten()
        });
    let has_custom_monitor = custom_monitor.is_some();
    let monitor = custom_monitor
        .or_else(|| primary_monitor.or(current_monitor))
        .ok_or_else(|| "No monitor is available for island positioning.".to_string())?;

    let scale = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let physical_width = (stage_width * scale).round() as i32;
    let physical_top_offset = (state.margin_y * scale).round() as i32;
    let tucked_top_offset =
        -((COLLAPSED_ISLAND_HEIGHT * state.collapsed_scale - TUCKED_VISIBLE_EDGE_HEIGHT).max(0.0)
            * scale)
            .round() as i32;
    // 收起态小狗贴在屏幕底部，缩边时应该从底边往下缩，只露出头顶一小截。
    // 小狗画面在窗口内的起点：槽位高 - 底部留白 - 图片高 + 下移量 + GIF 顶部透明留白。
    let dog_top_in_window = ((128.0 * state.collapsed_scale + 16.0)
        - 2.0
        - 112.0 * state.collapsed_scale
        + 9.7 * state.collapsed_scale)
        * scale;
    let top_inset = work_area_top_inset(monitor_position.y, monitor.work_area().position.y);
    let centered_x = monitor_position.x + ((monitor_size.width as i32 - physical_width) / 2);
    let physical_height = (stage_height * scale).round() as i32;
    let tucked_visible_height = state
        .tucked_visible_height
        .clamp(MIN_TUCKED_VISIBLE_HEIGHT, MAX_TUCKED_VISIBLE_HEIGHT);
    // 收起时默认趴在工作区底部（任务栏上方），像趴在桌面边缘；展开面板保持在顶部。
    let normal_y = if matches!(state.mode, IslandMode::Collapsed) {
        let work_area = monitor.work_area();
        work_area.position.y + work_area.size.height as i32 - physical_height - physical_top_offset
    } else {
        monitor_position.y + top_inset + physical_top_offset
    };
    let tucked_y = if matches!(state.mode, IslandMode::Collapsed) {
        let work_area = monitor.work_area();
        let bottom = work_area.position.y + work_area.size.height as i32;
        bottom
            - (tucked_visible_height * scale).round() as i32
            - dog_top_in_window.round() as i32
    } else {
        monitor_position.y + top_inset + tucked_top_offset
    };
    let mut positioned_state = state;
    if !has_custom_monitor {
        // 多屏切换或 DPI 变化时，按旧坐标找显示器可能失败。过去这里直接
        // 丢弃 custom_position，结果固定在右下角的小狗会突然回到屏幕中央
        // （看起来像往左上方漂）。现在保留用户位置，并夹到当前显示器工作区。
        if let Some(position) = state.custom_position {
            let slot_w = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
            let slot_h = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
            let work = monitor.work_area();
            let max_x = work.position.x + work.size.width as i32 - slot_w;
            let max_y = work.position.y + work.size.height as i32 - slot_h;
            positioned_state.custom_position = Some(IslandPosition {
                x: position.x.clamp(work.position.x, max_x.max(work.position.x)),
                y: position.y.clamp(work.position.y, max_y.max(work.position.y)),
            });
        }
    }
    // 小狗在收起态几何下的锚点（展开窗口时小狗保持不动，面板朝空闲的一侧长）。
    let slot_w_phys = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_h_phys = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    let work_area = monitor.work_area();
    let work_left = work_area.position.x;
    let work_top = work_area.position.y;
    let work_right = work_area.position.x + work_area.size.width as i32;
    let work_bottom = work_area.position.y + work_area.size.height as i32;
    let dog_centered_x = monitor_position.x + ((monitor_size.width as i32 - slot_w_phys) / 2);
    let dog_normal_y = work_bottom - slot_h_phys - physical_top_offset;
    // 缩边方向：按小狗实际所在位置选最近的上/下边缘。
    // 不能只看默认的 dog_normal_y，否则手动放在屏幕顶部的小狗睡觉时
    // 会突然跳到屏幕底部缩边。
    let visible_head_phys = (tucked_visible_height * scale).round() as i32;
    let dog_anchor_y = state
        .custom_position
        .map(|position| position.y)
        .unwrap_or(dog_normal_y);
    let tuck_top =
        (dog_anchor_y - work_top) < (work_bottom - (dog_anchor_y + slot_h_phys));
    let dog_tucked_y = if tuck_top {
        // 顶部缩边时露出的窗口底部高度同样可调；多留一点窗口，避免翻转后的头被裁掉。
        work_top - slot_h_phys + (visible_head_phys + (6.0 * scale).round() as i32)
    } else {
        work_bottom - visible_head_phys - dog_top_in_window.round() as i32
    };
    let _ = window.emit("maltese-tuck-edge", if tuck_top { "top" } else { "bottom" });
    let (dog_x, dog_y) = resolve_stage_position(
        positioned_state,
        dog_centered_x,
        dog_normal_y,
        dog_tucked_y,
    );
    let (x, y) = match state.mode {
        IslandMode::Expanded => {
            let gap_css = EXPANDED_PANEL_GAP;
            let slot_w_css = slot_width_css(state.collapsed_scale);
            let slot_h_css = slot_height_css(state.collapsed_scale);
            // 面板优先长在小狗右侧；右侧贴边时翻到左侧，避免整个弹窗落在屏幕外。
            // 小狗的屏幕坐标在翻边前后保持不变（窗口只向另一侧变宽）。
            let desired_width_phys = (stage_width * scale).round() as i32;
            let panel_side = expanded_panel_side(
                dog_x,
                slot_w_phys,
                desired_width_phys,
                work_left,
                work_right,
            );

            let side_space = if panel_side == "right" {
                (work_right - dog_x).max(0)
            } else {
                (dog_x + slot_w_phys - work_left).max(0)
            };
            let min_width_css = (slot_w_css + gap_css + 200.0).min(stage_width);
            let width_css = stage_width.min(
                ((side_space as f64) / scale).max(min_width_css),
            );
            let desired_height_phys = (stage_height * scale).round() as i32;
            let panel_vertical = expanded_panel_vertical(
                dog_y,
                slot_h_phys,
                desired_height_phys,
                work_top,
                work_bottom,
            );
            let vertical_space = if panel_vertical == "above" {
                (dog_y + slot_h_phys - work_top).max(0)
            } else {
                (work_bottom - dog_y).max(0)
            };
            let height_css = stage_height
                .min((vertical_space as f64) / scale)
                .max(slot_h_css);
            let phys_w = (width_css * scale).round() as i32;
            let phys_h = (height_css * scale).round() as i32;
            if window.inner_size().map_err(|error| error.to_string())?
                != LogicalSize::new(width_css, height_css).to_physical::<u32>(scale)
            {
                window
                    .set_size(Size::Logical(LogicalSize::new(width_css, height_css)))
                    .map_err(|error| error.to_string())?;
            }
            let _ = window.emit("maltese-panel-side", panel_side);
            let _ = window.emit("maltese-panel-vertical", panel_vertical);
            let x = if panel_side == "left" {
                dog_x + slot_w_phys - phys_w
            } else {
                dog_x
            };
            let y = if panel_vertical == "above" {
                dog_y + slot_h_phys - phys_h
            } else {
                dog_y
            };
            (x, y)
        }
        _ => (dog_x, dog_y),
    };
    let _ = (centered_x, normal_y, tucked_y);

    let target = PhysicalPosition::new(x, y);
    let start = window.outer_position().map_err(|error| error.to_string())?;
    if start == target {
        return Ok(());
    }
    if !animate_position {
        return window
            .set_position(Position::Physical(target))
            .map_err(|error| error.to_string());
    }

    let window = window.clone();
    thread::spawn(move || {
        let started_at = Instant::now();
        loop {
            if POSITION_ANIMATION_GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            let progress = (started_at.elapsed().as_secs_f64()
                / POSITION_ANIMATION_DURATION.as_secs_f64())
                .min(1.0);
            let position = interpolate_stage_position(start, target, progress);
            if let Err(error) = window.set_position(Position::Physical(position)) {
                eprintln!("Failed to animate island position: {error}");
                break;
            }
            if progress >= 1.0 {
                break;
            }
            thread::sleep(Duration::from_millis(8));
        }
    });
    Ok(())
}

// 展开面板朝哪一侧生长：优先右侧，右侧贴边则翻到左侧；两侧都放不下时选空间大的一侧。
fn expanded_panel_vertical(
    dog_y: i32,
    slot_h_phys: i32,
    desired_height_phys: i32,
    work_top: i32,
    work_bottom: i32,
) -> &'static str {
    let above = (dog_y + slot_h_phys - work_top).max(0);
    let below = (work_bottom - dog_y).max(0);
    if above >= desired_height_phys {
        "above"
    } else if below >= desired_height_phys {
        "below"
    } else if above >= below {
        "above"
    } else {
        "below"
    }
}

fn overlay_panel_vertical(
    dog_y: i32,
    slot_h_phys: i32,
    gap_phys: i32,
    desired_height_phys: i32,
    work_top: i32,
    work_bottom: i32,
) -> &'static str {
    // 翻到上方时面板可以占满小狗上方的整块窗口；翻到下方时窗口顶部要先留出小狗槽，
    // 所以下方可用空间要扣掉槽高和间隙，不能像独立气泡窗口那样直接比较。
    let above = (dog_y + slot_h_phys - work_top).max(0);
    let below = (work_bottom - dog_y - slot_h_phys - gap_phys).max(0);
    if above >= desired_height_phys {
        "above"
    } else if below >= desired_height_phys {
        "below"
    } else if above >= below {
        "above"
    } else {
        "below"
    }
}

fn overlay_window_height(
    vertical: &str,
    base_h: f64,
    gap: f64,
    panel_h: f64,
    available_h: f64,
) -> f64 {
    let desired = if vertical == "below" {
        base_h + gap + panel_h
    } else {
        panel_h
    };
    desired.min(available_h).max(base_h)
}

fn expanded_panel_side(
    dog_x: i32,
    slot_w_phys: i32,
    desired_width_phys: i32,
    work_left: i32,
    work_right: i32,
) -> &'static str {
    let right_space = (work_right - dog_x).max(0);
    let left_space = (dog_x + slot_w_phys - work_left).max(0);
    if right_space >= desired_width_phys {
        "right"
    } else if left_space >= desired_width_phys {
        "left"
    } else if right_space >= left_space {
        "right"
    } else {
        "left"
    }
}

// 收起态“小狗槽”尺寸（逻辑像素）。custom_position 记录的是槽的左上角，
// 所有涉及槽位尺寸的计算必须走这里，避免各调用点公式漂移导致定位偏差。
fn slot_width_css(collapsed_scale: f64) -> f64 {
    (152.0 * collapsed_scale + 16.0).max(148.0)
}

fn slot_height_css(collapsed_scale: f64) -> f64 {
    (128.0 * collapsed_scale + 16.0).max(124.0)
}

fn stage_dimensions(state: IslandWindowState) -> (f64, f64) {
    match state.mode {
        IslandMode::Collapsed => (
            slot_width_css(state.collapsed_scale),
            slot_height_css(state.collapsed_scale),
        ),
        IslandMode::Expanded => {
            // 云朵面板窗口：宽度 = 小狗槽 + 间隙 + 面板；高度取面板与小狗槽的较大值。
            let slot_w = slot_width_css(state.collapsed_scale);
            let slot_h = slot_height_css(state.collapsed_scale);
            (
                slot_w + EXPANDED_PANEL_GAP + EXPANDED_PANEL_WIDTH,
                slot_h.max(EXPANDED_PANEL_HEIGHT),
            )
        }
    }
}

fn interpolate_stage_position(
    start: PhysicalPosition<i32>,
    target: PhysicalPosition<i32>,
    progress: f64,
) -> PhysicalPosition<i32> {
    let eased = 1.0 - (1.0 - progress.clamp(0.0, 1.0)).powi(3);
    PhysicalPosition::new(
        (start.x as f64 + (target.x as f64 - start.x as f64) * eased).round() as i32,
        (start.y as f64 + (target.y as f64 - start.y as f64) * eased).round() as i32,
    )
}

fn monitor_for_island_position(
    window: &WebviewWindow,
    position: IslandPosition,
    collapsed_scale: f64,
) -> Result<Option<Monitor>, String> {
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;

    Ok(monitors.into_iter().find(|monitor| {
        let scale = monitor.scale_factor();
        island_slot_center_within_monitor(
            position,
            collapsed_scale,
            scale,
            *monitor.position(),
            *monitor.size(),
        )
    }))
}

// custom_position 是收起态小狗槽的左上角，中心点必须按槽位实际尺寸计算。
// 不能用旧整窗宽度常量（STAGE_WINDOW_WIDTH=640）：右下/右上角的槽位中心
// 会被算到显示器右缘之外，导致归属判定失败、custom_position 被丢弃，
// 小狗随即回到屏幕水平居中（“选右下角却回到屏幕中央”）。
fn island_slot_center_within_monitor(
    position: IslandPosition,
    collapsed_scale: f64,
    scale: f64,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
) -> bool {
    let island_center_x = position.x as f64 + slot_width_css(collapsed_scale) * scale / 2.0;
    let island_center_y = position.y as f64 + slot_height_css(collapsed_scale) * scale / 2.0;
    let monitor_left = monitor_position.x as f64;
    let monitor_top = monitor_position.y as f64;
    let monitor_right = (monitor_position.x + monitor_size.width as i32) as f64;
    let monitor_bottom = (monitor_position.y + monitor_size.height as i32) as f64;

    island_center_x >= monitor_left
        && island_center_x < monitor_right
        && island_center_y >= monitor_top
        && island_center_y < monitor_bottom
}

// A top-docked taskbar shrinks the monitor work area instead of the monitor itself,
// so the island has to be anchored below it or the taskbar covers the island.
fn work_area_top_inset(monitor_top: i32, work_area_top: i32) -> i32 {
    (work_area_top - monitor_top).max(0)
}

fn resolve_stage_position(
    state: IslandWindowState,
    centered_x: i32,
    normal_y: i32,
    tucked_y: i32,
) -> (i32, i32) {
    match (state.custom_position, state.is_tucked) {
        (Some(position), true) => (position.x, tucked_y),
        (Some(position), false) => (position.x, position.y),
        (None, true) => (centered_x, tucked_y),
        (None, false) => (centered_x, normal_y),
    }
}

fn record_dragged_position(position: PhysicalPosition<i32>) {
    // 浮层展开时窗口会主动改变尺寸/位置；这些 Moved 事件不是用户拖拽，
    // 绝不能写进 custom_position，否则关闭浮层后小狗会留下左上偏移。
    if OVERLAY_SNAPSHOT
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
    {
        return;
    }
    mutate_window_state(|state| {
        if state.is_dragging && !state.is_tucked {
            state.custom_position = Some(IslandPosition {
                x: position.x,
                y: position.y,
            });
        }
        *state
    });
}

fn start_cursor_passthrough_loop(window: WebviewWindow) {
    thread::spawn(move || {
        let mut ignoring_cursor = false;

        loop {
            let should_ignore = !cursor_is_inside_island(&window);

            if should_ignore != ignoring_cursor {
                if window.set_ignore_cursor_events(should_ignore).is_ok() {
                    ignoring_cursor = should_ignore;
                }
            }

            thread::sleep(Duration::from_millis(12));
        }
    });
}

fn cursor_is_inside_island(window: &WebviewWindow) -> bool {
    // 主窗口现在只承载小狗和云朵面板，整块都需要可交互：
    // 浮层面板、展开面板、小狗脚爪都不能被鼠标穿透吃掉点击。
    let _ = window;
    true
}

#[allow(dead_code)]
fn point_in_notch(
    x: f64,
    y: f64,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    radius: f64,
    top_radius: f64,
) -> bool {
    let right = left + width;
    let bottom = top + height;

    if x < left || x > right || y < top || y > bottom {
        return false;
    }

    let top_radius = top_radius.min(width / 2.0).min(height / 2.0);
    if y < top + top_radius && (x < left + top_radius || x > right - top_radius) {
        let dx = x - x.clamp(left + top_radius, right - top_radius);
        let dy = y - (top + top_radius);
        return dx * dx + dy * dy <= top_radius * top_radius;
    }

    let radius = radius.min(width / 2.0).min(height);
    if y <= bottom - radius || (x >= left + radius && x <= right - radius) {
        return true;
    }
    let center_x = if x < left + radius {
        left + radius
    } else if x > right - radius {
        right - radius
    } else {
        x
    };
    let center_y = y.min(bottom - radius);
    let dx = x - center_x;
    let dy = y - center_y;

    (dx * dx) + (dy * dy) <= radius * radius
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_updater_config_is_valid_without_a_release_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(updater.pubkey.is_empty());
    }

    fn state(mode: IslandMode, scale: f64, expanded_height: f64) -> IslandWindowState {
        IslandWindowState {
            mode,
            collapsed_scale: scale,
            expanded_scale: scale,
            expanded_height,
            ..IslandWindowState::default()
        }
    }

    #[test]
    fn top_docked_taskbar_pushes_island_below_the_work_area() {
        assert_eq!(work_area_top_inset(0, 48), 48);
        assert_eq!(work_area_top_inset(0, 0), 0);
        assert_eq!(work_area_top_inset(-1080, -1080), 0);
        assert_eq!(work_area_top_inset(0, -10), 0);
    }

    #[test]
    fn expanded_panel_flips_away_from_screen_edges() {
        // 回归：小狗在右缘时，弹窗必须向左展开，不能整块长到屏幕外。
        assert_eq!(expanded_panel_side(1850, 198, 800, 0, 2048), "left");
        // 左缘向右展开，中间优先向右。
        assert_eq!(expanded_panel_side(16, 198, 800, 0, 2048), "right");
        assert_eq!(expanded_panel_side(925, 198, 800, 0, 2048), "right");
        // 两侧都放不下时，选剩余空间更大的一侧。
        assert_eq!(expanded_panel_side(400, 198, 800, 0, 1000), "right");
        assert_eq!(expanded_panel_side(650, 198, 800, 0, 1000), "left");
        // 负坐标副屏同样按边界判断。
        assert_eq!(expanded_panel_side(-214, 198, 800, -2048, 0), "left");
    }

    #[test]
    fn panel_flips_vertically_when_top_space_is_tight() {
        // 小狗贴顶部：上方放不下，面板必须翻到下方。
        assert_eq!(expanded_panel_vertical(0, 200, 650, 0, 1440), "below");
        // 小狗贴底部：下方放不下，面板回到上方。
        assert_eq!(expanded_panel_vertical(1240, 200, 650, 0, 1440), "above");
        // 中间优先上方，空间不足时才看下方。
        assert_eq!(expanded_panel_vertical(700, 200, 650, 0, 1440), "above");
        assert_eq!(expanded_panel_vertical(300, 200, 900, 0, 1440), "below");
        // 两边都放不下：选空间更大的一侧。
        assert_eq!(expanded_panel_vertical(400, 200, 2000, 0, 1440), "below");
        assert_eq!(expanded_panel_vertical(900, 200, 2000, 0, 1440), "above");
    }

    #[test]
    fn overlay_panel_below_reserves_space_for_the_pet_slot() {
        // 浮层窗口翻到下方时，窗口顶部仍要放得下小狗槽；方向判断和高度分配
        // 都必须扣掉槽高，否则气泡底部会超出窗口。
        assert_eq!(overlay_panel_vertical(0, 160, 8, 540, 0, 1440), "below");
        assert_eq!(overlay_panel_vertical(1240, 160, 8, 540, 0, 1440), "above");
        assert_eq!(overlay_panel_vertical(300, 160, 8, 540, 0, 1440), "below");
        assert_eq!(overlay_panel_vertical(700, 160, 8, 540, 0, 1440), "above");
        // 两侧都不够时选内容空间更大的一侧，而不是把小狗槽算进面板空间。
        assert_eq!(overlay_panel_vertical(500, 160, 8, 2000, 0, 1440), "below");
        assert_eq!(overlay_panel_vertical(900, 160, 8, 2000, 0, 1440), "above");
        // 向下展开时窗口必须包含小狗槽和间隙，否则面板底部会被窗口裁掉。
        assert_eq!(overlay_window_height("below", 160.0, 8.0, 540.0, 1080.0), 708.0);
        assert_eq!(overlay_window_height("above", 160.0, 8.0, 540.0, 1080.0), 540.0);
        // 屏幕空间不足时至少保留小狗槽，面板由前端滚动/裁切兜底。
        assert_eq!(overlay_window_height("below", 160.0, 8.0, 540.0, 500.0), 500.0);
        assert_eq!(overlay_window_height("above", 160.0, 8.0, 540.0, 120.0), 160.0);
    }

    #[test]
    fn corner_slot_centers_stay_inside_their_monitor() {
        // 回归：四角复位后槽位中心必须落在显示器内。此前 monitor 归属判定用旧整窗
        // 宽度（640）算中心，右下/右上角的槽位中心被算到屏幕右缘之外，custom_position
        // 被丢弃，小狗回到屏幕水平居中。
        let scale = 1.0;
        let collapsed_scale = DEFAULT_COLLAPSED_SCALE;
        let monitor_position = PhysicalPosition::new(0, 0);
        let monitor_size = PhysicalSize::new(1920u32, 1080u32);
        let work_size = PhysicalSize::new(1920u32, 1040u32);
        let margin = 16i32;
        let slot_w = (slot_width_css(collapsed_scale) * scale).round() as i32;
        let slot_h = (slot_height_css(collapsed_scale) * scale).round() as i32;

        let br = IslandPosition {
            x: work_size.width as i32 - slot_w - margin,
            y: work_size.height as i32 - slot_h - margin,
        };
        assert!(island_slot_center_within_monitor(
            br,
            collapsed_scale,
            scale,
            monitor_position,
            monitor_size,
        ));

        let tr = IslandPosition { x: br.x, y: margin };
        assert!(island_slot_center_within_monitor(
            tr,
            collapsed_scale,
            scale,
            monitor_position,
            monitor_size,
        ));

        let tl = IslandPosition { x: margin, y: margin };
        assert!(island_slot_center_within_monitor(
            tl,
            collapsed_scale,
            scale,
            monitor_position,
            monitor_size,
        ));

        let bl = IslandPosition {
            x: margin,
            y: work_size.height as i32 - slot_h - margin,
        };
        assert!(island_slot_center_within_monitor(
            bl,
            collapsed_scale,
            scale,
            monitor_position,
            monitor_size,
        ));

        // 真正在屏幕外的位置仍然会被拒绝。
        assert!(!island_slot_center_within_monitor(
            IslandPosition { x: 2000, y: 900 },
            collapsed_scale,
            scale,
            monitor_position,
            monitor_size,
        ));

        // 高 DPI（200%）下四角同样成立。
        let hidpi_monitor = PhysicalPosition::new(0, 0);
        let hidpi_size = PhysicalSize::new(3840u32, 2160u32);
        let hidpi_work = PhysicalSize::new(3840u32, 2080u32);
        let slot_w2 = (slot_width_css(collapsed_scale) * 2.0).round() as i32;
        let slot_h2 = (slot_height_css(collapsed_scale) * 2.0).round() as i32;
        let br2 = IslandPosition {
            x: hidpi_work.width as i32 - slot_w2 - margin,
            y: hidpi_work.height as i32 - slot_h2 - margin,
        };
        assert!(island_slot_center_within_monitor(
            br2,
            collapsed_scale,
            2.0,
            hidpi_monitor,
            hidpi_size,
        ));
    }

    #[test]
    fn custom_position_survives_tuck_and_reveal() {
        let mut custom = state(IslandMode::Collapsed, 1.0, DEFAULT_EXPANDED_ISLAND_HEIGHT);
        custom.custom_position = Some(IslandPosition { x: 420, y: 180 });

        assert_eq!(resolve_stage_position(custom, 100, 12, -48), (420, 180));

        custom.is_tucked = true;
        assert_eq!(resolve_stage_position(custom, 100, 12, -48), (420, -48));

        custom.is_tucked = false;
        assert_eq!(resolve_stage_position(custom, 100, 12, -48), (420, 180));
    }

    #[test]
    fn notch_has_flat_top_and_rounded_bottom_at_all_scales() {
        for scale in [0.75, DEFAULT_COLLAPSED_SCALE, 1.0, 1.4, 2.1] {
            for mode in [IslandMode::Collapsed, IslandMode::Expanded] {
                let (width, height) =
                    mode.base_size(COLLAPSED_ISLAND_WIDTH, DEFAULT_EXPANDED_ISLAND_HEIGHT);
                let width = width * scale;
                let height = height * scale;
                let radius = mode.corner_radius() * scale;
                let contains = |x, y| point_in_notch(x, y, 80.0, 0.0, width, height, radius, 0.0);

                assert!(contains(80.0, 0.0));
                assert!(contains(80.0 + width, 0.0));
                assert!(contains(80.0 + width / 2.0, height));
                assert!(!contains(80.0, height));
                assert!(!contains(80.0 + width, height));
                assert!(!contains(79.0, 0.0));
                assert!(!contains(80.0 + width / 2.0, height + 1.0));
            }
        }
    }

    #[test]
    fn default_notch_stays_at_top_when_expanding() {
        for mode in [IslandMode::Collapsed, IslandMode::Expanded] {
            let state = state(mode, 1.0, DEFAULT_EXPANDED_ISLAND_HEIGHT);
            assert_eq!(state.margin_y, 0.0);
            assert_eq!(resolve_stage_position(state, 550, 0, -28), (550, 0));
        }
    }

    #[test]
    fn compact_messages_and_mail_reader_keep_the_correct_cursor_boundary() {
        for height in [MIN_EXPANDED_ISLAND_HEIGHT, 244.0, 438.0, 450.0] {
            for scale in [0.75, 1.0, 1.4] {
                let (width, panel_height) = IslandMode::Expanded.base_size(COLLAPSED_ISLAND_WIDTH, height);
                let contains = |y| point_in_notch(
                    width * scale / 2.0, y, 0.0, 0.0, width * scale, panel_height * scale,
                    EXPANDED_RADIUS * scale, 0.0,
                );
                assert!(contains(panel_height * scale));
                assert!(!contains(panel_height * scale + 1.0));
                assert_eq!(IslandMode::Collapsed.base_size(COLLAPSED_ISLAND_WIDTH, height).1, COLLAPSED_ISLAND_HEIGHT);
            }
            let mut positioned = state(IslandMode::Expanded, 1.0, height);
            positioned.custom_position = Some(IslandPosition { x: 420, y: 180 });
            assert_eq!(resolve_stage_position(positioned, 100, 12, -48), (420, 180));
            positioned.is_tucked = true;
            assert_eq!(resolve_stage_position(positioned, 100, 12, -48), (420, -48));
        }
    }

    #[test]
    fn detached_island_rounds_top_corners() {
        for mode in [IslandMode::Collapsed, IslandMode::Expanded] {
            let mut detached = state(mode, 1.0, DEFAULT_EXPANDED_ISLAND_HEIGHT);
            assert_eq!(detached.top_corner_radius(), 0.0);
            detached.custom_position = Some(IslandPosition { x: 420, y: 180 });
            assert!(detached.top_corner_radius() > 0.0);
            let (width, height) = mode.base_size(COLLAPSED_ISLAND_WIDTH, DEFAULT_EXPANDED_ISLAND_HEIGHT);
            let contains = |x, y| point_in_notch(
                x, y, 80.0, 0.0, width, height, mode.corner_radius(), detached.top_corner_radius(),
            );
            assert!(!contains(80.0, 0.0));
            assert!(!contains(80.0 + width, 0.0));
            assert!(contains(80.0 + width / 2.0, 0.0));
            assert!(!contains(79.0, 0.0));
            detached.custom_position = None;
            assert_eq!(detached.top_corner_radius(), 0.0);
            detached.margin_y = 20.0;
            assert!(detached.top_corner_radius() > 0.0);
        }
    }

    #[test]
    fn docked_island_does_not_capture_cursor_outside_its_sides() {
        for scale in [0.75, DEFAULT_COLLAPSED_SCALE, 1.0, 1.4, 2.1] {
            let width = COLLAPSED_ISLAND_WIDTH * scale;
            let contains = |x, y| point_in_notch(
                x, y, 80.0, 0.0, width, COLLAPSED_ISLAND_HEIGHT * scale,
                COLLAPSED_RADIUS * scale, 0.0,
            );
            assert!(contains(80.0, 0.0));
            assert!(contains(80.0 + width, 0.0));
            for y in [0.0, 3.0 * scale, 6.0 * scale] {
                assert!(!contains(79.0, y));
                assert!(!contains(81.0 + width, y));
            }
        }
    }

    #[test]
    fn tuck_and_reveal_move_monotonically_between_physical_positions() {
        for (start, target) in [
            (PhysicalPosition::new(665, 0), PhysicalPosition::new(665, -32)),
            (PhysicalPosition::new(-900, -32), PhysicalPosition::new(-900, 270)),
        ] {
            assert_eq!(interpolate_stage_position(start, target, 0.0), start);
            assert_eq!(interpolate_stage_position(start, target, 1.0), target);
            let middle = interpolate_stage_position(start, target, 0.3);
            assert_ne!(middle, start);
            assert_ne!(middle, target);
            let mut last = start;
            for frame in 1..=40 {
                let current = interpolate_stage_position(start, target, frame as f64 / 40.0);
                assert_eq!(current.x, start.x);
                if target.y < start.y {
                    assert!(current.y <= last.y && current.y >= target.y);
                } else {
                    assert!(current.y >= last.y && current.y <= target.y);
                }
                last = current;
            }
        }
    }

    // tauri-plugin-updater declares `pubkey` as a mandatory config field with no
    // serde default, so dropping the key aborts startup with "missing field
    // `pubkey`". The shipped config keeps an empty placeholder; release builds
    // replace it through `src-tauri/tauri.release.conf.json`.
    fn shipped_updater_config() -> Value {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must be valid JSON");
        config
            .pointer("/plugins/updater")
            .cloned()
            .expect("tauri.conf.json must define plugins.updater")
    }

    #[test]
    fn shipped_updater_config_parses_with_the_empty_pubkey_placeholder() {
        let parsed: tauri_plugin_updater::Config =
            serde_json::from_value(shipped_updater_config())
                .expect("plugins.updater must deserialize or the app aborts at startup");

        assert_eq!(parsed.pubkey, "");
        assert!(!parsed.endpoints.is_empty());
    }

    #[test]
    fn release_overlay_replaces_the_pubkey_placeholder() {
        let mut update_config = shipped_updater_config();
        update_config["pubkey"] = json!("RWQtest-only-release-public-key");

        let parsed: tauri_plugin_updater::Config = serde_json::from_value(update_config)
            .expect("a release config carrying a real pubkey must deserialize");

        assert_eq!(parsed.pubkey, "RWQtest-only-release-public-key");
        assert!(!parsed.endpoints.is_empty());
    }

    #[test]
    fn hex_tint_parser_rejects_invalid_values() {
        assert_eq!(parse_hex_color("#101013"), Some((16, 16, 19)));
        assert_eq!(parse_hex_color("101013"), None);
        assert_eq!(parse_hex_color("#xyzxyz"), None);
    }
}

fn build_tray(app: &App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示小狗", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "配置桌宠", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Maltese", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &settings_item, &hide_item, &quit_item],
    )?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("Maltese 线条小狗")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let _ = show_island(app);
            }
            // 桌宠右键菜单已移除，配置入口统一放到任务栏托盘菜单。
            "settings" => {
                let _ = open_settings_window(app.clone());
            }
            "hide" => hide_island(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_island(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if let Some(identifier) = notification_diagnostics::verification_identifier() {
        context.config_mut().identifier = identifier;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_island(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() == "translation" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            if window.label() != WINDOW_LABEL {
                return;
            }

            if let WindowEvent::Moved(position) = event {
                record_dragged_position(*position);
                return;
            }

            // Native Acrylic/Region is intentionally not reapplied on DPI
            // changes. Liquid glass is rendered inside the island element.
        })
        .setup(|app| {
            build_tray(app)?;
            if let Some(settings) = app.get_webview_window("settings") {
                attach_settings_close(&settings);
            }
            if let Err(error) = clipboard_history::init(app.handle()) {
                eprintln!("failed to initialize clipboard history: {error}");
            }
            wake_shortcut::init(app.handle());
            shortcut_hotkeys::init(app.handle());
            video_automation::init(app.handle());
            dsh_api::init(app.handle());
            if let Err(error) = qq_mail::init(app.handle()) {
                eprintln!("failed to initialize QQ mail: {error}");
            }
            if let Err(error) = qq_notifications::init(app.handle()) {
                eprintln!("failed to initialize QQ notifications: {error}");
            }
            if let Err(error) = wechat_reminders::init(app.handle()) {
                eprintln!("failed to initialize WeChat reminders: {error}");
            }
            if let Err(error) = notification_diagnostics::start(app.handle()) {
                eprintln!("failed to initialize notification diagnostics: {error}");
            }
            if let Ok(window) = main_window(app.handle()) {
                if let Err(error) = apply_stage_geometry(&window, IslandWindowState::default(), false) {
                    eprintln!("failed to size and position island window: {error}");
                }
                start_cursor_passthrough_loop(window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            qq_mail::get_qq_mail_state,
            qq_mail::connect_qq_mail,
            qq_mail::set_qq_mail_enabled,
            qq_mail::refresh_qq_mail,
            qq_mail::read_qq_mail,
            qq_mail::disconnect_qq_mail,
            wechat_reminders::get_wechat_reminder_state,
            activity::get_active_activity,
            netease::media_press_key,
            netease::netease_focus,
            wechat_reminders::set_wechat_reminders_enabled,
            wechat_reminders::set_wechat_read_content,
            dsh_chat::dsh_chat,
            local_chat::local_chat,
            local_chat::local_chat_models,
            wechat_reminders::open_wechat,
            qq_notifications::get_qq_notification_state,
            qq_notifications::set_qq_notifications_enabled,
            qq_notifications::request_qq_notification_access,
            qq_notifications::open_qq_notification_settings,
            qq_notifications::clear_qq_notifications,
            qq_notifications::open_qq,
            set_island_layout,
            set_island_interaction,
            start_island_drag,
            reset_island_position,
            save_todo_markdown,
            get_default_todo_save_directory,
            show_ready_island,
            show_island_no_focus,
            open_settings_window,
            set_island_overlay,
            roam_island_step,
            minimize_island,
            lyrics::fetch_lyrics,
            icons::get_shortcut_icon,
            desktop_extras::sync_desktop_extras,
            desktop_extras::get_pressed_keys,
            show_pet_bubble,
            get_pet_bubble_payload,
            hide_pet_bubble,
            lock_island_corner,
            is_foreground_fullscreen,
            get_launch_at_startup,
            set_launch_at_startup,
            open_local_path,
            launch_tool,
            discover_shortcuts,
            discover_installed_apps,
            discover_start_apps,
            launch_start_app,
            get_desktop_icons_visible,
            set_desktop_icons_visible,
            launch_discovered_shortcut,
            launch_custom_shortcut,
            list_common_scripts,
            run_common_script,
            get_updater_proxy,
            updater_configured,
            get_agent_status,
            clear_agent_status,
            install_agent_status_hooks,
            get_media_state,
            get_system_idle_seconds,
            get_audio_level,
            media_play_pause,
            media_next,
            media_previous,
            media_toggle_shuffle,
            media_cycle_repeat,
            media_seek,
            media_set_volume,
            clipboard_history::get_clipboard_history,
            clipboard_history::set_clipboard_history_settings,
            clipboard_history::copy_clipboard_history_item,
            clipboard_history::toggle_clipboard_history_favorite,
            clipboard_history::set_clipboard_history_item_note,
            clipboard_history::delete_clipboard_history_item,
            clipboard_history::clear_clipboard_history,
            translation::toggle_translation_window,
            translation::hide_translation_window,
            translation::read_translation_clipboard,
            translation::copy_translation_result,
            translation::has_translation_secret,
            translation::save_translation_secret,
            translation::delete_translation_secret,
            translation::has_youdao_credentials,
            translation::save_youdao_credentials,
            translation::delete_youdao_credentials,
            translation::translate_text,
            translation::set_translation_shortcut,
            wake_shortcut::set_wake_shortcut,
            shortcut_hotkeys::set_shortcut_panel_hotkey,
            plugins::list_plugins,
            plugins::install_plugin,
            plugins::remove_plugin,
            plugins::open_plugins_directory,
            plugins::run_plugin_action,
            pet_gifs::add_pet_gif,
            pet_gifs::remove_pet_gif,
            video_automation::get_video_automation_state,
            video_automation::set_video_automation_config,
            video_automation::start_video_automation,
            video_automation::stop_video_automation,
        ])
        .run(context)
        .expect("error while running FocuSD Island");
}
