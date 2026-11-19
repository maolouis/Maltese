//! 页面事实归一化：把适配器脚本返回的宽字段收敛成稳定的 `PageFacts`。
//!
//! 纯函数、无 I/O；指纹与脱敏都在这里完成。

use super::model::{now_seconds, NoteType, Platform};
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
    "imageUrls",
    "noteType",
    "likeCount",
    "collectCount",
    "publishedAt",
    "xsecToken",
    "coverUrl",
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
    // ---- 小红书（其它平台留空）----
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub note_type: String,
    #[serde(default)]
    pub like_count: u64,
    #[serde(default)]
    pub collect_count: u64,
    #[serde(default)]
    pub published_at: u64,
    #[serde(default)]
    pub xsec_token: String,
    #[serde(default)]
    pub cover_url: String,
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
    /// 小红书图片直链（只记录，不下载/不转存）。
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub note_type: Option<NoteType>,
    #[serde(default)]
    pub like_count: Option<u64>,
    #[serde(default)]
    pub collect_count: Option<u64>,
    /// 发布时间（unix 秒；只能拿到日期时按本地 0 点估算）。
    #[serde(default)]
    pub published_at: Option<u64>,
    /// 导航该笔记必须带上的 xsec_token（裸链接会 403）。
    #[serde(default)]
    pub xsec_token: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
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

/// 图片直链清洗：只留 http(s)、去重、限制 18 张（小红书 UI 上限附近）。
pub fn normalize_image_urls(values: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
            continue;
        }
        if trimmed.len() > 600 {
            continue;
        }
        if result.iter().any(|existing| existing == trimmed) {
            continue;
        }
        result.push(trimmed.to_string());
        if result.len() >= 18 {
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
    if !is_video_page(without_query, platform) {
        return None;
    }
    Some(without_query.to_string())
}

/// 判断 URL 是否落在「具体视频页」路径：B 站 /video/BVxxx 或 /video/av123，抖音 /video/<数字>。
pub fn is_video_page(url: &str, platform: Platform) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .map(|(_, path)| format!("/{path}"))
        .unwrap_or_default();
    let path = path.split(['?', '#']).next().unwrap_or("").to_string();
    match platform {
        Platform::Bilibili => {
            let Some(rest) = path.strip_prefix("/video/") else {
                return false;
            };
            let id = rest.split('/').next().unwrap_or("");
            if let Some(bv) = id.strip_prefix("bv") {
                return bv.len() >= 6 && bv.chars().all(|ch| ch.is_ascii_alphanumeric());
            }
            if let Some(av) = id.strip_prefix("av") {
                return !av.is_empty() && av.chars().all(|ch| ch.is_ascii_digit());
            }
            false
        }
        Platform::Douyin => {
            let Some(rest) = path.strip_prefix("/video/") else {
                return false;
            };
            let id = rest.split('/').next().unwrap_or("");
            !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit())
        }
        Platform::Xiaohongshu => {
            // 笔记详情：/explore/<noteId> 或 /discovery/item/<noteId>；/explore 本身是 feed。
            let id = path
                .strip_prefix("/explore/")
                .or_else(|| path.strip_prefix("/discovery/item/"))
                .unwrap_or("");
            let id = id.split('/').next().unwrap_or("");
            (20..=32).contains(&id.len()) && id.chars().all(|ch| ch.is_ascii_alphanumeric())
        }
    }
}

/// 伪条目判定（N2）：站点首页/整页 Feed、站点标题、短时长无作者、非视频页 URL。
pub fn pseudo_item_reason(
    title: &str,
    author: Option<&str>,
    duration_seconds: Option<u64>,
    canonical: Option<&str>,
    on_feed: bool,
) -> Option<&'static str> {
    if on_feed {
        return Some("page_feed");
    }
    if canonical.is_none() {
        return Some("not_video_page");
    }
    let normalized = title.trim();
    if normalized.is_empty() {
        return Some("empty_title");
    }
    if normalized.contains("哔哩哔哩")
        || normalized.contains("干杯")
        || normalized.contains("抖音-记录美好生活")
        || normalized.contains("小红书 - 你的生活兴趣社区")
    {
        return Some("site_title");
    }
    let has_author = author.map(|value| !value.trim().is_empty()).unwrap_or(false);
    if duration_seconds.unwrap_or(0) < 8 && !has_author {
        return Some("short_without_author");
    }
    None
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
    let image_urls = normalize_image_urls(&raw.image_urls);
    let note_type = NoteType::parse(&raw.note_type);
    let like_count = if raw.like_count == 0 { None } else { Some(raw.like_count) };
    let collect_count = if raw.collect_count == 0 { None } else { Some(raw.collect_count) };
    let published_at = if raw.published_at == 0 { None } else { Some(raw.published_at) };
    let xsec_token = {
        let value = raw.xsec_token.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.chars().take(200).collect::<String>())
        }
    };
    let cover_url = {
        let value = raw.cover_url.trim();
        if value.starts_with("http://") || value.starts_with("https://") {
            Some(value.to_string())
        } else {
            None
        }
    };

    let live_or_ad = platform != Platform::Xiaohongshu
        && (tags.iter().any(|tag| tag.contains("直播") || tag.contains("广告"))
            || title.contains("直播")
            || title.contains("广告"));
    let pseudo = pseudo_item_reason(
        &title,
        author.as_deref(),
        duration,
        canonical.as_deref(),
        raw.on_feed,
    );
    let (filtered, filter_reason) = if let Some(reason) = pseudo {
        (true, Some(reason.to_string()))
    } else if live_or_ad && duration.is_none() {
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
        image_urls,
        note_type,
        like_count,
        collect_count,
        published_at,
        xsec_token,
        cover_url,
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
        // coverUrl 现在是小🍠白名单字段，只剩 cookie 一个越界字段。
        assert_eq!(unknown, 1);
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

#[cfg(test)]
mod url_tests {
    use super::*;

    #[test]
    fn only_specific_video_pages_are_accepted() {
        assert!(canonical_url("https://www.bilibili.com/video/BV1xx411c7mD?spm=1", Platform::Bilibili).is_some());
        assert!(canonical_url("https://www.bilibili.com/video/av170001", Platform::Bilibili).is_some());
        assert!(canonical_url("https://www.bilibili.com/", Platform::Bilibili).is_none());
        assert!(canonical_url("https://www.bilibili.com/video/", Platform::Bilibili).is_none());
        assert!(canonical_url("https://www.bilibili.com/v/popular/all", Platform::Bilibili).is_none());
        assert!(canonical_url("https://www.douyin.com/video/7300000000000000000", Platform::Douyin).is_some());
        assert!(canonical_url("https://www.douyin.com/", Platform::Douyin).is_none());
    }

    #[test]
    fn pseudo_items_get_reasons() {
        assert_eq!(
            pseudo_item_reason("哔哩哔哩 (゜-゜)つロ 干杯~-bilibili", None, Some(6), Some("https://www.bilibili.com/video/BV1xx"), false),
            Some("site_title")
        );
        assert_eq!(pseudo_item_reason("某个视频", None, Some(6), None, false), Some("not_video_page"));
        assert_eq!(pseudo_item_reason("某个视频", None, Some(6), Some("https://www.bilibili.com/video/BV1xx"), true), Some("page_feed"));
        assert_eq!(pseudo_item_reason("某个视频", None, Some(6), Some("https://www.bilibili.com/video/BV1xx"), false), Some("short_without_author"));
        assert_eq!(pseudo_item_reason("正常视频", Some("UP主"), Some(60), Some("https://www.bilibili.com/video/BV1xx"), false), None);
    }
}
