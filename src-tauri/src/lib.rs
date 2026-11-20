mod activity;
mod clipboard_history;
mod netease;
mod desktop_extras;
mod island_rect_store;
mod geometry_invariant;
mod geometry_authority;
mod desktop_icons;
mod web_protocol;
mod dsh_api;
mod dsh_chat;
mod instance_lock;
mod paths;
mod usage;
mod local_chat;
mod icons;
mod lyrics;
mod media_control;
mod messenger_activation;
mod notification_diagnostics;
mod pet_gifs;
mod plugins;
mod relay;
mod web_search;
mod qq_notifications;
mod qq_mail;
mod wechat_reminder_source;
mod wechat_reminders;
mod translation;
mod wake_shortcut;
mod shortcut_hotkeys;
mod collapse_shortcut;
mod custom_sound;
mod video;
mod window_factory;
mod actions;
mod agent_hub;
mod desktop_agents;
mod task_progress;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::VecDeque,
    env, fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    Position, Size, WebviewWindow, WindowEvent,
};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::SetWindowRgn,
    UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
    UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetCursorPos, GetWindowLongPtrW, GetWindowRect,
        IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SWP_NOZORDER, SW_HIDE, SW_SHOW, SW_SHOWNORMAL, WS_EX_APPWINDOW,
        WS_EX_TOOLWINDOW,
    },
};
use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::{ShellExecuteW, SHAppBarMessage, ABM_GETTASKBARPOS, APPBARDATA};

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
/// 聊天框可以单独调高，这里给到 960，实际会被屏幕工作区再收一次。
const MAX_EXPANDED_ISLAND_HEIGHT: f64 = 960.0;
const EXPANDED_RADIUS: f64 = 30.0;
const STAGE_WINDOW_PADDING_Y: f64 = 24.0;
const TUCKED_VISIBLE_EDGE_HEIGHT: f64 = 10.0;
// 展开态（云朵面板）固定尺寸：小狗槽 + 8px 间隙 + 面板。
const EXPANDED_PANEL_WIDTH: f64 = 460.0;
/// 展开态面板的默认高度；实际高度由前端按页面传入（聊天框可在设置里调）。
#[allow(dead_code)]
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
// 位移动画是否还在跑：浮层打开前必须先让动画落定，否则会把动画中间位置当成锚点。
static POSITION_ANIMATING: AtomicBool = AtomicBool::new(false);
// 当前这段位移动画的横向位移（像素）：用来区分“缩边唤醒”的纯竖直移动和“闲逛”的横向漂移。
static POSITION_ANIMATION_DELTA_X: AtomicI32 = AtomicI32::new(0);
// 最小化漂移（派单 2026-11-17）：
// Windows 最小化时会把窗口挪到 (-32000, -32000) 这类哨兵坐标，尺寸也会变成 0；
// 这段时间里任何 `outer_position()` / `outer_size()` 读到的都不是用户位置。
// 过去的几何入口（apply_stage_geometry / ensure_island_on_screen / Moved 回调）
// 会把它当成真实坐标夹取或 set_position/set_size 写回，于是「最小化一次，小狗就换了位置」。
// 现在：最小化期间几何整体冻结，并在最小化前缓存真实矩形，还原后逐像素复位。
static ISLAND_MINIMIZED: AtomicBool = AtomicBool::new(false);
static LAST_SETTLED_ISLAND_RECT: std::sync::Mutex<Option<WindowRect>> = std::sync::Mutex::new(None);
static PRE_MINIMIZE_ISLAND_RECT: std::sync::Mutex<Option<WindowRect>> = std::sync::Mutex::new(None);
static NATIVE_GLASS_INITIALIZED: OnceLock<()> = OnceLock::new();
// 主窗口是否已经 show 过。`frontend_ready` 握手会先一步把窗口显示出来，
// 之后 `show_ready_island` 作为兜底再触发时不能重复抢焦点。
static ISLAND_SHOWN: AtomicBool = AtomicBool::new(false);
// 前端首帧就绪的时间点：排障时用来对照 show 是否发生在握手之后。
static FRONTEND_READY_AT: OnceLock<Instant> = OnceLock::new();

// 启动阶段每一步的时间戳：卡死时直接看最后一条 [startup] 停在哪。
static STARTUP_START: OnceLock<Instant> = OnceLock::new();
static STARTUP_WATCHDOG_FIRED: AtomicBool = AtomicBool::new(false);
static FIRST_INTERACTION_AFTER_READY: AtomicBool = AtomicBool::new(false);

fn startup_start() -> Instant {
    *STARTUP_START.get_or_init(Instant::now)
}

fn startup_mark(step: &str) {
    eprintln!("[startup] step={step} +{}ms", startup_start().elapsed().as_millis());
}

/// 8s watchdog：前端首帧握手迟迟不来（冷启动卡死）时强制 show 一次，至少看到窗口。
fn spawn_startup_watchdog(app: AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if FRONTEND_READY_AT.get().is_some() || STARTUP_WATCHDOG_FIRED.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("STARTUP_WATCHDOG no frontend ready in 8s，强制显示岛屿窗口（不阻塞后续）");
        if let Ok(window) = main_window(&handle) {
            let _ = window.show();
        }
        let _ = show_island(&handle);
        eprintln!("[startup] step=watchdog_done +{}ms", startup_start().elapsed().as_millis());
    });
}
// show 之后窗口仍然不可见时的补显次数与间隔（WebView2 刚握手 / 系统吞掉 show）。
const ISLAND_VISIBILITY_ATTEMPTS: usize = 6;
const ISLAND_VISIBILITY_RETRY_DELAY: Duration = Duration::from_millis(150);

// 多屏放置（2026-11-17）：用户可指定主岛 / Bongo 落在哪块显示器。
// 指纹用「显示器名 + 分辨率」，不用索引（热插拔/改分辨率后索引会变）；匹配不到视为断开，
// 自动回主屏并提示，但**保留偏好**，插回来能自动回到副屏。
static ISLAND_MONITOR_PREF: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static BONGO_MONITOR_PREF: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
// 上一次「副屏断开」提示的 key：同一块屏断开着的时候只提示一次。
static MONITOR_MISSING_NOTIFIED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub name: String,
    /// 稳定指纹：`name|宽x高`。
    pub key: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

fn monitor_key(name: &str, width: u32, height: u32) -> String {
    format!("{name}|{width}x{height}")
}

/// 持久化用的完整指纹：名字 + 分辨率 + 位置（换口/换位置后靠位置兜底认回来）。
fn monitor_full_key(name: &str, width: u32, height: u32, x: i32, y: i32) -> String {
    format!("{}@{},{}", monitor_key(name, width, height), x, y)
}

fn monitor_infos(app: &AppHandle) -> Vec<MonitorInfo> {
    let primary = app.primary_monitor().ok().flatten();
    let primary_pos = primary.as_ref().map(|monitor| (monitor.position().x, monitor.position().y));
    let mut list: Vec<MonitorInfo> = app
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| MonitorInfo {
                    name: monitor.name().cloned().unwrap_or_default(),
                    key: monitor_full_key(
                        monitor.name().map(|name| name.as_str()).unwrap_or(""),
                        monitor.size().width,
                        monitor.size().height,
                        monitor.position().x,
                        monitor.position().y,
                    ),
                    x: monitor.position().x,
                    y: monitor.position().y,
                    width: monitor.size().width,
                    height: monitor.size().height,
                    scale: monitor.scale_factor(),
                    primary: primary_pos == Some((monitor.position().x, monitor.position().y)),
                })
                .collect()
        })
        .unwrap_or_default();
    // 主屏排最前，其余按 x 从左到右（副屏在左时 x 为负，正好符合视觉顺序）。
    list.sort_by_key(|info| (!info.primary, info.x));
    list
}

/// 按指纹找显示器：完整指纹（名字+分辨率+位置）→ 名字+分辨率（换位置）→ 只按名字
/// （换分辨率）→ 尺寸+位置（换了接口）。全都匹配不到 = 这块屏被拔掉了。
fn find_monitor_by_key(app: &AppHandle, key: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let exact = monitors.iter().find(|monitor| {
        monitor_full_key(
            monitor.name().map(|value| value.as_str()).unwrap_or(""),
            monitor.size().width,
            monitor.size().height,
            monitor.position().x,
            monitor.position().y,
        ) == key
    });
    if let Some(monitor) = exact {
        return Some(monitor.clone());
    }
    let name = key.split('|').next().unwrap_or(key);
    let prefix = key.split('@').next().unwrap_or(key);
    if let Some(monitor) = monitors.iter().find(|monitor| {
        monitor_key(
            monitor.name().map(|value| value.as_str()).unwrap_or(""),
            monitor.size().width,
            monitor.size().height,
        ) == prefix
    }) {
        return Some(monitor.clone());
    }
    if let Some(monitor) = monitors
        .iter()
        .find(|monitor| monitor.name().map(|value| value.as_str()) == Some(name))
    {
        return Some(monitor.clone());
    }
    // 位置兜底：`WxH@x,y`（旧的纯 name|WxH 指纹没有 @，这一步不参与）。
    let geometry = key.split_once('@').map(|(_, rest)| rest.to_string());
    let same_geometry = monitors.iter().find(|monitor| {
        geometry
            .as_deref()
            .map(|value| format!("{}x{}@{},{}", monitor.size().width, monitor.size().height, monitor.position().x, monitor.position().y) == value)
            .unwrap_or(false)
    });
    same_geometry.cloned()
}

/// Bongo / 陪玩狗的落点：优先 Bongo 指定屏，否则跟随主岛指定屏，再否则主屏。

static TRAY_HANDLE: std::sync::OnceLock<tauri::tray::TrayIcon> = std::sync::OnceLock::new();

/// 托盘图标作为「面板收起时也能看到采集状态」的出口（N4）。
pub(crate) fn set_tray_status(_app: &tauri::AppHandle, text: &str) {
    if let Some(tray) = TRAY_HANDLE.get() {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// 恢复默认托盘提示。
pub(crate) fn reset_tray_status(app: &tauri::AppHandle) {
    set_tray_status(app, "Maltese 线条小狗");
}

pub(crate) fn extras_target_monitor_key(app: &AppHandle) -> Option<String> {
    let bongo = BONGO_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    let island_pref = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    resolve_extras_target_key(bongo, island_pref, island_actual_monitor_key(app))
}

/// 「跟随小狗」的目标屏解析（纯函数，有单测）：
/// 1. Bongo 单独指定了屏 → 用它；
/// 2. 没单独指定、但「小狗屏幕」选了一块具体的屏 → 跟随小狗的**偏好**；
/// 3. 「小狗屏幕」是「跟随上次位置」/没设置（偏好为 None）→ 跟随小狗**实际所在显示器**。
///    这一步是「重启后 Bongo 回主屏」的根因：偏好 None 时不能直接回主屏，
///    否则小狗靠持久化的位置落在副屏，而 Bongo 又回了主屏。
pub(crate) fn resolve_extras_target_key(
    bongo_pref: Option<String>,
    island_pref: Option<String>,
    island_actual: Option<String>,
) -> Option<String> {
    bongo_pref.or(island_pref).or(island_actual)
}

/// 主岛窗口当前所在显示器的完整指纹（名字|宽x高@x,y，与 `monitor_infos` 一致）。
pub(crate) fn bongo_pref_key() -> Option<String> {
    BONGO_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone())
}

pub(crate) fn island_actual_monitor_key(app: &AppHandle) -> Option<String> {
    let window = app.get_webview_window(WINDOW_LABEL)?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    Some(monitor_full_key(
        monitor.name().map(|name| name.as_str()).unwrap_or(""),
        monitor.size().width,
        monitor.size().height,
        monitor.position().x,
        monitor.position().y,
    ))
}

pub(crate) fn find_extras_monitor(app: &AppHandle, key: Option<&str>) -> Option<Monitor> {
    match key {
        Some(key) => find_monitor_by_key(app, key).or_else(|| app.primary_monitor().ok().flatten()),
        None => app.primary_monitor().ok().flatten(),
    }
}

fn set_monitor_pref(slot: &std::sync::Mutex<Option<String>>, value: Option<String>) {
    if let Ok(mut guard) = slot.lock() {
        *guard = value;
    }
}

/// 当前生效的主岛显示器（指纹匹配到的那块）；没有偏好时返回 None（沿用老逻辑）。
fn preferred_island_monitor(window: &WebviewWindow) -> Option<Monitor> {
    let key = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone())?;
    find_monitor_by_key(window.app_handle(), &key)
}

/// 显示器热插拔：Tauri 2 没有跨平台的 monitor-change 事件，这里 30s 轮询指纹集合
/// （只在集合真的变化时才重排，不新增高频定时器）。
fn monitor_signature(app: &AppHandle) -> String {
    monitor_infos(app)
        .iter()
        .map(|info| format!("{}@{}x{}+{}", info.name, info.width, info.height, info.x))
        .collect::<Vec<_>>()
        .join(",")
}

fn has_monitor_preference() -> bool {
    let island = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    let bongo = BONGO_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    island.is_some() || bongo.is_some()
}

fn start_monitor_watch(app: AppHandle) {
    if thread::Builder::new()
        .name("monitor-watch".into())
        .spawn(move || {
            let mut last = monitor_signature(&app);
            loop {
                thread::sleep(Duration::from_secs(30));
                let current = monitor_signature(&app);
                if current == last {
                    continue;
                }
                last = current;
                eprintln!("[monitor] display layout changed: {last}");
                // pinned 不依赖主岛几何（主岛最小化时 apply 会冻结），这里单独摆一次。
                let _ = place_pinned_window(&app);
                if !has_monitor_preference() {
                    continue;
                }
                if let Ok(window) = main_window(&app) {
                    let state = read_window_state();
                    if let Err(error) = apply_stage_geometry(&window, state, false) {
                        eprintln!("failed to re-apply island geometry after monitor change: {error}");
                    }
                }
                if let Some(config) = desktop_extras::last_config() {
                    let _ = desktop_extras::sync_extras_now(&app, &config);
                }
            }
        })
        .is_err()
    {
        eprintln!("failed to spawn monitor watch thread");
    }
}

/// 几何不变量自检：8 个场景回到结构化结果，面板/QA 脚本可直接看。
#[tauri::command]
fn island_geometry_selftest() -> serde_json::Value {
    let results = geometry_invariant::selftest_scenarios();
    let passed = results.iter().filter(|item| item.pass).count();
    serde_json::json!({
        "tolerance": geometry_invariant::SLOT_TOLERANCE,
        "total": results.len(),
        "passed": passed,
        "scenarios": results,
    })
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    monitor_infos(&app)
}

/// 设置「小狗屏幕 / Bongo 屏幕」；`None` 表示回到主屏（或跟随主岛）。
/// 会清掉 custom_position 并按新屏重排，所以切屏后落在该屏的默认锚点。
#[tauri::command]
fn set_monitor_preferences(
    app: AppHandle,
    island: Option<String>,
    bongo: Option<String>,
) -> Result<(), String> {
    let window = main_window(&app)?;
    set_monitor_pref(&ISLAND_MONITOR_PREF, island);
    set_monitor_pref(&BONGO_MONITOR_PREF, bongo);
    // 换屏后旧坐标属于旧屏，清掉自定义位置让新屏的锚点生效。
    let state = mutate_window_state(|state| {
        state.custom_position = None;
        state.is_dragging = false;
        *state
    });
    let result = apply_stage_geometry(&window, state, false);
    // 固定在桌面的标签页跟随同一块屏：显示中就立刻移动，隐藏中也只更新下次显示的位置。
    if let Err(error) = place_pinned_window(&app) {
        eprintln!("failed to move pinned window after monitor change: {error}");
    }
    // Bongo / 陪玩狗也按同样的屏重排一次。
    if let Some(config) = desktop_extras::last_config() {
        let _ = desktop_extras::sync_extras_now(&app, &config);
    }
    if let Ok(mut guard) = MONITOR_MISSING_NOTIFIED.lock() {
        *guard = None;
    }
    result
}

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
    if FRONTEND_READY_AT.get().is_some()
        && !FIRST_INTERACTION_AFTER_READY.swap(true, Ordering::SeqCst)
    {
        eprintln!(
            "[startup] first_interaction_after_ready +{}ms",
            startup_start().elapsed().as_millis()
        );
    }
    let mode = IslandMode::from_value(&mode)?;
    let previous_state = read_window_state();
    // 操作前期望的狗槽：custom_position 优先，否则最近一次落定矩形（右键/展开的锚点语义）。
    let expected_slot_before = expected_slot_from_state(&window);
    let overlay_rect_before = read_sane_island_rect(&window);
    // 右键/点气泡从收起态直接展开时，锚点必须是「小狗当前真正所在的位置」：
    // 前端传上来的 custom_position 可能是很久以前的（浮层打开/回位、闲逛之后都不更新），
    // 用它当锚点会把窗口算到别的屏/别的 x 上（用户看到「右键气泡往右跳」）。
    // 这里直接用最近一次几何落定的真实矩形（最小化漂移那套缓存）当锚点；
    // 位移动画还没落定时先等最多 150ms，避免把过渡帧当锚点。
    let collapsing_to_expanded =
        matches!(mode, IslandMode::Expanded) && matches!(previous_state.mode, IslandMode::Collapsed);
    let mut settled_anchor = None;
    if collapsing_to_expanded {
        let deadline = Instant::now() + Duration::from_millis(150);
        while POSITION_ANIMATING.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        settled_anchor = LAST_SETTLED_ISLAND_RECT
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .map(|rect| IslandPosition {
                x: rect.x,
                y: rect.y,
            });
    }
    let mut anchor_source = "none";
    if settled_anchor.is_some() {
        anchor_source = "settled_rect";
    }
    let restored_custom_position = settled_anchor.or_else(|| {
        previous_state.custom_position.or_else(|| {
            let filtered = custom_position.filter(|position| {
                monitor_for_island_position(&window, *position, previous_state.collapsed_scale)
                    .ok()
                    .flatten()
                    .is_some()
            });
            if filtered.is_some() {
                anchor_source = "frontend";
            }
            filtered
        })
    });
    if anchor_source == "none" && previous_state.custom_position.is_some() {
        anchor_source = "prev_state";
    }
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
                MAX_EXPANDED_ISLAND_HEIGHT,
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
    // 不变量：任何展开/浮层前后，狗槽的屏幕坐标必须不变。
    // 展开前先把当前窗口矩形记下来（收起态狗槽 = 窗口左上角）。
    let rect_before = if collapsing_to_expanded {
        read_sane_island_rect(&window)
    } else {
        None
    };
    let overlay_was_open = OVERLAY_SNAPSHOT
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);
    let rect_before_overlay_check = read_sane_island_rect(&window);
    let geometry = apply_stage_geometry(
        &window,
        state,
        animate_position.unwrap_or(true) && previous_state.is_tucked != state.is_tucked,
    );
    if overlay_was_open {
        let after = read_sane_island_rect(&window);
        eprintln!(
            "RC_GEOM_AFTER_OVERLAY before={:?} after={:?} anchor={} overlay_active=true err={:?}",
            rect_before_overlay_check.map(|rect| (rect.x, rect.y, rect.width, rect.height)),
            after.map(|rect| (rect.x, rect.y, rect.width, rect.height)),
            anchor_source,
            geometry.as_ref().err()
        );
    }
    if let (Ok(()), Some(before), true) = (&geometry, rect_before, collapsing_to_expanded) {
        correct_expanded_slot_after(&window, state, before, anchor_source);
    }
    geometry?;
    // Bongo「跟随小狗」按主岛**实际所在屏**解析：主岛位置刚恢复 / 切屏后重排一次（幂等）。
    if let Some(config) = desktop_extras::last_config() {
        let _ = desktop_extras::sync_extras_now(&app, &config);
    }
    geometry_authority::record(
        "set_island_interaction",
        overlay_rect_before.map(|rect| geometry_authority::rect(rect.x, rect.y, rect.width, rect.height)),
        read_sane_island_rect(&window).map(|rect| geometry_authority::rect(rect.x, rect.y, rect.width, rect.height)),
    );
    if collapsing_to_expanded {
        let before = dog_slot_now(&window);
        let panel_side = LAST_PANEL_SIDE
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .unwrap_or("right");
        eprintln!(
            "RIGHTCLICK_GEOM before={:?} after={:?} anchor={} panelSide={} overlay_before={:?} monitor={:?}",
            overlay_rect_before.map(|rect| (rect.x, rect.y, rect.width, rect.height)),
            read_sane_island_rect(&window).map(|rect| (rect.x, rect.y, rect.width, rect.height)),
            anchor_source,
            panel_side,
            before.map(|slot| (slot.x, slot.y)),
            window
                .current_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_fingerprint_of(&monitor))
        );
    }
    // 不变量强制约束：不论哪条路径把位置算错，展开落定后都把狗槽拉回操作前的位置（±2px）。
    enforce_slot_invariant(&window, expected_slot_before, "set_island_interaction");
    let glass = apply_glass_material(&window, state);
    ensure_island_on_screen(&window);
    persist_island_snapshot(&app);
    glass
}

