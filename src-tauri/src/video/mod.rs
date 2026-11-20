//! 刷视频插件（小狗自主刷视频）。
//!
//! 分层：纯逻辑（rules/extract/queue/interest/profile/digest/delivery/store）→
//! 适配（browser/cdp/channel）→ 编排（session）与命令导出。

pub mod adapter;
pub mod accounts;
pub mod browser;
pub mod cdp;
pub mod channel;
pub mod comment;
pub mod config;
pub mod delivery;
pub mod digest;
pub mod external;
pub mod extract;
pub mod guard;
pub mod interest;
pub mod model;
pub mod profile;
pub mod queue;
pub mod rules;
pub mod session;
pub mod store;
pub mod taste;
pub mod reflection;
pub mod xhs_draft;
pub mod url_guard;

use accounts::AgentAccount;
use config::{VideoConfig, VideoConfigPatch};
use model::{
    ChannelState, ClearReport, ClearScope, DeliveryOutcome, DeliveryRecord, DiagnosticEntry,
    DigestDraft, Platform, SessionSummary, StopReason, UserProfile, VideoSession,
};
use profile::ProfilePatch;
use serde::Serialize;
use session::VideoSnapshot;
use std::fmt;
use std::time::Instant;
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl VideoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: Some(detail.into()),
        }
    }
}

impl fmt::Display for VideoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for VideoError {}

impl From<String> for VideoError {
    fn from(value: String) -> Self {
        Self::new("VIDEO_ERROR", value)
    }
}

impl From<&str> for VideoError {
    fn from(value: &str) -> Self {
        Self::new("VIDEO_ERROR", value)
    }
}

pub type VideoResult<T> = Result<T, VideoError>;

/// 命令耗时守卫：进入命令记 Instant，退出（含错误路径）时 >200ms 落 SLOW_COMMAND。
struct CommandGuard {
    started: Instant,
    name: &'static str,
    engine: std::sync::Arc<session::SessionEngine>,
}

impl Drop for CommandGuard {
    fn drop(&mut self) {
        self.engine
            .command_cost(self.name, self.started.elapsed().as_millis() as u64);
    }
}

fn command_guard(app: &AppHandle, name: &'static str) -> CommandGuard {
    CommandGuard {
        started: Instant::now(),
        name,
        engine: session::engine(app),
    }
}

fn parse_provider(value: &str) -> VideoResult<Platform> {
    Platform::parse(value)
        .ok_or_else(|| VideoError::new("INVALID_PROVIDER", "只支持 bilibili 或 douyin。"))
}

/// 评论结果：前端据此提示「发出去了 / 为什么没发出去」。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentReport {
    pub ok: bool,
    /// 失败原因码：no-input / no-button / comment-not-ready / comment-cdp …
    pub reason: String,
    pub message: String,
    pub platform: String,
    /// 发送细节（clicked/disabled/editorCleared 等，用于 COMMENT_SUBMIT 日志）。
    #[serde(default)]
    pub detail: serde_json::Value,
}

/// 在当前视频页面发一条评论（用户点「发送」时才调用）。
#[tauri::command]
pub async fn video_post_comment(app: AppHandle, text: String) -> VideoResult<CommentReport> {
    let _guard = command_guard(&app, "video_post_comment");
    session::engine(&app).post_comment(&text).await
}
#[tauri::command]
pub async fn video_start_session(
    app: AppHandle,
    provider: String,
    config: Option<VideoConfigPatch>,
    account_id: Option<String>,
) -> VideoResult<VideoSnapshot> {
    let _guard = command_guard(&app, "video_start_session");
    let platform = parse_provider(&provider)?;
    session::engine(&app).start(app, platform, config, account_id).await
}

#[tauri::command]
pub fn video_list_accounts(app: AppHandle) -> Vec<AgentAccount> {
    let _guard = command_guard(&app, "video_list_accounts");
    session::engine(&app).accounts()
}

#[tauri::command]
pub fn video_get_active_account(app: AppHandle) -> Option<AgentAccount> {
    let _guard = command_guard(&app, "video_get_active_account");
    session::engine(&app).active_account()
}

