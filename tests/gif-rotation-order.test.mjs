import assert from "node:assert/strict";
import test from "node:test";
import { movePetGifItem, petGifDropTargetIndex, petGifIndexAtPoint } from "../src/utils/gifRotationOrder.ts";

// QA D4：方格墙的插入线原来永远画在目标格左侧，但向下拖时 reorder 实际插到
// 目标格之后。现在语义统一成「占用落点格子的位置」，并由组件按拖动方向把
// 插入线画在左/右；这里锁住下标换算本身。
//
// 用户实机反馈「拖不动」：根因是 Tauri 默认把 WebView2 的拖放交给原生文件
// 拖放处理器，网页收不到 HTML5 drag 事件。修复改用 Pointer Events 排序，
// 落点换算抽成 petGifDropTargetIndex()，一并在这里覆盖。

test("向上拖（from > to）插到目标格之前", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(movePetGifItem(items, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(movePetGifItem(items, 2, 0), ["c", "a", "b", "d"]);
  // 原数组不被修改
  assert.deepEqual(items, ["a", "b", "c", "d"]);
});

test("向下拖（from < to）插到目标格之后，与右侧插入线一致", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(movePetGifItem(items, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(movePetGifItem(items, 1, 3), ["a", "c", "d", "b"]);
});

test("原位落点、越界下标都返回同一个数组（调用方据此跳过写盘）", () => {
  const items = ["a", "b"];
  assert.equal(movePetGifItem(items, 1, 1), items);
  assert.equal(movePetGifItem(items, -1, 0), items);
  assert.equal(movePetGifItem(items, 0, 2), items);
  const empty = [];
  assert.equal(movePetGifItem(empty, 0, 1), empty);
});

test("相邻两格互相拖动的结果符合直觉", () => {
  const items = ["a", "b", "c"];
  // 按住 a 拖到 b 上松手：a 占用 b 的位置 → b,a,c
  assert.deepEqual(movePetGifItem(items, 0, 1), ["b", "a", "c"]);
  // 按住 c 拖到 b 上松手：c 占用 b 的位置 → a,c,b
  assert.deepEqual(movePetGifItem(items, 2, 1), ["a", "c", "b"]);
});

test("首尾边界：第一格和最后一格互拖", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(movePetGifItem(items, 0, 3), ["b", "c", "d", "a"]);
  assert.deepEqual(movePetGifItem(items, 3, 0), ["d", "a", "b", "c"]);
  // 两格列表的两个方向
  assert.deepEqual(movePetGifItem(["a", "b"], 0, 1), ["b", "a"]);
  assert.deepEqual(movePetGifItem(["a", "b"], 1, 0), ["b", "a"]);
});

test("拖到自身（from === to）永远是同一个数组，单格列表也不会动", () => {
  const items = ["a", "b", "c"];
  for (let index = 0; index < items.length; index += 1) {
    assert.equal(movePetGifItem(items, index, index), items);
  }
  const single = ["only"];
  assert.equal(movePetGifItem(single, 0, 0), single);
  const empty = [];
  assert.equal(movePetGifItem(empty, 0, 0), empty);
});

// —— 指针落点命中（Pointer Events 排序用）——
// 模拟 2×2 网格：每格 100×100，gap 8px，坐标就是 getBoundingClientRect 的视口坐标。
const grid = [
  { index: 0, left: 0, top: 0, right: 100, bottom: 100 },
  { index: 1, left: 108, top: 0, right: 208, bottom: 100 },
  { index: 2, left: 0, top: 108, right: 100, bottom: 208 },
  { index: 3, left: 108, top: 108, right: 208, bottom: 208 },
];
const bounds = { left: 0, top: 0, right: 208, bottom: 208 };

test("指针落在哪一格就占用哪一格；压在被拖的格子上算不排序", () => {
  assert.equal(petGifDropTargetIndex(grid, { x: 50, y: 50 }), 0);
  assert.equal(petGifDropTargetIndex(grid, { x: 180, y: 180 }), 3);
  // 按住第 0 格拖，指针还压在自己身上 → null（松手什么都不做）
  assert.equal(petGifDropTargetIndex(grid, { x: 50, y: 50 }, { draggingIndex: 0 }), null);
  // 拖到第 3 格上 → 占用第 3 格的位置（movePetGifItem(items,0,3) = b,c,d,a）
  assert.equal(petGifDropTargetIndex(grid, { x: 180, y: 180 }, { draggingIndex: 0 }), 3);
  // 空列表没有落点
  assert.equal(petGifDropTargetIndex([], { x: 10, y: 10 }), null);
});

test("落在格子间隙取最近一格，拖出网格（含 24px 容错）返回 null 取消排序", () => {
  // 横向 gap 正中 (104,50) 到两格中心等距 → 取先遍历到的 0，保证结果稳定
  assert.equal(petGifDropTargetIndex(grid, { x: 104, y: 50 }), 0);
  // 偏第 1 格一侧就取 1
  assert.equal(petGifDropTargetIndex(grid, { x: 106, y: 50 }), 1);
  // 网格右侧 24px 容错之内仍可落位到最近的第 1 格
  assert.equal(petGifDropTargetIndex(grid, { x: 220, y: 50 }, { bounds }), 1);
  // 超出容错 → null，松手取消本次拖动
  assert.equal(petGifDropTargetIndex(grid, { x: 400, y: 50 }, { bounds }), null);
  assert.equal(petGifDropTargetIndex(grid, { x: 50, y: -100 }, { bounds }), null);
});
// —— 容器级拖拽（2026-11-17 修复）：pointerdown 命中测试 + 松手前重算落点 ——

test("容器级命中：按在格子里得到下标，按在间隙/网格外返回 null", () => {
  assert.equal(petGifIndexAtPoint(grid, { x: 50, y: 50 }), 0);
  assert.equal(petGifIndexAtPoint(grid, { x: 180, y: 50 }), 1);
  assert.equal(petGifIndexAtPoint(grid, { x: 104, y: 50 }), null, "格子间隙不算按住某一格");
  assert.equal(petGifIndexAtPoint(grid, { x: -10, y: 50 }), null);
  assert.equal(petGifIndexAtPoint([], { x: 50, y: 50 }), null);
});

test("松手时用重新测量后的矩形算落点：滚动前后同一坐标落到不同格子", () => {
  // 拖动中网格向上滚了 120px：格子矩形整体上移，旧矩形已经失效。
  const scrolled = grid.map((rect) => ({
    ...rect,
    top: rect.top - 120,
    bottom: rect.bottom - 120,
  }));
  const point = { x: 50, y: 40 };
  // 旧矩形里 (50,40) 落在第 0 格；新矩形里第 0 格已经上移到 -120~-20，命中第 2 格。
  assert.equal(petGifIndexAtPoint(grid, point), 0);
  assert.equal(petGifIndexAtPoint(scrolled, point), 2);
  assert.equal(petGifDropTargetIndex(scrolled, point, { draggingIndex: 0 }), 2);
  assert.deepEqual(movePetGifItem(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
});

test("容器命中 + 落点 + 排序串起来：从第 1 格拖到第 4 格", () => {
  const items = ["a", "b", "c", "d"];
  const from = petGifIndexAtPoint(grid, { x: 180, y: 180 });
  assert.equal(from, 3);
  const to = petGifDropTargetIndex(grid, { x: 50, y: 50 }, { draggingIndex: from });
  assert.equal(to, 0);
  assert.deepEqual(movePetGifItem(items, from, to), ["d", "a", "b", "c"]);
});
