// 桌宠自我状态（体力 / 情绪 / 亲密 / 专注）的纯函数模型。
// 规格：docs/research-pet-self-state.md + 2026-11-17 派单（新增第 4 指标 focus）。
//
// 设计边界（重要）：
// - 只影响 `petState === "idle"` 的待机轮播权重；动作 / 通知 / 音乐 / Agent 的优先级完全不动；
// - 事件驱动 + 60s 结算，不用每秒重算；
// - 不下惩罚：体力/情绪/亲密有下限（15/20/30），永不主动播 cry/angry；
// - 不读聊天正文：只用 `role === "user"` 的时间戳。
// 这里没有任何 React / DOM 依赖，node --test 可以直接跑。

export type PetVitals = {
  /** 体力 0–100（下限 15）。 */
  energy: number;
  /** 情绪 0–100（下限 20）。 */
  mood: number;
  /** 亲密 0–100（下限 30）。 */
  bond: number;
  /** 专注 0–100（下限 0；半衰期 45 分钟）。 */
  focus: number;
  /** 上次结算时间（毫秒）。 */
  updatedAt: number;
  /** 每类事件最后一次生效时间（冷却用）。 */
  lastAt: Partial<Record<VitalsEventKind, number>>;
  /** 当日累计：日期 + 各类增益总额 + 各类次数。 */
  today: {
    date: string;
    gained: Record<"energy" | "mood" | "bond" | "focus", number>;
    count: Partial<Record<VitalsEventKind, number>>;
  };
};

export type VitalsEventKind =
  | "pet"      // 摸头（含单击小狗换表情）
  | "eat"      // 喂食
  | "play"     // 陪玩 / 转圈 / 兜风 / 泡澡 / 装扮
  | "care"     // 抱抱 / 挠下巴 / 比心
  | "sleep"    // 睡觉
  | "todoDone" // 完成待办
  | "todoStart"// 开始待办（进入专注）
  | "todoStop" // 结束待办（退出专注）
  | "chat"     // 用户发了一条聊天（只上报“发送”，不含文本）
  | "bongo";   // Bongo 敲击

export type VitalsDelta = { energy: number; mood: number; bond: number; focus: number };

export const VITALS_STORAGE_KEY = "maltese-pet-vitals";
/** 半衰期（毫秒）。 */
export const VITALS_HALF_LIFE_MS = {
  energy: 6 * 3_600_000,
  mood: 2 * 3_600_000,
  bond: 72 * 3_600_000,
  /** 专注：45 分钟。 */
  focus: 45 * 60_000,
} as const;
/** 下限：保证长期不互动也不会「摆烂惩罚」用户。 */
export const VITALS_FLOOR = { energy: 15, mood: 20, bond: 30, focus: 0 } as const;
export const VITALS_CEIL = 100;
/** 初始值（focus 由使用方按「是否正在待办中」给 0–50）。 */
export const VITALS_INITIAL = { energy: 70, mood: 70, bond: 50 } as const;
/** 结算间隔：60s。 */
export const VITALS_TICK_MS = 60_000;
/** 专注度每 5 分钟 +1（只在「待办进行中」时涨）。 */
export const VITALS_FOCUS_GAIN_PER_5MIN = 1;

/** 每类事件的基准增益与冷却。delta 是「第一次」的满额，重复会递减。 */
/** 开始待办时专注至少到这个值（规格：focus 进入专注即 ≥70）。 */
export const VITALS_FOCUS_ON_TODO_START = 70;

export const VITALS_EVENTS: Record<
  VitalsEventKind,
  { delta: VitalsDelta; cooldownMs: number; dailyLimit?: number; key: keyof PetVitals["today"]["gained"] }
