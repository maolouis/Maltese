// 小狗人设与「求安慰」行为规则（纯逻辑，便于单测）。
//
// 人设：天真烂漫、单纯、心思简单、容易满足、爱撒娇，把开心和难过都写在脸上；
// 说话口语化、短句、偶尔叠词，不用术语不说教；但不装可怜骗互动、不道德绑架。
//
// 求安慰：mood < 40（或 bond 低）且要发主动消息时切到 comfort 角度；
// 每天 ≤2 次、间隔 ≥3 小时、mood 恢复到 ≥60 后 24 小时内不再求安慰；
// 用户正忙（前台工作类应用 + 系统空闲很小）时不求安慰。

export const PERSONA_KEYWORDS = [
  "天真烂漫",
  "单纯",
  "心思简单",
  "容易满足",
  "爱撒娇",
  "把开心和难过都写在脸上",
];

export const COMFORT_LINES = [
  "今天有点没精神…可以陪我说说话吗",
  "我好像有点低落，抱一下好不好",
  "不知道怎么了，就想靠着你待一会儿",
];

export const COMFORT_STORAGE_KEY = "maltese-comfort-state";
export const COMFORT_DAILY_LIMIT = 2;
export const COMFORT_GAP_MS = 3 * 3_600_000;
export const COMFORT_RECOVERED_COOLDOWN_MS = 24 * 3_600_000;
export const MOOD_LOW = 40;
export const BOND_LOW = 40;
export const MOOD_RECOVERED = 60;

export type ComfortState = {
  /** 最近 24h 内求安慰的时间戳（毫秒）。 */
  times: number[];
  /** 最近一次 mood 恢复到 ≥60 的时间（毫秒），用于 24h 冷却。 */
  recoveredAt: number | null;
};

export function emptyComfortState(): ComfortState {
  return { times: [], recoveredAt: null };
}

export function isLowMood(mood: number, bond = 100): boolean {
  return mood < MOOD_LOW || bond < BOND_LOW;
}

/** 工作类前台应用：用户正在专注，不要打断。 */
export function isWorkKind(kind: string): boolean {
  return kind === "code" || kind === "document" || kind === "meeting" || kind === "work";
}

function recentTimes(times: number[], now: number): number[] {
  const cutoff = now - 24 * 3_600_000;
  return times.filter((at) => Number.isFinite(at) && at >= cutoff).sort((a, b) => a - b);
}

export function comfortTimesToday(state: ComfortState, now: number): number[] {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return recentTimes(state.times, now).filter((at) => at >= dayStart.getTime());
}

/** 是否允许此刻发一条求安慰的主动消息。 */
export function canSeekComfort(
  state: ComfortState,
  now: number,
  mood: number,
  options: { bond?: number; kind?: string; idleSeconds?: number } = {},
): { allowed: boolean; reason: string } {
  const bond = options.bond ?? 100;
  if (!isLowMood(mood, bond)) return { allowed: false, reason: "mood_ok" };
  if (state.recoveredAt !== null && now - state.recoveredAt < COMFORT_RECOVERED_COOLDOWN_MS) {
    return { allowed: false, reason: "recovered_cooldown" };
  }
  const times = comfortTimesToday(state, now);
  if (times.length >= COMFORT_DAILY_LIMIT) return { allowed: false, reason: "daily_limit" };
  const recent = recentTimes(state.times, now);
  const last = recent.length > 0 ? recent[recent.length - 1] : undefined;
  if (last !== undefined && now - last < COMFORT_GAP_MS) return { allowed: false, reason: "gap" };
  if (isWorkKind(options.kind ?? "") && (options.idleSeconds ?? 0) < 60) {
    return { allowed: false, reason: "user_busy" };
  }
  return { allowed: true, reason: "ok" };
}

/** 记录一次求安慰（写回 state）。 */
export function recordComfort(state: ComfortState, now: number): ComfortState {
  return { recoveredAt: state.recoveredAt, times: [...recentTimes(state.times, now), now].slice(-10) };
}

/** mood 从低恢复到 ≥60 时标记，开启 24h 冷却。 */
export function trackMoodRecovery(state: ComfortState, mood: number, now: number): ComfortState {
  if (mood >= MOOD_RECOVERED && state.recoveredAt === null) {
    return { ...state, recoveredAt: now };
  }
  return state;
}

export function loadComfortState(storage: Storage | null = safeStorage()): ComfortState {
  if (!storage) return emptyComfortState();
  try {
    const raw = storage.getItem(COMFORT_STORAGE_KEY);
    if (!raw) return emptyComfortState();
    const parsed = JSON.parse(raw) as Partial<ComfortState>;
    return {
      times: Array.isArray(parsed.times) ? parsed.times.filter((at) => Number.isFinite(at)) : [],
      recoveredAt: Number.isFinite(parsed.recoveredAt as number) ? Number(parsed.recoveredAt) : null,
    };
  } catch {
    return emptyComfortState();
  }
}

export function saveComfortState(state: ComfortState, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(COMFORT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略
  }
}

/** 人设补充语（proactive / 聊天 system 共用一句话）。 */
export function personaSuffix(): string {
  return "人设：天真烂漫、单纯、心思简单、容易满足、爱撒娇，把开心和难过都写在脸上；说话口语化、短句、偶尔叠词，不用术语不说教。状态低落时可以轻轻表达想被安慰，但不装可怜骗互动、不道德绑架。";
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}