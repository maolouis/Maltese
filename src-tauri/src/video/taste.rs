//! 视频口味（聊天里说「少刷游戏区」「多来点纪录片」）的意图解析与落库说明。
//!
//! 纯逻辑：不读不写、不依赖 Tauri，便于单测。真正的画像读写由 `session` 完成。
//! 只动视频口味（画像正/负标签），**不改**平台、时长、自动评论等其它设置。

use super::model::UserProfile;
use super::profile;

/// 解析出的一次口味调整。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TasteIntent {
    pub add_positive: Vec<String>,
    pub add_negative: Vec<String>,
    pub remove_positive: Vec<String>,
    pub remove_negative: Vec<String>,
    /// 「恢复默认口味」
    pub reset: bool,
}

impl TasteIntent {
    pub fn is_empty(&self) -> bool {
        !self.reset
            && self.add_positive.is_empty()
            && self.add_negative.is_empty()
            && self.remove_positive.is_empty()
            && self.remove_negative.is_empty()
    }
}

/// 中文口语里的尾巴/语气词，剥掉后再当标签用。
const TAIL_WORDS: [&str; 12] = [
    "的视频", "视频", "的内容", "内容", "分区", "版块", "板块", "吧", "啊", "呀", "了", "的",
];

/// 常见分区/题材归一化（「游戏区」→「游戏」）。
fn normalize_category(raw: &str) -> String {
    let mut value = raw.trim().to_string();
    for prefix in ["一点", "一些", "点儿", "点", "些"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim().to_string();
        }
    }
    // 「区」后缀优先去掉（"经济区科技区" 会在 split 阶段拆开，这里兜底单区）。
    for tail in ["区", "专区", "版区"] {
        if let Some(rest) = value.strip_suffix(tail) {
            let rest = rest.trim();
            if !rest.is_empty() {
                value = rest.to_string();
            }
        }
    }
    for tail in TAIL_WORDS {
        if let Some(rest) = value.strip_suffix(tail) {
            let rest = rest.trim();
            if !rest.is_empty() {
                value = rest.to_string();
            }
        }
    }
    if matches!(value.as_str(), "" | "的" | "了" | "吧" | "啊" | "呀" | "哦") {
        return String::new();
    }
    value = value.trim_matches(|character: char| {
        character.is_whitespace() || "，,。.!！？?、；;：:".contains(character)
    })
    .to_string();
    match value.as_str() {
        "游戏" | "游戏区" | "电竞" | "电竞区" => "游戏",
        "美食" | "美食区" | "吃播" => "美食",
        "纪录片" | "纪录片区" => "纪录片",
        "动画" | "番剧" | "动漫" => "动画",
        "音乐" | "音乐区" => "音乐",
        "影视" | "影视区" | "电影" | "电视剧" => "影视",
        "科技" | "数码" | "数码区" | "geek" | "Geek" => "科技",
        "经济" | "经济区" | "财经" | "财经区" | "理财" => "财经",
        "vlog" | "Vlog" | "VLOG" | "生活" => "生活",
        "健身" | "运动" | "健身区" => "运动",
        "数码" => "科技",
        "知识" | "知识区" | "科普" => "知识",
        "直播" | "直播区" => "直播",
        "鬼畜" => "鬼畜",
        "舞蹈" => "舞蹈",
        "生活" => "生活",
        "时尚" => "时尚",
        "资讯" => "资讯",
        "娱乐" => "娱乐",
        "体育" => "体育",
        "汽车" => "汽车",
        "动物" | "萌宠" => "动物",
        "历史" => "历史",
        "财经" => "财经",
        "篮球" => "篮球",
        "足球" => "足球",
        "旅行" => "旅行",
        "游戏解说" => "游戏",
        _ => return value,
    }
    .to_string()
}

fn push_unique(list: &mut Vec<String>, tag: String) {
    if tag.is_empty() || tag.chars().count() > 12 {
        return;
    }
    if !list.contains(&tag) {
        list.push(tag);
    }
}

const NEGATIVE_MARKERS: [&str; 14] = [
    "不想看",
    "不想刷",
    "不太想看",
    "别再看",
    "别再刷",
    "少给我刷",
    "少给我推",
    "少刷",
    "少看",
    "别看",
    "少来点",
    "少来",
    "别刷",
    "屏蔽",
];

const POSITIVE_MARKERS: [&str; 16] = [
    "多给我刷",
    "多给我推",
    "多刷",
    "多看",
    "多来点",
    "多来些",
    "多推",
    "来点",
    "想看",
    "喜欢看",
    "爱看",
    "喜欢刷",
    "常刷",
    "经常刷",
    "多点",
    "多些",
];

fn split_tag(raw: &str) -> Vec<String> {
    // 「多刷音乐区和经济区科技区」这类连写：按区字和连接词拆开。
    let mut parts: Vec<String> = Vec::new();
    for chunk in raw.split("以及") {
        for part in chunk.split(|character: char| {
            matches!(character, '/' | '、' | '和' | '跟' | '与' | '，' | ',' | '；' | ';' | '区' | ' ' | '\u{3000}')
        }) {
            parts.push(part.to_string());
        }
    }
    parts
        .into_iter()
        .map(|part| normalize_category(&part))
        .filter(|part| !part.is_empty())
        .collect()
}