> = {
  pet: { delta: { energy: 2, mood: 4, bond: 1.5, focus: 0 }, cooldownMs: 20_000, key: "mood" },
  eat: { delta: { energy: 10, mood: 3, bond: 1, focus: 0 }, cooldownMs: 30 * 60_000, dailyLimit: 3, key: "energy" },
  play: { delta: { energy: -3, mood: 6, bond: 2, focus: 0 }, cooldownMs: 60_000, key: "mood" },
  care: { delta: { energy: 1, mood: 3, bond: 1, focus: 0 }, cooldownMs: 30_000, key: "bond" },
  sleep: { delta: { energy: 10, mood: 2, bond: 0.5, focus: 0 }, cooldownMs: 4 * 3_600_000, dailyLimit: 2, key: "energy" },
  todoDone: { delta: { energy: 2, mood: 5, bond: 1, focus: 5 }, cooldownMs: 0, key: "mood" },
  todoStart: { delta: { energy: 0, mood: 1, bond: 0.5, focus: 15 }, cooldownMs: 0, key: "focus" },
  todoStop: { delta: { energy: 0, mood: 0, bond: 0, focus: 0 }, cooldownMs: 0, key: "focus" },
  chat: { delta: { energy: 1, mood: 3, bond: 2, focus: 0 }, cooldownMs: 30_000, key: "bond" },
  bongo: { delta: { energy: 0, mood: 0.5, bond: 0.5, focus: 0 }, cooldownMs: 30_000, key: "mood" },
};

/** 当日增益上限（防止刷数值）。 */
export const VITALS_DAILY_GAIN_CAP = { energy: 60, mood: 60, bond: 30, focus: 120 } as const;

export function clamp(value: number, low = 0, high = VITALS_CEIL): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * 半衰期衰减：`floor + (clamp(v) - floor) * 2^(-elapsed/halfLife)`。
 * elapsed ≤ 0 时返回原值（时钟回拨不惩罚）。
 */
export function applyDecay(value: number, elapsedMs: number, halfLifeMs: number, floor = 0): number {
  const base = clamp(value, floor, VITALS_CEIL);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return base;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return base;
  const decayed = floor + (base - floor) * 2 ** (-elapsedMs / halfLifeMs);
  return clamp(decayed, floor, VITALS_CEIL);
}

export function applyEvent(value: number, delta: number, floor = 0): number {
  return clamp(clamp(value, floor, VITALS_CEIL) + delta, floor, VITALS_CEIL);
}

export function todayKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function createVitals(now: number, options?: { focusActive?: boolean }): PetVitals {
  const focus = options?.focusActive ? VITALS_FOCUS_ON_TODO_START : 0;
  return {
    energy: VITALS_INITIAL.energy,
    mood: VITALS_INITIAL.mood,
    bond: VITALS_INITIAL.bond,
    focus,
    updatedAt: now,
    lastAt: options?.focusActive ? { todoStart: now } : {},
    today: {
      date: todayKey(now),
      gained: { energy: 0, mood: 0, bond: 0, focus },
      count: {},
    },
  };
}

/** 用当前时间把四个指标衰减到 `now`（不改其它字段）。 */
export function decayVitals(state: PetVitals, now: number): PetVitals {
  const elapsed = now - state.updatedAt;
  return {
    ...state,
    energy: applyDecay(state.energy, elapsed, VITALS_HALF_LIFE_MS.energy, VITALS_FLOOR.energy),
    mood: applyDecay(state.mood, elapsed, VITALS_HALF_LIFE_MS.mood, VITALS_FLOOR.mood),
    bond: applyDecay(state.bond, elapsed, VITALS_HALF_LIFE_MS.bond, VITALS_FLOOR.bond),
    focus: applyDecay(state.focus, elapsed, VITALS_HALF_LIFE_MS.focus, VITALS_FLOOR.focus),
    updatedAt: now,
  };
}

function resetDailyIfNeeded(state: PetVitals, now: number): PetVitals {
  const key = todayKey(now);
  if (state.today?.date === key) return state;
  return {
    ...state,
    today: { date: key, gained: { energy: 0, mood: 0, bond: 0, focus: 0 }, count: {} },
  };
}

/**
 * 结算一次（幂等：连续调用与一次调用等价）：
 * - 先衰减到 now（跨天顺便重置当日额度）；
 * - 待办进行中（focusActive）时专注每小时 +12（= 每 5 分钟 +1），封顶 100。
 */
export function tickVitals(
  state: PetVitals,
  now: number,
  context?: { focusActive?: boolean },
): PetVitals {
  // 专注增益要按「上一次结算到现在」的时长算，所以先取 elapsed 再衰减。
  const elapsed = Math.max(0, now - state.updatedAt);
  const decayed = resetDailyIfNeeded(decayVitals(state, now), now);
  if (!context?.focusActive) return decayed;
  // 待办进行中不计衰减（人在专注做事），只按每 5 分钟 +1 累积；结束后再按 45 分钟半衰期回落。
  const gain = (elapsed / (5 * 60_000)) * VITALS_FOCUS_GAIN_PER_5MIN;
  if (!Number.isFinite(gain) || gain <= 0) return decayed;
  return {
    ...decayed,
    focus: clamp(state.focus + gain, VITALS_FLOOR.focus, VITALS_CEIL),
    today: {
      ...decayed.today,
      gained: { ...decayed.today.gained, focus: decayed.today.gained.focus + gain },
    },
  };
}

