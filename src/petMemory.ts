// 桌宠三层记忆（短期对话 / 中期当日摘要 / 长期事实卡）。
//
// 纯逻辑 + localStorage，node --test 可直接测；注入走 Rust（local_chat / dsh_chat 的
// memory_context 参数），因为前端 history 里的 system 会被 build_messages 丢掉。
//
// 隐私：只存摘要与事实（key-value），不存原始长文本；一键清空见 clearMemory()。

export const MEMORY_STORAGE_KEY = "maltese-pet-memory";
export const MEMORY_DEPTH_KEY = "maltese-pet-memory-depth";
/** 记忆更新事件（同窗口内 save/clear 后通知 UI 刷新）。 */
export const MEMORY_UPDATED_EVENT = "maltese-pet-memory-updated";

export type MemoryDepth = "off" | "normal" | "deep";

export type MemoryFact = {
  key: string;
  value: string;
  confidence: number;
  updatedAt: number;
};

export type DaySummary = {
  date: string; // YYYY-MM-DD
  text: string;
};

export type PetMemory = {
  facts: MemoryFact[];
  summaries: DaySummary[];
  updatedAt: number;
};

/** 最近对话轮次（一问一答算两轮，这里按消息条数近似）。 */
export const RECENT_TURNS = 10;
export const COMPACT_TOKEN_THRESHOLD = 6000;
export const COMPACT_TURN_THRESHOLD = 12;
export const SUMMARY_DAILY_MAX_CHARS = 200;
export const SUMMARY_KEEP_DAYS = 3;
export const FACTS_MAX = 20;
export const FACTS_TOP = 5;
export const FACT_CHARS_BUDGET = 80; // ≈40 token
export const SUMMARY_CHARS_BUDGET = 60; // ≈30 token
export const BUDGET_NORMAL_TOKENS = 70;
export const BUDGET_DEEP_TOKENS = 300;
/** 维护任务只在聊天空闲这么久之后跑，避免抢单槽位。 */
export const MEMORY_IDLE_MS = 30_000;

/** token 估算：中文按 1.6 字/token，英文按 4 字符/token 折中。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.6 + other / 4);
}

export function memoryBudget(depth: MemoryDepth): number {
  if (depth === "off") return 0;
  if (depth === "deep") return BUDGET_DEEP_TOKENS;
  return BUDGET_NORMAL_TOKENS;
}

export function emptyMemory(now = Date.now()): PetMemory {
  return { facts: [], summaries: [], updatedAt: now };
}

export function loadMemory(storage: Storage | null = safeStorage()): PetMemory {
  const fallback = emptyMemory();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PetMemory>;
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter((fact): fact is MemoryFact => Boolean(fact) && typeof fact.key === "string" && typeof fact.value === "string")
          .map((fact) => ({
            key: fact.key,
            value: fact.value,
            confidence: Number.isFinite(fact.confidence) ? Number(fact.confidence) : 0.5,
            updatedAt: Number.isFinite(fact.updatedAt) ? Number(fact.updatedAt) : 0,
          }))
      : [];
    const summaries = Array.isArray(parsed.summaries)
      ? parsed.summaries.filter((item): item is DaySummary => Boolean(item) && typeof item.date === "string" && typeof item.text === "string")
      : [];
    return { facts, summaries, updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0 };
  } catch {
    return fallback;
  }
}

export function saveMemory(memory: PetMemory, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memory));
    notifyMemoryUpdated(storage);
  } catch {
    // 忽略
  }
}

export function clearMemory(storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(MEMORY_STORAGE_KEY);
    notifyMemoryUpdated(storage);
  } catch {
    // 忽略
  }
}

function notifyMemoryUpdated(storage: Storage | null): void {
  try {
    if (typeof window === "undefined") return;
    if (storage && storage === window.localStorage) {
      window.dispatchEvent(new Event(MEMORY_UPDATED_EVENT));
    }
  } catch {
    // 忽略
  }
}

export function loadMemoryDepth(storage: Storage | null = safeStorage()): MemoryDepth {
  if (!storage) return "normal";
  try {
    const value = storage.getItem(MEMORY_DEPTH_KEY);
    return value === "off" || value === "deep" || value === "normal" ? value : "normal";
  } catch {
    return "normal";
  }
}

export function saveMemoryDepth(depth: MemoryDepth, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(MEMORY_DEPTH_KEY, depth);
  } catch {
    // 忽略
  }
}

/** 是否需要 compact：token 超阈值或轮次超阈值（两者任一）。 */
export function shouldCompact(messageCount: number, tokens: number): boolean {
  return messageCount > COMPACT_TURN_THRESHOLD || tokens > COMPACT_TOKEN_THRESHOLD;
}

