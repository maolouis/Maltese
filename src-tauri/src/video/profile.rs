//! 用户画像：正/负标签、作者偏好与来源会话。
//!
//! 纯内存逻辑；落盘由 `store` 负责。

use super::model::{now_seconds, UserProfile, SCHEMA_VERSION};
use serde::Deserialize;

pub const MAX_POSITIVE_TAGS: usize = 100;
pub const MAX_NEGATIVE_TAGS: usize = 100;
pub const MAX_AUTHORS: usize = 50;
pub const MAX_TAG_CHARS: usize = 30;

pub fn normalize_tag(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_TAG_CHARS)
        .collect::<String>()
        .to_lowercase()
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    #[serde(default)]
    pub add_positive_tags: Vec<String>,
    #[serde(default)]
    pub remove_positive_tags: Vec<String>,
    #[serde(default)]
    pub add_negative_tags: Vec<String>,
    #[serde(default)]
    pub remove_negative_tags: Vec<String>,
    #[serde(default)]
    pub add_authors: Vec<String>,
    #[serde(default)]
    pub remove_authors: Vec<String>,
}

pub fn apply_patch(profile: &mut UserProfile, patch: &ProfilePatch) -> Result<(), String> {
    for tag in &patch.add_positive_tags {
        add_positive_tag(profile, tag, None)?;
    }
    for tag in &patch.remove_positive_tags {
        remove_positive_tag(profile, tag);
    }
    for tag in &patch.add_negative_tags {
        add_negative_tag(profile, tag, None)?;
    }
    for tag in &patch.remove_negative_tags {
        remove_negative_tag(profile, tag);
    }
    for author in &patch.add_authors {
        add_author(profile, author, None)?;
    }
    for author in &patch.remove_authors {
        remove_author(profile, author);
    }
    Ok(())
}

pub fn empty_profile() -> UserProfile {
    UserProfile {
        positive_tags: Vec::new(),
        negative_tags: Vec::new(),
        preferred_authors: Vec::new(),
        sources: Vec::new(),
        updated_at: now_seconds(),
        schema_version: SCHEMA_VERSION,
    }
}

fn push_unique(list: &mut Vec<String>, value: &str, limit: usize) -> Result<(), String> {
    let normalized = normalize_tag(value);
    if normalized.is_empty() {
        return Ok(());
    }
    if list.iter().any(|existing| existing == &normalized) {
        return Ok(());
    }
    if list.len() >= limit {
        return Err("INVALID_PROFILE：画像标签已达上限。".to_string());
    }
    list.push(normalized);
    Ok(())
}

pub fn add_positive_tag(profile: &mut UserProfile, tag: &str, session_id: Option<&str>) -> Result<(), String> {
    push_unique(&mut profile.positive_tags, tag, MAX_POSITIVE_TAGS)?;
    remember_source(profile, tag, session_id);
    profile.updated_at = now_seconds();
    Ok(())
}

pub fn add_negative_tag(profile: &mut UserProfile, tag: &str, session_id: Option<&str>) -> Result<(), String> {
    push_unique(&mut profile.negative_tags, tag, MAX_NEGATIVE_TAGS)?;
    remember_source(profile, tag, session_id);
    profile.updated_at = now_seconds();
    Ok(())
}

pub fn add_author(profile: &mut UserProfile, author: &str, session_id: Option<&str>) -> Result<(), String> {
    push_unique(&mut profile.preferred_authors, author, MAX_AUTHORS)?;
    remember_source(profile, author, session_id);
    profile.updated_at = now_seconds();
    Ok(())
}

fn remember_source(profile: &mut UserProfile, tag: &str, session_id: Option<&str>) {
    let normalized = normalize_tag(tag);
    if let Some(existing) = profile.sources.iter_mut().find(|source| source.tag == normalized) {
        if let Some(session_id) = session_id {
            existing.session_id = Some(session_id.to_string());
        }
        return;
    }
    profile.sources.push(super::model::TagSource {
        tag: normalized,
        session_id: session_id.map(str::to_string),
    });
}

