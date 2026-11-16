//! 整理：把强兴趣条目聚类成一份不超过 5 条、300 字的小结。

use super::model::{
    ContentItem, DigestDraft, DigestGenerator, DigestItem, InterestLevel, Platform,
};
use super::profile::normalize_tag;
use std::collections::HashSet;

pub const MAX_ITEMS: usize = 5;
pub const MAX_PER_CLUSTER: usize = 2;
pub const MAX_WHY_CHARS: usize = 40;
pub const MAX_THEME_CHARS: usize = 60;
pub const MAX_TOTAL_CHARS: usize = 300;
pub const MIN_CLUSTER_JACCARD: f32 = 0.3;

struct Cluster {
    key: String,
    items: Vec<ContentItem>,
}

fn tags(item: &ContentItem) -> HashSet<String> {
    item.tags.iter().map(|tag| normalize_tag(tag)).collect()
}

fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f32 {
    if left.is_empty() && right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count() as f32;
    let union = left.union(right).count() as f32;
    if union == 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn should_merge(existing: &ContentItem, candidate: &ContentItem) -> bool {
    let same_author = match (existing.author.as_deref(), candidate.author.as_deref()) {
        (Some(left), Some(right)) => normalize_tag(left) == normalize_tag(right),
        _ => false,
    };
    same_author || jaccard(&tags(existing), &tags(candidate)) >= MIN_CLUSTER_JACCARD
}

fn final_score(item: &ContentItem) -> i32 {
    item.verdict.as_ref().map(|verdict| verdict.final_score).unwrap_or(0)
}

fn cluster_items(items: &[ContentItem]) -> Vec<Cluster> {
    let mut clusters: Vec<Cluster> = Vec::new();
    for item in items {
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            cluster.items.iter().any(|existing| should_merge(existing, item))
        }) {
            cluster.items.push(item.clone());
        } else {
            clusters.push(Cluster {
                key: item.cluster_key.clone(),
                items: vec![item.clone()],
            });
        }
    }
    for cluster in &mut clusters {
        cluster.items.sort_by(|left, right| final_score(right).cmp(&final_score(left)));
    }
    clusters
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn why_line(item: &ContentItem) -> String {
    let reasons = item
        .verdict
        .as_ref()
        .map(|verdict| verdict.reasons.clone())
        .unwrap_or_default();
    let joined = reasons.join("、");
    if joined.is_empty() {
        truncate_chars(&format!("《{}》", item.title), MAX_WHY_CHARS)
    } else {
        truncate_chars(&joined, MAX_WHY_CHARS)
    }
}

fn to_digest_item(item: &ContentItem, platform: Platform) -> DigestItem {
    DigestItem {
        item_key: item.item_key.clone(),
        title: truncate_chars(&item.title, 80),
        author: item.author.clone(),
        platform,
        duration_seconds: item.duration_seconds,
        why_line: why_line(item),
        cluster_key: item.cluster_key.clone(),
    }
}

/// 只有强兴趣才会产出小结；弱兴趣只在同簇累计 ≥3 时补位。
pub fn build_digest(
    session_id: &str,
    platform: Platform,
    strong: &[ContentItem],
    weak: &[ContentItem],
    limit: usize,
) -> Option<DigestDraft> {
    let strong: Vec<ContentItem> = strong
        .iter()
        .filter(|item| {
            !item.filtered
                && item
                    .verdict
                    .as_ref()
                    .and_then(|verdict| verdict.level)
                    == Some(InterestLevel::Strong)
        })
        .cloned()
        .collect();
    if strong.is_empty() {
        return None;
    }

    let limit = limit.clamp(1, MAX_ITEMS);
    let mut chosen: Vec<DigestItem> = Vec::new();
    for cluster in cluster_items(&strong) {
        for item in cluster.items.iter().take(MAX_PER_CLUSTER) {
            if chosen.len() >= limit {
                break;
            }
            chosen.push(to_digest_item(item, platform));
        }
        if chosen.len() >= limit {
            break;
        }
    }

    if chosen.len() < limit {
        for cluster in cluster_items(weak) {
            if cluster.items.len() < 3 {
                continue;
            }
            if chosen.len() >= limit {
                break;
            }
            let best = &cluster.items[0];
            if chosen.iter().any(|existing| existing.item_key == best.item_key) {
                continue;
            }
            chosen.push(to_digest_item(best, platform));
        }
    }

    if chosen.is_empty() {
        return None;
    }

    let theme_line = Some(truncate_chars(
        &format!("小狗刷到 {} 条你可能感兴趣的，都是这阵子的同款口味。", chosen.len()),
        MAX_THEME_CHARS,
    ));

    let mut draft = DigestDraft {
        session_id: session_id.to_string(),
        theme_line,
        generator: DigestGenerator::Template,
        items: chosen,
        total_chars: 0,
    };
    draft.total_chars = total_chars(&draft);
    Some(draft)
}

