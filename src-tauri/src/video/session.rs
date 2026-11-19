//! 会话编排：状态机、采集 tick、翻页调度、整理与投递入队。
//!
//! 纯逻辑部分（状态迁移、条目合并）可单测；运行部分通过 CDP 驱动专用浏览器，
//! CDP 不可用时降级到前台窗口标题（弱通道，只作主题线索）。

use super::adapter::{adapter_for, PlatformAdapter};
use super::accounts::{AccountStore, AccountStatus, AgentAccount};
use super::browser::{self, BrowserInstance};
use super::cdp::{port_alive, shutdown_browser, CdpSession, EVALUATE_TIMEOUT};
use super::channel::ChannelManager;
use super::comment::generate_content_comment;
use super::CommentReport;
use super::config::{apply_patch, validate_config, VideoCommentModelConfig, VideoConfig, VideoConfigPatch};
use super::delivery::can_deliver;
use super::digest::build_digest;
use super::extract::{is_video_page, normalize_value, PageFacts, PageKind};
use super::guard::Guard;
use super::interest::score;
use super::model::*;
use super::profile::learn_from_session;
use super::queue::{
    fallback_candidate_pages, parse_candidates, url_matches_video_id, CandidateQueue,
    FailureOutcome, PageProbe, QueuedCandidate, REFILL_THRESHOLD,
};
use super::store::StoreHandle;
use super::{VideoError, VideoResult};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub const FIRST_ACTION_DELAY_SECONDS: u64 = 6;
pub const SNAPSHOT_THROTTLE_MS: u64 = 500;
pub const MAX_ITEMS_HARD_CAP: usize = 500;
pub const SAMPLE_BURST_WINDOW_SECONDS: u64 = 60;
pub const SAMPLE_BURST_LIMIT: usize = 30;
pub const SAMPLE_BURST_KEEP: usize = 10;
const MAX_CDP_FAILURES: u32 = 3;
const MAX_RECONNECT_FAILURES: u32 = 3;

/// 专用浏览器实例的现状（面板高级设置里展示，便于判断「会不会复用上次的浏览器」）。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub profile_dir: String,
    pub marker_present: bool,
    pub marker_pid_alive: bool,
    pub cdp_ready: bool,
    /// owned / external / fresh，和 browser::reuse_decision 一致。
    pub reuse: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSnapshot {
    pub session_id: String,
    pub provider: String,
    pub account_id: Option<String>,
    pub auto_comment: bool,
    pub phase: Phase,
    pub running: bool,
    pub interval_seconds: u64,
    pub max_minutes: u64,
    pub steps: u64,
    pub item_count: u32,
    pub strong_count: u32,
    pub filtered_count: u32,
    /// 当前自动评论是否只生成不发送。
    pub comment_dry_run: bool,
    /// 本轮已产生的评论数（含预演）。
    pub comment_count: u32,
    /// 其中仅预演的条数。
    pub comment_dry_run_count: u32,
    /// 最近一条评论（无头/无 UI 场景也能在面板看到）。
    pub last_comment_text: String,
    pub last_comment_dry_run: bool,
    pub last_comment_verified: bool,
    pub last_comment_at: u64,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub last_action_at: Option<u64>,
    pub current_url: String,
    pub waiting_for_browser: bool,
    pub foreground_title: String,
    pub foreground_process: String,
    pub channel: ChannelState,
    pub pending_count: u32,
    pub persist_failed: bool,
    pub degraded: bool,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

impl Default for VideoSnapshot {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            provider: "bilibili".to_string(),
            account_id: None,
            auto_comment: false,
            phase: Phase::Idle,
            running: false,
            interval_seconds: 45,
            max_minutes: 30,
            steps: 0,
            item_count: 0,
            strong_count: 0,
            filtered_count: 0,
            comment_dry_run: true,
            comment_count: 0,
            comment_dry_run_count: 0,
            last_comment_text: String::new(),
            last_comment_dry_run: false,
            last_comment_verified: false,
            last_comment_at: 0,
            started_at: None,
            ended_at: None,
            last_action_at: None,
            current_url: String::new(),
            waiting_for_browser: false,
            foreground_title: String::new(),
            foreground_process: String::new(),
            channel: ChannelState::default(),
            pending_count: 0,
            persist_failed: false,
            degraded: false,
            error_code: None,
            error: None,
        }
    }
}

fn allowed_transition(current: Phase, next: Phase) -> bool {
    use Phase::*;
    matches!(
        (current, next),
        (Idle, Preparing)
            | (Preparing, AwaitingLogin)
            | (Preparing, Collecting)
            | (Preparing, Stopped)
            | (Preparing, Idle)
            | (AwaitingLogin, Collecting)
            | (AwaitingLogin, Stopped)
            | (Collecting, UserTakeover)
            | (Collecting, Digesting)
            | (Collecting, Interrupted)
            | (Collecting, Blocked)
            | (Collecting, Stopped)
            | (UserTakeover, Collecting)
            | (UserTakeover, Digesting)
            | (UserTakeover, Stopped)
            | (Digesting, Ended)
            | (Ended, Idle)
            | (Interrupted, Idle)
            | (Blocked, Idle)
            | (Stopped, Idle)
    )
}

#[derive(Default)]
pub struct TransitionResult {
    pub applied: bool,
    pub diagnostics: u32,
}

/// 非法迁移一律忽略并记诊断，防止「停止 + 到点」重复整理。
pub fn try_transition(current: &mut Phase, next: Phase, diagnostics: &mut u32) -> bool {
    if allowed_transition(*current, next) {
        *current = next;
        true
    } else {
        *diagnostics = diagnostics.saturating_add(1);
        false
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    New,
    Updated,
    Filtered,
    Ignored,
}

fn upsert_signal(item: &mut ContentItem, kind: SignalKind, at: u64) {
    if item.signals.iter().any(|signal| signal.kind == kind) {
        return;
    }
    item.signals
        .push(InterestSignal::new(kind, item.source_confidence.max(0.1), at));
}

/// 合并一次采集：同 `itemKey` 只保留一个条目，进度回退 >5 秒记为拖动。
pub fn merge_facts(items: &mut Vec<ContentItem>, facts: &PageFacts, now: u64) -> MergeOutcome {
    if facts.filtered {
        return MergeOutcome::Filtered;
    }
    // N1 第二道：已经有 canonicalUrl 但不是具体视频页（例如站点首页）→ 丢弃。
    if let Some(url) = facts.canonical_url.as_deref() {
        if !is_video_page(url, facts.platform) {
            return MergeOutcome::Filtered;
        }
    }
    if let Some(item) = items.iter_mut().find(|item| item.item_key == facts.item_key) {
        let previous_position = item.position_seconds;
        let advanced = facts.position_seconds.saturating_sub(previous_position);
        if facts.playing && facts.visible {
            if advanced > 5 {
                upsert_signal(item, SignalKind::SeekBack, now);
            } else {
                item.watched_seconds = item.watched_seconds.saturating_add(advanced);
            }
        }
        item.position_seconds = facts.position_seconds;
        item.duration_seconds = facts.duration_seconds.or(item.duration_seconds);
        item.title = facts.title.clone();
        if !facts.description.is_empty() {
            item.description = facts.description.clone();
        }
        item.author = facts.author.clone();
        item.tags = facts.tags.clone();
        item.canonical_url = facts.canonical_url.clone();
        item.source_confidence = facts.confidence;
        item.last_seen_at = now;
        item.visits = item.visits.saturating_add(1);
        if facts.liked {
            upsert_signal(item, SignalKind::Like, now);
        }
        if facts.favorited {
            upsert_signal(item, SignalKind::Favorite, now);
        }
        if facts.coin_or_share {
            upsert_signal(item, SignalKind::CoinShare, now);
        }
        if facts.comment_seconds >= 10 {
            upsert_signal(item, SignalKind::CommentArea, now);
        }
        if facts.author_clicked {
            upsert_signal(item, SignalKind::AuthorClick, now);
        }
        if facts.seek_back {
            upsert_signal(item, SignalKind::SeekBack, now);
        }
        if item.visits >= 2 && item.watched_seconds >= 60 {
            upsert_signal(item, SignalKind::Rewatch, now);
        }
        return MergeOutcome::Updated;
    }

    if items.len() >= MAX_ITEMS_HARD_CAP {
        return MergeOutcome::Ignored;
    }

    let mut item = ContentItem {
        item_key: facts.item_key.clone(),
        cluster_key: facts.cluster_key.clone(),
        platform: Some(facts.platform),
        title: facts.title.clone(),
        description: facts.description.clone(),
        author: facts.author.clone(),
        duration_seconds: facts.duration_seconds,
        watched_seconds: 0,
        position_seconds: facts.position_seconds,
        completion_percent: facts.completion_percent(),
        tags: facts.tags.clone(),
        canonical_url: facts.canonical_url.clone(),
        source_confidence: facts.confidence,
        filtered: false,
        filter_reason: None,
        signals: Vec::new(),
        verdict: None,
        visits: 1,
        first_seen_at: now,
        last_seen_at: now,
    };
    if facts.liked {
        upsert_signal(&mut item, SignalKind::Like, now);
    }
    if facts.favorited {
        upsert_signal(&mut item, SignalKind::Favorite, now);
    }
    if facts.coin_or_share {
        upsert_signal(&mut item, SignalKind::CoinShare, now);
    }
    if facts.comment_seconds >= 10 {
        upsert_signal(&mut item, SignalKind::CommentArea, now);
    }
    if facts.author_clicked {
        upsert_signal(&mut item, SignalKind::AuthorClick, now);
    }
    if facts.seek_back {
        upsert_signal(&mut item, SignalKind::SeekBack, now);
    }
    items.push(item);
    MergeOutcome::New
}

fn new_session_id(platform: Platform) -> String {
    let date = {
        let now = now_seconds();
        let days = now / 86_400;
        let z = days as i64 + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let year = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        format!("{year:04}{month:02}{day:02}")
    };
    let random = (now_seconds() ^ ((std::process::id() as u64) << 17) ^ 0x9e37_79b9_7f4a_7c15)
        & 0xff_ffff;
    let prefix = match platform {
        Platform::Bilibili => "bili",
        Platform::Douyin => "douyin",
    };
    format!("{prefix}-{date}-{random:06x}")
}

struct RuntimeState {
    session_id: String,
    phase: Phase,
    platform: Platform,
    provider: String,
    account_id: Option<String>,
    /// 本轮启动时从聊天设置传入的模型配置，只保存在内存。
    comment_model: Option<VideoCommentModelConfig>,
    interval_seconds: u64,
    max_minutes: u64,
    sample_interval_seconds: u64,
    started_at: u64,
    ended_at: Option<u64>,
    stop_reason: Option<StopReason>,
    steps: u64,
    items: Vec<ContentItem>,
    filtered_count: u32,
    comment_count: u32,
    comment_dry_run_count: u32,
    last_comment_text: String,
    last_comment_dry_run: bool,
    last_comment_verified: bool,
    last_comment_at: u64,
    current_url: String,
    waiting_for_browser: bool,
    foreground_title: String,
    foreground_process: String,
    channel: ChannelState,
    pending_count: u32,
    persist_failed: bool,
    degraded: bool,
    error_code: Option<String>,
    error_message: Option<String>,
    last_action_at: Option<u64>,
    diagnostics: u32,
    /// 当前专用浏览器实例的 CDP 端口（0 表示还没起来），评论等一次性操作要用。
    cdp_port: u16,
    /// 本轮评论记录（历史详情用）。
    comments: Vec<SessionComment>,
    /// 稳定性改造：本轮导航轮次、失败 URL 数、成功采集轮次、已采到的不同视频 id。
    round_index: u64,
    failed_urls: u32,
    collected_rounds: u32,
    collected_ids: std::collections::HashSet<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            phase: Phase::Idle,
            platform: Platform::Bilibili,
            provider: "bilibili".to_string(),
            account_id: None,
            comment_model: None,
            interval_seconds: 45,
            max_minutes: 30,
            sample_interval_seconds: 2,
            started_at: 0,
            ended_at: None,
            stop_reason: None,
            steps: 0,
            items: Vec::new(),
            filtered_count: 0,
            comment_count: 0,
            comment_dry_run_count: 0,
            last_comment_text: String::new(),
            last_comment_dry_run: false,
            last_comment_verified: false,
            last_comment_at: 0,
            current_url: String::new(),
            waiting_for_browser: false,
            foreground_title: String::new(),
            foreground_process: String::new(),
            channel: ChannelState::default(),
            pending_count: 0,
            persist_failed: false,
            degraded: false,
            error_code: None,
            error_message: None,
            last_action_at: None,
            diagnostics: 0,
            cdp_port: 0,
            comments: Vec::new(),
            round_index: 0,
            failed_urls: 0,
            collected_rounds: 0,
            collected_ids: std::collections::HashSet::new(),
        }
    }
}

pub struct SessionEngine {
    store: StoreHandle,
    accounts: Mutex<AccountStore>,
    state: Mutex<RuntimeState>,
    config: Mutex<VideoConfig>,
    channel: Mutex<ChannelManager>,
    guard: Mutex<Guard>,
    browser: Mutex<Option<BrowserInstance>>,
    stop: AtomicBool,
    run_id: AtomicU64,
}

static ENGINE: OnceLock<Arc<SessionEngine>> = OnceLock::new();

pub(crate) fn data_root(app: &AppHandle) -> std::path::PathBuf {
    crate::paths::data_root().join("video")
}

