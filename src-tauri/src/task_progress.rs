//! 对话任务进度状态机（MVP）。
//!
//! 目标：把「小狗正在做什么」从零散的面板数据收敛成一条任务时间线：
//! - 确定性来源优先：视频用 `video_get_snapshot`、agent 用 pipeline 步骤事件、技能用
//!   `runSkill` 前后上报（前端 invoke 命令）；
//! - 兜底推断只做补充，不覆盖确定性状态；
//! - 内存表 + 按天 JSONL（`<agent-hub>/logs/tasks-YYYY-MM-DD.jsonl`），保留最近 20 条；
//! - 超过预期时长 2× 没有更新 → `stalled`（search 120s / agent 300s / video 按 maxMinutes /
//!   daily 10min，其余用小默认）。
//!
//! 阶段流转：
//! `requested → planning → executing → waiting_confirm → delivering → done/failed/cancelled/stalled`
//! 只允许合法前进；`task_end` 只能落到终态。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use crate::agent_hub;

pub const KINDS: [&str; 8] = [
    "chat", "search", "settings", "todo", "video", "daily", "agent", "other",
];
pub const STAGES: [&str; 9] = [
    "requested",
    "planning",
    "executing",
    "waiting_confirm",
    "delivering",
    "done",
    "failed",
    "cancelled",
    "stalled",
];
const TERMINAL_STAGES: [&str; 4] = ["done", "failed", "cancelled", "stalled"];
const MAX_TASKS: usize = 20;
const DEFAULT_LIMIT: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressCount {
    pub current: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub id: String,
    pub kind: String,
    pub stage: String,
    pub title: String,
    pub source: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub expected_secs: u64,
    pub progress: Option<TaskProgressCount>,
    pub detail: Option<String>,
    pub error: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListSnapshot {
    pub tasks: Vec<TaskProgress>,
    pub revision: u64,
    pub now: u64,
    pub active_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredTask {
    pub task: String,
    pub stage: String,
    pub confidence: f64,
}

struct Store {
    tasks: Vec<TaskProgress>,
    revision: u64,
    video_task_id: Option<String>,
    counter: u64,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn default_expected_secs(kind: &str) -> u64 {
    match kind {
        "search" => 120,
        "agent" => 300,
        "daily" => 600,
        "video" => 1_800,
        "settings" | "todo" => 60,
        _ => 120,
    }
}

fn is_terminal(stage: &str) -> bool {
    TERMINAL_STAGES.contains(&stage)
}

fn valid_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    match from {
        "requested" => matches!(to, "planning" | "executing" | "cancelled"),
        "planning" => matches!(to, "executing" | "waiting_confirm" | "failed" | "cancelled"),
        "executing" => matches!(
            to,
            "waiting_confirm" | "delivering" | "done" | "failed" | "cancelled" | "stalled"
        ),
        "waiting_confirm" => matches!(to, "delivering" | "done" | "failed" | "cancelled" | "stalled"),
        "delivering" => matches!(to, "done" | "failed" | "cancelled"),
        _ => false,
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("未知任务类型：{kind}"))
    }
}

fn validate_stage(stage: &str) -> Result<(), String> {
    if STAGES.contains(&stage) {
        Ok(())
    } else {
        Err(format!("未知任务阶段：{stage}"))
    }
}

fn store_lock() -> std::sync::MutexGuard<'static, Option<Store>> {
    STORE.lock().unwrap_or_else(|error| error.into_inner())
}

fn ensure_store<'a>(guard: &'a mut std::sync::MutexGuard<'static, Option<Store>>) -> &'a mut Store {
    guard.get_or_insert_with(|| Store {
        tasks: Vec::new(),
        revision: 0,
        video_task_id: None,
        counter: 0,
    })
}

fn push_task(store: &mut Store, mut task: TaskProgress) -> TaskProgress {
    store.revision += 1;
    task.revision = store.revision;
    store.tasks.push(task.clone());
    trim_tasks(store);
    task
}