// ---------------------------------------------------------------------------
// 最小化漂移防护（2026-11-17 派单）
//
// Windows 最小化会把窗口移到 (-32000, -32000) 附近、尺寸变成 0。旧代码里
// `apply_stage_geometry` / `ensure_island_on_screen` / `WindowEvent::Moved` 会在
// 这个瞬间读到哨兵坐标，夹取后 `set_position`/`set_size`，等于把「还原位置」
// 写成了别的值 —— 用户看到的就是「最小化一次，小狗回来时位置变了」。
// 现在的规则：
//   1) 最小化（或拿到哨兵坐标）期间，所有几何入口直接返回，不改 state、不写窗口；
//   2) 每次几何落定时缓存真实矩形；最小化前把它冻结成 PRE_MINIMIZE；
//   3) 还原后按 PRE_MINIMIZE 逐像素复位，再恢复常规几何计算。
// ---------------------------------------------------------------------------

/// 物理像素矩形（主窗口 outer rect）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Windows 最小化哨兵坐标（约 -32000）；同数量级的一律不采信。
const MINIMIZED_SENTINEL_THRESHOLD: i32 = -30_000;
/// 小于这个尺寸的矩形不是桌宠窗口的真实矩形（最小化 / 创建中 / 刚隐藏）。
const MIN_SANE_ISLAND_SIZE: u32 = 32;

fn is_sentinel_window_position(x: i32, y: i32) -> bool {
    x <= MINIMIZED_SENTINEL_THRESHOLD || y <= MINIMIZED_SENTINEL_THRESHOLD
}

/// 过滤掉最小化哨兵位置 / 0 尺寸 / 明显不合理的矩形。
fn sane_window_rect(rect: WindowRect) -> Option<WindowRect> {
    if is_sentinel_window_position(rect.x, rect.y) {
        return None;
    }
    if rect.width < MIN_SANE_ISLAND_SIZE || rect.height < MIN_SANE_ISLAND_SIZE {
        return None;
    }
    Some(rect)
}

/// 读一次主窗口真实矩形（最小化期间返回 None）。
fn read_sane_island_rect(window: &WebviewWindow) -> Option<WindowRect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    sane_window_rect(WindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// 所有几何入口的第一道闸：最小化 / 还原过渡期间不重算、不写位置尺寸。
fn island_geometry_frozen(window: &WebviewWindow) -> bool {
    if ISLAND_MINIMIZED.load(Ordering::SeqCst) {
        return true;
    }
    if window.is_minimized().unwrap_or(false) {
        return true;
    }
    if let Ok(position) = window.outer_position() {
        if is_sentinel_window_position(position.x, position.y) {
            return true;
        }
    }
    false
}

/// 展开/浮层事后校正：保证「狗槽」屏幕坐标与展开前一致。
///
/// 锚点来源可能算错（旧 custom_position / 过渡帧），但只要事后量一次就能把窗口平移回原位，
/// 用户侧看不到跳动。dx/dy 超过 1px 才纠正，避免无意义的 1px 抖动。
fn correct_expanded_slot_after(
    window: &WebviewWindow,
    state: IslandWindowState,
    slot_before: WindowRect,
    anchor_source: &str,
) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let slot_w = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_h = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    let panel_side = LAST_PANEL_SIDE
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .unwrap_or("right");
    let panel_vertical = LAST_PANEL_VERTICAL
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .unwrap_or("above");
    let phys_w = size.width as i32;
    let phys_h = size.height as i32;
    let slot_x = if panel_side == "left" {
        position.x + phys_w - slot_w
    } else {
        position.x
    };
    let slot_y = if panel_vertical == "above" {
        position.y + phys_h - slot_h
    } else {
        position.y
    };
    // 锚点保护：slot_before 不在任何显示器里（典型：浮层态窗口坐标被当成狗槽）→ 回退 LAST_SETTLED。
    let mut slot_before = slot_before;
    let before_on_screen = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| slot_inside_monitor(slot_before, &monitor))
        .unwrap_or(true);
    if !before_on_screen {
        if let Ok(settled) = LAST_SETTLED_ISLAND_RECT.lock() {
            if let Some(settled) = *settled {
                eprintln!(
                    "RECALC_GUARD reason=anchor_offscreen from=({},{}) fallback_settled=({},{})",
                    slot_before.x, slot_before.y, settled.x, settled.y
                );
                slot_before = settled;
            }
        }
    }
    let dx = slot_x - slot_before.x;
    let dy = slot_y - slot_before.y;
    let monitor_fingerprint = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_full_key(
            monitor.name().map(|name| name.as_str()).unwrap_or(""),
            monitor.size().width,
            monitor.size().height,
            monitor.position().x,
            monitor.position().y,
        ))
        .unwrap_or_else(|| "?".to_string());
    eprintln!(
        "RC_GEOM before={},{} {}x{} after={},{} {}x{} anchor={} monitor={} panel_side={} panel_vertical={} slot_before=({},{}) slot_after=({},{}) dx={} dy={}",
        slot_before.x, slot_before.y, slot_before.width, slot_before.height,
        position.x, position.y, phys_w as u32, phys_h as u32,
        anchor_source, monitor_fingerprint, panel_side, panel_vertical,
        slot_before.x, slot_before.y, slot_x, slot_y, dx, dy
    );
    // 目标窗口位置：先按 slot 不变量把狗槽拉回展开前的位置。
    let (mut target_x, mut target_y) = (position.x - dx, position.y - dy);
    // 跨屏禁止：窗口必须完全落在**狗槽所在显示器**内（左侧副屏全部是负坐标）。
    if let Some(monitor) = dog_monitor_for_slot(window, slot_before, slot_w, slot_h) {
        let monitor_rect = screen_rect_of_monitor(&monitor);
        let (clamped_x, clamped_y, _cw, _ch) = clamp_rect_to_safe(
            target_x,
            target_y,
            phys_w,
            phys_h,
            monitor_rect,
        );
        if clamped_x != target_x || clamped_y != target_y {
            eprintln!(
                "OVERLAY_MONITOR_CLAMP wanted=({},{},{},{}) clamped=({},{},{},{}) monitor={}",
                target_x,
                target_y,
                phys_w,
                phys_h,
                clamped_x,
                clamped_y,
                phys_w,
                phys_h,
                monitor_full_key(
                    monitor.name().map(|name| name.as_str()).unwrap_or(""),
                    monitor.size().width,
                    monitor.size().height,
                    monitor.position().x,
                    monitor.position().y,
                )
            );
            target_x = clamped_x;
            target_y = clamped_y;
        }
    }
    if target_x == position.x && target_y == position.y {
        return;
    }
    // 兜底：偏差 >2px 且结果贴屏幕左上角（<50px）→ 记录角落风险并（配合不变量）纠正回原槽。
    let corner_risk = target_x.abs() < 50 && target_y.abs() < 50;
    if corner_risk && (dx.abs() > 2 || dy.abs() > 2) {
        eprintln!(
            "OVERLAY_CORNER_GUARD corner_risk=true slot_before=({},{}) slot_after=({},{}) dx={dx} dy={dy} target=({target_x},{target_y})",
            slot_before.x, slot_before.y, slot_x, slot_y
        );
    }
    if reject_zero_position(window, target_x, target_y, "slot_correct") {
        return;
    }
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(target_x, target_y)));
    eprintln!(
        "OVERLAY_SLOT_CORRECT dx={} dy={} from=({},{}) to=({},{})",
        dx, dy, position.x, position.y, target_x, target_y
    );
    // 统一不变量校验点：纠正后再量一次狗槽，超差就记 SLOT_INVARIANT_VIOLATION（并再纠一次）。
    let slot_before_rect = geometry_invariant::SlotRect::new(
        slot_before.x,
        slot_before.y,
        slot_before.width as i32,
        slot_before.height as i32,
    );
    if let Ok(after_size) = window.outer_size() {
        let after_slot = geometry_invariant::slot_from_window(
            geometry_invariant::SlotRect::new(
                target_x,
                target_y,
                after_size.width as i32,
                after_size.height as i32,
            ),
            panel_side,
            panel_vertical,
            slot_before_rect.width,
            slot_before_rect.height,
        );
        if let Some(violation) =
            geometry_invariant::assert_slot_invariant(slot_before_rect, after_slot, "expanded_slot_correct", true)
        {
            eprintln!(
                "SLOT_INVARIANT_VIOLATION op={} dx={} dy={} corrected={} before=({},{}) after=({},{})",
                violation.op,
                violation.dx,
                violation.dy,
                violation.corrected,
                violation.before.x,
                violation.before.y,
                violation.after.x,
                violation.after.y
            );
        }
    }
    remember_settled_island_rect(window);
}

/// 狗槽（展开前位置）落在哪块显示器上。
fn slot_inside_monitor(slot: WindowRect, monitor: &Monitor) -> bool {
    let position = monitor.position();
    let size = monitor.size();
    slot.x >= position.x
        && slot.y >= position.y
        && slot.x + slot.width as i32 <= position.x + size.width as i32
        && slot.y + slot.height as i32 <= position.y + size.height as i32
}

/// (0,0) 是历史 P0「锚点算错」的典型产物；一律拒绝写入并留证。
fn reject_zero_position(window: &WebviewWindow, x: i32, y: i32, reason: &str) -> bool {
    if x != 0 || y != 0 {
        return false;
    }
    eprintln!(
        "RECALC_GUARD reason=zero-position op={reason} label={} rejected=true",
        window.label()
    );
    true
}


/// 前端实测的狗元素在窗口内的偏移（CSS 像素）。
#[derive(Clone, Debug)]
struct PetSlotMeasure {
    mode: String,
    off_x: f64,
    off_y: f64,
    width: f64,
    height: f64,
}

static PET_SLOT_MEASURE: std::sync::Mutex<Option<PetSlotMeasure>> = std::sync::Mutex::new(None);
/// 按布局态分别保存实测偏移：collapsed 的样本绝不能用于 overlay/expanded 落位。
static PET_SLOT_MEASURES: std::sync::Mutex<std::option::Option<std::collections::HashMap<String, PetSlotMeasure>>> =
    std::sync::Mutex::new(None);
/// 本次几何操作是否已经用实测 offset 预纠正过（防止 offset 被减两次）。
static OFFSET_ALREADY_APPLIED: AtomicBool = AtomicBool::new(false);

/// 当前真实布局态：overlay 打开时 state.mode 仍是 collapsed，必须靠 OVERLAY_SNAPSHOT 判定。
fn current_layout_mode() -> &'static str {
    if OVERLAY_SNAPSHOT.lock().map(|slot| slot.is_some()).unwrap_or(false) {
        return "overlay";
    }
    match read_window_state().mode {
        IslandMode::Expanded => "expanded",
        IslandMode::Collapsed => "collapsed",
    }
}

fn same_mode_measure(layout_mode: &str) -> Option<PetSlotMeasure> {
    PET_SLOT_MEASURES
        .lock()
        .ok()
        .and_then(|map| map.as_ref().and_then(|entries| entries.get(layout_mode).cloned()))
}

/// 前端在浮层/展开后上报狗元素相对窗口的实测偏移（CSS px）。
/// Rust 侧狗槽真值一律用「窗口原点 + 实测偏移」，不再用 panelSide 公式反推。
#[tauri::command]
fn report_pet_slot_offset(
    app: AppHandle,
    mode: String,
    off_x: f64,
    off_y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let measure = PetSlotMeasure {
        mode: mode.clone(),
        off_x,
        off_y,
        width,
        height,
    };
    if let Ok(mut slot) = PET_SLOT_MEASURE.lock() {
        *slot = Some(measure.clone());
    }
    if let Ok(mut map) = PET_SLOT_MEASURES.lock() {
        map.get_or_insert_with(std::collections::HashMap::new)
            .insert(mode.clone(), measure.clone());
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        let slot_x = position.x + (off_x * scale).round() as i32;
        let slot_y = position.y + (off_y * scale).round() as i32;
        let expected = expected_slot_from_state(&window);
        let dx = expected.map(|slot| slot_x - slot.x).unwrap_or(0);
        let dy = expected.map(|slot| slot_y - slot.y).unwrap_or(0);
        let mut corrected = false;
        let mut target = (position.x, position.y);
        let layout_mode = current_layout_mode();
        let same_mode = layout_mode == mode && mode != "collapsed";
        let offset_source = if same_mode { "same-mode" } else if mode == "collapsed" { "none" } else { "stale" };
        // 启动 3s 窗口内只记录不纠正（否则会用 (0,0) 类偏移把窗口从副屏拉回主屏）。
        let startup_window = startup_restore_active();
        let already_applied = OFFSET_ALREADY_APPLIED.swap(false, Ordering::SeqCst);
        // 实测纠正：只允许「当前布局态 == 本次测量态」且不在启动窗口期内。
        if same_mode && !startup_window && !already_applied && (dx.abs() > 2 || dy.abs() > 2) {
            target = (position.x - dx, position.y - dy);
            if !reject_zero_position(&window, target.0, target.1, "measured_slot") {
                let _ = window.set_position(Position::Physical(PhysicalPosition::new(target.0, target.1)));
                corrected = true;
            }
        }
        eprintln!(
            "OVERLAY_DOG_MEASURE mode={mode} window=({},{},{},{}) offset=({off_x:.1},{off_y:.1}) slot=({slot_x},{slot_y}) expected={:?} dx={dx} dy={dy} corrected={corrected} target=({},{})",
            position.x,
            position.y,
            size.width,
            size.height,
            expected.map(|slot| (slot.x, slot.y)),
            target.0,
            target.1
        );
        eprintln!(
            "GEOM_DECISION op=report_pet_slot_offset mode={mode} offsetSource={offset_source} offsetApplied={} expected={:?} final=({},{}) corrected={corrected} startupWindow={startup_window}",
            if corrected { "once" } else if already_applied { "once" } else { "none" },
            expected.map(|slot| (slot.x, slot.y)),
            target.0,
            target.1
        );
    }
    Ok(())
}

/// 用实测偏移算狗槽（仅展开/浮层态；没测量过就返回 None，由调用方回退公式）。
fn measured_dog_slot(window: &WebviewWindow) -> Option<WindowRect> {
    let layout_mode = current_layout_mode();
    if layout_mode == "collapsed" {
        return None;
    }
    // 只用与当前布局态一致的样本；没有就回退公式（绝不拿 collapsed 的 (0,0) 当 overlay 偏移）。
    let measure = same_mode_measure(layout_mode)?;
    let state = read_window_state();
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?;
    let slot_w = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_h = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    Some(WindowRect {
        x: position.x + (measure.off_x * scale).round() as i32,
        y: position.y + (measure.off_y * scale).round() as i32,
        width: slot_w as u32,
        height: slot_h as u32,
    })
}

/// 当前狗槽（收起态 = 窗口左上角；展开/浮层态 = 窗口原点 + 前端实测偏移，缺测量才回退公式）。
fn dog_slot_now(window: &WebviewWindow) -> Option<WindowRect> {
    if let Some(measured) = measured_dog_slot(window) {
        return Some(measured);
    }
    let rect = read_sane_island_rect(window)?;
    let state = read_window_state();
    let scale = window.scale_factor().ok()?;
    let slot_w = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_h = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    let (side, vertical) = if matches!(state.mode, IslandMode::Collapsed) {
        ("right".to_string(), "below".to_string())
    } else {
        (
            LAST_PANEL_SIDE
                .lock()
                .ok()
                .and_then(|slot| *slot)
                .unwrap_or("right")
                .to_string(),
            LAST_PANEL_VERTICAL
                .lock()
                .ok()
                .and_then(|slot| *slot)
                .unwrap_or("above")
                .to_string(),
        )
    };
    let slot = geometry_invariant::slot_from_window(
        geometry_invariant::SlotRect::new(rect.x, rect.y, rect.width as i32, rect.height as i32),
        &side,
        &vertical,
        slot_w,
        slot_h,
    );
    Some(WindowRect {
        x: slot.x,
        y: slot.y,
        width: slot_w as u32,
        height: slot_h as u32,
    })
}

