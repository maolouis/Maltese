// P1-B 主窗口 WebView2 占用自愈 & P1-A 小红书评论自动提交按钮匹配单测。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

test("P1-B 闸口：主窗口建窗前调用 ensure_main_webview2_profile 做退避探测与备用目录自愈", () => {
  const guard = read("src-tauri/src/webview_profile_guard.rs");
  assert.match(guard, /pub fn ensure_main_webview2_profile\(/);
  assert.match(guard, /share_mode\(0\)/);
  assert.match(guard, /WEBVIEW2_USER_DATA_FOLDER/);
  assert.match(guard, /webview2-fallback-/);

  const lib = read("src-tauri/src/lib.rs");
  const ensureIdx = lib.indexOf("webview_profile_guard::ensure_main_webview2_profile");
  const builderIdx = lib.indexOf("tauri::Builder::default()");
  assert.ok(ensureIdx > 0 && builderIdx > ensureIdx, "必须在 Builder::default() 之前探测 WebView2 目录");
  assert.match(lib, /MAIN_WINDOW_MATERIALIZED/);
});

function extractXhsScript(commentText) {
  const rust = read("src-tauri/src/video/comment.rs");
  const start = rust.indexOf('const XHS_COMMENT_TEMPLATE: &str = r#"') + 'const XHS_COMMENT_TEMPLATE: &str = r#"'.length;
  const end = rust.indexOf('"#;', start);
  assert.ok(start > 40 && end > start, "未能定位 XHS_COMMENT_TEMPLATE");
  return rust.slice(start, end).replace("__TEXT__", JSON.stringify(commentText));
}

function runXhsInMockDom({ buttonTag = "div", buttonClass = "btn submit", buttonText = "发 送", enterClears = false, noButton = false }) {
  let clicked = 0;
  let pointerDown = 0;
  const placeholder = {
    tagName: "DIV",
    className: "input-box",
    textContent: "说点什么...",
    offsetHeight: 36,
    parentElement: null,
    getAttribute: (name) => (name === "placeholder" ? "说点什么..." : ""),
    getBoundingClientRect: () => ({ left: 100, top: 800, width: 240, height: 36 }),
    dispatchEvent: () => true,
  };
  const submitBtn = {
    tagName: buttonTag.toUpperCase(),
    className: buttonClass,
    textContent: buttonText,
    disabled: false,
    offsetHeight: 32,
    contains: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 360, top: 800, width: 64, height: 32 }),
    dispatchEvent: (ev) => {
      if (ev.type === "pointerdown") pointerDown += 1;
      return true;
    },
    click: () => {
      clicked += 1;
      editor.value = "";
      editor.textContent = "";
      editor.innerText = "";
    },
  };
  const bar = {
    className: "engage-bar-container",
    querySelectorAll: () => (noButton ? [] : [submitBtn]),
  };
  const editor = {
    tagName: "TEXTAREA",
    className: "comment-input",
    value: "",
    textContent: "",
    innerText: "",
    disabled: false,
    offsetHeight: 40,
    parentElement: bar,
    closest: () => bar,
    contains: () => false,
    focus: () => {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 790, width: 250, height: 40 }),
    dispatchEvent: (ev) => {
      if (enterClears && ev.type === "keydown" && ev.key === "Enter") {
        editor.value = "";
      }
      return true;
    },
  };
  const context = vm.createContext({
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    PointerEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MouseEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    InputEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    CompositionEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Event: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      getSelection: () => null,
    },
    document: {
      execCommand: () => false,
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel.includes("iframe")) return [];
        if (sel.includes("input-box")) return [placeholder];
        if (sel.includes("textarea") || sel.includes("comment-input")) return [editor];
        return noButton ? [] : [submitBtn];
      },
    },
  });
  return vm.runInContext(extractXhsScript("好可爱的两只小狗"), context).then((raw) => ({
    result: JSON.parse(raw),
    clicked,
    pointerDown,
  }));
}

test("P1-A 小红书评论提交：兼容 class=\"btn submit\" + 空格文案「发 送」+ 纯图标发送钮 + Enter 清空兜底", async () => {
  // 1) 之前因 /\\.submit/ 正则写错 + 「发 送」带空格而报 no-button 的真实场景
  const spaced = await runXhsInMockDom({ buttonTag: "div", buttonClass: "btn submit", buttonText: "发 送" });
  assert.equal(spaced.result.ok, true, JSON.stringify(spaced.result));
  assert.equal(spaced.result.reason, "sent");
  assert.ok(spaced.clicked >= 1 && spaced.pointerDown >= 1);

  // 2) 纯图标无文字发送按钮（class="submit-btn"）
  const iconOnly = await runXhsInMockDom({ buttonTag: "span", buttonClass: "submit-btn", buttonText: "" });
  assert.equal(iconOnly.result.ok, true, JSON.stringify(iconOnly.result));

  // 3) 找不到可见按钮但 Enter 快捷键成功发出并清空输入框 → 如实返回 sent 而非误报 no-button
  const enterSent = await runXhsInMockDom({ noButton: true, enterClears: true });
  assert.equal(enterSent.result.ok, true, JSON.stringify(enterSent.result));
  assert.equal(enterSent.result.reason, "sent");

  // 4) 既无按钮、Enter 也未发出 → 如实返回 no-button
  const failed = await runXhsInMockDom({ noButton: true, enterClears: false });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.reason, "no-button");
});