fn trim_tasks(store: &mut Store) {
    while store.tasks.len() > MAX_TASKS {
        let terminal = store
            .tasks
            .iter()
            .position(|task| is_terminal(&task.stage))
            .unwrap_or(0);
        store.tasks.remove(terminal);
    }
}

#[cfg(test)]
fn find_task<'a>(store: &'a mut Store, id: &str) -> Option<&'a mut TaskProgress> {
    store.tasks.iter_mut().find(|task| task.id == id)
}

fn task_is_active(store: &Store, id: &str) -> bool {
    store
        .tasks
        .iter()
        .any(|task| task.id == id && !is_terminal(&task.stage))
}

/// 同时改任务字段与全局 revision，避免 `&mut store` 与 `&mut task` 双重借用。
fn mutate_task<R>(
    store: &mut Store,
    id: &str,
    update: impl FnOnce(&mut TaskProgress, &mut u64) -> R,
) -> Option<R> {
    let index = store.tasks.iter().position(|task| task.id == id)?;
    let Store { tasks, revision, .. } = store;
    Some(update(&mut tasks[index], revision))
}

// ---------------------------------------------------------------------------
// JSONL 落盘
// ---------------------------------------------------------------------------

pub(crate) fn task_log_path(log_dir: &Path, date: &str) -> PathBuf {
    log_dir.join(format!("tasks-{date}.jsonl"))
}

fn append_task_log(log_dir: &Path, entry: &Value) -> PathBuf {
    let (date, time) = agent_hub::local_parts();
    let path = task_log_path(log_dir, &date);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut line = entry.clone();
    if let Value::Object(map) = &mut line {
        map.insert("at".into(), Value::String(format!("{date} {time}")));
    }
    let text = format!("{line}\n");
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write;
            let _ = file.write_all(text.as_bytes());
        }
        Err(error) => eprintln!("task-progress: 无法写日志 {}：{error}", path.display()),
    }
    path
}

fn log_transition(log_dir: &Path, task: &TaskProgress, event: &str) {
    append_task_log(
        log_dir,
        &json!({
            "event": event,
            "taskId": task.id,
            "kind": task.kind,
            "stage": task.stage,
            "title": task.title,
            "source": task.source,
            "progress": task.progress,
            "detail": task.detail,
            "error": task.error,
            "startedAt": task.started_at,
            "updatedAt": task.updated_at,
            "expectedSecs": task.expected_secs,
        }),
    );
}

// ---------------------------------------------------------------------------
// 超时检测
// ---------------------------------------------------------------------------

fn sweep_stalled_with(store: &mut Store, log_dir: &Path, now: u64) -> Vec<TaskProgress> {
    let mut changed = Vec::new();
    for index in 0..store.tasks.len() {
        if is_terminal(&store.tasks[index].stage) {
            continue;
        }
        let expected = store.tasks[index].expected_secs;
        let updated = store.tasks[index].updated_at;
        let limit_ms = expected.saturating_mul(2).saturating_mul(1000);
        if limit_ms > 0 && now.saturating_sub(updated) >= limit_ms {
            store.revision += 1;
            let revision = store.revision;
            let task = &mut store.tasks[index];
            task.stage = "stalled".into();
            task.updated_at = now;
            task.revision = revision;
            task.error = Some("超过预期时长 2× 没有更新，已标记为停滞。".into());
            changed.push(task.clone());
        }
    }
    for task in &changed {
        log_transition(log_dir, task, "stalled");
    }
    changed
}

// ---------------------------------------------------------------------------
// 核心操作（供命令 / agent_hub / 测试调用）
// ---------------------------------------------------------------------------

