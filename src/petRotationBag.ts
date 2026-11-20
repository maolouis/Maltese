// 轮播「洗牌袋 + 最近去重 + 权重封顶」纯函数。
//
// 背景（用户反馈 P1：表情轮播一直是那几个）：原先 `sampleFrames` 每次会话固定抽 30 张、
// 播放列表顺序稳定，而且 `usePetGifRotation` 每次重建列表都把指针重置到 0，
// 所以看到的永远是同一批、同一顺序的几张。
//
// 这里做三件事（无 React / DOM 依赖，node --test 可直接跑）：
// 1. Shuffle bag：每个状态把**全部可用帧**洗牌成袋子，逐个播完再重新洗（一轮内不重复、全量覆盖）；
// 2. 最近 8 个播放过的帧去重：抽到近期播过的就跳过，最多重试 5 次；
// 3. 权重封顶：单状态 ≤ MAX_STATE_WEIGHT，且每个状态至少 MIN_STATE_SHARE 的占比。

export type RotationBag = {
  /** 本轮洗好的帧顺序。 */
  order: string[];
  /** 下一个要播的位置；== order.length 表示该重新洗牌。 */
  index: number;
};

export type BagStore = {
  version: 1;
  bags: Record<string, RotationBag>;
  recent: string[];
};

export const ROTATION_BAG_STORAGE_KEY = "maltese-rotation-bags";
/** 最近播放去重窗口。 */
export const RECENT_LIMIT = 8;
/** 抽到近期播过的帧时最多重试几次（避免死循环）。 */
export const RECENT_RETRY = 5;
/** 单状态权重上限（避免某状态 ×5 霸屏）。 */
export const MAX_STATE_WEIGHT = 3.0;
/** 每个状态的最低占比。 */
export const MIN_STATE_SHARE = 0.02;

function normalizeRng(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 0.999999;
  return value;
}

/** Fisher–Yates；rng 可注入便于单测。 */
export function shuffled<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(normalizeRng(rng()) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 新袋：全部帧洗牌。 */
export function refillBag(frames: readonly string[], rng: () => number = Math.random): RotationBag {
  return { order: shuffled(frames, rng), index: 0 };
}

/**
 * 从袋里取下一帧；袋子用完自动重洗。
 * 抽到的帧在 `recent` 里则跳过（最多 RECENT_RETRY 次），保证「不连着重复」。
 */
export function nextFromBag(
  frames: readonly string[],
  bag: RotationBag | null | undefined,
  recent: readonly string[],
  rng: () => number = Math.random,
): { frame: string | null; bag: RotationBag } {
  if (frames.length === 0) {
    return { frame: null, bag: { order: [], index: 0 } };
  }
  let current = bag && bag.order.length > 0 ? bag : refillBag(frames, rng);
  // 帧池变了（换形象/改勾选）：袋里可能有不在池里的帧 → 重洗。
  if (current.order.some((frame) => !frames.includes(frame))) {
    current = refillBag(frames, rng);
  }
  for (let attempt = 0; attempt <= RECENT_RETRY; attempt += 1) {
    if (current.index >= current.order.length) {
      current = refillBag(frames, rng);
    }
    const frame = current.order[current.index];
    if (!frame) break;
    current = { order: current.order, index: current.index + 1 };
    if (frames.includes(frame) && !recent.includes(frame)) {
      return { frame, bag: current };
    }
  }
  // 重试都命中最近 8 个（池子比窗口还小）：退而取当前袋里第一个可用帧。
  if (current.index >= current.order.length) {
    current = refillBag(frames, rng);
  }
  const fallback = current.order[current.index] ?? frames[0] ?? null;
  return {
    frame: fallback,
    bag: { order: current.order, index: Math.min(current.index + 1, current.order.length) },
  };
}

/** 最近播放窗口（新的在前）。 */
export function pushRecent(recent: readonly string[], frame: string, limit = RECENT_LIMIT): string[] {
  return [frame, ...recent.filter((item) => item !== frame)].slice(0, limit);
}

/** 按权重抽一个状态（权重先经过封顶/兜底归一）。 */
export function pickWeightedState(
  weights: Record<string, number>,
  rng: () => number = Math.random,
): string | null {
  const entries = Object.entries(weights).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = normalizeRng(rng()) * total;
  for (const [state, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return state;
  }
  return entries[entries.length - 1][0];
}

/**
 * 权重封顶 + 最低占比：
 * - 每个状态先 clamp 到 [0.05, MAX_STATE_WEIGHT]；
 * - 再把低于「总权重 × MIN_STATE_SHARE」的状态抬到该下限（最多迭代 4 次，避免来回震荡）。
 */
export function clampRotationWeights(
  weights: Record<string, number>,
  options: { max?: number; minShare?: number } = {},
): Record<string, number> {
  const max = options.max ?? MAX_STATE_WEIGHT;
  const minShare = options.minShare ?? MIN_STATE_SHARE;
  const out: Record<string, number> = {};
  const keys = Object.keys(weights);
  if (keys.length === 0) return out;
  for (const key of keys) {
    const value = Number(weights[key]);
    out[key] = Number.isFinite(value) && value > 0 ? Math.min(value, max) : 0.05;
  }
  // 抬到最低占比会抬高总权重、进而抬高门槛，迭代到稳定（一般 5–10 轮内收敛）。
  for (let round = 0; round < 24; round += 1) {
    const total = Object.values(out).reduce((sum, value) => sum + value, 0);
    const floor = total * minShare;
    let changed = false;
    for (const key of keys) {
      if (out[key] < floor - 1e-9) {
        out[key] = floor;
        changed = true;
      }
      if (out[key] > max) {
        out[key] = max;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 持久化（跨会话保持袋子进度；失败/损坏一律当没有）
// ---------------------------------------------------------------------------

export function emptyBagStore(): BagStore {
  return { version: 1, bags: {}, recent: [] };
}

export function loadBagStore(storage: Storage | null): BagStore {
  if (!storage) return emptyBagStore();
  try {
    const raw = storage.getItem(ROTATION_BAG_STORAGE_KEY);
    if (!raw) return emptyBagStore();
    const parsed = JSON.parse(raw) as Partial<BagStore>;
    if (parsed?.version !== 1 || typeof parsed.bags !== "object" || parsed.bags === null) {
      return emptyBagStore();
    }
    const bags: Record<string, RotationBag> = {};
    for (const [key, value] of Object.entries(parsed.bags)) {
      if (!value || !Array.isArray(value.order)) continue;
      bags[key] = {
        order: value.order.filter((frame): frame is string => typeof frame === "string"),
        index: Math.max(0, Math.floor(Number(value.index) || 0)),
      };
    }
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent.filter((frame): frame is string => typeof frame === "string").slice(0, RECENT_LIMIT)
      : [];
    return { version: 1, bags, recent };
  } catch {
    return emptyBagStore();
  }
}

export function saveBagStore(storage: Storage | null, store: BagStore): void {
  if (!storage) return;
  try {
    storage.setItem(ROTATION_BAG_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 配额/隐私模式失败不影响轮播。
  }
}

/** 播放列表重建时指针怎么走：新列表里还能找到刚播的那帧就继续，否则从 0 开始。 */
export function nextIndexAfterFramesChange(
  frames: readonly string[],
  previousFrame: string | null,
  previousIndex: number,
): number {
  if (frames.length === 0) return 0;
  if (previousFrame) {
    const found = frames.indexOf(previousFrame);
    if (found >= 0) return (found + 1) % frames.length;
  }
  if (previousIndex > 0 && previousIndex < frames.length) return previousIndex;
  return 0;
}