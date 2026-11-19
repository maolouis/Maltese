import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMaintenance,
  buildMaintenancePrompt,
  parseMaintenanceReply,
  resetMaintenanceState,
  scheduleMemoryMaintenance,
} from "../src/petMemoryMaintenance.ts";
import { emptyMemory } from "../src/petMemory.ts";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("维护 prompt：只包含对话与 JSON 约束", () => {
  const prompt = buildMaintenancePrompt([
    { role: "user", text: "我叫小明，喜欢咖啡" },
    { role: "assistant", text: "记住啦" },
  ]);
  assert.ok(prompt.includes("主人：我叫小明"));
  assert.ok(prompt.includes("facts"));
  assert.ok(prompt.includes("JSON"));
});

test("解析模型输出：容错 JSON 围栏，摘要截断 200 字，事实最多 3 条", () => {
  const parsed = parseMaintenanceReply(
    '```json\n{"summary":"' + "很长的摘要".repeat(100) + '","facts":[' +
      '{"key":"名字","value":"小明","confidence":0.9},' +
      '{"key":"喜好","value":"咖啡"},{"key":"在做","value":"写代码"},{"key":"多余","value":"丢弃"}]}\n```',
  );
  assert.ok(parsed);
  assert.equal(parsed.summary.length, 200);
  assert.equal(parsed.facts.length, 3);
  assert.equal(parsed.facts[1].confidence, 0.6);
});

test("解析失败返回 null（坏 JSON / 空 JSON）", () => {
  assert.equal(parseMaintenanceReply("模型胡说"), null);
  assert.equal(parseMaintenanceReply("{bad json}"), null);
  assert.equal(parseMaintenanceReply('{"summary":"","facts":[]}'), null);
});

test("应用维护：当日摘要保留、旧摘要淘汰、事实按 key 合并", () => {
  const now = Date.parse("2026-11-19T12:00:00");
  const seeded = {
    facts: [{ key: "名字", value: "旧名字", confidence: 0.5, updatedAt: 1 }],
    summaries: [{ date: "2026-11-01", text: "太旧" }],
    updatedAt: 1,
  };
  const next = applyMaintenance(
    seeded,
    { summary: "今天聊了名字和咖啡", facts: [{ key: "名字", value: "小明", confidence: 0.9 }] },
    now,
  );
  assert.equal(next.facts.find((fact) => fact.key === "名字").value, "小明");
  assert.equal(next.summaries.length, 1);
  assert.equal(next.summaries[0].text, "今天聊了名字和咖啡");
});

test("调度：消息不足 8 条不排期；busy / 近期有用户消息 / 未到 idle 都不调用模型", async () => {
  resetMaintenanceState();
  const storage = memoryStorage();
  const calls = [];
  const messages = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `m${index}` }));
  const fire = (options) => {
    let handler = null;
    scheduleMemoryMaintenance({
      messages,
      isBusy: () => false,
      lastUserAt: () => Date.now() - 60_000,
      callModel: async (prompt) => {
        calls.push(prompt);
        return '{"summary":"聊了名字和咖啡","facts":[{"key":"名字","value":"小明","confidence":0.9}]}';
      },
      idleMs: 0,
      setTimeoutFn: (callback) => {
        handler = callback;
        return 1;
      },
      clearTimeoutFn: () => undefined,
      ...options,
    });
    return handler;
  };

  // 不足 8 条：不排期
  let handler = null;
  scheduleMemoryMaintenance({
    messages: messages.slice(0, 3),
    isBusy: () => false,
    lastUserAt: () => 0,
    callModel: async () => "",
    idleMs: 0,
    setTimeoutFn: (callback) => { handler = callback; return 1; },
    clearTimeoutFn: () => undefined,
  });
  assert.equal(handler, null);
  assert.equal(calls.length, 0);

  // busy：到点也不调用
  handler = fire({ isBusy: () => true });
  handler();
  assert.equal(calls.length, 0);

  // 近期有用户消息：不调用
  handler = fire({ lastUserAt: () => Date.now() - 1_000 });
  handler();
  assert.equal(calls.length, 0);

  // 正常：调用模型并写回记忆（fake storage 由真实 localStorage 承担，这里只断言调用次数）
  handler = fire({});
  handler();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  resetMaintenanceState();
});