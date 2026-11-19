// 多屏放置的纯逻辑：指纹匹配 / 锚点 / DPI 换算 / 下拉选项。
// 说明：显示器索引在热插拔、改分辨率后会变，所以持久化的是「名字 + 分辨率」指纹；
// 匹配顺序：完全一致 → 同名（换了分辨率）→ 同几何（换了接口）→ 找不到（视为断开）。
// node --test 可以直接跑（无 React / Tauri 依赖）。

export type MonitorFingerprint = {
  /** 显示器名，如 `\\.\DISPLAY1`。 */
  name: string;
  /** 稳定指纹：`name|宽x高`。 */
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
};

export type MonitorTarget = {
  key?: string;
  name: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
};

export type MonitorMatch = {
  monitor: MonitorFingerprint | null;
  matchedBy: "exact" | "name" | "geometry" | "none";
};

/** 显示器指纹：名字 + 分辨率（+ 可选位置）。不含索引，热插拔/换位置都不变。 */
export function monitorKey(
  name: string,
  width: number,
  height: number,
  x?: number,
  y?: number,
): string {
  const base = `${name}|${width}x${height}`;
  return Number.isFinite(x) && Number.isFinite(y) ? `${base}@${x},${y}` : base;
}

/** 匹配顺序：完整指纹（名字+分辨率+位置）→ 名字+分辨率 → 只名字 → 尺寸+位置。 */
export function matchMonitor(target: MonitorTarget, monitors: MonitorFingerprint[]): MonitorMatch {
  const wantedKey = target.key ?? monitorKey(target.name, target.width, target.height, target.x, target.y);
  const exact = monitors.find((monitor) => monitor.key === wantedKey);
  if (exact) return { monitor: exact, matchedBy: "exact" };
  const sameNameSize = monitors.find((monitor) =>
    monitor.key.split("@")[0] === `${target.name}|${target.width}x${target.height}`);
  if (sameNameSize) return { monitor: sameNameSize, matchedBy: "name" };
  const sameName = monitors.find((monitor) => monitor.name === target.name);
  if (sameName) return { monitor: sameName, matchedBy: "name" };
  const sameGeometry = monitors.find(
    (monitor) =>
      monitor.width === target.width &&
      monitor.height === target.height &&
      (target.x === undefined || monitor.x === target.x) &&
      (target.y === undefined || monitor.y === target.y),
  );
  if (sameGeometry) return { monitor: sameGeometry, matchedBy: "geometry" };
  return { monitor: null, matchedBy: "none" };
}

/** 逻辑像素 → 目标屏物理像素（DPR 用**目标屏**的 scale，不是当前窗口的）。 */
export function toPhysical(logical: number, scale: number): number {
  if (!Number.isFinite(logical) || !Number.isFinite(scale) || scale <= 0) return Math.round(logical || 0);
  return Math.round(logical * scale);
}

