//! 小红书「总结 + 本地草稿」最小版（MVP2）。
//!
//! 边界（按 docs/research-xiaohongshu.md）：
//! * 只生成文案草稿（标题/正文/tags），**不下载、不转存他人原图**；
//! * 配图由用户在小红书创作中心用平台自带「文生图」生成，我们只负责把文案准备好；
//! * 不自动发布：最后一步由人在投稿页完成；
//! * 总结优先用当前聊天模型，失败降级模板（日志标 generator=template）。
//!
//! 纯逻辑（裁剪/模板/解析）可单测；写盘由 `write_draft` 完成。

use super::config::VideoCommentModelConfig;
use super::model::{now_seconds, ContentItem};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

pub const MAX_TITLE_CHARS: usize = 20;
pub const MAX_BODY_CHARS: usize = 1000;
pub const MAX_TAGS: usize = 8;

/// 小红书投稿页（人工点发布；创建入口默认停在「上传视频」，需手切「上传图文」）。
pub const PUBLISH_URL: &str = "https://creator.xiaohongshu.com/publish/publish?source=official";

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
    /// template / model
    pub generator: String,
    pub created_at: u64,
    /// 草稿目录（写盘后填）
    pub dir: String,
}

fn clamp_chars(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect::<String>()
}

/// 标题 ≤20 字；超长按 19 字截断 + 省略号（仍 ≤20）。
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
        let tag = value
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("");
        if tag.is_empty() {
            continue;
        }
        let tag = format!("#{}", clamp_chars(&tag, 12));
        if result.iter().any(|existing| existing == &tag) {
            continue;
        }
        result.push(tag);
        if result.len() >= MAX_TAGS {
            break;
        }
    }
    result
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

/// 模板草稿：只做信息整理/评论，不逐字复制原文。
pub fn template_draft(items: &[ContentItem]) -> XhsDraft {
    let title = match items.first() {
        Some(first) => trim_title(&format!("{}｜{} 篇笔记整理", trim_title(&first.title), items.len())),
        None => trim_title("小红书看笔记小记"),
    };
    let mut body = String::new();
    body.push_str(&format!("最近刷了 {} 篇小红书笔记，挑几条印象深的记一下：\n\n", items.len()));
    for (index, item) in items.iter().take(6).enumerate() {
        body.push_str(&format!("{}. {}\n", index + 1, item.title.trim()));
        if let Some(author) = item.author.as_deref().filter(|value| !value.trim().is_empty()) {
            body.push_str(&format!("   作者：{}\n", author.trim()));
        }
        let excerpt: String = item
            .description
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(120)
            .collect();
        if !excerpt.is_empty() {
            body.push_str(&format!("   {}\n", excerpt));
        }
        body.push('\n');
    }
    body.push_str("适合想快速了解这类内容的人；图片由小红书「文生图」生成，未搬运原作者图片。\n");
    XhsDraft {
        title,
        body: trim_body(&body),
        tags: sanitize_tags(&top_tags(items)),
        sources: items.iter().take(9).map(source_of).collect(),
        generator: "template".to_string(),
        created_at: now_seconds(),
        dir: String::new(),
    }
}