pub fn engine(app: &AppHandle) -> Arc<SessionEngine> {
    ENGINE
        .get_or_init(|| {
            let store = StoreHandle::new(data_root(app));
            // 进程异常退出（崩溃/被重启）时，磁盘上会留下 endedAt=null 的会话：
            // 启动时补成 crash + 补算摘要，保证历史不会一直空白。
            recover_interrupted_sessions(&store);
            Arc::new(SessionEngine {
                store,
                accounts: Mutex::new(AccountStore::load(&data_root(app))),
                state: Mutex::new(RuntimeState::default()),
                config: Mutex::new(VideoConfig::default()),
                channel: Mutex::new(ChannelManager::new()),
                guard: Mutex::new(Guard::default_guard()),
                browser: Mutex::new(None),
                stop: AtomicBool::new(false),
                run_id: AtomicU64::new(0),
            })
        })
        .clone()
}

fn lock_state(state: &Mutex<RuntimeState>) -> std::sync::MutexGuard<'_, RuntimeState> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}



/// 一条视频页停留过程的结局。
enum DwellOutcome {
    /// 页面被带回非视频页（首页/推荐流），需要立刻换下一条。
    TargetLost,
    /// 用户停止或被新会话顶掉。
    Aborted,
    /// 停够了或视频播完；带上最后一次页面事实（可能为空）。
    Finished(Option<PageFacts>),
}

/// 页面探针：URL / 标题 / video 元素 / og:title。
const PAGE_PROBE_JS: &str = r#"
(() => {
  const meta = (name) => (document.querySelector(`meta[property="${name}"]`)?.content || '').trim();
  return {
    href: location.href,
    title: document.title || '',
    hasVideo: !!document.querySelector('video'),
    ogTitle: meta('og:title'),
  };
})()
"#;

/// navigate 后等待「页面关键信息就绪」的最长时间与轮询间隔。
const PAGE_READY_WAIT_SECONDS: u64 = 8;
const PAGE_READY_POLL_MS: u64 = 350;

pub async fn probe_page(cdp: &mut CdpSession) -> Option<PageProbe> {
    let value = cdp.evaluate(PAGE_PROBE_JS, EVALUATE_TIMEOUT).await.ok()?;
    serde_json::from_value(value).ok()
}

