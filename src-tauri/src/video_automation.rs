//! 旧「自动刷视频」命令的兼容壳。
//!
//! 新实现位于 `video` 模块；这里只保留旧命令名与参数，内部转发并补齐新字段。

use crate::video::{self, session::VideoSnapshot};
use serde::Deserialize;
use tauri::AppHandle;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAutomationConfig {
    pub interval_seconds: u64,
    pub max_minutes: u64,
}

pub fn init(_app: &AppHandle) {}

#[tauri::command]
pub fn get_video_automation_state(app: AppHandle) -> VideoSnapshot {
    video::session::engine(&app).snapshot()
}

#[tauri::command]
pub fn set_video_automation_config(
    app: AppHandle,
    config: VideoAutomationConfig,
) -> Result<VideoSnapshot, video::VideoError> {
    let patch = video::config::VideoConfigPatch {
        page_interval_seconds: Some(config.interval_seconds),
        max_minutes: Some(config.max_minutes),
        ..video::config::VideoConfigPatch::default()
    };
    video::session::engine(&app).update_config(&patch)?;
    Ok(video::session::engine(&app).snapshot())
}

#[tauri::command]
pub async fn start_video_automation(
    app: AppHandle,
    provider: String,
) -> Result<VideoSnapshot, video::VideoError> {
    let platform = video::model::Platform::parse(&provider)
        .ok_or_else(|| video::VideoError::new("INVALID_PROVIDER", "只支持 bilibili 或 douyin。"))?;
    let engine = video::session::engine(&app);
    engine.start(app, platform, None).await
}

#[tauri::command]
pub async fn stop_video_automation(app: AppHandle) -> Result<VideoSnapshot, video::VideoError> {
    Ok(video::session::engine(&app).stop(None))
}