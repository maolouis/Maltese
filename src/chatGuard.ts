// 聊天请求的「永不卡死」护栏：token 预算联动、分级超时、取消状态、对话占用标志。
//
// 全部是纯函数/常量，node --test 直接可测；PetChat.tsx 只负责把它们接到计时器与 UI 上。
// 背景：docs/chat-vs-proactive-diagnosis-2026-11-17.md —— 思考预算会把 max_tokens
// 吃光、流式空正文没有兜底、前端没有取消和分级超时，用户看到的是「一直卡住」。

import { thinkingBudget, type ThinkingDepth } from "./localChat.ts";

/**
 * 超时策略（2026-11-17 实测修正）：
 * - 本机 Strata 首次 prefill 实测可到 16–55s，**首字 8s 会误杀正常请求**；
 * - 改为「空闲超时」：只要还有事件（reasoning/delta/progress）就不算卡死；
 * - 首字（无任何事件）15s；思考档 25s；总上限 120s；一旦开始输出，只看空窗与总时长。
 */
export const CHAT_FIRST_TOKEN_TIMEOUT_MS: Record<ThinkingDepth, number> = {
  off: 15_000,
  shallow: 15_000,
  normal: 25_000,
  deep: 25_000,
};

/** 总时长上限：120s（本机实测流式 36s、非流式 55s 都可能出现，不能掐断）。 */
export const CHAT_TOTAL_TIMEOUT_MS: Record<ThinkingDepth, number> = {
  off: 120_000,
  shallow: 120_000,
  normal: 120_000,
  deep: 120_000,
};

/** 已经开始输出后，允许的最长「完全没有新事件」的空窗。 */
export const CHAT_IDLE_TIMEOUT_MS = 20_000;

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
export function chatTimeouts(depth: ThinkingDepth): { firstTokenMs: number; totalMs: number; idleMs: number } {
  return {
    firstTokenMs: CHAT_FIRST_TOKEN_TIMEOUT_MS[depth],
    totalMs: CHAT_TOTAL_TIMEOUT_MS[depth],
    idleMs: CHAT_IDLE_TIMEOUT_MS,
  };
}

export type StreamAbortInput = {
  /** 请求开始时间（毫秒时间戳）。 */
  startedAt: number;
  /** 最近一次收到任何事件的时间；从未收到为 null。 */
  lastActivityAt: number | null;
  now: number;
  depth: ThinkingDepth;
};

/**
 * 流式请求是否该中止（纯函数，便于单测）：
 * - 还没有任何事件：超过首字时限 → 中止；
 * - 已经开始输出：只看「空窗」是否超过 idleMs，以及总时长；
 * - 任何情况下总时长超过上限 → 中止。
 * 关键点：**已经吐出过文字的请求不会因为「首字慢」被误杀**。
 */
export function shouldAbortStream(input: StreamAbortInput): { abort: boolean; reason: string } {
  const profile = chatTimeouts(input.depth);
  const elapsed = input.now - input.startedAt;
  if (elapsed >= profile.totalMs) {
    return { abort: true, reason: `模型这轮超过 ${Math.round(profile.totalMs / 1000)} 秒还没结束，已停止。可调浅思考或稍后重试。` };
  }
  if (input.lastActivityAt === null) {
    if (elapsed >= profile.firstTokenMs) {
      return { abort: true, reason: `模型 ${Math.round(profile.firstTokenMs / 1000)} 秒内没有任何输出，已停止。可能还在加载，稍后重试。` };
    }
    return { abort: false, reason: "" };
  }
  if (input.now - input.lastActivityAt >= profile.idleMs) {
    return { abort: true, reason: `模型中途 ${Math.round(profile.idleMs / 1000)} 秒没有新内容，已停止。` };
  }
  return { abort: false, reason: "" };
}

export type ChatErrorInfo = { code: string; message: string; raw: string };

const ERROR_MAP: Array<{ test: RegExp; code: string; message: string }> = [
  { test: /连接不到|ECONNREFUSED|Connection refused|os error 10061/i, code: "CHAT_BACKEND_DOWN", message: "连不上本地模型服务：请确认模型已启动（聊天设置里有「启动模型」）。" },
  { test: /超时|timeout|timed out|太慢|没有任何输出|空窗/i, code: "CHAT_TIMEOUT", message: "模型响应超时，已停止。首次加载会比较慢，稍后重试或调浅思考。" },
  { test: /400|template|chat template|Bad Request/i, code: "CHAT_BAD_REQUEST", message: "模型拒绝了这次请求（可能是对话模板不兼容），已尝试去掉状态上下文重试。" },
  { test: /401|403|api.?key|鉴权|unauthorized/i, code: "CHAT_AUTH", message: "模型接口鉴权失败，请检查聊天设置里的 API Key。" },
  { test: /没有返回|空|empty/i, code: "CHAT_EMPTY", message: "模型没有返回正文，已自动重试；仍无内容请调浅思考再试。" },
];

/** 把任意错误映射成中文可读原因 + 错误码（原始内容进 console）。 */
export function describeChatError(error: unknown): ChatErrorInfo {
  // Error 对象直接 JSON.stringify 会得到 "{}"：必须取 message，否则错误详情丢失。
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string"
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
  for (const item of ERROR_MAP) {
    if (item.test.test(raw)) return { code: item.code, message: item.message, raw };
  }
  return { code: "CHAT_UNKNOWN", message: "模型这次没能回答（已记录原因），可以点「重试」再试一次。", raw };
}

/** 是否是「模板/请求被拒」类错误：用于自动降级为不注入状态上下文。 */
export function isTemplateRejection(error: unknown): boolean {
  // Error 对象直接 JSON.stringify 会得到 "{}"：必须取 message，否则错误详情丢失。
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string"
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
  return /400|bad request|template|消息格式|messages/i.test(raw);
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