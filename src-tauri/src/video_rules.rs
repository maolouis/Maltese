//! 旧规则模块的兼容转发；新实现位于 `video::rules`。

pub use crate::video::rules::{
    is_browser_process, normalize_provider, page_key, title_matches, validate_config,
};