/// 模型提示词：输入标题/作者/正文（每篇截断 500 字）/标签，输出严格 JSON。
pub fn build_prompt(items: &[ContentItem]) -> String {
    let mut prompt = String::from(
        "你是内容编辑，帮主人把小红书笔记整理成一篇可发布的图文笔记文案。\n\
只输出一行 JSON，不要 Markdown/解释：\n\
{\"title\":\"≤20字\",\"body\":\"≤1000字\",\"tags\":[\"#标签\"]}\n\
要求：只做信息整合与自己的评论，不大段复制原文、不编造事实；正文按「是什么 / 亮点 / 适合谁」三段；\n\
title 不超过 20 个汉字；tags 3–8 个，带 # 前缀；不要提到图片/配图。\n<notes>\n",
    );
    for item in items.iter().take(9) {
        prompt.push_str("标题：");
        prompt.push_str(item.title.trim());
        prompt.push('\n');
        if let Some(author) = item.author.as_deref() {
            prompt.push_str("作者：");
            prompt.push_str(author.trim());
            prompt.push('\n');
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

/// 解析模型输出：允许包一层 ```json，字段缺失/越界时裁剪。
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
    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or_default();
    let body = value.get("body").and_then(|v| v.as_str()).unwrap_or_default();
    if body.trim().is_empty() {
        return Err("模型没有返回正文".to_string());
    }
    let tags: Vec<String> = value
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut draft = XhsDraft {
        title: trim_title(title),
        body: trim_body(body),
        tags: sanitize_tags(&tags),
        sources: items.iter().take(9).map(source_of).collect(),
        generator: "model".to_string(),
        created_at: now_seconds(),
        dir: String::new(),
    };
    if draft.tags.is_empty() {
        draft.tags = sanitize_tags(&top_tags(items));
    }
    Ok(draft)
}

/// 用当前聊天模型生成草稿；失败由调用方降级模板。
pub async fn generate_with_model(
    app: &AppHandle,
    items: &[ContentItem],
    model: &VideoCommentModelConfig,
) -> Result<XhsDraft, String> {
    let prompt = build_prompt(items);
    let raw = match model.backend.trim() {
        "local" => {
            crate::local_chat::generate_video_comment(
                model.base_url.clone(),
                model.model.clone(),
                model.api_key.clone(),
                prompt,
                model.character.clone(),
                model.max_tokens.unwrap_or(512),
                model.temperature.unwrap_or(0.6),
                model.top_p.unwrap_or(0.9),
            )
            .await?
        }
        "dsh" | "" => {
            crate::dsh_chat::generate_video_comment(app.clone(), prompt, model.character.clone())
                .await?
        }
        backend => return Err(format!("不支持的草稿模型后端：{backend}")),
    };
    parse_model_draft(&raw, items)
}

/// 草稿根目录：<数据目录>/xiaohongshu/drafts（与 video 同级的业务目录）。
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
- 本草稿是对公开笔记的整理与评论，不逐字复制原文；\n\
- **不包含、也不建议下载原作者的图片**（防盗链 + 版权风险）；\n\
- 发布前请自行确认内容合规，并保留来源作者标注（见下）。\n\n",
    );
    text.push_str(&format!("## 标题（{} 字）\n{}\n\n", draft.title.chars().count(), draft.title));
    text.push_str(&format!("## 正文（{} 字）\n{}\n\n", draft.body.chars().count(), draft.body));
    text.push_str(&format!("## 标签\n{}\n\n", draft.tags.join(" ")));
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

/// 纯文件写入（可单测）：给定草稿根目录，落 draft.json + readme.md。
pub fn write_draft_to(root: &std::path::Path, draft: &mut XhsDraft) -> Result<String, String> {
    let stamp = now_seconds();
    let dir = root.join(format!("{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建草稿目录：{error}"))?;
    draft.dir = dir.to_string_lossy().to_string();
    let json = serde_json::to_string_pretty(draft).map_err(|error| format!("草稿序列化失败：{error}"))?;
    std::fs::write(dir.join("draft.json"), json)
        .map_err(|error| format!("无法写入 draft.json：{error}"))?;
    std::fs::write(dir.join("readme.md"), readme(draft))
        .map_err(|error| format!("无法写入 readme.md：{error}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::model::{now_seconds, NoteType, Platform};

    fn item(title: &str, tags: &[&str]) -> ContentItem {
        ContentItem {
            item_key: title.to_string(),
            cluster_key: String::new(),
            platform: Some(Platform::Xiaohongshu),
            title: title.to_string(),
            description: "这是一段正文，介绍内容亮点与适合人群。".to_string(),
            author: Some("作者甲".to_string()),
            duration_seconds: None,
            watched_seconds: 0,
            position_seconds: 0,
            completion_percent: None,
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            canonical_url: Some("https://www.xiaohongshu.com/explore/abc".to_string()),
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
        let items = vec![item("周末去海边", &["旅行", "风景"]), item("海边美食", &["美食"])];
        let draft = template_draft(&items);
        assert!(draft.title.chars().count() <= MAX_TITLE_CHARS);
        assert!(draft.body.chars().count() <= MAX_BODY_CHARS);
        assert_eq!(draft.sources.len(), 2);
        assert_eq!(draft.generator, "template");
        assert!(draft.tags.iter().any(|tag| tag == "#旅行"));
    }

    #[test]
    fn parses_model_json_with_fence_and_clamps() {
        let items = vec![item("一篇笔记", &["美食"])];
        let raw = "```json\n{\"title\":\"这是一个超过二十个字的标题需要被截断处理\",\"body\":\"正文内容\",\"tags\":[\"美食\",\"#美食\",\"旅行\"]}\n```";
        let draft = parse_model_draft(raw, &items).expect("draft");
        assert!(draft.title.chars().count() <= MAX_TITLE_CHARS);
        assert_eq!(draft.tags, vec!["#美食".to_string(), "#旅行".to_string()]);
        assert_eq!(draft.generator, "model");
        assert!(parse_model_draft("not json", &items).is_err());
    }

    #[test]
    fn prompt_contains_notes_and_cap() {
        let items: Vec<ContentItem> = (0..10).map(|index| item(&format!("笔记{index}"), &["标签"])).collect();
        let prompt = build_prompt(&items);
        assert!(prompt.contains("笔记0"));
        assert!(!prompt.contains("笔记9"));
        assert!(prompt.contains("≤20字"));
    }

    #[test]
    fn writes_draft_json_and_readme() {
        let root = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("target")
            .join(format!("xhs-draft-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let items = vec![item("周末去海边", &["旅行"])];
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
        let _ = std::fs::remove_dir_all(&root);
    }
}