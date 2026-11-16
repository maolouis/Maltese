//! 刷视频数据落盘：会话、索引、画像、投递、待投递与脱敏日志。
//!
//! 写失败不阻塞调用方：数据留在内存并置 `persistFailed`。

use super::delivery::{PendingQueue, MAX_PENDING};
use super::model::{
    now_seconds, ClearReport, ClearScope, DeliveryRecord, DiagnosticEntry, SessionSummary,
    UserProfile, VideoSession,
};
use super::profile::empty_profile;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

pub const SESSION_RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const DELIVERY_RETENTION_SECONDS: u64 = 90 * 24 * 60 * 60;
pub const LOG_RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_LOG_ENTRIES: usize = 200;

#[derive(Default)]
struct StoreData {
    sessions: HashMap<String, VideoSession>,
    index: Vec<SessionSummary>,
    profile: Option<UserProfile>,
    deliveries: Vec<DeliveryRecord>,
    pending: PendingQueue,
    logs: VecDeque<DiagnosticEntry>,
}

pub struct StoreHandle {
    root: PathBuf,
    memory_only: bool,
    persist_failed: AtomicBool,
    data: Mutex<StoreData>,
}

struct CivilDate {
    year: i64,
    month: u32,
    day: u32,
}

/// 把 Unix 秒转成 UTC 年月日（Howard Hinnant 的 civil_from_days）。
fn civil_from_seconds(seconds: u64) -> CivilDate {
    let days = (seconds / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    if month <= 2 {
        year += 1;
    }
    CivilDate { year, month, day }
}

fn month_folder(seconds: u64) -> String {
    let date = civil_from_seconds(seconds);
    format!("{:04}-{:02}", date.year, date.month)
}

fn log_file_name(seconds: u64) -> String {
    let date = civil_from_seconds(seconds);
    format!("video-{:04}{:02}{:02}.jsonl", date.year, date.month, date.day)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("data"),
        now_seconds()
    ));
    {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, fallback: T) -> (T, bool) {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(value) => (value, false),
            Err(_) => {
                let _ = fs::rename(path, path.with_extension("corrupt"));
                (fallback, true)
            }
        },
        Err(_) => (fallback, false),
    }
}

impl StoreHandle {
    pub fn new(root: PathBuf) -> Self {
        let memory_only = fs::create_dir_all(&root).is_err();
        let store = Self {
            root,
            memory_only,
            persist_failed: AtomicBool::new(memory_only),
            data: Mutex::new(StoreData::default()),
        };
        store.load();
        store.cleanup_retention(now_seconds());
        store
    }