export type VitalsEventResult = {
  state: PetVitals;
  /** 这次事件是否真的生效（冷却/上限/未知事件时为 false，便于日志与单测）。 */
  applied: boolean;
};

/**
 * 上报一次互动事件：
 * 冷却内 / 当日该类超限 / 未知事件 → 忽略；
 * 生效时按 `delta / (1 + countToday / 6)` 递减，再写入当日累计。
 */
export function applyVitalsEvent(
  state: PetVitals,
  kind: VitalsEventKind,
  now: number,
): VitalsEventResult {
  const config = VITALS_EVENTS[kind];
  if (!config) return { state, applied: false };
  const base = resetDailyIfNeeded(decayVitals(state, now), now);
  const last = base.lastAt[kind];
  if (typeof last === "number" && now - last < config.cooldownMs) {
    return { state: base, applied: false };
  }
  const count = base.today.count[kind] ?? 0;
  if (typeof config.dailyLimit === "number" && count >= config.dailyLimit) {
    return { state: base, applied: false };
  }
  // 重复递减：第 1 次满额、第 7 次减半……
  const repeatFactor = 1 / (1 + count / 6);
  const gained = base.today.gained[config.key] ?? 0;
  const cap = VITALS_DAILY_GAIN_CAP[config.key];
  const room = Math.max(0, cap - gained);
  const delta: VitalsDelta = {
    energy: config.delta.energy * repeatFactor,
    mood: config.delta.mood * repeatFactor,
    bond: config.delta.bond * repeatFactor,
    focus: config.delta.focus * repeatFactor,
  };
  // 当日加成额度只挡正增益，负增益（陪玩耗体力）照常。
  if (delta[config.key] > 0 && room <= 0) {
    return { state: base, applied: false };
  }
  const next: PetVitals = {
    ...base,
    energy: applyEvent(base.energy, delta.energy, VITALS_FLOOR.energy),
    mood: applyEvent(base.mood, delta.mood, VITALS_FLOOR.mood),
    bond: applyEvent(base.bond, delta.bond, VITALS_FLOOR.bond),
    // 开始待办 = 直接进入专注（规格：focus ≥70），其余事件照常加减。
    focus: kind === "todoStart"
      ? Math.max(applyEvent(base.focus, delta.focus, VITALS_FLOOR.focus), VITALS_FOCUS_ON_TODO_START)
      : applyEvent(base.focus, delta.focus, VITALS_FLOOR.focus),
    lastAt: { ...base.lastAt, [kind]: now },
    today: {
      ...base.today,
      gained: {
        ...base.today.gained,
        [config.key]: Math.min(cap, gained + Math.max(0, delta[config.key])),
      },
      count: { ...base.today.count, [kind]: count + 1 },
    },
  };
  return { state: next, applied: true };
}

// ---------------------------------------------------------------------------
// 指标 → 待机轮播权重（只影响 petState === "idle"，不碰任何其它状态）
// ---------------------------------------------------------------------------

export const VITALS_BASE_WEIGHTS: Record<string, number> = {
  idle: 3,
  happy: 1.5,
  relax: 1.2,
  play: 1,
  peek: 0.5,
  pet: 1,
  chin: 0.6,
  love: 1,
  // 下面几个原本靠「倍率作用于未定义值」隐式出现，这里显式给基线，权重表才完整可断言。
  sleeping: 1,
  working: 1,
  attention: 1,
  celebrate: 1,
  spin: 1,
};

/**
 * 四个指标 → 状态权重（相对值）。没有列出的状态用基线 1（或调用方给的缺省）。
 * 原则：数值低只会「更安静/更想睡」，不会自动播 cry/angry 惩罚用户。
 */