pub(crate) fn begin(
    log_dir: &Path,
    kind: &str,
    title: &str,
    id: Option<String>,
    expected_secs: Option<u64>,
    source: &str,
) -> Result<TaskProgress, String> {
    validate_kind(kind)?;
    let now = now_ms();
    let mut guard = store_lock();
    let store = ensure_store(&mut guard);
    sweep_stalled_with(store, log_dir, now);
    let task_id = id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            store.counter += 1;
            format!("{kind}-{now}-{}", store.counter)
        });
    if store
        .tasks
        .iter()
        .any(|task| task.id == task_id && !is_terminal(&task.stage))
    {
        return Err(format!("任务 {task_id} 仍在进行中"));
    }
    let task = TaskProgress {
        id: task_id,
        kind: kind.to_string(),
        stage: "requested".to_string(),
        title: title.chars().take(120).collect(),
        source: source.to_string(),
        started_at: now,
        updated_at: now,
        expected_secs: expected_secs.unwrap_or_else(|| default_expected_secs(kind)),
        progress: None,
        detail: None,
        error: None,
        revision: 0,
    };
    let task = push_task(store, task);
    drop(guard);
    log_transition(log_dir, &task, "begin");
    Ok(task)
}

/// 日志降噪：纯心跳（stage / progress.current / detail 都没变）不写盘，
/// 但内存里的 updated_at 仍会更新，stalled 判定不受影响。
fn should_log_advance(previous: &TaskProgress, next: &TaskProgress) -> bool {
    if previous.stage != next.stage {
        return true;
    }
    let previous_current = previous.progress.as_ref().map(|progress| progress.current);
    let next_current = next.progress.as_ref().map(|progress| progress.current);
    if previous_current != next_current {
        return true;
    }
    previous.detail != next.detail
}

/// 视频进度口径：按「每条 15s」估算总条数（30 分钟 ≈ 120 条），
/// 避免出现 total = current 导致进度条永远 100%。
fn estimated_video_total(max_minutes: u64) -> u32 {
    let estimate = max_minutes.saturating_mul(60 / 15);
    u32::try_from(estimate).unwrap_or(u32::MAX).max(1)
}

pub(crate) fn advance(
    log_dir: &Path,
    id: &str,
    stage: &str,
    progress: Option<TaskProgressCount>,
    detail: Option<&str>,
) -> Result<TaskProgress, String> {
    validate_stage(stage)?;
    if is_terminal(stage) {
        return Err("终态请用 task_end 结束任务。".into());
    }
    let now = now_ms();
    let mut guard = store_lock();
    let store = ensure_store(&mut guard);
    sweep_stalled_with(store, log_dir, now);
    let updated = mutate_task(store, id, |task, revision| -> Result<(TaskProgress, bool), String> {
        if is_terminal(&task.stage) {
            return Err(format!("任务 {id} 已结束（{}）", task.stage));
        }
        if !valid_transition(&task.stage, stage) {
            return Err(format!("非法阶段流转：{} → {}", task.stage, stage));
        }
        let previous = task.clone();
        *revision += 1;
        task.revision = *revision;
        task.stage = stage.to_string();
        task.updated_at = now;
        if let Some(progress) = progress {
            task.progress = Some(TaskProgressCount {
                current: progress.current,
                total: progress.total.max(progress.current),
            });
        }
        if let Some(detail) = detail {
            task.detail = Some(detail.chars().take(240).collect());
        }
        let loggable = should_log_advance(&previous, task);
        Ok((task.clone(), loggable))
    })
    .ok_or_else(|| format!("找不到任务 {id}"))??;
    drop(guard);
    let (task, loggable) = updated;
    if loggable {
        log_transition(log_dir, &task, "advance");
    }
    Ok(task)
}

