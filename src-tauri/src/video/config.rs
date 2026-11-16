//! 刷视频插件配置。纯数据 + 校验，不触碰 I/O。

use super::model::Platform;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelPriority {
    Auto,
    CdpOnly,
    NoExtension,
}

impl Default for ChannelPriority {
    fn default() -> Self {
        ChannelPriority::Auto
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
    pub provider: Platform,
    pub max_minutes: u64,
    pub page_interval_seconds: u64,
    pub sample_interval_seconds: u64,
    pub max_items: u32,
    pub daily_deliveries: u32,
    pub channel_priority: ChannelPriority,
    pub model_summary: bool,
    pub auto_like: bool,
    pub auto_favorite: bool,
    pub auto_like_daily_limit: u32,
    pub auto_favorite_daily_limit: u32,
    pub keep_profile_on_clear: bool,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            provider: Platform::Bilibili,
            max_minutes: 30,
            page_interval_seconds: 45,
            sample_interval_seconds: 2,
            max_items: 200,
            daily_deliveries: 2,
            channel_priority: ChannelPriority::Auto,
            model_summary: true,
            auto_like: false,
            auto_favorite: false,
            auto_like_daily_limit: 10,
            auto_favorite_daily_limit: 5,
            keep_profile_on_clear: false,
        }
    }
}

/// 前端只传需要改的字段；旧版 `intervalSeconds` 仍映射到翻页间隔。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfigPatch {
    pub provider: Option<Platform>,
    pub max_minutes: Option<u64>,
    pub page_interval_seconds: Option<u64>,
    pub interval_seconds: Option<u64>,
    pub sample_interval_seconds: Option<u64>,
    pub max_items: Option<u32>,
    pub daily_deliveries: Option<u32>,
    pub channel_priority: Option<ChannelPriority>,
    pub model_summary: Option<bool>,
    pub auto_like: Option<bool>,
    pub auto_favorite: Option<bool>,
    pub auto_like_daily_limit: Option<u32>,
    pub auto_favorite_daily_limit: Option<u32>,
    pub keep_profile_on_clear: Option<bool>,
}

pub fn validate_config(config: &VideoConfig) -> Result<(), String> {
    if !(1..=240).contains(&config.max_minutes) {
        return Err("maxMinutes 需要在 1 到 240 分钟之间。".to_string());
    }
    if !(15..=600).contains(&config.page_interval_seconds) {
        return Err("pageIntervalSeconds 需要在 15 到 600 秒之间。".to_string());
    }
    if !(1..=5).contains(&config.sample_interval_seconds) {
        return Err("sampleIntervalSeconds 需要在 1 到 5 秒之间。".to_string());
    }
    if !(20..=500).contains(&config.max_items) {
        return Err("maxItems 需要在 20 到 500 之间。".to_string());
    }
    if !(1..=5).contains(&config.daily_deliveries) {
        return Err("dailyDeliveries 需要在 1 到 5 次之间。".to_string());
    }
    if config.auto_like_daily_limit > 10 {
        return Err("autoLikeDailyLimit 需要在 0 到 10 之间。".to_string());
    }
    if config.auto_favorite_daily_limit > 5 {
        return Err("autoFavoriteDailyLimit 需要在 0 到 5 之间。".to_string());
    }
    Ok(())
}

/// 合并 patch 后整体校验；越界直接报错，不返回截断值。
pub fn apply_patch(base: &VideoConfig, patch: &VideoConfigPatch) -> Result<VideoConfig, String> {
    let mut next = base.clone();
    if let Some(value) = patch.provider {
        next.provider = value;
    }
    if let Some(value) = patch.max_minutes {
        next.max_minutes = value;
    }
    if let Some(value) = patch.page_interval_seconds.or(patch.interval_seconds) {
        next.page_interval_seconds = value;
    }
    if let Some(value) = patch.sample_interval_seconds {
        next.sample_interval_seconds = value;
    }
    if let Some(value) = patch.max_items {
        next.max_items = value;
    }
    if let Some(value) = patch.daily_deliveries {
        next.daily_deliveries = value;
    }
    if let Some(value) = patch.channel_priority {
        next.channel_priority = value;
    }
    if let Some(value) = patch.model_summary {
        next.model_summary = value;
    }
    if let Some(value) = patch.auto_like {
        next.auto_like = value;
    }
    if let Some(value) = patch.auto_favorite {
        next.auto_favorite = value;
    }
    if let Some(value) = patch.auto_like_daily_limit {
        next.auto_like_daily_limit = value;
    }
    if let Some(value) = patch.auto_favorite_daily_limit {
        next.auto_favorite_daily_limit = value;
    }
    if let Some(value) = patch.keep_profile_on_clear {
        next.keep_profile_on_clear = value;
    }
    validate_config(&next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        assert!(validate_config(&VideoConfig::default()).is_ok());
    }

    #[test]
    fn rejects_out_of_range_without_truncating() {
        let mut config = VideoConfig::default();
        config.sample_interval_seconds = 6;
        assert!(validate_config(&config).is_err());

        let mut config = VideoConfig::default();
        config.max_items = 501;
        assert!(validate_config(&config).is_err());

        let mut config = VideoConfig::default();
        config.daily_deliveries = 6;
        assert!(validate_config(&config).is_err());

        let mut config = VideoConfig::default();
        config.auto_favorite_daily_limit = 6;
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn legacy_interval_field_maps_to_page_interval() {
        let patch: VideoConfigPatch =
            serde_json::from_str(r#"{"intervalSeconds": 90}"#).expect("patch");
        let next = apply_patch(&VideoConfig::default(), &patch).expect("valid");
        assert_eq!(next.page_interval_seconds, 90);
    }

    #[test]
    fn boundaries_are_inclusive() {
        let mut config = VideoConfig::default();
        config.max_minutes = 1;
        config.page_interval_seconds = 15;
        config.max_items = 20;
        assert!(validate_config(&config).is_ok());

        config.max_minutes = 240;
        config.page_interval_seconds = 600;
        config.max_items = 500;
        assert!(validate_config(&config).is_ok());
    }
}