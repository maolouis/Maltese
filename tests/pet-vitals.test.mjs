// 桌宠自我状态（体力/情绪/亲密/专注）单测：衰减 / 事件 / 权重 / 轮播 / 只读接入层。

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendVitalsLog,
  applyDecay,
  applyEvent,
  applyVitalsEvent,
  buildIdlePlaylist,
  createVitals,
  describeRecentInteractions,
  loadVitals,
  loadVitalsLog,
  readPetVitals,
  saveVitals,
  summarizePetVitals,
  tickVitals,
  VITALS_DAILY_GAIN_CAP,
  VITALS_EVENTS,
  VITALS_FLOOR,
  VITALS_HALF_LIFE_MS,
  VITALS_LOG_KEY,
  VITALS_LOG_LIMIT,
  VITALS_STORAGE_KEY,
  vitalsBucketKey,
  vitalsEventForPetAction,
  vitalsLevel,
  weightsForVitals,
} from "../src/petVitals.ts";

const HOUR = 3_600_000;
const MIN = 60_000;

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

// —— 衰减 ——

test("衰减：半衰期到点剩一半，带下限时按 floor 抬，elapsed≤0 不变", () => {
  assert.equal(applyDecay(100, 6 * HOUR, 6 * HOUR), 50);
  assert.equal(applyDecay(100, 0, 6 * HOUR), 100);
  assert.equal(applyDecay(100, -5 * HOUR, 6 * HOUR), 100, "时钟回拨不惩罚");
  // floor 15：15 + (100-15)*0.5 = 57.5
  assert.equal(applyDecay(100, 6 * HOUR, 6 * HOUR, 15), 57.5);
  // 再久也不会掉到 floor 以下
  const long = applyDecay(80, 100 * HOUR, 2 * HOUR, VITALS_FLOOR.mood);
  assert.ok(Math.abs(long - VITALS_FLOOR.mood) < 1e-6, String(long));
  assert.equal(applyDecay(Number.NaN, HOUR, 6 * HOUR), 0);
});

test("applyEvent 夹在 0–100 之间", () => {
  assert.equal(applyEvent(95, 10), 100);
  assert.equal(applyEvent(2, -10), 0);
  assert.equal(applyEvent(50, 4), 54);
});

// —— 事件 / 冷却 / 日上限 / 重复递减 ——

test("事件：冷却内不重复生效，且冷却与日上限都拦住刷数值", () => {
  const start = 1_700_000_000_000;
  let state = createVitals(start);
  const first = applyVitalsEvent(state, "pet", start);
  assert.equal(first.applied, true);
  state = first.state;
  // 冷却 20s 内再来一次不生效
  const tooSoon = applyVitalsEvent(state, "pet", start + 5_000);
  assert.equal(tooSoon.applied, false);
  const afterCooldown = applyVitalsEvent(tooSoon.state, "pet", start + 25_000);
  assert.equal(afterCooldown.applied, true);
  // 情绪不会超过 100，且当日增益有上限
  for (let i = 0; i < 60; i += 1) {
    state = applyVitalsEvent(afterCooldown.state, "pet", start + 25_000 + i * 25_000).state;
  }
  assert.ok(state.mood <= 100);
  assert.ok(state.today.gained.mood <= VITALS_DAILY_GAIN_CAP.mood);
});

test("事件：喂食每天最多 3 次（dailyLimit），睡觉 4 小时冷却", () => {
  const start = 1_700_000_000_000;
  let state = createVitals(start);
  let applied = 0;
  for (let i = 0; i < 5; i += 1) {
    const result = applyVitalsEvent(state, "eat", start + i * 31 * MIN);
    state = result.state;
    if (result.applied) applied += 1;
  }
  assert.equal(applied, 3, "每天 3 次是上限");
  assert.equal(VITALS_EVENTS.eat.dailyLimit, 3);
  const sleep = applyVitalsEvent(createVitals(start), "sleep", start);
  assert.equal(sleep.applied, true);
  assert.equal(applyVitalsEvent(sleep.state, "sleep", start + 3 * HOUR).applied, false);
});

test("重复递减：第 7 次同事件只有一半增益", () => {
  const start = 1_700_000_000_000;
  let state = createVitals(start);
  const gains = [];
  for (let i = 0; i < 7; i += 1) {
    const before = state.mood;
    const result = applyVitalsEvent(state, "care", start + i * 31_000);
    state = result.state;
    gains.push(Number((state.mood - before).toFixed(2)));
  }
  assert.ok(gains[0] > gains[6], `递减应生效：${gains.join(",")}`);
  assert.ok(Math.abs(gains[6] - gains[0] / 2) < 0.6, "第 7 次约为满额一半");
});

