// 把「小狗自我状态 + 近期互动」接进模型上下文（聊天系统提示 / 主动消息提示词）。
//
// 数据来源（防御式）：
// 1) 优先 `window.localStorage["maltese-pet-vitals"]`（dev-shell 的 vitals 落盘格式）；
// 2) 字段缺失/损坏一律返回 null，不抛错、不阻塞聊天；
// 3) 不读取任何聊天正文：互动描述只来自 `lastAt` 的事件时间戳（被摸头/喂食…）。
//
// 纯函数 + 同步读取，node --test 可直接跑（没有 window 时安全返回 null）。

export const PET_VITALS_STORAGE_KEY = "maltese-pet-vitals";
/** 注入聊天的上下文总长度上限（字符），避免拖慢首字。 */
export const CHAT_CONTEXT_MAX_CHARS = 120;
/** 最多描述几条近期互动。 */
export const RECENT_INTERACTION_LIMIT = 3;

export type VitalsSummary = {
  energy: number;
  mood: number;
  bond: number;
  focus?: number;
};

type VitalsEventKind =
  | "pet"
  | "eat"
  | "play"
  | "care"
  | "sleep"
  | "todoDone"
  | "todoStart"
  | "todoStop"
  | "chat"
  | "bongo";

const EVENT_PHRASE: Record<VitalsEventKind, string> = {
  pet: "被摸头",
  eat: "被喂食",
  play: "一起玩过",
  care: "被抱过",
  sleep: "睡了一觉",
  todoDone: "看你完成待办",
  todoStart: "陪你开始待办",
  todoStop: "陪你结束待办",
  chat: "和你聊过天",
  bongo: "敲过鼓",
};

function clamp(value: number, low = 0, high = 100): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读原始 vitals 对象；字段缺失或损坏返回 null（绝不抛错）。 */
export function readVitalsRaw(storage: Storage | null = safeStorage()): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PET_VITALS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 归一化成数值摘要；核心三项缺失就返回 null。 */
export function summarizeVitalsFrom(raw: Record<string, unknown> | null): VitalsSummary | null {
  if (!raw) return null;
  const energy = Number(raw.energy);
  const mood = Number(raw.mood);
  const bond = Number(raw.bond);
  if (!Number.isFinite(energy) || !Number.isFinite(mood) || !Number.isFinite(bond)) return null;
  const focus = Number(raw.focus);
  return {
    energy: clamp(energy),
    mood: clamp(mood),
    bond: clamp(bond),
    focus: Number.isFinite(focus) ? clamp(focus) : undefined,
  };
}

export function loadVitalsSummary(storage: Storage | null = safeStorage()): VitalsSummary | null {
  return summarizeVitalsFrom(readVitalsRaw(storage));
}

/** 分档文案：只用于让模型理解强度，不写死台词。 */
export function vitalsBand(value: number, kind: "energy" | "mood" | "bond" | "focus" = "mood"): string {
  const high = value >= 75;
  const good = value >= 55;
  const low = value < 35;
  if (kind === "energy") {
    if (high) return "精神很好";
    if (good) return "还有精神";
    if (low) return "有点累";
    return "还行";
  }
  if (kind === "mood") {
    if (high) return "心情不错";
    if (good) return "挺平静";
    if (low) return "有点低落";
    return "一般";
  }
  if (kind === "bond") {
    if (high) return "很黏你";
    if (good) return "亲近";
    if (low) return "有点想被注意";
    return "熟悉";
  }
  if (high) return "很专注";
  if (good) return "在专注";
  if (low) return "有点走神";
  return "一般";
}

/** `体力 32（有点累）、情绪 78（心情不错）、亲密 64、专注 20` */
export function formatVitalsLine(vitals: VitalsSummary): string {
  const parts = [
    `体力 ${vitals.energy}（${vitalsBand(vitals.energy, "energy")}）`,
    `情绪 ${vitals.mood}（${vitalsBand(vitals.mood, "mood")}）`,
    `亲密 ${vitals.bond}（${vitalsBand(vitals.bond, "bond")}）`,
  ];
  if (typeof vitals.focus === "number") parts.push(`专注 ${vitals.focus}`);
  return parts.join("、");
}