/** compact 时保留最近 8 条、更早的交给摘要。 */
export function compactPlan(messageCount: number): { keep: number; toSummary: number } {
  if (messageCount <= RECENT_TURNS) return { keep: messageCount, toSummary: 0 };
  const keep = 8;
  return { keep, toSummary: Math.max(0, messageCount - keep) };
}

/** 事实合并：按 key 去重（新值覆盖、confidence 取高）、总量 ≤20、按更新时间排序。 */
export function mergeFacts(existing: MemoryFact[], incoming: MemoryFact[]): MemoryFact[] {
  const map = new Map<string, MemoryFact>();
  for (const fact of [...existing, ...incoming]) {
    const key = (fact.key ?? "").trim();
    if (!key) continue;
    const value = (fact.value ?? "").trim().slice(0, 60);
    if (!value) continue;
    const previous = map.get(key);
    if (!previous) {
      map.set(key, { key, value, confidence: clamp01(fact.confidence), updatedAt: fact.updatedAt || 0 });
      continue;
    }
    const fresher = fact.updatedAt >= previous.updatedAt;
    map.set(key, {
      key,
      value: fresher ? value : previous.value,
      confidence: Math.max(previous.confidence, clamp01(fact.confidence)),
      updatedAt: Math.max(previous.updatedAt, fact.updatedAt || 0),
    });
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, FACTS_MAX);
}

/** 只保留最近 N 天的摘要（每天最多 200 字）。 */
export function pruneSummaries(summaries: DaySummary[], now = Date.now()): DaySummary[] {
  const cutoff = now - SUMMARY_KEEP_DAYS * 24 * 3_600_000;
  return summaries
    .filter((item) => {
      const at = Date.parse(`${item.date}T00:00:00`);
      return Number.isFinite(at) ? at >= cutoff : false;
    })
    .map((item) => ({ date: item.date, text: item.text.slice(0, SUMMARY_DAILY_MAX_CHARS) }))
    .slice(-SUMMARY_KEEP_DAYS);
}

/**
 * 记忆注入文本（走 Rust system/prompt）：
 * 事实 top5（≤80 字）→ 最近一天摘要（≤60 字）；总预算按 depth（normal 70 token / deep 300）。
 * off 或没有记忆时返回 null（不注入）。
 */
export function buildMemoryContext(
  memory: PetMemory,
  depth: MemoryDepth = "normal",
  now = Date.now(),
): string | null {
  if (depth === "off") return null;
  const budgetChars = Math.floor(memoryBudget(depth) * 1.6);
  const facts = [...memory.facts]
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    .slice(0, FACTS_TOP)
    .map((fact) => `${fact.key}=${fact.value}`)
    .join("；")
    .slice(0, FACT_CHARS_BUDGET);
  const summaries = pruneSummaries(memory.summaries, now);
  const summary = (summaries.length > 0 ? summaries[summaries.length - 1].text : "").slice(0, SUMMARY_CHARS_BUDGET);
  const parts: string[] = [];
  if (facts) parts.push(`事实：${facts}`);
  if (summary) parts.push(`最近：${summary}`);
  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, budgetChars);
}

/** 维护任务是否可以跑：聊天 idle ≥30s 且没有在跑的维护。 */
export function canRunMaintenance(now: number, lastUserAt: number, running: boolean): boolean {
  if (running) return false;
  return now - lastUserAt >= MEMORY_IDLE_MS;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}