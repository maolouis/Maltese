//! 页面事实归一化：把适配器脚本返回的宽字段收敛成稳定的 `PageFacts`。
//!
//! 纯函数、无 I/O；指纹与脱敏都在这里完成。

use super::model::{now_seconds, Platform};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

const MAX_TITLE_CHARS: usize = 200;
const MAX_TAG_CHARS: usize = 30;
const MAX_TAGS: usize = 10;

pub const RAW_FIELDS: &[&str] = &[
    "itemId",
    "title",
    "description",
    "author",
    "durationSeconds",
    "positionSeconds",
    "playing",
    "visible",
    "tags",
    "liked",
    "favorited",
    "coinOrShare",
    "commentSeconds",
    "authorClicked",
    "seekBack",
    "visits",
    "url",
    "loginVisible",
    "captchaVisible",
    "riskBanner",
    "onFeed",
];

/// 适配器脚本返回的宽字段（字段名与页面脚本一致）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFacts {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub duration_seconds: u64,
    #[serde(default)]
    pub position_seconds: u64,
    #[serde(default)]
    pub playing: bool,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub liked: bool,
    #[serde(default)]
    pub favorited: bool,
    #[serde(default)]
    pub coin_or_share: bool,
    #[serde(default)]
    pub comment_seconds: u64,
    #[serde(default)]
    pub author_clicked: bool,
    #[serde(default)]
    pub seek_back: bool,
    #[serde(default)]
    pub visits: u32,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub login_visible: bool,
    #[serde(default)]
    pub captcha_visible: bool,
    #[serde(default)]
    pub risk_banner: bool,
    #[serde(default)]
    pub on_feed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHints {
    pub login_visible: bool,
    pub captcha_visible: bool,
    pub risk_banner: bool,
    pub on_feed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageKind {
    Feed,
    Login,
    RiskControl,
    Other,
}

#[derive(Clone, Debug)]
pub enum ExtractIssue {
    EmptyTitle,
    InvalidUrl,
    InvalidPayload(String),
}

impl std::fmt::Display for ExtractIssue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractIssue::EmptyTitle => write!(formatter, "页面没有可用标题"),
            ExtractIssue::InvalidUrl => write!(formatter, "页面 URL 不是平台域名"),
            ExtractIssue::InvalidPayload(message) => write!(formatter, "页面数据不可解析：{message}"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFacts {
    pub item_key: String,
    pub cluster_key: String,
    pub platform: Platform,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub author: Option<String>,
    pub duration_seconds: Option<u64>,
    pub position_seconds: u64,
    pub playing: bool,
    pub visible: bool,
    pub tags: Vec<String>,
    pub liked: bool,
    pub favorited: bool,
    pub coin_or_share: bool,
    pub comment_seconds: u64,
    pub author_clicked: bool,
    pub seek_back: bool,
    pub visits: u32,
    pub canonical_url: Option<String>,
    pub confidence: f32,
    pub hints: PageHints,
    pub filtered: bool,
    pub filter_reason: Option<String>,
    pub observed_at: u64,
}

impl PageFacts {
    pub fn completion_percent(&self) -> Option<u32> {
        let duration = self.duration_seconds?;
        if duration == 0 {
            return None;
        }
        let percent = (self.position_seconds as f64 / duration as f64 * 100.0).round();
        Some(percent.clamp(0.0, 100.0) as u32)
    }

    pub fn is_quick_skip(&self) -> bool {
        self.watched_guess() <= 3 && self.completion_percent().unwrap_or(0) < 10
    }

    fn watched_guess(&self) -> u64 {
        self.position_seconds.max(0)
    }
}

pub fn normalize_title(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_TITLE_CHARS).collect()
}

pub fn normalize_description(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

pub fn normalize_author(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(MAX_TAG_CHARS).collect())
    }
}

pub fn normalize_tags(values: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        let tag: String = value.trim().chars().take(MAX_TAG_CHARS).collect();
        if tag.is_empty() || result.iter().any(|existing| existing.eq_ignore_ascii_case(&tag)) {
            continue;
        }
        result.push(tag);
        if result.len() >= MAX_TAGS {
            break;
        }
    }
    result
}

