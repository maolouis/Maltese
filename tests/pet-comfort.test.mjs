import assert from "node:assert/strict";
import test from "node:test";
import {
  BOND_LOW,
  COMFORT_DAILY_LIMIT,
  COMFORT_GAP_MS,
  COMFORT_RECOVERED_COOLDOWN_MS,
  MOOD_LOW,
  PERSONA_KEYWORDS,
  canSeekComfort,
  comfortTimesToday,
  emptyComfortState,
  isLowMood,
  loadComfortState,
  personaSuffix,
  recordComfort,
  saveComfortState,
  trackMoodRecovery,
} from "../src/petComfort.ts";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-20T12:00:00+08:00").getTime();

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("低 mood 判定与工作忙碌跳过", () => {
  assert.equal(MOOD_LOW, 40);
  assert.equal(BOND_LOW, 40);
  assert.equal(isLowMood(39), true);
  assert.equal(isLowMood(40), false);
  assert.equal(isLowMood(80, 30), true);
  const busy = canSeekComfort(emptyComfortState(), NOW, 20, { kind: "code", idleSeconds: 5 });
  assert.equal(busy.allowed, false);
  assert.equal(busy.reason, "user_busy");
  const idle = canSeekComfort(emptyComfortState(), NOW, 20, { kind: "code", idleSeconds: 600 });
  assert.equal(idle.allowed, true);
});

test("每日 ≤2 次、间隔 ≥3 小时", () => {
  let state = emptyComfortState();
  const first = canSeekComfort(state, NOW, 20);
  assert.equal(first.allowed, true);
  state = recordComfort(state, NOW);
  const tooSoon = canSeekComfort(state, NOW + COMFORT_GAP_MS - 1, 20);
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.reason, "gap");
  const afterGap = canSeekComfort(state, NOW + COMFORT_GAP_MS, 20);
  assert.equal(afterGap.allowed, true);
  state = recordComfort(state, NOW + COMFORT_GAP_MS);
  const third = canSeekComfort(state, NOW + 2 * COMFORT_GAP_MS, 20);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "daily_limit");
  assert.equal(comfortTimesToday(state, NOW + 2 * COMFORT_GAP_MS).length, COMFORT_DAILY_LIMIT);
});

test("mood 恢复到 ≥60 后 24h 内不再求安慰", () => {
  let state = recordComfort(emptyComfortState(), NOW - 5 * HOUR, 20);
  state = trackMoodRecovery(state, 70, NOW);
  assert.ok(state.recoveredAt);
  const blocked = canSeekComfort(state, NOW + 1 * HOUR, 20);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "recovered_cooldown");
  const allowed = canSeekComfort(state, NOW + COMFORT_RECOVERED_COOLDOWN_MS + 1, 20);
  assert.equal(allowed.allowed, true);
});

test("人设关键词与提示语", () => {
  for (const keyword of ["天真烂漫", "单纯", "心思简单", "容易满足", "爱撒娇", "把开心和难过都写在脸上"]) {
    assert.ok(PERSONA_KEYWORDS.includes(keyword));
  }
  const suffix = personaSuffix();
  for (const keyword of PERSONA_KEYWORDS) {
    assert.ok(suffix.includes(keyword));
  }
  assert.ok(suffix.includes("不装可怜"));
  assert.ok(suffix.includes("不道德绑架"));
});

test("存储读写与空态", () => {
  const store = storage();
  assert.deepEqual(loadComfortState(store), emptyComfortState());
  const state = recordComfort(emptyComfortState(), NOW);
  saveComfortState(state, store);
  assert.equal(loadComfortState(store).times.length, 1);
});