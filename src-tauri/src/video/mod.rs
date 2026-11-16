//! 刷视频插件（小狗自主刷视频）。
//!
//! 分层：纯逻辑（rules/extract/interest/profile/digest/delivery/store）→
//! 适配（browser/cdp/channel）→ 编排（session）与命令导出。

pub mod adapter;
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
pub mod rules;
pub mod session;
pub mod store;
pub mod url_guard;

use config::{VideoConfig, VideoConfigPatch};
use model::{
    ChannelState, ClearReport, ClearScope, DeliveryOutcome, DeliveryRecord, DiagnosticEntry,
    DigestDraft, Platform, SessionSummary, StopReason, UserProfile, VideoSession,
};
use profile::ProfilePatch;
use serde::Serialize;
use session::VideoSnapshot;
use std::fmt;
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
}

/// 在当前视频页面发一条评论（用户点「发送」时才调用）。
#[tauri::command]
pub async fn video_post_comment(app: AppHandle, text: String) -> VideoResult<CommentReport> {
    session::engine(&app).post_comment(&text).await
}
#[tauri::command]
pub async fn video_start_session(
    app: AppHandle,
    provider: String,
    config: Option<VideoConfigPatch>,
) -> VideoResult<VideoSnapshot> {
    let platform = parse_provider(&provider)?;
    session::engine(&app).start(app, platform, config).await
}

#[tauri::command]
pub async fn video_stop_session(
    app: AppHandle,
    reason: Option<StopReason>,
) -> VideoResult<VideoSnapshot> {
    Ok(session::engine(&app).stop(reason))
}

#[tauri::command]
pub fn video_get_snapshot(app: AppHandle) -> VideoSnapshot {
    session::engine(&app).snapshot()
}

#[tauri::command]
pub fn video_update_config(
    app: AppHandle,
    patch: VideoConfigPatch,
) -> VideoResult<VideoConfig> {
    session::engine(&app).update_config(&patch)
}

#[tauri::command]
pub fn video_probe_channels(app: AppHandle) -> Vec<ChannelState> {
    session::engine(&app).probe_channels()
}

#[tauri::command]
pub fn video_list_sessions(app: AppHandle, limit: Option<u32>) -> Vec<SessionSummary> {
    session::engine(&app).list_sessions(limit.unwrap_or(20))
}

#[tauri::command]
pub fn video_get_session(app: AppHandle, session_id: String) -> VideoResult<VideoSession> {
    session::engine(&app).get_session(&session_id)
}

#[tauri::command]
pub fn video_get_profile(app: AppHandle) -> UserProfile {
    session::engine(&app).profile()
}

#[tauri::command]
pub fn video_update_profile(
    app: AppHandle,
    patch: ProfilePatch,
) -> VideoResult<UserProfile> {
    let engine = session::engine(&app);
    let mut profile = engine.profile();
    profile::apply_patch(&mut profile, &patch)
        .map_err(|message| VideoError::new("INVALID_PROFILE", message))?;
    engine.save_profile(&profile);
    Ok(profile)
}

#[tauri::command]
pub fn video_take_pending_digest(app: AppHandle) -> Option<DigestDraft> {
    session::engine(&app).take_pending_digest(&app)
}

#[tauri::command]
pub fn video_mark_delivery(
    app: AppHandle,
    session_id: String,
    outcome: DeliveryOutcome,
) -> VideoResult<DeliveryRecord> {
    session::engine(&app).mark_delivery(&app, &session_id, outcome)
}

#[tauri::command]
pub fn video_diagnostics(app: AppHandle, limit: Option<u32>) -> Vec<DiagnosticEntry> {
    session::engine(&app).diagnostics(limit.unwrap_or(20))
}

#[tauri::command]
pub fn video_clear_data(
    app: AppHandle,
    scope: ClearScope,
    include_browser_profile: Option<bool>,
) -> VideoResult<ClearReport> {
    session::engine(&app).clear_data(scope, include_browser_profile.unwrap_or(false))
}

#[tauri::command]
pub fn video_open_login_window(
    app: AppHandle,
    provider: Option<String>,
) -> VideoResult<()> {
    let platform = parse_provider(provider.as_deref().unwrap_or("bilibili"))?;
    session::engine(&app).open_login_window(platform)
}

#[tauri::command]
pub fn video_close_browser(app: AppHandle) -> VideoResult<()> {
    session::engine(&app).close_browser()
}

#[tauri::command]
pub fn video_open_external_url(url: String) -> VideoResult<()> {
    external::open_external_url(&url)
}