/// 轮询等页面就绪：URL 命中该 bvid + 标题不是站点标题 + 有 video/og:title。
/// 最多 PAGE_READY_WAIT_SECONDS 秒，超时返回 None（调用方按这条 URL 失败处理）。
pub async fn wait_page_ready(cdp: &mut CdpSession, expected_id: &str) -> Option<PageProbe> {
    let deadline = Instant::now() + Duration::from_secs(PAGE_READY_WAIT_SECONDS);
    loop {
        if let Some(probe) = probe_page(cdp).await {
            if probe.is_ready(expected_id) {
                return Some(probe);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(PAGE_READY_POLL_MS)).await;
    }
}
/// N11：评论清洗（≤40 字、去 @/链接/禁词）。模型空/失败时必须返回错误，
/// 不再发送固定模板，避免把“模型未生成”伪装成真实评论。
fn sanitize_comment(raw: &str) -> Result<String, String> {
    const BANNED: [&str; 7] = ["三连", "求关注", "互关", "点个赞", "投币", "私信", "加微信"];
    let mut text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    for word in BANNED {
        text = text.replace(word, "");
    }
    text = text
        .split_whitespace()
        .filter(|part| !part.starts_with("http://") && !part.starts_with("https://") && !part.starts_with('@'))
        .collect::<Vec<_>>()
        .join(" ");
    let text: String = text.trim().chars().take(40).collect();
    if text.trim().is_empty() {
        Err("模型没有返回可用评论".to_string())
    } else {
        Ok(text.trim().to_string())
    }
}

fn comment_bubble(title: &str, comment: &str) -> String {
    let short: String = title.trim().chars().take(12).collect();
    format!("刚给《{short}》评论了一句：{comment}")
}

/// 评论回读匹配：去掉空白与标点后做子串匹配（容忍页面截断/换行差异）。
pub fn comment_in_text(page_text: &str, comment: &str) -> bool {
    fn normalize(value: &str) -> String {
        value
            .chars()
            .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
            .filter(|ch| !matches!(ch, '，' | '。' | '！' | '？' | '：' | '；' | '、' | '…' | '“' | '”' | '‘' | '’' | '（' | '）' | '《' | '》'))
            .collect::<String>()
    }
    let page = normalize(page_text);
    let target = normalize(comment);
    if target.is_empty() || page.is_empty() {
        return false;
    }
    // 页面可能显示不全：取评论前 60% 做匹配，兼顾短评论。
    let probe: String = target.chars().take((target.chars().count() * 3 / 5).max(4)).collect();
    page.contains(&probe)
}

/// 启动时兜底：把上次异常退出（崩溃/被重启）留下的「未结束」会话补成 crash，
/// 有 items 就补算摘要。保证历史里永远不是「有内容但显示空白」。
fn recover_interrupted_sessions(store: &StoreHandle) {
    let now = now_seconds();
    let profile = store.profile();
    for summary in store.list_sessions(50) {
        if summary.ended_at.is_some() {
            continue;
        }
        let Some(mut session) = store.get_session(&summary.session_id) else {
            continue;
        };
        let last_seen = session
            .items
            .iter()
            .map(|item| item.last_seen_at)
            .max()
            .unwrap_or(session.started_at)
            .max(session.started_at);
        session.ended_at = Some(last_seen);
        session.stop_reason = Some(StopReason::Crash);
        if session.error_code.is_none() {
            session.error_code = Some("INTERRUPTED".to_string());
        }
        session.item_count = session.items.len() as u32;
        if session.digest.is_none() {
            session.digest = digest_for_items(
                &session.session_id,
                session.platform,
                &session.items,
                &profile,
                last_seen,
            );
        }
        store.save_session(&session);
        store.log(DiagnosticEntry {
            at: now,
            session_id: Some(session.session_id.clone()),
            channel: None,
            level: "warn".to_string(),
            code: "SESSION_RECOVERED".to_string(),
            message: format!(
                "reason=crash items={} has_digest={} from=endedAt_null",
                session.items.len(),
                session.digest.is_some()
            ),
        });
    }
}

/// 用已有条目补算一份摘要（与停止时同一套打分/模板）。
fn digest_for_items(
    session_id: &str,
    platform: Platform,
    items: &[ContentItem],
    profile: &UserProfile,
    created_at: u64,
) -> Option<Digest> {
    if items.is_empty() {
        return None;
    }
    let mut scored = items.to_vec();
    for item in &mut scored {
        item.verdict = Some(score(item, profile, item.source_confidence.max(0.1)));
    }
    let mut strong: Vec<ContentItem> = scored
        .iter()
        .filter(|item| {
            item.verdict.as_ref().and_then(|verdict| verdict.level) == Some(InterestLevel::Strong)
        })
        .cloned()
        .collect();
    let weak: Vec<ContentItem> = scored
        .iter()
        .filter(|item| {
            item.verdict.as_ref().and_then(|verdict| verdict.level) == Some(InterestLevel::Weak)
        })
        .cloned()
        .collect();
    if strong.is_empty() && scored.len() >= 2 {
        let mut relaxed = scored.clone();
        for item in relaxed.iter_mut().take(5) {
            if let Some(verdict) = item.verdict.as_mut() {
                verdict.level = Some(InterestLevel::Strong);
            }
        }
        strong = relaxed;
    }
    let draft = build_digest(session_id, platform, &strong, &weak, 5)?;
    Some(Digest {
        session_id: session_id.to_string(),
        theme_line: draft.theme_line,
        generator: draft.generator,
        status: DigestStatus::Pending,
        total_chars: draft.total_chars,
        created_at,
        items: draft.items,
        reflection: None,
        reflection_source: None,
    })
}

impl SessionEngine {

    /// 采集过程中增量落盘（历史记录不再只有启动时的空快照）。
    fn persist_runtime_session(&self) {
        let state = lock_state(&self.state);
        if state.session_id.is_empty() {
            return;
        }
        let session = VideoSession {
            session_id: state.session_id.clone(),
            platform: state.platform,
            account_id: state.account_id.clone(),
            started_at: state.started_at,
            ended_at: None,
            stop_reason: None,
            channel_capability: state.channel.capability,
            item_count: state.items.len() as u32,
            strong_count: state
                .items
                .iter()
                .filter(|item| {
                    item.verdict.as_ref().and_then(|verdict| verdict.level)
                        == Some(InterestLevel::Strong)
                })
                .count() as u32,
            filtered_count: state.filtered_count,
            error_code: state.error_code.clone(),
            schema_version: SCHEMA_VERSION,
            items: state.items.clone(),
            digest: None,
            comments: state.comments.clone(),
        };
        drop(state);
        self.store.save_session(&session);
    }

    /// 自检：把一条评论写进 live snapshot 并发气泡事件（不依赖采集是否成功）。
    pub fn selftest_comment(&self, app: &AppHandle, text: &str) {
        let now = now_seconds();
        self.store.log(DiagnosticEntry {
            at: now,
            session_id: Some(self.snapshot().session_id),
            channel: None,
            level: "info".to_string(),
            code: "COMMENT_SELFTEST".to_string(),
            message: format!("invoked text={}", text),
        });
        {
            let mut state = lock_state(&self.state);
            state.last_comment_text = text.to_string();
            state.last_comment_dry_run = true;
            state.last_comment_verified = false;
            state.last_comment_at = now;
        }
        let _ = app.emit(
            "video-comment-bubble",
            serde_json::json!({
                "kind": "selftest",
                "text": format!("小狗评论（预演）：{}", text),
            }),
        );
    }

    pub fn snapshot(&self) -> VideoSnapshot {
        let state = lock_state(&self.state);
        VideoSnapshot {
            session_id: state.session_id.clone(),
            provider: state.provider.clone(),
            account_id: state.account_id.clone(),
            auto_comment: self.config().auto_comment,
            phase: state.phase,
            running: matches!(
                state.phase,
                Phase::Preparing | Phase::AwaitingLogin | Phase::Collecting | Phase::UserTakeover
            ),
            interval_seconds: state.interval_seconds,
            max_minutes: state.max_minutes,
            steps: state.steps,
            item_count: state.items.len() as u32,
            strong_count: state
                .items
                .iter()
                .filter(|item| {
                    item.verdict.as_ref().and_then(|verdict| verdict.level)
                        == Some(InterestLevel::Strong)
                })
                .count() as u32,
            filtered_count: state.filtered_count,
            comment_dry_run: self.config().comment_dry_run,
            comment_count: state.comment_count,
            comment_dry_run_count: state.comment_dry_run_count,
            last_comment_text: state.last_comment_text.clone(),
            last_comment_dry_run: state.last_comment_dry_run,
            last_comment_verified: state.last_comment_verified,
            last_comment_at: state.last_comment_at,
            started_at: if state.started_at == 0 {
                None
            } else {
                Some(state.started_at)
            },
            ended_at: state.ended_at,
            last_action_at: state.last_action_at,
            current_url: state.current_url.clone(),
            waiting_for_browser: state.waiting_for_browser,
            foreground_title: state.foreground_title.clone(),
            foreground_process: state.foreground_process.clone(),
            channel: state.channel.clone(),
            pending_count: self.store.pending_count() as u32,
            persist_failed: state.persist_failed || self.store.persist_failed(),
            degraded: state.degraded,
            error_code: state.error_code.clone(),
            error: state.error_message.clone(),
        }
    }

    fn browser_alive(&self) -> bool {
        match self.browser.lock() {
            Ok(mut browser) => browser.as_mut().map(|process| process.is_alive()).unwrap_or(false),
            Err(poisoned) => poisoned.into_inner().as_mut().map(|process| process.is_alive()).unwrap_or(false),
        }
    }

    /// 取出（并关闭）内存里记录的专用浏览器实例。
    fn take_browser(&self) -> Option<BrowserInstance> {
        match self.browser.lock() {
            Ok(mut browser) => browser.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }

    fn close_browser_instance(&self) {
        if let Some(mut instance) = self.take_browser() {
            instance.close();
        }
        browser::clear_marker();
    }

    /// 装上本次要用的实例；同时把 CDP 端口写进运行态（评论等一次性操作要用）。
    fn install_browser(&self, instance: BrowserInstance) -> u16 {
        let handle = instance.handle().clone();
        if let Some(mut previous) = self.take_browser() {
            previous.close();
        }
        match self.browser.lock() {
            Ok(mut browser) => *browser = Some(instance),
            Err(poisoned) => *poisoned.into_inner() = Some(instance),
        }
        browser::write_marker(&handle);
        if let Ok(mut state) = self.state.lock() {
            state.cdp_port = handle.port;
        }
        handle.port
    }

    /// 内存里同 profile、仍存活且 CDP 可用的实例。
    fn owned_reusable(&self, profile: &std::path::Path) -> bool {
        match self.browser.lock() {
            Ok(mut browser) => match browser.as_mut() {
                Some(instance) => {
                    instance.is_alive()
                        && browser::same_profile(&instance.handle().profile_dir, profile)
                        && browser::cdp_ready(instance.handle().port)
                }
                None => false,
            },
            Err(poisoned) => match poisoned.into_inner().as_mut() {
                Some(instance) => {
                    instance.is_alive()
                        && browser::same_profile(&instance.handle().profile_dir, profile)
                        && browser::cdp_ready(instance.handle().port)
                }
                None => false,
            },
        }
    }

    /// 启动失败时把本次启动的浏览器关掉，并落一条诊断日志（QA U1/U4）。
    fn fail_start(self: &Arc<Self>, app: &AppHandle, code: &str, message: &str, detail: &str) -> VideoError {
        self.close_browser_instance();
        self.set_runtime_error(code, message);
        self.store.log(DiagnosticEntry {
            at: now_seconds(),
            session_id: {
                let state = lock_state(&self.state);
                if state.session_id.is_empty() {
                    None
                } else {
                    Some(state.session_id.clone())
                }
            },
            channel: None,
            level: "error".to_string(),
            code: code.to_string(),
            message: format!("{message}{detail}"),
        });
        self.finish(app, StopReason::BrowserUnavailable, false);
        VideoError::with_detail(code, message, detail)
    }

    fn set_runtime_error(&self, code: &str, message: &str) {
        // 错误必须同时进「持久状态」和诊断日志：
        // 持久状态保证面板重挂载后还能看到，日志保证 DSH /api/video/diagnostics 能排障（QA U3/U4）。
        let entry = {
            let mut state = lock_state(&self.state);
            state.error_code = Some(code.to_string());
            state.error_message = Some(message.to_string());
            state.waiting_for_browser = false;
            DiagnosticEntry {
                at: now_seconds(),
                session_id: if state.session_id.is_empty() {
                    None
                } else {
                    Some(state.session_id.clone())
                },
                channel: Some(state.channel.channel_type),
                level: "error".to_string(),
                code: code.to_string(),
                message: message.to_string(),
            }
        };
        self.store.log(entry);
    }

    pub fn config(&self) -> VideoConfig {
        match self.config.lock() {
            Ok(config) => config.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn accounts(&self) -> Vec<AgentAccount> {
        self.accounts.lock().map(|accounts| accounts.list()).unwrap_or_default()
    }

    pub fn active_account(&self) -> Option<AgentAccount> {
        self.accounts.lock().ok().and_then(|accounts| accounts.active())
    }

    pub fn create_account(
        &self,
        platform: Platform,
        display_name: String,
        handle: String,
        persona: String,
        goals: String,
    ) -> VideoResult<AgentAccount> {
        let mut accounts = self.accounts.lock().map_err(|_| VideoError::new("ACCOUNT_ERROR", "小狗账号状态不可用。"))?;
        let profile_id = format!("dog-{}-{}", now_seconds(), accounts.list().len() + 1);
        accounts
            .create(
                platform,
                display_name,
                handle,
                persona,
                goals,
                browser::account_profile_dir(&profile_id),
            )
            .map_err(|message| VideoError::new("ACCOUNT_INVALID", message))
    }

    pub fn set_active_account(&self, account_id: &str) -> VideoResult<AgentAccount> {
        self.accounts
            .lock()
            .map_err(|_| VideoError::new("ACCOUNT_ERROR", "小狗账号状态不可用。"))?
            .set_active(account_id)
            .map_err(|message| VideoError::new("ACCOUNT_NOT_FOUND", message))
    }

    pub fn mark_account_ready(&self, account_id: &str) -> VideoResult<AgentAccount> {
        self.accounts
            .lock()
            .map_err(|_| VideoError::new("ACCOUNT_ERROR", "小狗账号状态不可用。"))?
            .mark_ready(account_id)
            .map_err(|message| VideoError::new("ACCOUNT_NOT_FOUND", message))
    }

    pub fn update_config(&self, patch: &VideoConfigPatch) -> VideoResult<VideoConfig> {
        let base = self.config();
        let next = apply_patch(&base, patch)
            .map_err(|message| VideoError::new("INVALID_CONFIG", message))?;
        match self.config.lock() {
            Ok(mut config) => *config = next.clone(),
            Err(poisoned) => *poisoned.into_inner() = next.clone(),
        }
        Ok(next)
    }

    pub async fn start(
        self: &Arc<Self>,
        app: AppHandle,
        provider: Platform,
        patch: Option<VideoConfigPatch>,
        requested_account_id: Option<String>,
    ) -> VideoResult<VideoSnapshot> {
        let comment_model = patch.as_ref().and_then(|value| value.comment_model.clone());
        if let Some(patch) = patch.as_ref() {
            self.update_config(patch)?;
        }
        let config = self.config();
        validate_config(&config)
            .map_err(|message| VideoError::new("INVALID_CONFIG", message))?;

        let account = {
            let accounts = self.accounts.lock().map_err(|_| VideoError::new("ACCOUNT_ERROR", "小狗账号状态不可用。"))?;
            let selected = requested_account_id
                .as_deref()
                .and_then(|id| accounts.list().into_iter().find(|item| item.id == id));
            if let Some(account) = selected {
                if account.platform != provider {
                    return Err(VideoError::new("ACCOUNT_PLATFORM_MISMATCH", "小狗账号的平台和当前刷视频平台不一致。"));
                }
                if account.status != AccountStatus::Ready {
                    return Err(VideoError::new("ACCOUNT_NOT_READY", "请先打开小狗账号的专用登录窗，完成注册或登录后点“我已登录”。"));
                }
                Some(account)
            } else {
                None
            }
        };
        let account_id = account.as_ref().map(|item| item.id.clone());
        let profile = account.as_ref().map(|item| std::path::PathBuf::from(&item.profile_dir));

        {
            let already_running = {
                let state = lock_state(&self.state);
                matches!(
                    state.phase,
                    Phase::Preparing
                        | Phase::AwaitingLogin
                        | Phase::Collecting
                        | Phase::UserTakeover
                )
            };
            if already_running {
                return Ok(self.snapshot());
            }
            let mut state = lock_state(&self.state);
            let session_id = new_session_id(provider);
            let started_at = now_seconds();
            *state = RuntimeState {
                session_id: session_id.clone(),
                phase: Phase::Preparing,
                platform: provider,
                provider: provider.as_str().to_string(),
                account_id: account_id.clone(),
                interval_seconds: config.page_interval_seconds,
                max_minutes: config.max_minutes,
                sample_interval_seconds: config.sample_interval_seconds,
                comment_model: comment_model.clone(),
                started_at,
                ..RuntimeState::default()
            };
            let mut diagnostics = 0;
            try_transition(&mut state.phase, Phase::Collecting, &mut diagnostics);
            state.diagnostics = diagnostics;

            let mut session = VideoSession::new(session_id.clone(), provider, started_at);
            session.account_id = account_id.clone();
            self.store.save_session(&session);
            // N3：每次运行开始必须落日志（启动事件）。
            self.store.log(DiagnosticEntry {
                at: started_at,
                session_id: Some(session_id.clone()),
                channel: None,
                level: "info".to_string(),
                code: "SESSION_STARTED".to_string(),
                message: format!("provider={} interval={}s max={}min", provider.as_str(), config.page_interval_seconds, config.max_minutes),
            });
        }

        let run_id = self.run_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.stop.store(false, Ordering::SeqCst);

        let profile = profile.unwrap_or_else(browser::profile_dir);

        // U1：专用浏览器只允许「一个 profile 一个实例」。
        // 顺序：内存里还活着 → 复用；上次运行留下的同 profile 实例（应用重启后 handle 丢了）
        // → 接管它的端口；都没有 → 先清掉残留实例再启动，端口和 profile 始终绑在同一个实例上。
        let port = if self.owned_reusable(&profile) {
            let port = match self.browser.lock() {
                Ok(browser) => browser
                    .as_ref()
                    .map(|instance| instance.handle().port)
                    .unwrap_or(0),
                Err(poisoned) => poisoned
                    .into_inner()
                    .as_ref()
                    .map(|instance| instance.handle().port)
                    .unwrap_or(0),
            };
            if let Ok(mut state) = self.state.lock() {
                state.cdp_port = port;
            }
            port
        } else if let Some(handle) = browser::find_reusable(&profile) {
            // 接管上次留下的实例：它的端口已经在监听，不再开新进程（以前会换端口再 launch，
            // 结果新进程被转交给旧实例，端口永远不监听 → 15s 后 CDP_UNAVAILABLE）。
            let port = handle.port;
            self.install_browser(BrowserInstance::External(handle));
            port
        } else {
            // 残留实例还占着 profile/端口但 CDP 不通：先关掉，否则新进程拿不到 profile。
            let closed = browser::close_profile_instance(&profile);
            if closed > 0 {
                self.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: None,
                    channel: None,
                    level: "info".to_string(),
                    code: "STALE_BROWSER_CLOSED".to_string(),
                    message: format!(
                        "启动了新专用浏览器前，先关闭了上一个占用同一登录 profile 的残留实例（{closed} 个）。"
                    ),
                });
            }
            self.close_browser_instance();
            let port = match browser::pick_port(browser::DEFAULT_PORT) {
                Ok(port) => port,
                Err(error) => {
                    self.abort_start(Phase::Stopped, &error.code, &error.message);
                    // 失败也要落一条会话，历史里才能看到真实原因（QA U5）。
                    self.finish(&app, StopReason::BrowserUnavailable, false);
                    return Err(error);
                }
            };
            let process = match browser::launch(provider, port, &profile, false) {
                Ok(process) => process,
                Err(error) => {
                    self.abort_start(Phase::Stopped, &error.code, &error.message);
                    self.finish(&app, StopReason::BrowserUnavailable, false);
                    return Err(error);
                }
            };
            let handle = process.handle.clone();
            if !browser::wait_for_cdp_async(port, browser::CDP_READY_TIMEOUT).await {
                // 本次启动的进程必须关掉，不能留下占着 profile 的孤儿实例（U1/U10）。
                let mut process = process;
                process.close();
                let error = self.fail_start(
                    &app,
                    "CDP_UNAVAILABLE",
                    "小狗专用浏览器启动后没有打开调试端口，本轮已停止。",
                    &format!("port={port} profile={}", profile.display()),
                );
                return Err(error);
            }
            browser::write_marker(&handle);
            self.install_browser(BrowserInstance::Owned(process));
            port
        };
        if let Some(account_id) = account_id.as_deref() {
            let _ = self.accounts.lock().map_err(|_| ()).and_then(|mut accounts| accounts.mark_run(account_id).map_err(|_| ())); 
        }

        let engine = self.clone();
        let app_for_loop = app.clone();
        tauri::async_runtime::spawn(async move {
            engine.run(app_for_loop, port, run_id).await;
        });

        Ok(self.snapshot())
    }

    fn abort_start(&self, phase: Phase, code: &str, message: &str) {
        {
            let mut state = lock_state(&self.state);
            state.phase = phase;
            state.error_code = Some(code.to_string());
            state.error_message = Some(message.to_string());
        }
        self.store.log(DiagnosticEntry {
            at: now_seconds(),
            session_id: {
                let state = lock_state(&self.state);
                if state.session_id.is_empty() {
                    None
                } else {
                    Some(state.session_id.clone())
                }
            },
            channel: None,
            level: "error".to_string(),
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    /// 停止会话：只做「发信号 + 落一条停止日志 + 返回快照」，
    /// 写终态/生成摘要/关浏览器全部丢到后台阻塞线程，命令立即返回（用户点停止不再卡界面）。
    pub fn stop(self: &Arc<Self>, app: &AppHandle, reason: Option<StopReason>) -> VideoSnapshot {
        self.stop.store(true, Ordering::SeqCst);
        self.run_id.fetch_add(1, Ordering::SeqCst);
        let stop_reason = reason.unwrap_or(StopReason::UserStop);
        let running = {
            let state = lock_state(&self.state);
            matches!(
                state.phase,
                Phase::Preparing | Phase::AwaitingLogin | Phase::Collecting | Phase::UserTakeover
            )
        };
        if running {
            {
                let mut state = lock_state(&self.state);
                self.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: Some(state.session_id.clone()),
                    channel: None,
                    level: "info".to_string(),
                    code: "SESSION_STOPPED".to_string(),
                    message: format!(
                        "reason={:?} items={} filtered={}",
                        stop_reason,
                        state.items.len(),
                        state.filtered_count
                    ),
                });
                // 立刻把 phase 置为 stopped：采集循环看到就退出，不会重复收尾。
                state.phase = Phase::Stopped;
                state.stop_reason = Some(stop_reason);
            }
            let engine = self.clone();
            let app_for_cleanup = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                // 同一把状态锁保证 finish 不会和采集循环打架（循环已因 stop 退出）。
                engine.finish(&app_for_cleanup, stop_reason, true);
            });
            let snapshot = self.snapshot();
            let _ = app.emit("video-session-updated", snapshot);
            return self.snapshot();
        }

        {
            let mut state = lock_state(&self.state);
            let mut diagnostics = 0;
            if try_transition(&mut state.phase, Phase::Stopped, &mut diagnostics) {
                state.stop_reason = Some(stop_reason);
                state.ended_at = Some(now_seconds());
            }
        }
        let engine = self.clone();
        tauri::async_runtime::spawn_blocking(move || engine.close_browser_instance());
        self.snapshot()
    }

    /// 命令耗时埋点：>200ms 记 SLOW_COMMAND，>1s 记 VERY_SLOW_COMMAND。
    pub fn command_cost(&self, name: &str, ms: u64) {
        if ms < 200 {
            return;
        }
        let (code, level) = if ms >= 1000 {
            ("VERY_SLOW_COMMAND", "warn")
        } else {
            ("SLOW_COMMAND", "info")
        };
        self.store.log(DiagnosticEntry {
            at: now_seconds(),
            session_id: None,
            channel: None,
            level: level.to_string(),
            code: code.to_string(),
            message: format!("name={} ms={}", name, ms),
        });
    }

    /// 统一写诊断日志，避免每处都手写 DiagnosticEntry。
    fn log_event(
        &self,
        session_id: Option<&str>,
        channel: Option<ChannelType>,
        level: &str,
        code: &str,
        message: impl Into<String>,
    ) {
        self.store.log(DiagnosticEntry {
            at: now_seconds(),
            session_id: session_id.map(str::to_string),
            channel,
            level: level.to_string(),
            code: code.to_string(),
            message: message.into(),
        });
    }

    fn browser_port(&self) -> Option<u16> {
        match self.browser.lock() {
            Ok(browser) => browser.as_ref().map(|instance| instance.handle().port),
            Err(poisoned) => poisoned
                .into_inner()
                .as_ref()
                .map(|instance| instance.handle().port),
        }
    }

    /// CDP 完全不可用时才走的唯一重启路径：
    /// 关旧实例 → 重新 launch → wait_for_cdp → 连新端口。端口可能变化。
    async fn restart_browser(&self, platform: Platform, session_id: &str) -> Option<CdpSession> {
        self.log_event(
            Some(session_id),
            None,
            "warn",
            "BROWSER_RESTART",
            "step=close reason=cdp_unavailable",
        );
        self.close_browser_instance();
        tokio::time::sleep(Duration::from_secs(1)).await;
        let profile = self
            .accounts
            .lock()
            .ok()
            .and_then(|accounts| accounts.active())
            .map(|account| std::path::PathBuf::from(&account.profile_dir))
            .unwrap_or_else(browser::profile_dir);
        let port = match browser::pick_port(browser::DEFAULT_PORT) {
            Ok(port) => port,
            Err(error) => {
                self.log_event(
                    Some(session_id),
                    None,
                    "error",
                    "BROWSER_RESTART",
                    format!("ok=false step=pick_port reason={}", error.message),
                );
                return None;
            }
        };
        let process = match browser::launch(platform, port, &profile, false) {
            Ok(process) => process,
            Err(error) => {
                self.log_event(
                    Some(session_id),
                    None,
                    "error",
                    "BROWSER_RESTART",
                    format!("ok=false step=launch reason={}", error.message),
                );
                return None;
            }
        };
        let handle = process.handle.clone();
        if !browser::wait_for_cdp(port, browser::CDP_READY_TIMEOUT) {
            let mut process = process;
            process.close();
            self.log_event(
                Some(session_id),
                None,
                "error",
                "BROWSER_RESTART",
                format!("ok=false step=cdp port={port}"),
            );
            return None;
        }
        browser::write_marker(&handle);
        self.install_browser(BrowserInstance::Owned(process));
        match CdpSession::connect(port, platform).await {
            Ok(session) => {
                self.log_event(
                    Some(session_id),
                    None,
                    "info",
                    "BROWSER_RESTART",
                    format!("ok=true port={port}"),
                );
                if let Ok(mut state) = self.state.lock() {
                    state.cdp_port = port;
                }
                Some(session)
            }
            Err(_) => {
                self.log_event(
                    Some(session_id),
                    None,
                    "error",
                    "BROWSER_RESTART",
                    format!("ok=false step=connect port={port}"),
                );
                None
            }
        }
    }

    /// 连 CDP：先重试 MAX_RECONNECT_FAILURES 次，仍失败才重启浏览器（默认不重启）。
    async fn open_session(
        &self,
        platform: Platform,
        port: &mut u16,
        session_id: &str,
    ) -> Option<CdpSession> {
        for _ in 0..MAX_RECONNECT_FAILURES {
            if self.stop.load(Ordering::SeqCst) {
                return None;
            }
            match CdpSession::connect(*port, platform).await {
                Ok(session) => return Some(session),
                Err(_) => tokio::time::sleep(Duration::from_millis(700)).await,
            }
        }
        self.log_event(
            Some(session_id),
            None,
            "warn",
            "CDP_UNAVAILABLE",
            format!("connect_failures={} port={}", MAX_RECONNECT_FAILURES, port),
        );
        let session = self.restart_browser(platform, session_id).await?;
        if let Some(new_port) = self.browser_port() {
            *port = new_port;
        }
        Some(session)
    }

    /// 从当前页面批量抓候选链接入队，写 `CANDIDATES n=… sample=…`。
    async fn fill_candidate_queue(
        &self,
        cdp: &mut CdpSession,
        adapter: &'static dyn PlatformAdapter,
        platform: Platform,
        queue: &mut CandidateQueue,
        session_id: &str,
    ) -> usize {
        let value = match cdp.evaluate(adapter.candidate_script(), EVALUATE_TIMEOUT).await {
            Ok(value) => value,
            Err(_) => {
                self.log_event(
                    Some(session_id),
                    Some(ChannelType::Cdp),
                    "warn",
                    "CANDIDATES",
                    "n=0 reason=script_failed",
                );
                return 0;
            }
        };
        let added = queue.push_candidates(parse_candidates(&value, platform));
        let sample = queue.sample(3).join(" ");
        self.log_event(
            Some(session_id),
            Some(ChannelType::Cdp),
            "info",
            "CANDIDATES",
            format!(
                "n={} queue={} sample={}",
                added,
                queue.remaining(),
                sample
            ),
        );
        added
    }

    /// 记录一次 URL 失败：连败 2 次拉黑并写 `URL_BLACKLIST`，同时落一条 `ROUND`。
    fn record_url_failure(
        &self,
        queue: &mut CandidateQueue,
        target: &QueuedCandidate,
        session_id: &str,
        rounds: &mut u64,
        failed_urls: &mut u32,
    ) {
        *failed_urls = failed_urls.saturating_add(1);
        match queue.record_failure(&target.id) {
            FailureOutcome::Retry(count) => self.log_event(
                Some(session_id),
                Some(ChannelType::Cdp),
                "warn",
                "URL_FAILED",
                format!(
                    "url={} id={} count={} queue={}",
                    target.url,
                    target.id,
                    count,
                    queue.remaining()
                ),
            ),
            FailureOutcome::Blacklisted(count) => self.log_event(
                Some(session_id),
                Some(ChannelType::Cdp),
                "warn",
                "URL_BLACKLIST",
                format!(
                    "url={} id={} failures={} blacklist={}",
                    target.url,
                    target.id,
                    count,
                    queue.blacklist_len()
                ),
            ),
        }
        *rounds = rounds.saturating_add(1);
        let (items, _) = {
            let mut state = lock_state(&self.state);
            state.round_index = *rounds;
            state.failed_urls = *failed_urls;
            state.waiting_for_browser = false;
            (state.items.len(), state.phase)
        };
        self.log_event(
            Some(session_id),
            Some(ChannelType::Cdp),
            "warn",
            "ROUND",
            format!(
                "n={} url={} title= items={} queue={} failed={}",
                rounds,
                target.url,
                items,
                queue.remaining(),
                failed_urls
            ),
        );
    }

    /// 在一条视频页上停留采样：页面健康检查 + 累计观看时长，最长 page_interval 秒。
    async fn dwell_on_video(
        &self,
        cdp: &mut CdpSession,
        expected_id: &str,
        session_id: &str,
        extract_script: &str,
        platform: Platform,
        config: &VideoConfig,
        run_id: u64,
    ) -> DwellOutcome {
        let dwell_seconds = config.page_interval_seconds.clamp(15, 180);
        let sample_seconds = config.sample_interval_seconds.clamp(1, 5);
        let started = Instant::now();
        let mut last_facts: Option<PageFacts> = None;
        let mut last_persist = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(sample_seconds)).await;
            if self.stop.load(Ordering::SeqCst) || self.run_id.load(Ordering::SeqCst) != run_id {
                return DwellOutcome::Aborted;
            }
            let href = cdp.current_url().await;
            if !href.is_empty() && !url_matches_video_id(&href, expected_id) {
                self.log_event(
                    Some(session_id),
                    Some(ChannelType::Cdp),
                    "warn",
                    "TARGET_HEALTH",
                    format!(
                        "url={} expect={} ok=false action=next_candidate",
                        href, expected_id
                    ),
                );
                return DwellOutcome::TargetLost;
            }
            if let Ok(value) = cdp.evaluate(extract_script, EVALUATE_TIMEOUT).await {
                if let Ok((facts, _unknown)) = normalize_value(&value, platform, 1.0) {
                    let ended = facts
                        .duration_seconds
                        .map(|duration| duration > 0 && facts.position_seconds + 1 >= duration)
                        .unwrap_or(false)
                        && !facts.playing;
                    {
                        let mut state = lock_state(&self.state);
                        merge_facts(&mut state.items, &facts, now_seconds());
                        if let Some(url) = facts.canonical_url.clone() {
                            state.current_url = url;
                        }
                        state.foreground_title = facts.title.clone();
                        state.waiting_for_browser = false;
                    }
                    last_facts = Some(facts);
                    // 每 30 秒把边看边攒的观看时长增量落盘。
                    if last_persist.elapsed() >= Duration::from_secs(30) {
                        last_persist = Instant::now();
                        self.persist_runtime_session();
                    }
                    if ended {
                        return DwellOutcome::Finished(last_facts.take());
                    }
                }
            }
            if started.elapsed() >= Duration::from_secs(dwell_seconds) {
                return DwellOutcome::Finished(last_facts.take());
            }
        }
    }

    async fn run(self: Arc<Self>, app: AppHandle, port: u16, run_id: u64) {
        let platform = self.snapshot().provider;
        let platform = Platform::parse(&platform).unwrap_or(Platform::Bilibili);
        let adapter = adapter_for(platform);
        let session_id = self.snapshot().session_id;
        let mut last_emit = Instant::now() - Duration::from_millis(SNAPSHOT_THROTTLE_MS);

        // P0：清掉同 profile 的多余浏览器实例，只保留当前端口。
        {
            let mut alive: Vec<u16> = Vec::new();
            for candidate in 9333u16..=9338 {
                if port_alive(candidate).await {
                    alive.push(candidate);
                }
            }
            if alive.len() > 1 {
                let mut closed = 0usize;
                for candidate in alive.iter().copied() {
                    if candidate == port {
                        continue;
                    }
                    if shutdown_browser(candidate).await {
                        closed += 1;
                    }
                }
                self.log_event(
                    Some(&session_id),
                    None,
                    "warn",
                    "BROWSER_ENFORCED_SINGLE",
                    format!("closed={} kept_port={} alive={:?}", closed, port, alive),
                );
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }

        let mut port = port;
        let mut session = match self.open_session(platform, &mut port, &session_id).await {
            Some(session) => session,
            None => {
                self.set_runtime_error(
                    "CDP_UNAVAILABLE",
                    "小狗专用浏览器调试接口连不上（重连 3 次、重启浏览器也没成功），本轮已停止。",
                );
                self.close_browser_instance();
                self.finish(&app, StopReason::BrowserUnavailable, false);
                return;
            }
        };

        // 初始候选：先回推荐流 / 首页，批量抓链接（之后只直接导航，不再点击卡片）。
        if session.navigate(adapter.feed_url()).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(1800)).await;
        }
        let mut queue = CandidateQueue::new();
        let mut rounds: u64 = 0;
        let mut collected_rounds: u32 = 0;
        let mut failed_urls: u32 = 0;
        let mut empty_fills: u32 = 0;
        let mut cdp_failures = 0u32;
        let mut last_housekeeping_at = now_seconds();
        let mut last_progress_at = now_seconds();
        let mut stall_logged = false;
        let mut commented_urls: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut last_comment_at = 0u64;
        let mut comment_count = 0u32;
        let mut last_skip_reason: Option<String> = None;
        let mut login_risk_logged = false;

        loop {
            if self.stop.load(Ordering::SeqCst) || self.run_id.load(Ordering::SeqCst) != run_id {
                break;
            }
            let config = self.config();
            let (phase, started_at, item_count) = {
                let state = lock_state(&self.state);
                (state.phase, state.started_at, state.items.len())
            };
            if !matches!(
                phase,
                Phase::Collecting | Phase::AwaitingLogin | Phase::UserTakeover
            ) {
                break;
            }
            if !self.browser_alive() {
                self.set_runtime_error(
                    "BROWSER_CLOSED",
                    "小狗浏览器已关闭，已停止本轮并保留已采集内容。",
                );
                self.finish(&app, StopReason::BrowserClosed, false);
                break;
            }
            if now_seconds().saturating_sub(started_at) >= config.max_minutes.saturating_mul(60) {
                self.finish(&app, StopReason::DurationLimit, true);
                break;
            }
            if item_count >= config.max_items as usize {
                self.finish(&app, StopReason::ItemLimit, true);
                break;
            }

            let now = now_seconds();
            // 停滞看门狗：只记一笔 + 让补货逻辑重新抓候选，不清空队列
            // （清空会丢掉本轮已采集合与黑名单，导致 ROUND 计数回退）。
            if now.saturating_sub(last_progress_at) >= 30 && !stall_logged {
                stall_logged = true;
                let url = self.snapshot().current_url;
                self.log_event(
                    Some(&session_id),
                    None,
                    "warn",
                    "STALL_WATCH",
                    format!(
                        "no_progress_for={}s url={} queue={} action=refill",
                        now.saturating_sub(last_progress_at),
                        url,
                        queue.remaining()
                    ),
                );
            }
            // A1：每 10s 一次单实例体检（运行中也可能被拉起第二个实例）。
            if now.saturating_sub(last_housekeeping_at) >= 10 {
                last_housekeeping_at = now;
                let mut alive: Vec<u16> = Vec::new();
                for candidate in 9333u16..=9338 {
                    if port_alive(candidate).await {
                        alive.push(candidate);
                    }
                }
                if alive.len() > 1 {
                    let mut closed = 0usize;
                    for candidate in alive.iter().copied() {
                        if candidate == port {
                            continue;
                        }
                        if shutdown_browser(candidate).await {
                            closed += 1;
                        }
                    }
                    self.log_event(
                        Some(&session_id),
                        None,
                        "warn",
                        "BROWSER_ENFORCED_SINGLE",
                        format!("closed={} kept_port={} alive={:?}", closed, port, alive),
                    );
                }
            }

            // CDP 坏了先重连；重连 3 次仍失败才重启浏览器（restart 里会重建队列）。
            if cdp_failures >= MAX_CDP_FAILURES {
                cdp_failures = 0;
                self.log_event(
                    Some(&session_id),
                    None,
                    "warn",
                    "CDP_RECOVER",
                    format!("port={} action=reconnect", port),
                );
                match self.open_session(platform, &mut port, &session_id).await {
                    Some(next) => {
                        session = next;
                        // 重启 / 重连后必须重建候选队列。
                        queue = CandidateQueue::new();
                        let _ = session.navigate(adapter.feed_url()).await;
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        self.fill_candidate_queue(
                            &mut session,
                            adapter,
                            platform,
                            &mut queue,
                            &session_id,
                        )
                        .await;
                        continue;
                    }
                    None => {
                        self.set_runtime_error(
                            "CDP_UNAVAILABLE",
                            "小狗专用浏览器调试接口连不上，本轮已停止。",
                        );
                        self.finish(&app, StopReason::BrowserUnavailable, true);
                        break;
                    }
                }
            }

            // 队列见底就补货；补不到就回热门/排行榜兜底。
            if queue.remaining() < REFILL_THRESHOLD {
                self.fill_candidate_queue(
                    &mut session,
                    adapter,
                    platform,
                    &mut queue,
                    &session_id,
                )
                .await;
                if queue.remaining() == 0 {
                    for fallback in fallback_candidate_pages(platform) {
                        if session.navigate(fallback).await.is_err() {
                            cdp_failures = cdp_failures.saturating_add(1);
                            continue;
                        }
                        tokio::time::sleep(Duration::from_millis(1600)).await;
                        self.fill_candidate_queue(
                            &mut session,
                            adapter,
                            platform,
                            &mut queue,
                            &session_id,
                        )
                        .await;
                        if queue.remaining() >= REFILL_THRESHOLD {
                            break;
                        }
                    }
                    if queue.remaining() == 0 {
                        empty_fills = empty_fills.saturating_add(1);
                        let url = session.current_url().await;
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "CANDIDATES_EMPTY",
                            format!("fills={} url={}", empty_fills, url),
                        );
                        // 弱通道：只读前台窗口标题，让面板显示「在等浏览器」。
                        if let Some((title, process)) = foreground_title_process() {
                            let mut state = lock_state(&self.state);
                            state.foreground_title = title;
                            state.foreground_process = process;
                            state.waiting_for_browser = true;
                        }
                        if empty_fills >= 3 {
                            self.set_runtime_error(
                                "NO_CANDIDATES",
                                "连续 3 次抓不到候选视频链接（页面结构可能变了），本轮已停止。",
                            );
                            self.finish(&app, StopReason::Crash, false);
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                    empty_fills = 0;
                }
            }

            let Some(target) = queue.next_candidate() else {
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            };
            self.log_event(
                Some(&session_id),
                Some(ChannelType::Cdp),
                "info",
                "NAV_ATTEMPT",
                format!(
                    "url={} id={} queue={}",
                    target.url,
                    target.id,
                    queue.remaining()
                ),
            );
            let mut nav_error = false;
            if session.navigate(&target.url).await.is_err() {
                nav_error = true;
                cdp_failures = cdp_failures.saturating_add(1);
            }
            let ready = if nav_error {
                None
            } else {
                wait_page_ready(&mut session, &target.id).await
            };
            let probe = match ready {
                Some(probe) => probe,
                None => {
                    if nav_error {
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "NAV_FAILED",
                            format!("url={} reason=cdp_navigate_error", target.url),
                        );
                    } else {
                        let href = session.current_url().await;
                        let title = session
                            .evaluate("document.title", EVALUATE_TIMEOUT)
                            .await
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string))
                            .unwrap_or_default();
                        // 视频页被重定向到登录页时不要计成「URL 失败」，先进入等待登录。
                        if href.contains("passport.bilibili.com") || title.contains("登录") {
                            {
                                let mut state = lock_state(&self.state);
                                let mut diagnostics = 0;
                                try_transition(
                                    &mut state.phase,
                                    Phase::AwaitingLogin,
                                    &mut diagnostics,
                                );
                                state.error_code = Some("LOGIN_REQUIRED".to_string());
                                state.error_message =
                                    Some("请在小狗专用窗口登录一次。".to_string());
                            }
                            self.log_event(
                                Some(&session_id),
                                Some(ChannelType::Cdp),
                                "warn",
                                "LOGIN_REQUIRED",
                                format!("url={} action=wait_login", href),
                            );
                            queue.requeue(target.clone());
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            continue;
                        }
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "NAV_TIMEOUT",
                            format!(
                                "url={} expect={} actual={} title={} wait={}s",
                                target.url, target.id, href, title, PAGE_READY_WAIT_SECONDS
                            ),
                        );
                    }
                    self.record_url_failure(
                        &mut queue,
                        &target,
                        &session_id,
                        &mut rounds,
                        &mut failed_urls,
                    );
                    continue;
                }
            };
            cdp_failures = 0;

            // 页面关键信息就绪 → 取事实（标题/时长/作者/互动）。
            // 刚到位时 video 元数据可能还没来（duration=0 会被误判成「短且无作者」），
            // 因此对可重试的伪条目判定最多再试 3 次（约 2 秒）。
            let mut facts: Option<PageFacts> = None;
            for attempt in 0..3u32 {
                match session.evaluate(adapter.extract_script(), EVALUATE_TIMEOUT).await {
                    Ok(value) => match normalize_value(&value, platform, 1.0) {
                        Ok((candidate, _unknown)) => {
                            let retryable = candidate.filtered
                                && matches!(
                                    candidate.filter_reason.as_deref(),
                                    Some("short_without_author") | Some("empty_title")
                                );
                            facts = Some(candidate);
                            if !retryable {
                                break;
                            }
                        }
                        Err(issue) => {
                            self.log_event(
                                Some(&session_id),
                                Some(ChannelType::Cdp),
                                "warn",
                                "EXTRACT_FAILED",
                                format!("url={} issue={} attempt={}", target.url, issue, attempt),
                            );
                        }
                    },
                    Err(_) => {
                        cdp_failures = cdp_failures.saturating_add(1);
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "EXTRACT_FAILED",
                            format!(
                                "url={} issue=cdp_evaluate attempt={}",
                                target.url, attempt
                            ),
                        );
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
            let facts = facts;
            let Some(facts) = facts else {
                self.record_url_failure(
                    &mut queue,
                    &target,
                    &session_id,
                    &mut rounds,
                    &mut failed_urls,
                );
                continue;
            };

            // 页面分类：风控直接停；登录墙进入等待登录；视频页（含平台适配器判成 Feed 的详情页）继续采集。
            match adapter.classify_page(&facts) {
                PageKind::RiskControl => {
                    {
                        let mut state = lock_state(&self.state);
                        state.error_code = Some("RISK_CONTROL".to_string());
                        state.error_message = Some("平台要求验证，小狗已停下来。".to_string());
                    }
                    self.finish(&app, StopReason::RiskControl, false);
                    break;
                }
                PageKind::Login => {
                    {
                        let mut state = lock_state(&self.state);
                        let mut diagnostics = 0;
                        try_transition(&mut state.phase, Phase::AwaitingLogin, &mut diagnostics);
                        state.error_code = Some("LOGIN_REQUIRED".to_string());
                        state.error_message = Some("请在小狗专用窗口登录一次。".to_string());
                    }
                    self.log_event(
                        Some(&session_id),
                        Some(ChannelType::Cdp),
                        "warn",
                        "LOGIN_REQUIRED",
                        format!("url={} action=wait_login", target.url),
                    );
                    queue.requeue(target.clone());
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                PageKind::Feed | PageKind::Other => {
                    // 注意：适配器的 classify 会把「平台域名 + 详情页」也归到 Feed，
                    // 这里必须再用 is_video_page 复核一遍，否则视频页会被当成首页丢掉。
                    let canonical = facts.canonical_url.clone().unwrap_or_default();
                    if !is_video_page(&canonical, platform) {
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "TARGET_HEALTH",
                            format!(
                                "url={} expect={} ok=false action=next_candidate",
                                canonical, target.id
                            ),
                        );
                        self.record_url_failure(
                            &mut queue,
                            &target,
                            &session_id,
                            &mut rounds,
                            &mut failed_urls,
                        );
                        continue;
                    }
                }
            }

            // 采集：合并到条目列表（同 itemKey 只更新，不重复）。
            let mut collect_ok = false;
            {
                let mut state = lock_state(&self.state);
                state.foreground_title = facts.title.clone();
                state.foreground_process.clear();
                state.waiting_for_browser = false;
                if let Some(url) = facts.canonical_url.clone() {
                    state.current_url = url;
                }
                match merge_facts(&mut state.items, &facts, now) {
                    MergeOutcome::Filtered => {
                        state.filtered_count = state.filtered_count.saturating_add(1);
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "info",
                            "ITEM_DISCARDED",
                            format!(
                                "{} | reason={} | url={}",
                                facts.title,
                                facts
                                    .filter_reason
                                    .clone()
                                    .unwrap_or_else(|| "not_video_page".to_string()),
                                facts.canonical_url.clone().unwrap_or_default()
                            ),
                        );
                    }
                    MergeOutcome::New | MergeOutcome::Updated => {
                        collect_ok = true;
                        collected_rounds = collected_rounds.saturating_add(1);
                        state.collected_rounds = collected_rounds;
                        state.collected_ids.insert(target.id.clone());
                        state.steps = state.steps.saturating_add(1);
                        state.last_action_at = Some(now);
                    }
                    MergeOutcome::Ignored => {}
                }
                if state.items.len() > config.max_items as usize {
                    state.items.truncate(config.max_items as usize);
                }
                if state.phase == Phase::AwaitingLogin && collect_ok {
                    let mut diagnostics = 0;
                    try_transition(&mut state.phase, Phase::Collecting, &mut diagnostics);
                    state.error_code = None;
                    state.error_message = None;
                }
            }
            if collect_ok {
                queue.mark_collected(&target.id);
                self.log_event(
                    Some(&session_id),
                    Some(ChannelType::Cdp),
                    "info",
                    "ITEM_COLLECTED",
                    format!(
                        "url={} bvid={} title={}",
                        facts.canonical_url.clone().unwrap_or_else(|| target.url.clone()),
                        target.id,
                        facts.title
                    ),
                );
                if let Ok(mut channel) = self.channel.lock() {
                    channel.record_success(now);
                }
                self.persist_runtime_session();
                last_progress_at = now_seconds();
                stall_logged = false;
            } else {
                // 被过滤成伪条目：不算成功，换下一条。
                self.record_url_failure(
                    &mut queue,
                    &target,
                    &session_id,
                    &mut rounds,
                    &mut failed_urls,
                );
                continue;
            }

            // 停留看视频（同时做 TARGET_HEALTH 自愈检查）。
            let dwell = self
                .dwell_on_video(
                    &mut session,
                    &target.id,
                    &session_id,
                    adapter.extract_script(),
                    platform,
                    &config,
                    run_id,
                )
                .await;
            let final_facts = match dwell {
                DwellOutcome::Aborted => break,
                DwellOutcome::TargetLost => {
                    // 页面回退/跳走：失败计数 +1，下一轮直接用队列里没采过的下一条。
                    self.record_url_failure(
                        &mut queue,
                        &target,
                        &session_id,
                        &mut rounds,
                        &mut failed_urls,
                    );
                    if let Ok(mut channel) = self.channel.lock() {
                        channel.record_failure(FailureReason::LeftRecommendFeed, now_seconds());
                    }
                    continue;
                }
                DwellOutcome::Finished(facts) => facts,
            };

            // 本轮完成：写 ROUND（标题、已采数、剩余队列、失败数）。
            rounds = rounds.saturating_add(1);
            {
                let mut state = lock_state(&self.state);
                state.round_index = rounds;
                state.collected_rounds = collected_rounds;
                state.failed_urls = failed_urls;
            }
            let title = final_facts
                .as_ref()
                .map(|facts| facts.title.clone())
                .unwrap_or_else(|| probe.title.clone());
            let collected_distinct = {
                let state = lock_state(&self.state);
                state.collected_ids.len()
            };
            last_progress_at = now_seconds();
            stall_logged = false;
            self.log_event(
                Some(&session_id),
                Some(ChannelType::Cdp),
                "info",
                "ROUND",
                format!(
                    "n={} url={} title={} items={} queue={} failed={}",
                    rounds,
                    probe.href,
                    title,
                    collected_distinct,
                    queue.remaining(),
                    failed_urls
                ),
            );

            // 评论：异步派发，绝不 await（模型慢/失败都不阻塞刷视频）。
            if let Some(facts) = final_facts {
                let url = facts.canonical_url.clone().unwrap_or_default();
                let is_login_or_risk = facts.hints.login_visible
                    || facts.hints.captcha_visible
                    || facts.hints.risk_banner;
                self.log_event(
                    Some(&session_id),
                    Some(ChannelType::Cdp),
                    "info",
                    "COMMENT_EVAL",
                    format!(
                        "url={} auto={} dry={} watched_ms={} login={} risk={}",
                        url,
                        config.auto_comment,
                        config.comment_dry_run,
                        facts.position_seconds.saturating_mul(1000),
                        facts.hints.login_visible,
                        facts.hints.captcha_visible || facts.hints.risk_banner
                    ),
                );
                if is_login_or_risk {
                    if !login_risk_logged {
                        login_risk_logged = true;
                        self.log_event(
                            Some(&session_id),
                            Some(ChannelType::Cdp),
                            "warn",
                            "COMMENT_SKIPPED",
                            format!("url={} reason=login_or_risk", url),
                        );
                    }
                } else if url.contains("/video/") {
                    let watched_ms = facts.position_seconds.saturating_mul(1000);
                    let allowed = config.auto_comment
                        && comment_count < 10
                        && watched_ms >= 8_000
                        && !commented_urls.contains(&url)
                        && (last_comment_at == 0
                            || now_seconds().saturating_sub(last_comment_at) >= 180);
                    if allowed {
                        commented_urls.insert(url);
                        last_comment_at = now_seconds();
                        comment_count = comment_count.saturating_add(1);
                        self.spawn_auto_comment(
                            app.clone(),
                            facts,
                            run_id,
                            config.comment_dry_run,
                        );
                    } else {
                        let reason = if !config.auto_comment {
                            "disabled"
                        } else if comment_count >= 10 {
                            "session_limit"
                        } else if watched_ms < 8_000 {
                            "not_watched_enough"
                        } else if commented_urls.contains(&url) {
                            "duplicate"
                        } else {
                            "interval"
                        };
                        if last_skip_reason.as_deref() != Some(reason) {
                            last_skip_reason = Some(reason.to_string());
                            self.log_event(
                                Some(&session_id),
                                Some(ChannelType::Cdp),
                                "info",
                                "COMMENT_SKIPPED",
                                format!("url={} reason={}", url, reason),
                            );
                        }
                    }
                }
            }

            if last_emit.elapsed() >= Duration::from_millis(SNAPSHOT_THROTTLE_MS) {
                last_emit = Instant::now();
                let snapshot = self.snapshot();
                let _ = app.emit("video-session-updated", snapshot);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // 兜底收尾：异常 break 时 phase 不能卡在 Collecting。
        let still_collecting = {
            let mut state = lock_state(&self.state);
            matches!(
                state.phase,
                Phase::Collecting | Phase::AwaitingLogin | Phase::UserTakeover
            )
        };
        if still_collecting && !self.stop.load(Ordering::SeqCst) {
            self.finish(&app, StopReason::Crash, true);
        }
    }

    /// 当前视频口味（面板展示 / 聊天技能读取）。
    pub fn taste_profile(&self) -> UserProfile {
        self.store.profile()
    }

    /// 聊天里说一句话 → 解析成口味调整并落库；解析失败返回 TASTE_UNCLEAR（由调用方反问）。
    pub fn apply_taste_text(&self, text: &str) -> VideoResult<super::taste::TasteReport> {
        let Some(intent) = super::taste::parse_taste_intent(text) else {
            return Err(VideoError::new(
                "TASTE_UNCLEAR",
                super::taste::clarify_reply(),
            ));
        };
        let mut profile = self.store.profile();
        let report = super::taste::apply_intent(&mut profile, &intent)
            .map_err(|message| VideoError::new("TASTE_UPDATE_FAILED", message))?;
        self.store.save_profile(&profile);
        self.log_event(
            None,
            None,
            "info",
            "TASTE_UPDATED",
            format!(
                "text={} moves={:?} positive={:?} negative={:?}",
                text.chars().take(60).collect::<String>(),
                report.moves,
                report.positive_tags,
                report.negative_tags
            ),
        );
        Ok(report)
    }

    /// 恢复默认口味（只清画像标签，不动平台/时长/自动评论等设置）。
    pub fn reset_taste(&self) -> UserProfile {
        let mut profile = self.store.profile();
        profile.positive_tags.clear();
        profile.negative_tags.clear();
        profile.sources.clear();
        profile.updated_at = now_seconds();
        self.store.save_profile(&profile);
        self.log_event(None, None, "info", "TASTE_RESET", "taste=default");
        profile
    }

    /// 异步生成「看完感悟」并回写 session.digest；失败降级模板并标 reflection=template。
    fn spawn_reflection(self: &Arc<Self>, app: &AppHandle, session_id: String, items: Vec<ContentItem>) {
        if items.is_empty() {
            return;
        }
        let engine = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let model = {
                let state = lock_state(&engine.state);
                state.comment_model.clone()
            };
            let generated = match model.as_ref() {
                Some(model) => tokio::time::timeout(
                    Duration::from_secs(25),
                    super::reflection::generate_reflection(&app, &items, model),
                )
                .await
                .unwrap_or_else(|_| Err("感悟模型超时".to_string())),
                None => Err("没有传入当前聊天模型配置".to_string()),
            };
            let (text, source) = match generated {
                Ok(text) => (text, "model"),
                Err(error) => {
                    engine.log_event(
                        Some(&session_id),
                        None,
                        "warn",
                        "REFLECTION_FALLBACK",
                        format!("reason={} mood={}", error, super::reflection::mood_key(&items)),
                    );
                    (
                        super::reflection::template_reflection(&items, super::reflection::reflection_timestamp()),
                        "template",
                    )
                }
            };
            let mut session = match engine.store.get_session(&session_id) {
                Some(session) => session,
                None => return,
            };
            let Some(mut digest) = session.digest.take() else {
                return;
            };
            digest.reflection = Some(text.clone());
            digest.reflection_source = Some(source.to_string());
            session.digest = Some(digest);
            engine.store.save_session(&session);
            engine.log_event(
                Some(&session_id),
                None,
                "info",
                "REFLECTION_BUILT",
                format!(
                    "reflection={} chars={} text={}",
                    source,
                    text.chars().count(),
                    text
                ),
            );
            let _ = app.emit("video-session-updated", engine.snapshot());
        });
    }

    fn finish(self: &Arc<Self>, app: &AppHandle, reason: StopReason, produce_digest: bool) {
        let config = self.config();
        let profile = self.store.profile();
        let (mut session, items, platform, ended_at, summary) = {
            let mut state = lock_state(&self.state);
            // 0 条时不要笼统记成「异常崩溃」（QA U5）：按真实原因细分。
            let reason = if produce_digest && state.items.is_empty() {
                match state.error_code.as_deref() {
                    Some("LOGIN_REQUIRED") => StopReason::LoginRequired,
                    Some(_) => reason,
                    None => StopReason::ParseFailed,
                }
            } else {
                reason
            };
            let ended_at = now_seconds();
            state.ended_at = Some(ended_at);
            state.stop_reason = Some(reason);
            state.waiting_for_browser = false;
            let mut diagnostics = 0;
            if produce_digest {
                try_transition(&mut state.phase, Phase::Digesting, &mut diagnostics);
            } else {
                try_transition(&mut state.phase, Phase::Interrupted, &mut diagnostics);
            }
            let summary = format!(
                "collected={} distinct={} failed={} reason={:?}",
                state.collected_rounds,
                state.collected_ids.len(),
                state.failed_urls,
                reason
            );
            let session = VideoSession {
                session_id: state.session_id.clone(),
                platform: state.platform,
                account_id: state.account_id.clone(),
                started_at: state.started_at,
                ended_at: Some(ended_at),
                stop_reason: Some(reason),
                channel_capability: state.channel.capability,
                item_count: state.items.len() as u32,
                strong_count: 0,
                filtered_count: state.filtered_count,
                error_code: state.error_code.clone(),
                schema_version: SCHEMA_VERSION,
                items: state.items.clone(),
                digest: None,
                comments: state.comments.clone(),
            };
            (session, state.items.clone(), state.platform, ended_at, summary)
        };
        self.log_event(Some(&session.session_id), None, "info", "SESSION_SUMMARY", summary);

        if produce_digest {
            let mut scored = items.clone();
            for item in &mut scored {
                let verdict = score(item, &profile, item.source_confidence.max(0.1));
                item.verdict = Some(verdict);
            }
            session.items = scored.clone();
            session.strong_count = scored
                .iter()
                .filter(|item| {
                    item.verdict.as_ref().and_then(|verdict| verdict.level)
                        == Some(InterestLevel::Strong)
                })
                .count() as u32;

            let strong: Vec<ContentItem> = scored
                .iter()
                .filter(|item| {
                    item.verdict.as_ref().and_then(|verdict| verdict.level)
                        == Some(InterestLevel::Strong)
                })
                .cloned()
                .collect();
            let weak: Vec<ContentItem> = scored
                .iter()
                .filter(|item| {
                    item.verdict.as_ref().and_then(|verdict| verdict.level)
                        == Some(InterestLevel::Weak)
                })
                .cloned()
                .collect();

            // N7：需要 strong 才出摘要太苛刻；条目 ≥2 时把条目放宽成 strong 再生成。
            let mut strong_for_digest = strong.clone();
            if strong_for_digest.is_empty() && scored.len() >= 2 {
                let mut relaxed = scored.clone();
                for item in relaxed.iter_mut().take(5) {
                    if item.verdict.is_none() {
                        item.verdict = Some(score(item, &profile, item.source_confidence.max(0.1)));
                    }
                    if let Some(verdict) = item.verdict.as_mut() {
                        verdict.level = Some(InterestLevel::Strong);
                    }
                }
                strong_for_digest = relaxed;
            }
            if let Some(draft) = build_digest(&session.session_id, platform, &strong_for_digest, &weak, 5) {
                self.store.log(DiagnosticEntry {
                    at: ended_at,
                    session_id: Some(session.session_id.clone()),
                    channel: None,
                    level: "info".to_string(),
                    code: "DIGEST_BUILT".to_string(),
                    message: format!("items={} strong={}", draft.items.len(), strong_for_digest.len()),
                });
                let item_keys: Vec<String> =
                    draft.items.iter().map(|item| item.item_key.clone()).collect();
                let cluster_keys: Vec<String> = draft
                    .items
                    .iter()
                    .map(|item| item.cluster_key.clone())
                    .collect();
                let history = self.store.deliveries();
                let decision = can_deliver(
                    &session.session_id,
                    &item_keys,
                    &cluster_keys,
                    &history,
                    config.daily_deliveries,
                    ended_at,
                );
                if decision.allowed {
                    let mut pending = self.store.pending();
                    pending.enqueue(draft.clone(), ended_at);
                    self.store.save_pending(&pending);
                    self.log_event(
                        Some(&session.session_id),
                        None,
                        "info",
                        "DELIVERY_QUEUED",
                        format!("digest_items={} pending={}", draft.items.len(), pending.items.len()),
                    );
                    let _ = app.emit(
                        "video-summary-pending",
                        serde_json::json!({ "sessionId": session.session_id, "digest": draft }),
                    );
                    let _ = app.emit(
                        "video-pending-changed",
                        serde_json::json!({ "count": pending.items.len() }),
                    );
                } else {
                    self.store.log(DiagnosticEntry {
                        at: ended_at,
                        session_id: Some(session.session_id.clone()),
                        channel: None,
                        level: "info".to_string(),
                        code: "DELIVERY_SKIPPED".to_string(),
                        message: decision.reason,
                    });
                }
                session.digest = Some(Digest {
                    session_id: session.session_id.clone(),
                    theme_line: draft.theme_line.clone(),
                    generator: draft.generator,
                    status: DigestStatus::Pending,
                    total_chars: draft.total_chars,
                    created_at: ended_at,
                    items: draft.items.clone(),
                    reflection: None,
                    reflection_source: None,
                });
            }

            let mut quick_skip_authors: Vec<(String, u32)> = Vec::new();
            for item in &scored {
                if item
                    .signals
                    .iter()
                    .any(|signal| signal.kind == SignalKind::QuickSkip)
                {
                    if let Some(author) = item.author.clone() {
                        if let Some(entry) =
                            quick_skip_authors.iter_mut().find(|(name, _)| name == &author)
                        {
                            entry.1 = entry.1.saturating_add(1);
                        } else {
                            quick_skip_authors.push((author, 1));
                        }
                    }
                }
            }
            let strong_tags: Vec<String> = strong
                .iter()
                .flat_map(|item| item.tags.clone())
                .collect::<Vec<_>>();
            let mut profile_update = profile.clone();
            learn_from_session(
                &mut profile_update,
                &session.session_id,
                &strong_tags,
                strong.first().and_then(|item| item.author.as_deref()),
                &quick_skip_authors,
            );
            self.store.save_profile(&profile_update);
        }

        self.store.save_session(&session);
        // 感悟：异步生成并回写 session.digest（不阻塞停止/不放待投递正文）。
        self.spawn_reflection(&app, session.session_id.clone(), session.items.clone());
        {
            let mut state = lock_state(&self.state);
            let mut diagnostics = 0;
            try_transition(&mut state.phase, Phase::Ended, &mut diagnostics);
            state.persist_failed = self.store.persist_failed();
        }
        // U10：一轮结束就关掉专用浏览器，避免残留实例继续占住 profile/端口。
        self.close_browser_instance();
        let snapshot = self.snapshot();
        let _ = app.emit("video-session-updated", snapshot);
    }

    fn comment_run_active(&self, run_id: u64) -> bool {
        if self.stop.load(Ordering::SeqCst) || self.run_id.load(Ordering::SeqCst) != run_id {
            return false;
        }
        let state = lock_state(&self.state);
        matches!(state.phase, Phase::Collecting | Phase::AwaitingLogin | Phase::UserTakeover)
    }

    /// 在独立任务中完成模型生成、预演/发送和回读验证。
    ///
    /// 评论不能占住采集循环：模型服务可能需要几十秒，CDP 发送后还要等待页面
    /// 渲染。这里通过 run_id 复核会话生命周期，停止或切换会话后不会再写页面。
    fn spawn_auto_comment(
        self: &Arc<Self>,
        app: AppHandle,
        facts: PageFacts,
        run_id: u64,
        dry_run: bool,
    ) {
        let engine = self.clone();
        tauri::async_runtime::spawn(async move {
            if !engine.comment_run_active(run_id) {
                return;
            }
            let model = {
                let state = lock_state(&engine.state);
                state.comment_model.clone()
            };
            let generated = match model.as_ref() {
                Some(model) => match tokio::time::timeout(
                    Duration::from_secs(30),
                    generate_content_comment(&app, &facts, model),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err("评论模型响应超时，未发送评论".to_string()),
                },
                None => Err("没有传入当前聊天模型配置，未生成评论".to_string()),
            };
            let comment = match generated.and_then(|raw| sanitize_comment(&raw)) {
                Ok(comment) => comment,
                Err(error) => {
                    let message = format!("{}：{}", facts.title, error);
                    engine.store.log(DiagnosticEntry {
                        at: now_seconds(),
                        session_id: Some(engine.snapshot().session_id.clone()),
                        channel: Some(ChannelType::Cdp),
                        level: "warn".to_string(),
                        code: "COMMENT_MODEL_FAILED".to_string(),
                        message: message.clone(),
                    });
                    let _ = app.emit(
                        "video-auto-comment",
                        serde_json::json!({
                            "ok": false,
                            "message": message,
                        }),
                    );
                    let _ = app.emit(
                        "video-comment-bubble",
                        serde_json::json!({
                            "kind": "failed",
                            "text": "模型没有生成评论，本轮没有发送。",
                        }),
                    );
                    return;
                }
            };
            if !engine.comment_run_active(run_id) {
                return;
            }

            if dry_run {
                engine.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: Some(engine.snapshot().session_id.clone()),
                    channel: Some(ChannelType::Cdp),
                    level: "info".to_string(),
                    code: "COMMENT_DRY_RUN".to_string(),
                    message: format!("url={} text={}", facts.canonical_url.clone().unwrap_or_default(), comment),
                });
                {
                    let mut state = lock_state(&engine.state);
                    state.comment_count = state.comment_count.saturating_add(1);
                    state.comment_dry_run_count = state.comment_dry_run_count.saturating_add(1);
                    state.last_comment_text = comment.clone();
                    state.last_comment_dry_run = true;
                    state.last_comment_verified = false;
                    state.last_comment_at = now_seconds();
                    state.comments.push(SessionComment {
                        text: comment.clone(),
                        url: facts.canonical_url.clone().unwrap_or_default(),
                        title: facts.title.clone(),
                        dry_run: true,
                        verified: false,
                        at: now_seconds(),
                    });
                }
                let _ = app.emit(
                    "video-comment-bubble",
                    serde_json::json!({
                        "kind": "dry-run",
                        "text": comment_bubble(&facts.title, &comment),
                    }),
                );
                let _ = app.emit(
                    "video-auto-comment",
                    serde_json::json!({ "ok": true, "message": "评论预演已生成，未发送" }),
                );
                let _ = app.emit("video-session-updated", engine.snapshot());
                return;
            }

            // 模型生成期间页面可能已经翻页；再次确认当前 target 仍是视频详情页。
            let (port, platform) = {
                let state = lock_state(&engine.state);
                (state.cdp_port, state.platform)
            };
            let page_ready = if port == 0 {
                false
            } else if let Ok(mut cdp) = CdpSession::connect(port, platform).await {
                cdp.current_url().await.contains("/video/")
            } else {
                false
            };
            if !page_ready || !engine.comment_run_active(run_id) {
                let message = "视频页面已变化，未发送评论".to_string();
                engine.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: Some(engine.snapshot().session_id.clone()),
                    channel: Some(ChannelType::Cdp),
                    level: "info".to_string(),
                    code: "COMMENT_SKIPPED".to_string(),
                    message: message.clone(),
                });
                let _ = app.emit("video-auto-comment", serde_json::json!({ "ok": false, "message": message }));
                return;
            }

            let report = match engine.post_comment(&comment).await {
                Ok(report) if report.ok => report,
                Ok(report) => {
                    let message = format!("评论未提交：{}", report.message);
                    engine.store.log(DiagnosticEntry {
                        at: now_seconds(),
                        session_id: Some(engine.snapshot().session_id.clone()),
                        channel: Some(ChannelType::Cdp),
                        level: "warn".to_string(),
                        code: "COMMENT_SKIPPED".to_string(),
                        message: message.clone(),
                    });
                    let _ = app.emit("video-auto-comment", serde_json::json!({ "ok": false, "message": message }));
                    return;
                }
                Err(error) => {
                    let message = error.to_string();
                    engine.store.log(DiagnosticEntry {
                        at: now_seconds(),
                        session_id: Some(engine.snapshot().session_id.clone()),
                        channel: Some(ChannelType::Cdp),
                        level: "warn".to_string(),
                        code: "COMMENT_FAILED".to_string(),
                        message: message.clone(),
                    });
                    let _ = app.emit("video-auto-comment", serde_json::json!({ "ok": false, "message": message }));
                    return;
                }
            };

            let mut verified = false;
            if port != 0 {
                if let Ok(mut cdp) = CdpSession::connect(port, platform).await {
                    for _ in 0..3 {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        if let Ok(text) = cdp.evaluate_text("document.body.innerText").await {
                            if comment_in_text(&text, &comment) {
                                verified = true;
                                break;
                            }
                        }
                    }
                }
            }
            if !verified {
                engine.set_runtime_error("COMMENT_UNVERIFIED", "评论可能没发出去：没在评论区回读到这条内容。");
            }
            let message = if verified { "评论已提交并回读验证" } else { "评论已尝试提交，但回读未验证" };
            engine.store.log(DiagnosticEntry {
                at: now_seconds(),
                session_id: Some(engine.snapshot().session_id.clone()),
                channel: Some(ChannelType::Cdp),
                level: if verified { "info" } else { "warn" }.to_string(),
                code: if verified { "COMMENT_POSTED" } else { "COMMENT_UNVERIFIED" }.to_string(),
                message: format!("url={} verified={} text={}", facts.canonical_url.clone().unwrap_or_default(), verified, comment),
            });
            {
                let mut state = lock_state(&engine.state);
                state.comment_count = state.comment_count.saturating_add(1);
                state.last_comment_text = comment.clone();
                state.last_comment_dry_run = false;
                state.last_comment_verified = verified;
                state.last_comment_at = now_seconds();
                state.comments.push(SessionComment {
                    text: comment.clone(),
                    url: facts.canonical_url.clone().unwrap_or_default(),
                    title: facts.title.clone(),
                    dry_run: false,
                    verified,
                    at: now_seconds(),
                });
            }
            let _ = app.emit(
                "video-comment-bubble",
                serde_json::json!({
                    "kind": if verified { "posted" } else { "unverified" },
                    "text": comment_bubble(&facts.title, &comment),
                }),
            );
            let _ = app.emit(
                "video-auto-comment",
                serde_json::json!({ "ok": verified, "message": message }),
            );
            let _ = app.emit("video-session-updated", engine.snapshot());
            let _ = report;
        });
    }

    /// 在当前视频页面里发一条评论（只有用户点发送时才会调用）。
    pub async fn post_comment(&self, text: &str) -> VideoResult<CommentReport> {
        let (port, platform, phase) = {
            let state = self.state.lock().expect("video state lock");
            (state.cdp_port, state.platform, state.phase)
        };
        if port == 0 || phase == Phase::Idle {
            return Err(VideoError::new(
                "comment-not-ready",
                "还没有在刷视频：先点「开始」，让小狗打开专用浏览器再评论",
            ));
        }
        let script = crate::video::comment::build_comment_script(text)
            .map_err(|message| VideoError::new("comment-invalid", message))?;

        let mut session = crate::video::cdp::CdpSession::connect(port, platform)
            .await
            .map_err(|failure| {
                VideoError::with_detail(
                    "comment-cdp",
                    "连不上专用浏览器，评论没有发出去",
                    format!("{failure:?}"),
                )
            })?;
        let value = session
            .evaluate(&script, std::time::Duration::from_secs(8))
            .await
            .map_err(|failure| {
                VideoError::with_detail(
                    "comment-eval",
                    "执行评论脚本失败",
                    format!("{failure:?}"),
                )
            })?;

        // evaluate 返回的是 JSON 字符串（脚本里自己 stringify），这里解出结果。
        let raw = value
            .as_str()
            .map(|text| text.to_string())
            .unwrap_or_else(|| value.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|error| VideoError::with_detail("comment-parse", "评论结果解析失败", error.to_string()))?;
        let ok = parsed.get("ok").and_then(|item| item.as_bool()).unwrap_or(false);
        let reason = parsed
            .get("reason")
            .and_then(|item| item.as_str())
            .unwrap_or("unknown")
            .to_string();
        let message = parsed
            .get("message")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string();
        Ok(CommentReport {
            ok,
            reason,
            message,
            platform: platform.as_str().to_string(),
        })
    }
    pub fn list_sessions(&self, limit: u32) -> Vec<SessionSummary> {
        let pending_ids: std::collections::HashSet<String> = self
            .store
            .pending()
            .items
            .iter()
            .map(|entry| entry.digest.session_id.clone())
            .collect();
        let mut sessions = self.store.list_sessions(limit);
        for session in &mut sessions {
            session.has_pending = pending_ids.contains(&session.session_id);
        }
        sessions
    }

    pub fn get_session(&self, session_id: &str) -> VideoResult<VideoSession> {
        self.store
            .get_session(session_id)
            .ok_or_else(|| VideoError::new("NOT_FOUND", "找不到这个观看会话。"))
    }

    pub fn profile(&self) -> UserProfile {
        self.store.profile()
    }

    pub fn save_profile(&self, profile: &UserProfile) {
        self.store.save_profile(profile);
    }

    pub fn take_pending_digest(&self, app: &AppHandle) -> Option<DigestDraft> {
        let mut pending = self.store.pending();
        let entry = pending.take_first()?;
        self.store.save_pending(&pending);
        let _ = app.emit(
            "video-pending-changed",
            serde_json::json!({ "count": pending.items.len() }),
        );
        Some(entry.digest)
    }

    pub fn mark_delivery(
        &self,
        app: &AppHandle,
        session_id: &str,
        outcome: DeliveryOutcome,
    ) -> VideoResult<DeliveryRecord> {
        let draft = {
            let pending = self.store.pending();
            pending
                .items
                .iter()
                .find(|entry| entry.digest.session_id == session_id)
                .map(|entry| entry.digest.clone())
        };
        let (item_keys, cluster_keys) = draft
            .map(|draft| {
                (
                    draft.items.iter().map(|item| item.item_key.clone()).collect::<Vec<_>>(),
                    draft.items.iter().map(|item| item.cluster_key.clone()).collect::<Vec<_>>(),
                )
            })
            .unwrap_or_default();
        let existing = self.store.deliveries();
        let record = super::delivery::record_outcome(
            session_id,
            item_keys,
            cluster_keys,
            outcome,
            &existing,
        );
        self.store.append_delivery(&record);
        let mut pending = self.store.pending();
        pending.remove_session(session_id);
        self.store.save_pending(&pending);
        let _ = app.emit(
            "video-pending-changed",
            serde_json::json!({ "count": pending.items.len() }),
        );
        Ok(record)
    }

    pub fn diagnostics(&self, limit: u32) -> Vec<DiagnosticEntry> {
        self.store.diagnostics(limit)
    }

    pub fn clear_data(&self, scope: ClearScope, include_browser_profile: bool) -> VideoResult<ClearReport> {
        {
            let state = lock_state(&self.state);
            if matches!(
                state.phase,
                Phase::Preparing | Phase::AwaitingLogin | Phase::Collecting | Phase::UserTakeover | Phase::Digesting
            ) {
                return Err(VideoError::new("SESSION_RUNNING", "请先停止当前观看会话。"));
            }
        }
        let report = self.store.clear(scope, include_browser_profile);
        if include_browser_profile {
            let profile = browser::profile_dir();
            let _ = std::fs::remove_dir_all(profile);
            let accounts = browser::account_profile_dir("..");
            if let Some(root) = accounts.parent() {
                let _ = std::fs::remove_dir_all(root);
            }
        }
        Ok(report)
    }

    pub fn probe_channels(&self) -> Vec<ChannelState> {
        ChannelManager::default_health()
    }

    pub fn close_browser(&self) -> VideoResult<()> {
        self.close_browser_instance();
        Ok(())
    }

    /// 当前专用浏览器实例现状：面板高级设置里展示「会复用上次实例 / 会先清理残留再启动」。
    pub fn browser_status(&self) -> BrowserStatus {
        let profile = browser::profile_dir();
        let marker = browser::read_marker();
        let (marker_present, marker_matches, marker_pid_alive, marker_cdp_ready, marker_port) =
            match marker.as_ref() {
                Some(marker) => (
                    true,
                    browser::same_profile(&marker.profile_dir, &profile),
                    browser::pid_alive_browser(marker.pid),
                    browser::cdp_ready(marker.port),
                    Some(marker.port),
                ),
                None => (false, false, false, false, None),
            };
        let owned_alive = self.owned_reusable(&profile);
        let owned = match self.browser.lock() {
            Ok(browser) => browser
                .as_ref()
                .map(|instance| (instance.handle().pid, instance.handle().port)),
            Err(poisoned) => poisoned
                .into_inner()
                .as_ref()
                .map(|instance| (instance.handle().pid, instance.handle().port)),
        };
        let decision = browser::reuse_decision(
            owned_alive,
            marker_matches,
            marker_pid_alive,
            marker_cdp_ready,
        );
        let reuse = match decision {
            browser::BrowserReuse::Owned => "owned",
            browser::BrowserReuse::External => "external",
            browser::BrowserReuse::Fresh => "fresh",
        };
        BrowserStatus {
            pid: owned.map(|(pid, _)| pid).or(if marker_pid_alive {
                marker.as_ref().map(|marker| marker.pid)
            } else {
                None
            }),
            port: owned.map(|(_, port)| port).or(marker_port),
            profile_dir: profile.to_string_lossy().into_owned(),
            marker_present,
            marker_pid_alive,
            cdp_ready: owned_alive || marker_cdp_ready,
            reuse: reuse.to_string(),
        }
    }

    /// 首次登录：这是唯一允许把窗口提到前台的路径。
    ///
    /// 成功判据（QA U2）：真的出现一个可见的浏览器窗口且 CDP 可用；否则报中文错误、
    /// 关掉本次启动的进程并写诊断日志，绝不「提示成功但没窗口」。
    pub async fn open_login_window(&self, platform: Platform, account_id: Option<&str>) -> VideoResult<()> {
        let profile = if let Some(account_id) = account_id {
            let mut accounts = self.accounts.lock().map_err(|_| VideoError::new("ACCOUNT_ERROR", "小狗账号状态不可用。"))?;
            let account = accounts
                .list()
                .into_iter()
                .find(|item| item.id == account_id)
                .ok_or_else(|| VideoError::new("ACCOUNT_NOT_FOUND", "找不到这个小狗账号。"))?;
            if account.platform != platform {
                return Err(VideoError::new("ACCOUNT_PLATFORM_MISMATCH", "小狗账号的平台和登录窗口不一致。"));
            }
            let profile = std::path::PathBuf::from(account.profile_dir);
            let _ = accounts.mark_login_started(account_id);
            profile
        } else {
            browser::profile_dir()
        };

        let not_visible = || {
            VideoError::new(
                "LOGIN_WINDOW_NOT_VISIBLE",
                "小狗专用浏览器已在运行，但没能把登录窗显示出来。请在任务栏找到它手动打开，或在高级设置里点「关闭专用浏览器」后重试。",
            )
        };

        // 1) 已有同 profile 实例（内存里或上次留下的）：接管它，把登录页开成新标签并前置。
        if self.owned_reusable(&profile) {
            let port = match self.browser.lock() {
                Ok(browser) => browser.as_ref().map(|item| item.handle().port).unwrap_or(0),
                Err(poisoned) => poisoned.into_inner().as_ref().map(|item| item.handle().port).unwrap_or(0),
            };
            if browser::focus_browser_window(platform) {
                return Ok(());
            }
            let _ = browser::open_target(port, platform.feed_url());
            tokio::time::sleep(Duration::from_millis(600)).await;
            if browser::focus_browser_window(platform) {
                return Ok(());
            }
            return Err(not_visible());
        }
        if let Some(handle) = browser::find_reusable(&profile) {
            let port = handle.port;
            self.install_browser(BrowserInstance::External(handle));
            let _ = browser::open_target(port, platform.feed_url());
            tokio::time::sleep(Duration::from_millis(600)).await;
            if browser::focus_browser_window(platform) {
                return Ok(());
            }
            return Err(not_visible());
        }

        // 2) 没有可复用实例：先清掉残留（占着 profile 的旧实例会让新进程静默转交），再启动。
        browser::close_profile_instance(&profile);
        self.close_browser_instance();
        let port = browser::pick_port(browser::DEFAULT_PORT)?;
        let mut process = browser::launch(platform, port, &profile, true)?;
        let pid = process.handle.pid;
        if !browser::wait_for_cdp_async(port, browser::CDP_READY_TIMEOUT).await {
            process.close();
            browser::clear_marker();
            self.abort_start(
                Phase::Stopped,
                "CDP_UNAVAILABLE",
                "小狗专用浏览器启动后没有打开调试接口，登录窗没有打开。",
            );
            return Err(VideoError::with_detail(
                "CDP_UNAVAILABLE",
                "小狗专用浏览器启动后没有打开调试接口，登录窗没有打开。请确认电脑上 Chrome/Edge 能正常启动后重试。",
                format!("port={port} profile={}", profile.display()),
            ));
        }
        if !browser::wait_for_visible_window_async(pid, browser::LOGIN_WINDOW_TIMEOUT).await {
            // CDP 起来了但没有可见窗口：多半被旧实例转交/最小化了，关掉并报错。
            process.close();
            browser::clear_marker();
            self.abort_start(
                Phase::Stopped,
                "LOGIN_WINDOW_NOT_VISIBLE",
                "小狗专用浏览器已经启动，但没有出现可见的登录窗口。",
            );
            return Err(VideoError::with_detail(
                "LOGIN_WINDOW_NOT_VISIBLE",
                "小狗专用浏览器已经启动，但没有出现可见的登录窗口。请先点「关闭专用浏览器」再重试。",
                format!("pid={pid} port={port}"),
            ));
        }
        let handle = process.handle.clone();
        browser::write_marker(&handle);
        self.install_browser(BrowserInstance::Owned(process));
        let _ = browser::focus_browser_window(platform);
        Ok(())
    }

    pub fn pending(&self) -> Option<DigestDraft> {
        self.store
            .pending()
            .items
            .first()
            .map(|entry| entry.digest.clone())
    }

    /// 扩展/UIA 通道上报：只接受已归一化的页面事实，可信度由调用方按通道赋值。
    pub fn ingest_facts(&self, facts: &PageFacts) -> bool {
        let mut state = lock_state(&self.state);
        if !matches!(state.phase, Phase::Collecting | Phase::UserTakeover) {
            return false;
        }
        let now = now_seconds();
        if let Some(url) = facts.canonical_url.clone() {
            state.current_url = url;
        }
        match merge_facts(&mut state.items, facts, now) {
            MergeOutcome::Filtered => {
                state.filtered_count = state.filtered_count.saturating_add(1);
                false
            }
            MergeOutcome::Ignored => false,
            _ => true,
        }
    }
}