/// 只保留平台 + 路径段，剥掉 query 与 fragment。
pub fn canonical_url(value: &str, platform: Platform) -> Option<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return None;
    }
    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    let without_query = without_fragment.split('?').next().unwrap_or(without_fragment);
    if !platform.matches_url(without_query) {
        return None;
    }
    Some(without_query.to_string())
}

fn hash_prefix(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    hex.chars().take(32).collect()
}

/// 去掉标点与空白、小写，用于指纹。
pub fn normalize_key_part(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
        .collect::<String>()
        .to_lowercase()
}

pub fn item_key(platform: Platform, item_id: &str, title: &str, author: Option<&str>) -> String {
    let item_id = item_id.trim();
    if !item_id.is_empty() {
        return hash_prefix(&format!("v1|{}|{}", platform.as_str(), item_id));
    }
    hash_prefix(&format!(
        "v1|{}|{}|{}",
        platform.as_str(),
        normalize_key_part(title),
        normalize_key_part(author.unwrap_or(""))
    ))
}

pub fn cluster_key(platform: Platform, author: Option<&str>, tags: &[String]) -> String {
    if let Some(author) = author.filter(|value| !value.trim().is_empty()) {
        return hash_prefix(&format!(
            "a1|{}|{}",
            platform.as_str(),
            normalize_key_part(author)
        ));
    }
    if let Some(tag) = tags.iter().find(|tag| !tag.trim().is_empty()) {
        return hash_prefix(&format!("t1|{}|{}", platform.as_str(), normalize_key_part(tag)));
    }
    String::new()
}

pub fn normalize_facts(
    raw: RawFacts,
    platform: Platform,
    confidence: f32,
) -> Result<PageFacts, ExtractIssue> {
    let title = normalize_title(&raw.title);
    if title.is_empty() {
        return Err(ExtractIssue::EmptyTitle);
    }
    let author = normalize_author(&raw.author);
    let description = normalize_description(&raw.description);
    let tags = normalize_tags(&raw.tags);
    let duration = if raw.duration_seconds == 0 {
        None
    } else {
        Some(raw.duration_seconds)
    };
    let key = item_key(platform, &raw.item_id, &title, author.as_deref());
    let cluster = {
        let computed = cluster_key(platform, author.as_deref(), &tags);
        if computed.is_empty() {
            key.clone()
        } else {
            computed
        }
    };
    let canonical = canonical_url(&raw.url, platform);

    let live_or_ad = tags.iter().any(|tag| tag.contains("直播") || tag.contains("广告"))
        || title.contains("直播")
        || title.contains("广告");
    let (filtered, filter_reason) = if live_or_ad && duration.is_none() {
        (true, Some("直播或广告，且没有有效时长".to_string()))
    } else {
        (false, None)
    };

    Ok(PageFacts {
        item_key: key,
        cluster_key: cluster,
        platform,
        title,
        description,
        author,
        duration_seconds: duration,
        position_seconds: raw.position_seconds,
        playing: raw.playing,
        visible: raw.visible,
        tags,
        liked: raw.liked,
        favorited: raw.favorited,
        coin_or_share: raw.coin_or_share,
        comment_seconds: raw.comment_seconds,
        author_clicked: raw.author_clicked,
        seek_back: raw.seek_back,
        visits: raw.visits,
        canonical_url: canonical,
        confidence,
        hints: PageHints {
            login_visible: raw.login_visible,
            captcha_visible: raw.captcha_visible,
            risk_banner: raw.risk_banner,
            on_feed: raw.on_feed,
        },
        filtered,
        filter_reason,
        observed_at: now_seconds(),
    })
}

