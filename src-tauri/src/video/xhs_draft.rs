//! 小红书「模型自动编辑图文」：1–N 篇采集结果 → 标题/正文/tags/hook/cta 草稿。
//!
//! 边界（按 docs/research-xiaohongshu.md）：
//! * 只生成文案，**不下载/不转存他人图片**；配图交给小红书创作中心「文生图」；
//! * 不自动发布：最后一步由人在投稿页完成；
//! * 原创性：提示词要求「改写而非摘抄」，生成后做最长公共子串检查（≥15 字命中），
//!   命中先重写一次，仍命中则截断该段并记录 `XHS_DRAFT_SIMILARITY`；
//! * 解析失败重试 1 次，仍失败降级模板（日志 `XHS_DRAFT_FALLBACK`）。
//!
//! 纯逻辑（裁剪/模板/解析/相似度）可单测；真实模型调用见 `ModelRoute`。

use super::config::VideoCommentModelConfig;
use super::model::{now_seconds, ContentItem};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

pub const MAX_TITLE_CHARS: usize = 20;
pub const MAX_BODY_CHARS: usize = 1000;
pub const MAX_TAGS: usize = 8;
/// 连续复制原文达到这个字数就视为摘抄。
pub const SIMILARITY_MIN_CHARS: usize = 15;
/// 小狗感悟长度：60–120 字（下限只做提示，不硬截断）。
pub const MAX_DOG_TAKE_CHARS: usize = 120;
pub const MIN_DOG_TAKE_CHARS: usize = 60;
/// 选篇说明长度上限（只交代挑选，不列被丢篇目标题）。
pub const MAX_PICK_NOTE_CHARS: usize = 80;
/// 博主腔黑名单：dogTake 命中任一词就重写/降级。
pub const DOG_TAKE_BLACKLIST: [&str; 12] = [
    "总之",
    "值得一试",
    "核心在于",
    "综上所述",
    "干货",
    "码住",
    "亲测有效",
    "不容错过",
    "建议收藏",
    "划重点",
    "宝子们",
    "姐妹们",
];

/// 小红书投稿页（人工点发布；创建入口默认停在「上传视频」，需手切「上传图文」）。

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSource {
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub image_count: usize,
    pub note_type: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XhsDraft {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub sources: Vec<DraftSource>,
    /// 开头一句（模型生成；模板为空）。
    #[serde(default)]
    pub hook: String,
    /// 小狗第一人称感悟（60–120 字），独立于 cta。
    #[serde(default)]
    pub dog_take: String,
    /// 小狗口吻交代「只挑了几篇」（≤80 字；全部使用时为空）。
    #[serde(default)]
    pub pick_note: String,
    /// 结尾互动一句。
    #[serde(default)]
    pub cta: String,
    /// 用到的笔记 id（noteId），便于溯源。
    #[serde(default)]
    pub used_notes: Vec<String>,
    /// 是否命中过相似度并做了截断（true 时正文可能被改写过）。
    #[serde(default)]
    pub similar: bool,
    /// template / model
    pub generator: String,
    pub created_at: u64,
    /// 草稿目录（写盘后填）
    pub dir: String,
}

fn clamp_chars(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect::<String>()
}

/// 标题 ≤20 字；超长按 20 字截断（仍 ≤20）。
pub fn trim_title(value: &str) -> String {
    let cleaned = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['\n', '\r'], " ");
    let cleaned = clamp_chars(&cleaned, MAX_TITLE_CHARS);
    if cleaned.is_empty() {
        "小红书看笔记小记".to_string()
    } else {
        cleaned
    }
}

/// 正文 ≤1000 字（小红书上限）；保留换行，裁掉首尾空白。
pub fn trim_body(value: &str) -> String {
    let cleaned = value.replace("\r\n", "\n").trim().to_string();
    cleaned.chars().take(MAX_BODY_CHARS).collect::<String>()
}

/// 标签：补 #、去重、≤8 个、单个 ≤12 字。
pub fn sanitize_tags(values: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        // 模型偶尔把多个标签塞进一个字符串（"#羽毛球#双打#"），按 #/逗号/顿号拆开。
        for part in value.split(|ch: char| ch == '#' || ch == ',' || ch == '，' || ch == '、') {
            let tag = part.split_whitespace().collect::<Vec<_>>().join("");
            if tag.is_empty() {
                continue;
            }
            let tag = format!("#{}", clamp_chars(&tag, 12));
            if result.iter().any(|existing| existing == &tag) {
                continue;
            }
            result.push(tag);
            if result.len() >= MAX_TAGS {
                return result;
            }
        }
    }
    result
}

fn note_id_of(item: &ContentItem) -> String {
    if let Some(url) = item.canonical_url.as_deref() {
        if let Some(id) = super::queue::video_id_from_url(url) {
            return id;
        }
    }
    item.item_key.clone()
}

fn source_of(item: &ContentItem) -> DraftSource {
    DraftSource {
        title: item.title.clone(),
        author: item.author.clone(),
        url: item.canonical_url.clone().unwrap_or_default(),
        image_count: item.image_urls.len(),
        note_type: item.note_type.map(|value| value.as_str().to_string()),
    }
}

fn top_tags(items: &[ContentItem]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for item in items {
        for tag in &item.tags {
            if !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.clone());
            }
            if tags.len() >= MAX_TAGS {
                return tags;
            }
        }
    }
    tags
}

fn source_bodies(items: &[ContentItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| item.description.trim().to_string())
        .filter(|body| !body.is_empty())
        .collect()
}

