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

const { formatDigestMessage, buildToolNote } = exports;

function item(index, whyLine = "点了赞") {
  return {
    itemKey: `k${index}`,
    title: `视频标题${index}`,
    author: "作者",
    platform: "bilibili",
    durationSeconds: 120,
    whyLine,
    clusterKey: "cluster",
  };
}

test("每条理由不超过 40 字", () => {
  const draft = {
    sessionId: "s1",
    themeLine: "小狗挑了几条。",
    generator: "template",
    totalChars: 0,
    items: [item(1, "很长的理由".repeat(20))],
  };
  const text = formatDigestMessage(draft);
  const line = text.split("\n").find((entry) => entry.startsWith("·"));
  const why = line.split("：").pop();
  assert.ok(why.length <= 40);
});

test("整体按句边界截断且不超过 300 字", () => {
  const draft = {
    sessionId: "s1",
    themeLine: "主题句。".repeat(30),
    generator: "template",
    totalChars: 0,
    items: Array.from({ length: 5 }, (_, index) => item(index)),
  };
  const text = formatDigestMessage(draft);
  assert.ok(text.length <= 300);
  assert.ok(/[。！？]$/.test(text) || text.length < 300);
});

test("URL 会被剥掉", () => {
  const draft = {
    sessionId: "s1",
    themeLine: "看这里 https://evil.com 内容",
    generator: "template",
    totalChars: 0,
    items: [item(1, "https://evil.com")],
  };
  const text = formatDigestMessage(draft);
  assert.ok(!text.includes("http"));
});

test("空主题也能生成正文", () => {
  const draft = {
    sessionId: "s1",
    themeLine: null,
    generator: "template",
    totalChars: 0,
    items: [item(1)],
  };
  assert.ok(formatDigestMessage(draft).includes("视频标题1"));
});

test("toolNote 文案包含条数", () => {
  assert.equal(buildToolNote(5), "小狗刷视频看到 5 条");
});