test("结算幂等：连续 tick 与一次 tick 等价（衰减可组合）", () => {
  const start = 1_700_000_000_000;
  const base = createVitals(start);
  const once = tickVitals(base, start + 3 * HOUR);
  let many = base;
  for (let i = 1; i <= 12; i += 1) many = tickVitals(many, start + i * 15 * MIN);
  assert.ok(Math.abs(once.energy - many.energy) < 0.5, `${once.energy} vs ${many.energy}`);
  assert.ok(Math.abs(once.mood - many.mood) < 0.5);
});

test("专注：待办进行中随时间上涨（每 5 分钟 +1），不在待办时只有衰减", () => {
  const start = 1_700_000_000_000;
  const base = createVitals(start, { focusActive: true });
  assert.equal(base.focus, 70, "开始待办即进入专注（≥70）");
  const after = tickVitals(base, start + 50 * MIN, { focusActive: true });
  assert.ok(Math.abs(after.focus - 80) < 0.5, `50 分钟应 +10，实际 ${after.focus}`);
  // 45 分钟半衰期：待办结束后快速回落
  const idle = tickVitals(after, start + 50 * MIN + 45 * MIN, { focusActive: false });
  assert.ok(Math.abs(idle.focus - 40) < 1.5, `半衰期后约 40，实际 ${idle.focus}`);
  // 开始待办事件也把 focus 顶到 70
  const started = applyVitalsEvent(createVitals(start), "todoStart", start);
  assert.equal(started.applied, true);
  assert.ok(Math.abs(started.state.focus - 70) < 0.01);
});

// —— 指标 → 权重 ——

test("权重：体力低 → sleeping/relax 高、happy 低；情绪高 → happy/love 高", () => {
  const tired = weightsForVitals({ energy: 20, mood: 70, bond: 50, focus: 0 });
  assert.ok(tired.sleeping > (weightsForVitals({ energy: 90, mood: 70, bond: 50, focus: 0 }).sleeping ?? 0));
  assert.ok(tired.happy < 1, "累的时候不会一直傻乐");
  const happy = weightsForVitals({ energy: 80, mood: 90, bond: 90, focus: 0 });
  assert.ok(happy.happy > 3);
  assert.ok(happy.love > 3);
});

test("权重：专注高 → working/attention 升、sleeping 降；任何权重都 > 0", () => {
  const focused = weightsForVitals({ energy: 70, mood: 70, bond: 60, focus: 80 });
  const relaxed = weightsForVitals({ energy: 70, mood: 70, bond: 60, focus: 0 });
  assert.ok(focused.working > relaxed.working);
  assert.ok(focused.sleeping < relaxed.sleeping);
  for (const weight of Object.values(focused)) {
    assert.ok(weight > 0, "权重不能为 0，否则某些表情永远不出现");
  }
});

test("权重：久不互动也不会自动播 cry/angry 惩罚", () => {
  const bottom = weightsForVitals({
    energy: VITALS_FLOOR.energy,
    mood: VITALS_FLOOR.mood,
    bond: VITALS_FLOOR.bond,
    focus: 0,
  });
  assert.equal(bottom.cry, undefined);
  assert.equal(bottom.angry, undefined);
});

// —— 待机播放列表 ——

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

test("轮播：只产出勾选状态的帧、去相邻重复、数量 = 24", () => {
  const states = ["idle", "happy", "relax", "sleeping"];
  const framesFor = (state) => [`${state}-1.gif`, `${state}-2.gif`];
  const playlist = buildIdlePlaylist({
    states,
    weights: weightsForVitals({ energy: 20, mood: 70, bond: 50, focus: 0 }),
    framesFor,
    rng: seeded(7),
    slots: 24,
  });
  assert.equal(playlist.length, 24);
  for (const frame of playlist) {
    assert.ok(states.some((state) => frame.startsWith(`${state}-`)), frame);
  }
  for (let i = 1; i < playlist.length; i += 1) {
    assert.notEqual(playlist[i], playlist[i - 1], "相邻帧不能重复");
  }
  // 体力低时 sleeping/relax 应明显多于 happy
  const counts = {};
  for (const frame of playlist) {
    const state = frame.split("-")[0];
    counts[state] = (counts[state] ?? 0) + 1;
  }
  assert.ok((counts.sleeping ?? 0) + (counts.relax ?? 0) > (counts.happy ?? 0));
});

test("轮播：空池返回空数组（调用方回退现有行为），分桶键只在跨档时变化", () => {
  assert.deepEqual(buildIdlePlaylist({ states: [], weights: {}, framesFor: () => [] }), []);
  const a = { energy: 71, mood: 40, bond: 50, focus: 10 };
  const b = { ...a, energy: 79 };
  const c = { ...a, energy: 25 };
  assert.equal(vitalsBucketKey(a), vitalsBucketKey(b));
  assert.notEqual(vitalsBucketKey(a), vitalsBucketKey(c));
});

// —— 状态文案 / 事件映射 ——

