// 轮播多样性单测：洗牌袋一轮全覆盖、最近 8 去重、权重封顶/最低占比、重建列表指针连续。

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampRotationWeights,
  nextFromBag,
  nextIndexAfterFramesChange,
  pickWeightedState,
  pushRecent,
  refillBag,
  RECENT_LIMIT,
  RECENT_RETRY,
  MAX_STATE_WEIGHT,
  MIN_STATE_SHARE,
} from "../src/petRotationBag.ts";
import { buildIdlePlaylistStateful } from "../src/petVitals.ts";

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("洗牌袋：一轮内不重复且覆盖全部帧，播完自动重洗", () => {
  const frames = Array.from({ length: 12 }, (_, i) => `f${i}.gif`);
  const rng = seeded(7);
  let bag = refillBag(frames, rng);
  const seen = [];
  for (let i = 0; i < frames.length; i += 1) {
    const drawn = nextFromBag(frames, bag, [], rng);
    assert.ok(drawn.frame);
    seen.push(drawn.frame);
    bag = drawn.bag;
  }
  assert.equal(new Set(seen).size, frames.length, "一轮内不许重复且必须全覆盖");
  // 再抽一轮仍然覆盖全部（重新洗牌）
  const second = [];
  for (let i = 0; i < frames.length; i += 1) {
    const drawn = nextFromBag(frames, bag, [], rng);
    second.push(drawn.frame);
    bag = drawn.bag;
  }
  assert.equal(new Set(second).size, frames.length);
  assert.notDeepEqual(seen, second, "重新洗牌后顺序不应完全相同");
});

test("最近 8 个播放过的帧不会再次抽到（窗口内无重复）", () => {
  const frames = Array.from({ length: 16 }, (_, i) => `f${i}.gif`);
  const rng = seeded(11);
  let bag = refillBag(frames, rng);
  let recent = [];
  const played = [];
  for (let i = 0; i < 40; i += 1) {
    const drawn = nextFromBag(frames, bag, recent, rng);
    bag = drawn.bag;
    played.push(drawn.frame);
    recent = pushRecent(recent, drawn.frame);
  }
  for (let i = 1; i < played.length; i += 1) {
    const window = played.slice(Math.max(0, i - RECENT_LIMIT), i);
    assert.ok(!window.includes(played[i]), `第 ${i} 次播放与最近 ${RECENT_LIMIT} 个重复：${played[i]}`);
  }
  assert.ok(RECENT_RETRY >= 1);
});

test("权重封顶 + 最低占比：单状态 ≤3、每个状态 ≥2% 份额", () => {
  const clamped = clampRotationWeights({ sleeping: 5, relax: 3, happy: 0.2, rare: 0.05 });
  assert.ok(clamped.sleeping <= MAX_STATE_WEIGHT + 1e-9, `sleeping=${clamped.sleeping}`);
  const total = Object.values(clamped).reduce((sum, value) => sum + value, 0);
  for (const [state, value] of Object.entries(clamped)) {
    assert.ok(value / total >= MIN_STATE_SHARE - 1e-6, `${state} 份额 ${value / total} 低于下限`);
  }
  // 极端权重也被压到上限，小状态不会被清零（霸屏程度随状态数变化，这里只断言封顶生效）
  const dominated = clampRotationWeights({ one: 50, two: 0.1, three: 0.1 });
  assert.ok(dominated.one <= MAX_STATE_WEIGHT + 1e-9, `one=${dominated.one}`);
  assert.ok(dominated.two > 0 && dominated.three > 0);
});

test("按权重抽状态：封顶后的分布符合预期（不霸屏）", () => {
  const weights = clampRotationWeights({ sleeping: 5, relax: 3, idle: 2, happy: 0.2 });
  const rng = seeded(21);
  const counts = {};
  for (let i = 0; i < 4000; i += 1) {
    const state = pickWeightedState(weights, rng);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  for (const [state, weight] of Object.entries(weights)) {
    const share = counts[state] / 4000;
    assert.ok(Math.abs(share - weight / total) < 0.03, `${state} 实际 ${share} vs 期望 ${weight / total}`);
  }
});

test("列表重建时指针不重置：找到刚播的帧就继续，找不到才回到 0", () => {
  const frames = ["a.gif", "b.gif", "c.gif", "d.gif"];
  assert.equal(nextIndexAfterFramesChange(frames, "b.gif", 1), 2);
  assert.equal(nextIndexAfterFramesChange(frames, "d.gif", 3), 0);
  assert.equal(nextIndexAfterFramesChange(["x.gif", "y.gif"], "b.gif", 1), 1);
  assert.equal(nextIndexAfterFramesChange(["x.gif", "y.gif"], "nope.gif", 0), 0);
});

test("有状态播放列表：64 槽、跨重建不重复同一帧（同状态袋继续推进）", () => {
  const framesFor = (state) => Array.from({ length: 10 }, (_, i) => `${state}-${i}.gif`);
  const states = ["idle", "happy", "relax"];
  const weights = { idle: 2, happy: 1, relax: 1 };
  const first = buildIdlePlaylistStateful({ states, weights, framesFor, slots: 64, rng: seeded(3) });
  assert.equal(first.frames.length, 64);
  // 连续两次重建（模拟分桶变化）：第二次使用同一份袋进度，首帧不应重复上一轮尾帧
  const second = buildIdlePlaylistStateful({
    states,
    weights,
    framesFor,
    slots: 64,
    rng: seeded(4),
    store: first.store,
  });
  assert.equal(second.frames.length, 64);
  assert.notEqual(second.frames[0], first.frames[first.frames.length - 1]);
  // 同一轮内同一状态的帧不重复（每个状态只有 10 张，64 槽里同状态帧会跨轮，但相邻重洗不应连播同一张）
  for (let i = 1; i < first.frames.length; i += 1) {
    assert.notEqual(first.frames[i], first.frames[i - 1], `第 ${i} 与前一帧相同`);
  }
});