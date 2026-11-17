// 聊天请求的「永不卡死」护栏：token 预算联动、分级超时、取消状态、对话占用标志。
//
// 全部是纯函数/常量，node --test 直接可测；PetChat.tsx 只负责把它们接到计时器与 UI 上。
// 背景：docs/chat-vs-proactive-diagnosis-2026-11-17.md —— 思考预算会把 max_tokens
// 吃光、流式空正文没有兜底、前端没有取消和分级超时，用户看到的是「一直卡住」。

import { thinkingBudget, type ThinkingDepth } from "./localChat";

/** 思考档位对应的「首字最迟多久」：浅/标准/深 分别 8s / 20s / 20s（深档首字同样放宽）。 */
export const CHAT_FIRST_TOKEN_TIMEOUT_MS: Record<ThinkingDepth, number> = {
  off: 8_000,
  shallow: 8_000,
  normal: 20_000,
  deep: 20_000,
};

/** 总时长上限：浅/标准 60s，深 90s。 */
export const CHAT_TOTAL_TIMEOUT_MS: Record<ThinkingDepth, number> = {
  off: 60_000,
  shallow: 60_000,
  normal: 60_000,
  deep: 90_000,
};

/** 正文预算的下限（没有思考时也至少给这么多 token）。 */
export const CHAT_MIN_REPLY_TOKENS = 512;
/** 思考结束后至少留给正文的 token。 */
export const CHAT_REPLY_HEADROOM_TOKENS = 256;

/**
 * 请求真正下发的 max_tokens：`reasoningBudget + 256`（至少 512），
 * 同时不低于用户设置的上限，避免「思考把预算吃光、正文为空」。
 */
export function chatMaxTokens(configMaxTokens: number, depth: ThinkingDepth): number {
  const configured = Number.isFinite(configMaxTokens) ? Math.max(32, Math.round(configMaxTokens)) : 256;
  const budget = depth === "off" ? 0 : thinkingBudget(depth);
  const withHeadroom = budget + CHAT_REPLY_HEADROOM_TOKENS;
  const floor = depth === "off" ? configured : Math.max(CHAT_MIN_REPLY_TOKENS, withHeadroom);
  return Math.max(configured, floor, 32);
}

/** 该档位是否需要「首字超时」保护（关思考也一样要有，只是更短）。 */
export function chatTimeouts(depth: ThinkingDepth): { firstTokenMs: number; totalMs: number } {
  return {
    firstTokenMs: CHAT_FIRST_TOKEN_TIMEOUT_MS[depth],
    totalMs: CHAT_TOTAL_TIMEOUT_MS[depth],
  };
}

/** 对话占用标志：发消息时写入时间戳，主动聊天看到 60s 内有人聊天就跳过。 */
export const CHAT_BUSY_KEY = "maltese-chat-in-progress";
export const CHAT_BUSY_GRACE_MS = 60_000;

export function markChatBusy(storage: Storage | null, now: number = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(CHAT_BUSY_KEY, String(now));
  } catch {
    // 隐私模式写不进去也不影响聊天。
  }
}

export function clearChatBusy(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CHAT_BUSY_KEY);
  } catch {
    // 忽略。
  }
}

/** 主动聊天是否该让路：有人正在聊天 / 刚结束 60s 内 → 跳过。 */
export function shouldSkipProactiveForChat(
  storage: Pick<Storage, "getItem"> | null,
  now: number = Date.now(),
  graceMs: number = CHAT_BUSY_GRACE_MS,
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(CHAT_BUSY_KEY);
    if (!raw) return false;
    const startedAt = Number(raw);
    if (!Number.isFinite(startedAt)) return false;
    return now - startedAt < graceMs;
  } catch {
    return false;
  }
}

/** 失败/取消时不把思考内容当答案留在界面上。 */
export function shouldKeepReasoning(reasoningCount: number, failed: boolean): boolean {
  return !failed && reasoningCount > 0;
}

/** 只有非空正文才写入消息；取消或空正文一律不追加（避免空气泡）。 */
export function shouldPersistReply(text: string | null | undefined, cancelled: boolean): boolean {
  if (cancelled) return false;
  return Boolean(text && text.trim());
}