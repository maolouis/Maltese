// 删除 GIF 的确认流程、可撤销回收站与顺序恢复的纯逻辑。
//
// 这些函数不碰 DOM / localStorage / Tauri，方便 `tests/*.test.mjs` 直接单测：
// 组件只负责把它们接到界面上（确认框、提示条、回收站列表）。

/** 回收站只保留最近这么多条删除记录。 */
export const PET_GIF_TRASH_LIMIT = 10;

/** 和 `petGifRotation.PetGifRotationItem` 结构一致；这里不 import 它，避免测试拉起 React/Tauri 依赖。 */
export type RemovablePetGifItem = {
  id: string;
  name: string;
  src?: string;
  path?: string;
  custom?: boolean;
};

export type PetGifTrashEntry = {
  /** 回收站条目 id（一次删除一个）。 */
  id: string;
  /** 删除时的形象 id（xiaobai / xiaojimao / duo）。 */
  character: string;
  /** 删除时的表情状态（idle / angry …）。 */
  state: string;
  /** 删除前在轮播列表里的下标，恢复时插回原位。 */
  index: number;
  item: RemovablePetGifItem;
  /** 删除时间（epoch ms）。 */
  deletedAt: number;
  /** 自定义 GIF 在 pet-gifs-trash 里的副本路径；内置素材没有。 */
  trashPath?: string;
};

// ---------------------------------------------------------------------------
// 确认流程状态机
// ---------------------------------------------------------------------------

export type PetGifRemovalStatus = "idle" | "confirming" | "deleting";

export type PetGifRemovalState = {
  status: PetGifRemovalStatus;
  /** 正在询问 / 正在删除的那一项。 */
  item: RemovablePetGifItem | null;
};

export const PET_GIF_REMOVAL_IDLE: PetGifRemovalState = { status: "idle", item: null };

/**
 * 右键/点垃圾桶 → 进入确认态。只有空闲时才接受新请求，
 * 避免删除动画/确认框里重复触发造成「一次点击删两张」。
 */
export function requestPetGifRemoval(
  state: PetGifRemovalState,
  item: RemovablePetGifItem,
): PetGifRemovalState {
  if (state.status !== "idle") return state;
  return { status: "confirming", item };
}

/** 取消（Esc / 点取消 / 点遮罩）：回到空闲，不删除任何东西。 */
export function cancelPetGifRemoval(state: PetGifRemovalState): PetGifRemovalState {
  if (state.status !== "confirming") return state;
  return PET_GIF_REMOVAL_IDLE;
}

/**
 * 用户确认后才允许真正删除。未确认（idle / deleting）时返回 `item: null`，
 * 调用方必须拿到非空 item 才继续执行文件删除与配置写入。
 */
export function beginPetGifDeletion(state: PetGifRemovalState): {
  state: PetGifRemovalState;
  item: RemovablePetGifItem | null;
} {
  if (state.status !== "confirming" || !state.item) {
    return { state, item: null };
  }
  return { state: { status: "deleting", item: state.item }, item: state.item };
}

/** 删除流程结束（成功或失败）后收掉确认框。 */
export function finishPetGifRemoval(state: PetGifRemovalState): PetGifRemovalState {
  if (state.status !== "deleting") return state;
  return PET_GIF_REMOVAL_IDLE;
}

// ---------------------------------------------------------------------------
// 回收站（localStorage 里保留最近 N 条）
// ---------------------------------------------------------------------------

/**
 * 把一条删除记录插到最前面，超过上限时丢掉最旧的一条。
 * 返回被挤出去的那条，调用方负责删掉它对应的磁盘副本。
 */
export function pushPetGifTrashEntry(
  entries: readonly PetGifTrashEntry[],
  entry: PetGifTrashEntry,
  limit: number = PET_GIF_TRASH_LIMIT,
): { entries: PetGifTrashEntry[]; evicted: PetGifTrashEntry | null } {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const kept = entries.filter((existing) => existing.id !== entry.id);
  const next = [entry, ...kept];
  const overflow = next.slice(boundedLimit);
  return {
    entries: next.slice(0, boundedLimit),
    evicted: overflow.length > 0 ? overflow[overflow.length - 1] : null,
  };
}

/** 移除某条记录（恢复成功 / 用户手动清掉后）。 */
export function removePetGifTrashEntry(
  entries: readonly PetGifTrashEntry[],
  id: string,
): PetGifTrashEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/** 按删除时间倒序（最新的在最前面），展示用。 */
export function sortPetGifTrash(entries: readonly PetGifTrashEntry[]): PetGifTrashEntry[] {
  return [...entries].sort((a, b) => b.deletedAt - a.deletedAt);
}

// ---------------------------------------------------------------------------
// 顺序恢复
// ---------------------------------------------------------------------------

/**
 * 恢复时插回原下标：下标越界（期间列表变短）时夹到末尾，已是最后一张时插到末尾。
 * 同一 id 已经在列表里就原样返回（避免重复恢复出现两张一样的 GIF）。
 */
export function restorePetGifItemIntoList<T extends { id: string }>(
  list: readonly T[],
  item: T,
  index: number,
): T[] {
  if (list.some((existing) => existing.id === item.id)) return [...list];
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : list.length;
  const at = Math.min(Math.max(safeIndex, 0), list.length);
  return [...list.slice(0, at), item, ...list.slice(at)];
}