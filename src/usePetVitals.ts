// 桌宠自我状态的 React 层：持久化 + 60s 结算 + 事件上报。
// 纯逻辑都在 petVitals.ts（有单测），这里只做「何时结算 / 何时上报」。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendVitalsLog,
  applyVitalsEvent,
  createVitals,
  loadVitals,
  saveVitals,
  tickVitals,
  VITALS_TICK_MS,
  type PetVitals,
  type VitalsEventKind,
} from "./petVitals";

/** 聊天消息存储键：只读 `role`/`at`，**不读 text**。 */
const PET_CHAT_STORAGE_KEY = "focusd-island-pet-chat-messages";

export type PetVitalsController = {
  vitals: PetVitals;
  /** 上报一次互动（冷却/日上限由纯函数把关）。 */
  reportEvent: (kind: VitalsEventKind, options?: { todoTitle?: string }) => void;
  /** 立刻结算一次（打开设置卡片时用）。 */
  refresh: () => void;
};

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 聊天里新出现的「用户发送」时间戳（不读正文）。 */
function unreadUserChatTimes(storage: Storage | null, since: number): number[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PET_CHAT_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Array<{ role?: string; at?: number }>;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item?.role === "user" && Number.isFinite(item.at))
      .map((item) => Number(item.at))
      .filter((at) => at > since)
      .sort((a, b) => a - b)
      .slice(-5);
  } catch {
    return [];
  }
}

export function usePetVitals(options: {
  /** 总开关：关闭后不写指标、也不参与待机权重。 */
  enabled: boolean;
  /** 是否正在待办中（决定 focus 涨不涨）。 */
  focusActive: boolean;
}): PetVitalsController {
  const { enabled, focusActive } = options;
  const [vitals, setVitals] = useState<PetVitals>(() => {
    const storage = safeStorage();
    return loadVitals(storage, Date.now(), { focusActive });
  });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const focusRef = useRef(focusActive);
  focusRef.current = focusActive;
  /** 已结算到哪条聊天消息。 */
  const lastChatAtRef = useRef(0);

  const settle = useCallback((now: number) => {
    setVitals((previous) => tickVitals(previous, now, { focusActive: focusRef.current }));
  }, []);

  // 60s 结算 + 切回前台时补一次（合盖/休眠后避免一次算太多）。
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => settle(Date.now()), VITALS_TICK_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") settle(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, settle]);

  // 聊天上报：只数「新的用户发送」，不带任何正文。
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      const times = unreadUserChatTimes(safeStorage(), lastChatAtRef.current);
      if (times.length === 0) return;
      lastChatAtRef.current = times[times.length - 1];
      setVitals((previous) => {
        let next = previous;
        for (const at of times) {
          next = applyVitalsEvent(next, "chat", at).state;
        }
        return next;
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  // 进入/退出专注：开始待办 → focus +15 并开始随时间上涨；结束/完成 → 停止上涨。
  const wasFocusRef = useRef(focusActive);
  useEffect(() => {
    if (wasFocusRef.current === focusActive) return;
    wasFocusRef.current = focusActive;
    if (!enabled) return;
    setVitals((previous) => applyVitalsEvent(previous, focusActive ? "todoStart" : "todoStop", Date.now()).state);
  }, [enabled, focusActive]);

  // 持久化：状态变化就落盘（事件频率远低于每秒一次，不需要额外节流）。
  useEffect(() => {
    if (!enabled) return;
    saveVitals(safeStorage(), vitals);
  }, [enabled, vitals]);

  const reportEvent = useCallback((kind: VitalsEventKind, options?: { todoTitle?: string }) => {
    if (!enabledRef.current) return;
    const now = Date.now();
    setVitals((previous) => applyVitalsEvent(previous, kind, now).state);
    // 记录一条「互动事实」（只有类型/时间/待办标题，不含任何聊天正文），供模型上下文读取。
    appendVitalsLog(safeStorage(), { kind, at: now, todoTitle: options?.todoTitle });
  }, []);

  const refresh = useCallback(() => {
    settle(Date.now());
  }, [settle]);

  return { vitals, reportEvent, refresh };
}

/** 开关关闭时给调用方一个「不影响轮播」的占位状态。 */
export function disabledVitals(now = Date.now()): PetVitals {
  return createVitals(now, { focusActive: false });
}