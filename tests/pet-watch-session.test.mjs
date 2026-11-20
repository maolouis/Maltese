import assert from "node:assert/strict";
import test from "node:test";
import {
  addWatchEntries,
  emptyMemory,
  watchEntriesFromSession,
} from "../src/petMemory.ts";

const NOW = Date.parse("2026-11-20T15:00:00+08:00");

const session = {
  items: [
    {
      itemKey: "strong-1",
      title: "强兴趣视频",
      author: "UP1",
      canonicalUrl: "https://www.bilibili.com/video/BVstrong",
      watchedSeconds: 10,
      completionPercent: 20,
      verdict: { level: "strong" },
    },
    {
      itemKey: "watched-1",
      title: "看了很久的视频",
      author: "UP2",
      canonicalUrl: "https://www.bilibili.com/video/BVwatched",
      watchedSeconds: 90,
      completionPercent: 0,
      verdict: { level: "weak" },
    },
    {
      itemKey: "digest-1",
      title: "进小结的视频",
      author: "UP3",
      canonicalUrl: "https://www.bilibili.com/video/BVdigest",
      watchedSeconds: 5,
      completionPercent: 0,
      verdict: null,
    },
    {
      itemKey: "weak-1",
      title: "弱条目视频",
      author: "UP4",
      canonicalUrl: "https://www.bilibili.com/video/BVweak",
      watchedSeconds: 8,
      completionPercent: 10,
      verdict: { level: "weak" },
    },
  ],
  digest: {
    items: [{ itemKey: "digest-1", title: "进小结的视频", whyLine: "讲了很实用的调试技巧" }],
    reflection: "今天看的多是技术向",
  },
};

test("会话筛选：强兴趣/看够时长/进 digest 三路放行，弱条目跳过", () => {
  const result = watchEntriesFromSession(session, NOW);
  const titles = result.entries.map((entry) => entry.title).sort();
  assert.deepEqual(titles, ["强兴趣视频", "看了很久的视频", "进小结的视频"].sort());
  assert.equal(result.skippedUrls.length, 1);
  assert.ok(result.skippedUrls[0].includes("BVweak"));
  assert.equal(result.strongCount, 1);
  assert.equal(result.digestCount, 1);
  const digestEntry = result.entries.find((entry) => entry.title === "进小结的视频");
  assert.equal(digestEntry.take, "讲了很实用的调试技巧");
  const strongEntry = result.entries.find((entry) => entry.title === "强兴趣视频");
  assert.equal(strongEntry.take, "今天看的多是技术向");
  assert.equal(strongEntry.strong, true);
});

test("接线后只入库筛选结果，条数一致且不含弱条目", () => {
  const { entries } = watchEntriesFromSession(session, NOW);
  const memory = addWatchEntries(emptyMemory(NOW), entries, NOW);
  assert.equal(memory.watch.length, 3);
  assert.ok(!memory.watch.some((entry) => entry.title === "弱条目视频"));
  assert.ok(memory.watch.every((entry) => entry.title && entry.key));
});