export function weightsForVitals(vitals: PetVitals): Record<string, number> {
  const weights: Record<string, number> = { ...VITALS_BASE_WEIGHTS };
  const scale = (state: string, factor: number) => {
    weights[state] = (weights[state] ?? 1) * factor;
  };
  const { energy, mood, bond, focus } = vitals;

  // 体力
  if (energy < 25) {
    scale("sleeping", 5);
    scale("relax", 3);
    scale("chin", 2);
    scale("happy", 0.2);
    scale("play", 0.2);
    scale("celebrate", 0.3);
  } else if (energy < 50) {
    scale("relax", 2);
    scale("idle", 2);
    scale("sleeping", 1);
    scale("play", 0.6);
  } else if (energy > 80) {
    scale("play", 1.6);
    scale("happy", 1.3);
  }

  // 情绪
  if (mood > 75) {
    scale("happy", 3);
    scale("celebrate", 1.5);
    scale("love", 2);
    scale("spin", 1.2);
  } else if (mood < 35) {
    scale("relax", 2);
    scale("chin", 1.5);
    scale("happy", 0.3);
  }

  // 亲密
  if (bond > 80) {
    scale("love", 3);
    scale("pet", 2);
    scale("peek", 1.5);
    scale("happy", 1.2);
  } else if (bond < 35) {
    scale("idle", 2);
    scale("peek", 1);
    scale("pet", 0.6);
    scale("love", 0.2);
  }

  // 专注（第 4 指标）：高专注更「陪你做事」，睡意变少
  if (focus > 60) {
    scale("working", 2);
    scale("attention", 1.4);
    scale("sleeping", 0.4);
  } else if (focus > 30) {
    scale("working", 1.4);
    scale("attention", 1.1);
  }

  // 下限：任何状态都有机会出现（避免长时间只播一张）。
  for (const [state, weight] of Object.entries(weights)) {
    weights[state] = Math.max(0.05, weight);
  }
  return weights;
}

/** 一句话状态（UI 用 i18n 文案；这里只给等级 + 主导指标）。 */
export type VitalsLevel = "great" | "good" | "ok" | "low" | "tired" | "lonely" | "focused";

export function vitalsLevel(vitals: Pick<PetVitals, "energy" | "mood" | "bond" | "focus">): VitalsLevel {
  if (vitals.energy <= 25) return "tired";
  if (vitals.bond <= 35) return "lonely";
  if (vitals.focus >= 60) return "focused";
  if (vitals.mood >= 80 && vitals.bond >= 70) return "great";
  if (vitals.mood < 35) return "low";
  if (vitals.mood >= 55) return "good";
  return "ok";
}

/**
 * 生成待机播放列表（24 张「状态 + 帧」）：
 * - 只从 `states`（用户勾选且可轮播的状态）里抽；
 * - 权重来自 `weights`，帧从 `framesFor(state)` 里随机；
 * - 去掉相邻重复帧；空池返回空数组（调用方回退到现有行为）。
 */
export function buildIdlePlaylist(options: {
  states: string[];
  weights: Record<string, number>;
  framesFor: (state: string) => string[];
  rng?: () => number;
  slots?: number;
}): string[] {
  const rng = options.rng ?? Math.random;
  const slots = Math.max(1, options.slots ?? 24);
  const pool: Array<{ state: string; weight: number; frames: string[] }> = [];
  for (const state of options.states) {
    const frames = options.framesFor(state);
    if (!frames.length) continue;
    pool.push({ state, weight: Math.max(0.05, options.weights[state] ?? 0.5), frames });
  }
  if (pool.length === 0) return [];
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  const out: string[] = [];
  let guard = slots * 8;
  while (out.length < slots && guard > 0) {
    guard -= 1;
    let roll = rng() * total;
    let picked = pool[pool.length - 1];
    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) {
        picked = entry;
        break;
      }
    }
    const frame = picked.frames[Math.floor(rng() * picked.frames.length)];
    if (!frame) continue;
    if (out[out.length - 1] === frame) continue;
    out.push(frame);
  }
  return out;
}

/** 轮播重建的分桶键：数值小幅变化不重建，避免播放列表频繁从头开始。 */
export function vitalsBucketKey(vitals: PetVitals): string {
  return [
    Math.floor(vitals.energy / 20),
    Math.floor(vitals.mood / 20),
    Math.floor(vitals.bond / 25),
    Math.floor(vitals.focus / 20),
  ].join(":");
}