pub(crate) fn end(
    log_dir: &Path,
    id: &str,
    stage: &str,
    error: Option<&str>,
    detail: Option<&str>,
) -> Result<TaskProgress, String> {
    validate_stage(stage)?;
    if !is_terminal(stage) {
        return Err("只能结束到 done / failed / cancelled / stalled。".into());
    }
    let now = now_ms();
    let mut guard = store_lock();
    let store = ensure_store(&mut guard);
    sweep_stalled_with(store, log_dir, now);
    let updated = mutate_task(store, id, |task, revision| -> (TaskProgress, bool) {
        let previous = task.clone();
        if !is_terminal(&task.stage) {
            *revision += 1;
            task.revision = *revision;
            task.stage = stage.to_string();
            task.updated_at = now;
            if let Some(error) = error {
                task.error = Some(error.chars().take(240).collect());
            }
            if let Some(detail) = detail {
                task.detail = Some(detail.chars().take(240).collect());
            }
        }
        (task.clone(), previous.stage != task.stage)
    })
    .ok_or_else(|| format!("找不到任务 {id}"))?;
    drop(guard);
    let (task, changed) = updated;
    if changed {
        log_transition(log_dir, &task, "end");
    }
    Ok(task)
}

#[cfg(test)]
pub(crate) fn snapshot_with_video(
    log_dir: &Path,
    limit: usize,
    video: &crate::video::session::VideoSnapshot,
) -> TaskListSnapshot {
    snapshot_inner(log_dir, limit, Some(video))
}

fn snapshot_inner(
    log_dir: &Path,
    limit: usize,
    video: Option<&crate::video::session::VideoSnapshot>,
) -> TaskListSnapshot {
    let now = now_ms();
    let mut guard = store_lock();
    let store = ensure_store(&mut guard);
    sweep_stalled_with(store, log_dir, now);
    if let Some(video) = video {
        sync_video(store, log_dir, video, now);
    }
    let mut tasks = store.tasks.clone();
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    tasks.truncate(limit.max(1));
    let active_count = tasks.iter().filter(|task| !is_terminal(&task.stage)).count();
    TaskListSnapshot {
        tasks,
        revision: store.revision,
        now,
        active_count,
    }
}

#[cfg(test)]
pub(crate) fn snapshot(log_dir: &Path, limit: usize) -> TaskListSnapshot {
    snapshot_inner(log_dir, limit, None)
}

// ---------------------------------------------------------------------------
// 视频：确定性上报（video_get_snapshot → video 任务）
// ---------------------------------------------------------------------------

