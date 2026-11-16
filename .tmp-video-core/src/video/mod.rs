//! 刷视频插件（小狗自主刷视频）。
//!
//! 分层：纯逻辑（rules/extract/interest/profile/digest/delivery/store）→
//! 适配（browser/cdp/channel）→ 编排（session）与命令导出。

pub mod adapter;
pub mod browser;
pub mod cdp;
pub mod channel;
pub mod config;
pub mod delivery;
pub mod digest;
pub mod extract;
pub mod guard;
pub mod interest;
pub mod model;
pub mod profile;
pub mod rules;
pub mod session;
pub mod store;
pub mod url_guard;

use serde::Serialize;
use std::fmt;

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