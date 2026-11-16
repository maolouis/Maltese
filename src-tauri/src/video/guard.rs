//! 自动互动护栏：默认关闭、日限、间隔、元素校验与审计。
//!
//! 本期只提供骨架；具体点击脚本由适配器迭代，默认不启用。

use super::model::{now_seconds, SignalKind};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const LIKE_SCORE_THRESHOLD: i32 = 80;
pub const FAVORITE_SCORE_THRESHOLD: i32 = 85;
pub const MIN_INTERVAL_SECONDS: u64 = 30;
pub const MAX_AUDIT_ENTRIES: usize = 50;
pub const CLOSE_AFTER_FAILURES: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuardAction {
    Like,
    Favorite,
}

impl GuardAction {
    pub fn signal(self) -> SignalKind {
        match self {
            GuardAction::Like => SignalKind::Like,
            GuardAction::Favorite => SignalKind::Favorite,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: u64,
    pub item_key: String,
    pub action: GuardAction,
    pub result: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardDecision {
    Allowed,
    Disabled,
    BelowThreshold,
    DailyLimit,
    TooSoon,
    ElementMismatch,
}

#[derive(Clone, Debug)]
pub struct Guard {
    pub like_enabled: bool,
    pub favorite_enabled: bool,
    pub like_daily_limit: u32,
    pub favorite_daily_limit: u32,
    like_count: u32,
    favorite_count: u32,
    last_action_at: u64,
    consecutive_failures: u32,
    audit: VecDeque<AuditEntry>,
}

impl Guard {
    pub fn new(auto_like: bool, auto_favorite: bool) -> Self {
        Self {
            like_enabled: auto_like,
            favorite_enabled: auto_favorite,
            like_daily_limit: 10,
            favorite_daily_limit: 5,
            like_count: 0,
            favorite_count: 0,
            last_action_at: 0,
            consecutive_failures: 0,
            audit: VecDeque::new(),
        }
    }

    pub fn decide(
        &mut self,
        action: GuardAction,
        final_score: i32,
        now: u64,
        element_validated: bool,
    ) -> GuardDecision {
        let enabled = match action {
            GuardAction::Like => self.like_enabled,
            GuardAction::Favorite => self.favorite_enabled,
        };
        if !enabled {
            return GuardDecision::Disabled;
        }
        let threshold = match action {
            GuardAction::Like => LIKE_SCORE_THRESHOLD,
            GuardAction::Favorite => FAVORITE_SCORE_THRESHOLD,
        };
        if final_score < threshold {
            return GuardDecision::BelowThreshold;
        }
        let count = match action {
            GuardAction::Like => self.like_count,
            GuardAction::Favorite => self.favorite_count,
        };
        let limit = match action {
            GuardAction::Like => self.like_daily_limit,
            GuardAction::Favorite => self.favorite_daily_limit,
        };
        if count >= limit {
            return GuardDecision::DailyLimit;
        }
        if now.saturating_sub(self.last_action_at) < MIN_INTERVAL_SECONDS {
            return GuardDecision::TooSoon;
        }
        if !element_validated {
            return GuardDecision::ElementMismatch;
        }
        GuardDecision::Allowed
    }

    pub fn record(&mut self, action: GuardAction, success: bool, item_key: &str, now: u64) {
        if success {
            match action {
                GuardAction::Like => self.like_count = self.like_count.saturating_add(1),
                GuardAction::Favorite => {
                    self.favorite_count = self.favorite_count.saturating_add(1)
                }
            }
            self.consecutive_failures = 0;
            self.last_action_at = now;
        } else {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            if self.consecutive_failures >= CLOSE_AFTER_FAILURES {
                match action {
                    GuardAction::Like => self.like_enabled = false,
                    GuardAction::Favorite => self.favorite_enabled = false,
                }
            }
        }
        self.audit.push_back(AuditEntry {
            at: now,
            item_key: item_key.to_string(),
            action,
            result: if success { "ok" } else { "failed" }.to_string(),
        });
        while self.audit.len() > MAX_AUDIT_ENTRIES {
            self.audit.pop_front();
        }
    }

    pub fn audit(&self, limit: u32) -> Vec<AuditEntry> {
        self.audit
            .iter()
            .rev()
            .take(limit.max(1) as usize)
            .cloned()
            .collect()
    }

    pub fn reset_daily(&mut self) {
        self.like_count = 0;
        self.favorite_count = 0;
    }

    pub fn snapshot_counts(&self) -> (u32, u32) {
        (self.like_count, self.favorite_count)
    }

    pub fn default_guard() -> Self {
        Self::new(false, false)
    }

    pub fn now() -> u64 {
        now_seconds()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_guard_allows_nothing() {
        let mut guard = Guard::default_guard();
        assert_eq!(
            guard.decide(GuardAction::Like, 95, 100, true),
            GuardDecision::Disabled
        );
        assert_eq!(
            guard.decide(GuardAction::Favorite, 100, 100, true),
            GuardDecision::Disabled
        );
    }

    #[test]
    fn favorite_needs_85_but_like_needs_80() {
        let mut guard = Guard::new(true, true);
        assert_eq!(
            guard.decide(GuardAction::Favorite, 84, 100, true),
            GuardDecision::BelowThreshold
        );
        assert_eq!(
            guard.decide(GuardAction::Favorite, 85, 100, true),
            GuardDecision::Allowed
        );
        assert_eq!(
            guard.decide(GuardAction::Like, 80, 100, true),
            GuardDecision::Allowed
        );
    }

    #[test]
    fn daily_limit_blocks_eleventh_like() {
        let mut guard = Guard::new(true, false);
        for index in 0..10 {
            let now = 100 + index * 31;
            assert_eq!(
                guard.decide(GuardAction::Like, 90, now, true),
                GuardDecision::Allowed
            );
            guard.record(GuardAction::Like, true, "key", now);
        }
        assert_eq!(
            guard.decide(GuardAction::Like, 90, 500, true),
            GuardDecision::DailyLimit
        );
    }

    #[test]
    fn interval_is_at_least_thirty_seconds() {
        let mut guard = Guard::new(true, false);
        guard.record(GuardAction::Like, true, "key", 100);
        assert_eq!(
            guard.decide(GuardAction::Like, 90, 120, true),
            GuardDecision::TooSoon
        );
        assert_eq!(
            guard.decide(GuardAction::Like, 90, 130, true),
            GuardDecision::Allowed
        );
    }

    #[test]
    fn invalid_element_is_rejected() {
        let mut guard = Guard::new(true, false);
        assert_eq!(
            guard.decide(GuardAction::Like, 90, 100, false),
            GuardDecision::ElementMismatch
        );
    }

    #[test]
    fn two_failures_disable_capability() {
        let mut guard = Guard::new(true, false);
        guard.record(GuardAction::Like, false, "key", 100);
        guard.record(GuardAction::Like, false, "key", 131);
        assert_eq!(
            guard.decide(GuardAction::Like, 90, 200, true),
            GuardDecision::Disabled
        );
    }

    #[test]
    fn audit_returns_latest_fifty() {
        let mut guard = Guard::new(true, true);
        for index in 0..60 {
            guard.record(GuardAction::Like, true, &format!("k{index}"), index as u64);
        }
        let audit = guard.audit(50);
        assert_eq!(audit.len(), MAX_AUDIT_ENTRIES);
        assert_eq!(audit[0].item_key, "k59");
    }

    #[test]
    fn daily_counts_reset() {
        let mut guard = Guard::new(true, true);
        guard.record(GuardAction::Like, true, "k", 100);
        assert_eq!(guard.snapshot_counts(), (1, 0));
        guard.reset_daily();
        assert_eq!(guard.snapshot_counts(), (0, 0));
    }
}