#[tauri::command]
pub fn video_create_account(
    app: AppHandle,
    platform: String,
    display_name: String,
    handle: Option<String>,
    persona: Option<String>,
    goals: Option<String>,
) -> VideoResult<AgentAccount> {
    let _guard = command_guard(&app, "video_create_account");
    let platform = parse_provider(&platform)?;
    session::engine(&app).create_account(
        platform,
        display_name,
        handle.unwrap_or_default(),
        persona.unwrap_or_default(),
        goals.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn video_set_active_account(app: AppHandle, account_id: String) -> VideoResult<AgentAccount> {
    let _guard = command_guard(&app, "video_set_active_account");
    session::engine(&app).set_active_account(&account_id)
}

#[tauri::command]
pub fn video_mark_account_ready(app: AppHandle, account_id: String) -> VideoResult<AgentAccount> {
    let _guard = command_guard(&app, "video_mark_account_ready");
    session::engine(&app).mark_account_ready(&account_id)
}

#[tauri::command]
pub async fn video_stop_session(
    app: AppHandle,
    reason: Option<StopReason>,
) -> VideoResult<VideoSnapshot> {
    let _guard = command_guard(&app, "video_stop_session");
    let engine = session::engine(&app);
    let app_for_stop = app.clone();
    // 收尾（写终态/生成摘要/关浏览器）放阻塞线程池：命令线程不被卡住。
    tauri::async_runtime::spawn_blocking(move || engine.stop(&app_for_stop, reason))
        .await
        .map_err(|error| {
            VideoError::with_detail("STOP_FAILED", "停止会话时线程异常。", error.to_string())
        })
}

#[tauri::command]
pub fn video_get_snapshot(app: AppHandle) -> VideoSnapshot {
    let _guard = command_guard(&app, "video_get_snapshot");
    session::engine(&app).snapshot()
}

#[tauri::command]
pub fn video_update_config(
    app: AppHandle,
    patch: VideoConfigPatch,
) -> VideoResult<VideoConfig> {
    let _guard = command_guard(&app, "video_update_config");
    session::engine(&app).update_config(&patch)
}


/// 自检命令：把一条评论写进 live snapshot 并发气泡事件（仅用于验证面板/气泡，不影响采集）。
#[tauri::command]
pub fn video_comment_selftest(app: AppHandle, text: Option<String>) -> Result<(), String> {
    let _guard = command_guard(&app, "video_comment_selftest");
    let value = text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "这个讲得挺细的，先码住。".to_string());
    session::engine(&app).selftest_comment(&app, &value);
    Ok(())
}

#[tauri::command]
pub fn video_probe_channels(app: AppHandle) -> Vec<ChannelState> {
    let _guard = command_guard(&app, "video_probe_channels");
    session::engine(&app).probe_channels()
}

#[tauri::command]
pub fn video_list_sessions(app: AppHandle, limit: Option<u32>) -> Vec<SessionSummary> {
    let _guard = command_guard(&app, "video_list_sessions");
    session::engine(&app).list_sessions(limit.unwrap_or(20))
}

#[tauri::command]
pub fn video_get_session(app: AppHandle, session_id: String) -> VideoResult<VideoSession> {
    let _guard = command_guard(&app, "video_get_session");
    session::engine(&app).get_session(&session_id)
}

#[tauri::command]
pub fn video_get_profile(app: AppHandle) -> UserProfile {
    let _guard = command_guard(&app, "video_get_profile");
    session::engine(&app).profile()
}

#[tauri::command]
pub fn video_update_profile(
    app: AppHandle,
    patch: ProfilePatch,
) -> VideoResult<UserProfile> {
    let _guard = command_guard(&app, "video_update_profile");
    let engine = session::engine(&app);
    let mut profile = engine.profile();
    profile::apply_patch(&mut profile, &patch)
        .map_err(|message| VideoError::new("INVALID_PROFILE", message))?;
    engine.save_profile(&profile);
    Ok(profile)
}

#[tauri::command]
pub fn video_take_pending_digest(app: AppHandle) -> Option<DigestDraft> {
    let _guard = command_guard(&app, "video_take_pending_digest");
    session::engine(&app).take_pending_digest(&app)
}

/// 当前视频口味（面板展示；聊天技能也读它）。
#[tauri::command]
pub fn video_get_taste(app: AppHandle) -> UserProfile {
    let _guard = command_guard(&app, "video_get_taste");
    session::engine(&app).taste_profile()
}

/// 聊天里一句话调整视频口味：只动画像正/负标签，不改其它设置。
#[tauri::command]
pub fn video_update_taste(app: AppHandle, text: String) -> VideoResult<taste::TasteReport> {
    let _guard = command_guard(&app, "video_update_taste");
    session::engine(&app).apply_taste_text(&text)
}

/// 恢复默认口味。
#[tauri::command]
pub fn video_reset_taste(app: AppHandle) -> UserProfile {
    let _guard = command_guard(&app, "video_reset_taste");
    session::engine(&app).reset_taste()
}

#[tauri::command]
pub fn video_mark_delivery(
    app: AppHandle,
    session_id: String,
    outcome: DeliveryOutcome,
) -> VideoResult<DeliveryRecord> {
    let _guard = command_guard(&app, "video_mark_delivery");
    session::engine(&app).mark_delivery(&app, &session_id, outcome)
}

#[tauri::command]
pub fn video_diagnostics(app: AppHandle, limit: Option<u32>) -> Vec<DiagnosticEntry> {
    let _guard = command_guard(&app, "video_diagnostics");
    session::engine(&app).diagnostics(limit.unwrap_or(20))
}

#[tauri::command]
pub async fn video_clear_data(
    app: AppHandle,
    scope: ClearScope,
    include_browser_profile: Option<bool>,
) -> VideoResult<ClearReport> {
    let _guard = command_guard(&app, "video_clear_data");
    let engine = session::engine(&app);
    // 清 profile 可能是几百毫秒到数秒的磁盘删除：放阻塞线程池，别卡 UI。
    tauri::async_runtime::spawn_blocking(move || {
        engine.clear_data(scope, include_browser_profile.unwrap_or(false))
    })
    .await
    .map_err(|error| VideoError::with_detail("CLEAR_FAILED", "清理数据时线程异常。", error.to_string()))?
}

#[tauri::command]
pub async fn video_open_login_window(
    app: AppHandle,
    provider: Option<String>,
    account_id: Option<String>,
) -> VideoResult<()> {
    let _guard = command_guard(&app, "video_open_login_window");
    let platform = parse_provider(provider.as_deref().unwrap_or("bilibili"))?;
    session::engine(&app)
        .open_login_window(platform, account_id.as_deref())
        .await
}

#[tauri::command]
pub fn video_close_browser(app: AppHandle) -> VideoResult<()> {
    let _guard = command_guard(&app, "video_close_browser");
    session::engine(&app).close_browser()
}

/// 专用浏览器实例现状（面板高级设置展示；用于解释「会复用上次实例还是清理后重开」）。
#[tauri::command]
pub async fn video_browser_status(app: AppHandle) -> session::BrowserStatus {
    let _guard = command_guard(&app, "video_browser_status");
    let engine = session::engine(&app);
    // 进程/端口探测是同步 IO，放阻塞线程池，避免同步命令卡主线程。
    tauri::async_runtime::spawn_blocking(move || engine.browser_status())
        .await
        .unwrap_or_else(|_| session::BrowserStatus::default())
}

#[tauri::command]
pub fn video_open_external_url(url: String) -> VideoResult<()> {
    external::open_external_url(&url)
}

/// 生成小红书图文草稿：只准备文案（标题/正文/tags），配图由平台「文生图」，人工发布。
#[tauri::command]
pub async fn xhs_generate_draft(
    app: AppHandle,
    session_ids: Option<Vec<String>>,
) -> VideoResult<xhs_draft::XhsDraft> {
    let _guard = command_guard(&app, "xhs_generate_draft");
    let engine = session::engine(&app);
    let items = engine.draft_items(&session_ids.unwrap_or_default());
    if items.is_empty() {
        return Err(VideoError::new(
            "XHS_NO_ITEMS",
            "还没有采到小红书笔记：先在「小红书」平台采一轮，再生成草稿。",
        ));
    }
    let model = engine.comment_model_config();
    let mut draft = match model.as_ref() {
        Some(model) => {
            match tokio::time::timeout(
                std::time::Duration::from_secs(45),
                xhs_draft::generate_with_model(&app, &items, model),
            )
            .await
            {
                Ok(Ok(draft)) => draft,
                Ok(Err(error)) => {
                    engine.log_diagnostic(
                        "warn",
                        "XHS_DRAFT_FALLBACK",
                        format!("reason={error} generator=template"),
                    );
                    xhs_draft::template_draft(&items)
                }
                Err(_) => {
                    engine.log_diagnostic(
                        "warn",
                        "XHS_DRAFT_FALLBACK",
                        "reason=timeout generator=template",
                    );
                    xhs_draft::template_draft(&items)
                }
            }
        }
        None => {
            engine.log_diagnostic(
                "info",
                "XHS_DRAFT_FALLBACK",
                "reason=no_model generator=template",
            );
            xhs_draft::template_draft(&items)
        }
    };
    if draft.similar {
        engine.log_diagnostic(
            "warn",
            "XHS_DRAFT_SIMILARITY",
            format!(
                "similar=true notes={} len={} action=truncate",
                items.len(),
                draft.body.chars().count()
            ),
        );
    }
    let dir = xhs_draft::write_draft(&app, &mut draft)
        .map_err(|message| VideoError::new("XHS_DRAFT_WRITE_FAILED", message))?;
    engine.log_diagnostic(
        "info",
        "XHS_DRAFT_BUILT",
        format!(
            "generator={} similar={} len={} notes={} dir={}",
            draft.generator,
            draft.similar,
            draft.body.chars().count(),
            draft.used_notes.len(),
            dir
        ),
    );
    Ok(draft)
}

/// 保存用户编辑后的草稿（标题/正文/tags 可改，仍按平台上限裁剪）。
#[tauri::command]
pub fn xhs_save_draft(
    app: AppHandle,
    draft: xhs_draft::XhsDraft,
) -> VideoResult<xhs_draft::XhsDraft> {
    let _guard = command_guard(&app, "xhs_save_draft");
    let engine = session::engine(&app);
    let mut draft = draft;
    xhs_draft::normalize_edited(&mut draft);
    let dir = xhs_draft::persist_edited(&app, &mut draft)
        .map_err(|message| VideoError::new("XHS_DRAFT_WRITE_FAILED", message))?;
    engine.log_diagnostic(
        "info",
        "XHS_DRAFT_SAVED",
        format!(
            "title_chars={} body_chars={} tags={} dir={}",
            draft.title.chars().count(),
            draft.body.chars().count(),
            draft.tags.len(),
            dir
        ),
    );
    Ok(draft)
}

/// 打开小红书草稿目录。
#[tauri::command]
pub fn xhs_open_drafts_dir(app: AppHandle) -> VideoResult<()> {
    let _guard = command_guard(&app, "xhs_open_drafts_dir");
    use tauri_plugin_opener::OpenerExt;
    let dir = xhs_draft::drafts_root(&app);
    std::fs::create_dir_all(&dir).map_err(|error| {
        VideoError::with_detail("XHS_DRAFT_DIR_FAILED", "无法创建草稿目录。", error.to_string())
    })?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| {
            VideoError::with_detail("XHS_DRAFT_DIR_FAILED", "无法打开草稿目录。", error.to_string())
        })
}

/// 打开 `video/logs` 目录（历史加载失败 / 诊断面板的「查看日志」）。
#[tauri::command]
pub fn video_open_logs_dir(app: AppHandle) -> VideoResult<()> {
    let _guard = command_guard(&app, "video_open_logs_dir");
    use tauri_plugin_opener::OpenerExt;
    let logs = session::data_root(&app).join("logs");
    std::fs::create_dir_all(&logs).map_err(|error| {
        VideoError::with_detail("LOG_DIR_FAILED", "无法创建日志目录。", error.to_string())
    })?;
    app.opener()
        .open_path(logs.to_string_lossy(), None::<&str>)
        .map_err(|error| {
            VideoError::with_detail("LOG_DIR_FAILED", "无法打开日志目录。", error.to_string())
        })
}
