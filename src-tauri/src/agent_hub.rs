//! 多 Agent 适配器 + 简单串行流水线（Agent Hub）。
//!
//! 设计取舍（见 docs/agent-hub.md）：
//! - 不引入 Dify / LangChain 等外部框架，直接用本机已安装的 CLI（codex / claude / doubao / dsh）
//!   作为「agent」，Rust 侧只负责探测、spawn、流式读 stdout、超时/取消与日志。
//! - 子进程以当前用户权限运行；可执行文件来自用户配置（`agent-hub/config.json`），
//!   代码只做白名单/元字符校验，绝不经过 shell 拼接 prompt。
//!   遇到 npm 的 `.cmd` shim 时优先解析出 `node <script>` 直接 spawn，绕开 cmd.exe 的二次解析。
//! - 不做复杂 DAG：流水线就是「上一步输出注入下一步模板的 {{prev}}」的串行编排。
//!
//! 前端事件：
//! - `agent-stream`      { streamId, agentId, line }  stdout 每一行
//! - `agent-stderr`      { streamId, agentId, line }  stderr 每一行
//! - `agent-pipeline-step` { runId, pipelineId, index, agentId, streamId }
//!
//! 命令：
//! - `get_agent_registry`  探测结果 + 流水线配置
//! - `agent_hub_status`    谁在跑 / 队列长度 / 最近错误
//! - `agent_hub_usage`     今日运行统计（读当天 jsonl）
//! - `agent_run`           跑单个 agent
//! - `agent_cancel`        取消（kill 进程树）
//! - `agent_pipeline`      按 steps 串行编排
//! - `agent_pipeline_run`  按配置里的 pipelineId 串行编排

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

/// 单次运行上限：300s（需求硬约束）。
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
/// 一次 prompt 最多 8000 字，避免把整本书塞进命令行。
const MAX_PROMPT_CHARS: usize = 8_000;
/// 流水线最多 6 步。
const MAX_PIPELINE_STEPS: usize = 6;
/// 单次输出缓存上限（防止 agent 刷屏把内存吃满）。
const MAX_OUTPUT_CHARS: usize = 400_000;
/// 全局并发上限 2、单 agent 并发上限 1。
const GLOBAL_CONCURRENCY: usize = 2;

const CONFIG_DIR: &str = "agent-hub";
const CONFIG_FILE: &str = "config.json";
const LOG_DIR: &str = "logs";

/// 不允许配置成 agent 的解释器：即使它们本身能跑，也等于把任意命令执行权交出去。
const FORBIDDEN_EXECUTABLES: &[&str] = &[
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "cscript",
    "cscript.exe",
    "wscript",
    "wscript.exe",
    "mshta",
    "mshta.exe",
    "rundll32",
    "rundll32.exe",
    "reg",
    "reg.exe",
    "schtasks",
    "schtasks.exe",
];

/// shell 元字符：出现在**命令名**里一律拒绝；出现在走 cmd.exe 兜底的参数里也拒绝。
const SHELL_METACHARS: &[char] = &['&', '|', '<', '>', '^', '%', '!', '"', '\'', ';', '`', '\r', '\n', '$'];

// ---------------------------------------------------------------------------
// 配置与注册表
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    pub agent_id: String,
    pub prompt_template: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSpec {
    pub id: String,
    pub title: String,
    pub description: String,
    pub steps: Vec<PipelineStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    pub id: String,
    pub display_name: String,
    /// codex / claude / doubao / dsh / custom
    pub kind: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 给用户看的补充说明（例如豆包没有 CLI 时怎么配置）。
    #[serde(default)]
    pub note: Option<String>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubConfig {
    #[serde(default)]
    agents: Vec<AgentSpec>,
    #[serde(default)]
    pipelines: Vec<PipelineSpec>,
    /// 桌面 AI 助手白名单（Claude / ChatGPT / Cursor / 豆包 …）。
    /// 空数组 = 使用 desktop_agents 模块的内置默认列表。
    #[serde(default)]
    pub(crate) desktop_agents: Vec<crate::desktop_agents::DesktopAgentSpec>,
}

/// 返回给前端的 agent 卡片数据。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub enabled: bool,
    pub available: bool,
    pub command: String,
    pub resolved_command: Option<String>,
    pub unavailable_reason: Option<String>,
    pub note: Option<String>,
    /// idle / queued / running
    pub status: String,
    pub queue_length: usize,
    pub last_error: Option<String>,
    pub prompt_preview: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub agents: Vec<AgentInfo>,
    pub pipelines: Vec<PipelineSpec>,
    pub config_path: String,
    pub log_dir: String,
    pub probed_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub stream_id: String,
    pub agent_id: String,
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub first_line_ms: Option<u64>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub log_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepResult {
    pub index: usize,
    pub agent_id: String,
    pub agent_name: String,
    pub stream_id: String,
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineResult {
    pub ok: bool,
    pub run_id: String,
    pub steps: Vec<PipelineStepResult>,
    /// 任一步失败时的中文原因（同时保留已完成步骤的输出）。
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAgentInfo {
    pub stream_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub pid: Option<u32>,
    pub started_at: u64,
    pub prompt_preview: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHubStatus {
    pub running: Vec<RunningAgentInfo>,
    pub queue: HashMap<String, usize>,
    pub recent_errors: Vec<Value>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageSummary {
    pub date: String,
    pub runs: u64,
    pub failures: u64,
    pub avg_duration_ms: u64,
    pub avg_first_line_ms: Option<u64>,
    pub log_path: String,
}

/// 进程内状态：谁在跑、谁在排队、最近错误。
struct RunningEntry {
    agent_id: String,
    agent_name: String,
    stream_id: String,
    pid: Option<u32>,
    started_at: u64,
    prompt_preview: String,
    cancel: Arc<AtomicBool>,
}

static RUNNING: Mutex<Option<HashMap<String, RunningEntry>>> = Mutex::new(None);
static QUEUE: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);
static PER_AGENT_SEMAPHORES: Mutex<Option<HashMap<String, Arc<tokio::sync::Semaphore>>>> =
    Mutex::new(None);
static GLOBAL_SEMAPHORE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
static RECENT_ERRORS: Mutex<Option<Vec<Value>>> = Mutex::new(None);
/// 探测缓存：同一进程里不做重复 where 查找。
static PROBE_CACHE: Mutex<Option<HashMap<String, (bool, Option<PathBuf>, Option<String>)>>> =
    Mutex::new(None);

fn global_semaphore() -> &'static tokio::sync::Semaphore {
    GLOBAL_SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(GLOBAL_CONCURRENCY))
}

fn per_agent_semaphore(agent_id: &str) -> Arc<tokio::sync::Semaphore> {
    let mut guard = PER_AGENT_SEMAPHORES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    map.entry(agent_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 配置加载 / 权限校验 / 可执行文件探测
// ---------------------------------------------------------------------------

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CONFIG_DIR))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

pub(crate) fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    config_dir(app).map(|dir| dir.join(LOG_DIR))
}

fn seed_config() -> HubConfig {
    let codex_args = vec![
        "exec".to_string(),
        "--skip-git-repo-check".to_string(),
        "{{prompt}}".to_string(),
    ];
    let claude_args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "text".to_string(),
        "{{prompt}}".to_string(),
    ];
    HubConfig {
        agents: vec![
            AgentSpec {
                id: "codex".into(),
                display_name: "Codex".into(),
                kind: "codex".into(),
                command: "codex.cmd".into(),
                args: codex_args,
                cwd: None,
                env: HashMap::new(),
                enabled: true,
                note: Some("OpenAI Codex CLI，非交互用 `codex exec`。".into()),
            },
            AgentSpec {
                id: "claude".into(),
                display_name: "Claude Code".into(),
                kind: "claude".into(),
                command: "claude.cmd".into(),
                args: claude_args,
                cwd: None,
                env: HashMap::new(),
                enabled: true,
                note: Some("Claude Code CLI，非交互用 `claude -p`。".into()),
            },
            AgentSpec {
                id: "doubao".into(),
                display_name: "豆包".into(),
                kind: "doubao".into(),
                command: "doubao".into(),
                args: vec!["{{prompt}}".into()],
                cwd: None,
                env: HashMap::new(),
                enabled: true,
                note: Some(
                    "豆包目前没有官方桌面 CLI；可把 command 指向你自备的包装脚本（.cmd/.ps1），\
或先禁用。不存在时会显示「未安装」。"
                        .into(),
                ),
            },
            AgentSpec {
                id: "dsh".into(),
                display_name: "DSH".into(),
                kind: "dsh".into(),
                command: "dsh.cmd".into(),
                args: vec![
                    "--profile".into(),
                    "headless".into(),
                    "--json".into(),
                    "{{prompt}}".into(),
                ],
                cwd: None,
                env: HashMap::new(),
                enabled: false,
                note: Some("默认关闭；需要先在 DSH 里登录/配好凭据，再手动启用。".into()),
            },
        ],
        pipelines: vec![
            PipelineSpec {
                id: "review".into(),
                title: "需求 → 方案 → 审阅".into(),
                description: "codex 先给实现方案，claude 再挑毛病；两步都只输出文字，不改文件。".into(),
                steps: vec![
                    PipelineStep {
                        agent_id: "codex".into(),
                        prompt_template: "请阅读下面的需求，给出可落地的代码修改方案（文件、函数、关键片段）。只输出方案，不要直接修改文件。\n\n需求：{{input}}".into(),
                    },
                    PipelineStep {
                        agent_id: "claude".into(),
                        prompt_template: "请审阅下面的实现方案，指出风险、遗漏和更好的做法，给出结论。\n\n方案：\n{{prev}}".into(),
                    },
                ],
            },
            PipelineSpec {
                id: "idea".into(),
                title: "点子 → 落地建议".into(),
                description: "豆包先发散点子，codex 再把点子拆成实施步骤。".into(),
                steps: vec![
                    PipelineStep {
                        agent_id: "doubao".into(),
                        prompt_template: "围绕下面的主题给 3 个具体、可执行的点子，每个一句话说明价值：\n\n{{input}}".into(),
                    },
                    PipelineStep {
                        agent_id: "codex".into(),
                        prompt_template: "把下面的点子整理成可落地的实施建议（步骤、涉及文件、风险）：\n\n{{prev}}".into(),
                    },
                ],
            },
        ],
        desktop_agents: crate::desktop_agents::default_desktop_agents(),
    }
}

