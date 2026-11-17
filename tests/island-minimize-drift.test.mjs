// 最小化漂移 / 闪烁回归单测（派单 2026-11-17）。
// 纯函数 + 源码断言：Rust 侧的几何冻结没法在 node 里跑，但可以用源码断言守住关键闸口。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  isSaneIslandRect,
  isSentinelWindowPosition,
  MINIMIZE_BLUR_SETTLE_MS,
  MIN_SANE_ISLAND_SIZE,
  MINIMIZED_SENTINEL_THRESHOLD,
  shouldCollapseOnBlur,
} from "../src/islandMinimizeGuard.ts";

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

test("最小化哨兵坐标：(-32000,-32000) 一律不是真实位置", () => {
  assert.equal(MINIMIZED_SENTINEL_THRESHOLD, -30_000);
  assert.equal(isSentinelWindowPosition(-32000, -32000), true);
  assert.equal(isSentinelWindowPosition(-30_000, 1080), true);
  assert.equal(isSentinelWindowPosition(100, -30_001), true);
  assert.equal(isSentinelWindowPosition(0, 0), false);
  assert.equal(isSentinelWindowPosition(1912, 1040), false);
  assert.equal(isSentinelWindowPosition(Number.NaN, 0), true);
  assert.equal(isSentinelWindowPosition(0, Number.POSITIVE_INFINITY), true);
});

test("真实矩形判据：哨兵位置 / 0 尺寸 / 标题栏高度都拒收", () => {
  assert.equal(MIN_SANE_ISLAND_SIZE, 32);
  assert.equal(isSaneIslandRect({ x: 1560, y: 880, width: 259, height: 221 }), true);
  assert.equal(isSaneIslandRect({ x: -32000, y: -32000, width: 259, height: 221 }), false);
  assert.equal(isSaneIslandRect({ x: 1560, y: 880, width: 0, height: 0 }), false);
  assert.equal(isSaneIslandRect({ x: 1560, y: 880, width: 259, height: 28 }), false);
  assert.equal(isSaneIslandRect(null), false);
  assert.equal(isSaneIslandRect(undefined), false);
});

test("失焦收起判据：最小化 / 过渡期不收起（面板不闪）", () => {
  const base = { focused: false, mode: "expanded", minimized: false, settleMs: 500 };
  assert.equal(shouldCollapseOnBlur(base), true, "正常点别处 → 收起");
  assert.equal(shouldCollapseOnBlur({ ...base, minimized: true }), false, "最小化 → 不收起");
  assert.equal(shouldCollapseOnBlur({ ...base, settleMs: MINIMIZE_BLUR_SETTLE_MS - 1 }), false, "过渡期内不收起");
  assert.equal(shouldCollapseOnBlur({ ...base, focused: true }), false, "获得焦点不收起");
  assert.equal(shouldCollapseOnBlur({ ...base, mode: "collapsed" }), false, "收起态不重复收起");
  assert.equal(shouldCollapseOnBlur({ ...base, settleMs: Number.NaN }), false);
});

test("源码闸口：Rust 所有几何入口都先过 island_geometry_frozen", () => {
  const source = read("src-tauri/src/lib.rs");
  // 定义存在
  assert.match(source, /fn island_geometry_frozen\(/);
  assert.match(source, /fn is_sentinel_window_position\(/);
  assert.match(source, /static PRE_MINIMIZE_ISLAND_RECT:/);
  // apply_stage_geometry / ensure_island_on_screen 都有早退
  const applyAt = source.indexOf("fn apply_stage_geometry(");
  assert.ok(applyAt > 0);
  assert.match(source.slice(applyAt, applyAt + 900), /island_geometry_frozen\(window\)/);
  const ensureAt = source.indexOf("fn ensure_island_on_screen(");
  assert.ok(ensureAt > 0);
  assert.match(source.slice(ensureAt, ensureAt + 900), /island_geometry_frozen\(window\)/);
  // Moved 回调不再把哨兵位置写进 custom_position
  const recordAt = source.indexOf("fn record_dragged_position(");
  assert.ok(recordAt > 0);
  assert.match(source.slice(recordAt, recordAt + 900), /is_sentinel_window_position/);
  // 还原时按最小化前矩形复位
  assert.match(source, /fn restore_island_rect_after_unminimize\(/);
  assert.match(source, /fn sync_minimize_geometry\(/);
});

test("源码闸口：前端失焦收起走 shouldCollapseOnBlur，并区分最小化", () => {
  const source = read("src/App.tsx");
  assert.match(source, /import \{ MINIMIZE_BLUR_SETTLE_MS, shouldCollapseOnBlur \} from "\.\/islandMinimizeGuard"/);
  assert.match(source, /isMinimized\(\)/);
  assert.match(source, /shouldCollapseOnBlur\(\{ focused: false, mode: modeRef\.current, minimized, settleMs \}\)/);
});