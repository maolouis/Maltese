//! D1：外部链接白名单。
//!
//! 只允许 https + 官方子域，交给系统默认浏览器；不经过 `open_local_path`
//!（它要求路径真实存在）。

use super::url_guard;
use super::{VideoError, VideoResult};

pub fn validate_external_url(url: &str) -> VideoResult<()> {
    url_guard::check_url(url).map_err(|message| VideoError::new("URL_NOT_ALLOWED", message))
}

pub fn open_external_url(url: &str) -> VideoResult<()> {
    validate_external_url(url)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| {
        VideoError::with_detail("URL_OPEN_FAILED", "无法打开系统浏览器。", error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_returns_stable_error_code() {
        let error = validate_external_url("https://evil.com").expect_err("rejected");
        assert_eq!(error.code, "URL_NOT_ALLOWED");
    }

    #[test]
    fn validation_accepts_official_page() {
        assert!(validate_external_url("https://member.bilibili.com/upload").is_ok());
    }
}