pub(crate) fn read_or_seed_config(dir: &Path) -> Result<HubConfig, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("无法创建 agent 配置目录：{error}"))?;
    let path = dir.join(CONFIG_FILE);
    if !path.is_file() {
        let config = seed_config();
        let text = serde_json::to_string_pretty(&config)
            .map_err(|error| format!("无法序列化默认配置：{error}"))?;
        std::fs::write(&path, text).map_err(|error| format!("无法写入默认配置：{error}"))?;
        return Ok(config);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| {
        format!(
            "agent 配置解析失败（{}）：{error}。修好它或删掉后重启会重新生成默认配置。",
            path.display()
        )
    })
}

/// 命令名安全校验：拒绝元字符与解释器。
fn validate_command_name(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("未配置可执行文件（command 为空）。".into());
    }
    if trimmed.chars().any(|c| SHELL_METACHARS.contains(&c)) {
        return Err("命令里包含 shell 元字符（& | < > ^ % ! 引号 等），已拒绝。".into());
    }
    let base = Path::new(trimmed)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if FORBIDDEN_EXECUTABLES.contains(&base.as_str()) {
        return Err(format!(
            "出于安全考虑，不允许把 shell 解释器「{base}」配置成 agent；请填具体 CLI。"
        ));
    }
    Ok(())
}