fn sync_video(
    store: &mut Store,
    log_dir: &Path,
    video: &crate::video::session::VideoSnapshot,
    now: u64,
) {
    use crate::video::model::Phase;
    let active = store.video_task_id.clone();
    let running_phase = video.running
        || !matches!(
            video.phase,
            Phase::Idle | Phase::Ended | Phase::Stopped | Phase::Interrupted | Phase::Blocked
        );
    if running_phase {
        let stage = match video.phase {
            Phase::Digesting => "delivering",
            Phase::AwaitingLogin => "waiting_confirm",
            _ => "executing",
        };
        let total = estimated_video_total(video.max_minutes);
        let progress = Some(TaskProgressCount {
            current: video.item_count,
            total,
        });
        let detail = format!(
            "已采集 {} 条 / 预计约 {} 条 · {} 分钟上限{}",
            video.item_count,
            total,
            video.max_minutes,
            if video.pending_count > 0 {
                format!(" · 待投递 {}", video.pending_count)
            } else {
                String::new()
            }
        );
        let task_id = match active {
            Some(id) if task_is_active(store, &id) => id,
            _ => {
                store.counter += 1;
                let id = format!(
                    "video-{}-{}",
                    if video.session_id.is_empty() {
                        now.to_string()
                    } else {
                        video.session_id.clone()
                    },
                    store.counter
                );
                let task = TaskProgress {
                    id: id.clone(),
                    kind: "video".into(),
                    stage: "requested".into(),
                    title: "视频采集".into(),
                    source: "video-snapshot".into(),
                    started_at: video.started_at.unwrap_or(now),
                    updated_at: now,
                    expected_secs: video.max_minutes.saturating_mul(60).max(60),
                    progress: None,
                    detail: None,
                    error: None,
                    revision: 0,
                };
                let task = push_task(store, task);
                store.video_task_id = Some(id.clone());
                log_transition(log_dir, &task, "begin");
                id
            }
        };
        store.video_task_id = Some(task_id.clone());
        let updated = mutate_task(store, &task_id, |task, revision| {
            if is_terminal(&task.stage) || !valid_transition(&task.stage, stage) {
                return None;
            }
            let previous = task.clone();
            *revision += 1;
            task.revision = *revision;
            task.stage = stage.to_string();
            task.updated_at = now;
            task.progress = progress.clone();
            task.detail = Some(detail.clone());
            Some((task.clone(), should_log_advance(&previous, task)))
        })
        .flatten();
        if let Some((task, loggable)) = updated {
            if loggable {
                log_transition(log_dir, &task, "advance");
            }
        }
        return;
    }
    // 停止/结束时收尾
    let Some(id) = active else { return };
    if !task_is_active(store, &id) {
        store.video_task_id = None;
        return;
    }
    let (stage, error, detail) = match video.phase {
        Phase::Blocked => (
            "failed",
            Some(
                video
                    .error
                    .clone()
                    .or_else(|| video.error_code.clone())
                    .unwrap_or_else(|| "视频采集被阻断".into()),
            ),
            format!("已采集 {} 条", video.item_count),
        ),
        Phase::Ended if video.item_count > 0 => ("done", None, format!("采集结束，共 {} 条", video.item_count)),
        Phase::Ended => ("done", None, "采集结束".to_string()),
        _ if video.item_count > 0 => ("done", None, format!("采集已停止，共 {} 条", video.item_count)),
        _ => ("cancelled", None, "采集已停止".to_string()),
    };
    let task = mutate_task(store, &id, |task, revision| {
        *revision += 1;
        task.revision = *revision;
        task.stage = stage.to_string();
        task.updated_at = now;
        task.error = error;
        task.detail = Some(detail);
        task.progress = Some(TaskProgressCount {
            current: video.item_count,
            total: estimated_video_total(video.max_minutes),
        });
        task.clone()
    });
    store.video_task_id = None;
    if let Some(task) = task {
        log_transition(log_dir, &task, "end");
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

fn task_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_hub::config_dir(app)?.join("logs"))
}

fn limit_or_default(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_TASKS)
}

#[tauri::command]
pub async fn task_begin(
    app: AppHandle,
    kind: String,
    title: String,
    id: Option<String>,
    expected_secs: Option<u64>,
) -> Result<TaskProgress, String> {
    let started = Instant::now();
    let log_dir = task_log_dir(&app)?;
    let result = begin(&log_dir, &kind, &title, id, expected_secs, "frontend");
    agent_hub::log_slow_command(&app, "task_begin", started.elapsed().as_millis());
    result
}

#[tauri::command]
pub async fn task_advance(
    app: AppHandle,
    id: String,
    stage: String,
    progress_current: Option<u32>,
    progress_total: Option<u32>,
    detail: Option<String>,
) -> Result<TaskProgress, String> {
    let started = Instant::now();
    let log_dir = task_log_dir(&app)?;
    let progress = progress_current.map(|current| TaskProgressCount {
        current,
        total: progress_total.unwrap_or(current),
    });
    let result = advance(&log_dir, &id, &stage, progress, detail.as_deref());
    agent_hub::log_slow_command(&app, "task_advance", started.elapsed().as_millis());
    result
}

#[tauri::command]
pub async fn task_end(
    app: AppHandle,
    id: String,
    stage: String,
    error: Option<String>,
    detail: Option<String>,
) -> Result<TaskProgress, String> {
    let started = Instant::now();
    let log_dir = task_log_dir(&app)?;
    let result = end(&log_dir, &id, &stage, error.as_deref(), detail.as_deref());
    agent_hub::log_slow_command(&app, "task_end", started.elapsed().as_millis());
    result
}

