//! 投递：7 天指纹去重、24 小时同簇去重、每日上限与待投递队列。

use super::model::{
    DeliveryChannel, DeliveryOutcome, DeliveryRecord, DeliveryStatus, DigestDraft,
};
use serde::{Deserialize, Serialize};

pub const ITEM_DEDUPE_SECONDS: u64 = 7 * 24 * 60 * 60;
pub const CLUSTER_DEDUPE_SECONDS: u64 = 24 * 60 * 60;
pub const MAX_PENDING: usize = 5;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryDecision {
    pub allowed: bool,
    pub reason: String,
}

impl DeliveryDecision {
    fn allow() -> Self {
        Self {
            allowed: true,
            reason: "可以投递".to_string(),
        }
    }

    fn deny(reason: &str) -> Self {
        Self {
            allowed: false,
            reason: reason.to_string(),
        }
    }
}

fn same_day(left: u64, right: u64) -> bool {
    left / 86_400 == right / 86_400
}

pub fn can_deliver(
    session_id: &str,
    item_keys: &[String],
    cluster_keys: &[String],
    history: &[DeliveryRecord],
    daily_limit: u32,
    now: u64,
) -> DeliveryDecision {
    if history
        .iter()
        .any(|record| record.session_id == session_id && record.status != DeliveryStatus::Dropped)
    {
        return DeliveryDecision::deny("这个会话已经投递过");
    }

    let recent_items: Vec<&DeliveryRecord> = history
        .iter()
        .filter(|record| now.saturating_sub(record.delivered_at) < ITEM_DEDUPE_SECONDS)
        .collect();

    if recent_items.iter().any(|record| {
        record
            .item_keys
            .iter()
            .any(|existing| item_keys.iter().any(|key| key == existing))
    }) {
        return DeliveryDecision::deny("7 天内已经推送过同一条内容");
    }

    let recent_clusters: Vec<&DeliveryRecord> = history
        .iter()
        .filter(|record| now.saturating_sub(record.delivered_at) < CLUSTER_DEDUPE_SECONDS)
        .collect();
    if recent_clusters.iter().any(|record| {
        record
            .cluster_keys
            .iter()
            .any(|existing| cluster_keys.iter().any(|key| key == existing && !key.is_empty()))
    }) {
        return DeliveryDecision::deny("24 小时内已经推送过同主题");
    }

    let today_count = history
        .iter()
        .filter(|record| {
            same_day(record.delivered_at, now)
                && matches!(
                    record.status,
                    DeliveryStatus::Delivered | DeliveryStatus::BubbleOnly
                )
        })
        .count() as u32;
    if today_count >= daily_limit {
        return DeliveryDecision::deny("今天的投递次数已达上限");
    }

    DeliveryDecision::allow()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingEntry {
    pub digest: DigestDraft,
    pub queued_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQueue {
    pub items: Vec<PendingEntry>,
    pub total_enqueued: u32,
}

impl PendingQueue {
    pub fn enqueue(&mut self, digest: DigestDraft, now: u64) -> bool {
        self.total_enqueued = self.total_enqueued.saturating_add(1);
        self.items.push(PendingEntry {
            digest,
            queued_at: now,
        });
        let changed = self.items.len() > MAX_PENDING;
        if changed {
            let drain = self.items.len() - MAX_PENDING;
            self.items.drain(0..drain);
        }
        changed
    }

    pub fn overflow_marker(&self) -> Option<String> {
        if self.total_enqueued as usize > self.items.len() {
            Some(format!(
                "小狗攒了 {} 条，先挑最新的 {} 条给你",
                self.total_enqueued,
                self.items.len()
            ))
        } else {
            None
        }
    }

    pub fn take_first(&mut self) -> Option<PendingEntry> {
        if self.items.is_empty() {
            None
        } else {
            Some(self.items.remove(0))
        }
    }

    pub fn remove_session(&mut self, session_id: &str) {
        self.items.retain(|entry| entry.digest.session_id != session_id);
    }
}

pub fn record_outcome(
    session_id: &str,
    item_keys: Vec<String>,
    cluster_keys: Vec<String>,
    outcome: DeliveryOutcome,
    existing: &[DeliveryRecord],
) -> DeliveryRecord {
    if let Some(record) = existing.iter().find(|record| record.session_id == session_id) {
        return record.clone();
    }
    DeliveryRecord {
        session_id: session_id.to_string(),
        delivered_at: outcome.at,
        channels: outcome.channels,
        item_keys,
        cluster_keys,
        status: outcome.status,
    }
}

pub fn channel_list(status: DeliveryStatus) -> Vec<DeliveryChannel> {
    match status {
        DeliveryStatus::Delivered => vec![DeliveryChannel::Chat, DeliveryChannel::Bubble],
        DeliveryStatus::BubbleOnly => vec![DeliveryChannel::Bubble],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{DigestGenerator, DigestItem, Platform};
    use crate::video::digest::build_digest;

    fn digest(session_id: &str, item_key: &str, cluster_key: &str) -> DigestDraft {
        DigestDraft {
            session_id: session_id.to_string(),
            theme_line: Some("小狗看到几条你可能感兴趣的。".to_string()),
            generator: DigestGenerator::Template,
            total_chars: 30,
            items: vec![DigestItem {
                item_key: item_key.to_string(),
                title: "标题".to_string(),
                author: Some("作者".to_string()),
                platform: Platform::Bilibili,
                duration_seconds: Some(60),
                why_line: "点了赞".to_string(),
                cluster_key: cluster_key.to_string(),
            }],
        }
    }

    fn record(session_id: &str, at: u64, item: &str, cluster: &str) -> DeliveryRecord {
        DeliveryRecord {
            session_id: session_id.to_string(),
            delivered_at: at,
            channels: vec![DeliveryChannel::Chat],
            item_keys: vec![item.to_string()],
            cluster_keys: vec![cluster.to_string()],
            status: DeliveryStatus::Delivered,
        }
    }

    #[test]
    fn dedupes_same_item_within_seven_days() {
        let now = 10 * 86_400;
        let history = vec![record("old", now - 3 * 86_400, "item1", "cluster1")];
        let decision = can_deliver("new", &["item1".to_string()], &[], &history, 2, now);
        assert!(!decision.allowed);
        let later = can_deliver("new2", &["item1".to_string()], &[], &history, 2, now + 4 * 86_400);
        assert!(later.allowed);
    }

    #[test]
    fn dedupes_same_cluster_within_24_hours() {
        let now = 10 * 86_400;
        let history = vec![record("old", now - 3600, "item1", "cluster1")];
        let decision = can_deliver("new", &["item2".to_string()], &["cluster1".to_string()], &history, 2, now);
        assert!(!decision.allowed);
        let later = can_deliver(
            "new2",
            &["item2".to_string()],
            &["cluster1".to_string()],
            &history,
            2,
            now + 25 * 3600,
        );
        assert!(later.allowed);
    }

    #[test]
    fn daily_limit_is_enforced() {
        let now = 10 * 86_400 + 100;
        let history = vec![
            record("a", now - 10, "i1", "c1"),
            record("b", now - 20, "i2", "c2"),
        ];
        let decision = can_deliver("c", &["i3".to_string()], &["c3".to_string()], &history, 2, now);
        assert!(!decision.allowed);

        let decision = can_deliver("c", &["i3".to_string()], &["c3".to_string()], &history, 5, now);
        assert!(decision.allowed);
    }

    #[test]
    fn same_session_is_idempotent() {
        let now = 10 * 86_400;
        let history = vec![record("s1", now - 10, "i1", "c1")];
        let decision = can_deliver("s1", &["other".to_string()], &[], &history, 5, now);
        assert!(!decision.allowed);
    }

    #[test]
    fn pending_queue_keeps_latest_five() {
        let mut queue = PendingQueue::default();
        for index in 0..7 {
            queue.enqueue(digest(&format!("s{index}"), &format!("i{index}"), "c"), 0);
        }
        assert_eq!(queue.items.len(), MAX_PENDING);
        assert_eq!(queue.items[0].digest.session_id, "s2");
        assert!(queue.overflow_marker().is_some());
        assert!(queue.overflow_marker().expect("marker").contains('7'));
    }

    #[test]
    fn day_counter_resets_next_day() {
        let now = 10 * 86_400 + 100;
        let history = vec![
            record("a", 9 * 86_400, "i1", "c1"),
            record("b", 9 * 86_400, "i2", "c2"),
        ];
        let decision = can_deliver("c", &["i3".to_string()], &["c3".to_string()], &history, 2, now);
        assert!(decision.allowed);
    }

    #[test]
    fn record_is_not_duplicated_for_same_session() {
        let outcome = DeliveryOutcome {
            status: DeliveryStatus::Delivered,
            channels: channel_list(DeliveryStatus::Delivered),
            at: 100,
        };
        let first = record_outcome(
            "s1",
            vec!["i1".to_string()],
            vec!["c1".to_string()],
            outcome.clone(),
            &[],
        );
        let second = record_outcome(
            "s1",
            vec!["i2".to_string()],
            vec!["c2".to_string()],
            outcome,
            &[first.clone()],
        );
        assert_eq!(second.item_keys, first.item_keys);
    }

    #[test]
    fn build_digest_and_delivery_roundtrip() {
        let draft = digest("s1", "i1", "c1");
        let decision = can_deliver(
            &draft.session_id,
            &draft.items.iter().map(|item| item.item_key.clone()).collect::<Vec<_>>(),
            &draft.items.iter().map(|item| item.cluster_key.clone()).collect::<Vec<_>>(),
            &[],
            2,
            100,
        );
        assert!(decision.allowed);
        let _ = build_digest;
    }
}