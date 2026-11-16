// 投递策略的纯逻辑：时间、空闲、全屏等外部状态全部由参数注入。

import type { DigestDraft } from "./plugins/video/types";

export type DeliveryPlan = {
  quietHours: [number, number] | null;
};

export type DeliveryInput = {
  proactiveLevel: number;
  plan: DeliveryPlan;
  idleSeconds: number;
  isFullscreen: boolean;
  foregroundKind: string;
  deliveredToday: number;
  dailyLimit: number;
  now: number;
};

export type DeliveryDecision = {
  allowed: boolean;
  reason: string;
};

export const MIN_IDLE_SECONDS = 120;

function inQuietHours(plan: DeliveryPlan, now: number): boolean {
  if (!plan.quietHours) return false;
  const [start, end] = plan.quietHours;
  const hour = new Date(now).getHours();
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function canDeliverNow(input: DeliveryInput): DeliveryDecision {
  if (input.proactiveLevel <= 0) {
    return { allowed: false, reason: "主动程度为 0" };
  }
  if (inQuietHours(input.plan, input.now)) {
    return { allowed: false, reason: "免打扰时段" };
  }
  if (input.idleSeconds < MIN_IDLE_SECONDS) {
    return { allowed: false, reason: "你正在用电脑" };
  }
  if (input.isFullscreen) {
    return { allowed: false, reason: "全屏中" };
  }
  if (input.foregroundKind === "meeting" || input.foregroundKind === "game") {
    return { allowed: false, reason: "会议或游戏中" };
  }
  if (input.deliveredToday >= input.dailyLimit) {
    return { allowed: false, reason: "今天投递次数已达上限" };
  }
  return { allowed: true, reason: "可以投递" };
}

const SENTENCE_END = /[。！？；.!?…]/;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = "";
  for (const character of value) {
    if (result.length >= limit) break;
    result += character;
    if (SENTENCE_END.test(character)) break;
  }
  return result;
}

function cleanLine(value: string, limit: number): string {
  const stripped = value.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  return truncate(stripped, limit);
}

export function formatDigestMessage(draft: DigestDraft): string {
  const lines: string[] = [];
  const theme = cleanLine(draft.themeLine ?? "", 60);
  if (theme) lines.push(theme);
  for (const item of draft.items.slice(0, 5)) {
    const title = cleanLine(item.title, 80);
    const why = cleanLine(item.whyLine, 40);
    if (!title) continue;
    lines.push(`· 《${title}》：${why}`);
  }
  return truncate(lines.join("\n"), 300);
}

export function buildToolNote(count: number): string {
  return `小狗刷视频看到 ${count} 条`;
}