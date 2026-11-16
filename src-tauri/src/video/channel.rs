//! 通道治理：固定降级链、失败阈值、能力损失文案与单周期单通道作答。

use super::model::{Capability, ChannelState, ChannelType, FailureReason};
use super::rules::channel_chain;

pub const DEGRADE_AFTER_FAILURES: u32 = 3;
pub const UNSTABLE_AFTER_RECONNECTS: u32 = 5;
pub const MAX_RECOVERY_PROBES: u32 = 3;
pub const RECOVERY_INTERVAL_SECONDS: u64 = 300;
pub const PROBE_BUDGET_SECONDS: u64 = 15;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelAction {
    Keep,
    Degrade,
    Pause,
    Stop,
}

pub struct ChannelManager {
    states: Vec<ChannelState>,
    active: usize,
    failures: u32,
    reconnects: u32,
    recovery_probes: u32,
    last_recovery_probe: u64,
    last_answer_at: u64,
    sample_interval: u64,
}

impl Default for ChannelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelManager {
    pub fn new() -> Self {
        let states = channel_chain()
            .iter()
            .map(|channel| ChannelState::for_type(*channel))
            .collect();
        Self {
            states,
            active: 0,
            failures: 0,
            reconnects: 0,
            recovery_probes: 0,
            last_recovery_probe: 0,
            last_answer_at: 0,
            sample_interval: 2,
        }
    }

    pub fn active(&self) -> ChannelState {
        self.states
            .get(self.active)
            .cloned()
            .unwrap_or_else(ChannelState::default)
    }

    pub fn active_type(&self) -> ChannelType {
        self.active().channel_type
    }

    pub fn capability(&self) -> Capability {
        self.active().capability
    }

    pub fn sample_interval(&self) -> u64 {
        self.sample_interval
    }

    pub fn set_sample_interval(&mut self, seconds: u64) {
        self.sample_interval = seconds.max(1);
    }

    pub fn states(&self) -> &[ChannelState] {
        &self.states
    }

    pub fn record_success(&mut self, now: u64) {
        self.failures = 0;
        if let Some(state) = self.states.get_mut(self.active) {
            state.last_success_at = Some(now);
            state.failure_reason = None;
        }
    }

    pub fn record_failure(&mut self, reason: FailureReason, now: u64) -> ChannelAction {
        if let Some(state) = self.states.get_mut(self.active) {
            state.failure_reason = Some(reason);
            state.retry_count = state.retry_count.saturating_add(1);
        }

        match reason {
            FailureReason::RiskControl => ChannelAction::Stop,
            FailureReason::LoginRequired => ChannelAction::Pause,
            FailureReason::ChannelUnstable => {
                self.reconnects = self.reconnects.saturating_add(1);
                if self.reconnects >= UNSTABLE_AFTER_RECONNECTS {
                    self.sample_interval = 5;
                }
                ChannelAction::Keep
            }
            FailureReason::ParserMismatch
            | FailureReason::ChannelTimeout
            | FailureReason::NoResponse => {
                self.failures = self.failures.saturating_add(1);
                if self.failures >= DEGRADE_AFTER_FAILURES {
                    self.degrade(now);
                    ChannelAction::Degrade
                } else {
                    ChannelAction::Keep
                }
            }
            _ => ChannelAction::Keep,
        }
    }

    fn degrade(&mut self, now: u64) {
        self.failures = 0;
        if self.active + 1 < self.states.len() {
            self.active += 1;
            if let Some(state) = self.states.get_mut(self.active) {
                state.last_success_at = Some(now);
            }
        }
    }

    /// 每 5 分钟最多探测 3 次更高通道；成功即回升。
    pub fn try_recover(&mut self, now: u64, higher_available: bool) -> bool {
        if self.active == 0 || self.recovery_probes >= MAX_RECOVERY_PROBES {
            return false;
        }
        if now.saturating_sub(self.last_recovery_probe) < RECOVERY_INTERVAL_SECONDS {
            return false;
        }
        self.last_recovery_probe = now;
        self.recovery_probes = self.recovery_probes.saturating_add(1);
        if higher_available {
            self.active = 0;
            self.failures = 0;
            true
        } else {
            false
        }
    }

