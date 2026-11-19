//! 桌面 Agent 监控：只读枚举本机正在运行的 AI 助手桌面应用（Claude / ChatGPT / Cursor /
//! 豆包 / 通义 / Copilot / Codex …），以及「把某个应用切到前台」的聚焦动作。
//!
//! 设计边界（需求明确要求）：
//! - **只监控 + 聚焦**，不做键盘/鼠标注入，不做 UI 自动化点击。
//! - 枚举只读：`EnumWindows` + `GetWindowThreadProcessId` + `QueryFullProcessImageNameW`；
//!   跳过不可见窗口、工具窗口（`WS_EX_TOOLWINDOW`）、有 owner 的弹窗、空标题窗口。
//! - 所有 Win32 枚举都在 `spawn_blocking` 里跑，结果缓存 3s；命令本身是 `async fn`，
//!   不占 Tauri main thread。
//! - 白名单来自 `%APPDATA%\<identifier>\agent-hub\config.json` 的 `desktopAgents[]`；
//!   配置里没有这个字段时使用内置默认列表（见 `default_desktop_agents`）。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::Threading::{
            AttachThreadInput, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongW,
            GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, SetForegroundWindow, ShowWindow, SwitchToThisWindow, GWL_EXSTYLE,
            GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
        },
    },
};

use crate::agent_hub;

