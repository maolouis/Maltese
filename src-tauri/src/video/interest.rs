//! 兴趣判定：信号权重 → 通道可信度 → 双阈值 → 否决规则。

use super::model::{ContentItem, InterestLevel, InterestVerdict, SignalKind, UserProfile};
use super::profile::{is_negative, profile_matches};

pub const STRONG_THRESHOLD: i32 = 65;
pub const WEAK_THRESHOLD: i32 = 40;
pub const LONG_VIDEO_SECONDS: u64 = 1800;
pub const LONG_VIDEO_MIN_COMPLETION: u32 = 30;

const INTERACTION_SIGNALS: &[SignalKind] = &[
    SignalKind::Like,
    SignalKind::Favorite,
    SignalKind::CoinShare,
    SignalKind::CommentArea,
    SignalKind::AuthorClick,
    SignalKind::Rewatch,
    SignalKind::SeekBack,
];

fn has_signal(item: &ContentItem, kind: SignalKind) -> bool {
    item.signals.iter().any(|signal| signal.kind == kind)
}

fn has_any_interaction(item: &ContentItem) -> bool {
    INTERACTION_SIGNALS.iter().any(|kind| has_signal(item, *kind))
}

/// 把条目字段里可推导的信号补齐（只补一次，不重复计分）。
fn collect_signals(item: &ContentItem) -> Vec<(SignalKind, i32, String)> {
    let mut result: Vec<(SignalKind, i32, String)> = Vec::new();
    for signal in &item.signals {
        if result.iter().any(|(existing, _, _)| *existing == signal.kind) {
            continue;
        }
        result.push((signal.kind, signal.weight, signal.evidence.clone()));
    }
    let mut push = |kind: SignalKind, evidence: String| {
        if result.iter().any(|(existing, _, _)| *existing == kind) {
            return;
        }
        result.push((kind, kind.default_weight(), evidence));
    };

    if let Some(completion) = item.completion_percent() {
        if completion >= 90 {
            push(SignalKind::CompletionHigh, SignalKind::CompletionHigh.evidence().to_string());
        } else if completion >= 50 {
            push(SignalKind::CompletionMid, SignalKind::CompletionMid.evidence().to_string());
        }
        if completion >= 30 && item.watched_seconds >= 30 {
            push(
                SignalKind::WatchSubstantial,
                SignalKind::WatchSubstantial.evidence().to_string(),
            );
        }
    } else if item.watched_seconds >= 30 {
        push(
            SignalKind::WatchSubstantial,
            SignalKind::WatchSubstantial.evidence().to_string(),
        );
    }

    if item.visits >= 2 && item.watched_seconds >= 60 {
        push(SignalKind::Rewatch, SignalKind::Rewatch.evidence().to_string());
    }


    result
}