/** 读 localStorage（坏数据/越界 → 回默认值）。 */
export function loadVitals(storage: Storage | null, now: number, options?: { focusActive?: boolean }): PetVitals {
  const fallback = createVitals(now, options);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(VITALS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PetVitals>;
    const energy = Number(parsed.energy);
    const mood = Number(parsed.mood);
    const bond = Number(parsed.bond);
    const focus = Number(parsed.focus);
    const updatedAt = Number(parsed.updatedAt);
    if (![energy, mood, bond, updatedAt].every((value) => Number.isFinite(value))) return fallback;
    return {
      energy: clamp(energy, VITALS_FLOOR.energy),
      mood: clamp(mood, VITALS_FLOOR.mood),
      bond: clamp(bond, VITALS_FLOOR.bond),
      focus: clamp(Number.isFinite(focus) ? focus : 0, VITALS_FLOOR.focus),
      updatedAt,
      lastAt: typeof parsed.lastAt === "object" && parsed.lastAt ? { ...parsed.lastAt } : {},
      today: parsed.today && typeof parsed.today === "object"
        ? {
            date: typeof parsed.today.date === "string" ? parsed.today.date : todayKey(now),
            gained: {
              energy: Number(parsed.today.gained?.energy) || 0,
              mood: Number(parsed.today.gained?.mood) || 0,
              bond: Number(parsed.today.gained?.bond) || 0,
              focus: Number(parsed.today.gained?.focus) || 0,
            },
            count: (parsed.today.count && typeof parsed.today.count === "object" ? parsed.today.count : {}),
          }
        : fallback.today,
    };
  } catch {
    return fallback;
  }
}

export function saveVitals(storage: Storage | null, vitals: PetVitals): void {
  if (!storage) return;
  try {
    storage.setItem(VITALS_STORAGE_KEY, JSON.stringify(vitals));
  } catch {
    // 配额/隐私模式失败不影响桌宠。
  }
  // 其它窗口（聊天 / 气泡 / 固定页）可以订阅，只拿到 4 个数值，不含任何文本内容。
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(VITALS_CHANGED_EVENT, {
        detail: {
          energy: vitals.energy,
          mood: vitals.mood,
          bond: vitals.bond,
          focus: vitals.focus,
        },
      }));
    }
  } catch {
    // 事件派发失败不影响指标。
  }
}

// ---------------------------------------------------------------------------
// 只读接入层：给聊天 / 主动消息 / 状态气泡用（不写任何东西，不读聊天正文）
// ---------------------------------------------------------------------------

/** 指标变化事件（写入后派发，只带 4 个数值）。 */
export const VITALS_CHANGED_EVENT = "maltese-pet-vitals-changed";
/** 最近互动事实日志（只有事件类型 + 时间戳 + 可选待办标题）。 */
export const VITALS_LOG_KEY = "maltese-pet-vitals-log";
export const VITALS_LOG_LIMIT = 30;

export type VitalsLogEntry = {
  kind: VitalsEventKind;
  at: number;
  /** 只有 todoStart/todoDone 会带待办标题（用户自己写的标题，不是聊天内容）。 */
  todoTitle?: string;
};

export type PetVitalsSnapshot = {
  energy: number;
  mood: number;
  bond: number;
  focus: number;
  updatedAt: number;
};

const DEFAULT_SNAPSHOT: PetVitalsSnapshot = {
  energy: VITALS_INITIAL.energy,
  mood: VITALS_INITIAL.mood,
  bond: VITALS_INITIAL.bond,
  focus: 0,
  updatedAt: 0,
};

/** 纯读当前指标（无副作用；没有数据时返回默认值）。 */
export function readPetVitals(storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null): PetVitalsSnapshot {
  if (!storage) return { ...DEFAULT_SNAPSHOT };
  try {
    const raw = storage.getItem(VITALS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SNAPSHOT };
    const parsed = JSON.parse(raw) as Partial<PetVitals>;
    const numbers = [parsed.energy, parsed.mood, parsed.bond].map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) return { ...DEFAULT_SNAPSHOT };
    return {
      energy: clamp(Number(parsed.energy), VITALS_FLOOR.energy),
      mood: clamp(Number(parsed.mood), VITALS_FLOOR.mood),
      bond: clamp(Number(parsed.bond), VITALS_FLOOR.bond),
      focus: clamp(Number.isFinite(Number(parsed.focus)) ? Number(parsed.focus) : 0, VITALS_FLOOR.focus),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { ...DEFAULT_SNAPSHOT };
  }
}

