// 记忆维护：真正调用模型生成「当日摘要 + 事实抽取」，只在聊天 idle ≥30s 且没有在跑任务时执行。
//
// 不抢聊天单槽位：调用方传入 busy/lastUserAt 探针，定时器到点再复核；任何失败都静默降级
// （记忆不更新，聊天仍按最近 8–10 轮滑动窗口工作）。

import {
  buildMemoryContext,
  canRunMaintenance,
  loadMemory,
  mergeFacts,
  pruneSummaries,
  saveMemory,
  type MemoryFact,
  type PetMemory,
} from "./petMemory.ts";

export type MaintenanceMessage = { role: string; text: string };

export type MaintenanceResult = {
  summary: string;
  facts: Array<{ key: string; value: string; confidence: number }>;
};

/** 摘要 ≤200 字、事实 ≤3 条、严格 JSON。 */
export function buildMaintenancePrompt(messages: MaintenanceMessage[]): string {
  const lines = messages
    .slice(-16)
    .map((message) => `${message.role === "user" ? "主人" : "小狗"}：${message.text.slice(0, 200)}`)
    .join("\n");
  return [
    "你在帮桌宠整理短期记忆，只输出 JSON，不要任何解释。",
    '格式：{"summary":"今天聊了什么（≤200字）","facts":[{"key":"称呼/喜好/在做的事","value":"值","confidence":0.9}]}',
    "要求：summary 只写事实，不编造；facts 最多 3 条、key 简短；没有可提取的事实时 facts 为空数组。",
    "对话：",
    lines,
  ].join("\n");
}

/** 容错解析模型输出：允许 ```json 围栏、前后解释文字。 */
export function parseMaintenanceReply(raw: string): MaintenanceResult | null {
  if (!raw) return null;
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim().slice(0, 200) : "";
  const rawFacts = Array.isArray(record.facts) ? record.facts : [];
  const facts: MaintenanceResult["facts"] = [];
  for (const item of rawFacts.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const fact = item as Record<string, unknown>;
    const key = typeof fact.key === "string" ? fact.key.trim().slice(0, 20) : "";
    const value = typeof fact.value === "string" ? fact.value.trim().slice(0, 60) : "";
    if (!key || !value) continue;
    const confidence = Number(fact.confidence);
    facts.push({ key, value, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6 });
  }
  if (!summary && facts.length === 0) return null;
  return { summary, facts };
}

/** 应用维护结果：当日摘要（≤200 字，保留 3 天）+ 事实合并（上限 20）。 */
export function applyMaintenance(memory: PetMemory, result: MaintenanceResult, now = Date.now()): PetMemory {
  const date = new Date(now).toISOString().slice(0, 10);
  const summaries = memory.summaries.filter((item) => item.date !== date);
  if (result.summary) {
    summaries.push({ date, text: result.summary.slice(0, 200) });
  }
  const incoming: MemoryFact[] = result.facts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence,
    updatedAt: now,
  }));
  return {
    facts: mergeFacts(memory.facts, incoming),
    summaries: pruneSummaries(summaries, now),
    updatedAt: now,
  };
}

/** 定时器句柄：同一时间只允许一个维护任务。 */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

export type MaintenanceOptions = {
  messages: MaintenanceMessage[];
  /** 聊天是否正在生成/有请求在跑。 */
  isBusy: () => boolean;
  /** 最近一次用户消息时间戳。 */
  lastUserAt: () => number;
  /** 调用模型（返回原始文本）。 */
  callModel: (prompt: string) => Promise<string>;
  /** 维护完成后回调（用于 UI 刷新条数）。 */
  onUpdated?: (memory: PetMemory) => void;
  idleMs?: number;
  now?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
};

/**
 * 调度一次记忆维护：默认延迟 30s，到点复核「idle 且无新消息」才真正调用模型。
 * 失败/超时静默放弃（不写记忆），聊天照常。
 */
export function scheduleMemoryMaintenance(options: MaintenanceOptions): void {
  const nowFn = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const idleMs = options.idleMs ?? 30_000;
  if (pendingTimer !== null) {
    clearTimeoutFn(pendingTimer);
    pendingTimer = null;
  }
  const snapshot = options.messages.slice(-16);
  if (snapshot.length < 8) return;
  const startedAt = nowFn();
  pendingTimer = setTimeoutFn(() => {
    pendingTimer = null;
    if (running) return;
    if (!canRunMaintenance(nowFn(), options.lastUserAt(), options.isBusy())) return;
    if (nowFn() - startedAt < idleMs) return;
    running = true;
    const prompt = buildMaintenancePrompt(snapshot);
    void Promise.resolve()
      .then(() => options.callModel(prompt))
      .then((raw) => {
        const result = parseMaintenanceReply(raw);
        if (!result) return;
        const next = applyMaintenance(loadMemory(), result, nowFn());
        saveMemory(next);
        options.onUpdated?.(next);
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, idleMs);
}

/** 测试用：清空模块级状态。 */
export function resetMaintenanceState(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  running = false;
}

/** 供 UI 预览当前注入文本（调试用）。 */
export function currentMemoryContext(depth: "off" | "normal" | "deep" = "normal"): string | null {
  return buildMemoryContext(loadMemory(), depth);
}