/// 当前状态「应该」落在的狗槽：优先 custom_position，其次最近一次落定矩形。
fn expected_slot_from_state(window: &WebviewWindow) -> Option<WindowRect> {
    let state = read_window_state();
    let scale = window.scale_factor().ok()?;
    let slot_w = (slot_width_css(state.collapsed_scale) * scale).round() as i32;
    let slot_h = (slot_height_css(state.collapsed_scale) * scale).round() as i32;
    if let Some(position) = state.custom_position {
        return Some(WindowRect {
            x: position.x,
            y: position.y,
            width: slot_w as u32,
            height: slot_h as u32,
        });
    }
    LAST_SETTLED_ISLAND_RECT
        .lock()
        .ok()
        .and_then(|slot| *slot)
}

/// 统一不变量约束：操作后狗槽偏离 expected 超过 2px 就立刻平移纠正并留证。
/// 返回最终是否满足不变量（true = 没有偏差或已纠正成功）。
fn enforce_slot_invariant(window: &WebviewWindow, expected: Option<WindowRect>, op: &str) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Some(after) = dog_slot_now(window) else {
        return true;
    };
    let before_rect = geometry_invariant::SlotRect::new(
        expected.x,
        expected.y,
        expected.width as i32,
        expected.height as i32,
    );
    let after_rect = geometry_invariant::SlotRect::new(
        after.x,
        after.y,
        after.width as i32,
        after.height as i32,
    );
    let Some(violation) =
        geometry_invariant::assert_slot_invariant(before_rect, after_rect, op, true)
    else {
        return true;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        eprintln!(
            "SLOT_INVARIANT_VIOLATION op={op} dx={} dy={} corrected=false reason=no_window_rect",
            violation.dx, violation.dy
        );
        return false;
    };
    let current_window = geometry_invariant::SlotRect::new(
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    );
    let target =
        geometry_invariant::correction_target(current_window, before_rect, after_rect);
    if !reject_zero_position(window, target.x, target.y, op) {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(target.x, target.y)));
    }
    let recheck_ok = dog_slot_now(window)
        .map(|current| {
            geometry_invariant::within_tolerance(
                before_rect,
                geometry_invariant::SlotRect::new(
                    current.x,
                    current.y,
                    current.width as i32,
                    current.height as i32,
                ),
            )
        })
        .unwrap_or(true);
    eprintln!(
        "SLOT_INVARIANT_VIOLATION op={op} dx={} dy={} corrected={} before=({},{}) after=({},{}) target=({},{})",
        violation.dx,
        violation.dy,
        recheck_ok,
        before_rect.x,
        before_rect.y,
        after_rect.x,
        after_rect.y,
        target.x,
        target.y
    );
    recheck_ok
}

fn dog_monitor_for_slot(
    window: &WebviewWindow,
    slot: WindowRect,
    slot_w: i32,
    slot_h: i32,
) -> Option<Monitor> {
    let center_x = slot.x + slot_w / 2;
    let center_y = slot.y + slot_h / 2;
    let monitors = window.available_monitors().ok()?;
    monitors
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            center_x >= position.x
                && center_x < position.x + size.width as i32
                && center_y >= position.y
                && center_y < position.y + size.height as i32
        })
        .or_else(|| window.primary_monitor().ok().flatten())
}

/// 几何落定后记一笔真实矩形，作为「最小化前位置」的缓存来源。
fn remember_settled_island_rect(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let Some(rect) = read_sane_island_rect(window) else {
        return;
    };
    if let Ok(mut slot) = LAST_SETTLED_ISLAND_RECT.lock() {
        *slot = Some(rect);
    }
    // 顺带写「退出后启动恢复」用的快照（同一矩形会去重）。
    persist_island_snapshot(window.app_handle());
}

/// 检测到最小化：冻结真实矩形（重复的 Moved/Resized 事件不会覆盖第一次的快照）。
fn note_island_minimized() {
    ISLAND_MINIMIZED.store(true, Ordering::SeqCst);
    // 最小化期间动画线程不能再 set_position：那会改写系统的还原位置。
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    POSITION_ANIMATING.store(false, Ordering::SeqCst);
    let settled = LAST_SETTLED_ISLAND_RECT
        .lock()
        .ok()
        .and_then(|slot| *slot);
    if let Some(rect) = settled {
        if let Ok(mut slot) = PRE_MINIMIZE_ISLAND_RECT.lock() {
            if slot.is_none() {
                *slot = Some(rect);
            }
        }
    }
}

/// 还原：按最小化前的真实矩形逐像素复位，再交回常规几何计算。
fn restore_island_rect_after_unminimize(window: &WebviewWindow) {
    ISLAND_MINIMIZED.store(false, Ordering::SeqCst);
    let restore = PRE_MINIMIZE_ISLAND_RECT
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    let Some(rect) = restore else {
        remember_settled_island_rect(window);
        return;
    };
    if read_sane_island_rect(window) != Some(rect) {
        let _ = window.set_size(Size::Physical(PhysicalSize::new(rect.width, rect.height)));
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)));
    }
    if let Ok(mut slot) = LAST_SETTLED_ISLAND_RECT.lock() {
        *slot = Some(rect);
    }
}

/// 最小化/还原事件统一入口（Resized / Focused / Moved 都汇到这里）：
/// 只在状态翻转的那一帧做快照或复位，其余事件什么也不改。
fn sync_minimize_geometry(window: &WebviewWindow) {
    let minimized = window.is_minimized().unwrap_or(false);
    if minimized {
        note_island_minimized();
        return;
    }
    if ISLAND_MINIMIZED.load(Ordering::SeqCst) {
        restore_island_rect_after_unminimize(window);
    } else {
        remember_settled_island_rect(window);
    }
}

// 保险：几何应用后窗口如果完全跑到工作区之外（多屏切换 / 异常位置），
// 清掉自定义位置、回到默认锚点并显示，避免“点一下小狗就整个不见了”。
// ---------------------------------------------------------------------------
// 启动恢复：退出/几何落定时把最终矩形写盘，启动先按矩形恢复（不依赖设置解析链路）
// ---------------------------------------------------------------------------
static STARTUP_RESTORED: AtomicBool = AtomicBool::new(false);
static STARTUP_RESTORE_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
/// 上次落盘的矩形：同一矩形不重复写盘（几何事件很频繁）。
static LAST_PERSISTED_RECT: std::sync::Mutex<Option<(i32, i32, u32, u32)>> =
    std::sync::Mutex::new(None);

fn now_unix_millis() -> u64 {
    u64::try_from(current_unix_millis()).unwrap_or_default()
}

fn startup_restore_active() -> bool {
    STARTUP_RESTORED.load(Ordering::SeqCst) && now_unix_millis() < STARTUP_RESTORE_UNTIL_MS.load(Ordering::SeqCst)
}

fn monitor_fingerprint_of(monitor: &Monitor) -> String {
    monitor_full_key(
        monitor.name().map(|name| name.as_str()).unwrap_or(""),
        monitor.size().width,
        monitor.size().height,
        monitor.position().x,
        monitor.position().y,
    )
}

/// 把当前窗口矩形落盘（几何落定 / 拖拽结束 / 锁角 / 切屏 / 缩边唤醒 / 退出时调用）。
fn persist_island_snapshot(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    if size.width < MIN_SANE_ISLAND_SIZE || size.height < MIN_SANE_ISLAND_SIZE {
        return;
    }
    if is_sentinel_window_position(position.x, position.y) {
        return;
    }
    let rect = (position.x, position.y, size.width, size.height);
    if let Ok(slot) = LAST_PERSISTED_RECT.lock() {
        if *slot == Some(rect) {
            return;
        }
    }
    let monitor = window.current_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|value| value.scale_factor()).unwrap_or(1.0);
    let state = read_window_state();
    // 启动快照只保存「收起态狗槽」：展开/浮层态退出时，窗口矩形是面板尺寸（727×480 / 587×540），
    // 直接存下来会让下次启动恢复成展开位置（用户看到“重启不跟随副屏设置”）。
    // 这里统一折算成狗槽 + 收起态尺寸，mode 一律 collapsed；启动恢复永远走收起态。
    let layout_overlay = current_layout_mode() == "overlay";
    let canonical_slot = if matches!(state.mode, IslandMode::Expanded) || layout_overlay {
        dog_slot_now(&window)
    } else {
        None
    };
    let (snapshot_x, snapshot_y, snapshot_w, snapshot_h, snapshot_mode) = match canonical_slot {
        Some(slot) => {
            eprintln!(
                "SNAPSHOT_CANONICAL from=({},{},{},{}) slot=({},{},{},{})",
                position.x, position.y, size.width, size.height, slot.x, slot.y, slot.width, slot.height
            );
            (slot.x, slot.y, slot.width, slot.height, "collapsed")
        }
        None => (position.x, position.y, size.width, size.height, "collapsed"),
    };
    let snapshot = island_rect_store::IslandRectSnapshot {
        x: snapshot_x,
        y: snapshot_y,
        width: snapshot_w,
        height: snapshot_h,
        mode: snapshot_mode.to_string(),
        monitor: monitor.as_ref().map(monitor_fingerprint_of).unwrap_or_default(),
        scale,
        updated_at: now_unix_millis(),
    };
    if let Err(error) = island_rect_store::save(&island_rect_store::snapshot_path(), &snapshot) {
        eprintln!("[startup] snapshot save failed: {error}");
        return;
    }
    if let Ok(mut slot) = LAST_PERSISTED_RECT.lock() {
        *slot = Some(rect);
    }
}

fn nearest_monitor_to_rect(app: &AppHandle, x: i32, y: i32) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().min_by_key(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let center_x = position.x + size.width as i32 / 2;
        let center_y = position.y + size.height as i32 / 2;
        (center_x - x).abs() as i64 + (center_y - y).abs() as i64
    })
}

/// 启动时先按磁盘上的最终矩形恢复；指纹还在就逐像素恢复，丢了就夹到最相近的屏。
fn restore_island_rect_on_startup(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let path = island_rect_store::snapshot_path();
    let Some(snapshot) = island_rect_store::load(&path) else {
        eprintln!("STARTUP_RESTORE source=file ok=false reason=missing path={}", path.display());
        return;
    };
    let target = find_monitor_by_key(app, &snapshot.monitor)
        .or_else(|| nearest_monitor_to_rect(app, snapshot.x, snapshot.y));
    let Some(monitor) = target else {
        eprintln!("STARTUP_RESTORE source=file ok=false reason=no_monitor");
        return;
    };
    let scale = monitor.scale_factor().max(0.1);
    let logical_w = snapshot.width as f64 / snapshot.scale.max(0.1);
    let logical_h = snapshot.height as f64 / snapshot.scale.max(0.1);
    let work = monitor.work_area();
    let work_rect = (
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
    );
    let (mut x, mut y) = (snapshot.x, snapshot.y);
    let exact = find_monitor_by_key(app, &snapshot.monitor).is_some();
    if !exact {
        (x, y) = island_rect_store::clamp_to_work_area(
            (snapshot.x, snapshot.y, snapshot.width, snapshot.height),
            work_rect,
        );
        eprintln!(
            "STARTUP_RESTORE_CLAMP from=({},{},{},{}) to=({x},{y}) monitor={}",
            snapshot.x,
            snapshot.y,
            snapshot.width,
            snapshot.height,
            monitor_fingerprint_of(&monitor)
        );
    }
    if let Err(error) = set_window_rect_atomic(&window, x, y, logical_w, logical_h, scale) {
        eprintln!("STARTUP_RESTORE source=file ok=false reason=set_rect: {error}");
        return;
    }
    // 让后续兜底链路（custom_position）也以这份矩形为准。
    mutate_window_state(|state| {
        state.custom_position = Some(IslandPosition { x, y });
        *state
    });
    STARTUP_RESTORED.store(true, Ordering::SeqCst);
    STARTUP_RESTORE_UNTIL_MS.store(now_unix_millis() + 3000, Ordering::SeqCst);
    eprintln!(
        "STARTUP_RESTORE source=file rect=({x},{y},{},{}) monitor={} scale={scale} mode={} ok={}",
        snapshot.width,
        snapshot.height,
        monitor_fingerprint_of(&monitor),
        snapshot.mode,
        exact
    );
    enforce_slot_invariant(
        &window,
        Some(WindowRect {
            x,
            y,
            width: snapshot.width,
            height: snapshot.height,
        }),
        "startup_restore",
    );
}