#[tauri::command]
pub async fn task_list_snapshot(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<TaskListSnapshot, String> {
    let started = Instant::now();
    let log_dir = task_log_dir(&app)?;
    let app_for_video = app.clone();
    let limit = limit_or_default(limit);
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        // 视频状态是确定性任务的来源；snapshot() 只读内存状态，不启动采集。
        let video = crate::video::video_get_snapshot(app_for_video);
        snapshot_inner(&log_dir, limit, Some(&video))
    })
    .await
    .map_err(|error| format!("任务快照线程失败：{error}"))?;
    agent_hub::log_slow_command(&app, "task_list_snapshot", started.elapsed().as_millis());
    Ok(snapshot)
}

/// 兜底推断：最多 100 token 的 JSON 分类，由 PetChat 在「未命中技能」的回复后异步调用。
/// 解析失败 / 置信度 <0.6 / 类型非法都返回 None，不写任务、不影响聊天。
#[tauri::command]
pub async fn task_infer(app: AppHandle, text: String, reply: Option<String>) -> Option<InferredTask> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let started = Instant::now();
    let prompt = format!(
        "把下面这轮对话归类为一个任务。只输出一行 JSON，不要解释：\
{{\"task\":\"chat|search|settings|todo|video|daily|agent|other\",\"stage\":\"requested|planning|executing|waiting_confirm|delivering|done|failed\",\"confidence\":0到1的小数}}\n\
用户：{}\n助手：{}",
        text.chars().take(300).collect::<String>(),
        reply
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>()
    );
    let raw = crate::dsh_chat::generate_video_comment(app.clone(), prompt, "xiaobai".into())
        .await
        .ok()?;
    agent_hub::log_slow_command(&app, "task_infer", started.elapsed().as_millis());
    let inferred = parse_inference(&raw)?;
    // 兜底推断只做「事后标注」：建一条 inferred 任务并立即 done，detail 记推断阶段/置信度，
    // 不覆盖技能/视频/agent 的确定性状态。
    if let Ok(log_dir) = task_log_dir(&app) {
        let title: String = text.chars().take(40).collect();
        if let Ok(task) = begin(&log_dir, &inferred.task, &title, None, None, "inferred") {
            let _ = advance(&log_dir, &task.id, &inferred.stage, None, Some("模型推断（兜底）"));
            let detail = format!("推断阶段 {} · 置信度 {:.2}", inferred.stage, inferred.confidence);
            let _ = end(&log_dir, &task.id, "done", None, Some(&detail));
        }
    }
    Some(inferred)
}

