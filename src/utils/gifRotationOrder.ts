// 表情轮播方格墙的拖拽排序下标换算。
//
// 单独放一个纯函数模块：组件和 node --test 都能直接引用，不需要模拟 React
// 或 Tauri 运行环境（QA D4 的回归用例在 tests/gif-rotation-order.test.mjs）。

/**
 * 把 from 处的项取出来放到 to 处（to 是落点格子的下标）。
 *
 * 语义是「占用落点格子的位置」：向上拖（from > to）插到目标格之前，
 * 向下拖（from < to）插到目标格之后。设置页的插入线按拖动方向画在目标格
 * 的左侧/右侧，保证视觉提示和松手后的顺序一致。
 * 越界或原位落点时原样返回同一个数组，调用方据此跳过写盘。
 */
export function movePetGifItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const removed = next.splice(from, 1);
  const moved = removed[0];
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}