/// 解析脚本 JSON，并统计字段白名单外的字段数。
pub fn normalize_value(
    value: &serde_json::Value,
    platform: Platform,
    confidence: f32,
) -> Result<(PageFacts, usize), ExtractIssue> {
    let object = value
        .as_object()
        .ok_or_else(|| ExtractIssue::InvalidPayload("root is not an object".to_string()))?;
    let unknown = object
        .keys()
        .filter(|key| !RAW_FIELDS.contains(&key.as_str()))
        .count();
    let raw: RawFacts = serde_json::from_value(value.clone())
        .map_err(|error| ExtractIssue::InvalidPayload(error.to_string()))?;
    let facts = normalize_facts(raw, platform, confidence)?;
    Ok((facts, unknown))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(title: &str) -> RawFacts {
        RawFacts {
            title: title.to_string(),
            url: "https://www.bilibili.com/video/BV1xx?spm=1#reply".to_string(),
            duration_seconds: 120,
            position_seconds: 60,
            playing: true,
            visible: true,
            on_feed: true,
            ..RawFacts::default()
        }
    }

    #[test]
    fn normalizes_title_and_author() {
        let facts = normalize_facts(
            RawFacts {
                title: "  一个  不错的   视频  ".to_string(),
                author: "  ".to_string(),
                ..raw("x")
            },
            Platform::Bilibili,
            1.0,
        )
        .expect("facts");
        assert_eq!(facts.title, "一个 不错的 视频");
        assert!(facts.author.is_none());

        let long = "字".repeat(300);
        assert_eq!(normalize_title(&long).chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn zero_duration_is_unknown_not_zero() {
        let facts = normalize_facts(
            RawFacts {
                duration_seconds: 0,
                ..raw("普通视频")
            },
            Platform::Bilibili,
            1.0,
        )
        .expect("facts");
        assert_eq!(facts.duration_seconds, None);
        assert_eq!(facts.completion_percent(), None);
    }

    #[test]
    fn dedupes_and_limits_tags() {
        let tags: Vec<String> = (0..15).map(|index| format!(" tag{index} ")).collect();
        let mut values = tags;
        values.push("TAG0".to_string());
        let normalized = normalize_tags(&values);
        assert_eq!(normalized.len(), MAX_TAGS);
        assert_eq!(normalized[0], "tag0");
    }

    #[test]
    fn strips_query_and_fragment_from_url() {
        let url = canonical_url("https://www.bilibili.com/video/BV1xx?spm=1#reply", Platform::Bilibili)
            .expect("url");
        assert_eq!(url, "https://www.bilibili.com/video/BV1xx");
        assert!(!url.contains('?'));
        assert!(!url.contains('#'));
        assert!(canonical_url("https://evil.com/x", Platform::Bilibili).is_none());
    }

    #[test]
    fn item_key_is_stable_and_platform_scoped() {
        let first = item_key(Platform::Bilibili, "BV1xx", "标题", Some("作者"));
        let second = item_key(Platform::Bilibili, "BV1xx", "标题", Some("作者"));
        let other = item_key(Platform::Douyin, "BV1xx", "标题", Some("作者"));
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert_eq!(first.len(), 32);
    }

    #[test]
    fn fallback_key_uses_title_and_author() {
        let first = item_key(Platform::Bilibili, "", "同一个 标题", Some("作者"));
        let second = item_key(Platform::Bilibili, "", "同一个标题", Some("作者"));
        assert_eq!(first, second);
    }

    #[test]
    fn filters_live_and_ad_without_duration() {
        let facts = normalize_facts(
            RawFacts {
                title: "正在直播：今天聊点啥".to_string(),
                duration_seconds: 0,
                ..raw("x")
            },
            Platform::Bilibili,
            1.0,
        )
        .expect("facts");
        assert!(facts.filtered);
        assert!(facts.filter_reason.is_some());
    }

    #[test]
    fn drops_superset_fields_and_reports_count() {
        let value = serde_json::json!({
            "title": "标题",
            "url": "https://www.bilibili.com/video/BV1xx",
            "durationSeconds": 60,
            "cookie": "secret",
            "coverUrl": "https://example.com/a.jpg"
        });
        let (facts, unknown) = normalize_value(&value, Platform::Bilibili, 1.0).expect("facts");
        assert_eq!(unknown, 2);
        assert_eq!(facts.title, "标题");
    }

    #[test]
    fn rejects_empty_title() {
        let result = normalize_facts(raw("   "), Platform::Douyin, 1.0);
        assert!(matches!(result, Err(ExtractIssue::EmptyTitle)));
    }

    #[test]
    fn completion_percent_is_clamped() {
        let mut facts = normalize_facts(raw("标题"), Platform::Bilibili, 1.0).expect("facts");
        facts.position_seconds = 999;
        facts.duration_seconds = Some(100);
        assert_eq!(facts.completion_percent(), Some(100));
    }
}
