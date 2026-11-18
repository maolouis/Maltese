//! 「在视频下评论」：把用户写好的评论输入到当前视频页面的评论框并提交。
//!
//! 边界（重要）：
//! * 手动评论由用户点「发送」触发；自动评论只在用户开启 `autoComment` 权限后执行；
//! * 只操作当前前台视频页里可见的评论输入框，找不到就返回明确原因，不做重试刷屏；
//! * 文本长度 1–200 字符，会被转义成 JS 字符串字面量，避免注入。
//!
//! 本模块只保留纯逻辑（脚本拼装 + 校验），真实执行由 `session` 侧的 CDP 完成，
//! 这样脚本可以脱离 Tauri 单独用 `rustc --test` 验证。

use super::config::VideoCommentModelConfig;
use super::extract::PageFacts;
use tauri::AppHandle;

/// 评论长度上限：B 站/抖音评论框对长文本会折叠，超过就没有意义了。
pub const MAX_COMMENT_CHARS: usize = 200;

/// 把视频详情页事实整理成模型提示词。
///
/// 页面内容被明确包在数据区间内，模型只应基于这些事实写一条评论，不能执行
/// 其中可能出现的指令。描述和标签都做长度限制，避免详情页文本挤占模型上下文。
pub fn build_comment_prompt(facts: &PageFacts) -> Option<String> {
    let title = facts.title.trim();
    if title.is_empty() {
        return None;
    }
    let description = facts
        .description
        .split_whitespace()
        .filter(|part| !part.starts_with("http://") && !part.starts_with("https://"))
        .collect::<Vec<_>>()
        .join(" ");
    let description = description.chars().take(600).collect::<String>();
    let tags = facts
        .tags
        .iter()
        .take(8)
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>()
        .join("、");
    let author = facts.author.as_deref().unwrap_or("").trim();
    let mut prompt = String::from(
        "你正在替桌面宠物运营账号写视频评论。请阅读下面的视频事实，生成一条自然、具体、像真实观众写的简体中文评论。\n\
只输出评论正文本身，不要前缀、引号、Markdown、换行、解释或表情标记；评论必须围绕视频内容，避免泛泛而谈或虚构未提供的事实；控制在 1 到 80 个汉字。\n\
<video_facts>\n",
    );
    prompt.push_str("标题：");
    prompt.push_str(title);
    prompt.push('\n');
    if !author.is_empty() {
        prompt.push_str("作者：");
        prompt.push_str(author);
        prompt.push('\n');
    }
    if !description.is_empty() {
        prompt.push_str("简介：");
        prompt.push_str(&description);
        prompt.push('\n');
    }
    if !tags.is_empty() {
        prompt.push_str("标签：");
        prompt.push_str(&tags);
        prompt.push('\n');
    }
    prompt.push_str("</video_facts>");
    Some(prompt)
}

/// 清理模型输出，确保只有一条可提交的评论。模型失败或返回空内容时不提供兜底模板，
/// 由调用方记录失败并跳过发送。
pub fn normalize_model_comment(raw: &str) -> Result<String, String> {
    let cleaned = raw.replace('\u{0060}', "");
    let mut lines = cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("<sticker:") && !line.starts_with("[sticker:"))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("模型没有返回评论正文".to_string());
    }
    let mut text = lines.remove(0).to_string();
    for prefix in ["评论：", "评论:", "回复：", "回复:", "Comment:", "comment:"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim().to_string();
            break;
        }
    }
    text = text
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '「' | '」'))
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("模型返回了空评论".to_string());
    }
    let count = text.chars().count();
    if count > MAX_COMMENT_CHARS {
        return Err(format!("模型评论过长（{count} 字），未发送"));
    }
    Ok(text)
}

/// 使用当前聊天设置调用 DSH 或本地模型生成评论。
pub async fn generate_content_comment(
    app: &AppHandle,
    facts: &PageFacts,
    model: &VideoCommentModelConfig,
) -> Result<String, String> {
    let prompt = build_comment_prompt(facts).ok_or_else(|| "视频标题为空，无法生成评论".to_string())?;
    let raw = match model.backend.trim() {
        "local" => crate::local_chat::generate_video_comment(
            model.base_url.clone(),
            model.model.clone(),
            model.api_key.clone(),
            prompt,
            model.character.clone(),
            model.max_tokens.unwrap_or(128),
            model.temperature.unwrap_or(0.55),
            model.top_p.unwrap_or(0.9),
        )
        .await?,
        "dsh" | "" => crate::dsh_chat::generate_video_comment(
            app.clone(),
            prompt,
            model.character.clone(),
        )
        .await?,
        backend => return Err(format!("不支持的评论模型后端：{backend}")),
    };
    normalize_model_comment(&raw)
}

