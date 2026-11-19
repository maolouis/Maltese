// 桌宠自我状态的 React 层：持久化 + 60s 结算 + 事件上报 + 离线体力恢复 + 刷视频涨情绪。
// 纯逻辑都在 petVitals.ts（有单测），这里只做「何时结算 / 何时上报」。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  appendVitalsLog,
  applyVitalsEvent,
  createVitals,
  loadVideoSeen,
  loadVitals,
  newVideoUrls,
  saveVideoSeen,
  saveVitals,
  settleOfflineRecovery,
  tickVitals,
  videoWatchDecision,
  VITALS_LAST_SEEN_KEY,
  VITALS_TICK_MS,
  type PetSleepMode,
  type PetVitals,
  type VitalsEventKind,
} from "./petVitals";

/** 聊天消息存储键：只读 `role`/`at`，**不读 text**。 */
const PET_CHAT_STORAGE_KEY = "focusd-island-pet-chat-messages";
/** 刷视频同步间隔：snapshot 是 2s 轮询的，这里 20s 拉一次 session items 足够。 */
const VIDEO_SYNC_MS = 20_000;

export type PetVitalsController = {
  vitals: PetVitals;
  /** 上报一次互动（冷却/日上限由纯函数把关）。 */
  reportEvent: (kind: VitalsEventKind, options?: { todoTitle?: string }) => void;
  /** 立刻结算一次（打开设置卡片时用）。 */
  refresh: () => void;
  /** 设置睡眠档位（manual = 用户点的睡觉；idle = 待机自动打盹；null = 醒着）。 */
  setSleepMode: (mode: PetSleepMode | null) => void;
  /** 睡觉时外部轮询（前台应用/媒体/空闲）应当停下；醒着才读。 */
  activityPollingPaused: boolean;
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

function readLastSeen(storage: Storage | null): number {
  if (!storage) return 0;
  try {
    const value = Number(storage.getItem(VITALS_LAST_SEEN_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(storage: Storage | null, at: number): void {
  if (!storage) return;
  try {
    storage.setItem(VITALS_LAST_SEEN_KEY, String(at));
  } catch {
    // 忽略配额失败。
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
    const now = Date.now();
    const loaded = loadVitals(storage, now, { focusActive });
    const lastSeen = readLastSeen(storage);
    // 离线恢复：应用没运行/用户离开期间体力按时间回升（睡觉两档速率不同）。
    if (!enabled || lastSeen <= 0) return loaded;
    const { state } = settleOfflineRecovery(loaded, lastSeen, now, loaded.sleepMode ?? null);
    return state;
  });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const focusRef = useRef(focusActive);
  focusRef.current = focusActive;
  /** 已结算到哪条聊天消息。 */
  const lastChatAtRef = useRef(0);
  /** 上次处理过的视频采集条数：只在 itemCount 增长时拉 session（减少 IPC，降低卡顿风险）。 */
  const lastVideoItemCountRef = useRef(0);

  const settle = useCallback((now: number) => {
    setVitals((previous) => tickVitals(previous, now, { focusActive: focusRef.current }));
  }, []);

  // 挂载时立即结算一次并落盘：避免「刚打开聊天时还没有第一次写入」导致状态栏没数据。
  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    setVitals((previous) => tickVitals(previous, now, { focusActive: focusRef.current }));
  }, [enabled]);

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

  // 刷视频：读视频插件的 snapshot/session（只读，不改视频模块），
  // 按 canonicalUrl 去重，每天最多 6 条 → mood +2/条、bond +0.5/条。
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let cancelled = false;
    const sync = async () => {
      if (cancelled) return;
      try {
        const snapshot = await invoke<{
          running?: boolean;
          itemCount?: number;
          sessionId?: string;
        }>("video_get_snapshot");
        if (!snapshot?.running || !snapshot.sessionId || !(Number(snapshot.itemCount) > 0)) {
          lastVideoItemCountRef.current = 0;
          return;
        }
        // 条数没变就不重复拉 session（视频插件的 snapshot 是 2s 轮询的）。
        if (Number(snapshot.itemCount) <= lastVideoItemCountRef.current) return;
        lastVideoItemCountRef.current = Number(snapshot.itemCount);
        const session = await invoke<{ items?: Array<{ canonicalUrl?: string | null }> }>(
          "video_get_session",
          { sessionId: snapshot.sessionId },
        );
        if (cancelled || !session?.items?.length) return;
        const storage = safeStorage();
        const now = Date.now();
        setVitals((previous) => {
          const seen = loadVideoSeen(storage, now);
          const candidates = newVideoUrls(previous, seen.urls, session.items, now);
          if (!candidates.length) return previous;
          let next = previous;
          let changed = false;
          for (const url of candidates) {
            const decision = videoWatchDecision(next, seen.urls, url, now);
            if (!decision.allowed) continue;
            const result = applyVitalsEvent(next, "video", now);
            if (!result.applied) continue;
            next = result.state;
            seen.urls.push(url);
            saveVideoSeen(storage, seen);
            appendVitalsLog(storage, { kind: "video", at: now, url });
            changed = true;
          }
          return changed ? next : previous;
        });
      } catch {
        // 视频插件未启用 / 没有会话数据：静默，不影响桌宠。
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), VIDEO_SYNC_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  // 进入/退出专注：开始待办 → focus +15 并开始随时间上涨；结束/完成 → 停止上涨。
  const wasFocusRef = useRef(focusActive);
  useEffect(() => {
    if (wasFocusRef.current === focusActive) return;
    wasFocusRef.current = focusActive;
    if (!enabled) return;
    setVitals((previous) => applyVitalsEvent(previous, focusActive ? "todoStart" : "todoStop", Date.now()).state);
  }, [enabled, focusActive]);

  // 持久化：状态变化就落盘，并刷新「最后在线时间」（下次启动算离开时长用）。
  useEffect(() => {
    if (!enabled) return;
    saveVitals(safeStorage(), vitals);
    writeLastSeen(safeStorage(), Date.now());
  }, [enabled, vitals]);

  // 关闭/切后台时也记一次最后在线时间。
  useEffect(() => {
    if (!enabled) return;
    const mark = () => writeLastSeen(safeStorage(), Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "hidden") mark();
    };
    window.addEventListener("beforeunload", mark);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mark();
      window.removeEventListener("beforeunload", mark);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  const reportEvent = useCallback((kind: VitalsEventKind, options?: { todoTitle?: string }) => {
    if (!enabledRef.current) return;
    const now = Date.now();
    setVitals((previous) => applyVitalsEvent(previous, kind, now).state);
    // 记录一条「互动事实」（只有类型/时间/待办标题/视频 URL，不含任何聊天正文），供模型上下文读取。
    appendVitalsLog(safeStorage(), { kind, at: now, todoTitle: options?.todoTitle });
  }, []);

  const refresh = useCallback(() => {
    settle(Date.now());
  }, [settle]);

  const setSleepMode = useCallback((mode: PetSleepMode | null) => {
    setVitals((previous) => ({ ...previous, sleepMode: mode, updatedAt: previous.updatedAt }));
  }, []);

  return {
    vitals,
    reportEvent,
    refresh,
    setSleepMode,
    activityPollingPaused: Boolean(vitals.sleepMode),
  };
}

/** 开关关闭时给调用方一个「不影响轮播」的占位状态。 */
export function disabledVitals(now = Date.now()): PetVitals {
  return createVitals(now, { focusActive: false });
}