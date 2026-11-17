// S5「久坐提醒」的独立活动 streak（纯函数，方便 node --test 直接单测）。
//
// D5：原来 S5 读的是主动聊天的 `proactiveStreakRef`——
//   - 初值 `{ kind: "", since: 0 }`，`since=0` 会让 `now - since` 变成「从 1970 年到现在」，
//     第一个 60s 检查就可能误触发久坐提醒；
//   - 而且它只在主动聊天 tick 里刷新，tick 在静默时段 / 每小时上限 / 主动等级 0 时提前
//     return，于是「关掉主动聊天 → streak 永远是 0 → 必然误触发」。
//
// 现在 S5 用自己的一份活动时间戳：60s 检查里直接取前台活动类型喂给 `noteSedentaryActivity`，
// 与主动聊天开不开、静默时段、每小时上限都无关。

/** 同一类活动连续多久算「久坐」（分钟）。 */
export const SEDENTARY_STANDUP_MINUTES = 40;
/** 两次久坐提醒之间至少隔多久。 */
export const SEDENTARY_STANDUP_COOLDOWN_MS = 45 * 60_000;
/** 系统闲置超过这个值就认为人不在（秒），不提醒久坐。 */
export const SEDENTARY_MAX_IDLE_SECONDS = 120;

export type SedentaryStreak = {
  /** 当前连续的活动类型（前台程序 kind）。 */
  kind: string;
  /** 这段活动是什么时候开始的；`0` 表示还没有采样过。 */
  since: number;
};

export function createSedentaryStreak(): SedentaryStreak {
  return { kind: "", since: 0 };
}

/**
 * 用一次活动采样更新 streak（返回新对象，方便 React/测试）：
 * - 采样为空（拿不到前台活动）时原样返回，不动时间基准；
 * - 活动类型变了 → 从这一刻重新开始计；
 * - 第一次采样 / `since` 非法 → 以当前时间为起点（杜绝「1970 年起就没站起来」的误判）。
 */
export function noteSedentaryActivity(
  streak: SedentaryStreak,
  kind: string,
  now: number,
): SedentaryStreak {
  const nextKind = typeof kind === "string" ? kind.trim() : "";
  if (!nextKind) return streak;
  if (!Number.isFinite(now)) return streak;
  if (!Number.isFinite(streak.since) || streak.since <= 0 || streak.kind !== nextKind) {
    return { kind: nextKind, since: now };
  }
  return streak;
}

/** 这段连续活动已经持续了多少分钟（没有有效起点时为 0，不会误触发）。 */
export function sedentaryStreakMinutes(streak: SedentaryStreak, now: number): number {
  if (!Number.isFinite(streak.since) || streak.since <= 0) return 0;
  if (!Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - streak.since) / 60_000));
}

export type StandupDecisionOptions = {
  streak: SedentaryStreak;
  now: number;
  /** 系统闲置秒数（`get_system_idle_seconds`）。 */
  idleSeconds: number;
  /** 上次久坐提醒的时间戳（0 = 还没提醒过）。 */
  lastStandupAt: number;
  /** 测试可覆盖，默认 40 分钟。 */
  minMinutes?: number;
  /** 测试可覆盖，默认 45 分钟。 */
  cooldownMs?: number;
  /** 测试可覆盖，默认 120s。 */
  maxIdleSeconds?: number;
};

/** S5 判定：连续同一类活动 ≥40 分钟 + 人还在（闲置 <120s）+ 过了 45 分钟冷却。 */
export function shouldFireStandup(options: StandupDecisionOptions): boolean {
  const minMinutes = options.minMinutes ?? SEDENTARY_STANDUP_MINUTES;
  const cooldownMs = options.cooldownMs ?? SEDENTARY_STANDUP_COOLDOWN_MS;
  const maxIdleSeconds = options.maxIdleSeconds ?? SEDENTARY_MAX_IDLE_SECONDS;
  if (sedentaryStreakMinutes(options.streak, options.now) < minMinutes) return false;
  // 人不在电脑前不算久坐（回来那一瞬间由 S7 回归承接）。
  if (!Number.isFinite(options.idleSeconds) || options.idleSeconds >= maxIdleSeconds) return false;
  if (!Number.isFinite(options.lastStandupAt) || options.lastStandupAt < 0) return false;
  return options.now - options.lastStandupAt >= cooldownMs;
}