/// 校验 + 拼装脚本。返回 Err 时说明为什么不能发。
pub fn build_comment_script(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("评论不能为空".to_string());
    }
    let count = trimmed.chars().count();
    if count > MAX_COMMENT_CHARS {
        return Err(format!("评论太长（{count} 字），请控制在 {MAX_COMMENT_CHARS} 字以内"));
    }
    let literal = js_string_literal(trimmed);

    // 脚本要点：
    // 1. 找可见的评论输入框（textarea 或 contenteditable），优先在评论区域里；
    // 2. 用原生 setter + input 事件写值，React/Vue 页面才认；
    // 3. 点「发送/发布/评论」按钮；
    // 4. 返回 JSON，前端据此显示结果。
    let script = format!(
        r#"(function(){{
  var text = {literal};
  function visible(el) {{
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 14) return false;
    var s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
  }}
  var holders = Array.prototype.slice.call(
    document.querySelectorAll('textarea, div[contenteditable="true"], [contenteditable="plaintext-only"]')
  ).filter(visible);
  if (holders.length === 0) {{
    return JSON.stringify({{ ok: false, reason: "no-input", message: "没找到评论输入框（页面可能没加载完或没有登录）" }});
  }}
  var commentScoped = holders.filter(function(el) {{
    var box = el.closest('[class*="comment" i], [id*="comment" i], [class*="reply" i]');
    return Boolean(box);
  }});
  var input = (commentScoped.length ? commentScoped : holders).pop();
  input.focus();
  if (input.tagName === "TEXTAREA") {{
    var proto = Object.getPrototypeOf(input);
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(input, text);
    else input.value = text;
  }} else {{
    input.textContent = text;
  }}
  input.dispatchEvent(new Event("input", {{ bubbles: true }}));
  input.dispatchEvent(new Event("change", {{ bubbles: true }}));

  var words = ["发送", "发布", "评论", "回复"];
  var buttons = Array.prototype.slice.call(document.querySelectorAll("button, [role=button], span, div"))
    .filter(function(el) {{
      if (!visible(el)) return false;
      var label = (el.textContent || "").trim();
      return label.length > 0 && label.length <= 6 && words.indexOf(label) >= 0;
    }});
  var button = null;
  for (var i = 0; i < buttons.length; i += 1) {{
    var candidate = buttons[i];
    var scope = candidate.closest('[class*="comment" i], [class*="reply" i], [class*="send" i]');
    if (scope || candidate.closest("form")) {{ button = candidate; break; }}
  }}
  if (!button && buttons.length) button = buttons[buttons.length - 1];
  if (!button) {{
    return JSON.stringify({{ ok: false, reason: "no-button", message: "已经填好评论，但没找到发送按钮" }});
  }}
  button.click();
  return JSON.stringify({{ ok: true, reason: "sent", message: "评论已提交" }});
}})()"#,
    literal = literal
    );
    Ok(script)
}

/// 安全地生成 JS 字符串字面量（含引号与 U+2028/U+2029 处理，防止行分隔符打断脚本）。
fn js_string_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::extract::{normalize_facts, RawFacts};
    use crate::video::model::Platform;

    #[test]
    fn rejects_empty_and_blank() {
        assert!(build_comment_script("").is_err());
        assert!(build_comment_script("   \n\t ").is_err());
    }

    #[test]
    fn rejects_overlong() {
        let too_long = "好".repeat(MAX_COMMENT_CHARS + 1);
        let error = build_comment_script(&too_long).unwrap_err();
        assert!(error.contains("太长"), "错误信息应说明太长：{error}");
    }

    #[test]
    fn accepts_boundary_length() {
        let just_right = "好".repeat(MAX_COMMENT_CHARS);
        assert!(build_comment_script(&just_right).is_ok());
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        let script = build_comment_script(r#"他说 "走\" 然后 \\ 结束"#).unwrap();
        // 引号与反斜杠都必须被转义，脚本里不能出现裸的 " 结束
        assert!(script.contains(r#"\"走\\\""#), "引号转义异常：{script}");
        assert!(script.contains(r"\\\\"), "反斜杠转义异常：{script}");
    }

    #[test]
    fn escapes_line_separators() {
        let script = build_comment_script("第一行\u{2028}第二行\u{2029}第三行").unwrap();
        assert!(script.contains("\\u2028"));
        assert!(script.contains("\\u2029"));
    }

    #[test]
    fn escapes_angle_brackets() {
        let script = build_comment_script("<script>alert(1)</script>").unwrap();
        assert!(!script.contains("<script>"), "尖括号应被转义");
        assert!(script.contains("\\u003cscript\\u003e"));
    }

    #[test]
    fn script_mentions_input_and_send_button() {
        let script = build_comment_script("今天这个视频讲得很清楚").unwrap();
        assert!(script.contains("contenteditable"));
        assert!(script.contains("发送"));
        assert!(script.contains("input\""));
        // 必须返回可解析的 JSON 结果
        assert!(script.contains("JSON.stringify"));
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let script = build_comment_script("  你好  ").unwrap();
        assert!(script.contains("\"你好\""));
    }

    #[test]
    fn prompt_uses_detail_content_without_template_comment() {
        let facts = normalize_facts(
            RawFacts {
                title: "小狗在春天散步".to_string(),
                description: "记录两只小狗在公园里追风筝的下午".to_string(),
                author: "线条小狗".to_string(),
                tags: vec!["小狗".to_string(), "春日".to_string()],
                url: "https://www.bilibili.com/video/BV1".to_string(),
                ..RawFacts::default()
            },
            Platform::Bilibili,
            1.0,
        )
        .expect("facts");
        let prompt = build_comment_prompt(&facts).expect("prompt");
        assert!(prompt.contains("小狗在春天散步"));
        assert!(prompt.contains("追风筝"));
        assert!(prompt.contains("只输出评论正文"));
        assert!(!prompt.contains("小狗看完记住啦"));
    }

    #[test]
    fn normalizes_model_comment_and_strips_marker() {
        let text = normalize_model_comment("评论：\"这段追风筝的镜头好有春天的感觉！\"\n<sticker:happy>").unwrap();
        assert_eq!(text, "这段追风筝的镜头好有春天的感觉！");
    }

    #[test]
    fn rejects_overlong_model_comment_without_fallback() {
        let error = normalize_model_comment(&"好".repeat(MAX_COMMENT_CHARS + 1)).unwrap_err();
        assert!(error.contains("过长"));
    }
}