/// 在 PATH（以及 npm 全局目录）里找可执行文件，不经过 shell 的 where。
fn search_path(command: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Programs"));
    }
    let has_extension = Path::new(command).extension().is_some();
    let extensions: &[&str] = if has_extension {
        &[""]
    } else {
        &[".exe", ".cmd", ".bat", ".ps1", ""]
    };
    for dir in dirs {
        for ext in extensions {
            let candidate = dir.join(format!("{command}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 解析可执行文件：绝对/相对路径要存在；裸名字走 PATH 搜索。
fn resolve_executable(command: &str) -> Result<PathBuf, String> {
    validate_command_name(command)?;
    let trimmed = command.trim();
    let looks_like_path = trimmed.contains('\\') || trimmed.contains('/') || Path::new(trimmed).is_absolute();
    if looks_like_path {
        let path = PathBuf::from(trimmed);
        let resolved = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|error| format!("无法读取当前目录：{error}"))?
                .join(path)
        };
        if resolved.is_file() {
            Ok(resolved)
        } else {
            Err(format!("找不到可执行文件：{}", resolved.display()))
        }
    } else {
        search_path(trimmed).ok_or_else(|| {
            format!("在 PATH 里没找到「{trimmed}」（也未在 %APPDATA%\\npm 找到）")
        })
    }
}

/// 带缓存的探测。缓存键是「配置里的 command」。
fn probe_command(command: &str) -> (bool, Option<PathBuf>, Option<String>) {
    {
        let guard = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_ref() {
            if let Some(hit) = map.get(command) {
                return hit.clone();
            }
        }
    }
    let result = match resolve_executable(command) {
        Ok(path) => (true, Some(path), None),
        Err(reason) => (false, None, Some(reason)),
    };
    let mut guard = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(command.to_string(), result.clone());
    result
}

fn running_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, RunningEntry>>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

fn queue_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, usize>>> {
    QUEUE.lock().unwrap_or_else(|e| e.into_inner())
}

fn push_recent_error(agent_id: &str, message: &str) {
    let mut guard = RECENT_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
    let list = guard.get_or_insert_with(Vec::new);
    list.push(json!({
        "at": now_ms(),
        "agentId": agent_id,
        "message": message.chars().take(240).collect::<String>(),
    }));
    while list.len() > 10 {
        list.remove(0);
    }
}

fn last_error_for(agent_id: &str) -> Option<String> {
    let guard = RECENT_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|list| {
        list.iter()
            .rev()
            .find(|entry| entry.get("agentId").and_then(Value::as_str) == Some(agent_id))
            .and_then(|entry| entry.get("message").and_then(Value::as_str))
            .map(str::to_string)
    })
}

fn build_registry(dir: &Path) -> Result<RegistrySnapshot, String> {
    let config = read_or_seed_config(dir)?;
    // 先在锁内把「谁在跑 / 队列」拷成快照，立刻释放锁；
    // 探测（读 PATH、stat 可执行文件）可能很慢，绝不能在持有 RUNNING/QUEUE 时做。
    let running_snapshot: Vec<(String, String)> = {
        let guard = running_map();
        guard
            .as_ref()
            .map(|map| {
                map.values()
                    .map(|entry| (entry.agent_id.clone(), entry.prompt_preview.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let queue_snapshot: HashMap<String, usize> = {
        let guard = queue_map();
        guard.clone().unwrap_or_default()
    };
    let agents = config
        .agents
        .iter()
        .map(|spec| {
            let (available, resolved, reason) = if spec.enabled {
                probe_command(&spec.command)
            } else {
                (false, None, Some("已在配置里禁用（enabled: false）。".into()))
            };
            let is_running = running_snapshot
                .iter()
                .any(|(agent_id, _)| *agent_id == spec.id);
            let queue_length = queue_snapshot.get(&spec.id).copied().unwrap_or(0);
            let prompt_preview = running_snapshot
                .iter()
                .find(|(agent_id, _)| *agent_id == spec.id)
                .map(|(_, preview)| preview.clone());
            AgentInfo {
                id: spec.id.clone(),
                display_name: spec.display_name.clone(),
                kind: spec.kind.clone(),
                enabled: spec.enabled,
                available,
                command: spec.command.clone(),
                resolved_command: resolved.map(|path| path.display().to_string()),
                unavailable_reason: reason,
                note: spec.note.clone(),
                status: if is_running {
                    "running".into()
                } else if queue_length > 0 {
                    "queued".into()
                } else {
                    "idle".into()
                },
                queue_length,
                last_error: last_error_for(&spec.id),
                prompt_preview,
            }
        })
        .collect();
    Ok(RegistrySnapshot {
        agents,
        pipelines: config.pipelines,
        config_path: dir.join(CONFIG_FILE).display().to_string(),
        log_dir: dir.join(LOG_DIR).display().to_string(),
        probed_at: now_ms(),
    })
}

fn find_agent(dir: &Path, agent_id: &str) -> Result<(AgentSpec, PathBuf), String> {
    let config = read_or_seed_config(dir)?;
    let spec = config
        .agents
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| format!("配置里没有 id 为「{agent_id}」的 agent。"))?;
    if !spec.enabled {
        return Err(format!("「{}」已在配置里禁用。", spec.display_name));
    }
    let (available, resolved, reason) = probe_command(&spec.command);
    if !available {
        return Err(format!(
            "「{}」未安装或不可用：{}",
            spec.display_name,
            reason.unwrap_or_else(|| "未知原因".into())
        ));
    }
    Ok((spec, resolved.expect("probe 成功时一定有路径")))
}

// ---------------------------------------------------------------------------
// 日期 / 日志
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn local_parts() -> (String, String) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: GetLocalTime 只读取当前时区时间，没有其它前提。
    let st = unsafe { GetLocalTime() };
    (
        format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay),
        format!("{:02}:{:02}:{:02}", st.wHour, st.wMinute, st.wSecond),
    )
}

#[cfg(not(windows))]
fn local_parts() -> (String, String) {
    let secs = now_ms() / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 简化版 civil_from_days（UTC）；非 Windows 只用于开发机自测。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!("{:02}:{:02}:{:02}", rem / 3600, (rem % 3600) / 60, rem % 60),
    )
}

fn log_path_for(log_dir: &Path, date: &str) -> PathBuf {
    log_dir.join(format!("agent-{date}.jsonl"))
}

/// 追加一行 JSONL。日志失败只 eprintln，不影响 agent 运行。
pub(crate) fn append_log(log_dir: &Path, entry: &Value) -> PathBuf {
    let (date, time) = local_parts();
    let path = log_path_for(log_dir, &date);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut line = entry.clone();
    if let Value::Object(map) = &mut line {
        map.insert("at".into(), Value::String(format!("{date} {time}")));
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut file) => {
            let _ = writeln!(file, "{line}");
        }
        Err(error) => eprintln!("agent-hub: 无法写日志 {}：{error}", path.display()),
    }
    path
}

/// P0 性能留痕：命令入口耗时 >200ms 时写一条 `SLOW_COMMAND` 到当天 jsonl。
/// 只记命令名与耗时，不记参数内容。
pub(crate) fn log_slow_command(app: &AppHandle, command: &str, duration_ms: u128) {
    if duration_ms < 200 {
        return;
    }
    let Ok(directory) = logs_dir(app) else {
        return;
    };
    append_log(
        &directory,
        &json!({
            "event": "SLOW_COMMAND",
            "command": command,
            "durationMs": duration_ms as u64,
        }),
    );
}

// ---------------------------------------------------------------------------
// 进程启动 / 流式读取
// ---------------------------------------------------------------------------

fn hidden_std_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// 从 npm 的 .cmd shim 里解析出 `node <script.js>`，避免走 cmd.exe。
/// npm 全局 shim 背后真正的入口：要么是 `node <script.js>`，要么是包内的原生 exe。
enum ShimTarget {
    Node(PathBuf, PathBuf),
    Exe(PathBuf),
}

/// 从 npm 的 .cmd shim 里解析出真实入口，避免走 cmd.exe 的二次解析。
/// 兼容两种常见写法：
/// - `"%_prog%" "%dp0%\node_modules\...\cli.js" %*`（codex 等）
/// - `"%dp0%\node_modules\...\claude.exe" %*`（Claude Code 的原生 exe）
fn npm_shim_target(shim: &Path) -> Option<ShimTarget> {
    let text = std::fs::read_to_string(shim).ok()?;
    if text.len() > 64 * 1024 {
        return None;
    }
    let shim_dir = shim.parent()?.to_path_buf();
    for raw in text.lines() {
        if !raw.contains("node_modules") {
            continue;
        }
        let mut remaining = raw;
        while let Some(open) = remaining.find('"') {
            let rest = &remaining[open + 1..];
            let Some(close) = rest.find('"') else { break };
            let candidate = &rest[..close];
            if candidate.contains("node_modules") {
                let expanded = candidate
                    .replace("%dp0%", &shim_dir.display().to_string())
                    .replace("%~dp0%", &shim_dir.display().to_string());
                let target = PathBuf::from(expanded);
                let lower = target.to_string_lossy().to_ascii_lowercase();
                if lower.ends_with(".exe") && target.is_file() {
                    return Some(ShimTarget::Exe(target));
                }
                if (lower.ends_with(".js") || lower.ends_with(".mjs")) && target.is_file() {
                    let sibling = shim_dir.join("node.exe");
                    let node = if sibling.is_file() {
                        sibling
                    } else {
                        search_path("node")?
                    };
                    return Some(ShimTarget::Node(node, target));
                }
            }
            remaining = &rest[close + 1..];
        }
    }
    None
}

fn comspec() -> PathBuf {
    std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("cmd.exe"))
}

