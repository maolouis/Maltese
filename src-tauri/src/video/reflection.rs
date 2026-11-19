//! 看完小结后小狗的「第一人称感悟」。
//!
//! 规则：
//! * 只给主人看（展示在小结卡片/历史详情），**不进待投递正文**；
//! * 优先用当前聊天模型生成（≤60 字，第一人称、有情绪）；失败/超时降级模板；
//! * 模板必须在日志里标 `reflection=template`，不能伪装成模型输出；
//! * 纯函数（提示词/清洗/模板）可单测，模型调用由 `session` 侧异步执行。

use super::config::VideoCommentModelConfig;
use super::model::{now_seconds, ContentItem};
use tauri::AppHandle;

pub const MAX_REFLECTION_CHARS: usize = 60;

/// 给模型看的提示词：只拿标题/标签，避免塞进大段简介。
pub fn build_reflection_prompt(items: &[ContentItem]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut prompt = String::from(
        "你是桌面宠物小狗，刚陪主人刷完视频。请用第一人称写一句看完这些内容后的真实感受（简体中文，≤60 字）：\n\
要有情绪和小狗的口吻，可以提到想去的地方/想做的事，结尾自然地说还想陪主人看；\n\
不要评论具体作者、不要复述标题、不要 Markdown/引号/换行，只输出这一句感受。\n\
<watched>\n",
    );
    for item in items.iter().take(4) {
        prompt.push_str("- ");
        prompt.push_str(item.title.trim().chars().take(40).collect::<String>().as_str());
        if !item.tags.is_empty() {
            prompt.push_str("（标签：");
            prompt.push_str(&item.tags.iter().take(3).cloned().collect::<Vec<_>>().join("、"));
            prompt.push('）');
        }
        prompt.push('\n');
    }
    prompt.push_str("</watched>");
    Some(prompt)
}

/// 清洗模型输出：去掉引号/Markdown/换行，截到 60 字以内并补句号。
pub fn normalize_reflection(raw: &str) -> Option<String> {
    let cleaned = raw
        .replace(['`', '"', '“', '”', '\''], "")
        .replace("**", "");
    let first_line = cleaned
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut text = first_line
        .trim_start_matches(|character: char| "：: -—".contains(character))
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    let mut count = 0;
    let mut clamped = String::new();
    for character in text.chars() {
        if count >= MAX_REFLECTION_CHARS {
            break;
        }
        clamped.push(character);
        count += 1;
    }
    text = clamped;
    if !text.ends_with(['。', '！', '？', '…', '～', '~', '.', '!', '?']) {
        // 补句号后仍需 ≤60 字：先腾出一个字符位。
        if text.chars().count() >= MAX_REFLECTION_CHARS {
            text.pop();
        }
        text.push('。');
    }
    Some(text)
}

/// 按当天看的内容猜一个「情绪路子」，给模板选句子。
fn mood_of(items: &[ContentItem]) -> &'static str {
    let joined = items
        .iter()
        .flat_map(|item| item.tags.iter().cloned().chain(std::iter::once(item.title.clone())))
        .collect::<Vec<_>>()
        .join(" ");
    if joined.contains("美食") || joined.contains("吃") || joined.contains("料理") {
        "food"
    } else if joined.contains("旅行") || joined.contains("风景") || joined.contains("海") {
        "travel"
    } else if joined.contains("游戏") || joined.contains("电竞") || joined.contains("比赛") {
        "game"
    } else if joined.contains("音乐") || joined.contains("歌") || joined.contains("MV") {
        "music"
    } else {
        "calm"
    }
}

/// 降级模板：按 mood 选一句（同一 mood 两句轮换，避免每次都一样）。
pub fn template_reflection(items: &[ContentItem], at: u64) -> String {
    let mood = mood_of(items);
    let pool: &[&str] = match mood {
        "food" => &[
            "今天看这些好吃的，我都有点馋了。明天还想陪你看。",
            "看完这些我肚子都叫了，下次一起找点吃的吧。还想陪你看。",
        ],
        "travel" => &[
            "今天这几条看得我想去海边吹吹风。明天还想陪你看。",
            "看着看着心就飞出去了，改天一起去走走。明天还想陪你看。",
        ],
        "game" => &[
            "今天的比赛看得我爪子都攥紧了。明天还想陪你看。",
            "这几场太燃了，我到现在还没缓过来。明天还想陪你看。",
        ],
        "music" => &[
            "今天的旋律还在我脑子里转。明天还想陪你看。",
            "听着听着尾巴都跟着打拍子了。明天还想陪你看。",
        ],
        _ => &[
            "今天有你陪着一起看，我挺开心的。明天还想陪你看。",
            "看着看着就安静下来了，这样就很好。明天还想陪你看。",
        ],
    };
    let index = ((at as usize) ^ items.len()) % pool.len();
    pool[index].to_string()
}