#[cfg(windows)]
fn foreground_title_process() -> Option<(String, String)> {
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HWND},
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW},
        },
        core::PWSTR,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut title = [0u16; 512];
        let length = GetWindowTextW(hwnd, &mut title) as usize;
        let title = String::from_utf16_lossy(&title[..length.min(title.len())]);

        let mut process_id = 0u32;
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
            hwnd,
            Some(&mut process_id),
        );
        if process_id == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut path = [0u16; 32768];
        let mut path_length = path.len() as u32;
        let readable = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !readable {
            return None;
        }
        let executable = std::path::Path::new(&String::from_utf16_lossy(
            &path[..path_length as usize],
        ))
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())?;
        Some((title, executable))
    }
}

#[cfg(not(windows))]
fn foreground_title_process() -> Option<(String, String)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::extract::normalize_facts;
    use crate::video::extract::RawFacts;
    use crate::video::model::Platform;

    #[test]
    fn transition_matrix_covers_all_pairs() {
        let phases = [
            Phase::Idle,
            Phase::Preparing,
            Phase::AwaitingLogin,
            Phase::Collecting,
            Phase::UserTakeover,
            Phase::Digesting,
            Phase::Ended,
            Phase::Interrupted,
            Phase::Blocked,
            Phase::Stopped,
        ];
        let mut valid = 0;
        let mut invalid = 0;
        for current in phases {
            for next in phases {
                let mut state = current;
                let mut diagnostics = 0;
                if try_transition(&mut state, next, &mut diagnostics) {
                    valid += 1;
                    assert_eq!(state, next);
                } else {
                    invalid += 1;
                    assert_eq!(state, current);
                    assert_eq!(diagnostics, 1);
                }
            }
        }
        assert_eq!(valid + invalid, 100);
        assert!(valid >= 15);
    }

    #[test]
    fn illegal_transition_is_ignored() {
        let mut phase = Phase::Idle;
        let mut diagnostics = 0;
        assert!(!try_transition(&mut phase, Phase::Collecting, &mut diagnostics));
        assert_eq!(phase, Phase::Idle);
        assert_eq!(diagnostics, 1);
    }

    fn facts(position: u64, liked: bool) -> PageFacts {
        let raw = RawFacts {
            item_id: "BV1".to_string(),
            title: "标题".to_string(),
            author: "作者".to_string(),
            duration_seconds: 120,
            position_seconds: position,
            playing: true,
            visible: true,
            liked,
            on_feed: true,
            url: "https://www.bilibili.com/video/BV1".to_string(),
            ..RawFacts::default()
        };
        normalize_facts(raw, Platform::Bilibili, 1.0).expect("facts")
    }

    #[test]
    fn same_item_is_merged_not_duplicated() {
        let mut items = Vec::new();
        assert_eq!(merge_facts(&mut items, &facts(10, false), 10), MergeOutcome::New);
        assert_eq!(merge_facts(&mut items, &facts(20, false), 20), MergeOutcome::Updated);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].watched_seconds, 10);
        assert_eq!(items[0].visits, 2);
    }

    #[test]
    fn seek_jump_records_signal_without_watch_time() {
        let mut items = Vec::new();
        merge_facts(&mut items, &facts(10, false), 10);
        merge_facts(&mut items, &facts(200, false), 20);
        assert_eq!(items[0].watched_seconds, 10);
        assert!(items[0]
            .signals
            .iter()
            .any(|signal| signal.kind == SignalKind::SeekBack));
    }

    #[test]
    fn like_signal_is_monotonic() {
        let mut items = Vec::new();
        merge_facts(&mut items, &facts(10, false), 10);
        merge_facts(&mut items, &facts(10, true), 11);
        merge_facts(&mut items, &facts(10, true), 12);
        let likes = items[0]
            .signals
            .iter()
            .filter(|signal| signal.kind == SignalKind::Like)
            .count();
        assert_eq!(likes, 1);
    }

    #[test]
    fn filtered_item_is_counted_not_stored() {
        let raw = RawFacts {
            title: "正在直播".to_string(),
            duration_seconds: 0,
            url: "https://www.bilibili.com/video/BV1".to_string(),
            ..RawFacts::default()
        };
        let facts = normalize_facts(raw, Platform::Bilibili, 1.0).expect("facts");
        let mut items = Vec::new();
        assert_eq!(merge_facts(&mut items, &facts, 10), MergeOutcome::Filtered);
        assert!(items.is_empty());
    }

    #[test]
    fn session_id_has_platform_and_date() {
        let id = new_session_id(Platform::Bilibili);
        assert!(id.starts_with("bili-"));
        assert!(id.rsplit('-').next().unwrap_or("").len() == 6);
    }
}