/// 缓存有效期：控制台 3s 轮询时，只有第一次真正枚举。
const CACHE_TTL: Duration = Duration::from_secs(3);
/// 单个窗口标题上限（字符），防御异常程序塞超长标题。
const MAX_TITLE_CHARS: usize = 200;
/// 最多检查多少顶层窗口，避免枚举被异常程序拖慢。
const MAX_WINDOWS: usize = 800;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentSpec {
    pub id: String,
    pub display_name: String,
    /// 进程名（可带或不带 .exe，大小写不敏感；按文件名 stem 匹配）。
    #[serde(default)]
    pub process_names: Vec<String>,
    /// 窗口标题包含这些片段也算匹配（给没有稳定进程名的壳应用兜底）。
    #[serde(default)]
    pub window_title_patterns: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentStatus {
    pub id: String,
    pub display_name: String,
    pub running: bool,
    pub process_count: usize,
    pub pids: Vec<u32>,
    pub window_title: Option<String>,
    pub matched_process: Option<String>,
    pub is_foreground: bool,
    /// 本次处于前台已持续多少秒（不在前台为 0）。
    pub foreground_seconds: u64,
    /// 距离上一次处于前台过去多少秒（从未活跃为 null）。
    pub last_active_ago_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopForeground {
    pub pid: u32,
    pub process_name: String,
    pub title: String,
    pub agent_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentsSnapshot {
    pub agents: Vec<DesktopAgentStatus>,
    pub foreground: Option<DesktopForeground>,
    pub enumerated_at: u64,
    pub enumeration_ms: u64,
    /// true 表示返回的是 ≤3s 的缓存，没有重新枚举。
    pub cached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFocusResult {
    pub id: String,
    pub display_name: String,
    pub window_title: Option<String>,
    pub pid: u32,
    pub foreground: bool,
}

#[derive(Clone, Debug)]
struct WindowEntry {
    hwnd: HWND,
    pid: u32,
    title: String,
    process_name: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct Activity {
    last_active_ms: Option<u64>,
    foreground_since_ms: Option<u64>,
}

static ACTIVITY: Mutex<Option<HashMap<String, Activity>>> = Mutex::new(None);
static CACHE: Mutex<Option<(u64, DesktopAgentsSnapshot)>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 内置默认白名单：覆盖需求点名的常见桌面 AI 助手。
pub(crate) fn default_desktop_agents() -> Vec<DesktopAgentSpec> {
    vec![
        DesktopAgentSpec {
            id: "claude-desktop".into(),
            display_name: "Claude".into(),
            process_names: vec!["claude".into(), "claude-desktop".into()],
            window_title_patterns: vec!["Claude".into()],
        },
        DesktopAgentSpec {
            id: "chatgpt".into(),
            display_name: "ChatGPT".into(),
            process_names: vec!["chatgpt".into()],
            window_title_patterns: vec!["ChatGPT".into()],
        },
        DesktopAgentSpec {
            id: "cursor".into(),
            display_name: "Cursor".into(),
            process_names: vec!["cursor".into()],
            window_title_patterns: vec!["Cursor".into()],
        },
        DesktopAgentSpec {
            id: "doubao".into(),
            display_name: "豆包".into(),
            process_names: vec!["doubao".into(), "doubao-desktop".into()],
            window_title_patterns: vec!["豆包".into(), "Doubao".into()],
        },
        DesktopAgentSpec {
            id: "tongyi".into(),
            display_name: "通义".into(),
            process_names: vec!["tongyi".into(), "qwen".into(), "qianwen".into()],
            window_title_patterns: vec!["通义".into(), "千问".into(), "Qwen".into()],
        },
        DesktopAgentSpec {
            id: "copilot".into(),
            display_name: "Copilot".into(),
            process_names: vec!["copilot".into()],
            window_title_patterns: vec!["Copilot".into()],
        },
        DesktopAgentSpec {
            id: "codex-desktop".into(),
            display_name: "Codex".into(),
            process_names: vec!["codex".into(), "codex-desktop".into()],
            window_title_patterns: vec!["Codex".into()],
        },
    ]
}

fn normalize_process(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    base.trim_end_matches(".exe").to_ascii_lowercase()
}

fn matches_process(spec: &DesktopAgentSpec, process_name: &str) -> bool {
    let candidate = normalize_process(process_name);
    spec.process_names
        .iter()
        .any(|name| normalize_process(name) == candidate)
}

fn matches_title(spec: &DesktopAgentSpec, title: &str) -> bool {
    let lower = title.to_lowercase();
    spec.window_title_patterns.iter().any(|pattern| {
        let needle = pattern.to_lowercase();
        if needle.is_empty() {
            return false;
        }
        // 词边界匹配：避免 "Qwen" 命中 "monitor-qwen36.ps1" 这类误报。
        let mut start = 0;
        while let Some(found) = lower[start..].find(&needle) {
            let index = start + found;
            let before = lower[..index].chars().next_back();
            let after = lower[index + needle.len()..].chars().next();
            let boundary = |value: Option<char>| value.map(|c| !c.is_ascii_alphanumeric()).unwrap_or(true);
            if boundary(before) && boundary(after) {
                return true;
            }
            start = index + needle.len();
        }
        false
    })
}

unsafe fn window_title(hwnd: HWND) -> Option<String> {
    let length = GetWindowTextLengthW(hwnd);
    if length <= 0 || length as usize > 4096 {
        return None;
    }
    let mut buffer = vec![0u16; (length + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buffer);
    if copied <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buffer[..copied as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(MAX_TITLE_CHARS).collect())
}

unsafe fn process_image_name(pid: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    let result = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        PWSTR(buffer.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(handle);
    if result.is_err() || size == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

unsafe fn is_window_candidate(hwnd: HWND) -> bool {
    if !IsWindowVisible(hwnd).as_bool() {
        return false;
    }
    // 工具窗口 / 有 owner 的弹窗通常不是主界面，跳过，避免把悬浮提示算成应用窗口。
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.0.is_null() {
            return false;
        }
    }
    true
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<WindowEntry>);
    if windows.len() >= MAX_WINDOWS {
        return false.into();
    }
    if !is_window_candidate(hwnd) {
        return true.into();
    }
    let Some(title) = window_title(hwnd) else {
        return true.into();
    };
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return true.into();
    }
    let Some(process_name) = process_image_name(pid) else {
        return true.into();
    };
    windows.push(WindowEntry {
        hwnd,
        pid,
        title,
        process_name,
    });
    true.into()
}

fn enumerate_windows() -> Vec<WindowEntry> {
    let mut windows: Vec<WindowEntry> = Vec::new();
    let pointer = &mut windows as *mut Vec<WindowEntry> as isize;
    // SAFETY: 回调只在 EnumWindows 调用期间使用该指针，回调内只做只读 Win32 查询。
    unsafe {
        let _ = EnumWindows(Some(enum_windows_proc), LPARAM(pointer));
    }
    windows
}

fn foreground_window() -> Option<(HWND, u32, String, String)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process_name = process_image_name(pid)?;
        let title = window_title(hwnd).unwrap_or_default();
        Some((hwnd, pid, process_name, title))
    }
}

fn load_specs(dir: &Path) -> Result<Vec<DesktopAgentSpec>, String> {
    let config = agent_hub::read_or_seed_config(dir)?;
    if config.desktop_agents.is_empty() {
        Ok(default_desktop_agents())
    } else {
        Ok(config.desktop_agents)
    }
}

fn update_activity(
    specs: &[DesktopAgentSpec],
    foreground_agent: Option<&str>,
    focus_target: Option<&str>,
) -> HashMap<String, Activity> {
    let now = now_ms();
    let mut guard = ACTIVITY.lock().unwrap_or_else(|error| error.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    for spec in specs {
        let entry = map.entry(spec.id.clone()).or_default();
        let is_foreground = foreground_agent == Some(spec.id.as_str())
            || focus_target == Some(spec.id.as_str());
        if is_foreground {
            entry.last_active_ms = Some(now);
            if entry.foreground_since_ms.is_none() {
                entry.foreground_since_ms = Some(now);
            }
        } else {
            entry.foreground_since_ms = None;
        }
    }
    // 移除已经从配置里删掉的 agent，避免静态表无限增长。
    let known: std::collections::HashSet<&str> =
        specs.iter().map(|spec| spec.id.as_str()).collect();
    map.retain(|id, _| known.contains(id.as_str()));
    map.clone()
}

fn build_snapshot(dir: &Path) -> Result<DesktopAgentsSnapshot, String> {
    let started = Instant::now();
    let specs = load_specs(dir)?;
    let windows = enumerate_windows();
    let foreground = foreground_window();
    let foreground_agent = foreground.as_ref().and_then(|(_, _, process_name, title)| {
        specs
            .iter()
            .find(|spec| matches_process(spec, process_name) || matches_title(spec, title))
            .map(|spec| spec.id.clone())
    });
    let activity = update_activity(&specs, foreground_agent.as_deref(), None);
    let now = now_ms();
    let agents = specs
        .iter()
        .map(|spec| {
            let matched: Vec<&WindowEntry> = windows
                .iter()
                .filter(|window| {
                    matches_process(spec, &window.process_name)
                        || matches_title(spec, &window.title)
                })
                .collect();
            let mut pids = matched.iter().map(|window| window.pid).collect::<Vec<_>>();
            pids.sort_unstable();
            pids.dedup();
            let is_foreground = foreground_agent.as_deref() == Some(spec.id.as_str());
            let window_title = matched
                .iter()
                .find(|window| is_foreground && foreground.as_ref().map(|item| item.0) == Some(window.hwnd))
                .or_else(|| matched.first())
                .map(|window| window.title.clone());
            let entry = activity.get(&spec.id).copied().unwrap_or_default();
            let foreground_seconds = if is_foreground {
                entry
                    .foreground_since_ms
                    .map(|since| now.saturating_sub(since) / 1000)
                    .unwrap_or(0)
            } else {
                0
            };
            DesktopAgentStatus {
                id: spec.id.clone(),
                display_name: spec.display_name.clone(),
                running: !matched.is_empty(),
                process_count: pids.len(),
                pids,
                window_title,
                matched_process: matched.first().map(|window| window.process_name.clone()),
                is_foreground,
                foreground_seconds,
                last_active_ago_seconds: entry
                    .last_active_ms
                    .map(|last| now.saturating_sub(last) / 1000),
            }
        })
        .collect();
    let snapshot = DesktopAgentsSnapshot {
        agents,
        foreground: foreground.map(|(_, pid, process_name, title)| DesktopForeground {
            pid,
            process_name,
            title,
            agent_id: foreground_agent,
        }),
        enumerated_at: now,
        enumeration_ms: started.elapsed().as_millis() as u64,
        cached: false,
    };
    Ok(snapshot)
}

fn cached_snapshot() -> Option<DesktopAgentsSnapshot> {
    let guard = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    let (at, snapshot) = guard.as_ref()?;
    if now_ms().saturating_sub(*at) <= CACHE_TTL.as_millis() as u64 {
        let mut cached = snapshot.clone();
        cached.cached = true;
        Some(cached)
    } else {
        None
    }
}

fn store_snapshot(snapshot: &DesktopAgentsSnapshot) {
    let mut guard = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    *guard = Some((now_ms(), snapshot.clone()));
}

/// 枚举当前桌面 AI 应用。`refresh=false` 且缓存 ≤3s 时直接返回缓存。
#[tauri::command]
pub async fn desktop_agents_status(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<DesktopAgentsSnapshot, String> {
    let started = Instant::now();
    let dir = agent_hub::config_dir(&app)?;
    let force = refresh.unwrap_or(false);
    if !force {
        if let Some(snapshot) = cached_snapshot() {
            agent_hub::log_slow_command(&app, "desktop_agents_status", started.elapsed().as_millis());
            return Ok(snapshot);
        }
    }
    let snapshot = tauri::async_runtime::spawn_blocking(move || build_snapshot(&dir))
        .await
        .map_err(|error| format!("桌面枚举线程失败：{error}"))??;
    store_snapshot(&snapshot);
    agent_hub::log_slow_command(&app, "desktop_agents_status", started.elapsed().as_millis());
    Ok(snapshot)
}

fn focus_now(dir: &Path, id: &str) -> Result<DesktopFocusResult, String> {
    let specs = load_specs(dir)?;
    let spec = specs
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| format!("配置里没有 id 为「{id}」的桌面 agent。"))?
        .clone();
    let windows = enumerate_windows();
    let mut matched: Vec<&WindowEntry> = windows
        .iter()
        .filter(|window| matches_process(&spec, &window.process_name) || matches_title(&spec, &window.title))
        .collect();
    if matched.is_empty() {
        return Err(format!("「{}」未启动（没有找到可见窗口）。", spec.display_name));
    }
    let foreground_hwnd = foreground_window().map(|(hwnd, ..)| hwnd);
    matched.sort_by_key(|window| {
        (
            foreground_hwnd == Some(window.hwnd),
            window.title.is_empty(),
        )
    });
    let target = matched[0];
    // SAFETY: target.hwnd 来自刚枚举到的可见顶层窗口，调用前后它可能关闭，
    // 失败会由 SetForegroundWindow/GetForegroundWindow 校验捕获。
    let focused = unsafe {
        if IsIconic(target.hwnd).as_bool() {
            let _ = ShowWindow(target.hwnd, SW_RESTORE);
        }
        let mut ok = SetForegroundWindow(target.hwnd).as_bool();
        if !ok {
            let _ = BringWindowToTop(target.hwnd);
            ok = SetForegroundWindow(target.hwnd).as_bool();
        }
        if !ok {
            // 前台锁：把自己的线程输入队列临时挂到当前前台线程上，再抢一次前台。
            // 这是 Win32 标准做法，只改前台焦点，不注入任何键鼠事件。
            let foreground = GetForegroundWindow();
            if !foreground.0.is_null() {
                let foreground_thread = GetWindowThreadProcessId(foreground, None);
                let target_thread = GetWindowThreadProcessId(target.hwnd, None);
                if foreground_thread != 0
                    && target_thread != 0
                    && foreground_thread != target_thread
                {
                    let _ = AttachThreadInput(foreground_thread, target_thread, true);
                    let _ = SetForegroundWindow(target.hwnd);
                    let _ = BringWindowToTop(target.hwnd);
                    // 必须在 detach 之前校验：detach 后前台可能被系统回退。
                    ok = GetForegroundWindow() == target.hwnd;
                    let _ = AttachThreadInput(foreground_thread, target_thread, false);
                }
            }
        }
        if !ok {
            // 最后兜底：SwitchToThisWindow 是 Win32 里给托盘/启动器用的兼容入口。
            SwitchToThisWindow(target.hwnd, true);
            ok = GetForegroundWindow() == target.hwnd;
        }
        ok
    };
    if !focused {
        return Err(format!(
            "系统拒绝把「{}」切到前台（可能被前台锁定）。请点一下任务栏里的窗口再试。",
            spec.display_name
        ));
    }
    update_activity(&specs, Some(&spec.id), Some(&spec.id));
    Ok(DesktopFocusResult {
        id: spec.id.clone(),
        display_name: spec.display_name.clone(),
        window_title: Some(target.title.clone()),
        pid: target.pid,
        foreground: true,
    })
}

/// 把指定桌面 agent 的窗口切到前台（最小化先还原）。失败立即返回中文原因。
#[tauri::command]
pub async fn desktop_agent_focus(app: AppHandle, id: String) -> Result<DesktopFocusResult, String> {
    let started = Instant::now();
    let dir = agent_hub::config_dir(&app)?;
    let worker_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || focus_now(&dir, &worker_id))
        .await
        .map_err(|error| format!("聚焦线程失败：{error}"))?;
    agent_hub::log_slow_command(&app, "desktop_agent_focus", started.elapsed().as_millis());
    result
}

/// 给控制台/技能用的纯函数入口（不依赖 AppHandle，便于实机测试）。
#[cfg(test)]
pub(crate) fn snapshot_for_test(dir: &Path) -> Result<DesktopAgentsSnapshot, String> {
    build_snapshot(dir)
}

#[cfg(test)]
pub(crate) fn focus_for_test(dir: &Path, id: &str) -> Result<DesktopFocusResult, String> {
    focus_now(dir, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_whitelist_covers_requested_apps() {
        let specs = default_desktop_agents();
        for id in ["claude-desktop", "chatgpt", "cursor", "doubao", "tongyi", "copilot", "codex-desktop"] {
            assert!(specs.iter().any(|spec| spec.id == id), "missing {id}");
        }
        assert!(specs.iter().all(|spec| !spec.process_names.is_empty()));
    }

    #[test]
    fn process_matching_ignores_exe_suffix_and_case() {
        let spec = DesktopAgentSpec {
            id: "x".into(),
            display_name: "X".into(),
            process_names: vec!["Claude.exe".into()],
            window_title_patterns: vec![],
        };
        assert!(matches_process(&spec, "claude"));
        assert!(matches_process(&spec, "C:/Program Files/Claude/claude.exe"));
        assert!(!matches_process(&spec, "chrome"));
    }

    #[test]
    fn title_matching_is_case_insensitive() {
        let spec = DesktopAgentSpec {
            id: "x".into(),
            display_name: "X".into(),
            process_names: vec![],
            window_title_patterns: vec!["豆包".into(), "ChatGPT".into()],
        };
        assert!(matches_title(&spec, "豆包 - 聊天"));
        assert!(matches_title(&spec, "chatgpt - 新对话"));
        assert!(!matches_title(&spec, "记事本"));
    }

    #[test]
    fn title_matching_respects_word_boundaries() {
        let spec = DesktopAgentSpec {
            id: "tongyi".into(),
            display_name: "通义".into(),
            process_names: vec![],
            window_title_patterns: vec!["Qwen".into(), "千问".into()],
        };
        assert!(!matches_title(&spec, "monitor-qwen36.ps1 - Notepad"));
        assert!(matches_title(&spec, "Qwen - 对话"));
        assert!(matches_title(&spec, "通义千问"));
    }

    #[test]
    fn cache_returns_snapshot_within_ttl() {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(".tmp-agent-hub-tests")
            .join(format!("cache-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let snapshot = snapshot_for_test(&dir).expect("snapshot");
        store_snapshot(&snapshot);
        let cached = cached_snapshot().expect("cache should hit");
        assert!(cached.cached);
        assert_eq!(cached.agents.len(), snapshot.agents.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enumeration_is_fast_and_reports_shape() {
        // 实机枚举（只读）；当前机器上不一定有目标应用，只校验结构/耗时。
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(".tmp-agent-hub-tests")
            .join(format!("desktop-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let snapshot = snapshot_for_test(&dir).expect("snapshot");
        assert_eq!(snapshot.agents.len(), default_desktop_agents().len());
        assert!(snapshot.enumeration_ms < 2_000, "enumeration too slow: {}", snapshot.enumeration_ms);
        for agent in &snapshot.agents {
            if agent.running {
                assert!(!agent.pids.is_empty());
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 实机：打印当前桌面 AI 应用，并尝试聚焦第一个运行中的应用。
    /// `cargo test --lib desktop_agents::tests::real_list_and_focus -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_list_and_focus() {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(".tmp-agent-hub-tests")
            .join(format!("desktop-real-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let started = Instant::now();
        let snapshot = snapshot_for_test(&dir).expect("snapshot");
        println!(
            "enumeration_ms={} foreground={:?}",
            started.elapsed().as_millis(),
            snapshot.foreground
        );
        for agent in &snapshot.agents {
            println!(
                "{}: running={} pids={:?} windows={:?} foreground={} foregroundSeconds={} lastActiveAgo={:?}",
                agent.display_name,
                agent.running,
                agent.pids,
                agent.window_title,
                agent.is_foreground,
                agent.foreground_seconds,
                agent.last_active_ago_seconds
            );
        }
        if let Some(agent) = snapshot.agents.iter().find(|agent| agent.running) {
            // 注意：后台测试进程不是前台进程，Windows 前台锁会拒绝 SetForegroundWindow；
            // 真实使用中用户点「聚焦」时本应用是前台进程，才会成功。这里只打印结果。
            let focus = focus_for_test(&dir, &agent.id);
            println!("focus {:?} => {:?}", agent.id, focus);
        } else {
            println!("本机当前没有运行中的白名单桌面 AI 应用");
        }
        // 模拟控制台反复刷新 10 次：每次都是真枚举（缓存由命令层负责）。
        for attempt in 1..=10 {
            let started = Instant::now();
            let refreshed = snapshot_for_test(&dir).expect("refresh snapshot");
            println!(
                "refresh {}: {}ms running={}",
                attempt,
                started.elapsed().as_millis(),
                refreshed.agents.iter().filter(|agent| agent.running).count()
            );
        }
    }
}