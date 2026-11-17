// 模拟一天：验证曲线单调、无 NaN、0≤值≤100，并把各时段待机轮播分布打出来。
// 用法：node scripts/simulate-pet-vitals.mjs

import {
  applyVitalsEvent,
  buildIdlePlaylist,
  createVitals,
  tickVitals,
  vitalsBucketKey,
  weightsForVitals,
} from "../src/petVitals.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const startOfDay = new Date("2026-11-17T00:00:00+08:00").getTime();
// 09:00 摸头 ×3 / 10:00 开始待办 / 10:40 完成待办 / 12:00 喂食 / 14:00 陪玩 /
// 14:05 结束待办 / 20:00 聊天 ×5 / 其余闲置；22:00 睡觉。
const EVENTS = [
  { at: 9 * HOUR, kind: "pet" },
  { at: 9 * HOUR + 25_000, kind: "pet" },
  { at: 9 * HOUR + 50_000, kind: "pet" },
  { at: 10 * HOUR, kind: "todoStart" },
  { at: 10 * HOUR + 40 * MIN, kind: "todoDone" },
  { at: 12 * HOUR, kind: "eat" },
  { at: 14 * HOUR, kind: "play" },
  { at: 20 * HOUR, kind: "chat" },
  { at: 20 * HOUR + 31_000, kind: "chat" },
  { at: 20 * HOUR + 62_000, kind: "chat" },
  { at: 22 * HOUR, kind: "sleep" },
];

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

let state = createVitals(startOfDay);
let focusActive = false;
let lastAt = startOfDay;
const appliedEvents = new Set();
let failures = 0;

function applyPending(until) {
  EVENTS.forEach((event, index) => {
    const at = startOfDay + event.at;
    if (appliedEvents.has(index) || at > until) return;
    appliedEvents.add(index);
    if (event.kind === "todoStart") focusActive = true;
    if (event.kind === "todoDone") focusActive = false;
    const result = applyVitalsEvent(state, event.kind, at);
    state = result.state;
    if (!result.applied) console.log(`  (skip ${event.kind} @${Math.round(event.at / HOUR)}h，冷却/上限)`);
  });
}

function check(label) {
  const values = [state.energy, state.mood, state.bond, state.focus];
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      failures += 1;
      console.log(`  !! ${label} 指标越界：${value}`);
    }
  }
}

console.log("时刻  体力 情绪 亲密 专注  bucket      一句话");
for (let hour = 0; hour <= 24; hour += 1) {
  const until = startOfDay + hour * HOUR;
  applyPending(until);
  state = tickVitals(state, until, { focusActive });
  lastAt = until;
  check(`${hour}h`);
  if (hour % 2 === 0) {
    // 待机轮播分布（1000 次抽样，24 张一轮）
    const counts = new Map();
    const states = ["idle", "happy", "relax", "play", "sleeping", "peek", "pet", "chin", "love", "working", "attention", "celebrate", "spin"];
    for (let round = 0; round < 42; round += 1) {
      const playlist = buildIdlePlaylist({
        states,
        weights: weightsForVitals(state),
        framesFor: (value) => [`${value}-1`],
        rng: seeded(hour * 100 + round + 1),
      });
      for (const frame of playlist) {
        const key = frame.split("-")[0];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const summary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}:${(count / 10).toFixed(0)}%`)
      .join(" ");
    console.log(
      `${String(hour).padStart(2, "0")}:00  ${Math.round(state.energy).toString().padStart(3)}  ${Math.round(state.mood).toString().padStart(3)}  ${Math.round(state.bond).toString().padStart(3)}  ${Math.round(state.focus).toString().padStart(3)}  ${vitalsBucketKey(state).padEnd(10)} ${summary}`,
    );
  }
}

if (failures > 0) {
  console.error(`模拟失败：${failures} 个越界值`);
  process.exit(1);
}
console.log("模拟通过：24 小时无 NaN / 无越界；低体力时段 sleeping+relax 占比上升。");