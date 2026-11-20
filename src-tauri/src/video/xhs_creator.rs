//! 小红书创作者中心「文字配图」自动填充：只填标题与小狗感悟正文，最后一步「发布」留给用户。
//!
//! 边界：
//! * 只在用户主动点「填入小红书创作者中心」时执行，不自动发布；
//! * 通过 CDP 操作已登录的专用浏览器；找不到入口/未登录/验证码时返回中文原因；
//! * 正文只填 `draft.dogTake`（小狗感悟），不填整篇 body。

use super::cdp::CdpSession;
use super::model::Platform;
use super::session;
use super::xhs_draft::XhsDraft;
use serde::Serialize;
use tauri::AppHandle;

pub const CREATOR_URL: &str = "https://creator.xiaohongshu.com/publish/publish?source=official";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillCreatorReport {
    pub ok: bool,
    pub title_filled: bool,
    pub body_filled: bool,
    /// content-preview / editor
    pub page: String,
    pub reason: String,
}

fn js_literal(text: &str) -> String {
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
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 填充脚本：切「上传图文」→ 点「文字配图」→ 填标题/正文（不点发布）。
pub fn build_fill_script(draft: &XhsDraft) -> String {
    format!(
        r#"(async function () {{
  var title = {};
  var body = {};
  var sleep = function (ms) {{ return new Promise(function (resolve) {{ setTimeout(resolve, ms); }}); }};
  function visible(el) {{
    if (!el) return false;
    var box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05;
  }}
  var roots = [];
  function deepAll(selector) {{
    var list = [];
    (function walk(root) {{
      if (!root || roots.indexOf(root) >= 0) return;
      roots.push(root);
      try {{
        var found = root.querySelectorAll ? root.querySelectorAll(selector) : [];
        for (var i = 0; i < found.length; i += 1) list.push(found[i]);
        var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var j = 0; j < all.length; j += 1) if (all[j].shadowRoot) walk(all[j].shadowRoot);
      }} catch (e) {{}}
    }})(document);
    return list;
  }}
  function byText(words) {{
    var nodes = deepAll('button, [role=button], div, span, a');
    for (var i = 0; i < nodes.length; i += 1) {{
      var node = nodes[i];
      if (!visible(node)) continue;
      var text = (node.textContent || '').trim();
      if (text.length > 20) continue;
      for (var w = 0; w < words.length; w += 1) {{
        if (text.indexOf(words[w]) >= 0) return node;
      }}
    }}
    return null;
  }}
  function setValue(input, value) {{
    input.focus();
    var proto = Object.getPrototypeOf(input);
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
    input.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }}
  function setEditable(editor, value) {{
    editor.focus();
    try {{ document.execCommand('selectAll', false, null); }} catch (e) {{}}
    var inserted = false;
    try {{ inserted = document.execCommand('insertText', false, value); }} catch (e) {{ inserted = false; }}
    if (!inserted) {{ editor.textContent = value; }}
    editor.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: value }}));
  }}

  var tab = byText(['上传图文']);
  if (tab) {{ tab.click(); await sleep(1200); }}
  var entry = byText(['文字配图', '文字生成图片', '文字生成']);
  if (!entry) {{
    return {{ ok: false, page: 'editor', reason: 'no-cover-entry', titleFilled: false, bodyFilled: false }};
  }}
  entry.click();
  await sleep(1500);
  var inputs = deepAll('input, textarea').filter(visible);
  var titleInput = null;
  for (var i = 0; i < inputs.length; i += 1) {{
    var placeholder = String(inputs[i].getAttribute('placeholder') || '');
    if (/标题|填写标题/.test(placeholder)) {{ titleInput = inputs[i]; break; }}
  }}
  if (!titleInput && inputs.length) titleInput = inputs[0];
  if (!titleInput) {{
    return {{ ok: false, page: 'editor', reason: 'no-title-input', titleFilled: false, bodyFilled: false }};
  }}
  setValue(titleInput, title);
  await sleep(300);
  var editors = deepAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]').filter(visible);
  var bodyEditor = null;
  for (var e = 0; e < editors.length; e += 1) {{
    if (editors[e] !== titleInput) {{ bodyEditor = editors[e]; }}
  }}
  if (!bodyEditor) {{
    return {{ ok: false, page: 'editor', reason: 'no-body-editor', titleFilled: true, bodyFilled: false }};
  }}
  if (bodyEditor.tagName === 'TEXTAREA') setValue(bodyEditor, body);
  else setEditable(bodyEditor, body);
  await sleep(600);
  return {{ ok: true, page: 'content-preview', reason: '', titleFilled: true, bodyFilled: true }};
}})()"#,
        js_literal(&draft.title),
        js_literal(&draft.dog_take)
    )
}

