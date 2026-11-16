import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("../src/videoDelivery.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const exports = {};
runInNewContext(source, { exports, Date, console });

const { canDeliverNow, formatDigestMessage, buildToolNote } = exports;

const base = {
  proactiveLevel: 60,
  plan: { quietHours: null },
  idleSeconds: 300,
  isFullscreen: false,
  foregroundKind: "other",
  deliveredToday: 0,
  dailyLimit: 2,
  now: new Date(2026, 0, 1, 12, 0, 0).getTime(),
};

test("允许投递", () => {
  assert.equal(canDeliverNow(base).allowed, true);
});

test("主动程度 0 直接拒绝", () => {
  assert.equal(canDeliverNow({ ...base, proactiveLevel: 0 }).allowed, false);
});

test("免打扰时段拒绝", () => {
  const now = new Date(2026, 0, 1, 3, 0, 0).getTime();
  assert.equal(
    canDeliverNow({ ...base, now, plan: { quietHours: [0, 7] } }).allowed,
    false,
  );
});

test("空闲不足 120 秒拒绝", () => {
  assert.equal(canDeliverNow({ ...base, idleSeconds: 119 }).allowed, false);
});

test("全屏拒绝", () => {
  assert.equal(canDeliverNow({ ...base, isFullscreen: true }).allowed, false);
});

test("会议或游戏拒绝", () => {
  assert.equal(canDeliverNow({ ...base, foregroundKind: "meeting" }).allowed, false);
  assert.equal(canDeliverNow({ ...base, foregroundKind: "game" }).allowed, false);
});

test("日限已达拒绝", () => {
  assert.equal(canDeliverNow({ ...base, deliveredToday: 2 }).allowed, false);
});

test("小结文本不超 300 字且不含 URL", () => {
  const draft = {
    sessionId: "s1",
    themeLine: "小狗刷到 3 条你可能感兴趣的。",
    generator: "template",
    totalChars: 0,
    items: Array.from({ length: 5 }, (_, index) => ({
      itemKey: `k${index}`,
      title: `标题${index}`.repeat(20),
      author: "作者",
      platform: "bilibili",
      durationSeconds: 60,
      whyLine: " https://evil.com 点了赞 ",
      clusterKey: "c",
    })),
  };
  const text = formatDigestMessage(draft);
  assert.ok(text.length <= 300);
  assert.ok(!/https?:\/\//.test(text));
});

test("toolNote 带条数", () => {
  assert.ok(buildToolNote(3).includes("3 条"));
});