fn ensure_island_on_screen(window: &WebviewWindow) {
    // 最小化期间 `current_monitor()` / `outer_position()` 都是哨兵值，
    // 一旦在这里判定“跑出工作区”就会清掉 custom_position + 重新 apply_stage_geometry，
    // 于是「最小化一次 → 位置被重置」。最小化/还原过渡期直接跳过。
    if island_geometry_frozen(window) {
        return;
    }
    if startup_restore_active() {
        eprintln!("STARTUP_SKIP_RECALC reason=startup_window");
        return;
    }
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

/// 是否允许这次按下开始一次拖拽。
///
/// 只在「几何已经落定」的收起态允许：缩边 / 唤醒 / 闲逛的位移动画进行中时
/// 窗口坐标是过渡值，这时开始拖拽会把某个动画中间帧当成用户放置位置写进
/// `custom_position`，再通过 `island-position-changed` 持久化到 localStorage。
/// 实机表现就是：锁右下角的小狗睡醒后停在「比锁角基线低 8px」的坐标上，
/// 而且这笔偏移再也回不去（见 docs/bugfix-2026-11-17.md「8px 位移判定」）。
/// 动画只有 320ms，落定后再按一次即可，代价远小于位置被写脏。
fn drag_start_allowed(state: IslandWindowState, animating: bool) -> bool {
    matches!(state.mode, IslandMode::Collapsed)
        && !state.is_tucked
        && !state.is_dragging
        && !animating
}

#[tauri::command]
fn start_island_drag(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    hide_pet_bubble_silent(&app);
    let current_state = read_window_state();
    let animating = POSITION_ANIMATING.load(Ordering::SeqCst);

    if !drag_start_allowed(current_state, animating) {
        return Ok(());
    }

    let position = window.outer_position().map_err(|error| error.to_string())?;
    // 拖拽起点：收尾时只有真的移动过才值得通知前端持久化。
    let drag_origin = position;
    let mut cursor = POINT::default();
    unsafe { GetCursorPos(&mut cursor) }.map_err(|error| error.to_string())?;
    // 记录光标相对窗口左上角的偏移，后面按光标位移手动移动窗口。
    // 不用 window.start_dragging()：那是系统标题栏拖拽，Windows 会阻止窗口
    // 上边缘越过屏幕顶部（下边却允许移出去），所以“往上拖不出去”。
    let grab_offset_x = cursor.x - position.x;
    let grab_offset_y = cursor.y - position.y;
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    mutate_window_state(|state| {
        state.custom_position = Some(IslandPosition {
            x: position.x,
            y: position.y,
        });
        state.is_dragging = true;
        *state
    });

    thread::spawn(move || {
        let mut last = position;
        loop {
            if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0 {
                break;
            }
            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_ok() {
                let target = PhysicalPosition::new(
                    point.x - grab_offset_x,
                    point.y - grab_offset_y,
                );
                if target != last {
                    let _ = window.set_position(Position::Physical(target));
                    last = target;
                }
            }
            thread::sleep(Duration::from_millis(8));
        }
        thread::sleep(Duration::from_millis(8));

        let final_position = window.outer_position().ok().map(|position| IslandPosition {
            x: position.x,
            y: position.y,
        });
        // 浮层打开时窗口矩形是「小狗槽 + 面板」放大后的样子，窗口左上角不再是
        // 小狗位置；这时把 outer_position 当成拖拽结果写进 custom_position，会让
        // 之后每次 apply_stage_geometry 都把小狗摆到错误位置（越开合越偏）。
        // 触摸屏/双击时的抖动也可能在浮层打开的瞬间触发一次拖拽收尾，所以这里
        // 直接丢弃这次拖拽结果，不改 custom_position、也不 emit。
        let overlay_open = overlay_snapshot_active();
        let collapsed = matches!(read_window_state().mode, IslandMode::Collapsed);
        let did_finish_drag = {
            let mut state = window_state().lock().expect("window state poisoned");
            if !state.is_dragging {
                false
            } else {
                state.is_dragging = false;
                if overlay_open || !collapsed {
                    eprintln!("dropped a drag result while an overlay/expanded window was open");
                    false
                } else {
                    if let Some(position) = final_position {
                        state.custom_position = Some(position);
                    }
                    true
                }
            }
        };

        if did_finish_drag {
            // 只有窗口真的被拖动过（松手位置 != 按下位置）才通知前端写 localStorage。
            // 零位移的「按下→松手」不是拖拽，锁角模式下不该用它覆盖角落基线；
            // 这条判据也是「非拖拽路径不写 focusd-island-position」的兜底。
            if let Some(position) = final_position {
                if position != (IslandPosition {
                    x: drag_origin.x,
                    y: drag_origin.y,
                }) {
                    let _ = window.emit("island-position-changed", position);
                }
            }
            // 拖拽只改变位置，不改变层级：松手后重新断言置顶，窗口仍留在最顶层。
            let _ = window.set_always_on_top(true);
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

// 全屏避让等场景需要单独控制「其它小狗」（陪伴狗 / 跟随小狗）的显隐。
// Bongo 走 set_bongo_hidden，两者互不牵连，用户可以让 Bongo 在全屏时留在桌上。
#[tauri::command]
fn set_extra_pets_hidden(app: AppHandle, hidden: bool) {
    if hidden {
        desktop_extras::hide_companion_pets(&app);
    } else {
        desktop_extras::restore_companion_pets(&app);
    }
}

// 全屏时 Bongo 单独一档开关：出现 / 不出现。
#[tauri::command]
fn set_bongo_hidden(app: AppHandle, hidden: bool) {
    if hidden {
        desktop_extras::hide_bongo(&app);
    } else {
        desktop_extras::restore_bongo(&app);
    }
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
// 最近一次展开几何用的面板方向：事后校正「狗槽屏幕坐标」时要用同一套公式。
static LAST_PANEL_SIDE: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
static LAST_PANEL_VERTICAL: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

/// 浮层锚点快照是否已经存在。存在期间窗口几何由浮层独占，
/// `apply_stage_geometry` 一律不插队（否则会把放大后的窗口缩回/挪走）。
fn overlay_snapshot_active() -> bool {
    OVERLAY_SNAPSHOT
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

/// 记录浮层打开前的真实矩形作为锚点，并把窗口真实位置写回 `custom_position`。
///
/// `plan_island_overlay`（前端拿方向去钉小狗）和 `set_island_overlay`（真正改窗口）
/// 都从这里取同一份快照：只要两次计算的锚点/基准尺寸完全相同，小狗就不会朝反方向
/// 闪，关闭时也能原样落回（见 docs/pet-overlay-geometry.md 不变量 2、3）。
fn create_overlay_snapshot(
    window: &tauri::WebviewWindow,
    scale: f64,
) -> Result<OverlaySnapshot, String> {
    // 从这一刻起窗口几何由浮层独占：显式置位，避免 plan → set 之间
    // 闲逛（roam）等路径又把窗口挪走 / 把 custom_position 写成动画终点。
    OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    // 漫游/唤醒的位移动画可能还在跑。先取消，再等它真的停下：
    // 动画中间位置不能当锚点，但也绝不能把窗口“归位”到目标坐标 ——
    // 那一下正是气泡打开时小狗左右闪的根源。
    let was_animating = POSITION_ANIMATING.load(Ordering::SeqCst);
    let was_dx = POSITION_ANIMATION_DELTA_X.load(Ordering::SeqCst);
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_millis(80);
    while POSITION_ANIMATING.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let settled_state = read_window_state();
    // 只有“缩边/趴睡落定”和“纯竖直的唤醒动画”才先落定位置：
    // 横向位移（闲逛）落定会把小狗一下拽到终点，就是那个“向左闪”。
    if settled_state.is_tucked || (was_animating && was_dx.abs() <= 2) {
        let _ = apply_stage_geometry(window, settled_state, false);
    }
    // 锚点一律取窗口当前真实矩形：收缩态里小狗槽就贴在窗口左下角，
    // 窗口左上角 = 小狗的屏幕位置。这样打开浮层只改宽高、不挪窗口。
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let inner = window.inner_size().map_err(|error| error.to_string())?;
    let actual_w = (inner.width as f64 / scale).max(1.0);
    let actual_h = (inner.height as f64 / scale).max(1.0);
    // 真实位置和逻辑位置不一致（漫游动画停在中间、或 custom_position 过期）时
    // 把真实位置写回去，关闭浮层时 apply_stage_geometry 才不会又挪一次。
    // 缩边态下 y 是“缩边后的临时位置”，不能写回 custom_position。
    if !settled_state.is_tucked && (settled_state.custom_position.is_some() || was_animating) {
        mutate_window_state(|state| {
            state.custom_position = Some(IslandPosition {
                x: position.x,
                y: position.y,
            });
            *state
        });
    }
    let snapshot = OverlaySnapshot {
        anchor_x: position.x,
        anchor_y: position.y,
        base_w: actual_w,
        base_h: actual_h,
    };
    if let Ok(mut slot) = OVERLAY_SNAPSHOT.lock() {
        *slot = Some(snapshot);
    }
    Ok(snapshot)
}

// 一次性设置窗口位置和尺寸。
// 分开调用 set_size / set_position 会先后应用两次几何：中间那一帧窗口已经变大、
// 位置还没挪（或反过来），小狗会从正确位置闪到另一侧。
fn set_window_rect_atomic(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    let phys_w = (width * scale).round().max(1.0) as i32;
    let phys_h = (height * scale).round().max(1.0) as i32;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        SetWindowPos(
            HWND(hwnd.0 as *mut _),
            None,
            x,
            y,
            phys_w,
            phys_h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
        .map_err(|error| error.to_string())
    }
}
/// 展开态面板当前是否长在小狗下方。面板在下方时，窗口还要额外容纳
/// 小狗槽 + 间隙，否则面板会被窗口底边裁掉，表现为“向下展开比向上展开矮”。
static PANEL_BELOW: AtomicBool = AtomicBool::new(false);

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
    let overlay_expected_slot = dog_slot_now(&window);
    let overlay_geom_epoch = geometry_authority::begin("set_island_overlay");
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
    // 任务栏避让：面板边界用「显示器 - 任务栏」的 safe rect（自动隐藏浮出时也成立）。
    let safe = safe_rect_for_monitor(&monitor);
    let mon_pos = tauri::PhysicalPosition::new(safe.left, safe.top);
    let mon_size = tauri::PhysicalSize::new(safe.width().max(1) as u32, safe.height().max(1) as u32);
    let mon_left = safe.left;
    let mon_right = safe.right;
    let mon_bottom = safe.bottom;

    let overlay_result: Result<(), String> = match overlay.as_deref() {
        None => {
            OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
            let snapshot = OVERLAY_SNAPSHOT.lock().ok().and_then(|mut slot| slot.take());
            if let Some(snapshot) = snapshot {
                // 浮层打开时窗口向上展开（小狗锚定在底部），收起时连同位置一起恢复，小狗不移动。
                // 尺寸和位置必须一次设置：分两次会出现错位帧，看起来小狗闪一下。
                // 原样恢复小狗槽锚点，不要按展开后的窗口尺寸再 clamp 一次，
                // 否则靠屏幕边缘的小狗每开合一次气泡都会被往内挤一点，越飘越远。
                let _ = set_window_rect_atomic(
                    &window,
                    snapshot.anchor_x,
                    snapshot.anchor_y,
                    snapshot.base_w.max(1.0),
                    snapshot.base_h.max(1.0),
                    scale,
                );
            }
            // 只有浮层期间尺寸设置真的变了才重算几何。否则这里再“套一次”会把窗口
            // 按 custom_position / 居中算法归位，小狗在气泡关掉时会跳一下。
            let state = read_window_state();
            let (stage_w, stage_h) = stage_dimensions(state);
            let base_w = snapshot.map(|snapshot| snapshot.base_w).unwrap_or(stage_w);
            let base_h = snapshot.map(|snapshot| snapshot.base_h).unwrap_or(stage_h);
            if (stage_w - base_w).abs() > 0.5 || (stage_h - base_h).abs() > 0.5 {
                apply_stage_geometry(&window, state, false)?;
            } else if snapshot.is_none() {
                // 兜底：没有快照却比收起态大（上一次浮层请求丢了 / 窗口被别的路径
                // 放大后没回收），按收起态几何收回去，避免「气泡关掉后窗口停在
                // 浮层尺寸、小狗被窗口边裁掉」。
                let actual = window.inner_size().map_err(|error| error.to_string())?;
                let scale_now = window.scale_factor().map_err(|error| error.to_string())?;
                let (stage_w_phys, stage_h_phys) = (
                    (stage_w * scale_now).round() as u32,
                    (stage_h * scale_now).round() as u32,
                );
                if actual.width.abs_diff(stage_w_phys) > 2
                    || actual.height.abs_diff(stage_h_phys) > 2
                {
                    eprintln!(
                        "overlay closed without a snapshot; restoring stage geometry (window {}x{} -> {}x{})",
                        actual.width, actual.height, stage_w_phys, stage_h_phys
                    );
                    apply_stage_geometry(&window, state, false)?;
                }
            }
            eprintln!(
                "overlay closed: restored rect {:?}",
                window
                    .outer_position()
                    .map(|position| (position.x, position.y))
                    .ok()
            );
            Ok(())
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
                // 正常流程里 plan_island_overlay 已经把锚点快照钉下来了
                // （前端先拿方向去钉小狗，再让这里改窗口）。复用同一份快照，
                // 两次计算的方向/位置必然一致，小狗不会朝反方向闪。
                Some(snapshot) => snapshot,
                None => create_overlay_snapshot(&window, scale)?,
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
            // 任务栏浮出时整体上移，保证气泡/面板不被挡住（只平移；高度不够才缩）。
            let (clamped_x, clamped_y, clamped_w, clamped_h) =
                clamp_rect_to_safe(x, y, phys_w, phys_h, safe);
            // B2 排障：浮层打开前后各记一次窗口矩形，便于比对「小狗有没有被挪走」。
            eprintln!(
                "overlay open ({mode}): anchor=({}, {}) base={:.1}x{:.1} side={panel_side} vertical={panel_vertical} -> rect=({clamped_x}, {clamped_y}) {:.1}x{:.1}",
                snapshot.anchor_x, snapshot.anchor_y, snapshot.base_w, snapshot.base_h,
                (clamped_w as f64) / scale, (clamped_h as f64) / scale
            );
            // 移动前预纠正：按计划矩形反推狗槽，若与落定狗槽偏差 >2px，先平移矩形（保持狗槽），
            // 这样用户看到的是「直接到位」，而不是「先移开再被拉回」。
            let mut move_x = clamped_x;
            let mut move_y = clamped_y;
            if let Some(expected) = expected_slot_from_state(&window) {
                // 优先用前端实测的狗偏移：直接把窗口放到「expected - offset」，不靠 panelSide 公式。
                // 只认与本次落位相同的布局态样本（overlay / expanded），collapsed 样本不参与。
                let target_layout_mode = if overlay.is_some() { "overlay" } else { "expanded" };
                let measured = same_mode_measure(target_layout_mode);
                OFFSET_ALREADY_APPLIED.store(false, Ordering::SeqCst);
                if let Some(measure) = measured.clone() {
                    let offset_x = (measure.off_x * scale).round() as i32;
                    let offset_y = (measure.off_y * scale).round() as i32;
                    let wanted_x = expected.x - offset_x;
                    let wanted_y = expected.y - offset_y;
                    if (wanted_x - clamped_x).abs() > 2 || (wanted_y - clamped_y).abs() > 2 {
                        move_x = wanted_x;
                        move_y = wanted_y;
                        OFFSET_ALREADY_APPLIED.store(true, Ordering::SeqCst);
                        eprintln!(
                            "GEOM_DECISION op=set_island_overlay mode={target_layout_mode} offsetSource=same-mode offsetApplied=once planned=({clamped_x},{clamped_y}) final=({move_x},{move_y}) offset=({}, {})",
                            measure.off_x, measure.off_y
                        );
                        if overlay.as_deref() == Some("hover") {
                            eprintln!(
                                "DOUBLECLICK_GEOM phase=move pre_corrected=true source=measured planned=({clamped_x},{clamped_y}) move=({move_x},{move_y}) offset=({}, {})",
                                measure.off_x, measure.off_y
                            );
                        }
                    }
                }
                let planned_slot = geometry_invariant::slot_from_window(
                    geometry_invariant::SlotRect::new(
                        clamped_x,
                        clamped_y,
                        clamped_w,
                        clamped_h,
                    ),
                    panel_side,
                    panel_vertical,
                    (snapshot.base_w * scale).round() as i32,
                    (snapshot.base_h * scale).round() as i32,
                );
                let dx = planned_slot.x - expected.x;
                let dy = planned_slot.y - expected.y;
                if dx.abs() > 2 || dy.abs() > 2 {
                    move_x = clamped_x - dx;
                    move_y = clamped_y - dy;
                    if overlay.as_deref() == Some("hover") {
                        eprintln!(
                            "DOUBLECLICK_GEOM phase=move pre_corrected=true planned=({clamped_x},{clamped_y}) move=({move_x},{move_y}) dx={dx} dy={dy}"
                        );
                    }
                } else if overlay.as_deref() == Some("hover") {
                    eprintln!(
                        "DOUBLECLICK_GEOM phase=move pre_corrected=false move=({move_x},{move_y}) dx={dx} dy={dy}"
                    );
                }
            }
            set_window_rect_atomic(
                &window,
                move_x,
                move_y,
                (clamped_w as f64) / scale,
                (clamped_h as f64) / scale,
                scale,
            )
        }
    };
    // 先放掉浮层请求锁再纠正：set_position 会同步触发窗口事件，持锁调用有死锁风险。
    drop(_request_guard);
    // 双击打开的是 hover 浮层：单独用 doubleclick 记日志/违规，和右键同等待遇。
    let overlay_op = if overlay.as_deref() == Some("hover") {
        "doubleclick"
    } else {
        "set_island_overlay"
    };
    if overlay_op == "doubleclick" {
        let before = overlay_expected_slot;
        let after = dog_slot_now(&window);
        eprintln!(
            "DOUBLECLICK_GEOM before={:?} after={:?} panelSide={:?} panelVertical={:?} dx={} dy={}",
            before.map(|slot| (slot.x, slot.y, slot.width, slot.height)),
            after.map(|slot| (slot.x, slot.y, slot.width, slot.height)),
            LAST_PANEL_SIDE.lock().ok().and_then(|slot| *slot),
            LAST_PANEL_VERTICAL.lock().ok().and_then(|slot| *slot),
            after.map(|slot| before.map(|b| slot.x - b.x).unwrap_or(0)).unwrap_or(0),
            after.map(|slot| before.map(|b| slot.y - b.y).unwrap_or(0)).unwrap_or(0)
        );
    }
    // 不变量强制约束：浮层开合后狗槽必须回到操作前的位置（±2px）。
    enforce_slot_invariant(&window, overlay_expected_slot, overlay_op);
    geometry_authority::commit(
        "set_island_overlay",
        overlay_geom_epoch,
        None,
        geometry_authority::window_rect(&window),
    );
    overlay_result
}

// 只算「面板朝哪边长」，**不改窗口矩形**；但会把浮层锚点快照钉下来，
// 让随后 set_island_overlay 复用同一份输入（否则两侧各读一次窗口，
// 漫游/拖拽未落定时会钉错一侧，小狗闪一下）。
// 前端先问这个，把小狗按正确方向钉住，再让 set_island_overlay 一次性改几何：
// 反过来的话，窗口已经放大而小狗还按上一轮的方向摆，就会往一侧闪一下。
#[tauri::command]
fn plan_island_overlay(app: AppHandle, overlay: String) -> Result<serde_json::Value, String> {
    let window = main_window(&app)?;
    let state = read_window_state();
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
    let safe = safe_rect_for_monitor(&monitor);
    let mon_left = safe.left;
    let mon_right = safe.right;

    // 和 set_island_overlay 用同一份输入：这里就把锚点快照钉下来，随后
    // set_island_overlay 直接复用，不再重新读窗口 —— 两边算出的方向/基准
    // 必然一致，「先钉方向再改几何」才不会钉错一侧（否则小狗会往反方向闪）。
    // 快照存在期间 apply_stage_geometry 一律不插队，也顺手堵住了
    // plan → set 之间被其它 show/设置同步路径重算几何的空档。
    let existing = OVERLAY_SNAPSHOT.lock().ok().and_then(|slot| *slot);
    let snapshot = match existing {
        Some(snapshot) => snapshot,
        None => create_overlay_snapshot(&window, scale)?,
    };
    let (base_w, base_h) = (snapshot.base_w, snapshot.base_h);
    // 与右键完全同源：锚点一律取「最近一次落定 / custom_position」的狗槽，不用窗口临时坐标。
    let settled_anchor = expected_slot_from_state(&window);
    let anchor = settled_anchor
        .map(|slot| IslandPosition { x: slot.x, y: slot.y })
        .unwrap_or(IslandPosition {
            x: snapshot.anchor_x,
            y: snapshot.anchor_y,
        });
    let mut snapshot = snapshot;
    if anchor.x != snapshot.anchor_x || anchor.y != snapshot.anchor_y {
        eprintln!(
            "DOUBLECLICK_GEOM phase=pre source=settled old_anchor=({}, {}) new_anchor=({}, {})",
            snapshot.anchor_x, snapshot.anchor_y, anchor.x, anchor.y
        );
        // 写回快照：set_island_overlay 直接用修正后的锚点，移动前后狗槽不变。
        snapshot.anchor_x = anchor.x;
        snapshot.anchor_y = anchor.y;
        if let Ok(mut slot) = OVERLAY_SNAPSHOT.lock() {
            *slot = Some(snapshot);
        }
    }

    let (panel_w, panel_h): (f64, f64) = match overlay.as_str() {
        "hover" => (320.0, 540.0),
        "menu" => (210.0, 260.0),
        _ => (300.0, 400.0),
    };
    let gap = 8.0;
    let base_w_phys = (base_w * scale).round() as i32;
    let base_h_phys = (base_h * scale).round() as i32;
    let desired_w_phys = ((base_w + gap + panel_w) * scale).round() as i32;
    let side = expanded_panel_side(anchor.x, base_w_phys, desired_w_phys, mon_left, mon_right);
    let vertical = overlay_panel_vertical(
        anchor.y,
        base_h_phys,
        (gap * scale).round() as i32,
        (panel_h * scale).round() as i32,
        safe.top,
        safe.bottom,
    );
    // 计划目标矩形（和 set_island_overlay 同一套公式），仅用于日志/预校验。
    let plan_phys_w = ((base_w + gap + panel_w) * scale).round() as i32;
    let plan_phys_h = ((base_h + gap + panel_h) * scale).round() as i32;
    let plan_x = if side == "left" {
        anchor.x + base_w_phys - plan_phys_w
    } else {
        anchor.x
    };
    let plan_y = if vertical == "above" {
        anchor.y + base_h_phys - plan_phys_h
    } else {
        anchor.y
    };
    eprintln!(
        "overlay plan ({overlay}): side={side} vertical={vertical} anchor=({}, {}) base={base_w:.1}x{base_h:.1}",
        anchor.x, anchor.y
    );
    if overlay == "hover" {
        eprintln!(
            "DOUBLECLICK_GEOM phase=pre source={} target=({plan_x},{plan_y},{plan_phys_w},{plan_phys_h}) slot=({},{}) side={side} vertical={vertical}",
            if settled_anchor.is_some() { "settled" } else { "current-window" },
            anchor.x, anchor.y
        );
    }
    // 真实路径注入：规划阶段就校验一次狗槽不变量（此时窗口还没动，超差说明锚点已算错）。
    let plan_expected = WindowRect {
        x: snapshot.anchor_x,
        y: snapshot.anchor_y,
        width: (base_w * scale).round() as u32,
        height: (base_h * scale).round() as u32,
    };
    let plan_epoch = geometry_authority::begin("plan_island_overlay");
    geometry_authority::commit(
        "plan_island_overlay",
        plan_epoch,
        None,
        geometry_authority::window_rect(&window),
    );
    // 规划期**只计算不落位**：这里只断言/记录，绝不 set_position。
    if let Some(actual) = dog_slot_now(&window) {
        let expected_rect = geometry_invariant::SlotRect::new(
            plan_expected.x,
            plan_expected.y,
            plan_expected.width as i32,
            plan_expected.height as i32,
        );
        let actual_rect = geometry_invariant::SlotRect::new(
            actual.x,
            actual.y,
            actual.width as i32,
            actual.height as i32,
        );
        if let Some(violation) =
            geometry_invariant::assert_slot_invariant(expected_rect, actual_rect, "plan_island_overlay", true)
        {
            eprintln!(
                "GEOM_PLAN_NO_MOVE op=plan_island_overlay dx={} dy={} before=({},{}) after=({},{})",
                violation.dx, violation.dy, expected_rect.x, expected_rect.y, actual_rect.x, actual_rect.y
            );
        }
    }
    if overlay == "hover" {
        let slot = dog_slot_now(&window);
        eprintln!(
            "DOUBLECLICK_GEOM phase=plan anchor=({}, {}) slot={:?} side={side} vertical={vertical}",
            snapshot.anchor_x,
            snapshot.anchor_y,
            slot.map(|current| (current.x, current.y))
        );
    }
    Ok(json!({ "side": side, "vertical": vertical }))
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

// 独立的桌宠设置窗口：简单、浅色、改完即生效。窗口已改成懒创建，
// 第一次打开时才创建 WebView，之后复用。
//
// 必须是 async 命令：Windows 下同步命令是在主线程的 WebView2 消息派发栈里
// 执行的，tauri-runtime-wry 会**就地**创建窗口，而 wry 创建 WebView2 需要
// 嵌套消息泵（`wait_with_pump`）；嵌套在 WebView2 自己的回调里跑，控制器
// 永远初始化不完 —— 表现就是窗口 HWND 已经存在（标题/尺寸都对）但
// `IsWindowVisible=False`、子窗口 `Chrome_WidgetWin_0` 是 0×0，设置打不开。
// async 命令在异步运行时线程上跑，建窗口会排进事件循环，走和启动期
// `tauri.conf.json` 窗口一样的正常创建路径。官方文档（webview_window.rs 的
// Known issues，wry#583）同样要求用 async 命令 / 独立线程创建窗口。
#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    let started = Instant::now();
    let window = window_factory::ensure(&app, "settings")?;
    let already_visible = window.is_visible().unwrap_or(false);
    // 懒创建出来的窗口是 visible(false)：WebView2 子窗口还没挂好时 show() 可能“成功但不可见”。
    // 这里显式 unminimize + show，并用 is_visible() 复核，最多重试 3 次。
    let mut shown = false;
    for attempt in 1..=3 {
        let _ = window.unminimize();
        let _ = window.show();
        std::thread::sleep(std::time::Duration::from_millis(120));
        let visible = window.is_visible().unwrap_or(false);
        let rect = window
            .outer_position()
            .ok()
            .zip(window.outer_size().ok())
            .map(|(position, size)| (position.x, position.y, size.width, size.height));
        eprintln!("SETTINGS_WINDOW_SHOW attempt={attempt} visible={visible} rect={rect:?}");
        if visible {
            shown = true;
            break;
        }
    }
    if !shown {
        eprintln!("SETTINGS_WINDOW_SHOW failed after retries (visible=false)");
    }
    // 焦点失败不影响「窗口已经显示」，不要因此让前端走 fallback。
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus the settings window: {error}");
    }
    // 排障用：创建 → show → 聚焦 的耗时与结果（重复点击时应只剩聚焦）。
    eprintln!(
        "settings window ready in {:?} (created: {}, already visible: {})",
        started.elapsed(),
        !already_visible,
        already_visible
    );
    Ok(())
}

#[tauri::command]
fn show_island_no_focus(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    desktop_extras::restore_extra_pets(&app);
    // 窗口已经显示时不要再套用收起态几何：云朵浮层/面板可能正把窗口放大，
    // 这里再 resize 一次会把刚展开的浮层瞬间缩回去（表现为浮窗出不来、频闪）。
    let visible = window.is_visible().unwrap_or(false);
    if !visible {
        apply_stage_geometry(&window, read_window_state(), false)?;
    }
    window.show().map_err(|error| error.to_string())?;
    ISLAND_SHOWN.store(true, Ordering::SeqCst);
    Ok(())
}

// ---------- 桌宠气泡窗口与内嵌服务窗口 ----------

const BUBBLE_WINDOW_LABEL: &str = "bubble";

// 气泡窗口的内容缓存：窗口冷启动/事件早于监听器注册时，前端可以主动补取。
static BUBBLE_PAYLOAD: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

// 在小狗侧边显示气泡（mode: "hover" 互动面板 / "cloud" 云朵消息框）。
// async：气泡窗口是懒创建的，Windows 下建窗口必须在非主线程发起
// （原因见 `open_settings_window` 的注释）。
#[tauri::command]
async fn show_pet_bubble(
    app: AppHandle,
    mode: String,
    title: Option<String>,
    body: Option<String>,
    ttl_ms: Option<u64>,
) -> Result<(), String> {
    let main = main_window(&app)?;
    let bubble = window_factory::ensure(&app, BUBBLE_WINDOW_LABEL)?;
    // 任务栏（自动隐藏浮出 / 换边）变化时重新夹取气泡位置。
    start_taskbar_watch(app.clone());

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

    place_bubble_near_main(&app, &bubble, &main, desired)?;
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

/// 气泡窗口按内容调整高度后重新贴到小狗侧边（云朵文字长度不固定，固定窗口会截断）。
/// async：同上，气泡窗口可能是第一次创建（懒创建）。
#[tauri::command]
async fn resize_pet_bubble(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let main = main_window(&app)?;
    let bubble = window_factory::ensure(&app, BUBBLE_WINDOW_LABEL)?;
    let width = width.clamp(220.0, 420.0);
    let height = height.clamp(120.0, 640.0);
    place_bubble_near_main(&app, &bubble, &main, LogicalSize::new(width, height))
}

/// 设置气泡尺寸并贴到小狗旁边：优先右侧，放不下翻左侧；上下空间不够就翻面。
fn place_bubble_near_main(
    app: &AppHandle,
    bubble: &tauri::WebviewWindow,
    main: &tauri::WebviewWindow,
    desired: LogicalSize<f64>,
) -> Result<(), String> {
    let _ = app;
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
    // 任务栏（含自动隐藏浮出）可能盖住底部：统一夹进 safe rect。
    let _ = clamp_window_above_taskbar(bubble);
    Ok(())
}

// ---------------------------------------------------------------------------
// 任务栏避让：气泡 / 悬停面板 / 固定页不能被任务栏挡住
// ---------------------------------------------------------------------------
//
// `monitor.work_area()` 只在任务栏**固定显示**时把那条边排除掉；任务栏设成「自动隐藏」
// 时 work_area 是整块屏幕，任务栏浮出就会盖住气泡底部。所以这里用真实的
// SHAppBarMessage(ABM_GETTASKBARPOS) + 副屏 `Shell_SecondaryTrayWnd` 矩形，
// 按「贴哪条边」把显示器可用区削成 safe rect，摆位后统一 clamp。

const TASKBAR_MARGIN: i32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { left, top, right, bottom }
    }

    fn width(self) -> i32 {
        self.right - self.left
    }

    fn height(self) -> i32 {
        self.bottom - self.top
    }

    fn intersect(self, other: Self) -> Option<Self> {
        let rect = Self::new(
            self.left.max(other.left),
            self.top.max(other.top),
            self.right.min(other.right),
            self.bottom.min(other.bottom),
        );
        (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskbarEdge {
    Top,
    Bottom,
    Left,
    Right,
}

/// 任务栏与显示器重叠后贴在哪个边；自动隐藏收起时只剩 2px 细条 → None。
fn taskbar_edge_on_monitor(taskbar: ScreenRect, monitor: ScreenRect) -> Option<TaskbarEdge> {
    let overlap = taskbar.intersect(monitor)?;
    let monitor_width = monitor.width();
    let monitor_height = monitor.height();
    let mut candidates: Vec<(i32, TaskbarEdge)> = Vec::new();
    let mut push = |edge, distance, thickness, span, axis| {
        if thickness >= 12 && span * 10 >= axis * 4 {
            candidates.push((distance, edge));
        }
    };
    push(TaskbarEdge::Top, (taskbar.top - monitor.top).abs(), overlap.height(), overlap.width(), monitor_width);
    push(TaskbarEdge::Bottom, (monitor.bottom - taskbar.bottom).abs(), overlap.height(), overlap.width(), monitor_width);
    push(TaskbarEdge::Left, (taskbar.left - monitor.left).abs(), overlap.width(), overlap.height(), monitor_height);
    push(TaskbarEdge::Right, (monitor.right - taskbar.right).abs(), overlap.width(), overlap.height(), monitor_height);
    candidates.sort_by_key(|(distance, _)| *distance);
    candidates.first().map(|(_, edge)| *edge)
}

/// 气泡可用区 = 显示器 ∩ work_area，再减掉所有贴边任务栏（一侧留 8px）。
fn bubble_safe_rect(monitor: ScreenRect, work: ScreenRect, taskbars: &[ScreenRect]) -> ScreenRect {
    let mut safe = monitor.intersect(work).unwrap_or(monitor);
    for taskbar in taskbars {
        let Some(edge) = taskbar_edge_on_monitor(*taskbar, monitor) else {
            continue;
        };
        let mut next = safe;
        match edge {
            TaskbarEdge::Bottom => next.bottom = next.bottom.min(taskbar.top - TASKBAR_MARGIN),
            TaskbarEdge::Top => next.top = next.top.max(taskbar.bottom + TASKBAR_MARGIN),
            TaskbarEdge::Left => next.left = next.left.max(taskbar.right + TASKBAR_MARGIN),
            TaskbarEdge::Right => next.right = next.right.min(taskbar.left - TASKBAR_MARGIN),
        }
        if next.width() < 160 || next.height() < 120 {
            continue;
        }
        safe = next;
    }
    safe
}

/// 只平移；高度真不够才缩高（宽度保持，避免改变内部布局）。
fn clamp_rect_to_safe(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    safe: ScreenRect,
) -> (i32, i32, i32, i32) {
    let width = width.max(1).min(safe.width());
    let height = height.max(1).min(safe.height());
    let x = x.max(safe.left).min(safe.right - width);
    let y = y.max(safe.top).min(safe.bottom - height);
    (x, y, width, height)
}

fn screen_rect_of_monitor(monitor: &Monitor) -> ScreenRect {
    let position = monitor.position();
    let size = monitor.size();
    ScreenRect::new(
        position.x,
        position.y,
        position.x + size.width as i32,
        position.y + size.height as i32,
    )
}

fn work_rect_of_monitor(monitor: &Monitor) -> ScreenRect {
    let area = monitor.work_area();
    ScreenRect::new(
        area.position.x,
        area.position.y,
        area.position.x + area.size.width as i32,
        area.position.y + area.size.height as i32,
    )
}

/// 当前所有任务栏矩形：主任务栏走 SHAppBarMessage，副屏任务栏枚举 Shell_SecondaryTrayWnd。
fn taskbar_rects() -> Vec<ScreenRect> {
    let mut rects = Vec::new();
    unsafe {
        let mut data: APPBARDATA = std::mem::zeroed();
        data.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        if SHAppBarMessage(ABM_GETTASKBARPOS, &mut data) != 0 {
            let rect = ScreenRect::new(data.rc.left, data.rc.top, data.rc.right, data.rc.bottom);
            if rect.width() > 0 && rect.height() > 0 {
                rects.push(rect);
            }
        }
        let mut window = HWND::default();
        loop {
            window = match FindWindowExW(None, Some(window), w!("Shell_SecondaryTrayWnd"), None) {
                Ok(next) if !next.0.is_null() => next,
                _ => break,
            };
            if !IsWindowVisible(window).as_bool() {
                continue;
            }
            let mut raw = RECT::default();
            if GetWindowRect(window, &mut raw).is_ok() {
                let rect = ScreenRect::new(raw.left, raw.top, raw.right, raw.bottom);
                if rect.width() > 0 && rect.height() > 0 {
                    rects.push(rect);
                }
            }
        }
    }
    rects
}

fn safe_rect_for_monitor(monitor: &Monitor) -> ScreenRect {
    bubble_safe_rect(
        screen_rect_of_monitor(monitor),
        work_rect_of_monitor(monitor),
        &taskbar_rects(),
    )
}

/// 把窗口夹进「任务栏上方」可用区；返回是否动过窗口。
fn clamp_window_above_taskbar(window: &tauri::WebviewWindow) -> bool {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return false;
    };
    let safe = safe_rect_for_monitor(&monitor);
    let (x, y, width, height) = clamp_rect_to_safe(
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
        safe,
    );
    let resized = width != size.width as i32 || height != size.height as i32;
    let moved = x != position.x || y != position.y;
    if resized {
        let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(
            width as u32,
            height as u32,
        )));
    }
    if moved {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }
    if moved || resized {
        eprintln!(
            "[taskbar] clamp {} -> ({x},{y}) {width}x{height} safe=({},{},{},{})",
            window.label(),
            safe.left,
            safe.top,
            safe.right,
            safe.bottom
        );
    }
    moved || resized
}

static TASKBAR_WATCH_STARTED: AtomicBool = AtomicBool::new(false);
/// 主岛当前是否处于展开面板态（watcher 只在展开/浮层时夹取，收起的小狗不跟着动）。
static ISLAND_EXPANDED: AtomicBool = AtomicBool::new(false);

/// 主岛窗口（展开面板/浮层）按任务栏 safe rect 上移；高度真的不够才缩。
fn clamp_island_window_to_taskbar(window: &tauri::WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return (x, y);
    };
    let safe = safe_rect_for_monitor(&monitor);
    let Ok(size) = window.inner_size() else {
        return (x, y);
    };
    let (clamped_x, clamped_y, clamped_w, clamped_h) = clamp_rect_to_safe(
        x,
        y,
        size.width as i32,
        size.height as i32,
        safe,
    );
    if clamped_w != size.width as i32 || clamped_h != size.height as i32 {
        let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(
            clamped_w as u32,
            clamped_h as u32,
        )));
    }
    (clamped_x, clamped_y)
}

/// 任务栏会因「自动隐藏浮出 / 换位置」变化：每 500ms 检查气泡与固定页，
/// 只在越界需要上移时动窗口；任务栏收起后不主动回落（避免来回跳）。
fn start_taskbar_watch(app: AppHandle) {
    if TASKBAR_WATCH_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        for label in [BUBBLE_WINDOW_LABEL, "pinned"] {
            if let Some(window) = app.get_webview_window(label) {
                if window.is_visible().unwrap_or(false) {
                    clamp_window_above_taskbar(&window);
                }
            }
        }
        // 主岛只在「展开面板 / 浮层打开」时跟着上移，收起的小狗不因为任务栏浮出而乱动。
        if ISLAND_EXPANDED.load(Ordering::SeqCst) || OVERLAY_ACTIVE.load(Ordering::SeqCst) {
            if let Some(island) = app.get_webview_window(WINDOW_LABEL) {
                if island.is_visible().unwrap_or(false) {
                    clamp_window_above_taskbar(&island);
                }
            }
        }
    });
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
    // 浮层打开时窗口已经按气泡尺寸放大，再闲逛会让整块面板一起滑走。
    if OVERLAY_ACTIVE.load(Ordering::SeqCst) {
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
    // 锁角要落在「用户指定的屏幕」的对应角上；没指定才用主屏。
    let monitor = preferred_island_monitor(&window)
        .or_else(|| window.primary_monitor().ok().flatten())
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
        enforce_slot_invariant(
            &window,
            Some(WindowRect {
                x,
                y,
                width: slot_width as u32,
                height: slot_height as u32,
            }),
            "lock_island_corner",
        );
        geometry_authority::record("lock_island_corner", None, geometry_authority::window_rect(&window));
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
    // frontend_ready 握手已经显示过时，兜底调用直接成功返回，避免重复 set_focus
    // 把用户刚切到的其它窗口抢回来。
    if ISLAND_SHOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    show_island(&app)?;
    // 把「命令返回成功」定义成「窗口确实可见」：前端只在返回成功且 isVisible()
    // 为真时才认为首帧显示完成，否则会按退避重试。
    let window = main_window(&app)?;
    if window.is_visible().unwrap_or(true) {
        Ok(())
    } else {
        Err("island window reported hidden right after show".to_string())
    }
}