/** 行为约束（一句）：低体力更安静/撒娇，高情绪更活泼。 */
export function vitalsBehaviorHint(vitals: VitalsSummary): string {
  if (vitals.energy < 35) return "你有点累：回应更短、更安静，可以撒娇但别太闹。";
  if (vitals.mood >= 75) return "你心情很好：语气更活泼，可以多说半句。";
  if (vitals.bond >= 75) return "你现在很黏主人：可以主动贴近一点。";
  return "语气保持平常的亲近感。";
}

/** 从 `lastAt` 时间戳生成「N 分钟前被摸头」这类描述；不含聊天正文。 */
export function describeRecentInteractions(
  raw: Record<string, unknown> | null,
  now: number = Date.now(),
  limit: number = RECENT_INTERACTION_LIMIT,
): string[] {
  if (!raw) return [];
  const lastAt = raw.lastAt;
  if (typeof lastAt !== "object" || lastAt === null) return [];
  const entries: Array<{ kind: VitalsEventKind; at: number }> = [];
  for (const [kind, value] of Object.entries(lastAt as Record<string, unknown>)) {
    if (!(kind in EVENT_PHRASE)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    entries.push({ kind: kind as VitalsEventKind, at: value });
  }
  entries.sort((left, right) => right.at - left.at);
  return entries.slice(0, Math.max(1, limit)).map(({ kind, at }) => {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    const when = minutes <= 0 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
    return `${when}${EVENT_PHRASE[kind]}`;
  });
}

/**
 * 聊天用的系统上下文（≤120 字）：
 *   【小狗现在】体力 32（有点累）……
 *   【最近的互动】3 分钟前被摸头；刚刚被喂食
 *   （行为约束一句）
 * 没有任何状态时返回 null，调用方不注入 → 提示词与旧版一致。
 */
export function buildChatVitalsContext(
  storage: Storage | null = safeStorage(),
  now: number = Date.now(),
): string | null {
  const raw = readVitalsRaw(storage);
  const vitals = summarizeVitalsFrom(raw);
  if (!vitals) return null;
  const header = `【小狗现在】${formatVitalsLine(vitals)}`;
  const interactions = describeRecentInteractions(raw, now);
  const interactionLine = interactions.length > 0 ? `【最近的互动】${interactions.join("；")}` : "";
  const hint = vitalsBehaviorHint(vitals);
  // 先保状态行 + 行为约束（对话质量相关），互动行放得下再加。
  let text = `${header}\n${hint}`;
  if (interactionLine && text.length + 1 + interactionLine.length <= CHAT_CONTEXT_MAX_CHARS) {
    text = `${header}\n${interactionLine}\n${hint}`;
  }
  if (text.length <= CHAT_CONTEXT_MAX_CHARS) return text;
  // 极端情况下裁掉行为约束，只留状态行（再超就截断）。
  return text.length > CHAT_CONTEXT_MAX_CHARS ? header.slice(0, CHAT_CONTEXT_MAX_CHARS) : header;
}

/** 主动消息用：一行状态说明（≤60 字）；没有状态返回 null。 */
export function buildProactiveVitalsLine(
  vitals: VitalsSummary | null,
  interactions: string[] | null = null,
): string | null {
  if (!vitals) return null;
  const base = `它现在的状态：${formatVitalsLine(vitals)}；${vitalsBehaviorHint(vitals)}`;
  const interactionText = interactions && interactions.length > 0 ? `最近互动：${interactions.slice(0, RECENT_INTERACTION_LIMIT).join("；")}` : "";
  const text = interactionText ? `${base}${interactionText}` : base;
  return text.length <= 120 ? text : text.slice(0, 120);
}