/** 一行中文状态摘要，给模型/气泡用。例：「体力 32（有点累）、情绪 78（心情不错）、亲密 64、专注 20」。 */
export function summarizePetVitals(vitals: PetVitalsSnapshot | PetVitals): string {
  const energy = Math.round(vitals.energy);
  const mood = Math.round(vitals.mood);
  const bond = Math.round(vitals.bond);
  const focus = Math.round(vitals.focus);
  const energyNote = energy < 40 ? "有点累" : energy >= 80 ? "很有精神" : "还行";
  const moodNote = mood < 35 ? "有点低落" : mood > 75 ? "心情不错" : "还算平稳";
  const bondNote = bond > 80 ? "很黏人" : bond < 35 ? "还有点生疏" : "熟悉了";
  const focusNote = focus > 60 ? "正专注" : focus > 30 ? "有点专注" : "比较放松";
  return `体力 ${energy}（${energyNote}）、情绪 ${mood}（${moodNote}）、亲密 ${bond}（${bondNote}）、专注 ${focus}（${focusNote}）`;
}

export function loadVitalsLog(storage: Storage | null): VitalsLogEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(VITALS_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is VitalsLogEntry => Boolean(item)
        && typeof (item as VitalsLogEntry).kind === "string"
        && Number.isFinite((item as VitalsLogEntry).at))
      .slice(0, VITALS_LOG_LIMIT);
  } catch {
    return [];
  }
}

/** 追加一条互动事实（新的在前，最多 30 条；不含任何聊天正文）。 */
export function appendVitalsLog(
  storage: Storage | null,
  entry: VitalsLogEntry,
  limit: number = VITALS_LOG_LIMIT,
): VitalsLogEntry[] {
  const next = [entry, ...loadVitalsLog(storage)].slice(0, Math.max(1, limit));
  if (storage) {
    try {
      storage.setItem(VITALS_LOG_KEY, JSON.stringify(next));
    } catch {
      // 忽略
    }
  }
  return next;
}

const INTERACTION_LABELS: Record<VitalsEventKind, string> = {
  pet: "被摸头",
  eat: "喂过食",
  play: "一起玩了",
  care: "被抱了抱",
  sleep: "睡了一觉",
  todoDone: "陪着完成了待办",
  todoStart: "开始做待办",
  todoStop: "结束了待办",
  chat: "和主人说了几句",
  bongo: "Bongo 敲了一下",
};

function relativeMinutes(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 最近互动事实（最多 `limit` 条，新的在前）：
 * 只会出现「3 分钟前被摸头」这类描述，**不包含任何聊天正文**。
 * 传入 `activeTodoTitle` 时，第一条是「正在做待办：<标题>」（用户自己写的待办标题）。
 */
export function describeRecentInteractions(
  storage: Storage | null,
  limit = 3,
  options?: { now?: number; activeTodoTitle?: string | null },
): string[] {
  const now = options?.now ?? Date.now();
  const lines: string[] = [];
  const activeTitle = options?.activeTodoTitle?.trim();
  if (activeTitle) lines.push(`正在做待办：${activeTitle}`);
  for (const entry of loadVitalsLog(storage)) {
    if (lines.length >= limit) break;
    const label = INTERACTION_LABELS[entry.kind];
    if (!label) continue;
    const detail = entry.kind === "todoStart" || entry.kind === "todoDone"
      ? entry.todoTitle?.trim() ? `${label}：${entry.todoTitle.trim()}` : label
      : label;
    lines.push(`${relativeMinutes(entry.at, now)}${detail}`);
  }
  return lines.slice(0, Math.max(0, limit));
}

/** 动作 → 事件类型（摸头/喂食/陪玩/照顾/睡觉）。没有对应事件的动作返回 null。 */
export function vitalsEventForPetAction(action: string): VitalsEventKind | null {
  switch (action) {
    case "pet":
    case "happy":
      return "pet";
    case "eating":
      return "eat";
    case "play":
    case "ride":
    case "bath":
    case "costume":
    case "spin":
    case "chase":
    case "hide":
    case "celebrate":
      return "play";
    case "chin":
    case "love":
    case "pickup":
      return "care";
    case "sleeping":
      return "sleep";
    default:
      return null;
  }
}