fn powershell_exe() -> PathBuf {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let candidate = system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if candidate.is_file() {
        candidate
    } else {
        PathBuf::from("powershell.exe")
    }
}

fn expand_args(args: &[String], prompt: &str) -> Vec<String> {
    let mut used = false;
    let expanded = args
        .iter()
        .map(|arg| {
            if arg.contains("{{prompt}}") {
                used = true;
                arg.replace("{{prompt}}", prompt)
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>();
    let mut expanded = expanded;
    if !used {
        expanded.push(prompt.to_string());
    }
    expanded
}

/// 走 cmd.exe 兜底时的参数安全检查：任何元字符都拒绝，而不是尝试转义。
fn validate_args_for_shell(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg.chars().any(|c| SHELL_METACHARS.contains(&c)) {
            return Err(
                "这段内容包含 shell 元字符（& | < > ^ % ! 引号等），为安全起见已拒绝；\
请换一种说法，或把该 agent 的 command 换成真正的 .exe/.ps1（不经过 cmd.exe）。"
                    .into(),
            );
        }
    }
    Ok(())
}

fn build_command(
    spec: &AgentSpec,
    resolved: &Path,
    prompt: &str,
) -> Result<(Command, String), String> {
    let args = expand_args(&spec.args, prompt);
    let extension = resolved
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let (mut command, launcher) = if extension == "cmd" || extension == "bat" {
        match npm_shim_target(resolved) {
            Some(ShimTarget::Node(node, script)) => {
                let mut command = hidden_std_command(&node);
                command.arg(script);
                (command, format!("{} (npm shim)", node.display()))
            }
            Some(ShimTarget::Exe(program)) => {
                (hidden_std_command(&program), program.display().to_string())
            }
            None => {
                validate_args_for_shell(&args)?;
                let mut command = hidden_std_command(comspec());
                command.arg("/C").arg(resolved);
                (command, format!("{} /C", comspec().display()))
            }
        }
    } else if extension == "ps1" {
        // powershell -File 的参数不会二次拼接成命令字符串，但仍拒绝明显的元字符更稳妥。
        let mut command = hidden_std_command(powershell_exe());
        command
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(resolved);
        (command, format!("{} -File", powershell_exe().display()))
    } else {
        (hidden_std_command(resolved), resolved.display().to_string())
    };
    for arg in args {
        command.arg(arg);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = spec.cwd.as_deref().filter(|value| !value.trim().is_empty()) {
        let dir = PathBuf::from(cwd);
        if !dir.is_dir() {
            return Err(format!("配置的工作目录不存在：{}", dir.display()));
        }
        command.current_dir(dir);
    }
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    Ok((command, launcher))
}

fn kill_process_tree(pid: u32) -> bool {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let taskkill = system_root.join("System32").join("taskkill.exe");
    let program = if taskkill.is_file() {
        taskkill
    } else {
        PathBuf::from("taskkill.exe")
    };
    let status = hidden_std_command(program)
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(status, Ok(status) if status.success())
}

fn emit_event(app: &Option<AppHandle>, event: &str, payload: Value) {
    if let Some(app) = app {
        let _ = app.emit(event, payload);
    }
}

struct StreamSummary {
    output: String,
    first_line_ms: Option<u64>,
}

/// 读取 stdout：逐行 emit + 累积完整输出。
fn pump_stdout(
    stdout: std::process::ChildStdout,
    app: Option<AppHandle>,
    stream_id: String,
    agent_id: String,
    started: Instant,
    sender: mpsc::Sender<StreamSummary>,
) {
    let mut reader = BufReader::new(stdout);
    let mut output = String::new();
    let mut first_line_ms = None;
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = buf.trim_end_matches(['\r', '\n']).to_string();
                if first_line_ms.is_none() {
                    first_line_ms = Some(started.elapsed().as_millis() as u64);
                }
                if output.chars().count() < MAX_OUTPUT_CHARS {
                    output.push_str(&line);
                    output.push('\n');
                }
                emit_event(
                    &app,
                    "agent-stream",
                    json!({ "streamId": stream_id, "agentId": agent_id, "line": line }),
                );
            }
            Err(_) => break,
        }
    }
    let _ = sender.send(StreamSummary {
        output,
        first_line_ms,
    });
}

fn pump_stderr(
    stderr: std::process::ChildStderr,
    app: Option<AppHandle>,
    stream_id: String,
    agent_id: String,
    sender: mpsc::Sender<String>,
) {
    let mut reader = BufReader::new(stderr);
    let mut text = String::new();
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = buf.trim_end_matches(['\r', '\n']).to_string();
                if text.chars().count() < 20_000 {
                    text.push_str(&line);
                    text.push('\n');
                }
                emit_event(
                    &app,
                    "agent-stderr",
                    json!({ "streamId": stream_id, "agentId": agent_id, "line": line }),
                );
            }
            Err(_) => break,
        }
    }
    let _ = sender.send(text);
}