    pub fn memory() -> Self {
        Self {
            root: PathBuf::new(),
            memory_only: true,
            persist_failed: AtomicBool::new(true),
            data: Mutex::new(StoreData::default()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn persist_failed(&self) -> bool {
        self.persist_failed.load(Ordering::Relaxed)
    }

    pub fn memory_only(&self) -> bool {
        self.memory_only
    }

    fn fail(&self) {
        self.persist_failed.store(true, Ordering::Relaxed);
    }

    fn load(&self) {
        if self.memory_only {
            return;
        }
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };

        let index_path = self.root.join("index.json");
        let (mut index, damaged) = read_json::<Vec<SessionSummary>>(&index_path, Vec::new());
        if damaged {
            self.fail();
        }
        if index.is_empty() {
            index = self.scan_sessions();
        }

        let mut sessions: HashMap<String, VideoSession> = HashMap::new();
        for summary in &index {
            if let Some(session) = self.read_session(&summary.session_id, summary.started_at) {
                sessions.insert(summary.session_id.clone(), session);
            }
        }

        let (profile, profile_damaged) = read_json::<UserProfile>(
            &self.root.join("profile.json"),
            empty_profile(),
        );
        if profile_damaged {
            self.fail();
        }

        let deliveries = self.read_deliveries();
        let (pending, pending_damaged) =
            read_json::<PendingQueue>(&self.root.join("pending.json"), PendingQueue::default());
        if pending_damaged {
            self.fail();
        }

        let logs = VecDeque::new();

        data.index = index;
        data.sessions = sessions;
        data.profile = Some(profile);
        data.deliveries = deliveries;
        data.pending = pending;
        data.logs = logs;
    }

    fn sessions_root(&self) -> PathBuf {
        self.root.join("sessions")
    }

    fn scan_sessions(&self) -> Vec<SessionSummary> {
        let mut result = Vec::new();
        let root = self.sessions_root();
        let Ok(months) = fs::read_dir(&root) else {
            return result;
        };
        for month in months.flatten() {
            let Ok(files) = fs::read_dir(month.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                if let Ok(session) = serde_json::from_str::<VideoSession>(&content) {
                    result.push(SessionSummary::from(&session));
                }
            }
        }
        result.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        result
    }

    fn session_path(&self, session_id: &str, started_at: u64) -> PathBuf {
        self.sessions_root()
            .join(month_folder(started_at))
            .join(format!("{session_id}.json"))
    }

    fn read_session(&self, session_id: &str, started_at: u64) -> Option<VideoSession> {
        if self.memory_only {
            return None;
        }
        let path = self.session_path(session_id, started_at);
        let content = fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn save_session(&self, session: &VideoSession) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.sessions.insert(session.session_id.clone(), session.clone());
        let summary = SessionSummary::from(session);
        data.index.retain(|item| item.session_id != session.session_id);
        data.index.push(summary);
        data.index.sort_by(|left, right| right.started_at.cmp(&left.started_at));

        if self.memory_only {
            return;
        }
        let path = self.session_path(&session.session_id, session.started_at);
        let result = serde_json::to_string_pretty(session)
            .map_err(|error| error.to_string())
            .and_then(|content| atomic_write(&path, &content));
        if result.is_err() {
            self.fail();
            return;
        }
        let index = serde_json::to_string_pretty(&data.index).unwrap_or_else(|_| "[]".to_string());
        if atomic_write(&self.root.join("index.json"), &index).is_err() {
            self.fail();
        }
    }

    pub fn get_session(&self, session_id: &str) -> Option<VideoSession> {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.sessions.get(session_id).cloned()
    }

    pub fn list_sessions(&self, limit: u32) -> Vec<SessionSummary> {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.index
            .iter()
            .take(limit.max(1) as usize)
            .cloned()
            .collect()
    }

    pub fn profile(&self) -> UserProfile {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.profile.clone().unwrap_or_else(empty_profile)
    }

    pub fn save_profile(&self, profile: &UserProfile) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.profile = Some(profile.clone());
        if self.memory_only {
            return;
        }
        let content = match serde_json::to_string_pretty(profile) {
            Ok(content) => content,
            Err(_) => {
                self.fail();
                return;
            }
        };
        if atomic_write(&self.root.join("profile.json"), &content).is_err() {
            self.fail();
        }
    }

    fn read_deliveries(&self) -> Vec<DeliveryRecord> {
        if self.memory_only {
            return Vec::new();
        }
        let path = self.root.join("deliveries.jsonl");
        let Ok(content) = fs::read_to_string(path) else {
            return Vec::new();
        };
        let mut result = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<DeliveryRecord>(trimmed) {
                result.push(record);
            }
        }
        result
    }

    pub fn deliveries(&self) -> Vec<DeliveryRecord> {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.deliveries.clone()
    }

