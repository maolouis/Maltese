//! 会话编排：状态机、采集 tick、翻页调度、整理与投递入队。
//!
//! 纯逻辑部分（状态迁移、条目合并）可单测；运行部分通过 CDP 驱动专用浏览器，
//! CDP 不可用时降级到前台窗口标题（弱通道，只作主题线索）。

use super::adapter::adapter_for;
use super::accounts::{AccountStore, AccountStatus, AgentAccount};
use super::browser::{self, BrowserInstance};
use super::cdp::{port_alive, shutdown_browser, CdpSession, EVALUATE_TIMEOUT};
use super::channel::ChannelManager;
use super::comment::generate_content_comment;
use super::CommentReport;
use super::config::{apply_patch, validate_config, VideoCommentModelConfig, VideoConfig, VideoConfigPatch};
use super::delivery::can_deliver;
use super::digest::build_digest;
use super::extract::{is_video_page, normalize_value, ExtractIssue, PageFacts, PageKind, RawFacts};
use super::guard::Guard;
use super::interest::score;
use super::model::*;
use super::profile::learn_from_session;
use super::store::StoreHandle;
use super::{VideoError, VideoResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
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
#[derive(Clone, Debug, Serialize)]
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
    /// 本轮已产生的评论数（含预演）。
    pub comment_count: u32,
    /// 其中仅预演的条数。
    pub comment_dry_run_count: u32,
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
            comment_count: 0,
            comment_dry_run_count: 0,
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
    auto_comment_attempted: HashSet<String>,
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
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            phase: Phase::Idle,
            platform: Platform::Bilibili,
            provider: "bilibili".to_string(),
            account_id: None,
            auto_comment_attempted: HashSet::new(),
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

fn data_root(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("maltese-assistant"))
        .join("video")
}

pub fn engine(app: &AppHandle) -> Arc<SessionEngine> {
    ENGINE
        .get_or_init(|| {
            Arc::new(SessionEngine {
                store: StoreHandle::new(data_root(app)),
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



/// N6：从当前视频页的推荐列表取**下一个** /video/BV 链接并导航过去。
pub async fn advance_to_next_video(cdp: &mut CdpSession, current_url: &str) -> NavOutcome {
    const NEXT_JS: &str = r#"(function(){
      try{
        var cur=location.href;
        var curBv=(cur.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/)||[])[1]||'';
        var s=window.__INITIAL_STATE__;
        if(s){
          var lists=[s.related,s.recommendList,s.relatedList];
          for(var i=0;i<lists.length;i++){
            var list=lists[i]||[];
            for(var j=0;j<list.length;j++){
              var bv=(list[j]&&(list[j].bvid||list[j].bvid_str))||'';
              if(bv && bv!==curBv) return 'https://www.bilibili.com/video/'+bv;
            }
          }
        }
        var as=document.querySelectorAll('a[href*="/video/BV"]');
        for(var k=0;k<as.length;k++){
          var m=(as[k].href||'').match(/\/video\/(BV[0-9A-Za-z]+)/);
          if(m && m[1]!==curBv) return 'https://www.bilibili.com/video/'+m[1];
        }
        return '';
      }catch(e){return ''}})()"#;
    let mut attempts: Vec<String> = Vec::new();
    if let Ok(value) = cdp.evaluate(NEXT_JS, EVALUATE_TIMEOUT).await {
        if let Some(url) = value.as_str().map(str::to_string).filter(|url| url.contains("/video/")) {
            if url != current_url {
                attempts.push(format!("next:{url}"));
                if cdp.navigate(&url).await.is_ok() {
                    let (final_url, title) = wait_for_video_url(cdp).await;
                    if final_url.contains("/video/") && final_url != current_url {
                        return NavOutcome { ok: true, attempts, final_url, title };
                    }
                }
            } else {
                attempts.push("next:same_url".to_string());
            }
        } else {
            attempts.push("next:empty".to_string());
        }
    }
    // 兜底：回排行榜再走 N5 的三段降级
    attempts.push("fallback:force_enter_video_page".to_string());
    let outcome = force_enter_video_page(cdp).await;
    attempts.extend(outcome.attempts.clone());
    NavOutcome {
        ok: outcome.ok && outcome.final_url != current_url,
        attempts,
        final_url: outcome.final_url,
        title: outcome.title,
    }
}


/// N11：评论清洗（≤40 字、去 @/链接/禁词、空则模板兜底）。
fn sanitize_comment(raw: &str) -> String {
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
        "这个讲得挺细的，先码住。".to_string()
    } else {
        text.trim().to_string()
    }
}

fn comment_bubble(title: &str, comment: &str) -> String {
    let short: String = title.trim().chars().take(12).collect();
    format!("刚给《{short}》评论了一句：{comment}")
}

/// N5：把页面强制带进视频详情页（三段降级）。
pub struct NavOutcome {
    pub ok: bool,
    pub attempts: Vec<String>,
    pub final_url: String,
    pub title: String,
}

async fn wait_for_video_url(cdp: &mut CdpSession) -> (String, String) {
    for _ in 0..27 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let url = cdp
            .evaluate("location.href", EVALUATE_TIMEOUT)
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        if url.contains("/video/") {
            let title = cdp
                .evaluate("document.title", EVALUATE_TIMEOUT)
                .await
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            return (url, title);
        }
    }
    let url = cdp
        .evaluate("location.href", EVALUATE_TIMEOUT)
        .await
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let title = cdp
        .evaluate("document.title", EVALUATE_TIMEOUT)
        .await
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    (url, title)
}

