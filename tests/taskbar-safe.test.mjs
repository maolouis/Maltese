// 任务栏避让单测：四边任务栏、自动隐藏细条、负坐标副屏、极小屏、margin、夹取。

import assert from "node:assert/strict";
import test from "node:test";

import {
  bubbleSafeRect,
  clampBubbleRect,
  intersectRect,
  monitorRect,
  taskbarEdgeOnMonitor,
} from "../src/taskbarSafe.ts";

const primary = monitorRect({ x: 0, y: 0, width: 2560, height: 1440 });
// 本机副屏在左：1920×1080，x = -1920
const secondary = monitorRect({ x: -1920, y: 0, width: 1920, height: 1080 });

test("任务栏贴边判定：下 / 上 / 左 / 右，自动隐藏的 2px 细条不算占用", () => {
  assert.equal(taskbarEdgeOnMonitor({ left: 0, top: 1392, right: 2560, bottom: 1440 }, primary), "bottom");
  assert.equal(taskbarEdgeOnMonitor({ left: 0, top: 0, right: 2560, bottom: 48 }, primary), "top");
  assert.equal(taskbarEdgeOnMonitor({ left: 0, top: 0, right: 48, bottom: 1440 }, primary), "left");
  assert.equal(taskbarEdgeOnMonitor({ left: 2512, top: 0, right: 2560, bottom: 1440 }, primary), "right");
  // 自动隐藏收起：只剩 2px 露在屏幕外沿，不算占用
  assert.equal(taskbarEdgeOnMonitor({ left: 0, top: 1438, right: 2560, bottom: 1440 }, primary), null);
  // 跟这块屏无关的任务栏（另一块屏）→ null
  assert.equal(taskbarEdgeOnMonitor({ left: -1920, top: 1032, right: 0, bottom: 1080 }, primary), null);
});

test("safe rect：底部任务栏削掉下方并留 8px，work_area 已经排除时不重复削", () => {
  const workBottom = { left: 0, top: 0, right: 2560, bottom: 1392 }; // 固定任务栏时 work_area
  const taskbar = { left: 0, top: 1392, right: 2560, bottom: 1440 };
  const safe = bubbleSafeRect(primary, workBottom, [taskbar]);
  assert.deepEqual(safe, { left: 0, top: 0, right: 2560, bottom: 1384 });
});

test("自动隐藏：work_area 是整屏时靠任务栏矩形削边；任务栏收起（2px）时回到整屏", () => {
  const full = { left: 0, top: 0, right: 2560, bottom: 1440 };
  const popped = { left: 0, top: 1392, right: 2560, bottom: 1440 };
  const hidden = { left: 0, top: 1438, right: 2560, bottom: 1440 };
  const safePopped = bubbleSafeRect(primary, full, [popped]);
  assert.equal(safePopped.bottom, 1384);
  const safeHidden = bubbleSafeRect(primary, full, [hidden]);
  assert.equal(safeHidden.bottom, 1440);
});

test("顶部 / 左侧任务栏：分别抬高 top、推右 left", () => {
  const full = { left: 0, top: 0, right: 2560, bottom: 1440 };
  assert.deepEqual(
    bubbleSafeRect(primary, full, [{ left: 0, top: 0, right: 2560, bottom: 48 }]),
    { left: 0, top: 56, right: 2560, bottom: 1440 },
  );
  assert.deepEqual(
    bubbleSafeRect(primary, full, [{ left: 0, top: 0, right: 48, bottom: 1440 }]),
    { left: 56, top: 0, right: 2560, bottom: 1440 },
  );
});

test("副屏负坐标：左侧副屏的底部任务栏削边后仍为负 x 区域", () => {
  const secondaryTaskbar = { left: -1920, top: 1032, right: 0, bottom: 1080 };
  const safe = bubbleSafeRect(secondary, secondary, [secondaryTaskbar]);
  assert.equal(safe.left, -1920);
  assert.equal(safe.bottom, 1024);
  const clamped = clampBubbleRect({ x: -500, y: 900 }, { width: 300, height: 224 }, safe);
  assert.equal(clamped.y, 1024 - 224);
  assert.ok(clamped.x >= -1920 && clamped.x + 300 <= 0);
});

test("多任务栏：主屏底部 + 副屏左侧各自生效，互不影响", () => {
  const taskbars = [
    { left: 0, top: 1392, right: 2560, bottom: 1440 },
    { left: -1920, top: 0, right: -1872, bottom: 1080 },
  ];
  assert.equal(bubbleSafeRect(primary, primary, taskbars).bottom, 1384);
  assert.equal(bubbleSafeRect(secondary, secondary, taskbars).left, -1864);
});

test("夹取：底部越界整体上移；顶部越界也拉回；高度不够才缩高", () => {
  const safe = { left: 0, top: 0, right: 2560, bottom: 1384 };
  const moved = clampBubbleRect({ x: 100, y: 1300 }, { width: 300, height: 224 }, safe);
  assert.deepEqual(moved, { x: 100, y: 1160, width: 300, height: 224 });
  const top = clampBubbleRect({ x: 100, y: -50 }, { width: 300, height: 224 }, safe);
  assert.equal(top.y, 0);
  // 气泡比可用区还高：缩到 safe 高度
  const tiny = { left: 0, top: 0, right: 800, bottom: 200 };
  const shrunk = clampBubbleRect({ x: 0, y: 0 }, { width: 300, height: 224 }, tiny);
  assert.deepEqual(shrunk, { x: 0, y: 0, width: 300, height: 200 });
});

test("极小屏：削边后 >=160×120 正常削；小于就放弃削边保持原工作区", () => {
  const small = monitorRect({ x: 0, y: 0, width: 320, height: 240 });
  const taskbar = { left: 0, top: 192, right: 320, bottom: 240 };
  // 240 - 48 - 8 = 184 高，仍然可用 → 正常削
  assert.deepEqual(bubbleSafeRect(small, small, [taskbar]), { left: 0, top: 0, right: 320, bottom: 184 });
  // 屏只有 100 高：削完只剩 44，比气泡最小可用区还小 → 放弃削边
  const tiny = monitorRect({ x: 0, y: 0, width: 320, height: 100 });
  assert.deepEqual(bubbleSafeRect(tiny, tiny, [{ left: 0, top: 52, right: 320, bottom: 100 }]), tiny);
});

test("intersectRect：不相交返回 null", () => {
  assert.equal(intersectRect(primary, secondary), null);
  assert.deepEqual(intersectRect(primary, { left: 100, top: 100, right: 200, bottom: 200 }), {
    left: 100,
    top: 100,
    right: 200,
    bottom: 200,
  });
});