#[cfg(test)]
mod comment_match_tests {
    use super::{comment_in_text, sanitize_comment};

    #[test]
    fn empty_model_output_is_rejected_without_template() {
        assert!(sanitize_comment("   ").is_err());
        assert!(sanitize_comment("求关注 https://example.com").is_err());
    }

    #[test]
    fn model_comment_is_cleaned_before_send() {
        let cleaned = sanitize_comment("看完了 求关注 @某人 https://example.com").unwrap();
        assert_eq!(cleaned, "看完了");
    }

    #[test]
    fn comment_in_text_matches() {
        assert!(comment_in_text("\u{6211}\u{53d1}\u{4e86}\u{ff1a}\u{8fd9}\u{4e2a}\u{8bb2}\u{5f97}\u{633a}\u{7ec6}\u{7684}\u{ff0c}\u{5148}\u{7801}\u{4f4f}\u{3002}", "\u{8fd9}\u{4e2a}\u{8bb2}\u{5f97}\u{633a}\u{7ec6}\u{7684}\u{ff0c}\u{5148}\u{7801}\u{4f4f}\u{3002}"));
        assert!(comment_in_text("\u{8fd9}\u{4e2a}\u{8bb2}\u{5f97}\u{633a}\u{7ec6}\u{7684}\u{5148}\u{7801}\u{4f4f}", "\u{8fd9}\u{4e2a}\u{8bb2}\u{5f97}\u{633a}\u{7ec6}\u{7684}\u{ff0c}\u{5148}\u{7801}\u{4f4f}\u{3002}"));
        assert!(!comment_in_text("\u{5b8c}\u{5168}\u{4e0d}\u{540c}\u{7684}\u{8bc4}\u{8bba}", "\u{8fd9}\u{4e2a}\u{8bb2}\u{5f97}\u{633a}\u{7ec6}\u{7684}\u{ff0c}\u{5148}\u{7801}\u{4f4f}\u{3002}"));
        assert!(!comment_in_text("", "x"));
    }
}