    /// 同一采集周期只允许一个通道作答。
    pub fn allow_answer(&mut self, now: u64) -> bool {
        let window = self.sample_interval.max(1);
        if now.saturating_sub(self.last_answer_at) < window {
            return false;
        }
        self.last_answer_at = now;
        true
    }

    pub fn loss_text(&self) -> String {
        self.active()
            .degraded_reason
            .unwrap_or_else(|| "无损".to_string())
    }

    pub fn default_health() -> Vec<ChannelState> {
        channel_chain()
            .iter()
            .map(|channel| ChannelState::for_type(*channel))
            .collect()
    }

    pub fn record_login_pause(&mut self, now: u64) {
        self.record_failure(FailureReason::LoginRequired, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::now_seconds;

    #[test]
    fn degrades_after_three_parser_mismatches() {
        let mut manager = ChannelManager::new();
        assert_eq!(manager.active_type(), ChannelType::Cdp);
        assert_eq!(
            manager.record_failure(FailureReason::ParserMismatch, 10),
            ChannelAction::Keep
        );
        assert_eq!(
            manager.record_failure(FailureReason::ParserMismatch, 11),
            ChannelAction::Keep
        );
        assert_eq!(
            manager.record_failure(FailureReason::ParserMismatch, 12),
            ChannelAction::Degrade
        );
        assert_eq!(manager.active_type(), ChannelType::Extension);
    }

    #[test]
    fn risk_control_stops_and_login_pauses() {
        let mut manager = ChannelManager::new();
        assert_eq!(
            manager.record_failure(FailureReason::RiskControl, 10),
            ChannelAction::Stop
        );
        let mut manager = ChannelManager::new();
        assert_eq!(
            manager.record_failure(FailureReason::LoginRequired, 10),
            ChannelAction::Pause
        );
        assert_eq!(manager.active_type(), ChannelType::Cdp);
    }

    #[test]
    fn unstable_channel_downgrades_frequency_without_switching() {
        let mut manager = ChannelManager::new();
        for _ in 0..UNSTABLE_AFTER_RECONNECTS {
            manager.record_failure(FailureReason::ChannelUnstable, 10);
        }
        assert_eq!(manager.active_type(), ChannelType::Cdp);
        assert_eq!(manager.sample_interval(), 5);
    }

    #[test]
    fn recovery_is_limited_to_three_probes() {
        let mut manager = ChannelManager::new();
        manager.active = 2;
        assert!(manager.try_recover(RECOVERY_INTERVAL_SECONDS + 1, true));
        assert_eq!(manager.active_type(), ChannelType::Cdp);

        manager.active = 2;
        for index in 0..3 {
            manager.try_recover(RECOVERY_INTERVAL_SECONDS * (index + 2), false);
        }
        assert!(!manager.try_recover(RECOVERY_INTERVAL_SECONDS * 10, true));
    }

    #[test]
    fn one_answer_per_sample_window() {
        let mut manager = ChannelManager::new();
        manager.set_sample_interval(2);
        assert!(manager.allow_answer(10));
        assert!(!manager.allow_answer(11));
        assert!(manager.allow_answer(12));
    }

    #[test]
    fn weak_channels_describe_capability_loss() {
        let mut manager = ChannelManager::new();
        manager.active = 4;
        assert!(manager.loss_text().contains("只能读标题"));
        assert_eq!(manager.capability(), Capability::Basic);
    }

    #[test]
    fn success_clears_failure_reason() {
        let mut manager = ChannelManager::new();
        manager.record_failure(FailureReason::ParserMismatch, 10);
        manager.record_success(now_seconds());
        assert!(manager.active().failure_reason.is_none());
        assert_eq!(manager.failures, 0);
    }
}
