// 双击小狗向左上角闪动 & 多真值几何污染回归闸门（2026-11-26）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

test("Rust 闸口：LAST_SETTLED_ISLAND_RECT 与 LAST_OUTER_WINDOW_RECT 语义分离，浮层外框绝不写入狗槽缓存", () => {
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /static LAST_OUTER_WINDOW_RECT:/);
  const rememberAt = lib.indexOf("fn remember_settled_island_rect(");
  assert.ok(rememberAt > 0);
  const rememberBlock = lib.slice(rememberAt, rememberAt + 1400);
  assert.match(rememberBlock, /OVERLAY_SNAPSHOT\.try_lock\(\)/);
  assert.match(rememberBlock, /store_last_outer_window_rect\(rect\)/);
  assert.match(rememberBlock, /snap\.anchor_x/);
});

test("Rust 闸口：expected_slot_from_state 在浮层激活期间优先返回 OVERLAY_SNAPSHOT 锚点", () => {
  const lib = read("src-tauri/src/lib.rs");
  const expectedAt = lib.indexOf("fn expected_slot_from_state(");
  assert.ok(expectedAt > 0);
  const expectedBlock = lib.slice(expectedAt, expectedAt + 900);
  assert.match(expectedBlock, /OVERLAY_SNAPSHOT\.try_lock\(\)/);
  assert.ok(
    expectedBlock.indexOf("OVERLAY_SNAPSHOT") < expectedBlock.indexOf("state.custom_position"),
    "OVERLAY_SNAPSHOT 必须先于 custom_position / settled_island_rect 返回",
  );
});

test("Rust 闸口：plan_island_overlay 在已有浮层（如 cloud）打开时绝不拿放大窗口左上角覆盖锚点", () => {
  const lib = read("src-tauri/src/lib.rs");
  const planAt = lib.indexOf("fn plan_island_overlay(");
  assert.ok(planAt > 0);
  const planBlock = lib.slice(planAt, planAt + 6500);
  assert.match(planBlock, /if existing\.is_some\(\)/);
  assert.match(planBlock, /"existing-overlay-snapshot"/);
  assert.match(planBlock, /compute_overlay_window_rect\(/);
  assert.match(planBlock, /same_mode_directed_measure\(/);
});

test("Rust 闸口：set_monitor_preferences 启动未换屏时不清空 custom_position，且 SetWindowPos 带 SWP_NOCOPYBITS", () => {
  const lib = read("src-tauri/src/lib.rs");
  const monitorAt = lib.indexOf("fn set_monitor_preferences(");
  assert.ok(monitorAt > 0);
  const monitorBlock = lib.slice(monitorAt, monitorAt + 1400);
  assert.match(monitorBlock, /let island_changed = prev_island != island;/);
  assert.match(monitorBlock, /if island_changed && !startup_already_on_target/);

  const atomicAt = lib.indexOf("fn set_window_rect_atomic(");
  assert.ok(atomicAt > 0);
  const atomicBlock = lib.slice(atomicAt, atomicAt + 700);
  assert.match(atomicBlock, /SWP_NOCOPYBITS/);
});

test("前端闸口：report_pet_slot_offset 只注册单次 effect，测量狗槽容器并上报 side/vertical", () => {
  const app = read("src/App.tsx");
  const matches = app.match(/invoke\("report_pet_slot_offset"/g) ?? [];
  assert.equal(matches.length, 1, "禁止重复注册 report_pet_slot_offset effect");
  assert.match(app, /document\.querySelector<HTMLElement>\("\.island__collapsed--pet-only"\)/);
  assert.match(app, /side,\s*\n\s*vertical,/);
});
