//! 刷视频插件的数据模型。
//!
//! 这里只放可序列化的数据结构，不依赖 Tauri / Win32 / 网络。

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Bilibili,
    Douyin,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Bilibili => "bilibili",
            Platform::Douyin => "douyin",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "bilibili" => Some(Platform::Bilibili),
            "douyin" => Some(Platform::Douyin),
            _ => None,
        }
    }

    pub fn feed_url(self) -> &'static str {
        match self {
            Platform::Bilibili => "https://www.bilibili.com/",
            Platform::Douyin => "https://www.douyin.com/",
        }
    }

    pub fn matches_url(self, url: &str) -> bool {
        let lower = url.to_lowercase();
        match self {
            Platform::Bilibili => lower.contains("bilibili.com"),
            Platform::Douyin => lower.contains("douyin.com"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Preparing,
    AwaitingLogin,
    Collecting,
    UserTakeover,
    Digesting,
    Ended,
    Interrupted,
    Blocked,
    Stopped,
}

impl Default for Phase {
    fn default() -> Self {
        Phase::Idle
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    UserStop,
    DurationLimit,
    ItemLimit,
    BrowserClosed,
    SleepInterrupt,
    RiskControl,
    LeftRecommendFeed,
    Crash,
    TakeoverTimeout,
    /// 专用浏览器没启动起来 / CDP 端口不通（QA U1/U5：不再笼统记成 crash）。
    BrowserUnavailable,
    /// 页面要求登录或停在登录墙（QA U5）。
    LoginRequired,
    /// 页面能打开但解析不到内容（选择器失效 / 未加载完，QA U5）。
    ParseFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Full,
    Enhanced,
    Basic,
}

impl Default for Capability {
    fn default() -> Self {
        Capability::Basic
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelType {
    Cdp,
    Extension,
    Uia,
    Smtc,
    WindowTitle,
}

impl Default for ChannelType {
    fn default() -> Self {
        ChannelType::WindowTitle
    }
}

impl ChannelType {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelType::Cdp => "cdp",
            ChannelType::Extension => "extension",
            ChannelType::Uia => "uia",
            ChannelType::Smtc => "smtc",
            ChannelType::WindowTitle => "windowTitle",
        }
    }

    pub fn confidence(self) -> f32 {
        match self {
            ChannelType::Cdp | ChannelType::Extension => 1.0,
            ChannelType::Smtc => 0.6,
            ChannelType::Uia => 0.5,
            ChannelType::WindowTitle => 0.3,
        }
    }

    pub fn capability(self) -> Capability {
        match self {
            ChannelType::Cdp | ChannelType::Extension => Capability::Full,
            ChannelType::Uia => Capability::Enhanced,
            ChannelType::Smtc | ChannelType::WindowTitle => Capability::Basic,
        }
    }

    pub fn degraded_reason(self) -> Option<String> {
        match self {
            ChannelType::Cdp | ChannelType::Extension => None,
            ChannelType::Uia => Some("只能读标题与部分文本，无法判断完成度与互动".to_string()),
            ChannelType::Smtc => {
                Some("有标题/进度/时长，但无作者标签与互动，不能给强兴趣结论".to_string())
            }
            ChannelType::WindowTitle => Some("只能读标题，无法判断完成度，不作兴趣结论".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureReason {
    ParserMismatch,
    ChannelTimeout,
    ChannelUnstable,
    LoginRequired,
    RiskControl,
    LeftRecommendFeed,
    BrowserUnavailable,
    PortBusy,
    NavigationFailed,
    NoResponse,
    StartFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InterestLevel {
    Strong,
    Weak,
    Discard,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalKind {
    CompletionHigh,
    CompletionMid,
    WatchSubstantial,
    Rewatch,
    SeekBack,
    Like,
    Favorite,
    CoinShare,
    CommentArea,
    AuthorClick,
    ProfileMatch,
    QuickSkip,
    AuthorQuickSkip,
    NegativeTag,
}

impl SignalKind {
    pub fn default_weight(self) -> i32 {
        match self {
            SignalKind::CompletionHigh => 20,
            SignalKind::CompletionMid => 10,
            SignalKind::WatchSubstantial => 10,
            SignalKind::Rewatch => 15,
            SignalKind::SeekBack => 8,
            SignalKind::Like => 25,
            SignalKind::Favorite => 30,
            SignalKind::CoinShare => 30,
            SignalKind::CommentArea => 8,
            SignalKind::AuthorClick => 10,
            SignalKind::ProfileMatch => 15,
            SignalKind::QuickSkip => -30,
            SignalKind::AuthorQuickSkip => -20,
            SignalKind::NegativeTag => -40,
        }
    }

    pub fn evidence(self) -> &'static str {
        match self {
            SignalKind::CompletionHigh => "看到接近片尾",
            SignalKind::CompletionMid => "看完大半",
            SignalKind::WatchSubstantial => "有实质观看",
            SignalKind::Rewatch => "主动回看",
            SignalKind::SeekBack => "回拖进度反复看",
            SignalKind::Like => "点了赞",
            SignalKind::Favorite => "收藏了",
            SignalKind::CoinShare => "投币或分享",
            SignalKind::CommentArea => "在评论区停留",
            SignalKind::AuthorClick => "点了同作者或同话题",
            SignalKind::ProfileMatch => "与你的偏好重合",
            SignalKind::QuickSkip => "很快划过",
            SignalKind::AuthorQuickSkip => "连续划过同一作者",
            SignalKind::NegativeTag => "命中不想看的标签",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DigestGenerator {
    Model,
    Template,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DigestStatus {
    Generated,
    Delivered,
    Pending,
    Dropped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryStatus {
    Delivered,
    BubbleOnly,
    Pending,
    Dropped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryChannel {
    Chat,
    Bubble,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterestSignal {
    pub kind: SignalKind,
    pub weight: i32,
    pub evidence: String,
    pub confidence: f32,
    pub occurred_at: u64,
}

impl InterestSignal {
    pub fn new(kind: SignalKind, confidence: f32, occurred_at: u64) -> Self {
        Self {
            kind,
            weight: kind.default_weight(),
            evidence: kind.evidence().to_string(),
            confidence,
            occurred_at,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterestVerdict {
    pub raw_score: i32,
    pub final_score: i32,
    pub level: Option<InterestLevel>,
    pub blocked: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentItem {
    pub item_key: String,
    pub cluster_key: String,
    pub platform: Option<Platform>,
    pub title: String,
    pub author: Option<String>,
    pub duration_seconds: Option<u64>,
    pub watched_seconds: u64,
    pub position_seconds: u64,
    pub completion_percent: Option<u32>,
    pub tags: Vec<String>,
    pub canonical_url: Option<String>,
    pub source_confidence: f32,
    pub filtered: bool,
    pub filter_reason: Option<String>,
    pub signals: Vec<InterestSignal>,
    pub verdict: Option<InterestVerdict>,
    pub visits: u32,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
}

impl ContentItem {
    pub fn completion_percent(&self) -> Option<u32> {
        let duration = self.duration_seconds?;
        if duration == 0 {
            return None;
        }
        let percent = (self.position_seconds as f64 / duration as f64 * 100.0).round();
        Some(percent.clamp(0.0, 100.0) as u32)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestItem {
    pub item_key: String,
    pub title: String,
    pub author: Option<String>,
    pub platform: Platform,
    pub duration_seconds: Option<u64>,
    pub why_line: String,
    pub cluster_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub session_id: String,
    pub theme_line: Option<String>,
    pub generator: DigestGenerator,
    pub status: DigestStatus,
    pub total_chars: u32,
    pub created_at: u64,
    pub items: Vec<DigestItem>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestDraft {
    pub session_id: String,
    pub theme_line: Option<String>,
    pub generator: DigestGenerator,
    pub items: Vec<DigestItem>,
    #[serde(default)]
    pub total_chars: u32,
}

impl Default for DigestGenerator {
    fn default() -> Self {
        DigestGenerator::Template
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSession {
    pub session_id: String,
    pub platform: Platform,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub stop_reason: Option<StopReason>,
    pub channel_capability: Capability,
    pub item_count: u32,
    pub strong_count: u32,
    pub filtered_count: u32,
    pub error_code: Option<String>,
    pub schema_version: u32,
    pub items: Vec<ContentItem>,
    pub digest: Option<Digest>,
}

impl VideoSession {
    pub fn new(session_id: String, platform: Platform, started_at: u64) -> Self {
        Self {
            session_id,
            platform,
            started_at,
            ended_at: None,
            stop_reason: None,
            channel_capability: Capability::Basic,
            item_count: 0,
            strong_count: 0,
            filtered_count: 0,
            error_code: None,
            schema_version: SCHEMA_VERSION,
            items: Vec::new(),
            digest: None,
        }
    }
}

impl Default for Platform {
    fn default() -> Self {
        Platform::Bilibili
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub platform: Platform,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub stop_reason: Option<StopReason>,
    pub item_count: u32,
    pub strong_count: u32,
    pub filtered_count: u32,
    pub error_code: Option<String>,
    pub delivery_status: Option<DeliveryStatus>,
}

impl From<&VideoSession> for SessionSummary {
    fn from(session: &VideoSession) -> Self {
        Self {
            session_id: session.session_id.clone(),
            platform: session.platform,
            started_at: session.started_at,
            ended_at: session.ended_at,
            stop_reason: session.stop_reason,
            item_count: session.item_count,
            strong_count: session.strong_count,
            filtered_count: session.filtered_count,
            error_code: session.error_code.clone(),
            delivery_status: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSource {
    pub tag: String,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub positive_tags: Vec<String>,
    pub negative_tags: Vec<String>,
    pub preferred_authors: Vec<String>,
    pub sources: Vec<TagSource>,
    pub updated_at: u64,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRecord {
    pub session_id: String,
    pub delivered_at: u64,
    pub channels: Vec<DeliveryChannel>,
    pub item_keys: Vec<String>,
    pub cluster_keys: Vec<String>,
    pub status: DeliveryStatus,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutcome {
    pub status: DeliveryStatus,
    pub channels: Vec<DeliveryChannel>,
    pub at: u64,
}

impl Default for DeliveryStatus {
    fn default() -> Self {
        DeliveryStatus::Pending
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelState {
    #[serde(rename = "type")]
    pub channel_type: ChannelType,
    pub capability: Capability,
    pub last_success_at: Option<u64>,
    pub failure_reason: Option<FailureReason>,
    pub retry_count: u32,
    pub degraded_reason: Option<String>,
}

impl Default for ChannelState {
    fn default() -> Self {
        Self {
            channel_type: ChannelType::WindowTitle,
            capability: Capability::Basic,
            last_success_at: None,
            failure_reason: None,
            retry_count: 0,
            degraded_reason: ChannelType::WindowTitle.degraded_reason(),
        }
    }
}

impl ChannelState {
    pub fn for_type(channel_type: ChannelType) -> Self {
        Self {
            channel_type,
            capability: channel_type.capability(),
            last_success_at: None,
            failure_reason: None,
            retry_count: 0,
            degraded_reason: channel_type.degraded_reason(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub at: u64,
    pub session_id: Option<String>,
    pub channel: Option<ChannelType>,
    pub level: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClearScope {
    Sessions,
    Profile,
    Deliveries,
    Logs,
    All,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub scope: ClearScope,
    pub removed_bytes: u64,
    pub kept: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_parsing_is_case_insensitive() {
        assert_eq!(Platform::parse("Bilibili"), Some(Platform::Bilibili));
        assert_eq!(Platform::parse(" douyin "), Some(Platform::Douyin));
        assert_eq!(Platform::parse("youtube"), None);
    }

    #[test]
    fn channel_confidence_matches_design() {
        assert_eq!(ChannelType::Cdp.confidence(), 1.0);
        assert_eq!(ChannelType::Smtc.confidence(), 0.6);
        assert_eq!(ChannelType::Uia.confidence(), 0.5);
        assert_eq!(ChannelType::WindowTitle.confidence(), 0.3);
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let session = VideoSession::new("bili-1".to_string(), Platform::Bilibili, 10);
        let value = serde_json::to_value(&session).expect("serialize session");
        assert!(value.get("sessionId").is_some());
        assert!(value.get("channelCapability").is_some());
        assert!(value.get("schemaVersion").is_some());
    }
}