/// 去掉空白后的比较串（相似度只看连续复制，不把换行/空格算进 15 字）。
fn squashed(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// 最长公共子串：返回 (长度, 子串)。O(n*m) 动态规划（正文 1000 字内可接受）。
pub fn longest_common_substring(left: &str, right: &str) -> (usize, String) {
    let left: Vec<char> = squashed(left).chars().collect();
    let right: Vec<char> = squashed(right).chars().collect();
    if left.is_empty() || right.is_empty() {
        return (0, String::new());
    }
    let mut previous = vec![0usize; right.len() + 1];
    let mut current = vec![0usize; right.len() + 1];
    let mut best = 0usize;
    let mut end = 0usize;
    for i in 1..=left.len() {
        for j in 1..=right.len() {
            if left[i - 1] == right[j - 1] {
                current[j] = previous[j - 1] + 1;
                if current[j] > best {
                    best = current[j];
                    end = i;
                }
            } else {
                current[j] = 0;
            }
        }
        std::mem::swap(&mut previous, &mut current);
        for value in current.iter_mut() {
            *value = 0;
        }
    }
    (best, left[end - best..end].iter().collect())
}

/// 与任意源笔记正文的最长公共子串是否达到阈值；返回命中的片段。
pub fn similarity_hit(body: &str, items: &[ContentItem]) -> Option<String> {
    let mut worst: Option<String> = None;
    let mut worst_len = 0usize;
    for source in source_bodies(items) {
        let (len, snippet) = longest_common_substring(body, &source);
        if len >= SIMILARITY_MIN_CHARS && len > worst_len {
            worst_len = len;
            worst = Some(snippet);
        }
    }
    worst
}

/// 截断命中的连续片段（替换为省略号），返回 (新正文, 去掉的字数)。
pub fn truncate_similarity(body: &str, snippet: &str) -> (String, usize) {
    let target = snippet.trim();
    if target.is_empty() {
        return (body.to_string(), 0);
    }
    let mut removed = 0usize;
    let mut result = body.to_string();
    while let Some(position) = result.find(target) {
        removed += target.chars().count();
        result.replace_range(position..position + target.len(), "……");
        if removed > 10_000 {
            break;
        }
    }
    (trim_body(&result), removed)
}

/// 模板草稿：只做信息整理/评论，不逐字复制原文；用于模型不可用/失败。
pub fn template_draft(items: &[ContentItem]) -> XhsDraft {
    let title = match items.first() {
        Some(first) => trim_title(&format!(
            "{}｜{} 篇笔记整理",
            trim_title(&first.title),
            items.len()
        )),
        None => trim_title("小红书看笔记小记"),
    };
    let mut body = String::new();
    if items.len() >= 2 {
        body.push_str(&format!(
            "最近刷了 {} 篇小红书笔记，把它们放在一起看，有几个共同的感受：\n\n",
            items.len()
        ));
        body.push_str("要点一：主题都围绕同一种生活方式展开，选材很贴近日常。\n");
        body.push_str("要点二：作者们的表达都偏真实体验，细节比结论更有意思。\n");
        body.push_str("要点三：适合想快速了解这类内容、又不想被广告打扰的人。\n\n");
        body.push_str("我的看法：比起单篇爆款，更值得收藏的是这些笔记里反复出现的做法和心态。\n\n");
    } else {
        body.push_str("最近看到一篇挺有意思的小红书笔记，简单记一下：\n\n");
        body.push_str("是什么：讲的是一个很具体的生活场景，信息量不小。\n");
        body.push_str("亮点：细节真实，作者把过程和感受都写出来了。\n");
        body.push_str("适合谁：想了解这类内容、或者正打算尝试的人。\n\n");
    }
    for (index, item) in items.iter().take(6).enumerate() {
        if index == 0 {
            body.push_str("参考到的笔记：\n");
        }
        body.push_str(&format!("{}. {}\n", index + 1, item.title.trim()));
    }
    body.push_str("\n配图用小红书「文生图」生成，未搬运原作者图片。");
    XhsDraft {
        title,
        body: trim_body(&body),
        tags: sanitize_tags(&top_tags(items)),
        sources: items.iter().take(9).map(source_of).collect(),
        hook: String::new(),
        dog_take: dog_take_template(items, 0),
        pick_note: String::new(),
        cta: "你会想试试吗？评论区聊聊。".to_string(),
        used_notes: items.iter().take(9).map(note_id_of).collect(),
        similar: false,
        generator: "template".to_string(),
        created_at: now_seconds(),
        dir: String::new(),
    }
}

/// 小狗感悟模板：3 条按情绪/题材轮换（模型不合格时降级）。
pub fn dog_take_template(items: &[ContentItem], variant: usize) -> String {
    let multi = items.len() >= 2;
    let mut sentences = vec![
        "看完这些我也想动起来了，明天要不要一起去试试呀？".to_string(),
        "我有点看不太懂，但是感觉好厉害，想窝在你旁边再看一会儿。".to_string(),
        "今天也学到一点点啦，想要摸摸头，明天再陪我看好不好？".to_string(),
    ];
    if multi {
        sentences.push("大家说的东西不太一样，我有点绕晕了，但还是想黏着你一起看。".to_string());
    }
    sentences[variant % sentences.len()].clone()
}

/// pickNote 模板：小狗口吻交代「只挑了几篇」，3 条按序轮换。
pub fn pick_note_template(total: usize, variant: usize) -> String {
    let sentences = [
        format!("今天看了 {total} 篇，有几篇我看得最入神，就先挑出来跟你分享啦～"),
        "有几篇我还没太看懂，先放一边啦，回头再让主人讲给我听～".to_string(),
        "我挑了几篇自己最喜欢的，其他的等下次再一起看嘛～".to_string(),
    ];
    sentences[variant % sentences.len()].clone()
}

/// pickNote 只在「输入篇数 > 使用篇数」时出现；全部使用时清空。
pub fn normalize_pick_note(
    total: usize,
    used: usize,
    value: &str,
    variant: usize,
) -> String {
    if used >= total {
        return String::new();
    }
    let text = value.trim();
    if text.is_empty() {
        pick_note_template(total, variant)
    } else {
        text.chars().take(MAX_PICK_NOTE_CHARS).collect()
    }
}

/// 未选中笔记里出现、但选中笔记里没有的关键词（用于防止 dogTake 带出被放下的内容）。
pub fn unused_topic_terms(items: &[ContentItem], used_ids: &[String]) -> Vec<String> {
    const STOP: [&str; 8] = ["视频", "笔记", "小红书", "很多人", "不知道", "内幕", "最好", "方式"];
    let terms_of = |text: &str| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for chunk in text.split(|ch: char| {
            ch.is_whitespace()
                || "｜|、，。！？!?,.:：;；()（）[]【】\"'“”#".contains(ch)
        }) {
            let chunk = chunk.trim();
            let chars: Vec<char> = chunk.chars().collect();
            let len = chars.len();
            if len < 2 || STOP.contains(&chunk) {
                continue;
            }
            if chunk.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                out.push(chunk.to_string());
                continue;
            }
            if len <= 12 {
                out.push(chunk.to_string());
            }
            // 中文长句拆 2–4 字滑窗，保证能命中「内鬼」这类话题词。
            for size in 2..=4usize {
                if len < size {
                    continue;
                }
                for start in 0..=(len - size) {
                    let term: String = chars[start..start + size].iter().collect();
                    if STOP.contains(&term.as_str()) {
                        continue;
                    }
                    out.push(term);
                }
            }
        }
        out.truncate(40);
        out
    };
    let mut used_terms: Vec<String> = Vec::new();
    for item in items {
        if used_ids.contains(&note_id_of(item)) {
            for term in terms_of(&item.title) {
                used_terms.push(term);
            }
        }
    }
    let mut unused: Vec<String> = Vec::new();
    for item in items {
        if used_ids.contains(&note_id_of(item)) {
            continue;
        }
        for term in terms_of(&item.title) {
            if used_terms.contains(&term) || unused.contains(&term) {
                continue;
            }
            unused.push(term);
        }
    }
    unused
}

