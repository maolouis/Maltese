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
/// 思考模式下正文预算至少 = 思考预算 + 256（否则思考吃光预算导致正文为空）。
pub fn effective_comment_max_tokens(thinking: bool, reasoning_budget: u32, requested: u32) -> u32 {
    if thinking {
        requested.max(reasoning_budget.saturating_add(256))
    } else {
        requested
    }
}

/// 评论禁用语（AI 腔/博主腔/空话）：命中就重写。
pub const COMMENT_FORBIDDEN: [&str; 14] = [
    "这种缘分",
    "太奇妙",
    "默契配合",
    "让人感慨",
    "值得",
    "不得不说",
    "总体而言",
    "真的很有意义",
    "心情复杂",
    "感到震撼",
    "治愈了",
    "狠狠共鸣",
    "DNA动了",
    "谁懂啊",
];

/// 评论是否完整句：以中文/英文句末标点结尾（或波浪号/省略号）。
pub fn comment_is_complete(text: &str) -> bool {
    text.trim()
        .chars()
        .last()
        .map(|ch| matches!(ch, '。' | '！' | '？' | '!' | '?' | '～' | '~' | '…' | '.'))
        .unwrap_or(false)
}

/// 截到最后一个完整句（绝不发半句）。
pub fn trim_to_complete_sentence(text: &str) -> String {
    let trimmed = text.trim();
    if comment_is_complete(trimmed) {
        return trimmed.to_string();
    }
    let mut end = 0usize;
    for (index, ch) in trimmed.char_indices() {
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '～' | '~' | '…') {
            end = index + ch.len_utf8();
        }
    }
    trimmed[..end].trim().to_string()
}

/// 评论命中禁用语时返回该词。
pub fn comment_forbidden_hit(text: &str) -> Option<&'static str> {
    COMMENT_FORBIDDEN
        .iter()
        .find(|word| text.contains(*word))
        .copied()
}

/// 生成结果（供 COMMENT_GEN 日志）。
#[derive(Clone, Debug, Default)]
pub struct CommentGeneration {
    pub text: String,
    pub thinking: bool,
    pub attempts: u32,
    /// 是否因截断被截到完整句。
    pub truncated: bool,
    pub duration_ms: u128,
}

fn comment_quality_issue(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return Some("empty".to_string());
    }
    let count = text.chars().count();
    if count > MAX_COMMENT_CHARS {
        return Some("too-long".to_string());
    }
    if let Some(word) = comment_forbidden_hit(text) {
        return Some(format!("forbidden:{word}"));
    }
    if !comment_is_complete(text) {
        return Some("truncated".to_string());
    }
    Some("ok".to_string()).filter(|value| value == "ok").map(|_| None).unwrap_or_else(|| None)
}

fn quality_ok(text: &str) -> bool {
    !text.trim().is_empty() && comment_forbidden_hit(text).is_none() && comment_is_complete(text)
}