pub(crate) fn parse_inference(raw: &str) -> Option<InferredTask> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let task = value.get("task")?.as_str()?.to_lowercase();
    if !KINDS.contains(&task.as_str()) {
        return None;
    }
    let stage = value
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("executing")
        .to_lowercase();
    if !STAGES.contains(&stage.as_str()) || is_terminal(&stage) {
        return None;
    }
    let confidence = value.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
    if confidence < 0.6 {
        return None;
    }
    Some(InferredTask {
        task,
        stage,
        confidence,
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::Phase;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".tmp-task-progress-tests")
            .join(format!("{tag}-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        *store_lock() = None;
        guard
    }

    #[test]
    fn stage_transitions_are_validated() {
        assert!(valid_transition("requested", "executing"));
        assert!(valid_transition("executing", "delivering"));
        assert!(valid_transition("delivering", "done"));
        assert!(valid_transition("executing", "stalled"));
        assert!(!valid_transition("done", "executing"));
        assert!(!valid_transition("requested", "done"));
        assert!(!valid_transition("failed", "planning"));

        let _lock = fresh();
        let dir = test_dir("transitions");
        let task = begin(&dir, "todo", "加个待办", None, None, "test").expect("begin");
        advance(&dir, &task.id, "executing", None, None).expect("executing");
        assert!(advance(&dir, &task.id, "done", None, None).is_err());
        end(&dir, &task.id, "done", None, None).expect("done");
        assert!(advance(&dir, &task.id, "executing", None, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeout_marks_task_stalled() {
        let _lock = fresh();
        let dir = test_dir("stalled");
        let task = begin(&dir, "search", "查资料", None, Some(1), "test").expect("begin");
        // 手动把 updated_at 往前拨 3s（预期 1s → 2× = 2s）
        {
            let mut guard = store_lock();
            let store = ensure_store(&mut guard);
            if let Some(item) = find_task(store, &task.id) {
                item.updated_at = now_ms().saturating_sub(3_000);
            }
        }
        let snapshot = snapshot(&dir, 20);
        let stalled = snapshot
            .tasks
            .iter()
            .find(|item| item.id == task.id)
            .expect("task");
        assert_eq!(stalled.stage, "stalled");
        assert!(stalled.error.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jsonl_log_rotates_by_day() {
        let dir = test_dir("jsonl");
        let first = task_log_path(&dir, "2026-11-19");
        let second = task_log_path(&dir, "2026-11-20");
        assert!(first.ends_with("tasks-2026-11-19.jsonl"));
        assert_ne!(first, second);
        append_task_log(&dir, &json!({"event": "begin", "taskId": "t1", "title": "x"}));
        let (date, _) = agent_hub::local_parts();
        let current = task_log_path(&dir, &date);
        let content = std::fs::read_to_string(&current).expect("log file");
        assert!(content.contains("\"taskId\":\"t1\""));
        assert_eq!(content.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_is_sorted_and_limited() {
        let _lock = fresh();
        let dir = test_dir("snapshot");
        for index in 0..25 {
            let task = begin(&dir, "todo", &format!("任务 {index}"), None, None, "test").expect("begin");
            end(&dir, &task.id, "done", None, None).expect("end");
        }
        let limited = snapshot(&dir, 5);
        assert_eq!(limited.tasks.len(), 5);
        for pair in limited.tasks.windows(2) {
            assert!(pair[0].updated_at >= pair[1].updated_at);
        }
        let capped = snapshot(&dir, 20);
        assert!(capped.tasks.len() <= MAX_TASKS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_snapshot_drives_video_task() {
        let _lock = fresh();
        let dir = test_dir("video");
        let mut video = crate::video::session::VideoSnapshot::default();
        video.session_id = "session-1".into();
        video.running = true;
        video.phase = Phase::Collecting;
        video.item_count = 7;
        video.steps = 9;
        video.max_minutes = 30;
        let running = snapshot_inner(&dir, 20, Some(&video));
        let task = running.tasks.iter().find(|task| task.kind == "video").expect("video task");
        assert_eq!(task.stage, "executing");
        let progress = task.progress.as_ref().unwrap();
        assert_eq!(progress.current, 7);
        // 30 分钟 × 每条 15s ≈ 120 条；不能再用 steps/current 导致 100%。
        assert_eq!(progress.total, 120);
        assert!(progress.current < progress.total);

        video.running = false;
        video.phase = Phase::Stopped;
        let stopped = snapshot_inner(&dir, 20, Some(&video));
        let task = stopped.tasks.iter().find(|task| task.kind == "video").expect("video task");
        assert_eq!(task.stage, "done");
        assert!(task.detail.as_deref().unwrap_or_default().contains("7"));
        assert_eq!(task.progress.as_ref().unwrap().total, 120);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 心跳（每秒一次快照、数据不变）不应写盘；但内存 updated_at 仍更新，
    /// 回拨后 stalled 仍能触发并写一行 stalled。
    #[test]
    fn heartbeat_does_not_write_but_still_stalls() {
        let _lock = fresh();
        let dir = test_dir("heartbeat");
        let mut video = crate::video::session::VideoSnapshot::default();
        video.session_id = "heartbeat-session".into();
        video.running = true;
        video.phase = Phase::Collecting;
        video.item_count = 13;
        video.steps = 13;
        video.max_minutes = 30;
        snapshot_inner(&dir, 20, Some(&video));
        let (date, _) = agent_hub::local_parts();
        let log = task_log_path(&dir, &date);
        let lines = || {
            std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .count()
        };
        let after_begin = lines();
        for _ in 0..5 {
            snapshot_inner(&dir, 20, Some(&video));
        }
        assert_eq!(lines(), after_begin, "纯心跳不应写盘");

        video.item_count = 14;
        snapshot_inner(&dir, 20, Some(&video));
        let after_progress = lines();
        assert!(after_progress > after_begin, "采集条数变化应写一行");

        // 让 stalled 更容易触发：expected 1s + updated_at 回拨；视频已停止，避免新建任务。
        {
            let mut guard = store_lock();
            let store = ensure_store(&mut guard);
            let task = store
                .tasks
                .iter_mut()
                .find(|task| task.kind == "video" && !is_terminal(&task.stage))
                .expect("active video task");
            task.expected_secs = 1;
            task.updated_at = now_ms().saturating_sub(3_000);
        }
        video.running = false;
        video.phase = Phase::Stopped;
        let stalled_snapshot = snapshot_inner(&dir, 20, Some(&video));
        let task = stalled_snapshot
            .tasks
            .iter()
            .find(|task| task.kind == "video")
            .expect("video task");
        assert_eq!(task.stage, "stalled");
        assert!(lines() > after_progress, "stalled 应补一行日志");
        let content = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(content.lines().last().unwrap_or_default().contains("\"stalled\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 实机 60s：每秒一次视频快照心跳，只打印/验证落盘行数。
    /// `cargo test --lib task_progress::tests::real_video_heartbeat_60s -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_video_heartbeat_60s() {
        let _lock = fresh();
        let dir = test_dir("video-60s");
        let mut video = crate::video::session::VideoSnapshot::default();
        video.session_id = "real-60s-video".into();
        video.running = true;
        video.phase = Phase::Collecting;
        video.item_count = 0;
        video.steps = 0;
        video.max_minutes = 30;
        let (date, _) = agent_hub::local_parts();
        let log = task_log_path(&dir, &date);
        let lines = || {
            std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .count()
        };
        let started = std::time::Instant::now();
        for second in 1..=60u64 {
            if second == 20 || second == 40 {
                video.item_count += 5;
            }
            let snapshot = snapshot_inner(&dir, 20, Some(&video));
            let task = snapshot.tasks.iter().find(|task| task.kind == "video").expect("video task");
            println!(
                "t={:>2}s lines={} current={} total={} stage={}",
                second,
                lines(),
                task.progress.as_ref().map(|p| p.current).unwrap_or(0),
                task.progress.as_ref().map(|p| p.total).unwrap_or(0),
                task.stage
            );
            if second < 60 {
                std::thread::sleep(std::time::Duration::from_millis(1_000));
            }
        }
        video.running = false;
        video.phase = Phase::Stopped;
        snapshot_inner(&dir, 20, Some(&video));
        println!(
            "elapsed={}ms final_lines={} log={}",
            started.elapsed().as_millis(),
            lines(),
            log.display()
        );
        println!("--- tasks jsonl ---\n{}", std::fs::read_to_string(&log).unwrap_or_default());
        // 旧实现：60 次心跳 + 2 次条数变化 + 结束 = 60+3 行左右；修后应明显更少。
        assert!(lines() <= 8, "60s 心跳后日志应 ≤8 行，实际 {} 行", lines());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn infer_parser_rejects_low_confidence_and_bad_kind() {
        assert!(parse_inference(r#"{"task":"search","stage":"executing","confidence":0.9}"#).is_some());
        assert!(parse_inference(r#"{"task":"search","stage":"executing","confidence":0.4}"#).is_none());
        assert!(parse_inference(r#"{"task":"nonsense","stage":"executing","confidence":0.9}"#).is_none());
        assert!(parse_inference("不是 JSON").is_none());
    }
}