/// 前端首帧（含桌宠 GIF 解码）就绪后主动通知 Rust，由 Rust 再做几何 + show。
/// 这条链路不等待 `set_island_interaction`，避免同步 IPC 慢/失败时窗口一直不显示；
/// `show_ready_island` 仍保留为兜底。
#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let first_ready = FRONTEND_READY_AT.set(Instant::now()).is_ok();
    if first_ready {
        eprintln!("frontend reported first paint ready");
        startup_mark("frontend_ready");
        // 首帧后心跳：卡死时看停在第几拍，区分「首帧前」还是「首帧后」卡死。
        tauri::async_runtime::spawn_blocking(|| {
            for (delay_seconds, label) in [(1u64, "+1s"), (2u64, "+3s"), (7u64, "+10s")] {
                std::thread::sleep(std::time::Duration::from_secs(delay_seconds));
                eprintln!("[startup] heartbeat frontend_ready{label} tick");
            }
        });
    }
    if ISLAND_SHOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    show_island(&app)
}

/// 读取自启项里登记的命令行（只取 REG_SZ 后面的值，去掉引号）。
fn startup_registered_command() -> Option<String> {
    let output = Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", STARTUP_REGISTRY_KEY, "/v", STARTUP_REGISTRY_VALUE])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains(STARTUP_REGISTRY_VALUE) {
            continue;
        }
        let Some((_, value)) = line.split_once("REG_SZ") else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// 旧便携版可能把自启项写成 `E:\...\release\maltese-assistant.exe`，
/// 升级到安装目录或者删掉旧文件之后，开机就会去拉起一个不存在 / 旧版本的 exe，
/// 表现成“自启动失败”。每次启动时如果登记路径不是当前 exe，就顺手改写。
fn sync_startup_path() {
    let Ok(current) = std::env::current_exe() else {
        return;
    };
    let Some(registered) = startup_registered_command() else {
        return; // 没开自启，不动它
    };
    let current_text = current.display().to_string();
    if registered.eq_ignore_ascii_case(&current_text) {
        return;
    }
    let _ = set_launch_at_startup(true);
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

/// 启动用户脚本：开一个新的控制台窗口，和资源管理器里双击一致。
///
/// 之前脚本走 `spawn_detached`（`CREATE_NO_WINDOW` + 继承父进程 stdio），
/// 而主程序是 windows 子系统、没有控制台：脚本虽然跑了，但输出无处可去，
/// `pause` / `Read-Host` 拿不到输入，用户看到的就是「点了没反应」。
/// 用 ShellExecuteW 打开一个控制台程序，等价于资源管理器里双击该程序。
///
/// 为什么不直接 `Command::spawn`：主程序是 windows 子系统、没有控制台，
/// Rust 的 `Command` 会把父进程的标准句柄塞进 `STARTF_USESTDHANDLES`，
/// 子进程于是「有个空窗口或干脆没有窗口」——`echo` 看不到、`pause` / `Read-Host`
/// 立即 EOF，用户看到的就是「点了没反应」。
/// ShellExecuteW 由系统负责给控制台程序创建带正确句柄的新窗口，这里实测：
/// 脚本内 `[Console]::WindowWidth` 能读到 120，`IsOutputRedirected=False`。
fn shell_execute_program(
    program: &str,
    parameters: &str,
    directory: Option<&Path>,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let wide = |value: &str| -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let operation = wide("open");
    let file = wide(program);
    let params = wide(parameters);
    let workdir: Vec<u16> = directory
        .map(|path| path.as_os_str().encode_wide().chain(std::iter::once(0)).collect())
        .unwrap_or_else(|| vec![0]);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params.as_ptr()),
            PCWSTR(workdir.as_ptr()),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(format!("无法启动 {program}（ShellExecute 返回 {}）", result.0 as isize));
    }
    Ok(())
}