fn sentence_boundary(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut result = String::new();
    let mut count = 0usize;
    for character in value.chars() {
        if count >= limit {
            break;
        }
        result.push(character);
        count += 1;
        if matches!(character, '。' | '！' | '？' | '；' | '.' | '!' | '?') {
            break;
        }
    }
    if !result.chars().last().is_some_and(|last| {
        matches!(last, '。' | '！' | '？' | '；' | '.' | '!' | '?' | '…')
    }) {
        if let Some(position) = result.rfind(|character: char| {
            matches!(character, '。' | '！' | '？' | '；' | '.' | '!' | '?')
        }) {
            result.truncate(position + 1);
        }
    }
    result
}

pub fn total_chars(draft: &DigestDraft) -> u32 {
    let mut value = draft.theme_line.clone().unwrap_or_default();
    for item in &draft.items {
        value.push_str(&item.title);
        value.push_str(&item.why_line);
    }
    value.chars().count() as u32
}

pub fn render_text(draft: &DigestDraft) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(theme) = draft.theme_line.as_deref() {
        lines.push(sentence_boundary(theme, MAX_THEME_CHARS));
    }
    for item in &draft.items {
        lines.push(format!(
            "· 《{}》：{}",
            sentence_boundary(&item.title, 80),
            sentence_boundary(&item.why_line, MAX_WHY_CHARS)
        ));
    }
    sentence_boundary(&lines.join("\n"), MAX_TOTAL_CHARS)
}

fn looks_unsafe(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("http")
        || lower.contains("www.")
        || lower.contains("加微信")
        || lower.contains("扫码")
        || lower.contains("充值")
}

