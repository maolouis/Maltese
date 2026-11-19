// 视频插件状态入口。真正的轮询、事件订阅和跨窗口共享状态位于 videoStateStore.ts。

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentAccount, ChannelState, DiagnosticEntry, DigestDraft, SessionSummary, TasteProfile, VideoConfig } from "./types";
import type { BrowserStatus } from "./videoPanelLogic";
import {
  clearVideoData,
  closeVideoBrowser,
  createVideoAccount,
  getVideoState,
  loadVideoBrowserStatus,
  loadVideoSessions,
  resetVideoTaste,
  markVideoAccountReady,
  openVideoAccountLogin,
  probeVideoChannels,
  refreshVideoState,
  retainVideoCoordinator,
  setActiveVideoAccount,
  startVideoSession,
  stopVideoSession,
  subscribeVideoState,
  takeVideoPending,
  updateVideoConfig,
  type VideoCommentModelOptions,
} from "./videoStateStore";

export { DEFAULT_VIDEO_CONFIG } from "./videoStateStore";

export type VideoPluginState = {
  snapshot: ReturnType<typeof getVideoState>["snapshot"];
  config: VideoConfig;
  accounts: AgentAccount[];
  activeAccount: AgentAccount | null;
  activeAccountLoaded: boolean;
  channel: ChannelState | null;
  diagnostics: DiagnosticEntry[];
  sessions: SessionSummary[];
  /** 历史加载失败时的可见原因（null = 正常）。 */
  sessionsError: string | null;
  latestDigest: DigestDraft | null;
  taste: TasteProfile | null;
  preview: DigestDraft | null;
  browserStatus: BrowserStatus | null;
  autoCommentNotice: { ok: boolean; message: string } | null;
  refresh: () => Promise<void>;
  loadBrowserStatus: () => Promise<void>;
  closeBrowser: () => Promise<void>;
  start: (provider: "bilibili" | "douyin", accountId?: string, options?: {
    autoComment?: boolean;
    commentDryRun?: boolean;
    commentModel?: VideoCommentModelOptions;
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
  resetTaste: () => Promise<void>;
  takePending: () => Promise<void>;
  clearData: (includeBrowserProfile: boolean) => Promise<void>;
};

export function useVideoPluginState(): VideoPluginState {
  const shared = useSyncExternalStore(subscribeVideoState, getVideoState, getVideoState);

  useEffect(() => retainVideoCoordinator(), []);

  const refresh = useCallback(() => refreshVideoState().then(() => undefined), []);
  const loadBrowserStatus = useCallback(() => loadVideoBrowserStatus(), []);
  const closeBrowser = useCallback(() => closeVideoBrowser(), []);
  const stop = useCallback(() => stopVideoSession(), []);
  const updateConfig = useCallback((patch: Partial<VideoConfig>) => updateVideoConfig(patch), []);
  const createAccount = useCallback((input: {
    platform: "bilibili" | "douyin";
    displayName: string;
    handle: string;
    persona: string;
    goals: string;
  }) => createVideoAccount(input), []);
  const openAccountLogin = useCallback((account: AgentAccount) => openVideoAccountLogin(account), []);
  const markAccountReady = useCallback((accountId: string) => markVideoAccountReady(accountId).then(() => undefined), []);
  const setActiveAccount = useCallback((accountId: string) => setActiveVideoAccount(accountId).then(() => undefined), []);
  const probeChannels = useCallback(() => probeVideoChannels(), []);
  const loadSessions = useCallback(() => loadVideoSessions(), []);
  const resetTaste = useCallback(() => resetVideoTaste(), []);
  const takePending = useCallback(() => takeVideoPending(), []);
  const clearData = useCallback((includeBrowserProfile: boolean) => clearVideoData(includeBrowserProfile), []);
  const start = useCallback(async (
    provider: "bilibili" | "douyin",
    accountId?: string,
    options?: {
      autoComment?: boolean;
      commentDryRun?: boolean;
      commentModel?: VideoCommentModelOptions;
    },
  ) => {
    const config = {
      ...shared.config,
      autoComment: options?.autoComment ?? shared.config.autoComment,
      commentDryRun: options?.commentDryRun ?? shared.config.commentDryRun,
    };
    await startVideoSession(provider, config, accountId, options?.commentModel);
  }, [shared.config]);

  return {
    ...shared,
    channel: shared.snapshot?.channel ?? null,
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
    resetTaste,
    takePending,
    clearData,
  };
}
