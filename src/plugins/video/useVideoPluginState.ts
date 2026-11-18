// 面板状态：2 秒轮询 + 事件订阅；后端字段在边界处窄化。

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isVideoSnapshot,
  type ChannelState,
  type AgentAccount,
  type DiagnosticEntry,
  type DigestDraft,
  type SessionSummary,
  type VideoConfig,
  type VideoSnapshot,
} from "./types";
import type { BrowserStatus } from "./videoPanelLogic";

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  provider: "bilibili",
  maxMinutes: 30,
  pageIntervalSeconds: 45,
  sampleIntervalSeconds: 2,
  maxItems: 200,
  dailyDeliveries: 2,
  channelPriority: "auto",
  modelSummary: true,
  autoComment: false,
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
  accounts: AgentAccount[];
  activeAccount: AgentAccount | null;
  activeAccountLoaded: boolean;
  channel: ChannelState | null;
  diagnostics: DiagnosticEntry[];
  sessions: SessionSummary[];
  preview: DigestDraft | null;
  browserStatus: BrowserStatus | null;
  autoCommentNotice: { ok: boolean; message: string } | null;
  refresh: () => Promise<void>;
  loadBrowserStatus: () => Promise<void>;
  closeBrowser: () => Promise<void>;
  start: (provider: "bilibili" | "douyin", accountId?: string, options?: {
    autoComment?: boolean;
    commentModel?: {
      backend: "dsh" | "local";
      baseUrl: string;
      model: string;
      apiKey?: string | null;
      character?: string;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
    };
  }) => Promise<void>;
  stop: () => Promise<void>;
  updateConfig: (patch: Partial<VideoConfig>) => Promise<void>;
  createAccount: (input: {
    platform: "bilibili" | "douyin";
    displayName: string;
    handle: string;
    persona: string;
    goals: string;
  }) => Promise<AgentAccount>;
  openAccountLogin: (account: AgentAccount) => Promise<void>;
  markAccountReady: (accountId: string) => Promise<void>;
  setActiveAccount: (accountId: string) => Promise<void>;
  probeChannels: () => Promise<void>;
  loadSessions: () => Promise<void>;
  takePending: () => Promise<void>;
  clearData: (includeBrowserProfile: boolean) => Promise<void>;
};

