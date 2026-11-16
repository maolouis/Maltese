// 投递器：只挂在主窗一次；负责写聊天、弹云朵并回写后端去重记录。

import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadProactiveLevel, proactivePlan } from "./proactiveChat";
import { buildToolNote, canDeliverNow, formatDigestMessage } from "./videoDelivery";
import { isDigestDraft, type DigestDraft } from "./plugins/video/types";

const MESSAGES_KEY = "focusd-island-pet-chat-messages";
const MAX_MESSAGES = 60;

type PendingPayload = {
  sessionId: string;
  digest: DigestDraft;
};

type ChatMessage = {
  id: string;
  role: "assistant";
  text: string;
  at: number;
  toolNote?: string;
};

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function appendChat(digest: DigestDraft): boolean {
  try {
    const raw = window.localStorage.getItem(MESSAGES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    const previous = Array.isArray(list) ? list : [];
    const message: ChatMessage = {
      id: createId(),
      role: "assistant",
      text: formatDigestMessage(digest),
      at: Date.now(),
      toolNote: buildToolNote(digest.items.length),
    };
    const next = [...previous, message].slice(-MAX_MESSAGES);
    window.localStorage.setItem(MESSAGES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function useVideoDelivery() {
  useEffect(() => {
    if (!isTauri()) return;
    const delivered = new Set<string>();
    let disposed = false;

    const handle = async (payload: PendingPayload) => {
      if (disposed || delivered.has(payload.sessionId)) return;
      if (!isDigestDraft(payload.digest)) return;

      const level = loadProactiveLevel();
      const plan = proactivePlan(level);
      let idleSeconds = 0;
      try {
        idleSeconds = await invoke<number>("get_system_idle_seconds");
      } catch {
        idleSeconds = 0;
      }
      let isFullscreen = false;
      try {
        isFullscreen = await invoke<boolean>("is_foreground_fullscreen");
      } catch {
        isFullscreen = false;
      }
      let foregroundKind = "other";
      try {
        const activity = await invoke<{ kind?: string }>("get_active_activity");
        foregroundKind = activity?.kind || "other";
      } catch {
        foregroundKind = "other";
      }

      const decision = canDeliverNow({
        proactiveLevel: level,
        plan: { quietHours: plan.quietHours },
        idleSeconds,
        isFullscreen,
        foregroundKind,
        deliveredToday: 0,
        dailyLimit: 5,
        now: Date.now(),
      });
      if (!decision.allowed) return;

      const wroteChat = appendChat(payload.digest);
      try {
        await invoke("show_pet_bubble", {
          mode: "cloud",
          title: `刷到 ${payload.digest.items.length} 条你可能感兴趣的`,
          body: payload.digest.items[0]?.whyLine ?? "小狗整理好了，回来看看吧。",
          ttlMs: 6000,
        });
      } catch {
        // 气泡失败不影响聊天记录。
      }

      delivered.add(payload.sessionId);
      try {
        await invoke("video_mark_delivery", {
          sessionId: payload.sessionId,
          outcome: {
            status: wroteChat ? "delivered" : "bubbleOnly",
            channels: wroteChat ? ["chat", "bubble"] : ["bubble"],
            at: Date.now(),
          },
        });
      } catch {
        // 后端去重失败时保留待投递，下次还能再试。
      }
    };

    const unlisten = listen<PendingPayload>("video-summary-pending", (event) => {
      void handle(event.payload);
    });

    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
}