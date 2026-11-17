import assert from "node:assert/strict";
import test from "node:test";
import { movePetGifItem } from "../src/utils/gifRotationOrder.ts";

// QA D4：方格墙的插入线原来永远画在目标格左侧，但向下拖时 reorder 实际插到
// 目标格之后。现在语义统一成「占用落点格子的位置」，并由组件按拖动方向把
// 插入线画在左/右；这里锁住下标换算本身。

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