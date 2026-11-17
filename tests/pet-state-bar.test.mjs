import assert from "node:assert/strict";
import test from "node:test";
import {
  busyStateText,
  detectThresholdCross,
  formatStateBar,
  readCollapsed,
  shouldShowNotice,
  stateBarVisible,
  STATE_NOTICE_THROTTLE_MS,
  writeCollapsed,
} from "../src/petStateBarLogic.ts";

test("状态条文案：四项数值用 · 分隔，缺 focus 不显示", () => {
  assert.equal(formatStateBar({ energy: 32, mood: 78, bond: 64, focus: 20 }), "体力 32 · 情绪 78 · 亲密 64 · 专注 20");
  assert.equal(formatStateBar({ energy: 32, mood: 78, bond: 64 }), "体力 32 · 情绪 78 · 亲密 64");
  // 越界夹取
  assert.equal(formatStateBar({ energy: 120, mood: -5, bond: 50 }), "体力 100 · 情绪 0 · 亲密 50");
});

test("无数据或关闭 vitals 时整行不渲染", () => {
  assert.equal(stateBarVisible(null), false);
  assert.equal(stateBarVisible(undefined, true), false);
  assert.equal(stateBarVisible({ energy: 50, mood: 50, bond: 50 }, false), false);
  assert.equal(stateBarVisible({ energy: 50, mood: 50, bond: 50 }, true), true);
  // 缺字段不崩、视为不可用
  assert.equal(stateBarVisible({ energy: Number.NaN, mood: 50, bond: 50 }), false);
});

test("阈值跨越：体力跌破 35 / 情绪升过 75 才提示，文案带角色名", () => {
  assert.deepEqual(
    detectThresholdCross({ energy: 40, mood: 60, bond: 50 }, { energy: 30, mood: 60, bond: 50 }, "小白"),
    { kind: "tired", text: "（小白看起来有点累了）" },
  );
  assert.deepEqual(
    detectThresholdCross({ energy: 50, mood: 70, bond: 50 }, { energy: 50, mood: 80, bond: 50 }, "小鸡毛"),
    { kind: "happy", text: "（小鸡毛心情不错）" },
  );
  // 已经在阈值内再变化不重复提示
  assert.equal(detectThresholdCross({ energy: 30, mood: 60, bond: 50 }, { energy: 25, mood: 60, bond: 50 }), null);
  assert.equal(detectThresholdCross(null, { energy: 20, mood: 60, bond: 50 }), null);
  assert.equal(detectThresholdCross({ energy: 50, mood: 60, bond: 50 }, null), null);
});

test("灰色提示 10 分钟节流", () => {
  const now = 1_000_000;
  assert.equal(shouldShowNotice(0, now), true, "从未提示过 → 可以提示");
  assert.equal(shouldShowNotice(now - 9 * 60_000, now), false, "9 分钟前提示过 → 跳过");
  assert.equal(shouldShowNotice(now - STATE_NOTICE_THROTTLE_MS, now), true, "满 10 分钟 → 可以提示");
  assert.equal(shouldShowNotice(Number.NaN, now), true, "坏数据按从未提示处理");
});

test("折叠状态读写容错", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readCollapsed(storage), false);
  writeCollapsed(storage, true);
  assert.equal(readCollapsed(storage), true);
  writeCollapsed(storage, false);
  assert.equal(readCollapsed(storage), false);
  assert.equal(readCollapsed(null), false);
  assert.doesNotThrow(() => writeCollapsed(null, true));
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readCollapsed(broken), false);
  assert.doesNotThrow(() => writeCollapsed(broken, true));
});

test("忙碌态文案：3s 后切成「加载模型或思考」，带秒数", () => {
  assert.equal(busyStateText(false, 0, false), "");
  assert.equal(busyStateText(true, 0, false), "小狗在想…");
  assert.equal(busyStateText(true, 2, true), "小狗正在思考… 2s");
  assert.equal(busyStateText(true, 5, false), "小狗在加载模型或思考… 5s");
});