// 「和小狗打台球」：开一个覆盖桌面工作区的透明窗口（不移动真实图标）。
// async：台球窗口是懒创建的（原因见 `open_settings_window` 的注释）。
#[tauri::command]
async fn open_billiards_window(app: AppHandle) -> Result<(), String> {
    let window = window_factory::ensure(&app, "billiards")?;
    // 铺满主显示器的工作区（避开任务栏）。
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let _ = window.set_position(tauri::PhysicalPosition::new(area.position.x, area.position.y));
        let _ = window.set_size(tauri::PhysicalSize::new(area.size.width, area.size.height));
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.emit("maltese-billiards-start", serde_json::json!({}));
    Ok(())
}

// 「固定标签页在桌面」：把当前标签页放到一个独立的置顶窗口里。
// async：固定窗口是懒创建的（原因见 `open_settings_window` 的注释）。
//
// 用户反馈「置于顶层的按钮失效」：这里补了三件事——
// 1) 记录「要固定的页面」，置顶窗口前端挂载后主动来读（否则首次固定时
//    `maltese-pinned-page` 事件早于新窗口 listen，页面永远退回默认「聊天」）；
// 2) 窗口已存在但被最小化/隐藏时先 `unminimize()` 再 `show()`，否则点按钮没反应；
// 3) `set_always_on_top(true)` 放在 show 之后再做一次，保证重新固定后仍然置顶。
static PINNED_PAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// 用户拖动过 pinned 窗口后的物理坐标（切屏时夹进目标屏，不丢位置）。
static PINNED_MANUAL_POSITION: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
/// 我们自己在摆放 pinned 窗口时置位，避免把程序位移记成「用户拖动」。
static PINNED_AUTO_POSITIONING: AtomicBool = AtomicBool::new(false);
/// 最近一次由程序写入的坐标：`Moved` 收到同一个坐标说明是程序位移，不算用户拖动。
static PINNED_LAST_SET: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
/// pinned 默认逻辑尺寸（与 window_factory 的 420×560 一致，用于按目标屏 scale 换算物理尺寸）。
const PINNED_LOGICAL_WIDTH: f64 = 420.0;
const PINNED_LOGICAL_HEIGHT: f64 = 560.0;
/// pinned 默认贴边距（目标屏右下角，与建议的 24px 一致）。
const PINNED_MARGIN: i32 = 24;

/// pinned 默认位置：目标屏工作区右下角，留 `margin` 边距。
fn pinned_anchor(work: (i32, i32, u32, u32), size: (u32, u32), margin: i32) -> (i32, i32) {
    let (left, top, width, height) = work;
    let margin = margin.max(0);
    let x = left + width as i32 - size.0 as i32 - margin;
    let y = top + height as i32 - size.1 as i32 - margin;
    (x.max(left), y.max(top))
}

/// 把坐标夹进工作区（换屏后旧位置可能属于另一个屏，不能把它留在屏外）。
fn clamp_to_work_area(
    position: (i32, i32),
    size: (u32, u32),
    work: (i32, i32, u32, u32),
) -> (i32, i32) {
    let (left, top, width, height) = work;
    let max_x = left + width as i32 - size.0 as i32;
    let max_y = top + height as i32 - size.1 as i32;
    (
        position.0.clamp(left, max_x.max(left)),
        position.1.clamp(top, max_y.max(top)),
    )
}

/// 目标屏工作区（物理像素）。跟随主岛同一份「小狗屏幕」偏好；匹配不到回主屏。
fn pinned_target_monitor(app: &AppHandle) -> Option<(Monitor, (i32, i32, u32, u32), f64)> {
    let preferred = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    let monitor = preferred
        .as_deref()
        .and_then(|key| find_monitor_by_key(app, key))
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some((
        monitor.clone(),
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
        monitor.scale_factor(),
    ))
}

/// 把 pinned 窗口从任务栏 / Alt+Tab 里摘掉：`WS_EX_TOOLWINDOW` 打开、`WS_EX_APPWINDOW` 关掉。
/// 幂等；失败只记日志（窗口样式不影响窗口本身可用）。
fn apply_pinned_taskbar_style(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let handle = HWND(hwnd.0);
        let before = GetWindowLongPtrW(handle, GWL_EXSTYLE);
        let next = (before | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
        if next != before {
            SetWindowLongPtrW(handle, GWL_EXSTYLE, next);
        }
        let after = GetWindowLongPtrW(handle, GWL_EXSTYLE);
        eprintln!(
            "[monitor] pinned ex-style 0x{before:X} -> 0x{after:X} (TOOLWINDOW={}, APPWINDOW={})",
            after & WS_EX_TOOLWINDOW.0 as isize != 0,
            after & WS_EX_APPWINDOW.0 as isize != 0
        );
    }
}

/// 把 pinned 窗口摆到「小狗所在屏」：右下角 24px，或沿用用户拖动过的位置（夹进该屏）。
/// 尺寸按**目标屏自己的 scale_factor** 从逻辑尺寸换算，150% 副屏也不会错位。
fn place_pinned_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("pinned") else {
        return Ok(());
    };
    let preferred_key = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    let Some((_monitor, work, scale)) = pinned_target_monitor(app) else {
        return Ok(());
    };
    // 用户可能手动缩放过：先用当前屏 scale 把物理尺寸换成逻辑尺寸，再按目标屏 scale 还原。
    let current_scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let current = window.outer_size().ok();
    let logical_w = current
        .map(|size| size.width as f64 / current_scale)
        .filter(|value| *value > 1.0)
        .unwrap_or(PINNED_LOGICAL_WIDTH);
    let logical_h = current
        .map(|size| size.height as f64 / current_scale)
        .filter(|value| *value > 1.0)
        .unwrap_or(PINNED_LOGICAL_HEIGHT);
    let physical = (
        (logical_w * scale).round().max(1.0) as u32,
        (logical_h * scale).round().max(1.0) as u32,
    );
    if current != Some(tauri::PhysicalSize::new(physical.0, physical.1)) {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            physical.0, physical.1,
        )));
    }
    let manual = PINNED_MANUAL_POSITION.lock().ok().and_then(|slot| *slot);
    let position = match manual {
        // 拖动过的窗口：换屏时夹进目标屏工作区，尽量保留相对位置。
        Some(position) => clamp_to_work_area(position, physical, work),
        None => pinned_anchor(work, physical, (PINNED_MARGIN as f64 * scale).round() as i32),
    };
    PINNED_AUTO_POSITIONING.store(true, Ordering::SeqCst);
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        position.0, position.1,
    )));
    if let Ok(mut slot) = PINNED_LAST_SET.lock() {
        *slot = Some(position);
    }
    PINNED_AUTO_POSITIONING.store(false, Ordering::SeqCst);
    // 任务栏（含自动隐藏浮出）会盖住底部：固定页也夹进 safe rect。
    let _ = clamp_window_above_taskbar(&window);
    if manual.is_some() {
        if let Ok(mut slot) = PINNED_MANUAL_POSITION.lock() {
            *slot = Some(position);
        }
    }
    eprintln!(
        "[monitor] pinned placed at ({}, {}) on {} (scale {:.2}, manual={})",
        position.0,
        position.1,
        preferred_key.as_deref().unwrap_or("primary"),
        scale,
        manual.is_some()
    );
    Ok(())
}

#[tauri::command]
async fn pin_page_to_desktop(app: AppHandle, page: String) -> Result<(), String> {
    if let Ok(mut current) = PINNED_PAGE.lock() {
        *current = Some(page.clone());
    }
    let window = window_factory::ensure(&app, "pinned")?;
    // 固定页也要避开任务栏；同一个 watcher 管气泡和固定页。
    start_taskbar_watch(app.clone());
    // 跟随「小狗屏幕」：右下角 24px（或夹取用户拖动过的位置），尺寸按目标屏 scale 换算。
    if let Err(error) = place_pinned_window(&app) {
        eprintln!("failed to place pinned window: {error}");
    }
    let _ = window.unminimize();
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_always_on_top(true);
    // 任务栏灰框（用户反馈 P1）：无边框透明窗口会以 WS_EX_APPWINDOW 出现在任务栏，
    // 渲染成一个没标题/没图标的灰块。`skip_taskbar` 在创建时生效，但 Windows 在窗口
    // 第一次 show 之后可能重新加上 APPWINDOW，所以这里在 show / 置顶之后再强制一次：
    // 打 WS_EX_TOOLWINDOW、去掉 WS_EX_APPWINDOW（同时移出 Alt+Tab 列表）。
    apply_pinned_taskbar_style(&window);
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.emit(
        "maltese-pinned-page",
        serde_json::json!({ "page": page }),
    );
    Ok(())
}

/// 置顶窗口前端挂载后读一次「当前要固定的页面」。
#[tauri::command]
fn get_pinned_page() -> Option<String> {
    PINNED_PAGE.lock().ok().and_then(|page| page.clone())
}

#[tauri::command]
fn unpin_page_from_desktop(app: AppHandle) -> Result<(), String> {
    if let Ok(mut current) = PINNED_PAGE.lock() {
        *current = None;
    }
    if let Some(window) = app.get_webview_window("pinned") {
        let _ = window.hide();
    }
    let _ = app.emit("maltese-unpinned-page", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
fn close_billiards_window(app: AppHandle) -> Result<(), String> {
    // 退出台球一定要把真实桌面图标放回去。
    let _ = desktop_icons::desktop_icons_restore();
    if let Some(window) = app.get_webview_window("billiards") {
        let _ = window.hide();
    }
    Ok(())
}

/// 快捷方式路径检查：告诉前端「文件在不在 / 是文件还是文件夹」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathCheckResult {
    exists: bool,
    is_file: bool,
    is_dir: bool,
    error: Option<String>,
}

/// 桌宠素材外置后的真实目录：`<resource_dir>/assets/pets`。
/// 开发态（tauri dev）资源不存在时返回空串，前端退回 `/assets/pets/...`。
#[tauri::command]
fn get_pet_asset_base(app: AppHandle) -> String {
    use tauri::Manager;
    // 不同安装方式下素材落点不一样（NSIS 会放到 resources/，绿色版可能直接跟在 exe 旁边），
    // 这里按可能性依次探测，避免「升级后小狗变空白」。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("assets").join("pets"));
        candidates.push(dir.join("resources").join("assets").join("pets"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("assets").join("pets"));
            candidates.push(dir.join("resources").join("assets").join("pets"));
        }
    }
    for pets in candidates {
        if pets.exists() {
            return pets.display().to_string();
        }
    }
    String::new()
}

#[tauri::command]
fn check_local_path(path: String) -> PathCheckResult {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return PathCheckResult {
            exists: false,
            is_file: false,
            is_dir: false,
            error: Some("路径为空".to_string()),
        };
    }
    let candidate = PathBuf::from(trimmed);
    match std::fs::metadata(&candidate) {
        Ok(metadata) => PathCheckResult {
            exists: true,
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            error: None,
        },
        Err(error) => PathCheckResult {
            exists: false,
            is_file: false,
            is_dir: false,
            error: Some(error.to_string()),
        },
    }
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

#[derive(Serialize, Clone)]
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
async fn discover_shortcuts(scan_dir: Option<String>) -> Result<Vec<DiscoveredShortcut>, String> {
    scan_shortcuts(shortcut_scan_roots(scan_dir.as_deref()), None, 240)
}

// 应用清单缓存：以前每敲一个字就重新扫一遍开始菜单 + 起一个 PowerShell，
// 这是快捷方式搜索卡顿的主要原因。现在全量清单缓存 10 分钟，搜索只做内存过滤。
static INSTALLED_APPS_CACHE: Mutex<Option<(std::time::Instant, Vec<DiscoveredShortcut>)>> =
    Mutex::new(None);
static START_APPS_CACHE: Mutex<Option<(std::time::Instant, Vec<StartApp>)>> = Mutex::new(None);
const APP_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

fn filter_discovered(
    items: Vec<DiscoveredShortcut>,
    query: Option<&str>,
    limit: usize,
) -> Vec<DiscoveredShortcut> {
    let needle = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    items
        .into_iter()
        .filter(|item| {
            needle
                .as_ref()
                .map(|value| item.label.to_lowercase().contains(value))
                .unwrap_or(true)
        })
        .take(limit)
        .collect()
}

#[tauri::command]
async fn discover_installed_apps(query: Option<String>) -> Result<Vec<DiscoveredShortcut>, String> {
    // 系统开始菜单/桌面里的入口就是 Windows 识别并展示的应用；
    // 搜索只在这个范围内进行，不扫描磁盘。
    let cached = INSTALLED_APPS_CACHE.lock().ok().and_then(|slot| {
        slot.as_ref().and_then(|(at, items)| {
            if at.elapsed() < APP_CACHE_TTL {
                Some(items.clone())
            } else {
                None
            }
        })
    });
    let all = match cached {
        Some(items) => items,
        None => {
            let items = scan_shortcuts(system_app_roots(), None, 4000)?;
            if let Ok(mut slot) = INSTALLED_APPS_CACHE.lock() {
                *slot = Some((std::time::Instant::now(), items.clone()));
            }
            items
        }
    };
    Ok(filter_discovered(all, query.as_deref(), 60))
}

#[derive(Serialize, Clone)]
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
async fn discover_start_apps(query: Option<String>) -> Result<Vec<StartApp>, String> {
    let cached = START_APPS_CACHE.lock().ok().and_then(|slot| {
        slot.as_ref().and_then(|(at, items)| {
            if at.elapsed() < APP_CACHE_TTL {
                Some(items.clone())
            } else {
                None
            }
        })
    });
    let all = match cached {
        Some(items) => items,
        None => {
            let items = load_start_apps()?;
            if let Ok(mut slot) = START_APPS_CACHE.lock() {
                *slot = Some((std::time::Instant::now(), items.clone()));
            }
            items
        }
    };
    let needle = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    Ok(all
        .into_iter()
        .filter(|app| {
            needle
                .as_ref()
                .map(|value| app.label.to_lowercase().contains(value))
                .unwrap_or(true)
        })
        .take(60)
        .collect())
}

/// 真正去读 Get-StartApps（带缓存的 discover_start_apps 只在 miss 时调用）。
fn load_start_apps() -> Result<Vec<StartApp>, String> {
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
        apps.push(StartApp { label, app_id });
    }
    Ok(apps)
}

