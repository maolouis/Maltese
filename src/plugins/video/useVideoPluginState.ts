// 面板状态：2 秒轮询 + 事件订阅；后端字段在边界处窄化。

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isVideoSnapshot,
  type ChannelState,
  type DiagnosticEntry,
  type DigestDraft,
  type SessionSummary,
  type VideoConfig,
  type VideoSnapshot,
} from "./types";

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  provider: "bilibili",
  maxMinutes: 30,
  pageIntervalSeconds: 45,
  sampleIntervalSeconds: 2,
  maxItems: 200,
  dailyDeliveries: 2,
  channelPriority: "auto",
  modelSummary: true,
  autoLike: false,
  autoFavorite: false,
  autoLikeDailyLimit: 10,
  autoFavoriteDailyLimit: 5,
  keepProfileOnClear: false,
};

const LEGACY_KEY_PREFIX = "maltese-video-auto-";
const OLD_KEYS = [`${LEGACY_KEY_PREFIX}comment`, `${LEGACY_KEY_PREFIX}send-comment`];

export type VideoPluginState = {
  snapshot: VideoSnapshot | null;
  config: VideoConfig;
  channel: ChannelState | null;
  diagnostics: DiagnosticEntry[];
  sessions: SessionSummary[];
  preview: DigestDraft | null;
  refresh: () => Promise<void>;
  start: (provider: "bilibili" | "douyin") => Promise<void>;
  stop: () => Promise<void>;
  updateConfig: (patch: Partial<VideoConfig>) => Promise<void>;
  probeChannels: () => Promise<void>;
  loadSessions: () => Promise<void>;
  takePending: () => Promise<void>;
  clearData: (includeBrowserProfile: boolean) => Promise<void>;
};

export function useVideoPluginState(): VideoPluginState {
  const [snapshot, setSnapshot] = useState<VideoSnapshot | null>(null);
  const [config, setConfig] = useState<VideoConfig>(DEFAULT_VIDEO_CONFIG);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [preview, setPreview] = useState<DigestDraft | null>(null);

  useEffect(() => {
    for (const key of OLD_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const next: unknown = await invoke("video_get_snapshot");
      if (isVideoSnapshot(next)) setSnapshot(next);
    } catch {
      // 保留上一次状态，面板显示「暂时不可用」。
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<unknown>("video-session-updated", (event) => {
      if (isVideoSnapshot(event.payload)) setSnapshot(event.payload);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const start = useCallback(async (provider: "bilibili" | "douyin") => {
    await invoke("video_start_session", {
      provider,
      config: {
        provider,
        pageIntervalSeconds: config.pageIntervalSeconds,
        maxMinutes: config.maxMinutes,
        sampleIntervalSeconds: config.sampleIntervalSeconds,
        dailyDeliveries: config.dailyDeliveries,
        modelSummary: config.modelSummary,
      },
    });
    await refresh();
  }, [config, refresh]);

  const stop = useCallback(async () => {
    await invoke("video_stop_session");
    await refresh();
  }, [refresh]);

  const updateConfig = useCallback(async (patch: Partial<VideoConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    await invoke("video_update_config", { patch });
  }, [config]);

  const probeChannels = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const result = await invoke<ChannelState[]>("video_probe_channels");
      if (Array.isArray(result)) {
        setDiagnostics(result.map((channel) => ({
          at: Date.now(),
          sessionId: null,
          channel: channel.type,
          level: "info",
          code: channel.capability,
          message: channel.degradedReason ?? "可用",
        })));
      }
    } catch {
      setDiagnostics([]);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const result = await invoke<SessionSummary[]>("video_list_sessions", { limit: 20 });
      if (Array.isArray(result)) setSessions(result);
    } catch {
      setSessions([]);
    }
  }, []);

  const takePending = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const result = await invoke<DigestDraft | null>("video_take_pending_digest");
      setPreview(result ?? null);
      await refresh();
    } catch {
      setPreview(null);
    }
  }, [refresh]);

  const clearData = useCallback(async (includeBrowserProfile: boolean) => {
    await invoke("video_clear_data", { scope: "all", includeBrowserProfile });
    setPreview(null);
    setSessions([]);
    await refresh();
  }, [refresh]);

  return {
    snapshot,
    config,
    channel: snapshot?.channel ?? null,
    diagnostics,
    sessions,
    preview,
    refresh,
    start,
    stop,
    updateConfig,
    probeChannels,
    loadSessions,
    takePending,
    clearData,
  };
}