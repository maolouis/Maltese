import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("../src/plugins/video/types.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const exports = {};
runInNewContext(source, { exports, Date, console });

const { isVideoSnapshot, isDigestDraft, errorMessageForCode } = exports;

function validSnapshot() {
  return {
    sessionId: "bili-20261114-abc123",
    provider: "bilibili",
    accountId: null,
    autoComment: false,
    phase: "collecting",
    running: true,
    intervalSeconds: 45,
    maxMinutes: 30,
    steps: 3,
    itemCount: 12,
    strongCount: 2,
    filteredCount: 0,
    startedAt: 100,
    endedAt: null,
    lastActionAt: 120,
    currentUrl: "https://www.bilibili.com/video/BV1",
    waitingForBrowser: false,
    foregroundTitle: "标题",
    foregroundProcess: "chrome.exe",
    channel: {
      type: "cdp",
      capability: "full",
      lastSuccessAt: 120,
      failureReason: null,
      retryCount: 0,
      degradedReason: null,
    },
    pendingCount: 0,
    persistFailed: false,
    degraded: false,
    errorCode: null,
    error: null,
  };
}

test("合法快照通过", () => {
  assert.equal(isVideoSnapshot(validSnapshot()), true);
});

test("缺少 phase 被拒绝", () => {
  const value = validSnapshot();
  delete value.phase;
  assert.equal(isVideoSnapshot(value), false);
});

test("未知平台被拒绝", () => {
  assert.equal(isVideoSnapshot({ ...validSnapshot(), provider: "youtube" }), false);
});

test("多余字段被容忍", () => {
  assert.equal(isVideoSnapshot({ ...validSnapshot(), extra: "ignored" }), true);
});

test("非对象被拒绝", () => {
  assert.equal(isVideoSnapshot(null), false);
  assert.equal(isVideoSnapshot("text"), false);
});

test("合法小结通过、缺 items 被拒绝", () => {
  const draft = {
    sessionId: "s1",
    themeLine: "主题",
    generator: "template",
    items: [
      {
        itemKey: "k",
        title: "标题",
        author: null,
        platform: "bilibili",
        durationSeconds: 60,
        whyLine: "点了赞",
        clusterKey: "c",
      },
    ],
    totalChars: 10,
  };
  assert.equal(isDigestDraft(draft), true);
  assert.equal(isDigestDraft({ ...draft, items: undefined }), false);
});

test("错误码有中文文案", () => {
  assert.ok(errorMessageForCode("BROWSER_UNAVAILABLE", "fallback").includes("Chrome"));
  assert.equal(errorMessageForCode(null, "fallback"), "fallback");
});