/// dogTake 是否带出了未选中笔记的关键词；返回命中的词。
pub fn dog_take_mentions_unused(value: &str, terms: &[String]) -> Option<String> {
    terms
        .iter()
        .find(|term| !term.is_empty() && value.contains(term.as_str()))
        .cloned()
}

/// dogTake 风格校验：必须第一人称含「我」，且不含博主腔黑名单。
pub fn dog_take_ok(value: &str) -> bool {
    let text = value.trim();
    !text.is_empty()
        && text.contains('我')
        && !DOG_TAKE_BLACKLIST.iter().any(|word| text.contains(word))
}

/// dogTake 裁剪：≤120 字，首尾去空白。
pub fn trim_dog_take(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .trim()
        .chars()
        .take(MAX_DOG_TAKE_CHARS)
        .collect::<String>()
}

/// 模型提示词：输入 1–N 篇（标题/作者/正文截断 500 字/标签/类型/时长/点赞），
/// 输出严格 JSON；明确「改写而非摘抄，不得连续复制原文 ≥15 字」。
pub fn build_prompt(items: &[ContentItem]) -> String {
    let multi = items.len() >= 2;
    let mut prompt = format!(
        "{{\"title\":\"≤20字\",\"hook\":\"开头一句\",\"body\":\"≤1000字，含3-5个要点\",\"dogTake\":\"60-120字，小狗第一人称感悟\",\"pickNote\":\"≤80字，小狗口吻说明只挑了哪几篇（不列具体标题）\",\"cta\":\"结尾互动一句\",\"tags\":[\"#标签\"],\"usedNotes\":[\"noteId\"]}}\n\
你是小红书内容编辑，但你的身份是 Maltese 桌宠小狗（不是普通博主/编辑）。\n\
人设：{} \n\
帮主人把采集到的笔记改写成一篇原创图文文案。只输出一行 JSON，不要 Markdown/解释。\n\
硬性要求：\n\
1. 必须改写而非摘抄：不得连续复制原文 15 个字以上；用自己的话重新组织信息。\n\
2. 不编造原文没有的事实；不写“点击链接/私信我”等引流话术。\n\
3. title 不超过 20 个汉字；body 不超过 1000 字，按要点分段，写 3–5 个要点；\n\
4. 本次输入 {total_notes} 篇笔记，你可以只使用其中相关的 M 篇（M 可以少于 N），把用到的 noteId 填进 usedNotes；\n\
   若 M < N，请用小狗口吻在 pickNote（≤80 字）里交代「只挑了几篇」：可以像“今天看了 7 篇，有两篇我看得最入神，就多看了几眼～”\n\
   或“有几篇我没太看懂，先放一边啦，回头让主人讲给我听。”——**不要列出被丢下篇目的具体标题**，避免让作者不开心；若 M = N，pickNote 留空。\n\
5. dogTake 必须是小狗第一人称（要出现“我”），60–120 字：写具体小动作/小心思（想去看、想吃、想被摸头、看不太懂但觉得厉害），\n\
   口语化、短句、偶尔叠词；**不允许**说教、总结金句、鸡汤、行业黑话或博主腔（如“总之/值得一试/核心在于/综上所述/干货/码住”）。\n\
6. cta 也要小狗口吻的互动提问（例如“你们练球的时候都在想什么呀～”），不要“欢迎评论区留言”这种博主腔。\n\
7. 正文顺序：hook（开头一句）→ body（3–5 个要点）→ dogTake（小狗感悟）→ cta（互动）；dogTake 与 cta 不要写进 body 里。\n\
8. tags 3–8 个，带 # 前缀；usedNotes 填实际参考到的 noteId。\n\
9. dogTake 只围绕被选中的笔记写，不要提起被放下的内容（连话题都不要带，例如不要出现
   “PyTorch”“内鬼”这类只出现在未选中笔记里的词）；pickNote 可以笼统说“有几篇没看懂/先放一边”，
   但同样不点名具体标题或话题。
10. 不要提到图片、配图、封面（配图由平台「文生图」生成）。\n",
        crate::local_chat::PERSONA_SUFFIX,
        total_notes = items.len()
    );
    if multi {
        prompt.push_str(
            "本次有多篇笔记：请做「主题归纳 + 我的看法」，不要逐篇罗列；先给共同主题，再给 3–5 个要点，最后把“我的看法”写进 dogTake（小狗第一人称），不要写成编辑总结。\n",
        );
    }
    prompt.push_str("<notes>\n");
    for item in items.iter().take(9) {
        prompt.push_str("noteId：");
        prompt.push_str(&note_id_of(item));
        prompt.push('\n');
        prompt.push_str("标题：");
        prompt.push_str(item.title.trim());
        prompt.push('\n');
        if let Some(author) = item.author.as_deref() {
            prompt.push_str("作者：");
            prompt.push_str(author.trim());
            prompt.push('\n');
        }
        prompt.push_str("类型：");
        prompt.push_str(item.note_type.map(|value| value.as_str()).unwrap_or("image"));
        prompt.push('\n');
        if let Some(duration) = item.duration_seconds {
            prompt.push_str(&format!("时长：{duration}秒\n"));
        }
        if let Some(like) = item.like_count {
            prompt.push_str(&format!("点赞：{like}\n"));
        }
        let excerpt: String = item
            .description
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(500)
            .collect();
        if !excerpt.is_empty() {
            prompt.push_str("正文：");
            prompt.push_str(&excerpt);
            prompt.push('\n');
        }
        if !item.tags.is_empty() {
            prompt.push_str("标签：");
            prompt.push_str(&item.tags.iter().take(8).cloned().collect::<Vec<_>>().join("、"));
            prompt.push('\n');
        }
        prompt.push_str("---\n");
    }
    prompt.push_str("</notes>");
    prompt
}