export function useVideoPluginState(): VideoPluginState {
  const [snapshot, setSnapshot] = useState<VideoSnapshot | null>(null);
  const [config, setConfig] = useState<VideoConfig>(DEFAULT_VIDEO_CONFIG);
  const [accounts, setAccounts] = useState<AgentAccount[]>([]);
  const [activeAccount, setActiveAccountState] = useState<AgentAccount | null>(null);
  const [activeAccountLoaded, setActiveAccountLoaded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [preview, setPreview] = useState<DigestDraft | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus | null>(null);
  const [autoCommentNotice, setAutoCommentNotice] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    for (const key of OLD_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
  }, []);

  const loadActiveAccount = useCallback(async () => {
    if (!isTauri()) {
      setActiveAccountLoaded(true);
      return;
    }
    try {
      const result = await invoke<AgentAccount | null>("video_get_active_account");
      setActiveAccountState(result && typeof result === "object" ? result : null);
    } catch {
      // 旧实例没有该命令时仍然允许面板工作，按临时观看处理。
    } finally {
      setActiveAccountLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const next: unknown = await invoke("video_get_snapshot");
      if (isVideoSnapshot(next)) setSnapshot(next);
      const listed = await invoke<AgentAccount[]>("video_list_accounts");
      if (Array.isArray(listed)) setAccounts(listed);
      await loadActiveAccount();
    } catch {
      // 保留上一次状态，面板显示「暂时不可用」。
    }
  }, [loadActiveAccount]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const loadDiagnostics = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const result = await invoke<DiagnosticEntry[]>("video_diagnostics", { limit: 20 });
      if (Array.isArray(result)) setDiagnostics(result);
    } catch {
      // 保留上一次诊断；失败不打扰用户。
    }
  }, []);

  // QA U4：诊断要读后端真实落盘的轨迹，而不是前端自检临时拼的 5 条。
  useEffect(() => {
    void loadDiagnostics();
    const timer = window.setInterval(() => void loadDiagnostics(), 4000);
    return () => window.clearInterval(timer);
  }, [loadDiagnostics]);

  const loadBrowserStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const status = await invoke<BrowserStatus>("video_browser_status");
      if (status && typeof status === "object") setBrowserStatus(status);
    } catch {
      setBrowserStatus(null);
    }
  }, []);

  useEffect(() => {
    void loadBrowserStatus();
  }, [loadBrowserStatus]);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const result = await invoke<SessionSummary[]>("video_list_sessions", { limit: 20 });
      if (Array.isArray(result)) setSessions(result);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<unknown>("video-session-updated", (event) => {
      if (!isVideoSnapshot(event.payload)) return;
      setSnapshot(event.payload);
      if (event.payload.phase === "ended" || event.payload.phase === "interrupted" || event.payload.phase === "stopped") {
        void loadSessions();
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ ok?: unknown; message?: unknown }>("video-auto-comment", (event) => {
      const message = typeof event.payload?.message === "string" ? event.payload.message : "自动评论没有完成";
      setAutoCommentNotice({
        ok: event.payload?.ok === true,
        message,
      });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const start = useCallback(async (
    provider: "bilibili" | "douyin",
    accountId?: string,
    options?: {
      autoComment?: boolean;
      commentModel?: {
        backend: "dsh" | "local";
        baseUrl: string;
        model: string;
        apiKey?: string | null;
        character?: string;
        maxTokens?: number;
        temperature?: number;
        topP?: number;
      };
    },
  ) => {
    await invoke("video_start_session", {
      provider,
      config: {
        provider,
        pageIntervalSeconds: config.pageIntervalSeconds,
        maxMinutes: config.maxMinutes,
        sampleIntervalSeconds: config.sampleIntervalSeconds,
        dailyDeliveries: config.dailyDeliveries,
        modelSummary: config.modelSummary,
        autoComment: options?.autoComment ?? config.autoComment,
        commentModel: options?.commentModel,
      },
      accountId: accountId || undefined,
    });
    await Promise.all([refresh(), loadSessions()]);
  }, [config, loadSessions, refresh]);

  const createAccount = useCallback(async (input: {
    platform: "bilibili" | "douyin";
    displayName: string;
    handle: string;
    persona: string;
    goals: string;
  }) => {
    const account = await invoke<AgentAccount>("video_create_account", input);
    setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
    return account;
  }, []);

  const openAccountLogin = useCallback(async (account: AgentAccount) => {
    await invoke("video_open_login_window", { provider: account.platform, accountId: account.id });
    const awaiting = { ...account, status: "awaitingLogin" as const };
    setAccounts((current) => current.map((item) => item.id === account.id ? awaiting : item));
    setActiveAccountState(awaiting);
  }, []);

  const markAccountReady = useCallback(async (accountId: string) => {
    const account = await invoke<AgentAccount>("video_mark_account_ready", { accountId });
    setAccounts((current) => current.map((item) => item.id === account.id ? account : item));
    setActiveAccountState(account);
  }, []);

  const setActiveAccount = useCallback(async (accountId: string) => {
    const account = await invoke<AgentAccount>("video_set_active_account", { accountId });
    setActiveAccountState(account);
    await Promise.all([refresh(), loadSessions()]);
  }, [loadSessions, refresh]);

  const stop = useCallback(async () => {
    await invoke("video_stop_session");
    await Promise.all([refresh(), loadSessions()]);
  }, [loadSessions, refresh]);

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
    await loadDiagnostics();
  }, [loadDiagnostics]);

  /** U10：用户手动关掉专用浏览器（残留会占住 profile/端口）。 */
  const closeBrowser = useCallback(async () => {
    await invoke("video_close_browser");
    await Promise.all([refresh(), loadBrowserStatus()]);
  }, [loadBrowserStatus, refresh]);

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
    accounts,
    activeAccount,
    activeAccountLoaded,
    channel: snapshot?.channel ?? null,
    diagnostics,
    sessions,
    preview,
    browserStatus,
    autoCommentNotice,
    refresh,
    loadBrowserStatus,
    closeBrowser,
    start,
    stop,
    updateConfig,
    createAccount,
    openAccountLogin,
    markAccountReady,
    setActiveAccount,
    probeChannels,
    loadSessions,
    takePending,
    clearData,
  };
}