/// 读 draft.json 并填充创作者中心；不点发布。
pub async fn fill_creator(app: &AppHandle, draft_dir: &str) -> Result<FillCreatorReport, String> {
    let path = std::path::Path::new(draft_dir).join("draft.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("读不到 draft.json（{draft_dir}）：{error}"))?;
    let draft: XhsDraft = serde_json::from_str(&raw).map_err(|error| format!("draft.json 解析失败：{error}"))?;
    let port = session::engine(app).cdp_port();
    if port == 0 {
        return Err("浏览器还没打开：先点「开始」让小狗打开专用浏览器，再点填入（未登录请先登录小红书）".to_string());
    }
    let mut cdp = CdpSession::connect(port, Platform::Xiaohongshu)
        .await
        .map_err(|failure| format!("连不上专用浏览器：{failure:?}"))?;
    cdp.navigate(CREATOR_URL)
        .await
        .map_err(|failure| format!("打不开创作中心：{failure:?}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    let value = cdp
        .evaluate(&build_fill_script(&draft), std::time::Duration::from_secs(20))
        .await
        .map_err(|failure| format!("执行填充脚本失败：{failure:?}"))?;
    let report = FillCreatorReport {
        ok: value.get("ok").and_then(|item| item.as_bool()).unwrap_or(false),
        title_filled: value
            .get("titleFilled")
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
        body_filled: value
            .get("bodyFilled")
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
        page: value
            .get("page")
            .and_then(|item| item.as_str())
            .unwrap_or("editor")
            .to_string(),
        reason: value
            .get("reason")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string(),
    };
    session::engine(app).log_diagnostic(
        if report.ok { "info" } else { "warn" },
        "XHS_FILL_CREATOR",
        format!(
            "ok={} title={} bodyLen={} reason={} page={}",
            report.ok, report.title_filled, draft.dog_take.chars().count(), report.reason, report.page
        ),
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> XhsDraft {
        XhsDraft {
            title: "测试标题".to_string(),
            dog_take: "我趴在脚边看完了，想被摸摸头～".to_string(),
            ..XhsDraft::default()
        }
    }

    #[test]
    fn script_contains_text_and_never_clicks_publish() {
        let script = build_fill_script(&draft());
        assert!(script.contains("上传图文"));
        assert!(script.contains("文字配图"));
        assert!(script.contains("测试标题"));
        assert!(script.contains("我趴在脚边看完了"));
        // 只填内容，不能出现点击发布的语句。
        assert!(!script.contains("立即发布"));
        assert!(!script.contains("发布笔记"));
    }

    #[test]
    #[ignore]
    fn dump_fill_script_for_fixture() {
        let script = build_fill_script(&draft());
        let path = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("target")
            .join("xhs-fill-script.js");
        std::fs::write(path, script).expect("write script");
    }

    #[test]
    fn script_escapes_quotes() {
        let mut value = draft();
        value.title = "他说 \"走\"".to_string();
        let script = build_fill_script(&value);
        assert!(script.contains("\\\"走\\\""));
    }
}