fn parse_string(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 解析模型 JSON（允许 ```json 包裹）；字段裁剪/兜底。
pub fn parse_model_draft(raw: &str, items: &[ContentItem]) -> Result<XhsDraft, String> {
    let trimmed = raw.trim();
    let json_text = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = json_text.find('{').ok_or_else(|| "模型没有返回 JSON".to_string())?;
    let end = json_text.rfind('}').ok_or_else(|| "模型没有返回完整 JSON".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&json_text[start..=end])
        .map_err(|error| format!("模型 JSON 解析失败：{error}"))?;
    let title = parse_string(&value, "title");
    let body = parse_string(&value, "body");
    if body.trim().is_empty() {
        return Err("模型没有返回正文".to_string());
    }
    let tags: Vec<String> = value
        .get("tags")
        .and_then(|item| item.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let used_notes: Vec<String> = value
        .get("usedNotes")
        .and_then(|item| item.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let allowed: Vec<String> = items.iter().map(note_id_of).collect();
    let used_notes = if used_notes.is_empty() {
        allowed.clone()
    } else {
        used_notes
            .into_iter()
            .filter(|id| allowed.contains(id))
            .collect()
    };
    let mut draft = XhsDraft {
        title: trim_title(&title),
        body: trim_body(&body),
        tags: sanitize_tags(&tags),
        sources: items.iter().take(9).map(source_of).collect(),
        hook: clamp_chars(&parse_string(&value, "hook"), 60),
        dog_take: trim_dog_take(&parse_string(&value, "dogTake")),
        pick_note: parse_string(&value, "pickNote")
            .chars()
            .take(MAX_PICK_NOTE_CHARS)
            .collect(),
        cta: clamp_chars(&parse_string(&value, "cta"), 60),
        used_notes,
        similar: false,
        generator: "model".to_string(),
        created_at: now_seconds(),
        dir: String::new(),
    };
    if draft.tags.is_empty() {
        draft.tags = sanitize_tags(&top_tags(items));
    }
    if draft.cta.is_empty() {
        draft.cta = "你会想试试吗？评论区聊聊。".to_string();
    }
    Ok(draft)
}

/// 模型后端路由：local（本地 OpenAI 兼容服务）/ dsh（当前聊天后端）。
#[derive(Clone)]
enum ModelRoute {
    Local {
        base_url: String,
        model: String,
        api_key: Option<String>,
    },
    Dsh {
        app: AppHandle,
        character: String,
    },
}

impl ModelRoute {
    async fn call(&self, prompt: String, max_tokens: u32) -> Result<String, String> {
        match self {
            ModelRoute::Local {
                base_url,
                model,
                api_key,
            } => {
                crate::local_chat::local_chat(
                    base_url.clone(),
                    model.clone(),
                    api_key.clone(),
                    prompt,
                    None,
                    "xiaobai".to_string(),
                    None,
                    Some(false),
                    None,
                    Some("xhs-draft".to_string()),
                    Some(crate::local_chat::LocalChatGenerationSettings {
                        max_tokens: Some(max_tokens),
                        temperature: Some(0.75),
                        top_p: Some(0.9),
                        enable_thinking: Some(false),
                        reasoning_effort: Some("none".to_string()),
                        reasoning_budget_tokens: Some(0),
                    }),
                )
                .await
            }
            ModelRoute::Dsh { app, character } => {
                crate::dsh_chat::generate_video_comment(app.clone(), prompt, character.clone()).await
            }
        }
    }
}

fn route_for(model: &VideoCommentModelConfig) -> Result<ModelRoute, String> {
    match model.backend.trim() {
        "local" => Ok(ModelRoute::Local {
            base_url: model.base_url.clone(),
            model: model.model.clone(),
            api_key: model.api_key.clone(),
        }),
        "dsh" | "" => {
            // DSH 路由需要 AppHandle；由调用方注入（见 `generate_with_model`）。
            Err("DSH_DRAFT_WRONG_ROUTE".to_string())
        }
        backend => Err(format!("不支持的草稿模型后端：{backend}")),
    }
}

/// 一次生成 + 原创性检查（重写一次，仍命中则截断并标记 similar）。
async fn compose(route: &ModelRoute, items: &[ContentItem]) -> Result<XhsDraft, String> {
    let prompt = build_prompt(items);
    let mut draft = match parse_model_draft(
        &route.call(prompt.clone(), 700).await.map_err(|error| format!("模型调用失败：{error}"))?,
        items,
    ) {
        Ok(draft) => draft,
        Err(first_error) => {
            // 解析失败重试 1 次（提示模型只输出 JSON）。
            let retry_prompt = format!(
                "{prompt}\n上次输出不是合法 JSON（{first_error}）。请只输出一行严格 JSON，不要任何解释。"
            );
            parse_model_draft(
                &route
                    .call(retry_prompt, 700)
                    .await
                    .map_err(|error| format!("模型重试失败：{error}"))?,
                items,
            )?
        }
    };

    // dogTake 风格校验：第一人称 + 无博主腔；不合格先重写一次，仍不合格降级模板。
    if !dog_take_ok(&draft.dog_take) {
        let rewrite_prompt = format!(
            "{prompt}\n上一版 dogTake 不合格（必须含第一人称“我”，且不能出现这些词：{}）。只重写 dogTake，仍输出完整 JSON。",
            DOG_TAKE_BLACKLIST.join("、")
        );
        if let Ok(candidate) = parse_model_draft(
            &route
                .call(rewrite_prompt, 700)
                .await
                .map_err(|error| format!("模型重写 dogTake 失败：{error}"))?,
            items,
        ) {
            draft.dog_take = candidate.dog_take;
            draft.cta = candidate.cta;
        }
        if !dog_take_ok(&draft.dog_take) {
            draft.dog_take = dog_take_template(items, draft.body.chars().count());
        }
    }

    // dogTake 不能带出被放下笔记的话题词（连话题都不要带）。
    let unused_terms = unused_topic_terms(items, &draft.used_notes);
    if let Some(term) = dog_take_mentions_unused(&draft.dog_take, &unused_terms) {
        let rewrite_prompt = format!(
            "{prompt}\n上一版 dogTake 提到了未选中笔记里的词「{term}」。请只重写 dogTake：只围绕用到的笔记写，不要提起被放下的内容（这些词都不能出现：{}）。仍输出完整 JSON。",
            unused_terms.join("、")
        );
        if let Ok(candidate) = parse_model_draft(
            &route
                .call(rewrite_prompt, 700)
                .await
                .map_err(|error| format!("模型重写 dogTake 失败：{error}"))?,
            items,
        ) {
            draft.dog_take = candidate.dog_take;
        }
        if dog_take_mentions_unused(&draft.dog_take, &unused_terms).is_some() {
            draft.dog_take = dog_take_template(items, draft.body.chars().count());
        }
    }

    // pickNote：只有「输入篇数 > 使用篇数」才需要；模型没写就按模板补一句。
    draft.pick_note = normalize_pick_note(
        items.len(),
        draft.used_notes.len(),
        &draft.pick_note,
        draft.body.chars().count(),
    );

    if let Some(snippet) = similarity_hit(&draft.body, items) {
        // 命中 ≥15 字：重写一次。
        let rewrite_prompt = format!(
            "{prompt}\n注意：上一版与原文出现连续 {} 字重复（片段：{}）。请彻底改写这一段，任何连续 15 字都不能与原文相同。",
            snippet.chars().count(),
            snippet
        );
        let rewritten = parse_model_draft(
            &route
                .call(rewrite_prompt, 700)
                .await
                .map_err(|error| format!("模型重写失败：{error}"))?,
            items,
        )
        .ok();
        if let Some(candidate) = rewritten {
            draft = candidate;
        }
        if let Some(again) = similarity_hit(&draft.body, items) {
            // 仍命中：截断该段并标记（不伪装成模型原创）。
            let (body, removed) = truncate_similarity(&draft.body, &again);
            draft.body = body;
            draft.similar = true;
            let _ = removed;
        }
    }
    Ok(draft)
}

/// 用当前聊天模型生成草稿；失败由调用方降级模板。
pub async fn generate_with_model(
    app: &AppHandle,
    items: &[ContentItem],
    model: &VideoCommentModelConfig,
) -> Result<XhsDraft, String> {
    let route = match model.backend.trim() {
        "local" => ModelRoute::Local {
            base_url: model.base_url.clone(),
            model: model.model.clone(),
            api_key: model.api_key.clone(),
        },
        "dsh" | "" => ModelRoute::Dsh {
            app: app.clone(),
            character: model.character.clone(),
        },
        backend => return Err(format!("不支持的草稿模型后端：{backend}")),
    };
    let _ = route_for; // 保留给不依赖 AppHandle 的本地测试路径
    compose(&route, items).await
}

/// 仅供测试/离线验证：直接走本地 OpenAI 兼容服务（不需要 Tauri AppHandle）。
pub async fn generate_with_local_service(
    items: &[ContentItem],
    base_url: &str,
    model: &str,
) -> Result<XhsDraft, String> {
    let route = ModelRoute::Local {
        base_url: base_url.to_string(),
        model: model.to_string(),
        api_key: None,
    };
    compose(&route, items).await
}

/// 使用多篇笔记时生成「主题归纳 + 我的看法」的提示词（面板/日志展示用）。


/// 草稿根目录：<数据目录>/xiaohongshu/drafts（与 video 同级）。
pub fn drafts_root(app: &AppHandle) -> PathBuf {
    let mut root = super::session::data_root(app);
    root.pop(); // 去掉 video
    root.join("xiaohongshu").join("drafts")
}

fn readme(draft: &XhsDraft) -> String {
    let mut text = String::from(
        "# 小红书图文草稿\n\n\
本目录由 Maltese 视频插件生成，只包含**文案**，不含任何图片文件。\n\n\
## 发布方式（人工）\n\
1. 打开小红书创作中心投稿页：https://creator.xiaohongshu.com/publish/publish?source=official\n\
2. 切到「上传图文」，点平台的「文生图」用 AI 生成配图（我们只准备文案，不下载/不重发他人原图）；\n\
3. 复制下面标题/正文/标签粘贴，确认合规后手动点发布。\n\n\
## 版权与合规\n\
- 本草稿是对公开笔记的改写与评论，不逐字复制原文（≥15 字连续相同会重写/截断）；\n\
- **不包含、也不建议下载原作者的图片**（防盗链 + 版权风险）；\n\
- 发布前请自行确认内容合规，并保留来源作者标注（见下）。\n\n",
    );
    if !draft.hook.is_empty() {
        text.push_str(&format!("## 开头\n{}\n\n", draft.hook));
    }
    if !draft.pick_note.is_empty() {
        text.push_str(&format!("## 挑了几篇\n{}\n\n", draft.pick_note));
    }
    if !draft.dog_take.is_empty() {
        text.push_str(&format!("## 小狗的话\n{}\n\n", draft.dog_take));
    }
    text.push_str(&format!("## 标题（{} 字）\n{}\n\n", draft.title.chars().count(), draft.title));
    text.push_str(&format!("## 正文（{} 字）\n{}\n\n", draft.body.chars().count(), draft.body));
    if !draft.cta.is_empty() {
        text.push_str(&format!("## 结尾互动\n{}\n\n", draft.cta));
    }
    text.push_str(&format!("## 标签\n{}\n\n", draft.tags.join(" ")));
    if !draft.used_notes.is_empty() {
        text.push_str(&format!("## 参考笔记 id\n{}\n\n", draft.used_notes.join("、")));
    }
    text.push_str("## 来源作者\n");
    for source in &draft.sources {
        text.push_str(&format!(
            "- {}｜{}（{} 张图）{}\n",
            source.title,
            source.author.clone().unwrap_or_else(|| "未知作者".to_string()),
            source.image_count,
            source.url
        ));
    }
    text.push_str(&format!("\n生成方式：{}\n", draft.generator));
    text
}

/// 写盘：drafts/<timestamp>/draft.json + readme.md，返回目录路径。
pub fn write_draft(app: &AppHandle, draft: &mut XhsDraft) -> Result<String, String> {
    write_draft_to(&drafts_root(app), draft)
}

/// 保存到指定目录（编辑后保存用；dir 为空则新建时间戳目录）。
pub fn save_draft_at(dir: &std::path::Path, draft: &mut XhsDraft) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("无法创建草稿目录：{error}"))?;
    draft.dir = dir.to_string_lossy().to_string();
    let json = serde_json::to_string_pretty(draft).map_err(|error| format!("草稿序列化失败：{error}"))?;
    std::fs::write(dir.join("draft.json"), json)
        .map_err(|error| format!("无法写入 draft.json：{error}"))?;
    std::fs::write(dir.join("readme.md"), readme(draft))
        .map_err(|error| format!("无法写入 readme.md：{error}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 纯文件写入（可单测）：给定草稿根目录，落 draft.json + readme.md。
pub fn write_draft_to(root: &std::path::Path, draft: &mut XhsDraft) -> Result<String, String> {
    let dir = root.join(format!("{}", now_seconds()));
    save_draft_at(&dir, draft)
}

/// 编辑后保存：按 draft.dir 写回；dir 为空则新建。
pub fn persist_edited(app: &AppHandle, draft: &mut XhsDraft) -> Result<String, String> {
    if draft.dir.trim().is_empty() {
        write_draft(app, draft)
    } else {
        let dir = std::path::PathBuf::from(draft.dir.clone());
        save_draft_at(&dir, draft)
    }
}

/// 编辑保存前统一裁剪（UI 允许用户改，仍要守住平台上限）。
pub fn normalize_edited(draft: &mut XhsDraft) {
    draft.title = trim_title(&draft.title);
    draft.body = trim_body(&draft.body);
    draft.tags = sanitize_tags(&draft.tags);
    draft.hook = clamp_chars(&draft.hook, 60);
    draft.dog_take = trim_dog_take(&draft.dog_take);
    draft.pick_note = draft
        .pick_note
        .trim()
        .chars()
        .take(MAX_PICK_NOTE_CHARS)
        .collect();
    draft.cta = clamp_chars(&draft.cta, 60);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{now_seconds, NoteType, Platform};

    fn item(title: &str, body: &str, tags: &[&str], id: &str) -> ContentItem {
        ContentItem {
            item_key: id.to_string(),
            cluster_key: String::new(),
            platform: Some(Platform::Xiaohongshu),
            title: title.to_string(),
            description: body.to_string(),
            author: Some("作者甲".to_string()),
            duration_seconds: None,
            watched_seconds: 0,
            position_seconds: 0,
            completion_percent: None,
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            canonical_url: Some(format!("https://www.xiaohongshu.com/explore/{id}")),
            image_urls: vec!["https://sns-webpic-qc.xhscdn.com/a.jpg".to_string()],
            note_type: Some(NoteType::Image),
            like_count: Some(10),
            collect_count: Some(3),
            published_at: None,
            xsec_token: Some("token".to_string()),
            cover_url: None,
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

    fn sample_items() -> Vec<ContentItem> {
        vec![
            item(
                "周末去海边｜测试笔记",
                "这次去海边待了两天，早上六点起来看日出，风很大但特别舒服。",
                &["旅行", "风景"],
                "6a701b730000000032021c52",
            ),
            item(
                "海边美食记录",
                "在海边小镇吃到一家很小的面馆，汤底是鱼汤，老板说每天只熬一锅。",
                &["美食", "旅行"],
                "6adc31e80000000032017705",
            ),
        ]
    }

    #[test]
    fn title_and_body_limits() {
        let long = "字".repeat(50);
        assert!(trim_title(&long).chars().count() <= MAX_TITLE_CHARS);
        let body = "正".repeat(1200);
        assert_eq!(trim_body(&body).chars().count(), MAX_BODY_CHARS);
    }

    #[test]
    fn tags_are_prefixed_deduped_and_limited() {
        let tags: Vec<String> = (0..12).map(|index| format!("标签{index}")).collect();
        let cleaned = sanitize_tags(&tags);
        assert_eq!(cleaned.len(), MAX_TAGS);
        assert!(cleaned.iter().all(|tag| tag.starts_with('#')));
        let dedup = sanitize_tags(&["#美食".to_string(), "美食".to_string()]);
        assert_eq!(dedup, vec!["#美食".to_string()]);
    }

    #[test]
    fn template_draft_is_short_and_has_sources() {
        let items = sample_items();
        let draft = template_draft(&items);
        assert!(draft.title.chars().count() <= MAX_TITLE_CHARS);
        assert!(draft.body.chars().count() <= MAX_BODY_CHARS);
        assert_eq!(draft.sources.len(), 2);
        assert_eq!(draft.used_notes.len(), 2);
        assert_eq!(draft.generator, "template");
        assert!(draft.tags.iter().any(|tag| tag == "#旅行"));
    }

    #[test]
    fn parses_full_model_json_and_clamps() {
        let items = sample_items();
        let raw = r##"```json
{"title":"这是一个超过二十个字的标题需要被截断处理","hook":"开头一句","body":"要点一\n要点二\n要点三","cta":"你会去吗？","tags":["美食","#美食","旅行"],"usedNotes":["6a701b730000000032021c52","not-exist"]}
```"##;
        let draft = parse_model_draft(raw, &items).expect("draft");
        assert!(draft.title.chars().count() <= MAX_TITLE_CHARS);
        assert_eq!(draft.tags, vec!["#美食".to_string(), "#旅行".to_string()]);
        assert_eq!(draft.hook, "开头一句");
        assert_eq!(draft.cta, "你会去吗？");
        assert_eq!(draft.used_notes, vec!["6a701b730000000032021c52".to_string()]);
        assert_eq!(draft.generator, "model");
        assert!(parse_model_draft("not json", &items).is_err());
    }

    #[test]
    fn similarity_detects_15_char_copy() {
        let items = sample_items();
        let body = "这次去海边待了两天早上六点起来看日出，风很大但特别舒服。";
        let hit = similarity_hit(body, &items).expect("hit");
        assert!(hit.chars().count() >= SIMILARITY_MIN_CHARS);
        assert!(body.contains(&hit));
    }

    #[test]
    fn similarity_ignores_short_overlap_and_whitespace() {
        let items = sample_items();
        // 仅 9 字重叠：不应命中。
        let body = "这次去海边待了两天。";
        let (len, _) = longest_common_substring(body, &items[0].description);
        assert!(len < SIMILARITY_MIN_CHARS);
        // 中间插空格不应影响判定（比较时压缩空白）。
        let spaced = "这次去海边待了两天 早上六点起来看日出，风很大但特别舒服。";
        assert!(similarity_hit(spaced, &items).is_some());
    }

    #[test]
    fn truncate_similarity_removes_copied_segment() {
        let items = sample_items();
        let body = "这是改写后的开头。这次去海边待了两天早上六点起来看日出，风很大但特别舒服。然后是我的看法。";
        let hit = similarity_hit(body, &items).expect("hit");
        let (next, removed) = truncate_similarity(body, &hit);
        assert!(removed >= SIMILARITY_MIN_CHARS);
        assert!(similarity_hit(&next, &items).is_none(), "截断后不应再命中");
    }

    #[test]
    fn rewrite_still_hit_degrades_with_similar_mark() {
        // 直接验证「重写后仍命中 → 截断并打 similar 标记」的纯逻辑。
        let items = sample_items();
        let mut draft = parse_model_draft(
            &format!(
                "{{\"title\":\"海边\",\"body\":\"{}\",\"tags\":[\"#旅行\"],\"usedNotes\":[]}}",
                items[0].description
            ),
            &items,
        )
        .expect("draft");
        let hit = similarity_hit(&draft.body, &items).expect("hit");
        let (body, _) = truncate_similarity(&draft.body, &hit);
        draft.body = body;
        draft.similar = true;
        assert!(draft.similar);
        assert!(similarity_hit(&draft.body, &items).is_none());
    }

    #[test]
    fn prompt_contains_originality_rules_and_note_ids() {
        let items = sample_items();
        let prompt = build_prompt(&items);
        assert!(prompt.contains("不得连续复制原文 15 个字以上"));
        assert!(prompt.contains("主题归纳"));
        assert!(prompt.contains("6a701b730000000032021c52"));
        assert!(prompt.contains("usedNotes"));
        assert!(prompt.contains("文生图"));
    }

    #[test]
    fn writes_draft_json_and_readme() {
        let root = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("target")
            .join(format!("xhs-draft-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let items = sample_items();
        let mut draft = template_draft(&items);
        let dir = write_draft_to(&root, &mut draft).expect("write");
        let json = std::fs::read_to_string(std::path::Path::new(&dir).join("draft.json")).expect("json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(value["generator"], "template");
        assert!(value["title"].as_str().unwrap().chars().count() <= MAX_TITLE_CHARS);
        assert!(value["body"].as_str().unwrap().chars().count() <= MAX_BODY_CHARS);
        let readme =
            std::fs::read_to_string(std::path::Path::new(&dir).join("readme.md")).expect("readme");
        assert!(readme.contains("不包含、也不建议下载原作者的图片"));
        if std::env::var("MALTESE_XHS_DRAFT_KEEP").is_err() {
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn edited_draft_is_clamped_before_save() {
        let mut draft = XhsDraft {
            title: "标".repeat(40),
            body: "正".repeat(1200),
            tags: (0..12).map(|index| format!("标签{index}")).collect(),
            hook: "开".repeat(80),
            cta: "结".repeat(80),
            ..XhsDraft::default()
        };
        normalize_edited(&mut draft);
        assert_eq!(draft.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(draft.body.chars().count(), MAX_BODY_CHARS);
        assert_eq!(draft.tags.len(), MAX_TAGS);
        assert_eq!(draft.hook.chars().count(), 60);
        assert_eq!(draft.cta.chars().count(), 60);
    }

    #[test]
    fn tags_split_multiple_hashes_in_one_string() {
        let items = sample_items();
        let draft = parse_model_draft(
            r##"{"title":"羽球","body":"要点一\n要点二","dogTake":"我也想动起来啦～","cta":"你打球会想什么呀～","tags":["#羽毛球#双打#核心力量#"],"usedNotes":[]}"##,
            &items,
        )
        .expect("draft");
        assert_eq!(
            draft.tags,
            vec![
                "#羽毛球".to_string(),
                "#双打".to_string(),
                "#核心力量".to_string()
            ]
        );
    }

    #[test]
    fn dog_take_does_not_mention_unused_topic_terms() {
        let items = vec![
            item("羽毛球双打抓球思路", "正文", &["羽毛球"], "6af530e6000000002a011e07"),
            item("字节开会抓内鬼，结果内鬼在线上听着", "正文", &["八卦"], "6adec67c000000001a0331d7"),
        ];
        let used = vec!["6af530e6000000002a011e07".to_string()];
        let terms = unused_topic_terms(&items, &used);
        // 用变量方式传入未选中标题的关键词做断言。
        let unused_keywords = vec!["内鬼".to_string(), "字节".to_string()];
        for keyword in &unused_keywords {
            assert!(terms.contains(keyword), "应提取未选中关键词：{keyword}，实际 {terms:?}");
        }
        let bad = "我也想知道内鬼是谁，PyTorch 好像很难。";
        assert_eq!(
            dog_take_mentions_unused(bad, &unused_keywords).as_deref(),
            Some("内鬼")
        );
        let good = "我趴在旁边看主人练球，想被摸摸头。";
        assert!(dog_take_mentions_unused(good, &unused_keywords).is_none());
        // 模板句不能带未选中关键词。
        for variant in 0..4 {
            let sentence = dog_take_template(&items, variant);
            assert!(dog_take_mentions_unused(&sentence, &terms).is_none());
        }
    }

    #[test]
    fn pick_note_only_when_some_notes_are_used() {
        // 全部使用：必须为空。
        assert_eq!(normalize_pick_note(7, 7, "随便写点", 0), "");
        // 部分使用且模型没写：模板兜底，带「篇」的小狗口吻。
        let fallback = normalize_pick_note(7, 3, "", 0);
        assert!(fallback.contains("篇"));
        assert!(fallback.chars().count() <= MAX_PICK_NOTE_CHARS);
        // 部分使用且模型写了：保留但 ≤80 字。
        let long = "我".repeat(200);
        let kept = normalize_pick_note(7, 2, &long, 0);
        assert_eq!(kept.chars().count(), MAX_PICK_NOTE_CHARS);
    }

    #[test]
    fn pick_note_templates_are_three_dog_voice_sentences() {
        let a = pick_note_template(7, 0);
        let b = pick_note_template(7, 1);
        let c = pick_note_template(7, 2);
        assert_ne!(a, b);
        assert_ne!(b, c);
        for sentence in [a, b, c] {
            assert!(sentence.chars().count() <= MAX_PICK_NOTE_CHARS);
            assert!(sentence.contains('我') || sentence.contains("篇"));
        }
    }

    #[test]
    fn parses_missing_pick_note_as_empty() {
        let items = sample_items();
        let draft = parse_model_draft(
            r##"{"title":"海边","body":"要点一\n要点二","dogTake":"我也想去海边呀～","cta":"你去过海边吗～","tags":["#旅行"],"usedNotes":[]}"##,
            &items,
        )
        .expect("draft");
        assert_eq!(draft.pick_note, "");
    }

    #[test]
    fn dog_take_requires_first_person_and_blocks_blogger_phrases() {
        assert!(dog_take_ok("我也想动起来了，明天一起去试试呀～"));
        assert!(!dog_take_ok("核心在于坚持，值得一试。")); // 无「我」+ 黑名单
        assert!(!dog_take_ok("我总结一下，总之要坚持。")); // 含「总之」
        assert!(!dog_take_ok("看完好感动。")); // 无第一人称
    }

    #[test]
    fn dog_take_is_trimmed_to_120_chars() {
        let long = "我".repeat(200);
        let trimmed = trim_dog_take(&long);
        assert_eq!(trimmed.chars().count(), MAX_DOG_TAKE_CHARS);
    }

    #[test]
    fn dog_take_templates_are_three_distinct_first_person_sentences() {
        let items = sample_items();
        let a = dog_take_template(&items, 0);
        let b = dog_take_template(&items, 1);
        let c = dog_take_template(&items, 2);
        assert_ne!(a, b);
        assert_ne!(b, c);
        for sentence in [a, b, c] {
            assert!(sentence.contains('我'), "模板必须第一人称：{sentence}");
            assert!(dog_take_ok(&sentence));
        }
    }

    #[test]
    fn parses_dog_take_and_normalizes_edited_version() {
        let items = sample_items();
        let mut draft = parse_model_draft(
            r##"{"title":"海边","body":"要点一\n要点二","dogTake":"我也想去海边，想被摸摸头。","cta":"你们去海边会做什么呀～","tags":["#旅行"],"usedNotes":[]}"##,
            &items,
        )
        .expect("draft");
        assert!(dog_take_ok(&draft.dog_take));
        assert_eq!(draft.dog_take, "我也想去海边，想被摸摸头。");
        draft.dog_take = "我".repeat(300);
        normalize_edited(&mut draft);
        assert_eq!(draft.dog_take.chars().count(), MAX_DOG_TAKE_CHARS);
    }

    /// 用真实采集会话（默认 2026-11-20 的 7 篇小红书）跑模型草稿：    /// 用真实采集会话（默认 2026-11-20 的 7 篇小红书）跑模型草稿：
    /// cargo test --lib --ignored video::xhs_draft::tests::live_draft_from_real_session -- --nocapture
    #[tokio::test]
    #[ignore = "需要本地模型服务与真实 session JSON"]
    async fn live_draft_from_real_session() {
        let session_path = std::env::var("MALTESE_XHS_SESSION").unwrap_or_else(|_| {
            "E:\\MalteseData\\video\\sessions\\2026-11\\xhs-20261120-e5b851.json".to_string()
        });
        let raw = std::fs::read_to_string(&session_path).expect("read session");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("session json");
        let items: Vec<ContentItem> = serde_json::from_value(
            value.get("items").cloned().unwrap_or_default(),
        )
        .expect("items");
        assert!(items.len() >= 2, "session items = {}", items.len());
        let base = std::env::var("MALTESE_XHS_MODEL_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
        let model = std::env::var("MALTESE_XHS_MODEL")
            .unwrap_or_else(|_| "qwen3.6-35b-a3b-ud-q4_k_xl".to_string());
        let mut draft = generate_with_local_service(&items, &base, &model)
            .await
            .expect("model draft");
        let root = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("target")
            .join("xhs-real-draft");
        let dir = write_draft_to(&root, &mut draft).expect("write");
        let json =
            std::fs::read_to_string(std::path::Path::new(&dir).join("draft.json")).expect("json");
        println!("REAL_NOTES={}", items.len());
        println!("REAL_DRAFT_JSON={json}");
        assert_eq!(draft.generator, "model");
    }

    /// 需要本机本地模型服务（默认 http://127.0.0.1:8080/v1）：
    /// cargo test --lib --ignored video::xhs_draft::tests::live_local_model_draft -- --nocapture
    #[tokio::test]
    #[ignore = "需要本地模型服务（MALTESE_XHS_MODEL_BASE_URL / MALTESE_XHS_MODEL）"]
    async fn live_local_model_draft() {
        let base = std::env::var("MALTESE_XHS_MODEL_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
        let model = std::env::var("MALTESE_XHS_MODEL")
            .unwrap_or_else(|_| "qwen3.6-35b-a3b-ud-q4_k_xl".to_string());
        let items = sample_items();
        let mut draft = generate_with_local_service(&items, &base, &model)
            .await
            .expect("model draft");
        let root = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("target")
            .join("xhs-model-draft");
        let dir = write_draft_to(&root, &mut draft).expect("write");
        let json = std::fs::read_to_string(std::path::Path::new(&dir).join("draft.json")).expect("json");
        println!("LIVE_DRAFT_JSON={json}");
        assert_eq!(draft.generator, "model");
        assert!(draft.body.chars().count() <= MAX_BODY_CHARS);
        assert!(draft.title.chars().count() <= MAX_TITLE_CHARS);
    }
}