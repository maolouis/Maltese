// 任务栏避让：气泡/浮层不要被任务栏挡住。
//
// 背景：Windows 的 `monitor.work_area()` 只在任务栏**固定显示**时把任务栏那条边排除掉；
// 任务栏设为「自动隐藏」时 work_area 是整块屏幕，任务栏浮出就会盖住气泡底部。
// 所以这里用「显示器矩形 − 任务栏实际占用边」算出一块 safe rect，摆位后统一 clamp。
//
// Rust 侧（src-tauri/src/lib.rs）有同一套算法的镜像实现，两边都有单测，
// 改规则时请一起改。

export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export type ScreenSize = { width: number; height: number };
export type ScreenPoint = { x: number; y: number };

/** 显示器矩形（物理像素；副屏在左时 left 为负）。 */
export function monitorRect(monitor: {
  x: number;
  y: number;
  width: number;
  height: number;
}): ScreenRect {
  return {
    left: monitor.x,
    top: monitor.y,
    right: monitor.x + monitor.width,
    bottom: monitor.y + monitor.height,
  };
}

export function intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** 任务栏与显示器重叠后贴在哪个边；不构成「贴边任务栏」时返回 null。 */
export function taskbarEdgeOnMonitor(
  taskbar: ScreenRect,
  monitor: ScreenRect,
): "top" | "bottom" | "left" | "right" | null {
  const overlap = intersectRect(taskbar, monitor);
  if (!overlap) return null;
  const overlapW = overlap.right - overlap.left;
  const overlapH = overlap.bottom - overlap.top;
  const monitorW = monitor.right - monitor.left;
  const monitorH = monitor.bottom - monitor.top;
  // 只有「横跨这条边的大部分」的带状窗口才算任务栏：
  // 顶部/底部任务栏要求很宽、很薄；左右任务栏要求很高、很窄。
  const candidates = [
    { edge: "top" as const, distance: Math.abs(taskbar.top - monitor.top), thickness: overlapH, span: overlapW, axis: monitorW },
    { edge: "bottom" as const, distance: Math.abs(monitor.bottom - taskbar.bottom), thickness: overlapH, span: overlapW, axis: monitorW },
    { edge: "left" as const, distance: Math.abs(taskbar.left - monitor.left), thickness: overlapW, span: overlapH, axis: monitorH },
    { edge: "right" as const, distance: Math.abs(monitor.right - taskbar.right), thickness: overlapW, span: overlapH, axis: monitorH },
  ].filter((item) => item.thickness >= 12 && item.span >= item.axis * 0.4);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].edge;
}

/**
 * 气泡可用区 = 显示器矩形 ∩ work_area（任务栏固定时已经排除），再减去所有
 * 「贴在显示器边上」的任务栏（含自动隐藏浮出的那条），任务栏一侧留 `margin`。
 * 结果太小（<120 高 / <160 宽）时放弃削边，避免把窗口挤没。
 */
export function bubbleSafeRect(
  monitor: ScreenRect,
  work: ScreenRect,
  taskbars: ScreenRect[],
  margin = 8,
): ScreenRect {
  let safe = intersectRect(monitor, work) ?? { ...monitor };
  for (const taskbar of taskbars) {
    const edge = taskbarEdgeOnMonitor(taskbar, monitor);
    if (!edge) continue;
    const next = { ...safe };
    if (edge === "bottom") next.bottom = Math.min(next.bottom, taskbar.top - margin);
    if (edge === "top") next.top = Math.max(next.top, taskbar.bottom + margin);
    if (edge === "left") next.left = Math.max(next.left, taskbar.right + margin);
    if (edge === "right") next.right = Math.min(next.right, taskbar.left - margin);
    if (next.right - next.left < 160 || next.bottom - next.top < 120) continue;
    safe = next;
  }
  return safe;
}

/**
 * 把气泡窗口夹进 safe rect：尽量只平移；高度真的不够时才缩窗口高度
 * （宽度保持，避免改变内部布局）。
 */
export function clampBubbleRect(
  position: ScreenPoint,
  size: ScreenSize,
  safe: ScreenRect,
): { x: number; y: number; width: number; height: number } {
  const safeW = safe.right - safe.left;
  const safeH = safe.bottom - safe.top;
  const width = Math.max(1, Math.min(size.width, safeW));
  const height = Math.max(1, Math.min(size.height, safeH));
  const x = Math.min(Math.max(position.x, safe.left), safe.right - width);
  const y = Math.min(Math.max(position.y, safe.top), safe.bottom - height);
  return { x, y, width, height };
}