fn finish_child(child: &mut Child) {
    let pid = child.id();
    if pid != 0 {
        let _ = kill_process_tree(pid);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 阻塞执行一个 agent。超时/取消都 kill 进程树。
fn run_one_blocking(
    app: Option<AppHandle>,
    log_dir: &Path,
    spec: &AgentSpec,
    resolved: &Path,
    prompt: &str,
    stream_id: &str,
) -> AgentRunResult {
    let started = Instant::now();
    let preview: String = prompt.chars().take(80).collect();
    let preview = preview.replace(['\r', '\n'], " ");
    let base_log = json!({
        "agentId": spec.id,
        "agentName": spec.display_name,
        "kind": spec.kind,
        "streamId": stream_id,
        "promptPreview": preview,
        "promptLength": prompt.chars().count(),
    });

    if prompt.trim().is_empty() {
        let message = "没有给出要发给 agent 的内容。".to_string();
        push_recent_error(&spec.id, &message);
        return AgentRunResult {
            stream_id: stream_id.into(),
            agent_id: spec.id.clone(),
            ok: false,
            output: String::new(),
            error: Some(message),
            exit_code: None,
            duration_ms: started.elapsed().as_millis() as u64,
            first_line_ms: None,
            timed_out: false,
            cancelled: false,
            log_path: String::new(),
        };
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        let message = format!("内容太长了：最多 {MAX_PROMPT_CHARS} 字。");
        push_recent_error(&spec.id, &message);
        return AgentRunResult {
            stream_id: stream_id.into(),
            agent_id: spec.id.clone(),
            ok: false,
            output: String::new(),
            error: Some(message),
            exit_code: None,
            duration_ms: started.elapsed().as_millis() as u64,
            first_line_ms: None,
            timed_out: false,
            cancelled: false,
            log_path: String::new(),
        };
    }

    let (mut command, launcher) = match build_command(spec, resolved, prompt) {
        Ok(value) => value,
        Err(message) => {
            push_recent_error(&spec.id, &message);
            return AgentRunResult {
                stream_id: stream_id.into(),
                agent_id: spec.id.clone(),
                ok: false,
                output: String::new(),
                error: Some(message),
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                first_line_ms: None,
                timed_out: false,
                cancelled: false,
                log_path: String::new(),
            };
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = running_map();
        guard.get_or_insert_with(HashMap::new).insert(
            stream_id.to_string(),
            RunningEntry {
                agent_id: spec.id.clone(),
                agent_name: spec.display_name.clone(),
                stream_id: stream_id.to_string(),
                pid: None,
                started_at: now_ms(),
                prompt_preview: preview.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let mut start_entry = base_log.clone();
    if let Value::Object(map) = &mut start_entry {
        map.insert("event".into(), Value::String("start".into()));
        map.insert("launcher".into(), Value::String(launcher.clone()));
        map.insert(
            "resolvedCommand".into(),
            Value::String(resolved.display().to_string()),
        );
    }
    let log_path = append_log(log_dir, &start_entry);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("无法启动「{}」：{error}", spec.display_name);
            remove_running(stream_id);
            push_recent_error(&spec.id, &message);
            let mut end_entry = base_log;
            if let Value::Object(map) = &mut end_entry {
                map.insert("event".into(), Value::String("end".into()));
                map.insert("ok".into(), Value::Bool(false));
                map.insert("error".into(), Value::String(message.clone()));
            }
            append_log(log_dir, &end_entry);
            return AgentRunResult {
                stream_id: stream_id.into(),
                agent_id: spec.id.clone(),
                ok: false,
                output: String::new(),
                error: Some(message),
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                first_line_ms: None,
                timed_out: false,
                cancelled: false,
                log_path: log_path.display().to_string(),
            };
        }
    };

    let pid = child.id();
    if pid != 0 {
        if let Some(map) = running_map().as_mut() {
            if let Some(entry) = map.get_mut(stream_id) {
                entry.pid = Some(pid);
            }
        }
    }

    let (stdout_tx, stdout_rx) = mpsc::channel::<StreamSummary>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let stream = stream_id.to_string();
        let agent = spec.id.clone();
        thread::spawn(move || pump_stdout(stdout, app, stream, agent, started, stdout_tx));
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let stream = stream_id.to_string();
        let agent = spec.id.clone();
        thread::spawn(move || pump_stderr(stderr, app, stream, agent, stderr_tx));
    }

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    finish_child(&mut child);
                    break None;
                }
                if started.elapsed() >= RUN_TIMEOUT {
                    timed_out = true;
                    finish_child(&mut child);
                    break None;
                }
                thread::sleep(Duration::from_millis(60));
            }
            Err(error) => {
                push_recent_error(&spec.id, &format!("等待进程失败：{error}"));
                finish_child(&mut child);
                break None;
            }
        }
    };

    let summary = stdout_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(StreamSummary {
            output: String::new(),
            first_line_ms: None,
        });
    let stderr_text = stderr_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();

    remove_running(stream_id);

    let exit_code = exit_status.as_ref().and_then(|status| status.code());
    let ok = exit_status.as_ref().map(|status| status.success()).unwrap_or(false)
        && !timed_out
        && !cancelled;
    let mut error = None;
    if timed_out {
        error = Some(format!(
            "AGENT_TIMEOUT：{} 超过 {} 秒没跑完，已强制结束（日志里有记录）。",
            spec.display_name,
            RUN_TIMEOUT.as_secs()
        ));
    } else if cancelled {
        error = Some("已取消这次运行。".to_string());
    } else if !ok {
        let stderr_reason = stderr_text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        error = Some(if stderr_reason.is_empty() {
            format!(
                "「{}」退出异常（退出码 {}）。",
                spec.display_name,
                exit_code.map(|code| code.to_string()).unwrap_or_else(|| "未知".into())
            )
        } else {
            format!(
                "「{}」失败：{}",
                spec.display_name,
                stderr_reason.chars().take(300).collect::<String>()
            )
        });
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    let mut end_entry = base_log;
    if let Value::Object(map) = &mut end_entry {
        map.insert("event".into(), Value::String("end".into()));
        map.insert("ok".into(), Value::Bool(ok));
        map.insert("exitCode".into(), json!(exit_code));
        map.insert("durationMs".into(), json!(duration_ms));
        map.insert("firstLineMs".into(), json!(summary.first_line_ms));
        map.insert("timedOut".into(), json!(timed_out));
        map.insert("cancelled".into(), json!(cancelled));
        map.insert("error".into(), json!(error));
        map.insert(
            "stderrPreview".into(),
            Value::String(stderr_text.chars().take(200).collect()),
        );
    }
    let log_path = append_log(log_dir, &end_entry);

    if let Some(message) = error.as_deref() {
        push_recent_error(&spec.id, message);
    }

    AgentRunResult {
        stream_id: stream_id.to_string(),
        agent_id: spec.id.clone(),
        ok,
        output: summary.output.trim_end().to_string(),
        error,
        exit_code,
        duration_ms,
        first_line_ms: summary.first_line_ms,
        timed_out,
        cancelled,
        log_path: log_path.display().to_string(),
    }
}

fn remove_running(stream_id: &str) {
    if let Some(map) = running_map().as_mut() {
        map.remove(stream_id);
    }
}

// ---------------------------------------------------------------------------
// 并发槽位
// ---------------------------------------------------------------------------

struct QueueTicket {
    agent_id: String,
    active: bool,
}

impl QueueTicket {
    fn new(agent_id: &str) -> Self {
        {
            let mut guard = queue_map();
            let map = guard.get_or_insert_with(HashMap::new);
            *map.entry(agent_id.to_string()).or_insert(0) += 1;
        }
        Self {
            agent_id: agent_id.to_string(),
            active: true,
        }
    }

    fn release(mut self) {
        self.finish();
    }

    fn finish(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        let mut guard = queue_map();
        if let Some(map) = guard.as_mut() {
            if let Some(count) = map.get_mut(&self.agent_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    map.remove(&self.agent_id);
                }
            }
        }
    }
}

impl Drop for QueueTicket {
    fn drop(&mut self) {
        self.finish();
    }
}

async fn acquire_slot(
    agent_id: &str,
) -> Result<
    (
        tokio::sync::OwnedSemaphorePermit,
        tokio::sync::SemaphorePermit<'static>,
    ),
    String,
> {
    let ticket = QueueTicket::new(agent_id);
    let per_agent = per_agent_semaphore(agent_id);
    let per_permit = per_agent
        .acquire_owned()
        .await
        .map_err(|_| "agent 并发槽位已关闭。".to_string())?;
    let global_permit = global_semaphore()
        .acquire()
        .await
        .map_err(|_| "全局并发槽位已关闭。".to_string())?;
    ticket.release();
    Ok((per_permit, global_permit))
}

