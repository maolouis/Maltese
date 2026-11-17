// 表情轮播方格墙的拖拽排序下标换算与落点命中。
//
// 单独放一个纯函数模块：组件和 node --test 都能直接引用，不需要模拟 React
// 或 Tauri 运行环境（QA D4/拖不动 的回归用例在 tests/gif-rotation-order.test.mjs）。

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

/** 一个格子当前的视口矩形（clientX / clientY 坐标系）与它在列表里的下标。 */
export type PetGifTileRect = {
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** 网格容器的视口矩形，用来判断指针是不是已经拖出网格。 */
export type PetGifBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type PetGifDropOptions = {
  /** 网格容器矩形；指针离开它（含 margin 边距）时返回 null，松手即取消。 */
  bounds?: PetGifBounds;
  /** 被拖起的格子下标：它自己永远不算落点（拖回原处视为不排序）。 */
  draggingIndex?: number;
  /** 网格边界外的容错距离，默认 24px。 */
  margin?: number;
};

function contains(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * 指针落点 → 松手后应当「占用」的格子下标；返回 null 表示不排序。
 *
 * 规则：
 * - 指针在某个格子内 → 那一格；正好压在**被拖起的格子**上 → null（拖到自身等于不动）。
 * - 指针落在格子间隙（网格 gap）→ 取中心点最近的一格，擦着边拖也能落位。
 * - 指针拖出网格（bounds + margin 之外）→ null，松手取消本次拖动。
 *
 * 触屏/笔没有 HTML5 拖放的 `dragover`/`drop`，拖动排序完全靠这个纯函数算落点，
 * 所以把它和 `movePetGifItem` 放在一起做单测。
 */
export function petGifDropTargetIndex(
  rects: PetGifTileRect[],
  point: { x: number; y: number },
  options: PetGifDropOptions = {},
): number | null {
  const { bounds, draggingIndex = -1, margin = 24 } = options;
  if (rects.length === 0) return null;
  if (bounds) {
    const outside =
      point.x < bounds.left - margin ||
      point.x > bounds.right + margin ||
      point.y < bounds.top - margin ||
      point.y > bounds.bottom + margin;
    if (outside) return null;
  }

  // 1) 直接命中某个格子（含被拖起的格子本身）。
  const hit = rects.find((rect) => contains(rect, point.x, point.y));
  if (hit) return hit.index === draggingIndex ? null : hit.index;

  // 2) 落在间隙里：取离指针最近的一格中心，忽略被拖起的格子。
  let best: PetGifTileRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (rect.index === draggingIndex) continue;
    const dx = point.x - (rect.left + rect.right) / 2;
    const dy = point.y - (rect.top + rect.bottom) / 2;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rect;
    }
  }
  return best === null ? null : best.index;
}