pub fn remove_positive_tag(profile: &mut UserProfile, tag: &str) {
    let normalized = normalize_tag(tag);
    profile.positive_tags.retain(|value| value != &normalized);
    profile.sources.retain(|source| source.tag != normalized);
    profile.updated_at = now_seconds();
}

pub fn remove_negative_tag(profile: &mut UserProfile, tag: &str) {
    let normalized = normalize_tag(tag);
    profile.negative_tags.retain(|value| value != &normalized);
    profile.updated_at = now_seconds();
}

pub fn remove_author(profile: &mut UserProfile, author: &str) {
    let normalized = normalize_tag(author);
    profile.preferred_authors.retain(|value| value != &normalized);
    profile.updated_at = now_seconds();
}

pub fn is_negative(profile: &UserProfile, tags: &[String]) -> bool {
    tags.iter().any(|tag| {
        let normalized = normalize_tag(tag);
        profile.negative_tags.iter().any(|negative| negative == &normalized)
    })
}

pub fn profile_matches(profile: &UserProfile, tags: &[String]) -> usize {
    tags.iter()
        .filter(|tag| {
            let normalized = normalize_tag(tag);
            profile.positive_tags.iter().any(|positive| positive == &normalized)
        })
        .count()
}

/// 会话结束后的画像学习：强兴趣写正向；连续快速划过同作者写负向。
pub fn learn_from_session(
    profile: &mut UserProfile,
    session_id: &str,
    strong_tags: &[String],
    strong_author: Option<&str>,
    quick_skip_authors: &[(String, u32)],
) {
    for tag in strong_tags {
        let _ = add_positive_tag(profile, tag, Some(session_id));
    }
    if let Some(author) = strong_author {
        if !author.trim().is_empty() {
            let _ = add_author(profile, author, Some(session_id));
        }
    }
    for (author, count) in quick_skip_authors {
        if *count >= 3 {
            let _ = add_negative_tag(profile, author, Some(session_id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_tags_are_normalized_and_kept_once() {
        let mut profile = empty_profile();
        add_positive_tag(&mut profile, " 机械  键盘 ", None).expect("first");
        add_positive_tag(&mut profile, "机械 键盘", None).expect("second");
        assert_eq!(profile.positive_tags, vec!["机械 键盘".to_string()]);
    }

    #[test]
    fn uppercase_tags_match_after_normalization() {
        let mut profile = empty_profile();
        add_negative_tag(&mut profile, "ASMR", None).expect("tag");
        assert!(is_negative(&profile, &["asmr".to_string()]));
    }

    #[test]
    fn removal_disables_scoring_tag() {
        let mut profile = empty_profile();
        add_positive_tag(&mut profile, "机械键盘", Some("s1")).expect("tag");
        assert_eq!(profile_matches(&profile, &["机械键盘".to_string()]), 1);
        remove_positive_tag(&mut profile, "机械键盘");
        assert_eq!(profile_matches(&profile, &["机械键盘".to_string()]), 0);
        assert!(profile.sources.is_empty());
    }

    #[test]
    fn over_limit_is_rejected_not_silently_dropped() {
        let mut profile = empty_profile();
        for index in 0..MAX_POSITIVE_TAGS {
            add_positive_tag(&mut profile, &format!("tag{index}"), None).expect("within limit");
        }
        assert!(add_positive_tag(&mut profile, "overflow", None).is_err());
    }

    #[test]
    fn author_quick_skip_enters_negative_after_three() {
        let mut profile = empty_profile();
        learn_from_session(
            &mut profile,
            "s1",
            &["tag".to_string()],
            Some("作者A"),
            &[("作者B".to_string(), 3)],
        );
        assert!(profile.negative_tags.iter().any(|tag| tag == "作者b"));
        assert!(profile.preferred_authors.iter().any(|tag| tag == "作者a"));
    }

    #[test]
    fn sources_keep_latest_session() {
        let mut profile = empty_profile();
        add_positive_tag(&mut profile, "tag", Some("s1")).expect("tag");
        add_positive_tag(&mut profile, "tag", Some("s2")).expect("tag");
        let source = profile.sources.iter().find(|source| source.tag == "tag").expect("source");
        assert_eq!(source.session_id.as_deref(), Some("s2"));
    }
}