//! 会话编排：状态机、采集 tick、翻页调度、整理与投递入队。
//!
//! 纯逻辑部分（状态迁移、条目合并）可单测；运行部分通过 CDP 驱动专用浏览器，
//! CDP 不可用时降级到前台窗口标题（弱通道，只作主题线索）。

use super::adapter::adapter_for;
use super::browser::{self, BrowserProcess};
use super::cdp::{CdpSession, EVALUATE_TIMEOUT};
use super::channel::{ChannelAction, ChannelManager};
use super::CommentReport;
use super::config::{apply_patch, validate_config, VideoConfig, VideoConfigPatch};
use super::delivery::can_deliver;
use super::digest::build_digest;
use super::extract::{normalize_value, ExtractIssue, PageFacts, PageKind, RawFacts};
use super::guard::Guard;
use super::interest::score;
use super::model::*;
use super::profile::learn_from_session;
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSnapshot {
    pub session_id: String,
    pub provider: String,
    pub phase: Phase,
    pub running: bool,
    pub interval_seconds: u64,
    pub max_minutes: u64,
    pub steps: u64,
    pub item_count: u32,
    pub strong_count: u32,
    pub filtered_count: u32,
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
            phase: Phase::Idle,
            running: false,
            interval_seconds: 45,
            max_minutes: 30,
            steps: 0,
            item_count: 0,
            strong_count: 0,
            filtered_count: 0,
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
    interval_seconds: u64,
    max_minutes: u64,
    sample_interval_seconds: u64,
    started_at: u64,
    ended_at: Option<u64>,
    stop_reason: Option<StopReason>,
    steps: u64,
    items: Vec<ContentItem>,
    filtered_count: u32,
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
            interval_seconds: 45,
            max_minutes: 30,
            sample_interval_seconds: 2,
            started_at: 0,
            ended_at: None,
            stop_reason: None,
            steps: 0,
            items: Vec::new(),
            filtered_count: 0,
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
    state: Mutex<RuntimeState>,
    config: Mutex<VideoConfig>,
    channel: Mutex<ChannelManager>,
    guard: Mutex<Guard>,
    browser: Mutex<Option<BrowserProcess>>,
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

impl SessionEngine {
    pub fn snapshot(&self) -> VideoSnapshot {
        let state = lock_state(&self.state);
        VideoSnapshot {
            session_id: state.session_id.clone(),
            provider: state.provider.clone(),
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

    pub fn config(&self) -> VideoConfig {
        match self.config.lock() {
            Ok(config) => config.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
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
    ) -> VideoResult<VideoSnapshot> {
        if let Some(patch) = patch.as_ref() {
            self.update_config(patch)?;
        }
        let config = self.config();
        validate_config(&config)
            .map_err(|message| VideoError::new("INVALID_CONFIG", message))?;

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
                interval_seconds: config.page_interval_seconds,
                max_minutes: config.max_minutes,
                sample_interval_seconds: config.sample_interval_seconds,
                started_at,
                ..RuntimeState::default()
            };
            let mut diagnostics = 0;
            try_transition(&mut state.phase, Phase::Collecting, &mut diagnostics);
            state.diagnostics = diagnostics;

            let session = VideoSession::new(session_id, provider, started_at);
            self.store.save_session(&session);
        }

        let run_id = self.run_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.stop.store(false, Ordering::SeqCst);

        let port = match browser::pick_port(browser::DEFAULT_PORT) {
            Ok(port) => port,
            Err(error) => {
                self.abort_start(Phase::Stopped, &error.code, &error.message);
                return Err(error);
            }
        };
        let profile = browser::profile_dir();
        let process = match browser::launch(provider, port, &profile, false) {
            Ok(process) => process,
            Err(error) => {
                self.abort_start(Phase::Stopped, &error.code, &error.message);
                return Err(error);
            }
        };
        {
            let mut browser = match self.browser.lock() {
                Ok(browser) => browser,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some(mut previous) = browser.take() {
                previous.close();
            }
            *browser = Some(process);
        }

        // 记录端口：评论等一次性操作需要复用同一个浏览器实例。
        {
            let mut state = self.state.lock().expect("video state lock");
            state.cdp_port = port;
        }

        let engine = self.clone();
        let app_for_loop = app.clone();
        tauri::async_runtime::spawn(async move {
            engine.run(app_for_loop, port, run_id).await;
        });

        Ok(self.snapshot())
    }

    fn abort_start(&self, phase: Phase, code: &str, message: &str) {
        let mut state = lock_state(&self.state);
        state.phase = phase;
        state.error_code = Some(code.to_string());
        state.error_message = Some(message.to_string());
    }

    pub fn stop(&self, reason: Option<StopReason>) -> VideoSnapshot {
        self.stop.store(true, Ordering::SeqCst);
        self.run_id.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = lock_state(&self.state);
            let stop_reason = reason.unwrap_or(StopReason::UserStop);
            let mut diagnostics = 0;
            if try_transition(&mut state.phase, Phase::Stopped, &mut diagnostics) {
                state.stop_reason = Some(stop_reason);
                state.ended_at = Some(now_seconds());
            }
        }
        if let Some(mut browser) = match self.browser.lock() {
            Ok(mut browser) => browser.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        } {
            browser.close();
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

        let connect_deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match CdpSession::connect(port, platform).await {
                Ok(mut cdp) => {
                    let _ = cdp.navigate(adapter.feed_url()).await;
                    session = Some(cdp);
                    break;
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
        } else if let Ok(mut channel) = self.channel.lock() {
            channel.record_failure(FailureReason::NoResponse, now_seconds());
            let state = channel.active();
            drop(channel);
            if let Ok(mut runtime) = self.state.lock() {
                runtime.channel = state;
                runtime.degraded = true;
            }
        }

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

            if now_seconds().saturating_sub(started_at) >= config.max_minutes.saturating_mul(60) {
                self.finish(&app, StopReason::DurationLimit, true);
                break;
            }
            if item_count >= config.max_items as usize {
                self.finish(&app, StopReason::ItemLimit, true);
                break;
            }

            let now = now_seconds();
            let should_sample = {
                let mut channel = match self.channel.lock() {
                    Ok(channel) => channel,
                    Err(poisoned) => poisoned.into_inner(),
                };
                channel.allow_answer(now)
            };

            if should_sample {
                let mut facts_result: Option<Result<(PageFacts, usize), ExtractIssue>> = None;
                if let Some(cdp) = session.as_mut() {
                    match cdp.evaluate(adapter.extract_script(), EVALUATE_TIMEOUT).await {
                        Ok(value) => {
                            facts_result = Some(normalize_value(&value, platform, 1.0));
                            if let Ok(mut channel) = self.channel.lock() {
                                channel.record_success(now);
                            }
                        }
                        Err(reason) => {
                            let action = {
                                let mut channel = match self.channel.lock() {
                                    Ok(channel) => channel,
                                    Err(poisoned) => poisoned.into_inner(),
                                };
                                channel.record_failure(reason, now)
                            };
                            if matches!(action, ChannelAction::Degrade) {
                                session = None;
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
                            if state.phase == Phase::AwaitingLogin {
                                let mut diagnostics = 0;
                                try_transition(&mut state.phase, Phase::Collecting, &mut diagnostics);
                                state.error_code = None;
                                state.error_message = None;
                            }
                            match merge_facts(&mut state.items, &facts, now) {
                                MergeOutcome::Filtered => {
                                    state.filtered_count = state.filtered_count.saturating_add(1)
                                }
                                _ => {}
                            }
                            if state.items.len() > config.max_items as usize {
                                state.items.truncate(config.max_items as usize);
                            }
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
                if let Some(cdp) = session.as_mut() {
                    if let Ok(value) =
                        cdp.evaluate(adapter.next_action_script(), EVALUATE_TIMEOUT).await
                    {
                        turned = value.as_bool().unwrap_or(false);
                    }
                    if !turned {
                        turned = cdp.dispatch_key(super::rules::page_key(platform)).await.is_ok();
                    }
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

            if let Some(draft) = build_digest(&session.session_id, platform, &strong, &weak, 5) {
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
        }
        Ok(report)
    }

    pub fn probe_channels(&self) -> Vec<ChannelState> {
        ChannelManager::default_health()
    }

    pub fn close_browser(&self) -> VideoResult<()> {
        if let Some(mut browser) = match self.browser.lock() {
            Ok(mut browser) => browser.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        } {
            browser.close();
        }
        Ok(())
    }

    /// 首次登录：这是唯一允许把窗口提到前台的路径。
    pub fn open_login_window(&self, platform: Platform) -> VideoResult<()> {
        let has_browser = match self.browser.lock() {
            Ok(browser) => browser.is_some(),
            Err(poisoned) => poisoned.into_inner().is_some(),
        };
        if has_browser {
            if browser::focus_browser_window(platform) {
                return Ok(());
            }
        }
        let port = browser::pick_port(browser::DEFAULT_PORT)?;
        let profile = browser::profile_dir();
        let process = browser::launch(platform, port, &profile, true)?;
        match self.browser.lock() {
            Ok(mut browser) => *browser = Some(process),
            Err(poisoned) => *poisoned.into_inner() = Some(process),
        }
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