/// 把视频详情页事实整理成模型提示词（小狗人设 + few-shot + 20–40 字完整句）。
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
        "你是 Maltese 桌宠小狗（小白/小鸡毛），不是运营、不是编辑。\n人设：",
    );
    prompt.push_str(crate::local_chat::PERSONA_SUFFIX);
    prompt.push_str(
        "\n请读下面的视频事实，用小狗第一人称写一条 20–40 字的简体中文评论。\n\
要求：\n\
1. 必须是完整句，结尾有标点（。！？～…），不要半句；\n\
2. 要带具体小动作或小心思：趴着看、想被摸头、想吃、看不懂但觉得厉害、尾巴摇起来；\n\
3. 口语化、短句，可以有一个可爱的语气词；\n\
4. 不要 AI 腔/博主腔，不要出现这些词：这种缘分、太奇妙、默契配合、让人感慨、值得、不得不说、总体而言、真的很有意义、心情复杂、感到震撼；\n\
5. 只输出评论正文，不要前缀、引号、Markdown、解释。\n\
示例：\n\
好：我趴在脚边看完了，尾巴一直没停过～你们打配合的样子好帅呀\n\
坏：一觉醒来就能看见队友头上的数字，这种缘分太奇妙啦，看着大家这么默契配合，感觉心里……（太长、AI 腔、且没写完）\n\
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

async fn call_comment_model(
    app: &AppHandle,
    prompt: &str,
    model: &VideoCommentModelConfig,
    thinking: bool,
) -> Result<String, String> {
    match model.backend.trim() {
        "local" => crate::local_chat::generate_video_comment(
            model.base_url.clone(),
            model.model.clone(),
            model.api_key.clone(),
            prompt.to_string(),
            model.character.clone(),
            effective_comment_max_tokens(thinking, 512, model.max_tokens.unwrap_or(160)),
            model.temperature.unwrap_or(0.7),
            model.top_p.unwrap_or(0.9),
            thinking,
            512,
        )
        .await,
        "dsh" | "" => {
            crate::dsh_chat::generate_video_comment(app.clone(), prompt.to_string(), model.character.clone())
                .await
        }
        backend => Err(format!("不支持的评论模型后端：{backend}")),
    }
}

/// 生成小狗评论：深度思考（可关）+ 20–40 字完整句 + 禁用语重写/截句兜底。
pub async fn generate_quality_comment(
    app: &AppHandle,
    facts: &PageFacts,
    model: &VideoCommentModelConfig,
) -> Result<CommentGeneration, String> {
    let prompt = build_comment_prompt(facts).ok_or_else(|| "视频标题为空，无法生成评论".to_string())?;
    let started = std::time::Instant::now();
    let mut thinking = model.thinking;
    let mut attempts = 0u32;
    let mut last_raw = String::new();
    for attempt in 0..2 {
        attempts = attempt + 1;
        let raw = call_comment_model(app, &prompt, model, thinking).await?;
        last_raw = raw.clone();
        let text = normalize_model_comment(&raw)?;
        if quality_ok(&text) {
            return Ok(CommentGeneration {
                text,
                thinking,
                attempts,
                truncated: false,
                duration_ms: started.elapsed().as_millis(),
            });
        }
        if attempt == 0 {
            if comment_forbidden_hit(&text).is_some() {
                // 禁用语：重写时把命中的词再强调一遍。
            } else if !comment_is_complete(&text) {
                // 截断：放大 token 预算重试。
            } else if text.trim().is_empty() {
                thinking = false;
            }
        }
    }
    let text = normalize_model_comment(&last_raw)?;
    if !comment_is_complete(&text) {
        let trimmed = trim_to_complete_sentence(&text);
        if trimmed.chars().count() >= 8 {
            return Ok(CommentGeneration {
                text: trimmed,
                thinking,
                attempts,
                truncated: true,
                duration_ms: started.elapsed().as_millis(),
            });
        }
        return Err("评论生成被截断且无法截出完整句，已跳过".to_string());
    }
    Err("评论含禁用语或质量不达标，已跳过".to_string())
}

/// 校验 + 拼装脚本。返回 Err 时说明为什么不能发。
/// 评论区 DOM 脚本模板：
/// 1) 评论区懒加载 → scrollIntoView + 等 1.2s；
/// 2) B 站评论框是点击态 → 先点占位元素展开编辑器；
/// 3) 找 textarea / contenteditable；
/// 4) 原生 setter + input/beforeinput/compositionend 写值；
/// 5) 找发送按钮并点击。
/// 失败原因细分：no-comment-section / no-editor / no-input / no-button。
const COMMENT_SCRIPT_TEMPLATE: &str = r#"(async function () {
  var text = __TEXT__;
  var sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  function visible(el) {
    if (!el) return false;
    var box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 14) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05;
  }
  // B 站2026评论区是 <bili-comments> web component（shadow DOM 包裹），普通 querySelector 进不去。
  function deepAll(selector) {
    var out = [];
    var roots = [];
    (function walk(root) {
      if (!root || roots.indexOf(root) >= 0) return;
      roots.push(root);
      try {
        var found = root.querySelectorAll ? root.querySelectorAll(selector) : [];
        for (var i = 0; i < found.length; i += 1) out.push(found[i]);
        var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var j = 0; j < all.length; j += 1) {
          if (all[j].shadowRoot) walk(all[j].shadowRoot);
        }
      } catch (e) {}
    })(document);
    return out;
  }
  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = deepAll(selectors[i]);
      for (var j = 0; j < nodes.length; j += 1) {
        if (visible(nodes[j])) return nodes[j];
      }
    }
    return null;
  }
  var SECTION_SELECTORS = ['#commentapp', 'bili-comments', '.comment-container', '.comments-container', '.comment-list', '[class*="comment-container"]', '[data-e2e="comment"]', '#comment', '.reply-tools', '.comment-wrapper', '.comment'];
  var debugInfo = function (label) {
    try {
      var editable = deepAll('[contenteditable="true"]').length;
      var textarea = deepAll('textarea').length;
      var box = deepAll('.reply-box, [class*="editor"], [class*="comment"], bili-comments, #commentapp')[0] || null;
      var html = box ? String(box.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300) : '';
      return label + ' section=' + Boolean(section) + ' editable=' + editable + ' textarea=' + textarea + ' html=' + html;
    } catch (e) {
      return label;
    }
  };
  // 1) 评论区是懒加载的：先滚到位置，等 1.2s 让 DOM 渲染。
  var section = firstVisible(SECTION_SELECTORS);
  if (section) {
    try { section.scrollIntoView({ block: 'center' }); } catch (e) {}
  }
  await sleep(1200);
  section = section || firstVisible(SECTION_SELECTORS);
  if (!section) {
    // 评论区懒加载：滚到底再等一次，仍没有则继续尝试找输入框（不直接失败）。
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
    await sleep(1800);
    section = firstVisible(SECTION_SELECTORS);
  }
  // 评论区可能刚渲染：再等一次并滚到可见位置。
  await sleep(600);
  // 未登录时评论区只显示「登录后参与评论」，没有输入框：直接给出可执行原因。
  var sectionText = (section && section.textContent) || (document.body && document.body.innerText) || '';
  var loginGate = /登录后参与评论|请先登录|登录后查看|扫码登录/.test(sectionText.slice(0, 4000));
  // 2) B 站评论框默认是「点击态」：先点占位元素展开真正的编辑器。
  var placeholderSelectors = [
    '.reply-box .input-area',
    '.reply-box [class*="input"]',
    '[class*="publish"] [class*="input"]',
    '[class*="publish"]',
    '.reply-box',
    '[class*="comment-input"]',
    '[class*="editor"]',
    '#comment [class*="input"]'
  ];
  var placeholder = firstVisible(placeholderSelectors);
  if (!placeholder) {
    var candidates = deepAll('[contenteditable="false"], .reply-box, [class*="input-area"], [class*="comment-box"]');
    for (var i = 0; i < candidates.length; i += 1) {
      var node = candidates[i];
      if (!visible(node)) continue;
      if (/发一条友善的评论|善意的评论|说点什么|写评论|评论一下|留下你的评论/.test(node.textContent || "")) { placeholder = node; break; }
    }
  }
  if (placeholder) {
    try { placeholder.click(); } catch (e) {}
    try { placeholder.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); placeholder.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); } catch (e) {}
    await sleep(1500);
  }
  // 3) 真正的输入框：textarea / contenteditable=true / comment-input。
  var inputSelectors = [
    '.comments-container [contenteditable="true"]',
    '.comment-input',
    '[class*="input-box"] [contenteditable="true"]',
    '.reply-box [contenteditable="true"]',
    '[class*="comment"] [contenteditable="true"]',
    'div[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    'textarea',
    '[class*="comment-input"]',
    '[class*="editor"] [contenteditable="true"]',
    '.bili-comment [contenteditable="true"]'
  ];
  var inputs = [];
  for (var k = 0; k < inputSelectors.length; k += 1) {
    var found = deepAll(inputSelectors[k]);
    for (var m = 0; m < found.length; m += 1) {
      var el = found[m];
      if (!visible(el)) continue;
      if (el.closest('header, nav, [class*="search" i]')) continue;
      if (inputs.indexOf(el) < 0) inputs.push(el);
    }
  }
  var scoped = inputs.filter(function (el) {
    return Boolean(el.closest('#commentapp, .comment-container, [class*="comment" i], [class*="reply" i], form'));
  });
  var input = scoped.length ? scoped[scoped.length - 1] : inputs[inputs.length - 1];
  if (!input) {
    if (loginGate) {
      return JSON.stringify({ ok: false, reason: "login-required", message: "评论区要求登录：先在小狗专用窗口登录 B 站，这条先没评" });
    }
    return JSON.stringify({ ok: false, reason: "no-editor", message: "评论区已展开，但没找到输入框 | " + debugInfo("no-editor") });
  }
  input.focus();
  try { input.click(); } catch (e) {}
  await sleep(200);
  // 4) 写值：原生 setter + input/compositionend；contenteditable 用 insertText/beforeinput。
  if (input.tagName === "TEXTAREA") {
    var proto = Object.getPrototypeOf(input);
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    try { document.execCommand("selectAll", false, null); } catch (e) {}
    var inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (e) { inserted = false; }
    if (!inserted) {
      input.textContent = text;
    }
    try {
      input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } catch (e) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    try {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
    } catch (e) {}
  }
  await sleep(300);
  // 5) 提交：快捷键 → 按钮（含完整指针序列）→ 诊断 → 登录态 API 兜底。
  var attempts = [];
  var lastDisabled = false;
  var diag = {
    buttonHtml: "",
    hitElement: "",
    captcha: false,
    activeInEditor: false,
    pointerSent: false,
    apiCode: null,
    apiMessage: "",
    apiError: "",
    listVerified: false,
    replyCount: 0,
  };
  var editorTextNow = function () {
    var editors = deepAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]').filter(visible);
    if (!editors.length) return "";
    var editor = editors[editors.length - 1];
    return (editor.tagName === "TEXTAREA" ? editor.value : (editor.innerText || editor.textContent || "")).trim();
  };
  try { input.focus(); } catch (e) {}
  for (var shortcut = 0; shortcut < 2; shortcut += 1) {
    var keydown = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    if (shortcut === 0) keydown.ctrlKey = true;
    try { input.dispatchEvent(new KeyboardEvent("keydown", keydown)); } catch (e) {}
    await sleep(700);
    if (editorTextNow() === "") { attempts.push(shortcut === 0 ? "ctrl-enter" : "enter"); break; }
  }
  if (editorTextNow() !== "") {
    var words = ["发布", "发送", "评论", "回复"];
    var candidates = deepAll('button, [role=button], .reply-send');
    var ranked = [];
    for (var b = 0; b < candidates.length; b += 1) {
      var candidate = candidates[b];
      if (!visible(candidate)) continue;
      var className = String(candidate.className || "");
      var label = (candidate.textContent || "").trim();
      if (/bpx-player|sending-area|danmaku|player-|search/i.test(className)) continue;
      var isSendClass = /reply-send/i.test(className);
      var labelMatches = label.length > 0 && label.length <= 8 && words.some(function (word) { return label.indexOf(word) >= 0; });
      if (!isSendClass && !labelMatches) continue;
      var scope = candidate.closest('#commentapp, bili-comments, .comment-container, [class*="comment" i], [class*="reply" i], form');
      var score = (labelMatches ? 2 : 0) + (isSendClass ? 3 : 0) + (scope ? 2 : 0);
      ranked.push({ node: candidate, score: score, name: className || candidate.tagName, label: label });
    }
    ranked.sort(function (a, b) { return b.score - a.score; });
    var button = ranked.length ? ranked[0].node : null;
    if (button) {
      lastDisabled = Boolean(button.disabled) || button.getAttribute("aria-disabled") === "true";
      diag.buttonHtml = String(button.outerHTML || "").slice(0, 200);
      try {
        var rect = button.getBoundingClientRect();
        var hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        diag.hitElement = hit ? (hit.tagName + "." + String(hit.className || "").slice(0, 80)) : "none";
      } catch (e) {}
      try {
        diag.captcha = Boolean(document.querySelector('.bili-captcha, [class*="captcha"], .geetest_panel'));
      } catch (e) {}
      try {
        var active = document.activeElement;
        diag.activeInEditor = Boolean(active) && (active === input || (input.contains && input.contains(active)));
      } catch (e) {}
      try { button.scrollIntoView({ block: "center" }); } catch (e) {}
      await sleep(100);
      try {
        var center = button.getBoundingClientRect();
        var point = { x: center.left + center.width / 2, y: center.top + center.height / 2 };
        var events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
        for (var e = 0; e < events.length; e += 1) {
          var kind = events[e];
          var ctor = kind.indexOf("pointer") === 0 ? PointerEvent : MouseEvent;
          button.dispatchEvent(new ctor(kind, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0 }));
          await sleep(60);
        }
        diag.pointerSent = true;
      } catch (e) {}
      attempts.push("pointer-sequence:" + String(ranked[0].name).slice(0, 40));
      await sleep(800);
    }
  }
  // 仍未清空编辑器：登录态下用页面内 fetch 调 /x/v2/reply/add（诊断 + 兜底）。
  if (editorTextNow() !== "") {
    try {
      var csrfMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
      var csrf = csrfMatch ? csrfMatch[1] : "";
      var state = window.__INITIAL_STATE__ || {};
      var aid = (state.videoData && state.videoData.aid) || state.aid || 0;
      var oid = String(aid || "");
      if (csrf && oid) {
        var form = new URLSearchParams();
        form.set("oid", oid);
        form.set("type", "1");
        form.set("message", text);
        form.set("csrf", csrf);
        form.set("plat", "1");
        var response = await fetch("https://api.bilibili.com/x/v2/reply/add", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        var data = await response.json();
        diag.apiCode = data.code;
        diag.apiMessage = data.message || "";
        if (data.code === 0) {
          await sleep(1200);
          try {
            var listUrl = "https://api.bilibili.com/x/v2/reply?oid=" + encodeURIComponent(oid) + "&type=1&pn=1&ps=20&sort=2";
            var listData = await (await fetch(listUrl, { credentials: "include" })).json();
            var replies = (listData.data && listData.data.replies) || [];
            diag.replyCount = replies.length;
            diag.listVerified = replies.some(function (item) {
              var message = String((item.content && item.content.message) || "");
              return message.indexOf(text.slice(0, 12)) >= 0;
            });
          } catch (e) {}
        }
      } else {
        diag.apiError = "missing-csrf-or-oid";
      }
    } catch (e) {
      diag.apiError = String(e).slice(0, 100);
    }
  }
  return JSON.stringify({
    ok: true,
    reason: "sent",
    message: "评论已提交",
    detail: {
      clicked: attempts.join("+"),
      disabled: lastDisabled,
      editorCleared: editorTextNow() === "",
      diag: diag,
    },
  });
})()"#;

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
    Ok(COMMENT_SCRIPT_TEMPLATE.replace("__TEXT__", &literal))
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
    fn thinking_max_tokens_is_at_least_budget_plus_256() {
        assert!(effective_comment_max_tokens(true, 512, 160) >= 512 + 256);
        assert_eq!(effective_comment_max_tokens(false, 512, 160), 160);
    }

    #[test]
    fn detects_truncated_comment_and_trims_to_complete_sentence() {
        // 用户这条就是被截断的：结尾没有标点。
        let truncated = "一觉醒来就能看见队友头上的数字，这种缘分太奇妙啦。看着大家这么默契配合，感觉心里";
        assert!(!comment_is_complete(truncated));
        assert_eq!(
            trim_to_complete_sentence(truncated),
            "一觉醒来就能看见队友头上的数字，这种缘分太奇妙啦。"
        );
        assert!(comment_is_complete("我趴在脚边看完了，尾巴一直没停过～"));
    }

    #[test]
    fn forbidden_phrases_are_detected() {
        assert_eq!(
            comment_forbidden_hit("这种缘分太奇妙啦，默契配合真好"),
            Some("这种缘分")
        );
        assert!(comment_forbidden_hit("我趴在脚边看完了，尾巴一直没停过～").is_none());
    }

    #[test]
    fn prompt_has_persona_fewshot_and_forbidden_words() {
        let facts = normalize_facts(
            RawFacts {
                title: "测试视频".to_string(),
                description: "两个队友配合打游戏".to_string(),
                author: "作者".to_string(),
                tags: vec!["游戏".to_string()],
                url: "https://www.bilibili.com/video/BV1xx411c7mD".to_string(),
                duration_seconds: 60,
                position_seconds: 10,
                playing: true,
                visible: true,
                ..RawFacts::default()
            },
            Platform::Bilibili,
            1.0,
        )
        .expect("facts");
        let prompt = build_comment_prompt(&facts).expect("prompt");
        assert!(prompt.contains("趴着看") || prompt.contains("我趴在脚边"));
        assert!(prompt.contains("这种缘分")); // bad 示例里的禁用语
        assert!(prompt.contains("20–40"));
    }

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
    fn script_handles_bilibili_shadow_dom_and_reason_codes() {
        let script = build_comment_script("测试评论").unwrap();
        // B 站评论区是 <bili-comments> web component：必须穿透 shadowRoot。
        assert!(script.contains("bili-comments"));
        assert!(script.contains(".comments-container"));
        assert!(script.contains(".submit"));
        assert!(script.contains("shadowRoot"));
        assert!(script.contains("deepAll"));
        // 失败原因细分（便于日志定位是评论区/编辑器/输入框/按钮哪一步）。
        assert!(script.contains("bili-comments"));
        assert!(script.contains("no-editor"));
        assert!(script.contains("no-editor"));
        assert!(script.contains("login-required"));
        // 点击态展开 + 写入事件 + 发送后 300ms 再点。
        assert!(script.contains("发一条友善的评论"));
        assert!(script.contains("compositionend"));
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