/// 模型可用时替换主题句；任何不合规都回退模板。
pub fn apply_model_summary(draft: &mut DigestDraft, model_text: Option<&str>) {
    let Some(text) = model_text else {
        return;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_THEME_CHARS || looks_unsafe(trimmed) {
        return;
    }
    draft.theme_line = Some(trimmed.to_string());
    draft.generator = DigestGenerator::Model;
    draft.total_chars = total_chars(draft);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{InterestSignal, InterestVerdict, SignalKind};

    fn item(key: &str, author: &str, tags: &[&str], score: i32) -> ContentItem {
        ContentItem {
            item_key: key.to_string(),
            platform: Some(Platform::Bilibili),
            title: format!("视频{key}"),
            author: Some(author.to_string()),
            duration_seconds: Some(120),
            watched_seconds: 60,
            completion_percent: Some(60),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            cluster_key: format!("cluster-{author}"),
            verdict: Some(InterestVerdict {
                raw_score: score,
                final_score: score,
                level: Some(InterestLevel::Strong),
                blocked: false,
                reasons: vec!["点了赞".to_string()],
            }),
            signals: vec![InterestSignal::new(SignalKind::Like, 1.0, 0)],
            ..ContentItem::default()
        }
    }

    #[test]
    fn same_author_is_limited_to_two_items() {
        let strong: Vec<ContentItem> = (0..5)
            .map(|index| item(&format!("k{index}"), "同一作者", &[], 80))
            .collect();
        let draft = build_digest("s1", Platform::Bilibili, &strong, &[], 5).expect("draft");
        assert_eq!(draft.items.len(), 2);
    }

    #[test]
    fn jaccard_boundary_merges_at_point_three() {
        let left = item("a", "作者A", &["x", "y", "z"], 80);
        let mut right = item("b", "作者B", &["x", "y", "w"], 80);
        assert!(jaccard(&tags(&left), &tags(&right)) >= 0.3);
        right.cluster_key = "other".to_string();
        let draft = build_digest(
            "s1",
            Platform::Bilibili,
            &[left.clone(), right],
            &[],
            5,
        )
        .expect("draft");
        assert!(draft.items.len() <= 2);

        let low = item("c", "作者C", &["x", "y", "z", "q"], 80);
        let mut lower = item("d", "作者D", &["x", "w", "v", "u"], 80);
        lower.cluster_key = "other2".to_string();
        assert!(jaccard(&tags(&low), &tags(&lower)) < 0.3);
    }

    #[test]
    fn total_items_never_exceed_five() {
        let strong: Vec<ContentItem> = (0..10)
            .map(|index| item(&format!("k{index}"), &format!("作者{index}"), &[], 80))
            .collect();
        let draft = build_digest("s1", Platform::Bilibili, &strong, &[], 5).expect("draft");
        assert!(draft.items.len() <= MAX_ITEMS);
        assert!(draft.items.len() >= 1);
    }

    #[test]
    fn why_line_is_short_and_non_empty() {
        let long_reason = "很长的理由".repeat(20);
        let mut target = item("k", "作者", &[], 80);
        target.verdict.as_mut().expect("verdict").reasons = vec![long_reason];
        let draft = build_digest("s1", Platform::Bilibili, &[target], &[], 5).expect("draft");
        let why = &draft.items[0].why_line;
        assert!(!why.is_empty());
        assert!(why.chars().count() <= MAX_WHY_CHARS);
    }

    #[test]
    fn total_text_is_at_most_300_chars() {
        let strong: Vec<ContentItem> = (0..5)
            .map(|index| {
                let mut value = item(&format!("k{index}"), &format!("作者{index}"), &[], 80);
                value.title = "很长的标题".repeat(30);
                value
            })
            .collect();
        let draft = build_digest("s1", Platform::Bilibili, &strong, &[], 5).expect("draft");
        let text = render_text(&draft);
        assert!(text.chars().count() <= MAX_TOTAL_CHARS);
        assert!(text.chars().last().is_some());
    }

    #[test]
    fn no_strong_interest_returns_none() {
        let weak = item("k", "作者", &[], 50);
        assert!(build_digest("s1", Platform::Bilibili, &[], &[weak], 5).is_none());
    }

    #[test]
    fn model_text_falls_back_when_unsafe() {
        let strong = vec![item("k", "作者", &[], 80)];
        let mut draft = build_digest("s1", Platform::Bilibili, &strong, &[], 5).expect("draft");
        let template = draft.theme_line.clone();
        apply_model_summary(&mut draft, Some("看这里 https://evil.com"));
        assert_eq!(draft.generator, DigestGenerator::Template);
        assert_eq!(draft.theme_line, template);

        apply_model_summary(&mut draft, Some("这些内容挺合你口味的。"));
        assert_eq!(draft.generator, DigestGenerator::Model);
    }

    #[test]
    fn sentence_boundary_does_not_cut_half_sentence() {
        let value = "第一句话。第二句话。第三句话。";
        let cut = sentence_boundary(value, 8);
        assert_eq!(cut, "第一句话。");
    }

    #[test]
    fn weak_clusters_only_fill_when_three_or_more() {
        let strong = vec![item("s", "强作者", &[], 80)];
        let weak: Vec<ContentItem> = (0..3)
            .map(|index| {
                let mut value = item(&format!("w{index}"), "弱作者", &["共同标签"], 50);
                value.verdict.as_mut().expect("verdict").level = Some(InterestLevel::Weak);
                value
            })
            .collect();
        let draft = build_digest("s1", Platform::Bilibili, &strong, &weak, 5).expect("draft");
        assert!(draft.items.len() >= 2);
    }
}