test("状态等级：分档与阈值一致", () => {
  assert.equal(vitalsLevel({ energy: 70, mood: 85, bond: 80, focus: 0 }), "great");
  assert.equal(vitalsLevel({ energy: 70, mood: 60, bond: 50, focus: 0 }), "good");
  assert.equal(vitalsLevel({ energy: 20, mood: 70, bond: 50, focus: 0 }), "tired");
  assert.equal(vitalsLevel({ energy: 70, mood: 70, bond: 30, focus: 0 }), "lonely");
  assert.equal(vitalsLevel({ energy: 70, mood: 70, bond: 60, focus: 70 }), "focused");
});

test("动作 → 事件映射覆盖摸头/喂食/陪玩/照顾/睡觉", () => {
  assert.equal(vitalsEventForPetAction("pet"), "pet");
  assert.equal(vitalsEventForPetAction("eating"), "eat");
  assert.equal(vitalsEventForPetAction("play"), "play");
  assert.equal(vitalsEventForPetAction("chin"), "care");
  assert.equal(vitalsEventForPetAction("sleeping"), "sleep");
  assert.equal(vitalsEventForPetAction("unknown-action"), null);
});

// —— 持久化 / 只读接入层 ——

test("持久化：读写往返、坏数据回默认值", () => {
  const storage = memoryStorage();
  const state = createVitals(1_700_000_000_000);
  saveVitals(storage, state);
  const loaded = loadVitals(storage, Date.now());
  assert.ok(Math.abs(loaded.energy - state.energy) < 0.01);
  assert.ok(storage.getItem(VITALS_STORAGE_KEY));
  assert.deepEqual(loadVitals(memoryStorage({ [VITALS_STORAGE_KEY]: "not-json" }), 1_700_000_000_000).energy, 70);
  // 越界值被夹回下限
  const broken = loadVitals(memoryStorage({ [VITALS_STORAGE_KEY]: JSON.stringify({ energy: 1, mood: 500, bond: 50, updatedAt: 1 }) }), 1_700_000_000_000);
  assert.equal(broken.energy, VITALS_FLOOR.energy);
  assert.equal(broken.mood, 100);
});

test("readPetVitals：无数据返回默认值，从不抛错", () => {
  const snapshot = readPetVitals(memoryStorage());
  assert.deepEqual(snapshot, { energy: 70, mood: 70, bond: 50, focus: 0, updatedAt: 0 });
  assert.deepEqual(readPetVitals(null), { energy: 70, mood: 70, bond: 50, focus: 0, updatedAt: 0 });
  assert.doesNotThrow(() => readPetVitals(memoryStorage({ [VITALS_STORAGE_KEY]: "{" })));
});

test("summarizePetVitals：中文分档（有点累 / 心情不错 / 正专注）", () => {
  const tired = summarizePetVitals({ energy: 32, mood: 78, bond: 64, focus: 20, updatedAt: 0 });
  assert.match(tired, /体力 32（有点累）/);
  assert.match(tired, /情绪 78（心情不错）/);
  assert.match(tired, /亲密 64/);
  assert.match(tired, /专注 20/);
  const focused = summarizePetVitals({ energy: 80, mood: 40, bond: 50, focus: 90, updatedAt: 0 });
  assert.match(focused, /专注 90（正专注）/);
  assert.match(focused, /体力 80（很有精神）/);
  const low = summarizePetVitals({ energy: 50, mood: 20, bond: 20, focus: 0, updatedAt: 0 });
  assert.match(low, /情绪 20（有点低落）/);
  assert.match(low, /亲密 20（还有点生疏）/);
});

test("describeRecentInteractions：最多 3 条、空数据不崩、不带聊天正文", () => {
  assert.deepEqual(describeRecentInteractions(memoryStorage()), []);
  assert.deepEqual(describeRecentInteractions(null), []);
  const now = 1_700_000_000_000;
  let storage = memoryStorage();
  // 按时间顺序追加（新的写在前面，所以先写最旧的）
  appendVitalsLog(storage, { kind: "bongo", at: now - 30 * MIN });
  appendVitalsLog(storage, { kind: "chat", at: now - 20 * MIN });
  appendVitalsLog(storage, { kind: "eat", at: now - 10 * MIN });
  appendVitalsLog(storage, { kind: "pet", at: now - 3 * MIN });
  const lines = describeRecentInteractions(storage, 3, { now });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "3 分钟前被摸头");
  assert.equal(lines[1], "10 分钟前喂过食");
  assert.equal(lines[2], "20 分钟前和主人说了几句");
  // 待办标题会出现在第一条（用户自己写的标题，不是聊天内容）
  const todoLines = describeRecentInteractions(storage, 2, { now, activeTodoTitle: "重构聊天面板" });
  assert.equal(todoLines[0], "正在做待办：重构聊天面板");
  assert.equal(todoLines.length, 2);
  // 日志有上限
  for (let i = 0; i < 60; i += 1) appendVitalsLog(storage, { kind: "pet", at: now + i });
  assert.ok(loadVitalsLog(storage).length <= VITALS_LOG_LIMIT);
  assert.ok(storage.getItem(VITALS_LOG_KEY));
});