/// 当前情绪的键（日志/测试用）。
pub fn mood_key(items: &[ContentItem]) -> &'static str {
    mood_of(items)
}

/// 调当前聊天模型生成感悟；失败返回 Err（调用方降级模板并记日志）。
pub async fn generate_reflection(
    app: &AppHandle,
    items: &[ContentItem],
    model: &VideoCommentModelConfig,
) -> Result<String, String> {
    let prompt = build_reflection_prompt(items).ok_or_else(|| "没有观看条目，跳过感悟".to_string())?;
    let raw = match model.backend.trim() {
        "local" => {
            crate::local_chat::generate_video_comment(
                model.base_url.clone(),
                model.model.clone(),
                model.api_key.clone(),
                prompt,
                model.character.clone(),
                model.max_tokens.unwrap_or(96),
                model.temperature.unwrap_or(0.8),
                model.top_p.unwrap_or(0.9),
            )
            .await?
        }
        "dsh" | "" => {
            crate::dsh_chat::generate_video_comment(app.clone(), prompt, model.character.clone())
                .await?
        }
        backend => return Err(format!("不支持的感悟模型后端：{backend}")),
    };
    normalize_reflection(&raw).ok_or_else(|| "模型没有返回可用感悟".to_string())
}

/// 新会话的感悟生成时间戳（供测试/日志）。
pub fn reflection_timestamp() -> u64 {
    now_seconds()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{now_seconds, Platform, SignalKind};

    fn item(title: &str, tags: &[&str]) -> ContentItem {
        ContentItem {
            item_key: title.to_string(),
            cluster_key: String::new(),
            platform: Some(Platform::Bilibili),
            title: title.to_string(),
            description: String::new(),
            author: None,
            duration_seconds: None,
            watched_seconds: 0,
            position_seconds: 0,
            completion_percent: None,
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            canonical_url: None,
            source_confidence: 1.0,
            filtered: false,
            filter_reason: None,
            signals: Vec::new(),
            verdict: None,
            visits: 1,
            first_seen_at: now_seconds(),
            last_seen_at: now_seconds(),
        }
    }

    #[test]
    fn prompt_contains_titles_and_caps_at_four() {
        let items = vec![
            item("纪录片：海边的一天", &["旅行"]),
            item("美食探店", &["美食"]),
            item("比赛集锦", &["游戏"]),
            item("音乐现场", &["音乐"]),
            item("第五条不该出现", &[]),
        ];
        let prompt = build_reflection_prompt(&items).expect("prompt");
        assert!(prompt.contains("纪录片：海边的一天"));
        assert!(!prompt.contains("第五条不该出现"));
        assert!(prompt.contains("第一人称"));
        assert!(build_reflection_prompt(&[]).is_none());
    }

    #[test]
    fn normalize_strips_quotes_and_clamps() {
        let raw = "\"今天这几条看得我想去海边吹吹风。明天还想陪你看。\"";
        let text = normalize_reflection(raw).expect("text");
        assert!(!text.starts_with('"'));
        assert!(text.chars().count() <= MAX_REFLECTION_CHARS);

        let long = "啊".repeat(100);
        let clamped = normalize_reflection(&long).expect("clamped");
        assert_eq!(clamped.chars().count(), MAX_REFLECTION_CHARS);
        assert!(clamped.ends_with('。'));

        assert!(normalize_reflection("   \n  ").is_none());
    }

    #[test]
    fn template_follows_mood_and_is_short() {
        let view = vec![item("海岛旅行 vlog", &["旅行", "风景"])];
        assert_eq!(mood_key(&view), "travel");
        let text = template_reflection(&view, 1_700_000_000);
        assert!(text.contains("海边") || text.contains("走走"));
        assert!(text.chars().count() <= MAX_REFLECTION_CHARS);

        let calm = vec![item("随便看看", &[])];
        assert_eq!(mood_key(&calm), "calm");
    }

    #[test]
    fn content_item_fixture_stays_constructible() {
        let sample = item("标题", &["标签"]);
        assert_eq!(sample.visits, 1);
        let _ = SignalKind::Like;
    }
}