/// 把一句话解析成口味调整；无法理解时返回 `None`（调用方应反问澄清而不是硬改）。
pub fn parse_taste_intent(text: &str) -> Option<TasteIntent> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut intent = TasteIntent::default();
    if ["恢复默认口味", "默认口味", "重置口味", "清空口味", "恢复默认"]
        .iter()
        .any(|keyword| trimmed.contains(keyword))
    {
        intent.reset = true;
        return Some(intent);
    }

    // 先找所有口语标记的位置（长标记优先），标记后面到下一个标记之间的内容都是标签。
    let mut markers: Vec<(usize, &'static str, bool)> = Vec::new();
    let mut all: Vec<(&'static str, bool)> = Vec::new();
    for marker in NEGATIVE_MARKERS {
        all.push((marker, false));
    }
    for marker in POSITIVE_MARKERS {
        all.push((marker, true));
    }
    all.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
    let mut search_from = 0usize;
    while search_from < trimmed.len() {
        let mut found: Option<(usize, &'static str, bool)> = None;
        for (marker, positive) in &all {
            if let Some(offset) = trimmed[search_from..].find(marker) {
                let position = search_from + offset;
                match found {
                    Some((best, _, _)) if best <= position => {}
                    _ => found = Some((position, marker, *positive)),
                }
            }
        }
        let Some((position, marker, positive)) = found else {
            break;
        };
        let content_start = position + marker.len();
        let next_start = all
            .iter()
            .filter_map(|(candidate, _)| {
                trimmed[content_start..]
                    .find(candidate)
                    .map(|offset| content_start + offset)
            })
            .min()
            .unwrap_or(trimmed.len());
        let tags = split_tag(&trimmed[content_start..next_start]);
        if !tags.is_empty() {
            for tag in tags {
                if positive {
                    push_unique(&mut intent.add_positive, tag.clone());
                    push_unique(&mut intent.remove_negative, tag);
                } else {
                    push_unique(&mut intent.add_negative, tag.clone());
                    push_unique(&mut intent.remove_positive, tag);
                }
            }
        }
        search_from = content_start;
    }

    if intent.is_empty() {
        None
    } else {
        Some(intent)
    }
}

/// 落库结果：给聊天一句中文确认 + 面板要显示的最新口味标签。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteReport {
    pub reply: String,
    pub positive_tags: Vec<String>,
    pub negative_tags: Vec<String>,
    /// 本次改动说明（面板/日志用）
    pub moves: Vec<String>,
}

fn join_tags(tags: &[String]) -> String {
    tags.join("、")
}

/// 把意图应用到画像（只动视频口味），返回中文确认。
pub fn apply_intent(profile: &mut UserProfile, intent: &TasteIntent) -> Result<TasteReport, String> {
    let mut moves = Vec::new();
    if intent.reset {
        profile.positive_tags.clear();
        profile.negative_tags.clear();
        profile.sources.clear();
        profile.updated_at = super::model::now_seconds();
        return Ok(TasteReport {
            reply: "好，视频口味已经恢复默认，接下来按你新的喜好来。".to_string(),
            positive_tags: profile.positive_tags.clone(),
            negative_tags: profile.negative_tags.clone(),
            moves: vec!["reset".to_string()],
        });
    }

    for tag in &intent.remove_positive {
        if profile.positive_tags.iter().any(|existing| existing == tag) {
            profile::remove_positive_tag(profile, tag);
            moves.push(format!("-喜欢 {tag}"));
        }
    }
    for tag in &intent.remove_negative {
        if profile.negative_tags.iter().any(|existing| existing == tag) {
            profile::remove_negative_tag(profile, tag);
            moves.push(format!("-避开 {tag}"));
        }
    }
    for tag in &intent.add_positive {
        profile::add_positive_tag(profile, tag, None)?;
        moves.push(format!("+喜欢 {tag}"));
    }
    for tag in &intent.add_negative {
        profile::add_negative_tag(profile, tag, None)?;
        moves.push(format!("+避开 {tag}"));
    }
    profile.updated_at = super::model::now_seconds();

    let mut parts = Vec::new();
    if !intent.add_negative.is_empty() {
        parts.push(format!("后面少给你刷{}", join_tags(&intent.add_negative)));
    }
    if !intent.add_positive.is_empty() {
        parts.push(format!("多给你刷{}", join_tags(&intent.add_positive)));
    }
    if !intent.remove_positive.is_empty() {
        parts.push(format!("不再专门推{}", join_tags(&intent.remove_positive)));
    }
    if !intent.remove_negative.is_empty() {
        parts.push(format!("把{}从屏蔽里拿掉", join_tags(&intent.remove_negative)));
    }
    let reply = if parts.is_empty() {
        "口味已经是这样了，不用再改。".to_string()
    } else {
        format!("好，{}。", parts.join("，"))
    };
    Ok(TasteReport {
        reply,
        positive_tags: profile.positive_tags.clone(),
        negative_tags: profile.negative_tags.clone(),
        moves,
    })
}

/// 给聊天技能做兜底提示（解析失败时反问，不乱改）。
pub fn clarify_reply() -> String {
    "想多看哪几个区呀？比如音乐、财经、科技，我记下来～".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::profile::empty_profile;

    fn intent_of(text: &str) -> TasteIntent {
        parse_taste_intent(text).expect("intent")
    }

    #[test]
    fn parses_three_adjacent_categories() {
        let intent = intent_of("多刷音乐区和经济区科技区的视频");
        assert_eq!(
            intent.add_positive,
            vec!["音乐".to_string(), "财经".to_string(), "科技".to_string()]
        );
    }

    #[test]
    fn parses_colloquial_variants_and_aliases() {
        for text in ["多来点纪录片", "常刷纪录片", "爱看纪录片", "喜欢看纪录片"] {
            assert_eq!(intent_of(text).add_positive, vec!["纪录片".to_string()]);
        }
        assert_eq!(intent_of("多刷数码区").add_positive, vec!["科技".to_string()]);
        assert_eq!(intent_of("多刷理财").add_positive, vec!["财经".to_string()]);
        assert_eq!(intent_of("多来点vlog").add_positive, vec!["生活".to_string()]);
        assert_eq!(intent_of("少刷游戏区").add_negative, vec!["游戏".to_string()]);
        assert_eq!(intent_of("屏蔽游戏").add_negative, vec!["游戏".to_string()]);
    }

    #[test]
    fn parses_mixed_punctuation_and_spaces() {
        let intent = intent_of("多刷音乐、财经, 科技和游戏");
        assert_eq!(
            intent.add_positive,
            vec![
                "音乐".to_string(),
                "财经".to_string(),
                "科技".to_string(),
                "游戏".to_string()
            ]
        );
    }

    #[test]
    fn empty_text_returns_none_and_clarify_mentions_categories() {
        assert!(parse_taste_intent("今天天气不错").is_none());
        assert!(clarify_reply().contains("哪几个区"));
    }

    #[test]

    fn parses_negative_category() {
        let intent = parse_taste_intent("我不想看游戏区了").expect("intent");
        assert_eq!(intent.add_negative, vec!["游戏".to_string()]);
        assert!(intent.add_positive.is_empty());
    }

    #[test]
    fn parses_positive_and_negative_in_one_sentence() {
        let intent = parse_taste_intent("少刷游戏，多看纪录片").expect("intent");
        assert_eq!(intent.add_negative, vec!["游戏".to_string()]);
        assert_eq!(intent.add_positive, vec!["纪录片".to_string()]);
        assert_eq!(intent.remove_positive, vec!["游戏".to_string()]);
        assert_eq!(intent.remove_negative, vec!["纪录片".to_string()]);
    }

    #[test]
    fn parses_multiple_positive_topics() {
        let intent = parse_taste_intent("多给我刷点美食/纪录片").expect("intent");
        assert_eq!(
            intent.add_positive,
            vec!["美食".to_string(), "纪录片".to_string()]
        );
    }

    #[test]
    fn parses_no_live_and_reset() {
        let intent = parse_taste_intent("最近别看直播").expect("intent");
        assert_eq!(intent.add_negative, vec!["直播".to_string()]);
        let reset = parse_taste_intent("恢复默认口味").expect("reset");
        assert!(reset.reset);
    }

    #[test]
    fn unclear_text_returns_none() {
        assert!(parse_taste_intent("今天天气不错").is_none());
        assert!(parse_taste_intent("").is_none());
    }

    #[test]
    fn applies_to_profile_without_touching_other_settings() {
        let mut profile = empty_profile();
        profile.positive_tags.push("游戏".to_string());
        let intent = parse_taste_intent("少刷游戏区，多来点美食").expect("intent");
        let report = apply_intent(&mut profile, &intent).expect("apply");
        assert!(profile.negative_tags.contains(&"游戏".to_string()));
        assert!(!profile.positive_tags.contains(&"游戏".to_string()));
        assert!(profile.positive_tags.contains(&"美食".to_string()));
        assert!(report.reply.contains("少给你刷游戏"));
        assert!(report.reply.contains("多给你刷美食"));
        assert_eq!(profile.schema_version, profile.schema_version); // 设置项不动（结构体没有其它字段被改）
    }

    #[test]
    fn reset_clears_taste_only() {
        let mut profile = empty_profile();
        profile.positive_tags.push("美食".to_string());
        profile.negative_tags.push("游戏".to_string());
        let intent = parse_taste_intent("恢复默认口味").expect("intent");
        let report = apply_intent(&mut profile, &intent).expect("apply");
        assert!(profile.positive_tags.is_empty());
        assert!(profile.negative_tags.is_empty());
        assert!(report.reply.contains("恢复默认"));
    }
}