import assert from "node:assert/strict";
import test from "node:test";
import {
  BUDGET_NORMAL_TOKENS,
  COMPACT_TURN_THRESHOLD,
  FACTS_MAX,
  MEMORY_STORAGE_KEY,
  RECENT_TURNS,
  buildMemoryContext,
  canRunMaintenance,
  clearMemory,
  compactPlan,
  emptyMemory,
  estimateTokens,
  loadMemory,
  loadMemoryDepth,
  mergeFacts,
  pruneSummaries,
  saveMemory,
  saveMemoryDepth,
  shouldCompact,
} from "../src/petMemory.ts";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("token 估算：中文与英文都非零且随长度增长", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("你好小狗") >= 2);
  assert.ok(estimateTokens("hello world") >= 2);
  assert.ok(estimateTokens("你好小狗，今天过得怎么样".repeat(5)) > estimateTokens("你好"));
});

test("compact 触发与保留计划", () => {
  assert.equal(shouldCompact(5, 100), false);
  assert.equal(shouldCompact(COMPACT_TURN_THRESHOLD + 1, 100), true);
  assert.equal(shouldCompact(5, 7000), true);
  assert.deepEqual(compactPlan(6), { keep: 6, toSummary: 0 });
  assert.deepEqual(compactPlan(20), { keep: 8, toSummary: 12 });
  assert.equal(RECENT_TURNS, 10);
});

test("事实去重：同 key 新值覆盖、按时间排序、上限 20", () => {
  const merged = mergeFacts(
    [{ key: "名字", value: "小明", confidence: 0.6, updatedAt: 100 }],
    [
      { key: "名字", value: "阿明", confidence: 0.9, updatedAt: 200 },
      { key: "喜好", value: "咖啡", confidence: 0.7, updatedAt: 150 },
      { key: "", value: "空 key 丢弃", confidence: 1, updatedAt: 300 },
    ],
  );
  const name = merged.find((fact) => fact.key === "名字");
  assert.equal(name.value, "阿明");
  assert.equal(name.confidence, 0.9);
  assert.equal(merged.length, 2);
  const many = mergeFacts(
    [],
    Array.from({ length: 30 }, (_, index) => ({ key: `k${index}`, value: "v", confidence: 0.5, updatedAt: index })),
  );
  assert.equal(many.length, FACTS_MAX);
});

test("摘要只保留 3 天且每天截断 200 字", () => {
  const now = Date.parse("2026-11-19T12:00:00");
  const kept = pruneSummaries(
    [
      { date: "2026-11-10", text: "太旧" },
      { date: "2026-11-18", text: "x".repeat(500) },
      { date: "2026-11-19", text: "今天聊了名字和咖啡" },
    ],
    now,
  );
  assert.ok(kept.every((item) => item.date !== "2026-11-10"));
  assert.equal(kept.find((item) => item.date === "2026-11-18").text.length, 200);
  assert.equal(kept.find((item) => item.date === "2026-11-19").text, "今天聊了名字和咖啡");
});

test("注入顺序与预算：事实在前、摘要随后；off 不注入；normal ≤70 token 对应字符预算", () => {
  const memory = {
    facts: [{ key: "名字", value: "小明", confidence: 0.9, updatedAt: 1 }],
    summaries: [{ date: new Date().toISOString().slice(0, 10), text: "今天聊了名字和咖啡" }],
    updatedAt: 1,
  };
  const context = buildMemoryContext(memory, "normal");
  assert.ok(context.startsWith("事实："));
  assert.ok(context.indexOf("事实：") < context.indexOf("最近："));
  assert.ok(context.length <= Math.floor(BUDGET_NORMAL_TOKENS * 1.6));
  assert.equal(buildMemoryContext(memory, "off"), null);
  assert.equal(buildMemoryContext(emptyMemory(), "normal"), null);
});

test("维护窗口：空闲 ≥30s 且没有在跑才能维护", () => {
  const now = 1_000_000;
  assert.equal(canRunMaintenance(now, now - 31_000, false), true);
  assert.equal(canRunMaintenance(now, now - 10_000, false), false);
  assert.equal(canRunMaintenance(now, now - 60_000, true), false);
});

test("存储与清空：读写一致，清空后为空；记忆深度默认 normal", () => {
  const storage = memoryStorage();
  const memory = {
    facts: [{ key: "喜好", value: "咖啡", confidence: 0.8, updatedAt: 1 }],
    summaries: [{ date: "2026-11-19", text: "聊了咖啡" }],
    updatedAt: 1,
  };
  saveMemory(memory, storage);
  assert.equal(loadMemory(storage).facts.length, 1);
  assert.ok(storage.getItem(MEMORY_STORAGE_KEY));
  clearMemory(storage);
  assert.equal(loadMemory(storage).facts.length, 0);
  assert.equal(loadMemoryDepth(storage), "normal");
  saveMemoryDepth("deep", storage);
  assert.equal(loadMemoryDepth(storage), "deep");
});