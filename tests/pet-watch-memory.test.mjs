import assert from "node:assert/strict";
import test from "node:test";
import {
  WATCH_DAILY_MAX,
  WATCH_DECAY_DAYS,
  WATCH_MAX,
  WATCH_TTL_DAYS,
  addWatchEntries,
  buildMemoryContext,
  clearMemory,
  decayWatch,
  emptyMemory,
  loadMemory,
  matchWatch,
  saveMemory,
  setWatchMemoryEnabled,
  watchEntryEligible,
  watchKey,
  watchMemoryEnabled,
} from "../src/petMemory.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00+08:00");

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function entry(url, title, extra = {}) {
  return {
    url,
    title,
    author: "作者",
    tags: ["编程", "教程", "多余标签", "第四个"],
    take: "讲得挺细",
    watchedSeconds: 120,
    watchedAt: NOW,
    ...extra,
  };
}

test("门槛：强兴趣/完成度/时长/digest 放行，弱条目跳过", () => {
  assert.equal(watchEntryEligible({ strong: true }).allowed, true);
  assert.equal(watchEntryEligible({ completionPercent: 60 }).allowed, true);
  assert.equal(watchEntryEligible({ watchedSeconds: 60 }).allowed, true);
  assert.equal(watchEntryEligible({ inDigest: true }).allowed, true);
  const weak = watchEntryEligible({ watchedSeconds: 20, completionPercent: 10 });
  assert.equal(weak.allowed, false);
  assert.equal(weak.reason, "weak");

  const memory = addWatchEntries(
    emptyMemory(NOW),
    [entry("https://b.com/video/W", "弱条目", { watchedSeconds: 5 }), entry("https://b.com/video/S", "强条目", { strong: true })],
    NOW,
  );
  assert.equal(memory.watch.length, 1);
  assert.equal(memory.watch[0].title, "强条目");
});

test("每日最多 20 条（按时长降序）、去重、字段清洗", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    entry(`https://b.com/video/D${index}`, `标题${index}`, { watchedSeconds: 60 + index }),
  );
  let memory = addWatchEntries(emptyMemory(NOW), many, NOW);
  assert.equal(memory.watch.length, WATCH_DAILY_MAX);
  assert.equal(memory.watch[0].watchedSeconds, 84);
  assert.equal(memory.watch[0].tags.length, 3);

  memory = addWatchEntries(memory, [entry("https://b.com/video/D24", "更新标题", { take: "新感悟", watchedAt: NOW + 1000 })], NOW + 1000);
  const item = memory.watch.find((row) => row.key === watchKey("https://b.com/video/D24"));
  assert.equal(item.title, "更新标题");
  assert.equal(item.take, "新感悟");
});

test("LRU 上限 200、90 天衰减、180 天淘汰", () => {
  const sameDay = Array.from({ length: 25 }, (_, index) => entry(`https://b.com/video/S${index}`, `标题${index}`));
  assert.equal(addWatchEntries(emptyMemory(NOW), sameDay, NOW).watch.length, WATCH_DAILY_MAX);

  const many = Array.from({ length: WATCH_MAX + 5 }, (_, index) =>
    entry(`https://b.com/video/BV${index}`, `标题${index}`, { watchedAt: NOW - (index % 11) * DAY }),
  );
  const memory = addWatchEntries(emptyMemory(NOW), many, NOW);
  assert.equal(memory.watch.length, WATCH_MAX);

  const old = entry("https://b.com/video/OLD", "老视频", { watchedAt: NOW - (WATCH_DECAY_DAYS + 1) * DAY });
  const expired = entry("https://b.com/video/GONE", "过期视频", { watchedAt: NOW - (WATCH_TTL_DAYS + 1) * DAY });
  const decayed = decayWatch([old, expired], NOW);
  assert.equal(decayed.length, 1);
  assert.equal(decayed[0].weight, 0.2);
});

test("关键词命中 top-3 与预算截断；无命中不注入", () => {
  let memory = emptyMemory(NOW);
  memory = addWatchEntries(
    memory,
    [
      entry("https://b.com/video/1", "Rust 编程教程", { tags: ["编程", "Rust"], take: "好懂" }),
      entry("https://b.com/video/2", "猫咪日常", { tags: ["宠物"], take: "可爱" }),
      entry("https://b.com/video/3", "前端调试技巧", { tags: ["编程", "前端"], take: "实用" }),
      entry("https://b.com/video/4", "美食探店", { tags: ["美食"], take: "馋" }),
    ],
    NOW,
  );
  const matched = matchWatch(memory.watch, "我想看编程的视频", 3);
  assert.ok(matched.length >= 2 && matched.length <= 3);
  assert.ok(matched.some((item) => item.title.includes("Rust")));

  const context = buildMemoryContext(memory, "normal", NOW, "编程");
  assert.ok(context && context.includes("看过："));
  assert.ok(context.includes("我当时的想法是"));
  assert.ok(context.length <= Math.floor(70 * 1.6));

  const noMatch = buildMemoryContext(memory, "normal", NOW, "量子物理");
  assert.ok(!noMatch || !noMatch.includes("看过："));
});

test("开关关闭不写入；清空同时清 watch", () => {
  const store = storage();
  assert.equal(watchMemoryEnabled(store), true);
  setWatchMemoryEnabled(false, store);
  assert.equal(watchMemoryEnabled(store), false);
  const memory = addWatchEntries(emptyMemory(NOW), [entry("https://b.com/video/9", "不该写入")], NOW, false);
  assert.equal((memory.watch ?? []).length, 0);

  saveMemory({ ...emptyMemory(NOW), watch: [{ kind: "watch", key: "k", title: "t", author: "", tags: [], take: "", watchedSeconds: 90, watchedAt: NOW, weight: 1 }] }, store);
  assert.equal((loadMemory(store).watch ?? []).length, 1);
  clearMemory(store);
  assert.equal((loadMemory(store).watch ?? []).length, 0);
});