    pub fn append_delivery(&self, record: &DeliveryRecord) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(existing) = data
            .deliveries
            .iter_mut()
            .find(|existing| existing.session_id == record.session_id)
        {
            *existing = record.clone();
            return;
        }
        data.deliveries.push(record.clone());
        if self.memory_only {
            return;
        }
        let Ok(line) = serde_json::to_string(record) else {
            self.fail();
            return;
        };
        let path = self.root.join("deliveries.jsonl");
        let result = fs::create_dir_all(&self.root)
            .map_err(|error| error.to_string())
            .and_then(|_| {
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .map_err(|error| error.to_string())?
                    .write_all(format!("{line}\n").as_bytes())
                    .map_err(|error| error.to_string())
            });
        if result.is_err() {
            self.fail();
        }
    }

    pub fn pending(&self) -> PendingQueue {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.pending.clone()
    }

    pub fn save_pending(&self, pending: &PendingQueue) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut pending = pending.clone();
        if pending.items.len() > MAX_PENDING {
            let drain = pending.items.len() - MAX_PENDING;
            pending.items.drain(0..drain);
        }
        data.pending = pending;
        if self.memory_only {
            return;
        }
        let content = match serde_json::to_string_pretty(&data.pending) {
            Ok(content) => content,
            Err(_) => {
                self.fail();
                return;
            }
        };
        if atomic_write(&self.root.join("pending.json"), &content).is_err() {
            self.fail();
        }
    }

    pub fn log(&self, entry: DiagnosticEntry) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.logs.push_back(entry.clone());
        while data.logs.len() > MAX_LOG_ENTRIES {
            data.logs.pop_front();
        }
        if self.memory_only {
            return;
        }
        let Ok(line) = serde_json::to_string(&entry) else {
            return;
        };
        let path = self
            .root
            .join("logs")
            .join(log_file_name(entry.at));
        let _ = fs::create_dir_all(self.root.join("logs")).and_then(|_| {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut file| file.write_all(format!("{line}\n").as_bytes()))
        });
    }

    pub fn diagnostics(&self, limit: u32) -> Vec<DiagnosticEntry> {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.logs
            .iter()
            .rev()
            .take(limit.max(1).min(MAX_LOG_ENTRIES as u32) as usize)
            .cloned()
            .collect()
    }

    pub fn cleanup_retention(&self, now: u64) {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };

        let old_sessions: Vec<String> = data
            .sessions
            .values()
            .filter(|session| now.saturating_sub(session.started_at) > SESSION_RETENTION_SECONDS)
            .map(|session| session.session_id.clone())
            .collect();
        for session_id in &old_sessions {
            if let Some(session) = data.sessions.remove(session_id) {
                if !self.memory_only {
                    let _ = fs::remove_file(self.session_path(&session.session_id, session.started_at));
                }
            }
        }
        data.index.retain(|summary| {
            now.saturating_sub(summary.started_at) <= SESSION_RETENTION_SECONDS
        });

        let before = data.deliveries.len();
        data.deliveries
            .retain(|record| now.saturating_sub(record.delivered_at) <= DELIVERY_RETENTION_SECONDS);
        if before != data.deliveries.len() && !self.memory_only {
            let content = data
                .deliveries
                .iter()
                .filter_map(|record| serde_json::to_string(record).ok())
                .collect::<Vec<_>>()
                .join("\n");
            let _ = atomic_write(&self.root.join("deliveries.jsonl"), &content);
        }

        if !self.memory_only {
            let logs = self.root.join("logs");
            if let Ok(entries) = fs::read_dir(&logs) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Ok(metadata) = entry.metadata() {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                                if now.saturating_sub(duration.as_secs()) > LOG_RETENTION_SECONDS {
                                    let _ = fs::remove_file(path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn dir_size(&self, path: &Path) -> u64 {
        let mut total = 0;
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let child = entry.path();
                if child.is_dir() {
                    total += self.dir_size(&child);
                } else if let Ok(metadata) = entry.metadata() {
                    total += metadata.len();
                }
            }
        }
        total
    }

    pub fn clear(&self, scope: ClearScope, include_browser_profile: bool) -> ClearReport {
        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        let before = if self.memory_only {
            0
        } else {
            self.dir_size(&self.root)
        };

        match scope {
            ClearScope::Sessions => {
                data.sessions.clear();
                data.index.clear();
                if !self.memory_only {
                    let _ = fs::remove_dir_all(self.sessions_root());
                    let _ = fs::remove_file(self.root.join("index.json"));
                }
            }
            ClearScope::Profile => {
                data.profile = Some(empty_profile());
                if !self.memory_only {
                    let _ = fs::remove_file(self.root.join("profile.json"));
                }
            }
            ClearScope::Deliveries => {
                data.deliveries.clear();
                if !self.memory_only {
                    let _ = fs::remove_file(self.root.join("deliveries.jsonl"));
                }
            }
            ClearScope::Logs => {
                data.logs.clear();
                if !self.memory_only {
                    let _ = fs::remove_dir_all(self.root.join("logs"));
                }
            }
            ClearScope::All => {
                data.sessions.clear();
                data.index.clear();
                data.profile = Some(empty_profile());
                data.deliveries.clear();
                data.logs.clear();
                data.pending = PendingQueue::default();
                if !self.memory_only {
                    let _ = fs::remove_dir_all(self.sessions_root());
                    for name in [
                        "index.json",
                        "profile.json",
                        "deliveries.jsonl",
                        "pending.json",
                    ] {
                        let _ = fs::remove_file(self.root.join(name));
                    }
                    let _ = fs::remove_dir_all(self.root.join("logs"));
                }
            }
        }

        let after = if self.memory_only {
            0
        } else {
            self.dir_size(&self.root)
        };
        let mut kept = Vec::new();
        if include_browser_profile {
            kept.push("浏览器登录 profile 会在调用方清空".to_string());
        } else {
            kept.push("浏览器登录 profile（video-profile）".to_string());
        }
        ClearReport {
            scope,
            removed_bytes: before.saturating_sub(after),
            kept,
        }
    }

    pub fn pending_count(&self) -> usize {
        let data = match self.data.lock() {
            Ok(data) => data,
            Err(poisoned) => poisoned.into_inner(),
        };
        data.pending.items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{Platform, DigestDraft, DeliveryStatus, DigestGenerator};

    fn temp_root(tag: &str) -> PathBuf {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("target");
        path.push("video-test");
        path.push(format!(
            "{tag}-{}-{}",
            now_seconds(),
            std::process::id()
        ));
        path
    }

    #[test]
    fn session_roundtrip_keeps_fields() {
        let root = temp_root("roundtrip");
        let store = StoreHandle::new(root.clone());
        let mut session = VideoSession::new(
            "bili-20261114-abc123".to_string(),
            Platform::Bilibili,
            now_seconds(),
        );
        session.item_count = 3;
        session.strong_count = 1;
        session.stop_reason = Some(crate::video::model::StopReason::DurationLimit);
        store.save_session(&session);

        let loaded = store.get_session(&session.session_id).expect("session");
        assert_eq!(loaded.item_count, 3);
        assert_eq!(loaded.strong_count, 1);
        assert_eq!(loaded.stop_reason, session.stop_reason);

        let reopened = StoreHandle::new(root.clone());
        let loaded = reopened.get_session(&session.session_id).expect("session after reopen");
        assert_eq!(loaded.item_count, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_json_is_backed_up() {
        let root = temp_root("corrupt");
        fs::create_dir_all(&root).expect("dir");
        fs::write(root.join("index.json"), "not json").expect("write");
        let store = StoreHandle::new(root.clone());
        assert!(root.join("index.corrupt").exists());
        assert!(store.persist_failed());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn index_rebuilds_from_session_files() {
        let root = temp_root("rebuild");
        let store = StoreHandle::new(root.clone());
        let session = VideoSession::new("bili-1".to_string(), Platform::Bilibili, now_seconds());
        store.save_session(&session);
        fs::remove_file(root.join("index.json")).expect("remove index");

        let reopened = StoreHandle::new(root.clone());
        assert_eq!(reopened.list_sessions(10).len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_removes_expired_sessions_and_deliveries() {
        let root = temp_root("retention");
        let store = StoreHandle::new(root.clone());
        let now = now_seconds();
        let old_started = now.saturating_sub(SESSION_RETENTION_SECONDS + 100);
        let old = VideoSession::new("old".to_string(), Platform::Bilibili, old_started);
        store.save_session(&old);
        store.append_delivery(&DeliveryRecord {
            session_id: "old".to_string(),
            delivered_at: now.saturating_sub(DELIVERY_RETENTION_SECONDS + 100),
            channels: Vec::new(),
            item_keys: Vec::new(),
            cluster_keys: Vec::new(),
            status: DeliveryStatus::Delivered,
        });
        store.cleanup_retention(now);
        assert!(store.get_session("old").is_none());
        assert!(store.deliveries().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unwritable_root_falls_back_to_memory() {
        let root = temp_root("readonly");
        fs::create_dir_all(&root).expect("dir");
        let file = root.join("blocker");
        fs::write(&file, "x").expect("write");
        let store = StoreHandle::new(file);
        assert!(store.memory_only());
        assert!(store.persist_failed());
        let session = VideoSession::new("s".to_string(), Platform::Douyin, 1);
        store.save_session(&session);
        assert!(store.get_session("s").is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_queue_is_bounded() {
        let root = temp_root("pending");
        let store = StoreHandle::new(root.clone());
        let mut pending = PendingQueue::default();
        for index in 0..7 {
            pending.enqueue(
                DigestDraft {
                    session_id: format!("s{index}"),
                    theme_line: None,
                    generator: DigestGenerator::Template,
                    items: Vec::new(),
                    total_chars: 0,
                },
                0,
            );
        }
        store.save_pending(&pending);
        assert_eq!(store.pending_count(), MAX_PENDING);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clear_all_resets_data() {
        let root = temp_root("clear");
        let store = StoreHandle::new(root.clone());
        let session = VideoSession::new("s".to_string(), Platform::Bilibili, now_seconds());
        store.save_session(&session);
        store.append_delivery(&DeliveryRecord {
            session_id: "s".to_string(),
            delivered_at: 100,
            channels: Vec::new(),
            item_keys: Vec::new(),
            cluster_keys: Vec::new(),
            status: DeliveryStatus::Delivered,
        });
        let report = store.clear(ClearScope::All, false);
        assert!(report.removed_bytes > 0);
        assert!(store.get_session("s").is_none());
        assert!(store.deliveries().is_empty());
        assert!(!report.kept.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn log_is_capped_in_memory() {
        let store = StoreHandle::memory();
        for index in 0..250 {
            store.log(DiagnosticEntry {
                at: index,
                session_id: None,
                channel: None,
                level: "info".to_string(),
                code: "TEST".to_string(),
                message: "m".to_string(),
            });
        }
        assert_eq!(store.diagnostics(1000).len(), MAX_LOG_ENTRIES);
    }
}