// 最小化漂移 / 闪烁防护的纯逻辑（方便 node --test 直接断言）。
//
// 复现：对桌宠窗口用**任何**方式最小化（任务栏右键菜单 / 任务栏按钮 / Alt+Tab / 标题栏 −），
// 还原后小狗位置回不到原处，且对话面板会闪一下。
// 两个根因：
//   1) 最小化期间 `outer_position()` 返回 (-32000, -32000) 哨兵值、`outer_size()` 变 0；
//      几何入口拿它夹取/写回就会改掉系统的「还原位置」（Rust 侧见 lib.rs 的
//      `island_geometry_frozen` / `PRE_MINIMIZE_ISLAND_RECT`）。
//   2) 最小化会触发 `onFocusChanged(false)` → 前端把它当成「用户点了别处」→
//      `collapseIsland()` → 面板闪一下并重发 collapsed 几何。
// 这里只放判据：焦点丢失到底该不该收起面板。

/** 失焦后等这么久再判定是否收起：最小化有几十毫秒的竞态（任务栏右键菜单尤其明显）。 */
export const MINIMIZE_BLUR_SETTLE_MS = 160;

/** Windows 最小化哨兵坐标（约 -32000）——这种位置绝不是真实窗口位置。 */
export const MINIMIZED_SENTINEL_THRESHOLD = -30_000;

/** 桌宠窗口的合理最小尺寸（逻辑/物理都远大于它；0 尺寸 = 最小化或创建中）。 */
export const MIN_SANE_ISLAND_SIZE = 32;

export type IslandRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function isSentinelWindowPosition(x: number, y: number): boolean {
  return !Number.isFinite(x) || !Number.isFinite(y)
    || x <= MINIMIZED_SENTINEL_THRESHOLD
    || y <= MINIMIZED_SENTINEL_THRESHOLD;
}

/** 过滤「最小化 / 0 尺寸 / 哨兵坐标」的伪矩形，只留真实几何。 */
export function isSaneIslandRect(rect: IslandRectLike | null | undefined): boolean {
  if (!rect) return false;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
  if (rect.width < MIN_SANE_ISLAND_SIZE || rect.height < MIN_SANE_ISLAND_SIZE) return false;
  return !isSentinelWindowPosition(rect.x, rect.y);
}

export type BlurCollapseInput = {
  /** 焦点事件：true = 获得焦点。 */
  focused: boolean;
  /** 当前岛态（collapsed / expanded）。 */
  mode: string;
  /** 窗口此刻是否最小化（`getCurrentWindow().isMinimized()`）。 */
  minimized: boolean;
  /** 距失焦已经过去多久（毫秒）。 */
  settleMs: number;
};

/**
 * 失焦时要不要把展开面板收起来：
 * - 只有「展开态 + 真的失焦」才收；
 * - 最小化 / 最小化还原过渡期（settle 未到）不收，避免闪烁与多余几何重发。
 */
export function shouldCollapseOnBlur(input: BlurCollapseInput): boolean {
  if (input.focused) return false;
  if (input.mode !== "expanded") return false;
  if (input.minimized) return false;
  if (!Number.isFinite(input.settleMs) || input.settleMs < MINIMIZE_BLUR_SETTLE_MS) return false;
  return true;
}