pub fn score(item: &ContentItem, profile: &UserProfile, confidence: f32) -> InterestVerdict {
    let confidence = confidence.clamp(0.0, 1.0);

    if is_negative(profile, &item.tags) {
        return InterestVerdict {
            raw_score: 0,
            final_score: 0,
            level: Some(InterestLevel::Blocked),
            blocked: true,
            reasons: vec!["命中不想看的标签".to_string()],
        };
    }

    let mut signals = collect_signals(item);

    if profile_matches(profile, &item.tags) >= 2 {
        signals.push((
            SignalKind::ProfileMatch,
            SignalKind::ProfileMatch.default_weight(),
            SignalKind::ProfileMatch.evidence().to_string(),
        ));
    }

    let raw: i32 = signals.iter().map(|(_, weight, _)| *weight).sum();
    let final_score = ((raw as f32) * confidence).round().clamp(0.0, 100.0) as i32;

    // 长视频挂机：看了很久但完成度低且完全没有互动，不得判为强兴趣。
    let hung_on_long_video = item
        .duration_seconds
        .is_some_and(|duration| duration >= LONG_VIDEO_SECONDS)
        && !has_any_interaction(item)
        && item.completion_percent().unwrap_or(0) < LONG_VIDEO_MIN_COMPLETION;
    if hung_on_long_video {
        return InterestVerdict {
            raw_score: raw,
            final_score,
            level: Some(InterestLevel::Discard),
            blocked: false,
            reasons: vec!["长视频挂机，没有互动".to_string()],
        };
    }

    let level = if final_score >= STRONG_THRESHOLD {
        InterestLevel::Strong
    } else if final_score >= WEAK_THRESHOLD {
        InterestLevel::Weak
    } else {
        InterestLevel::Discard
    };

    let mut positive: Vec<(SignalKind, i32, String)> = signals
        .into_iter()
        .filter(|(_, weight, _)| *weight > 0)
        .collect();
    positive.sort_by(|left, right| right.1.cmp(&left.1));
    let reasons = positive
        .iter()
        .take(2)
        .map(|(_, _, evidence)| evidence.chars().take(60).collect::<String>())
        .collect::<Vec<_>>();

    InterestVerdict {
        raw_score: raw,
        final_score,
        level: Some(level),
        blocked: false,
        reasons: if reasons.is_empty() {
            vec!["观看行为".to_string()]
        } else {
            reasons
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{InterestSignal, Platform};
    use crate::video::profile::empty_profile;

    fn item(signals: Vec<SignalKind>) -> ContentItem {
        ContentItem {
            item_key: "key".to_string(),
            platform: Some(Platform::Bilibili),
            title: "标题".to_string(),
            duration_seconds: Some(120),
            position_seconds: 0,
            watched_seconds: 0,
            completion_percent: None,
            source_confidence: 1.0,
            signals: signals
                .into_iter()
                .map(|kind| InterestSignal::new(kind, 1.0, 0))
                .collect(),
            ..ContentItem::default()
        }
    }

    #[test]
    fn each_signal_contributes_default_weight_once() {
        for kind in [
            SignalKind::Like,
            SignalKind::Favorite,
            SignalKind::CoinShare,
            SignalKind::Rewatch,
            SignalKind::SeekBack,
            SignalKind::CommentArea,
            SignalKind::AuthorClick,
        ] {
            let verdict = score(&item(vec![kind, kind, kind]), &empty_profile(), 1.0);
            assert_eq!(verdict.raw_score, kind.default_weight());
        }
    }

    #[test]
    fn confidence_scales_final_score() {
        let base = item(vec![SignalKind::Like, SignalKind::Favorite]);
        let full = score(&base, &empty_profile(), 1.0).final_score;
        let smtc = score(&base, &empty_profile(), 0.6).final_score;
        let title = score(&base, &empty_profile(), 0.3).final_score;
        assert_eq!(full, 55);
        assert_eq!(smtc, 33);
        assert_eq!(title, 17);
    }

    #[test]
    fn threshold_boundaries() {
        let mut weak = item(vec![SignalKind::Like, SignalKind::Favorite]);
        weak.signals.push(InterestSignal {
            kind: SignalKind::CommentArea,
            weight: 9,
            evidence: "在评论区停留".to_string(),
            confidence: 1.0,
            occurred_at: 0,
        });
        let verdict = score(&weak, &empty_profile(), 1.0);
        assert_eq!(verdict.final_score, 64);
        assert_eq!(verdict.level, Some(InterestLevel::Weak));

        weak.signals[2].weight = 10;
        let verdict = score(&weak, &empty_profile(), 1.0);
        assert_eq!(verdict.final_score, 65);
        assert_eq!(verdict.level, Some(InterestLevel::Strong));
    }

    #[test]
    fn negative_tag_blocks_even_with_like() {
        let mut profile = empty_profile();
        profile.negative_tags.push("asmr".to_string());
        let mut target = item(vec![SignalKind::Like, SignalKind::Favorite]);
        target.tags = vec!["ASMR".to_string()];
        let verdict = score(&target, &profile, 1.0);
        assert!(verdict.blocked);
        assert_eq!(verdict.level, Some(InterestLevel::Blocked));
    }

    #[test]
    fn long_video_idle_is_vetoed() {
        let mut target = item(vec![]);
        target.duration_seconds = Some(3600);
        target.watched_seconds = 600;
        target.position_seconds = 600;
        target.completion_percent = Some(16);
        let verdict = score(&target, &empty_profile(), 1.0);
        assert_eq!(verdict.level, Some(InterestLevel::Discard));
    }

    #[test]
    fn unknown_duration_skips_completion_weights() {
        let mut target = item(vec![]);
        target.duration_seconds = None;
        target.watched_seconds = 20;
        target.position_seconds = 20;
        target.completion_percent = None;
        let verdict = score(&target, &empty_profile(), 1.0);
        assert_eq!(verdict.raw_score, 0);
    }

    #[test]
    fn reasons_have_at_most_two_entries() {
        let target = item(vec![
            SignalKind::Like,
            SignalKind::Favorite,
            SignalKind::CoinShare,
            SignalKind::CommentArea,
        ]);
        let verdict = score(&target, &empty_profile(), 1.0);
        assert!(!verdict.reasons.is_empty());
        assert!(verdict.reasons.len() <= 2);
        assert!(verdict.reasons.iter().all(|reason| !reason.is_empty()));
    }

    #[test]
    fn profile_match_adds_bonus() {
        let mut profile = empty_profile();
        profile.positive_tags.push("rust".to_string());
        profile.positive_tags.push("编程".to_string());
        let mut target = item(vec![]);
        target.tags = vec!["Rust".to_string(), "编程".to_string()];
        let verdict = score(&target, &profile, 1.0);
        assert!(verdict.raw_score >= SignalKind::ProfileMatch.default_weight());
    }
}