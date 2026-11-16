//! 「在视频下评论」：把用户写好的评论输入到当前视频页面的评论框并提交。
//!
//! 边界（重要）：
//! * 只有在用户点「发送」时才会执行，插件从不自动评论、不自动点赞关注；
//! * 只操作当前前台视频页里可见的评论输入框，找不到就返回明确原因，不做重试刷屏；
//! * 文本长度 1–200 字符，会被转义成 JS 字符串字面量，避免注入。
//!
//! 本模块只保留纯逻辑（脚本拼装 + 校验），真实执行由 `session` 侧的 CDP 完成，
//! 这样脚本可以脱离 Tauri 单独用 `rustc --test` 验证。

/// 评论长度上限：B 站/抖音评论框对长文本会折叠，超过就没有意义了。
pub const MAX_COMMENT_CHARS: usize = 200;

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
}