/// 启动 shell:AppsFolder 里的应用（Store / MSIX 应用都走这里）。
#[tauri::command]
async fn launch_start_app(app_id: String) -> Result<(), String> {
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
    let normalized_path = normalize_shell_execute_path(path);
    let wide: Vec<u16> = normalized_path
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

/// ShellExecuteW 对 Win32 扩展路径前缀（`\\?\`）兼容性很差：
/// canonicalize() 在 Windows 上经常返回这种前缀，资源管理器却要求普通路径。
/// UNC 路径要保留双反斜杠，盘符路径则直接去掉前缀。
fn normalize_shell_execute_path(path: &Path) -> PathBuf {
    let Some(value) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn launch_canonical_path(canonical_path: &Path) -> Result<(), String> {
    let extension = canonical_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "ps1" | "py" | "bat" | "cmd" => launch_script(canonical_path, &extension),
        // .lnk / .url / .exe 等资源管理器入口交给 ShellExecute。
        _ => shell_execute(canonical_path),
    }
}

/// 用脚本自己的目录作为工作目录启动脚本。
///
/// `canonicalize()` 在 Windows 上可能返回 `\\?\` 扩展路径前缀，
/// PowerShell、Python 启动器和 cmd 对这种前缀的兼容性并不一致，
/// 所以脚本执行也和 ShellExecute 一样先还原成普通 Win32 路径。
fn launch_script(path: &Path, extension: &str) -> Result<(), String> {
    let normalized_path = normalize_shell_execute_path(path);
    let working_directory = normalized_path.parent();
    // 脚本都按「双击」语义启动：系统负责开一个带正确标准句柄的控制台窗口，
    // 这样 echo / 报错 / pause / Read-Host 都正常，用户也能看到确实跑了。
    let quoted = format!("\"{}\"", normalized_path.display());
    match extension {
        "ps1" => shell_execute_program(
            "powershell.exe",
            &format!("-NoProfile -ExecutionPolicy Bypass -File {quoted}"),
            working_directory,
        )
        .or_else(|_| shell_execute(&normalized_path)),
        "py" => {
            // 有 Python Launcher 用 py.exe，否则退回 python.exe。
            shell_execute_program("py.exe", &quoted, working_directory)
                .or_else(|_| shell_execute_program("python.exe", &quoted, working_directory))
                .or_else(|_| shell_execute(&normalized_path))
        }
        "bat" | "cmd" => {
            // cmd.exe 在 /c 之后保持脚本自己的工作目录，窗口由系统创建。
            shell_execute_program(
                "cmd.exe",
                &format!("/d /c call {quoted}"),
                working_directory,
            )
            .or_else(|_| shell_execute(&normalized_path))
        }
        _ => Err("不支持的脚本类型。".to_string()),
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
async fn launch_custom_shortcut(path: String) -> Result<(), String> {
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
        "ps1" | "py" | "bat" | "cmd" => launch_script(&canonical_path, &extension),
        "lnk" => shell_execute(&canonical_path),
        _ => Err("不支持的脚本类型。".to_string()),
    }
}

#[tauri::command]
async fn launch_tool(tool: String) -> Result<(), String> {
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


/// 数据目录信息（设置页只读展示）。
#[tauri::command]
fn data_directory_info() -> serde_json::Value {
    serde_json::json!({
        "root": crate::paths::data_root(),
        "legacyRoot": crate::paths::legacy_root(),
        "webviewProfile": crate::paths::webview_profile_dir(),
    })
}

/// 在资源管理器里打开数据目录。
#[tauri::command]
fn open_data_directory() -> Result<(), String> {
    let root = crate::paths::data_root();
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    std::process::Command::new("explorer")
        .arg(root)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn read_agent_status(app: AppHandle) -> Result<AgentStatusSnapshot, String> {
    let app_dir = crate::paths::data_root();
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
    let app_dir = crate::paths::data_root();
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
    let app_dir = crate::paths::data_root();
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
    // 最小化态要先还原并复位「最小化前矩形」，再谈几何：否则下面的
    // apply_stage_geometry 会读到哨兵坐标，把还原位置写坏（最小化漂移）。
    if window.is_minimized().unwrap_or(false) || ISLAND_MINIMIZED.load(Ordering::SeqCst) {
        let _ = window.unminimize();
        restore_island_rect_after_unminimize(&window);
    }
    // 已经显示时不要再套一次收起态几何：浮层/展开面板可能正把窗口放大，
    // 重算会把小狗挪走（和 show_island_no_focus 的写法保持一致）。
    // c327044 之后 show 链路变多（frontend_ready 握手 + show_ready_island 兜底 +
    // 第二实例唤起），旧写法每次都要重算几何，浮层打开时就会被拽走。
    let already_visible = window.is_visible().unwrap_or(false);
    if !already_visible {
        // 几何计算依赖 webview 的同步消息（inner_size / monitor / position）。
        // dev 下 webview 还没握手完成时这些调用会失败，旧写法直接把错误
        // 冒泡出去，后面的 window.show() 就永远执行不到，表现为「初始化卡住、
        // 桌宠一直不出现」。这里把几何失败降级成日志，保证窗口一定能显示，
        // 随后前端 set_island_layout 会再触发一次几何同步。
        if let Err(error) = apply_stage_geometry(&window, read_window_state(), false) {
            eprintln!("failed to apply island geometry when showing: {error}");
        }
    }
    // 从托盘 / 第二实例唤起时窗口可能是最小化状态，先还原再 show。
    let _ = window.unminimize();
    window.show().map_err(|error| error.to_string())?;
    ISLAND_SHOWN.store(true, Ordering::SeqCst);
    // 置顶是层级属性，与位置无关：重新显示后再断言一次，避免被其它窗口压到下面。
    let _ = window.set_always_on_top(true);
    // 焦点失败不算显示失败：窗口已经 show 出来了，没必要让前端重试整个流程。
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus island window after showing: {error}");
    }
    // P0：show 可能被系统窗口状态竞争吞掉；显示后再校验一次可见性，
    // 不可见就在后台补几次 show()，避免「进程活着但永远没有狗」。
    geometry_authority::record("show_island", None, geometry_authority::window_rect(&window));
    ensure_island_visible_after_show(window.clone());
    enforce_slot_invariant(&window, expected_slot_from_state(&window), "show_island");
    // 隐藏时一起收起的 Bongo / 陪伴狗 / 跟随小狗，显示时一并放回来。
    desktop_extras::restore_extra_pets(app);
    Ok(())
}

/// show() 之后校验可见性：不可见时在后台有限次重试显示。
/// 不阻塞调用线程（命令线程可能是主线程），也绝不止步于一次失败。
fn ensure_island_visible_after_show(window: WebviewWindow) {
    if window.is_visible().unwrap_or(true) {
        return;
    }
    if thread::Builder::new()
        .name("island-visibility-retry".into())
        .spawn(move || {
            for attempt in 1..=ISLAND_VISIBILITY_ATTEMPTS {
                thread::sleep(ISLAND_VISIBILITY_RETRY_DELAY);
                if window.show().is_ok() {
                    let _ = window.set_always_on_top(true);
                }
                if window.is_visible().unwrap_or(false) {
                    eprintln!("island window became visible after {attempt} retry attempts");
                    return;
                }
            }
            eprintln!(
                "island window is still hidden after {ISLAND_VISIBILITY_ATTEMPTS} visibility retries"
            );
        })
        .is_err()
    {
        eprintln!("failed to spawn island visibility retry thread");
    }
}

fn hide_island(app: &AppHandle) {
    POSITION_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst);
    ISLAND_SHOWN.store(false, Ordering::SeqCst);
    hide_pet_bubble_silent(app);
    if let Ok(window) = main_window(app) {
        let _ = window.hide();
    }
    // 快捷键/托盘隐藏桌宠时，桌上其它小狗也要消失，否则会留下 Bongo 孤零零趴在桌上。
    desktop_extras::hide_extra_pets(app);
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
    // 最小化 / 还原过渡期间：读到的位置尺寸都是哨兵值，任何 set_size/set_position
    // 都会把系统记录的「还原位置」改掉 → 最小化回来位置就变了。这里直接冻结。
    if island_geometry_frozen(window) {
        return Ok(());
    }
    // 浮层打开期间窗口尺寸/位置由 set_island_overlay 独占管理，
    // 其他调用（设置同步、显示窗口等）不要插队把窗口缩回去。
    if OVERLAY_SNAPSHOT
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
    {
        return Ok(());
    }
    // 启动恢复的 3s 窗口内，收起态几何不允许被前端 syncNativeInteraction 重算覆盖，
    // 否则「刚恢复对的矩形」会被默认锚点再算一遍（P0 启动位置不对的直接原因）。
    if matches!(state.mode, IslandMode::Collapsed) && startup_restore_active() {
        eprintln!("STARTUP_SKIP_RECALC reason=startup_window");
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
    // 拖到屏幕边缘外时，小狗槽中心可能已经不在任何显示器范围内；
    // 这时退回当前/主显示器，而不是当成“没有自定义位置”把坐标夹回工作区，
    // 否则表现为「可以往下拖出屏幕，却拖不出上边」。
    let custom_monitor = state.custom_position.and_then(|position| {
        monitor_for_island_position(window, position, state.collapsed_scale)
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten())
    });
    // 多屏放置：用户指定了「小狗屏幕」时，锚点、锁角、工作区裁剪全按那块屏算；
    // 指纹匹配不到（副屏被拔/改分辨率到认不出）→ 回主屏并按需提示，但保留偏好等它插回来。
    let preferred_pref = ISLAND_MONITOR_PREF.lock().ok().and_then(|slot| slot.clone());
    let preferred_monitor = preferred_pref
        .as_deref()
        .and_then(|key| find_monitor_by_key(window.app_handle(), key));
    if preferred_pref.is_some() && preferred_monitor.is_none() {
        let already = MONITOR_MISSING_NOTIFIED.lock().ok().and_then(|slot| slot.clone());
        if already.as_deref() != preferred_pref.as_deref() {
            if let Ok(mut guard) = MONITOR_MISSING_NOTIFIED.lock() {
                *guard = preferred_pref.clone();
            }
            eprintln!(
                "[monitor] preferred monitor missing ({}), falling back to primary",
                preferred_pref.as_deref().unwrap_or("?")
            );
            // 副屏没了：旧坐标属于那块屏，必须丢掉，否则狗会停在「已经不存在的屏」的坐标上。
            let fallback_state = mutate_window_state(|state| {
                state.custom_position = None;
                *state
            });
            let _ = window.emit(
                "maltese-monitor-missing",
                json!({ "message": "副屏已断开，已回到主屏", "key": preferred_pref }),
            );
            // 云朵气泡会占用 overlay 快照，几何会被 apply_stage_geometry 的 overlay 分支挡掉；
            // 气泡收起前反复重试（幂等；start==target 时直接返回），保证一定回到主屏工作区。
            if let Some(window) = window.app_handle().get_webview_window(WINDOW_LABEL) {
                // pinned 窗口也跟着回主屏（它不在主岛几何链路里）。
                let _ = place_pinned_window(window.app_handle());
                let app_handle = window.app_handle().clone();
                thread::spawn(move || {
                    for _ in 0..10 {
                        thread::sleep(Duration::from_millis(800));
                        if let Err(error) = apply_stage_geometry(&window, fallback_state, false) {
                            eprintln!("failed to fall back to primary monitor: {error}");
                        }
                        let _ = place_pinned_window(&app_handle);
                    }
                });
            }
        }
    }
    let has_custom_monitor = preferred_monitor.is_some() || custom_monitor.is_some();
    let has_preferred_monitor = preferred_monitor.is_some();
    let monitor = preferred_monitor
        .or(custom_monitor)
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
    // 指定了屏幕时，旧坐标可能属于旧屏：同样夹进目标屏工作区（否则切屏后狗还留在原屏）。
    if !has_custom_monitor || has_preferred_monitor {
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
    // 任务栏避让：展开/浮层用的边界是「显示器 - 任务栏」的 safe rect。
    let safe = safe_rect_for_monitor(&monitor);
    let work_left = safe.left;
    let work_top = safe.top;
    let work_right = safe.right;
    let work_bottom = safe.bottom;
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
            // 面板翻到下方时窗口要额外装下小狗槽和间隙；重新按方向取一次尺寸。
            PANEL_BELOW.store(panel_vertical == "below", Ordering::Relaxed);
            let (_, stage_height) = stage_dimensions(state);
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
            if let Ok(mut slot) = LAST_PANEL_SIDE.lock() {
                *slot = Some(panel_side);
            }
            if let Ok(mut slot) = LAST_PANEL_VERTICAL.lock() {
                *slot = Some(panel_vertical);
            }
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
    ISLAND_EXPANDED.store(matches!(state.mode, IslandMode::Expanded), Ordering::SeqCst);
    // 展开态 / 浮层打开时，任务栏浮出会把窗口底部盖住：整体上移（高度不够才缩）。
    let (x, y) = if matches!(state.mode, IslandMode::Expanded) || overlay_snapshot_active() {
        clamp_island_window_to_taskbar(window, x, y)
    } else {
        (x, y)
    };

    let target = PhysicalPosition::new(x, y);
    if reject_zero_position(window, target.x, target.y, "stage_geometry") {
        return Ok(());
    }
    let start = window.outer_position().map_err(|error| error.to_string())?;
    if start == target {
        remember_settled_island_rect(window);
        return Ok(());
    }
    if !animate_position {
        let result = window
            .set_position(Position::Physical(target))
            .map_err(|error| error.to_string());
        remember_settled_island_rect(window);
        return result;
    }

    let window = window.clone();
    POSITION_ANIMATION_DELTA_X.store(target.x - start.x, Ordering::SeqCst);
    POSITION_ANIMATING.store(true, Ordering::SeqCst);
    thread::spawn(move || {
        let started_at = Instant::now();
        loop {
            if POSITION_ANIMATION_GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            // 最小化期间写位置会污染系统的还原位置（最小化漂移），立刻停下。
            if window.is_minimized().unwrap_or(false) {
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
        POSITION_ANIMATING.store(false, Ordering::SeqCst);
        remember_settled_island_rect(&window);
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
    // 边界用**狗所在显示器**的 work_left/work_right（左侧副屏是负数）。
    // 右侧放不下就翻到左侧；两侧都放不下时选空间大的一侧，最终由 monitor clamp 兜底。
    const MARGIN: i32 = 8;
    let right_space = (work_right - MARGIN - dog_x).max(0);
    let left_space = (dog_x + slot_w_phys - (work_left + MARGIN)).max(0);
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
            // 这里必须用前端传进来的 expanded_height（各页面不一样，聊天框可调），
            // 之前写死成 520，导致设置里的聊天框高度改了也不生效。
            let slot_w = slot_width_css(state.collapsed_scale);
            let slot_h = slot_height_css(state.collapsed_scale);
            let height = if PANEL_BELOW.load(Ordering::Relaxed) {
                // 面板在小狗下方：狗槽 + 间隙 + 面板，否则面板会被窗口底边裁掉。
                slot_h + EXPANDED_PANEL_GAP + state.expanded_height
            } else {
                slot_h.max(state.expanded_height)
            };
            (
                slot_w + EXPANDED_PANEL_GAP + EXPANDED_PANEL_WIDTH,
                height,
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
    // 最小化时系统会把窗口挪到 (-32000, -32000) 并触发 Moved；这不是用户拖拽，
    // 写进 custom_position 就会「最小化一次位置就变了」。
    if is_sentinel_window_position(position.x, position.y)
        || ISLAND_MINIMIZED.load(Ordering::SeqCst)
    {
        return;
    }
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
    fn shell_execute_path_drops_extended_prefixes() {
        assert_eq!(
            normalize_shell_execute_path(Path::new(r"\\?\C:\tools\start.cmd")),
            PathBuf::from(r"C:\tools\start.cmd")
        );
        assert_eq!(
            normalize_shell_execute_path(Path::new(r"\\?\UNC\server\share\start.cmd")),
            PathBuf::from(r"\\server\share\start.cmd")
        );
        assert_eq!(
            normalize_shell_execute_path(Path::new(r"C:\tools\start.cmd")),
            PathBuf::from(r"C:\tools\start.cmd")
        );
    }

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
    fn expanded_stage_uses_the_requested_panel_height() {
        // 面板在上方（或左右）：窗口高度就是面板高度，且不小于小狗槽。
        PANEL_BELOW.store(false, Ordering::Relaxed);
        let expanded = state(IslandMode::Expanded, 0.89, 800.0);
        let (_, height) = stage_dimensions(expanded);
        assert!((height - 800.0).abs() < 0.5);

        let small = state(IslandMode::Expanded, 0.89, 220.0);
        let (_, small_height) = stage_dimensions(small);
        assert!(small_height >= slot_height_css(0.89));

        // 面板在下方：窗口要额外容纳小狗槽 + 间隙，否则面板会被底边裁掉。
        // 两个断言放在同一个测试里，避免并行测试互相改 PANEL_BELOW。
        PANEL_BELOW.store(true, Ordering::Relaxed);
        let below = state(IslandMode::Expanded, 0.89, 800.0);
        let (_, below_height) = stage_dimensions(below);
        let expected = slot_height_css(0.89) + EXPANDED_PANEL_GAP + 800.0;
        assert!((below_height - expected).abs() < 0.5);
        PANEL_BELOW.store(false, Ordering::Relaxed);
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

    // 判据 1（8px 位移）：唤醒落位必须是锁角基线，而不是「工作区底边 - 狗槽」。
    // 锁右下角的小狗在 2560×1440 / 工作区底边 1432 / 收起 1.6× 下，
    // 基线是 (2285, 1195)，比未锁角默认位（margin_y=0）高 16px。
    #[test]
    fn wake_restores_the_lock_corner_baseline_instead_of_the_work_area_default() {
        let collapsed_scale = 1.6;
        let scale = 1.0;
        let work_right = 2560;
        let work_bottom = 1432;
        let slot_w = (slot_width_css(collapsed_scale) * scale).round() as i32;
        let slot_h = (slot_height_css(collapsed_scale) * scale).round() as i32;
        assert_eq!((slot_w, slot_h), (259, 221));

        // lock_island_corner 的公式：工作区四角 + 16px 边距，写进 custom_position。
        const LOCK_MARGIN: i32 = 16;
        let locked = IslandPosition {
            x: work_right - slot_w - LOCK_MARGIN,
            y: work_bottom - slot_h - LOCK_MARGIN,
        };
        assert_eq!(locked, IslandPosition { x: 2285, y: 1195 });

        // 未锁角的默认收起位：工作区底边 - 狗槽 - margin_y(默认 0)。
        let default_y = work_bottom - slot_h;
        assert_eq!(default_y - locked.y, LOCK_MARGIN);

        let mut positioned = state(IslandMode::Collapsed, collapsed_scale, DEFAULT_EXPANDED_ISLAND_HEIGHT);
        positioned.custom_position = Some(locked);

        // 缩边：x 保持锁角基线，y 交给缩边公式。
        positioned.is_tucked = true;
        assert_eq!(
            resolve_stage_position(positioned, 0, default_y, -48).0,
            locked.x
        );
        // 唤醒：x/y 都必须精确回到锁角基线（差 0px，实机验收口径 ≤2px）。
        positioned.is_tucked = false;
        assert_eq!(
            resolve_stage_position(positioned, 0, default_y, -48),
            (locked.x, locked.y)
        );
    }

    // 判据 2（8px 位移）：唤醒/缩边/闲逛的位移动画进行中不允许开始拖拽，
    // 否则会把动画中间帧当成用户放置位置写进 custom_position 并持久化。
    #[test]
    fn drag_start_is_rejected_until_the_geometry_has_settled() {
        let settled = state(IslandMode::Collapsed, 1.0, DEFAULT_EXPANDED_ISLAND_HEIGHT);
        assert!(drag_start_allowed(settled, false));

        // 动画进行中（缩边 / 唤醒 / 闲逛）：拒绝。
        assert!(!drag_start_allowed(settled, true));

        // 缩边态按下：拒绝（唤醒由点击/悬停驱动，不该顺带改位置）。
        let mut tucked = settled;
        tucked.is_tucked = true;
        assert!(!drag_start_allowed(tucked, false));

        // 已经在拖：拒绝重复进入。
        let mut dragging = settled;
        dragging.is_dragging = true;
        assert!(!drag_start_allowed(dragging, false));

        // 展开态：拒绝（浮层矩形不是狗位）。
        let mut expanded = settled;
        expanded.mode = IslandMode::Expanded;
        assert!(!drag_start_allowed(expanded, false));
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

    // —— 最小化漂移防护（2026-11-17）——

    #[test]
    fn minimized_sentinel_positions_are_never_real_geometry() {
        // Windows 最小化把窗口放到 (-32000, -32000)；这类坐标一律不采信。
        assert!(is_sentinel_window_position(-32000, -32000));
        assert!(is_sentinel_window_position(-30_000, 1080));
        assert!(is_sentinel_window_position(100, -30_001));
        assert!(!is_sentinel_window_position(0, 0));
        assert!(!is_sentinel_window_position(1912, 1040));
    }

    #[test]
    fn sane_rect_rejects_sentinel_and_zero_sized_windows() {
        let real = WindowRect { x: 1560, y: 880, width: 259, height: 221 };
        assert_eq!(sane_window_rect(real), Some(real));
        // 最小化瞬间：位置是哨兵值
        assert_eq!(
            sane_window_rect(WindowRect { x: -32000, y: -32000, width: 259, height: 221 }),
            None
        );
        // 最小化瞬间：尺寸变 0 / 只剩标题栏高度
        assert_eq!(sane_window_rect(WindowRect { x: 1560, y: 880, width: 0, height: 0 }), None);
        assert_eq!(sane_window_rect(WindowRect { x: 1560, y: 880, width: 259, height: 28 }), None);
    }

    // —— Bongo「跟随小狗」的目标屏解析 ——

    #[test]
    fn extras_target_follows_island_actual_monitor_when_preferences_are_none() {
        // 用户没选「小狗屏幕」（跟随上次位置）时，偏好是 None；
        // 小狗靠持久化位置落在副屏，Bongo 必须跟到副屏，不能回主屏。
        assert_eq!(
            resolve_extras_target_key(None, None, Some("\\\\.\\DISPLAY1|1920x1080@-1920,0".to_string())),
            Some("\\\\.\\DISPLAY1|1920x1080@-1920,0".to_string())
        );
        // 显式选了「小狗屏幕」时优先用偏好
        assert_eq!(
            resolve_extras_target_key(None, Some("pref-island".to_string()), Some("actual".to_string())),
            Some("pref-island".to_string())
        );
        // Bongo 单独指定时优先级最高
        assert_eq!(
            resolve_extras_target_key(Some("pref-bongo".to_string()), Some("pref-island".to_string()), None),
            Some("pref-bongo".to_string())
        );
        // 全都没有（显示器未就绪）→ None，调用方回主屏
        assert_eq!(resolve_extras_target_key(None, None, None), None);
    }

    // —— 展开面板的跨屏/负坐标判定 ——

    #[test]
    fn expanded_panel_side_uses_target_monitor_bounds_when_secondary_left_is_negative() {
        // 左侧副屏 work area: -1920..0，狗槽 259 宽，面板想要 727 宽
        let left = -1920;
        let right = 0;
        // 副屏居中原位（狗在 -1090）：右侧还有 1090px → 朝右
        assert_eq!(expanded_panel_side(-1090, 259, 727, left, right), "right");
        // 靠副屏右边缘（狗在 -259）：右侧只有 259px → 必须翻到左侧
        assert_eq!(expanded_panel_side(-259, 259, 727, left, right), "left");
        // 靠副屏左边缘（狗在 -1900）：右侧 1900px → 朝右
        assert_eq!(expanded_panel_side(-1900, 259, 727, left, right), "right");
        // 屏太窄、两侧都放不下 → 选空间大的一侧（不跨屏，最终由 clamp 兜底）
        assert_eq!(expanded_panel_side(-300, 259, 3000, -700, 0), "right");
    }

    #[test]
    fn clamp_rect_to_monitor_keeps_window_on_negative_secondary() {
        let secondary = ScreenRect::new(-1920, 0, 0, 1080);
        // 展开后窗口跑到主屏（x=0）→ 夹回副屏右边缘
        let (x, y, w, h) = clamp_rect_to_safe(0, 500, 727, 480, secondary);
        assert_eq!(x, -727);
        assert!(x + w <= 0, "窗口必须完全落在副屏（right <= 0）");
        assert_eq!((y, h), (500, 480));
    }

    // —— 气泡避让任务栏 ——

    #[test]
    fn taskbar_edge_detects_four_sides_and_ignores_autohide_sliver() {
        let monitor = ScreenRect::new(0, 0, 2560, 1440);
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(0, 1392, 2560, 1440), monitor),
            Some(TaskbarEdge::Bottom)
        );
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(0, 0, 2560, 48), monitor),
            Some(TaskbarEdge::Top)
        );
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(0, 0, 48, 1440), monitor),
            Some(TaskbarEdge::Left)
        );
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(2512, 0, 2560, 1440), monitor),
            Some(TaskbarEdge::Right)
        );
        // 自动隐藏收起：只剩 2px 细条，不算占用
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(0, 1438, 2560, 1440), monitor),
            None
        );
        // 另一块屏的任务栏与本屏无关
        assert_eq!(
            taskbar_edge_on_monitor(ScreenRect::new(-1920, 1032, 0, 1080), monitor),
            None
        );
    }

    #[test]
    fn bubble_safe_rect_shaves_taskbar_side_with_margin() {
        let monitor = ScreenRect::new(0, 0, 2560, 1440);
        let work = ScreenRect::new(0, 0, 2560, 1392);
        let taskbar = ScreenRect::new(0, 1392, 2560, 1440);
        assert_eq!(
            bubble_safe_rect(monitor, work, &[taskbar]),
            ScreenRect::new(0, 0, 2560, 1384)
        );
        // top / left
        let full = ScreenRect::new(0, 0, 2560, 1440);
        assert_eq!(
            bubble_safe_rect(monitor, full, &[ScreenRect::new(0, 0, 2560, 48)]),
            ScreenRect::new(0, 56, 2560, 1440)
        );
        assert_eq!(
            bubble_safe_rect(monitor, full, &[ScreenRect::new(0, 0, 48, 1440)]),
            ScreenRect::new(56, 0, 2560, 1440)
        );
    }

    #[test]
    fn bubble_safe_rect_handles_autohide_popped_and_hidden() {
        let monitor = ScreenRect::new(0, 0, 2560, 1440);
        let full = monitor;
        let popped = ScreenRect::new(0, 1392, 2560, 1440);
        let hidden = ScreenRect::new(0, 1438, 2560, 1440);
        assert_eq!(bubble_safe_rect(monitor, full, &[popped]).bottom, 1384);
        // 收起后回到整屏，但调用方只会在越界时移动 → 已上移的位置保持不动
        assert_eq!(bubble_safe_rect(monitor, full, &[hidden]).bottom, 1440);
    }

    #[test]
    fn bubble_safe_rect_secondary_negative_coordinates() {
        let secondary = ScreenRect::new(-1920, 0, 0, 1080);
        let taskbar = ScreenRect::new(-1920, 1032, 0, 1080);
        let safe = bubble_safe_rect(secondary, secondary, &[taskbar]);
        assert_eq!(safe.left, -1920);
        assert_eq!(safe.bottom, 1024);
        let (x, y, width, height) = clamp_rect_to_safe(-500, 900, 300, 224, safe);
        assert_eq!(y, 1024 - 224);
        assert!(x >= -1920 && x + width <= 0);
        assert_eq!(height, 224);
    }

    #[test]
    fn clamp_rect_moves_up_and_shrinks_only_when_needed() {
        let safe = ScreenRect::new(0, 0, 2560, 1384);
        assert_eq!(clamp_rect_to_safe(100, 1300, 300, 224, safe), (100, 1160, 300, 224));
        assert_eq!(clamp_rect_to_safe(100, -50, 300, 224, safe), (100, 0, 300, 224));
        let tiny = ScreenRect::new(0, 0, 800, 200);
        assert_eq!(clamp_rect_to_safe(0, 0, 300, 224, tiny), (0, 0, 300, 200));
    }
    // —— 固定在桌面的标签页（pinned）跟随副屏 ——

    #[test]
    fn pinned_anchor_sits_bottom_right_of_the_target_work_area() {
        // 副屏在左：工作区 x = -1920，窗口 420×560，边距 24
        let work = (-1920, 0, 1920u32, 1080u32);
        let position = pinned_anchor(work, (420, 560), 24);
        assert_eq!(position, (-1920 + 1920 - 420 - 24, 1080 - 560 - 24));
        assert!(position.0 < 0, "副屏上的 pinned 仍在负 x 区域");
        assert!(position.0 + 420 <= 0, "整个窗口落在副屏内");
        // 主屏同样规则
        assert_eq!(pinned_anchor((0, 0, 2560, 1440), (420, 560), 24), (2116, 856));
        // 工作区比窗口还小时贴左上角，不出现负坐标
        assert_eq!(pinned_anchor((0, 0, 300, 300), (420, 560), 24), (0, 0));
    }

    #[test]
    fn pinned_clamp_keeps_window_inside_after_screen_switch() {
        let work = (-1920, 0, 1920u32, 1080u32);
        // 用户在主屏拖动过 (2285,1203)，切到副屏必须夹进副屏
        let clamped = clamp_to_work_area((2285, 1203), (420, 560), work);
        assert_eq!(clamped, (-1920 + 1920 - 420, 1080 - 560));
        assert!(clamped.0 >= -1920 && clamped.0 + 420 <= 0);
        assert!(clamped.1 >= 0 && clamped.1 + 560 <= 1080);
        // 已在屏内则原样保留（尊重拖动记忆）
        assert_eq!(clamp_to_work_area((-800, 200), (420, 560), work), (-800, 200));
        // 越过左上角也被拉回
        assert_eq!(clamp_to_work_area((-9999, -9999), (420, 560), work), (-1920, 0));
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
            // 托盘菜单事件在主线程触发，而懒创建窗口不能在主线程发起（会卡住
            // WebView2 初始化），所以丢到异步运行时线程里再调 async 命令。
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_settings_window(app).await {
                        eprintln!("failed to open the settings window from the tray: {error}");
                    }
                });
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

    let tray_icon = tray.build(app)?;
    let _ = TRAY_HANDLE.set(tray_icon);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTUP_START.get_or_init(Instant::now);
    startup_mark("run:begin");
    // 最早阶段：确定数据根（创建 + 一次性迁移），后续所有路径都走 paths::data_root()。
    let _ = paths::ensure_data_root();
    let mut context = tauri::generate_context!();
    if let Some(identifier) = notification_diagnostics::verification_identifier() {
        context.config_mut().identifier = identifier;
    }
    // P1：以应用数据目录（WebView2 profile 所在目录）为键的跨进程实例锁。
    // 先于 Builder 判断：第二实例在这里就退出，不会创建任何 WebView，也不会抢
    // profile / 托盘 / 全局快捷键；只留一个 show-request 文件让首实例把狗叫出来。
    // 锁随文件句柄释放，进程退出（含崩溃 / 任务管理器结束）时自动回收，没有 stale lock。
    let identifier = context.config().identifier.clone();
    let mut instance_data_dir = Some(paths::data_root());
    if let Some(data_dir) = instance_data_dir.as_deref() {
        match instance_lock::acquire(data_dir, &identifier) {
            Ok(instance_lock::InstanceGuard::Primary) => {}
            Ok(instance_lock::InstanceGuard::Secondary) => {
                let requested = instance_lock::request_show(data_dir);
                eprintln!(
                    "another Maltese instance is already using {} (show requested: {requested}); exiting",
                    data_dir.display()
                );
                instance_data_dir = None;
                return;
            }
            Err(error) => {
                eprintln!("failed to acquire the instance lock, continuing without it: {error}");
            }
        }
    }
    let setup_instance_dir = instance_data_dir.clone();
    let exit_instance_dir = instance_data_dir.clone();
    tauri::Builder::default()
        // 前端产物外置：`http://maltese.localhost/...` 从 <资源目录>/web 读取。
        // 默认（内嵌产物）时这个协议不会被请求，注册本身没有副作用。
        .register_uri_scheme_protocol(web_protocol::scheme(), |context, request| {
            web_protocol::respond(context.app_handle(), &request)
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 同 identifier 的第二实例会走到这里：把已存在的桌宠带到前台。
            // show_island 内部已经包含 show / 取消最小化 / 置顶 / 聚焦 / 可见性重试。
            if let Err(error) = show_island(app) {
                eprintln!("failed to bring the existing island to front: {error}");
            }
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
                // 「固定在桌面的标签页」：记住用户拖动后的位置（换屏时夹进目标屏）。
                if window.label() == "pinned" {
                    if let WindowEvent::Moved(position) = event {
                        let auto = PINNED_AUTO_POSITIONING.load(Ordering::SeqCst);
                        let minimized = window.is_minimized().unwrap_or(false);
                        let junk = (position.x == 0 && position.y == 0)
                            || is_sentinel_window_position(position.x, position.y);
                        let programmatic = PINNED_LAST_SET
                            .lock()
                            .ok()
                            .and_then(|slot| *slot)
                            == Some((position.x, position.y));
                        if !auto && !minimized && !junk && !programmatic {
                            if let Ok(mut slot) = PINNED_MANUAL_POSITION.lock() {
                                *slot = Some((position.x, position.y));
                            }
                        }
                    }
                }
                return;
            }

            // 最小化 / 还原：同步几何冻结状态（缓存最小化前矩形 / 还原后逐像素复位）。
            // 最小化会让窗口尺寸变 0、位置变 (-32000,-32000)，并连续发 Moved/Resized；
            // 这些事件绝不能进 record_dragged_position，否则还原位置被写脏。
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(_)) {
                if let Some(webview) = window.app_handle().get_webview_window(WINDOW_LABEL) {
                    sync_minimize_geometry(&webview);
                }
                return;
            }

            if let WindowEvent::Moved(position) = event {
                if window.is_minimized().unwrap_or(false)
                    || ISLAND_MINIMIZED.load(Ordering::SeqCst)
                    || is_sentinel_window_position(position.x, position.y)
                {
                    return;
                }
                record_dragged_position(*position);
                persist_island_snapshot(window.app_handle());
                return;
            }

            // Native Acrylic/Region is intentionally not reapplied on DPI
            // changes. Liquid glass is rendered inside the island element.
        })
        .setup(move |app| {
            build_tray(app)?;
            // 升级 / 换目录后把自启项指回当前 exe，避免开机拉起旧路径。
            sync_startup_path();
            // 首实例才启动 show-request 监听：第二实例发现锁已存在时会写文件。
            if let Some(data_dir) = setup_instance_dir.clone() {
                instance_lock::spawn_show_request_watcher(app.handle().clone(), data_dir);
            }
            // 多屏热插拔：30s 轮询显示器指纹集合，变化时按偏好重排主岛/Bongo。
            start_monitor_watch(app.handle().clone());
            // 重启后 Bongo 回主屏：启动瞬间显示器枚举 / 前端恢复主岛位置 / 屏幕偏好
            // 都还没就绪，extras 可能先按主屏落位。这里在 1s / 3s / 6s 各重同步一次
            // （幂等，成功后配置不变就不会再动），保证「Bongo 跟随小狗」用的是主岛实际所在屏。
            {
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    for delay in [Duration::from_millis(1000), Duration::from_secs(3), Duration::from_secs(6)] {
                        thread::sleep(delay);
                        if let Some(config) = desktop_extras::last_config() {
                            let _ = desktop_extras::sync_extras_now(&app_handle, &config);
                        }
                    }
                });
            }
            if let Err(error) = clipboard_history::init(app.handle()) {
                eprintln!("failed to initialize clipboard history: {error}");
            }
            // 上次台球若没正常退出，先把桌面图标位置改回来。
            desktop_icons::restore_desktop_on_startup();
            wake_shortcut::init(app.handle());
            shortcut_hotkeys::init(app.handle());
            collapse_shortcut::init(app.handle());
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
            startup_mark("setup:begin");
            if let Ok(window) = main_window(app.handle()) {
                startup_mark("setup:island_window");
                restore_island_rect_on_startup(app.handle());
                if let Err(error) = apply_stage_geometry(&window, IslandWindowState::default(), false) {
                    eprintln!("failed to size and position island window: {error}");
                }
                start_cursor_passthrough_loop(window);
            }
            startup_mark("setup:island_ready");
            spawn_startup_watchdog(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_monitors,
            island_geometry_selftest,
            report_pet_slot_offset,
            set_monitor_preferences,
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
            dsh_chat::dsh_chat,
            local_chat::local_chat,
            local_chat::local_chat_stream,
            local_chat::local_chat_cancel,
            local_chat::local_model_load_cancel,
            local_chat::local_model_status,
            local_chat::local_chat_models,
            local_chat::strata_launch,
            local_chat::ensure_local_model,
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
            frontend_ready,
            show_island_no_focus,
            open_settings_window,
            close_billiards_window,
            pin_page_to_desktop,
            get_pinned_page,
            unpin_page_from_desktop,
            set_island_overlay,
            plan_island_overlay,
            roam_island_step,
            minimize_island,
            set_extra_pets_hidden,
            set_bongo_hidden,
            lyrics::fetch_lyrics,
            icons::get_shortcut_icon,
            desktop_extras::sync_desktop_extras,
            desktop_icons::desktop_icons_begin_game,
            desktop_icons::desktop_icons_move,
            desktop_icons::desktop_icons_restore,
            desktop_icons::desktop_icons_available,
            open_billiards_window,
            desktop_extras::get_pressed_keys,
            show_pet_bubble,
            resize_pet_bubble,
            get_pet_bubble_payload,
            hide_pet_bubble,
            lock_island_corner,
            is_foreground_fullscreen,
            get_launch_at_startup,
            set_launch_at_startup,
            open_local_path,
            check_local_path,
            get_pet_asset_base,
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
            usage::usage_record,
            usage::usage_summary,
            usage::usage_clear,
            data_directory_info,
            open_data_directory,
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
            collapse_shortcut::set_collapse_shortcut,
            shortcut_hotkeys::set_shortcut_panel_hotkey,
            plugins::list_plugins,
            plugins::install_plugin,
            plugins::remove_plugin,
            plugins::open_plugins_directory,
            plugins::run_plugin_action,
            plugins::open_plugin_window,
            plugins::get_active_plugin,
            relay::relay_publish,
            relay::relay_fetch,
        web_search::web_search,
            pet_gifs::add_pet_gif,
            custom_sound::add_custom_sound,
            custom_sound::remove_custom_sound,
            pet_gifs::remove_pet_gif,
            pet_gifs::park_pet_gif,
            pet_gifs::restore_pet_gif,
            pet_gifs::discard_trashed_pet_gif,
            actions::read_clipboard_text,
            actions::set_clipboard_text,
            actions::type_text,
            actions::press_shortcut,
            video::video_start_session,
            video::video_list_accounts,
            video::video_get_active_account,
            video::video_create_account,
            video::video_set_active_account,
            video::video_mark_account_ready,
            video::video_stop_session,
            video::video_get_snapshot,
            video::video_update_config,
            video::video_probe_channels,
            video::video_comment_selftest,
            video::video_list_sessions,
            video::video_get_session,
            video::video_get_profile,
            video::video_update_profile,
            video::video_take_pending_digest,
            video::video_get_taste,
            video::video_update_taste,
            video::video_reset_taste,
            video::xhs_generate_draft,
            video::xhs_open_drafts_dir,
            video::xhs_save_draft,
            video::xhs_fill_creator,
            video::video_mark_delivery,
            video::video_diagnostics,
            video::video_clear_data,
            video::video_post_comment,
            video::video_open_login_window,
            video::video_close_browser,
            video::video_browser_status,
            video::video_open_external_url,
            video::video_open_logs_dir,
            agent_hub::get_agent_registry,
            agent_hub::agent_hub_status,
            agent_hub::agent_hub_usage,
            agent_hub::agent_run,
            agent_hub::agent_cancel,
            agent_hub::agent_pipeline,
            agent_hub::agent_pipeline_run,
            desktop_agents::desktop_agents_status,
            desktop_agents::desktop_agent_focus,
            task_progress::task_begin,
            task_progress::task_advance,
            task_progress::task_end,
            task_progress::task_list_snapshot,
            task_progress::task_infer,
        ])
        .build(context)
        .expect("error while building Maltese")
        .run(move |app, event| {
            // 退出应用时，如果台球还开着，把真实桌面图标放回去（issue #1）。
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(window) = app.get_webview_window("billiards") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = desktop_icons::desktop_icons_restore();
                    }
                }
                if exit_instance_dir.is_some() {
                    instance_lock::clear_instance_info();
                }
                // 退出前再落盘一次最终矩形（启动恢复用）。
                persist_island_snapshot(app);
                // U10：退出应用时关掉刷视频专用的浏览器，避免残留实例占住 profile/端口。
                let _ = video::session::engine(app).close_browser();
            }
        });
}