fn auto_stream_id(agent_id: &str) -> String {
    format!("{agent_id}-{}", now_ms())
}

// ---------------------------------------------------------------------------
// 命令：注册表 / 状态 / 用量
// ---------------------------------------------------------------------------

fn clear_probe_cache() {
    let mut guard = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// 注册表：**异步命令**。PATH 扫描 / stat 可执行文件都放进 blocking 线程，
/// 绝不在 main thread（Tauri 同步命令的执行线程）里做 IO。
#[tauri::command]
pub async fn get_agent_registry(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<RegistrySnapshot, String> {
    let started = Instant::now();
    let dir = config_dir(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if refresh.unwrap_or(false) {
            clear_probe_cache();
        }
        build_registry(&dir)
    })
    .await
    .map_err(|error| format!("agent 注册表线程失败：{error}"))?;
    log_slow_command(&app, "get_agent_registry", started.elapsed().as_millis());
    result
}

fn status_snapshot() -> AgentHubStatus {
    let running = {
        let guard = running_map();
        guard
            .as_ref()
            .map(|map| {
                map.values()
                    .map(|entry| RunningAgentInfo {
                        stream_id: entry.stream_id.clone(),
                        agent_id: entry.agent_id.clone(),
                        agent_name: entry.agent_name.clone(),
                        pid: entry.pid,
                        started_at: entry.started_at,
                        prompt_preview: entry.prompt_preview.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let queue = {
        let guard = queue_map();
        guard.clone().unwrap_or_default()
    };
    let recent_errors = {
        let guard = RECENT_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone().unwrap_or_default()
    };
    AgentHubStatus {
        running,
        queue,
        recent_errors,
    }
}

#[tauri::command]
pub async fn agent_hub_status(app: AppHandle) -> AgentHubStatus {
    let started = Instant::now();
    let status = tauri::async_runtime::spawn_blocking(status_snapshot)
        .await
        .unwrap_or_else(|_| AgentHubStatus {
            running: Vec::new(),
            queue: HashMap::new(),
            recent_errors: Vec::new(),
        });
    log_slow_command(&app, "agent_hub_status", started.elapsed().as_millis());
    status
}

fn usage_summary(log_dir: &Path) -> Result<AgentUsageSummary, String> {
    let (date, _) = local_parts();
    let path = log_path_for(log_dir, &date);
    let mut summary = AgentUsageSummary {
        date: date.clone(),
        log_path: path.display().to_string(),
        ..Default::default()
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(summary);
    };
    let mut total_duration: u64 = 0;
    let mut duration_samples: u64 = 0;
    let mut first_line_total: u64 = 0;
    let mut first_line_samples: u64 = 0;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("event").and_then(Value::as_str) != Some("end") {
            continue;
        }
        if value.get("pipelineId").is_some() {
            continue;
        }
        summary.runs += 1;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            summary.failures += 1;
        }
        if let Some(duration) = value.get("durationMs").and_then(Value::as_u64) {
            total_duration += duration;
            duration_samples += 1;
        }
        if let Some(first) = value.get("firstLineMs").and_then(Value::as_u64) {
            first_line_total += first;
            first_line_samples += 1;
        }
    }
    if duration_samples > 0 {
        summary.avg_duration_ms = total_duration / duration_samples;
    }
    if first_line_samples > 0 {
        summary.avg_first_line_ms = Some(first_line_total / first_line_samples);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn agent_hub_usage(app: AppHandle) -> Result<AgentUsageSummary, String> {
    let started = Instant::now();
    let log_dir = logs_dir(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || usage_summary(&log_dir))
        .await
        .map_err(|error| format!("agent 用量统计线程失败：{error}"))?;
    log_slow_command(&app, "agent_hub_usage", started.elapsed().as_millis());
    result
}

// ---------------------------------------------------------------------------
// 命令：单 agent 运行 / 取消
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_run(
    app: AppHandle,
    agent_id: String,
    prompt: String,
    stream_id: Option<String>,
) -> Result<AgentRunResult, String> {
    let started = Instant::now();
    let dir = config_dir(&app)?;
    // 解析命令 = PATH 扫描 + stat，放到 blocking 线程；async 命令的 worker 也不该做 IO。
    let probe_dir = dir.clone();
    let (spec, resolved) = tauri::async_runtime::spawn_blocking(move || find_agent(&probe_dir, &agent_id))
        .await
        .map_err(|error| format!("agent 探测线程失败：{error}"))??;
    let stream = stream_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| auto_stream_id(&spec.id));
    let log_dir = dir.join(LOG_DIR);
    let (_permit, _global) = acquire_slot(&spec.id).await?;
    let emit_app = Some(app.clone());
    let spec_for_task = spec.clone();
    let stream_for_task = stream.clone();
    let prompt_for_task = prompt.clone();
    let log_dir_for_task = log_dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_one_blocking(
            emit_app,
            &log_dir_for_task,
            &spec_for_task,
            &resolved,
            &prompt_for_task,
            &stream_for_task,
        )
    })
    .await
    .map_err(|error| format!("agent 运行线程失败：{error}"));
    log_slow_command(&app, "agent_run", started.elapsed().as_millis());
    result
}

/// 取消：锁内只置标记 / 取 pid，`taskkill`（同步等待）放到 blocking 线程，
/// 避免阻塞 main thread；返回是否真的杀到了进程。
#[tauri::command]
pub async fn agent_cancel(app: AppHandle, stream_id: String) -> bool {
    let started = Instant::now();
    let target = {
        let guard = running_map();
        guard.as_ref().and_then(|map| {
            map.get(&stream_id).map(|entry| {
                entry.cancel.store(true, Ordering::SeqCst);
                (entry.agent_id.clone(), entry.pid)
            })
        })
    };
    let Some((agent_id, pid)) = target else {
        log_slow_command(&app, "agent_cancel", started.elapsed().as_millis());
        return false;
    };
    push_recent_error(&agent_id, "用户取消了这次运行。");
    let Some(pid) = pid else {
        log_slow_command(&app, "agent_cancel", started.elapsed().as_millis());
        return false;
    };
    let killed = tauri::async_runtime::spawn_blocking(move || kill_process_tree(pid))
        .await
        .unwrap_or(false);
    log_slow_command(&app, "agent_cancel", started.elapsed().as_millis());
    killed
}

// ---------------------------------------------------------------------------
// 命令：流水线
// ---------------------------------------------------------------------------

fn fill_template(template: &str, input: &str, prev: &str) -> String {
    template
        .replace("{{prev}}", prev)
        .replace("{{input}}", input)
}

fn validate_steps(steps: &[PipelineStep]) -> Result<(), String> {
    if steps.is_empty() {
        return Err("流水线至少要有一步。".into());
    }
    if steps.len() > MAX_PIPELINE_STEPS {
        return Err(format!("流水线最多 {MAX_PIPELINE_STEPS} 步。"));
    }
    if steps.iter().any(|step| step.agent_id.trim().is_empty()) {
        return Err("流水线里缺少 agentId。".into());
    }
    Ok(())
}

fn pipeline_run_id(run_id: Option<String>) -> String {
    run_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("pipeline-{}", now_ms()))
}

#[tauri::command]
pub async fn agent_pipeline(
    app: AppHandle,
    steps: Vec<PipelineStep>,
    input: String,
    run_id: Option<String>,
    pipeline_id: Option<String>,
) -> Result<PipelineResult, String> {
    validate_steps(&steps)?;
    let started = Instant::now();
    let dir = config_dir(&app)?;
    let run = pipeline_run_id(run_id);
    let pipeline_label = pipeline_id.unwrap_or_else(|| "custom".into());
    let mut results = Vec::new();
    let mut prev = input.clone();
    let mut first_error = None;
    for (index, step) in steps.iter().enumerate() {
        let stream = format!("{run}-s{}", index + 1);
        emit_event(
            &Some(app.clone()),
            "agent-pipeline-step",
            json!({
                "runId": run,
                "pipelineId": pipeline_label,
                "index": index,
                "agentId": step.agent_id,
                "streamId": stream,
            }),
        );
        let probe_dir = dir.clone();
        let probe_id = step.agent_id.clone();
        let probe = tauri::async_runtime::spawn_blocking(move || find_agent(&probe_dir, &probe_id))
            .await
            .map_err(|error| format!("第 {} 步探测线程失败：{error}", index + 1))?;
        let (spec, resolved) = match probe {
            Ok(value) => value,
            Err(message) => {
                first_error = Some(format!("第 {} 步失败：{message}", index + 1));
                break;
            }
        };
        let prompt = fill_template(&step.prompt_template, &input, &prev);
        if prompt.trim().is_empty() {
            first_error = Some(format!("第 {} 步的 prompt 是空的。", index + 1));
            break;
        }
        let log_dir = dir.join(LOG_DIR);
        let _permit = match acquire_slot(&spec.id).await {
            Ok(value) => value,
            Err(message) => {
                first_error = Some(format!("第 {} 步失败：{message}", index + 1));
                break;
            }
        };
        let spec_name = spec.display_name.clone();
        let app_for_task = app.clone();
        let log_dir_for_task = log_dir.clone();
        let stream_for_task = stream.clone();
        let step_label = pipeline_label.clone();
        let step_index = index;
        let step_result = tauri::async_runtime::spawn_blocking(move || {
            let result = run_one_blocking(
                Some(app_for_task),
                &log_dir_for_task,
                &spec,
                &resolved,
                &prompt,
                &stream_for_task,
            );
            // 流水线步骤额外写一条带 pipeline 标记的日志，便于在 jsonl 里区分。
            let mut entry = json!({
                "event": "pipeline-step",
                "pipelineId": step_label,
                "step": step_index,
                "agentId": result.agent_id,
                "ok": result.ok,
                "durationMs": result.duration_ms,
            });
            if let Value::Object(map) = &mut entry {
                map.insert("streamId".into(), Value::String(result.stream_id.clone()));
                map.insert("error".into(), json!(result.error));
            }
            append_log(&log_dir_for_task, &entry);
            (result, spec_name)
        })
        .await
        .map_err(|error| format!("第 {} 步线程失败：{error}", index + 1))?;

        let (result, agent_name) = step_result;
        results.push(PipelineStepResult {
            index,
            agent_id: result.agent_id.clone(),
            agent_name: agent_name.clone(),
            stream_id: result.stream_id.clone(),
            ok: result.ok,
            output: result.output.clone(),
            error: result.error.clone(),
            duration_ms: result.duration_ms,
        });
        if !result.ok {
            first_error = Some(format!(
                "第 {} 步（{agent_name}）失败：{}",
                index + 1,
                result
                    .error
                    .clone()
                    .unwrap_or_else(|| "未知原因".into())
            ));
            break;
        }
        prev = result.output;
    }
    let output = PipelineResult {
        ok: first_error.is_none(),
        run_id: run,
        steps: results,
        error: first_error,
    };
    log_slow_command(&app, "agent_pipeline", started.elapsed().as_millis());
    Ok(output)
}

#[tauri::command]
pub async fn agent_pipeline_run(
    app: AppHandle,
    pipeline_id: String,
    input: String,
    run_id: Option<String>,
) -> Result<PipelineResult, String> {
    let started = Instant::now();
    let dir = config_dir(&app)?;
    let config = read_or_seed_config(&dir)?;
    let pipeline = config
        .pipelines
        .into_iter()
        .find(|pipeline| pipeline.id == pipeline_id)
        .ok_or_else(|| format!("配置里没有 id 为「{pipeline_id}」的流水线。"))?;
    let result = agent_pipeline(app.clone(), pipeline.steps, input, run_id, Some(pipeline_id)).await;
    log_slow_command(&app, "agent_pipeline_run", started.elapsed().as_millis());
    result
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录放在工作区里：部分 Windows 环境对 `%TEMP%` 没有写权限
    /// （os error 5），用工作区目录最稳；可用 MALTESE_AGENT_HUB_TEST_DIR 覆盖。
    fn test_dir(tag: &str) -> PathBuf {
        let base = std::env::var_os("MALTESE_AGENT_HUB_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(".tmp-agent-hub-tests")
            });
        let dir = base.join(format!("{tag}-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn expands_prompt_placeholder_or_appends() {
        let args = vec!["exec".to_string(), "{{prompt}}".to_string()];
        assert_eq!(
            expand_args(&args, "你好"),
            vec!["exec".to_string(), "你好".to_string()]
        );
        let plain = vec!["-p".to_string(), "text".to_string()];
        assert_eq!(
            expand_args(&plain, "汪"),
            vec!["-p".to_string(), "text".to_string(), "汪".to_string()]
        );
    }

    #[test]
    fn rejects_shell_metacharacters_in_command_names() {
        assert!(validate_command_name("codex.cmd").is_ok());
        assert!(validate_command_name("codex & calc").is_err());
        assert!(validate_command_name("cmd.exe").is_err());
        assert!(validate_command_name("powershell").is_err());
        assert!(validate_command_name("").is_err());
    }

    #[test]
    fn rejects_metacharacters_when_going_through_cmd() {
        assert!(validate_args_for_shell(&["--print".into(), "hello world".into()]).is_ok());
        assert!(validate_args_for_shell(&["--print".into(), "a & calc".into()]).is_err());
        assert!(validate_args_for_shell(&["%USERPROFILE%".into()]).is_err());
    }

    #[test]
    fn fills_pipeline_template() {
        let text = fill_template("需求：{{input}}\n上一步：{{prev}}", "做个控制台", "方案 A");
        assert!(text.contains("做个控制台"));
        assert!(text.contains("方案 A"));
    }

    #[test]
    fn rejects_empty_or_oversized_pipelines() {
        assert!(validate_steps(&[]).is_err());
        let many = (0..MAX_PIPELINE_STEPS + 1)
            .map(|_| PipelineStep {
                agent_id: "codex".into(),
                prompt_template: "x".into(),
            })
            .collect::<Vec<_>>();
        assert!(validate_steps(&many).is_err());
        assert!(validate_steps(&[PipelineStep {
            agent_id: "codex".into(),
            prompt_template: "x".into(),
        }])
        .is_ok());
    }

    #[test]
    fn date_and_log_path_have_expected_shape() {
        let (date, time) = local_parts();
        assert_eq!(date.len(), 10, "date={date}");
        assert_eq!(time.len(), 8, "time={time}");
        let path = log_path_for(Path::new(r"C:\logs"), "2026-11-19");
        assert!(path.ends_with("agent-2026-11-19.jsonl"));
    }

    #[test]
    fn npm_shim_is_parsed_to_node_script() {
        let dir = test_dir("shim");
        std::fs::create_dir_all(dir.join("node_modules/@openai/codex/bin")).unwrap();
        let script = dir.join("node_modules/@openai/codex/bin/codex.js");
        std::fs::write(&script, "// stub").unwrap();
        let node = dir.join("node.exe");
        std::fs::write(&node, "").unwrap();
        let shim = dir.join("codex.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
        )
        .unwrap();
        match npm_shim_target(&shim).expect("should resolve") {
            ShimTarget::Node(resolved_node, resolved_script) => {
                assert_eq!(resolved_node, node);
                assert_eq!(resolved_script, script);
            }
            ShimTarget::Exe(program) => panic!("expected node shim, got exe {}", program.display()),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npm_shim_native_exe_is_used_directly() {
        let dir = test_dir("shim-exe");
        let bin = dir.join("node_modules/@anthropic-ai/claude-code/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("claude.exe");
        std::fs::write(&exe, "").unwrap();
        let shim = dir.join("claude.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*",
        )
        .unwrap();
        match npm_shim_target(&shim).expect("should resolve exe") {
            ShimTarget::Exe(program) => assert_eq!(program, exe),
            ShimTarget::Node(node, script) => {
                panic!("expected exe, got node {} {}", node.display(), script.display())
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seeded_config_has_two_pipelines() {
        let config = seed_config();
        assert!(config.agents.iter().any(|agent| agent.id == "codex"));
        assert!(config.agents.iter().any(|agent| agent.id == "claude"));
        assert!(config.agents.iter().any(|agent| agent.id == "doubao"));
        assert!(config.pipelines.iter().any(|item| item.id == "review"));
        assert!(config.pipelines.iter().any(|item| item.id == "idea"));
        for pipeline in &config.pipelines {
            assert!(!pipeline.steps.is_empty());
        }
    }

    /// 实机联调：两步流水线（codex → claude），验证 {{prev}} 注入。
    /// 手动执行：`cargo test --lib agent_hub::tests::real_pipeline_codex_then_claude -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_pipeline_codex_then_claude() {
        let dir = test_dir("pipeline");
        let log_dir = dir.join(LOG_DIR);
        let (codex, codex_path) = find_agent(&dir, "codex").expect("codex should be available");
        let first = run_one_blocking(
            None,
            &log_dir,
            &codex,
            &codex_path,
            "只输出一个词：CODEX_OK",
            "pipe-1",
        );
        println!(
            "step1 ok={} duration={}ms output={:?} error={:?}",
            first.ok, first.duration_ms, first.output, first.error
        );
        assert!(first.ok, "codex 第一步失败：{:?}", first.error);
        let (claude, claude_path) = find_agent(&dir, "claude").expect("claude should be available");
        let prompt = fill_template(
            "上一步的输出是：\n{{prev}}\n如果它包含 CODEX_OK，只回答 PIPELINE_OK，不要解释。",
            "",
            &first.output,
        );
        let second = run_one_blocking(None, &log_dir, &claude, &claude_path, &prompt, "pipe-2");
        println!(
            "step2 ok={} duration={}ms output={:?} error={:?}",
            second.ok, second.duration_ms, second.output, second.error
        );
        assert!(second.ok, "claude 第二步失败：{:?}", second.error);
        println!("pipeline log dir: {}", log_dir.display());
    }

    /// 实机联调（备用）：claude 两步流水线，验证串行 + {{prev}} 注入。
    /// 有些受限环境里 codex 的 app-server 起不来（os error 5），但 claude 可用；
    /// 用它证明「上一步输出注入下一步」这条编排链路是通的。
    #[test]
    #[ignore]
    fn real_pipeline_claude_twice() {
        let dir = test_dir("pipeline-claude");
        let log_dir = dir.join(LOG_DIR);
        let (claude, claude_path) = find_agent(&dir, "claude").expect("claude should be available");
        let first = run_one_blocking(
            None,
            &log_dir,
            &claude,
            &claude_path,
            "只输出一个词：READY",
            "pipe-c1",
        );
        println!(
            "step1 ok={} duration={}ms output={:?} error={:?}",
            first.ok, first.duration_ms, first.output, first.error
        );
        assert!(first.ok, "claude 第一步失败：{:?}", first.error);
        let prompt = fill_template(
            "上一步的输出是：\n{{prev}}\n请原样复述它，并在后面加上 PIPELINE_OK，不要解释。",
            "",
            &first.output,
        );
        let second = run_one_blocking(None, &log_dir, &claude, &claude_path, &prompt, "pipe-c2");
        println!(
            "step2 ok={} duration={}ms output={:?} error={:?}",
            second.ok, second.duration_ms, second.output, second.error
        );
        assert!(second.ok, "claude 第二步失败：{:?}", second.error);
        println!("pipeline log dir: {}", log_dir.display());
    }

    /// 实机联调用：手动执行
    /// `cargo test --lib agent_hub::tests::real_agent_run -- --ignored --nocapture`
    /// 它会真的启动 codex/claude，需要本机已安装并登录。
    #[test]
    #[ignore]
    fn real_agent_run() {
        let dir = test_dir("real");
        let registry = build_registry(&dir).expect("registry");
        println!("config: {}", registry.config_path);
        for agent in &registry.agents {
            println!(
                "agent {} available={} reason={:?} resolved={:?}",
                agent.id, agent.available, agent.unavailable_reason, agent.resolved_command
            );
        }
        let (spec, resolved) = find_agent(&dir, "claude").expect("claude should be available");
        let result = run_one_blocking(
            None,
            &dir.join(LOG_DIR),
            &spec,
            &resolved,
            "只回答两个字母：OK",
            "real-test-1",
        );
        println!(
            "ok={} exit={:?} duration={}ms firstLine={:?} output={:?}",
            result.ok, result.exit_code, result.duration_ms, result.first_line_ms, result.output
        );
        println!("log={}", result.log_path);
        if let Ok(text) = std::fs::read_to_string(&result.log_path) {
            println!("--- log contents ---\n{text}");
        }
        assert!(!result.output.is_empty(), "claude 应该有输出");
    }
}