const NAV_FIND_LINK_JS: &str = r#"(function(){try{
  var a=document.querySelector('a[href*="/video/BV"],a[href*="/video/av"]');
  if(a&&a.href)return a.href;
  var s=window.__INITIAL_STATE__;
  if(s){
    var bvid=(s.videoData&&s.videoData.bvid)||(s.bvid)||'';
    if(bvid)return 'https://www.bilibili.com/video/'+bvid;
    var list=s.recommendList||s.relatedList||[];
    for(var i=0;i<list.length;i++){ if(list[i]&&list[i].bvid) return 'https://www.bilibili.com/video/'+list[i].bvid; }
  }
  return '';
}catch(e){return ''}})()"#;

const NAV_CLICK_CARD_JS: &str = r#"(function(){try{
  var sels=['.bili-video-card a','.bili-video-card','[data-video-id] a','[data-video-id]','.feed-card a','.feed-card','.bili-video-card__info--tit a'];
  for(var i=0;i<sels.length;i++){ var el=document.querySelector(sels[i]); if(el){ el.click(); return sels[i]; } }
  return '';
}catch(e){return ''}})()"#;

/// 三段降级：① 找 /video 链接直接导航 → ② 点第一个视频卡片 → ③ 先进排行榜再走 ①②。
pub async fn force_enter_video_page(cdp: &mut CdpSession) -> NavOutcome {
    let mut attempts: Vec<String> = Vec::new();

    // ① 直接导航
    if let Ok(value) = cdp.evaluate(NAV_FIND_LINK_JS, EVALUATE_TIMEOUT).await {
        if let Some(url) = value.as_str().map(str::to_string).filter(|url| url.contains("/video/")) {
            attempts.push(format!("navigate:{url}"));
            if cdp.navigate(&url).await.is_ok() {
                let (final_url, title) = wait_for_video_url(cdp).await;
                if final_url.contains("/video/") {
                    return NavOutcome { ok: true, attempts, final_url, title };
                }
            }
        } else {
            attempts.push("find_link:empty".to_string());
        }
    }

    // ② 点卡片
    if let Ok(value) = cdp.evaluate(NAV_CLICK_CARD_JS, EVALUATE_TIMEOUT).await {
        let selector = value.as_str().unwrap_or("").to_string();
        attempts.push(format!("click:{selector}"));
        if !selector.is_empty() {
            let (final_url, title) = wait_for_video_url(cdp).await;
            if final_url.contains("/video/") {
                return NavOutcome { ok: true, attempts, final_url, title };
            }
        }
    }

    // ③ 搜索/排行榜兜底后重新找链接
    for target in [
        "https://www.bilibili.com/v/popular/all",
        "https://www.bilibili.com/v/popular/rank/all",
    ] {
        attempts.push(format!("fallback:{target}"));
        if cdp.navigate(target).await.is_err() {
            continue;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if let Ok(value) = cdp.evaluate(NAV_FIND_LINK_JS, EVALUATE_TIMEOUT).await {
            if let Some(url) = value.as_str().map(str::to_string).filter(|url| url.contains("/video/")) {
                attempts.push(format!("navigate:{url}"));
                if cdp.navigate(&url).await.is_ok() {
                    let (final_url, title) = wait_for_video_url(cdp).await;
                    if final_url.contains("/video/") {
                        return NavOutcome { ok: true, attempts, final_url, title };
                    }
                }
            }
        }
    }

    let (final_url, title) = wait_for_video_url(cdp).await;
    NavOutcome { ok: false, attempts, final_url, title }
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
        };
        drop(state);
        self.store.save_session(&session);
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
            comment_count: state.comment_count,
            comment_dry_run_count: state.comment_dry_run_count,
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
    fn fail_start(&self, app: &AppHandle, code: &str, message: &str, detail: &str) -> VideoError {
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
            if !browser::wait_for_cdp(port, browser::CDP_READY_TIMEOUT) {
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

    pub fn stop(&self, app: &AppHandle, reason: Option<StopReason>) -> VideoSnapshot {
        self.stop.store(true, Ordering::SeqCst);
        self.run_id.fetch_add(1, Ordering::SeqCst);
        let stop_reason = reason.unwrap_or(StopReason::UserStop);
        // 正在跑就按「结束」保存会话（保留已采集条目、不生成小结），
        // 这样历史里能看到真实的条目数/停止原因，而不是一条 0 条的空会话（QA U5）。
        let running = {
            let state = lock_state(&self.state);
            matches!(
                state.phase,
                Phase::Preparing | Phase::AwaitingLogin | Phase::Collecting | Phase::UserTakeover
            )
        };
        if running {
            // N3：每次运行结束必须落日志（停止事件 + 原因）。
            {
                let state = lock_state(&self.state);
                self.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: Some(state.session_id.clone()),
                    channel: None,
                    level: "info".to_string(),
                    code: "SESSION_STOPPED".to_string(),
                    message: format!("reason={:?} items={} filtered={}", stop_reason, state.items.len(), state.filtered_count),
                });
            }
            // N10：用户停止也要产出小结（digest/pending），否则历史里永远没有成果。
            self.finish(app, stop_reason, true);
            {
                let mut state = lock_state(&self.state);
                state.phase = Phase::Stopped;
                state.stop_reason = Some(stop_reason);
            }
            let snapshot = self.snapshot();
            // N4：面板收起后仍能看到采集状态（托盘提示）。
            if snapshot.running {
                crate::set_tray_status(
                    app,
                    &format!("正在刷视频 {} 条（已丢弃 {} 条伪条目）", snapshot.item_count, snapshot.filtered_count),
                );
            } else {
                crate::reset_tray_status(app);
            }
            // N4：面板收起后仍能看到采集状态（托盘提示）。
        if snapshot.running {
            crate::set_tray_status(
                app,
                &format!("正在刷视频 {} 条（已丢弃 {} 条伪条目）", snapshot.item_count, snapshot.filtered_count),
            );
        }
        // N4：面板收起后仍能看到采集状态（托盘提示）。
        if snapshot.running {
            crate::set_tray_status(
                app,
                &format!("正在刷视频 {} 条（已丢弃 {} 条伪条目）", snapshot.item_count, snapshot.filtered_count),
            );
        }
        let _ = app.emit("video-session-updated", snapshot);
        } else {
            {
                let mut state = lock_state(&self.state);
                let mut diagnostics = 0;
                if try_transition(&mut state.phase, Phase::Stopped, &mut diagnostics) {
                    state.stop_reason = Some(stop_reason);
                    state.ended_at = Some(now_seconds());
                }
            }
            self.close_browser_instance();
        }
        self.snapshot()
    }

    async fn run(self: Arc<Self>, app: AppHandle, port: u16, run_id: u64) {
        let platform = self.snapshot().provider;
        let platform = Platform::parse(&platform).unwrap_or(Platform::Bilibili);
        let adapter = adapter_for(platform);

        let mut last_emit = Instant::now() - Duration::from_millis(SNAPSHOT_THROTTLE_MS);
        let mut session: Option<CdpSession> = None;
        let mut last_turn = Instant::now();
        let mut first_turn = true;

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
                self.store.log(DiagnosticEntry {
                    at: now_seconds(),
                    session_id: Some(self.snapshot().session_id),
                    channel: None,
                    level: "warn".to_string(),
                    code: "BROWSER_ENFORCED_SINGLE".to_string(),
                    message: format!("closed={} kept_port={} alive={:?}", closed, port, alive),
                });
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }
        let mut last_progress_at = now_seconds();
        let mut stall_logged = false;
        let connect_deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match CdpSession::connect(port, platform).await {
                Ok(mut cdp) => {
                    if cdp.navigate(adapter.feed_url()).await.is_ok() {
                        session = Some(cdp);
                        break;
                    }
                }
                Err(_) => {
                    if Instant::now() >= connect_deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }

        if session.is_some() {
            if let Ok(mut channel) = self.channel.lock() {
                channel.record_success(now_seconds());
                let state = channel.active();
                drop(channel);
                if let Ok(mut runtime) = self.state.lock() {
                    runtime.channel = state;
                }
            }
        } else {
            if let Ok(mut channel) = self.channel.lock() {
                channel.record_failure(FailureReason::NoResponse, now_seconds());
                let state = channel.active();
                drop(channel);
                if let Ok(mut runtime) = self.state.lock() {
                    runtime.channel = state;
                    runtime.degraded = true;
                }
            }
            self.set_runtime_error(
                "CDP_UNAVAILABLE",
                "小狗专用浏览器没有在 15 秒内打开调试接口，本轮已停止。请点「打开登录窗」确认浏览器能正常启动，或在高级设置里先「关闭专用浏览器」再重试。",
            );
            self.close_browser_instance();
            self.finish(&app, StopReason::BrowserUnavailable, false);
            return;
        }

        let mut cdp_failures = 0u32;
        let mut reconnect_failures = 0u32;
        let mut nav_failures = 0u32;
        let mut last_nav_at = 0u64;
        let mut advance_failures = 0u32;
        let mut commented_urls: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut last_comment_at = 0u64;
        let mut comment_count = 0u32;
        let mut last_skip_reason: Option<String> = None;
        let mut login_risk_logged = false;
        let mut last_advance_at = 0u64;
        let mut current_video_url = String::new();
        let mut last_collect_key = String::new();

        loop {
            if self.stop.load(Ordering::SeqCst) || self.run_id.load(Ordering::SeqCst) != run_id {
                break;
            }

            let config = self.config();
            let (phase, started_at, item_count) = {
                let state = lock_state(&self.state);
                (state.phase, state.started_at, state.items.len())
            };
            if !matches!(phase, Phase::Collecting | Phase::AwaitingLogin | Phase::UserTakeover) {
                break;
            }

            if !self.browser_alive() {
                self.set_runtime_error("BROWSER_CLOSED", "小狗浏览器已关闭，已停止本轮并保留已采集内容。");
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
            if now.saturating_sub(last_progress_at) >= 30 && !stall_logged {
                stall_logged = true;
                self.store.log(DiagnosticEntry {
                    at: now,
                    session_id: Some(self.snapshot().session_id),
                    channel: None,
                    level: "error".to_string(),
                    code: "SESSION_STALLED".to_string(),
                    message: format!(
                        "no_progress_for={}s url={} waiting_for_browser={}",
                        now.saturating_sub(last_progress_at),
                        self.snapshot().current_url,
                        self.snapshot().waiting_for_browser
                    ),
                });
                self.set_runtime_error(
                    "SESSION_STALLED",
                    "30 秒没有采集到任何变化：可能页面没加载完、遇到登录墙，或浏览器窗口被关掉了；已停止本轮。",
                );
                self.finish(&app, StopReason::Crash, true);
                break;
            }
            let should_sample = {
                let mut channel = match self.channel.lock() {
                    Ok(channel) => channel,
                    Err(poisoned) => poisoned.into_inner(),
                };
                channel.allow_answer(now)
            };

            if should_sample {
                let mut facts_result: Option<Result<(PageFacts, usize), ExtractIssue>> = None;
                if session.is_none() {
                    match CdpSession::connect(port, platform).await {
                        Ok(cdp) => {
                            session = Some(cdp);
                            reconnect_failures = 0;
                        }
                        Err(_) => {
                            reconnect_failures = reconnect_failures.saturating_add(1);
                            if reconnect_failures >= MAX_RECONNECT_FAILURES {
                                self.set_runtime_error("CDP_RECONNECT_FAILED", "小狗浏览器连接连续失败，已停止本轮。");
                                self.close_browser_instance();
                                self.finish(&app, StopReason::Crash, false);
                                break;
                            }
                        }
                    }
                }
                let evaluate_result = if let Some(cdp) = session.as_mut() {
                    Some(cdp.evaluate(adapter.extract_script(), EVALUATE_TIMEOUT).await)
                } else {
                    None
                };
                if let Some(result) = evaluate_result {
                    match result {
                        Ok(value) => {
                            cdp_failures = 0;
                            facts_result = Some(normalize_value(&value, platform, 1.0));
                            if let Ok(mut channel) = self.channel.lock() {
                                channel.record_success(now);
                            }
                        }
                        Err(reason) => {
                            cdp_failures = cdp_failures.saturating_add(1);
                            let _action = {
                                let mut channel = match self.channel.lock() {
                                    Ok(channel) => channel,
                                    Err(poisoned) => poisoned.into_inner(),
                                };
                                channel.record_failure(reason, now)
                            };
                            session = None;
                            if cdp_failures >= MAX_CDP_FAILURES {
                                self.set_runtime_error("CDP_STALLED", "页面连续无响应，已停止本轮以避免桌宠卡死。");
                                self.close_browser_instance();
                                self.finish(&app, StopReason::Crash, false);
                                break;
                            }
                        }
                    }
                }

                if facts_result.is_none() {
                    // 弱通道：只读前台窗口标题，不推断时长与互动。
                    if let Some((title, process)) = foreground_title_process() {
                        if super::rules::title_matches(&title, platform) {
                            let raw = RawFacts {
                                title: title.clone(),
                                url: String::new(),
                                duration_seconds: 0,
                                playing: false,
                                visible: true,
                                on_feed: true,
                                ..RawFacts::default()
                            };
                            facts_result = Some(normalize_value(
                                &serde_json::to_value(raw).unwrap_or_default(),
                                platform,
                                0.3,
                            ));
                        } else {
                            let mut state = lock_state(&self.state);
                            state.foreground_title = title;
                            state.foreground_process = process;
                            state.waiting_for_browser = true;
                        }
                    }
                }

                if let Some(Ok((facts, _unknown))) = facts_result {
                    let kind = adapter.classify_page(&facts);
                    let mut pending_advance = false;
                    let mut pending_persist = false;
                    let mut pending_comment: Option<PageFacts> = None;
                    // N5：Feed/首页时先在 state 锁之外做导航尝试（await 期间不能持有 MutexGuard）。
                    let mut nav_result: Option<NavOutcome> = None;
                    {
                        let items_empty = lock_state(&self.state).items.is_empty();
                        if matches!(kind, PageKind::Feed)
                            && items_empty
                            && nav_failures < 3
                            && now.saturating_sub(last_nav_at) >= 5
                        {
                            last_nav_at = now;
                            if let Some(cdp) = session.as_mut() {
                                nav_result = Some(force_enter_video_page(cdp).await);
                            }
                        }
                    }
                    let mut auto_comment: Option<PageFacts> = None;
                    {
                        let mut state = lock_state(&self.state);
                        state.foreground_title = facts.title.clone();
                        state.foreground_process.clear();
                        state.waiting_for_browser = false;
                        if let Some(url) = facts.canonical_url.clone() {
                            state.current_url = url;
                        }
                        match kind {
                        PageKind::RiskControl => {
                            state.error_code = Some("RISK_CONTROL".to_string());
                            state.error_message = Some("平台要求验证，小狗已停下来。".to_string());
                            drop(state);
                            self.finish(&app, StopReason::RiskControl, false);
                            break;
                        }
                        PageKind::Login => {
                            let mut diagnostics = 0;
                            try_transition(&mut state.phase, Phase::AwaitingLogin, &mut diagnostics);
                            state.error_code = Some("LOGIN_REQUIRED".to_string());
                            state.error_message = Some("请在小狗专用窗口登录一次。".to_string());
                        }
                        PageKind::Other => {
                            state.waiting_for_browser = true;
                        }
                        PageKind::Feed => {
                            // N5：使用锁外完成的导航结果（成功记 NAV_OK；三次失败 → NAV_FAILED + 停止）。
                            if let Some(outcome) = nav_result.take() {
                                if outcome.ok {
                                    nav_failures = 0;
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(state.session_id.clone()),
                                        channel: Some(ChannelType::Cdp),
                                        level: "info".to_string(),
                                        code: "NAV_OK".to_string(),
                                        message: format!("url={} attempts={:?}", outcome.final_url, outcome.attempts),
                                    });
                                    // P0：导航后复核（导航与采集用同一 target 的结果）。
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(state.session_id.clone()),
                                        channel: Some(ChannelType::Cdp),
                                        level: if outcome.final_url.contains("/video/") { "info" } else { "warn" }.to_string(),
                                        code: "NAV_VERIFIED".to_string(),
                                        message: format!("url={} title={}", outcome.final_url, outcome.title),
                                    });
                                } else {
                                    nav_failures = nav_failures.saturating_add(1);
                                    if nav_failures >= 3 {
                                        self.store.log(DiagnosticEntry {
                                            at: now,
                                            session_id: Some(state.session_id.clone()),
                                            channel: Some(ChannelType::Cdp),
                                            level: "error".to_string(),
                                            code: "NAV_FAILED".to_string(),
                                            message: format!(
                                                "final_url={} title={} attempts={:?}",
                                                outcome.final_url, outcome.title, outcome.attempts
                                            ),
                                        });
                                        drop(state);
                                        self.set_runtime_error(
                                            "NAV_FAILED",
                                            "进不去视频页：可能停在登录页、遇到风控，或页面结构变了（详见 video/logs 里的 NAV_FAILED）。",
                                        );
                                        self.finish(&app, StopReason::Crash, false);
                                        return;
                                    }
                                }
                            }
                            if state.phase == Phase::AwaitingLogin {
                                let mut diagnostics = 0;
                                try_transition(&mut state.phase, Phase::Collecting, &mut diagnostics);
                                state.error_code = None;
                                state.error_message = None;
                            }
                            match merge_facts(&mut state.items, &facts, now) {
                                MergeOutcome::Filtered => {
                                    state.filtered_count = state.filtered_count.saturating_add(1);
                                    last_progress_at = now;
                                    // N3：丢弃原因必须落到 video/logs/video-<date>.jsonl
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(state.session_id.clone()),
                                        channel: Some(ChannelType::Cdp),
                                        level: "info".to_string(),
                                        code: "ITEM_DISCARDED".to_string(),
                                        message: format!(
                                            "{} | reason={} | url={}",
                                            facts.title,
                                            facts.filter_reason.clone().unwrap_or_else(|| "not_video_page".to_string()),
                                            facts.canonical_url.clone().unwrap_or_default()
                                        ),
                                    });
                                }
                                other => {
                                    // N5 验收：真正采到视频条目时落 ITEM_COLLECTED（含 /video/ URL）。
                                    if matches!(other, MergeOutcome::New | MergeOutcome::Updated) {
                                        let url = facts.canonical_url.clone().unwrap_or_default();
                                        if url.contains("/video/") {
                                            last_collect_key = facts.item_key.clone();
                                            if current_video_url.is_empty() {
                                                current_video_url = url.clone();
                                            }
                                            self.store.log(DiagnosticEntry {
                                                at: now,
                                                session_id: Some(state.session_id.clone()),
                                                channel: Some(ChannelType::Cdp),
                                                level: "info".to_string(),
                                                code: "ITEM_COLLECTED".to_string(),
                                                message: format!("url={} watched_ms={} title={}", url, facts.position_seconds.saturating_mul(1000), facts.title),
                                            });
                                            pending_persist = true;
                                            last_progress_at = now;
                                            stall_logged = false;
                                            // N11：锁外做自动评论（去重/间隔/预演都在锁外判断）。
                                            pending_comment = Some(facts.clone());
                                            // N6：同一条重复采集且停留够 20s → 换下一条（标记，锁外执行）。
                                            if !last_collect_key.is_empty()
                                                && url == current_video_url
                                                && now.saturating_sub(last_advance_at) >= 20
                                            {
                                                pending_advance = true;
                                            }
                                        }
                                    }
                                }
                            }
                            if state.items.len() > config.max_items as usize {
                                state.items.truncate(config.max_items as usize);
                            }
                            // 旧 auto_comment 路径已停用：由新评论块接管（dry-run 优先），避免双发。
                        }
                        }
                    }
                    // N11：自动评论（默认 dry-run：只生成 + 日志 + 气泡，不真正发送）。
                    if let Some(facts) = pending_comment.take() {
                        let config = self.config();
                        let url = facts.canonical_url.clone().unwrap_or_default();
                        // 定位打点：无条件记录「评论块确实被执行 + 读到配置」。
                        self.store.log(DiagnosticEntry {
                            at: now,
                            session_id: Some(self.snapshot().session_id),
                            channel: Some(ChannelType::Cdp),
                            level: "info".to_string(),
                            code: "COMMENT_EVAL".to_string(),
                            message: format!(
                                "url={} auto={} dry={} watched_ms={} login={} risk={}",
                                url,
                                config.auto_comment,
                                config.comment_dry_run,
                                facts.position_seconds.saturating_mul(1000),
                                facts.hints.login_visible,
                                facts.hints.captcha_visible || facts.hints.risk_banner
                            ),
                        });
                        let is_login_or_risk = facts.hints.login_visible
                            || facts.hints.captcha_visible
                            || facts.hints.risk_banner;
                        if is_login_or_risk && !login_risk_logged {
                            login_risk_logged = true;
                            self.store.log(DiagnosticEntry {
                                at: now,
                                session_id: Some(self.snapshot().session_id),
                                channel: Some(ChannelType::Cdp),
                                level: "warn".to_string(),
                                code: "COMMENT_SKIPPED".to_string(),
                                message: format!("url={} reason=login_or_risk", url),
                            });
                        } else if url.contains("/video/") && !is_login_or_risk {
                            let watched_ms = facts.position_seconds.saturating_mul(1000);
                            let allowed = config.auto_comment
                                && comment_count < 10
                                && watched_ms >= 8_000
                                && !commented_urls.contains(&url)
                                && (last_comment_at == 0
                                    || now.saturating_sub(last_comment_at) >= 180);
                            if allowed {
                                let model = lock_state(&self.state).comment_model.clone();
                                let generated = match model.as_ref() {
                                    Some(model) => {
                                        tokio::time::timeout(
                                            std::time::Duration::from_secs(30),
                                            generate_content_comment(&app, &facts, model),
                                        )
                                        .await
                                        .unwrap_or_else(|_| Err("评论生成超时".to_string()))
                                    }
                                    None => {
                                        self.store.log(DiagnosticEntry {
                                            at: now,
                                            session_id: Some(self.snapshot().session_id),
                                            channel: Some(ChannelType::Cdp),
                                            level: "warn".to_string(),
                                            code: "COMMENT_SKIPPED".to_string(),
                                            message: format!("url={} reason=no_model", url),
                                        });
                                        Err("未配置评论模型".to_string())
                                    }
                                };
                                let comment = sanitize_comment(&generated.unwrap_or_default());
                                if config.comment_dry_run {
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(self.snapshot().session_id),
                                        channel: Some(ChannelType::Cdp),
                                        level: "info".to_string(),
                                        code: "COMMENT_DRY_RUN".to_string(),
                                        message: format!("url={} text={}", url, comment),
                                    });
                                    let _ = app.emit(
                                        "video-comment-bubble",
                                        serde_json::json!({
                                            "kind": "dry-run",
                                            "text": comment_bubble(&facts.title, &comment),
                                        }),
                                    );
                                } else {
                                    match self.post_comment(&comment).await {
                                        Ok(report) => {
                                            self.store.log(DiagnosticEntry {
                                                at: now,
                                                session_id: Some(self.snapshot().session_id),
                                                channel: Some(ChannelType::Cdp),
                                                level: "info".to_string(),
                                                code: "COMMENT_POSTED".to_string(),
                                                message: format!("url={} text={} ok={}", url, comment, report.ok),
                                            });
                                            let _ = app.emit(
                                                "video-comment-bubble",
                                                serde_json::json!({
                                                    "kind": "posted",
                                                    "text": comment_bubble(&facts.title, &comment),
                                                }),
                                            );
                                        }
                                        Err(error) => {
                                            let message = error.to_string();
                                            let reason = if message.contains("输入框") || message.contains("input") {
                                                "no-input"
                                            } else if message.contains("按钮") || message.contains("button") {
                                                "no-button"
                                            } else {
                                                "comment-cdp"
                                            };
                                            self.store.log(DiagnosticEntry {
                                                at: now,
                                                session_id: Some(self.snapshot().session_id),
                                                channel: Some(ChannelType::Cdp),
                                                level: "warn".to_string(),
                                                code: "COMMENT_SKIPPED".to_string(),
                                                message: format!("url={} reason={}", url, reason),
                                            });
                                            let _ = app.emit(
                                                "video-comment-bubble",
                                                serde_json::json!({ "kind": "failed", "text": format!("评论没发出去（{}），先不发了。", reason) }),
                                            );
                                        }
                                    }
                                }
                                commented_urls.insert(url.clone());
                                last_comment_at = now;
                                comment_count = comment_count.saturating_add(1);
                                {
                                    let mut state = lock_state(&self.state);
                                    state.comment_count = state.comment_count.saturating_add(1);
                                    if config.comment_dry_run {
                                        state.comment_dry_run_count =
                                            state.comment_dry_run_count.saturating_add(1);
                                    }
                                }
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
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(self.snapshot().session_id),
                                        channel: Some(ChannelType::Cdp),
                                        level: "info".to_string(),
                                        code: "COMMENT_SKIPPED".to_string(),
                                        message: format!("url={} reason={}", url, reason),
                                    });
                                }
                            }
                        }
                    }
                    if pending_persist {
                        pending_persist = false;
                        self.persist_runtime_session();
                    }
                    // N6：锁外执行「换下一个视频」，避免 MutexGuard 跨 await。
                    if pending_advance {
                        pending_advance = false;
                        last_advance_at = now;
                        if let Some(cdp) = session.as_mut() {
                            let from_url = current_video_url.clone();
                            let outcome = advance_to_next_video(cdp, &from_url).await;
                            if outcome.ok {
                                advance_failures = 0;
                                let to_url = outcome.final_url.clone();
                                current_video_url = to_url.clone();
                                self.store.log(DiagnosticEntry {
                                    at: now,
                                    session_id: Some(self.snapshot().session_id),
                                    channel: Some(ChannelType::Cdp),
                                    level: "info".to_string(),
                                    code: "ITEM_ADVANCED".to_string(),
                                    message: format!(
                                        "from={} to={} attempts={:?}",
                                        from_url, to_url, outcome.attempts
                                    ),
                                });
                            } else {
                                advance_failures = advance_failures.saturating_add(1);
                                self.store.log(DiagnosticEntry {
                                    at: now,
                                    session_id: Some(self.snapshot().session_id),
                                    channel: Some(ChannelType::Cdp),
                                    level: "warn".to_string(),
                                    code: "ADVANCE_FAILED".to_string(),
                                    message: format!(
                                        "count={} from={} attempts={:?}",
                                        advance_failures, from_url, outcome.attempts
                                    ),
                                });
                            }
                        }
                    }
                    if let Some(facts) = auto_comment {
                        let session_id = self.snapshot().session_id;
                        let model = {
                            let state = lock_state(&self.state);
                            state.comment_model.clone()
                        };
                        let generated = match model.as_ref() {
                            Some(model) => match tokio::time::timeout(
                                Duration::from_secs(35),
                                generate_content_comment(&app, &facts, model),
                            )
                            .await
                            {
                                Ok(result) => result,
                                Err(_) => Err("评论模型响应超时，未发送评论".to_string()),
                            },
                            None => Err("没有传入当前聊天模型配置，未生成评论".to_string()),
                        };
                        match generated {
                            Err(error) => {
                                let message = format!("{}：{}", facts.title, error);
                                self.store.log(DiagnosticEntry {
                                    at: now,
                                    session_id: Some(session_id.clone()),
                                    channel: Some(ChannelType::Cdp),
                                    level: "warn".to_string(),
                                    code: "AUTO_COMMENT_MODEL_FAILED".to_string(),
                                    message: message.clone(),
                                });
                                let _ = app.emit(
                                    "video-auto-comment",
                                    serde_json::json!({
                                        "sessionId": session_id,
                                        "itemKey": facts.item_key,
                                        "ok": false,
                                        "message": message,
                                    }),
                                );
                            }
                            Ok(comment) => match self.post_comment(&comment).await {
                                Ok(report) => {
                                    let code = if report.ok {
                                        "AUTO_COMMENT_SENT"
                                    } else {
                                        "AUTO_COMMENT_SKIPPED"
                                    };
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(session_id.clone()),
                                        channel: Some(ChannelType::Cdp),
                                        level: if report.ok { "info" } else { "warn" }.to_string(),
                                        code: code.to_string(),
                                        message: format!("{}：{}", facts.title, report.message),
                                    });
                                    let _ = app.emit(
                                        "video-auto-comment",
                                        serde_json::json!({
                                            "sessionId": session_id,
                                            "itemKey": facts.item_key,
                                            "ok": report.ok,
                                            "message": report.message,
                                        }),
                                    );
                                }
                                Err(error) => {
                                    let message = error.to_string();
                                    self.store.log(DiagnosticEntry {
                                        at: now,
                                        session_id: Some(session_id.clone()),
                                        channel: Some(ChannelType::Cdp),
                                        level: "warn".to_string(),
                                        code: "AUTO_COMMENT_FAILED".to_string(),
                                        message: message.clone(),
                                    });
                                    let _ = app.emit(
                                        "video-auto-comment",
                                        serde_json::json!({
                                            "sessionId": session_id,
                                            "itemKey": facts.item_key,
                                            "ok": false,
                                            "message": message,
                                        }),
                                    );
                                }
                            },
                        }
                    }
                }

                if last_emit.elapsed() >= Duration::from_millis(SNAPSHOT_THROTTLE_MS) {
                    last_emit = Instant::now();
                    let snapshot = self.snapshot();
                    let _ = app.emit("video-session-updated", snapshot);
                }
            }

            let turn_delay = if first_turn {
                FIRST_ACTION_DELAY_SECONDS
            } else {
                config.page_interval_seconds
            };
            if last_turn.elapsed() >= Duration::from_secs(turn_delay) {
                last_turn = Instant::now();
                first_turn = false;
                let mut turned = false;
                let next_result = if let Some(cdp) = session.as_mut() {
                    Some(cdp.evaluate(adapter.next_action_script(), EVALUATE_TIMEOUT).await)
                } else {
                    None
                };
                match next_result {
                    Some(Ok(value)) => {
                        turned = value.as_bool().unwrap_or(false);
                        cdp_failures = 0;
                    }
                    Some(Err(_)) => {
                        cdp_failures = cdp_failures.saturating_add(1);
                        session = None;
                    }
                    None => {}
                }
                if let Some(cdp) = session.as_mut() {
                    if !turned {
                        turned = cdp.dispatch_key(super::rules::page_key(platform)).await.is_ok();
                    }
                }
                if cdp_failures >= MAX_CDP_FAILURES {
                    self.set_runtime_error("CDP_STALLED", "翻页页面连续无响应，已停止本轮以避免桌宠卡死。");
                    self.finish(&app, StopReason::Crash, false);
                    break;
                }
                if turned {
                    let mut state = lock_state(&self.state);
                    state.steps = state.steps.saturating_add(1);
                    state.last_action_at = Some(now_seconds());
                    state.waiting_for_browser = false;
                } else {
                    let mut state = lock_state(&self.state);
                    state.waiting_for_browser = true;
                }
            }

            tokio::time::sleep(Duration::from_secs(config.sample_interval_seconds.max(1))).await;
        }

    }

    fn finish(&self, app: &AppHandle, reason: StopReason, produce_digest: bool) {
        let config = self.config();
        let profile = self.store.profile();
        let (mut session, items, platform, ended_at) = {
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
            };
            (session, state.items.clone(), state.platform, ended_at)
        };

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
        self.store.list_sessions(limit)
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
    pub fn open_login_window(&self, platform: Platform, account_id: Option<&str>) -> VideoResult<()> {
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
            std::thread::sleep(Duration::from_millis(600));
            if browser::focus_browser_window(platform) {
                return Ok(());
            }
            return Err(not_visible());
        }
        if let Some(handle) = browser::find_reusable(&profile) {
            let port = handle.port;
            self.install_browser(BrowserInstance::External(handle));
            let _ = browser::open_target(port, platform.feed_url());
            std::thread::sleep(Duration::from_millis(600));
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
        if !browser::wait_for_cdp(port, browser::CDP_READY_TIMEOUT) {
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
        if !browser::wait_for_visible_window(pid, browser::LOGIN_WINDOW_TIMEOUT) {
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