export type WorkArea = { x: number; y: number; width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** 把矩形夹进某块屏的工作区（跨屏切换后旧坐标可能完全在外）。 */
export function clampRectToWorkArea(rect: Rect, work: WorkArea): Rect {
  const maxX = work.x + work.width - rect.width;
  const maxY = work.y + work.height - rect.height;
  return {
    x: Math.min(Math.max(rect.x, work.x), Math.max(work.x, maxX)),
    y: Math.min(Math.max(rect.y, work.y), Math.max(work.y, maxY)),
    width: rect.width,
    height: rect.height,
  };
}

export type Corner = "tl" | "tr" | "bl" | "br";

/**
 * 锁角：在**该屏**工作区的对应角（右下角 = 这块屏的右下角），边距固定。
 * `corner` 为空表示不锁角（返回 null，由 Rust 用默认锚点）。
 */
export function cornerRectOnMonitor(
  work: WorkArea,
  corner: Corner,
  slot: { width: number; height: number },
  margin: number,
): Rect | null {
  if (!Number.isFinite(margin) || margin < 0) return null;
  const x = corner === "tl" || corner === "bl"
    ? work.x + margin
    : work.x + work.width - slot.width - margin;
  const y = corner === "tl" || corner === "tr"
    ? work.y + margin
    : work.y + work.height - slot.height - margin;
  return { x, y, width: slot.width, height: slot.height };
}

export type ScreenChoice = "last" | "primary" | "monitor";

export type ScreenSelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 生成下拉选项：
 * - 「跟随上次位置」/「主屏」+ 每块副屏（`name 2560×1440 @100%`）；
 * - 只有一块屏时只留主屏（调用方把 select 禁用并显示「只有一块屏幕」）。
 * 排序：主屏在前，其余按 x 从左到右（副屏在左时 x 为负）。
 */
export function screenSelectOptions(
  monitors: MonitorFingerprint[],
  options: { followLabel: string; primaryLabel: string },
): ScreenSelectOption[] {
  if (monitors.length <= 1) {
    return [{ value: "primary", label: options.primaryLabel, disabled: true }];
  }
  const sorted = [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x);
  const result: ScreenSelectOption[] = [
    { value: "last", label: options.followLabel },
    { value: "primary", label: options.primaryLabel },
  ];
  const secondary = sorted.filter((monitor) => !monitor.primary);
  secondary.forEach((monitor, index) => {
    result.push({
      value: monitor.key,
      label: `副屏 ${index + 1} · ${monitor.width}×${monitor.height} @${Math.round(monitor.scale * 100)}%`,
    });
  });
  return result;
}

/** 把设置里的值解析成 `set_monitor_preferences` 需要的岛/Bongo 指纹。 */
export function resolveMonitorPreference(
  choice: ScreenChoice | string,
  monitors: MonitorFingerprint[],
  fallbackToPrimaryKey: boolean,
): string | null {
  if (choice === "last" || choice === "" || choice === "follow") return null;
  if (choice === "primary") {
    if (!fallbackToPrimaryKey) return null;
    return monitors.find((monitor) => monitor.primary)?.key ?? null;
  }
  return choice;
}

/** Bongo 的下拉值：`follow` = 跟随小狗所在屏。 */
export function resolveBongoPreference(
  choice: ScreenChoice | "follow" | string,
  monitors: MonitorFingerprint[],
  islandPreference: string | null,
): string | null {
  if (choice === "follow") return islandPreference;
  return resolveMonitorPreference(choice, monitors, true);
}
/**
 * 「Bongo 跟随小狗」的目标屏解析（与 Rust `resolve_extras_target_key` 同规则）：
 * 1. Bongo 单独指定了屏 → 用它；
 * 2. 没单独指定、但「小狗屏幕」有具体偏好 → 跟随偏好指纹；
 * 3. 「小狗屏幕」是「跟随上次位置」/未设置（偏好 null）→ 跟随小狗**实际所在显示器**，
 *    不能回主屏——否则小狗靠持久化位置落在副屏时，重启后 Bongo 会留在主屏。
 */
export function resolveExtrasTargetKey(
  bongoPreference: string | null,
  islandPreference: string | null,
  islandActualMonitor: string | null,
): string | null {
  return bongoPreference ?? islandPreference ?? islandActualMonitor ?? null;
}

// ---------------------------------------------------------------------------
// 「固定在桌面的标签页」(pinned) 的多屏行为：与主岛共用同一份「小狗屏幕」偏好。
// ---------------------------------------------------------------------------

export type PinnedSize = { width: number; height: number };
export type PinnedPoint = { x: number; y: number };

/** pinned 窗口默认贴边距（目标屏右下角）。 */
export const PINNED_MARGIN = 24;

/** pinned 逻辑尺寸（与 Rust window_factory 的 420×560 一致）。 */
export const PINNED_LOGICAL_SIZE: PinnedSize = { width: 420, height: 560 };

/**
 * 解析 pinned 的目标屏工作区：跟随主岛的 `islandScreen` 偏好（指纹匹配），
 * 偏好为空（跟随上次位置）或匹配不到（副屏被拔）→ 回主屏。
 */
export function resolvePinnedWorkArea(
  islandScreen: string | null | undefined,
  monitors: MonitorFingerprint[],
): { monitor: MonitorFingerprint; work: WorkArea } | null {
  const primary = monitors.find((monitor) => monitor.primary) ?? monitors[0];
  if (!primary) return null;
  if (!islandScreen || islandScreen === "last" || islandScreen === "follow") {
    return { monitor: primary, work: toWorkArea(primary) };
  }
  const target =
    islandScreen === "primary"
      ? primary
      : monitors.find((monitor) => monitor.key === islandScreen) ??
        matchMonitor({ key: islandScreen, name: islandScreen, width: 0, height: 0 }, monitors).monitor ??
        primary;
  return { monitor: target, work: toWorkArea(target) };
}

export function toWorkArea(monitor: MonitorFingerprint): WorkArea {
  return { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
}

/**
 * pinned 默认位置：目标屏工作区右下角，留 `margin` 物理像素（默认 24）。
 * 小于工作区时贴左边/上边，不会出现负坐标。
 */
export function pinnedDefaultPosition(
  work: WorkArea,
  size: PinnedSize,
  margin: number = PINNED_MARGIN,
): PinnedPoint {
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : PINNED_MARGIN;
  return {
    x: Math.max(work.x, work.x + work.width - size.width - safeMargin),
    y: Math.max(work.y, work.y + work.height - size.height - safeMargin),
  };
}

/** 换屏后把 pinned 的旧位置夹进目标屏工作区（用户拖动过的位置尽量保留）。 */
export function clampPinnedPosition(
  position: PinnedPoint,
  size: PinnedSize,
  work: WorkArea,
): PinnedPoint {
  const maxX = work.x + work.width - size.width;
  const maxY = work.y + work.height - size.height;
  return {
    x: Math.min(Math.max(position.x, work.x), Math.max(work.x, maxX)),
    y: Math.min(Math.max(position.y, work.y), Math.max(work.y, maxY)),
  };
}

/**
 * pinned 的物理尺寸：逻辑尺寸 × **目标屏自己的 scale_factor**（与主岛一致）。
 * 100% 副屏 → 420×560；150% 副屏 → 630×840。
 */
export function pinnedPhysicalSize(
  size: PinnedSize = PINNED_LOGICAL_SIZE,
  targetScale: number,
): PinnedSize {
  return {
    width: toPhysical(size.width, targetScale),
    height: toPhysical(size.height, targetScale),
  };
}
