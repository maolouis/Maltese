// 视频插件的跨窗口状态协调器。
//
// 主窗口的视频页和独立插件窗口可能同时挂载同一个面板。所有窗口共享这份
// snapshot/账号/诊断状态，只保留一组轮询与事件监听，避免重复请求和竞态回写。

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isVideoSnapshot,
  type Platform,
  type AgentAccount,
  type ChannelState,
  type DiagnosticEntry,
  type DigestDraft,
  type DigestGenerator,
  type SessionSummary,
  type TasteProfile,
  type TasteReport,
  type VideoConfig,
  type VideoSessionDetail,
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
  commentDryRun: true,
  autoLike: false,
  autoFavorite: false,
  autoLikeDailyLimit: 10,
  autoFavoriteDailyLimit: 5,
  keepProfileOnClear: false,
};

export type VideoCommentModelOptions = {
  backend: "dsh" | "local";
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  character?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

export type VideoStoreState = {
  snapshot: VideoSnapshot | null;
  config: VideoConfig;
  accounts: AgentAccount[];
  activeAccount: AgentAccount | null;
  activeAccountLoaded: boolean;
  diagnostics: DiagnosticEntry[];
  sessions: SessionSummary[];
  /** 历史加载失败的可见原因（null = 正常）。 */
  sessionsError: string | null;
  /** 最近一轮摘要（即使待投递为空也要显示，解决「最近小结空白」）。 */
  latestDigest: DigestDraft | null;
  /** 当前视频口味标签（面板展示）。 */
  taste: TasteProfile | null;
  preview: DigestDraft | null;
  browserStatus: BrowserStatus | null;
  autoCommentNotice: { ok: boolean; message: string } | null;
};

const OLD_KEYS = ["maltese-video-auto-comment", "maltese-video-auto-send-comment"];
let state: VideoStoreState = {
  snapshot: null,
  config: DEFAULT_VIDEO_CONFIG,
  accounts: [],
  activeAccount: null,
  activeAccountLoaded: false,
  diagnostics: [],
  sessions: [],
  sessionsError: null,
  latestDigest: null,
  taste: null,
  preview: null,
  browserStatus: null,
  autoCommentNotice: null,
};

const listeners = new Set<() => void>();
let retained = 0;
let coordinatorStarted = false;
let refreshTimer: number | null = null;
let diagnosticsTimer: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let unlistenSession: Promise<UnlistenFn> | null = null;
let unlistenComment: Promise<UnlistenFn> | null = null;

function publish(patch: Partial<VideoStoreState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function removeLegacyKeys() {
  try {
    for (const key of OLD_KEYS) window.localStorage.removeItem(key);
  } catch {
    // 忽略旧配置清理失败。
  }
}

async function loadActiveAccount() {
  if (!isTauri()) {
    publish({ activeAccountLoaded: true });
    return;
  }
  try {
    const result = await invoke<AgentAccount | null>("video_get_active_account");
    publish({ activeAccount: result && typeof result === "object" ? result : null });
  } catch {
    publish({ activeAccount: null });
  } finally {
    publish({ activeAccountLoaded: true });
  }
}

export async function refreshVideoState() {
  if (!isTauri() || refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next: unknown = await invoke("video_get_snapshot");
      const listed = await invoke<AgentAccount[]>("video_list_accounts");
      if (isVideoSnapshot(next)) publish({ snapshot: next });
      if (Array.isArray(listed)) publish({ accounts: listed });
      await loadActiveAccount();
    } catch {
      // 保留最近一次状态，面板仍显示上次诊断。
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function loadVideoDiagnostics() {
  if (!isTauri()) return;
  try {
    const result = await invoke<DiagnosticEntry[]>("video_diagnostics", { limit: 20 });
    if (Array.isArray(result)) publish({ diagnostics: result });
  } catch {
    // 保留上一次诊断。
  }
}

export async function loadVideoBrowserStatus() {
  if (!isTauri()) return;
  try {
    const result = await invoke<BrowserStatus>("video_browser_status");
    if (result && typeof result === "object") publish({ browserStatus: result });
  } catch {
    publish({ browserStatus: null });
  }
}

export async function loadVideoSessions() {
  if (!isTauri()) return;
  try {
    const result = await invoke<SessionSummary[]>("video_list_sessions", { limit: 20 });
    publish({ sessions: Array.isArray(result) ? result : [], sessionsError: null });
  } catch (error) {
    // 加载失败必须可见（不能白屏）：保留上一次列表，同时给出中文原因。
    publish({
      sessionsError: `历史加载失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** 历史详情：点开某一轮时再按需加载（列表只带摘要，不拖慢面板）。 */
export async function loadVideoLatestDigest() {
  if (!isTauri()) return;
  try {
    let list = state.sessions;
    if (list.length === 0) {
      list = await invoke<SessionSummary[]>("video_list_sessions", { limit: 20 });
    }
    const candidate = list.find((session) => session.hasDigest || session.itemCount > 0);
    if (!candidate) {
      publish({ latestDigest: null });
      return;
    }
    const detail = await loadVideoSessionDetail(candidate.sessionId);
    const digest = detail.digest;
    if (!digest) {
      publish({ latestDigest: null });
      return;
    }
    const generator: DigestGenerator = digest.generator === "model" ? "model" : "template";
    publish({
      latestDigest: {
        sessionId: detail.sessionId,
        themeLine: digest.themeLine,
        generator,
        items: digest.items,
        totalChars: 0,
        reflection: digest.reflection ?? null,
        reflectionSource: digest.reflectionSource ?? null,
      },
    });
  } catch {
    publish({ latestDigest: null });
  }
}

/** 读当前视频口味（画像标签）。 */
export async function loadVideoTaste() {
  if (!isTauri()) return;
  try {
    const profile = await invoke<{ positiveTags?: string[]; negativeTags?: string[]; updatedAt?: number }>(
      "video_get_taste",
    );
    publish({
      taste: {
        positiveTags: profile?.positiveTags ?? [],
        negativeTags: profile?.negativeTags ?? [],
        updatedAt: profile?.updatedAt ?? 0,
      },
    });
  } catch {
    publish({ taste: null });
  }
}

/** 聊天技能/面板：一句话调整口味，返回中文确认（失败抛错由调用方反问）。 */
export async function updateVideoTaste(text: string): Promise<TasteReport> {
  const report = await invoke<TasteReport>("video_update_taste", { text });
  publish({
    taste: {
      positiveTags: report.positiveTags,
      negativeTags: report.negativeTags,
      updatedAt: Date.now() / 1000,
    },
  });
  window.dispatchEvent(new CustomEvent("video-taste-changed"));
  return report;
}

/** 恢复默认口味。 */
export async function resetVideoTaste() {
  const profile = await invoke<{ positiveTags?: string[]; negativeTags?: string[] }>("video_reset_taste");
  publish({
    taste: {
      positiveTags: profile?.positiveTags ?? [],
      negativeTags: profile?.negativeTags ?? [],
      updatedAt: Date.now() / 1000,
    },
  });
  window.dispatchEvent(new CustomEvent("video-taste-changed"));
}

export async function loadVideoSessionDetail(sessionId: string): Promise<VideoSessionDetail> {
  const detail = await invoke<VideoSessionDetail>("video_get_session", { sessionId });
  if (!detail || typeof detail !== "object") {
    throw new Error("返回的会话详情为空");
  }
  return detail;
}

/** 打开 video/logs 目录（历史加载失败时的「查看日志」入口）。 */
export async function openVideoLogsDir() {
  if (!isTauri()) return;
  await invoke("video_open_logs_dir");
}

function startCoordinator() {
  if (coordinatorStarted || !isTauri()) return;
  coordinatorStarted = true;
  removeLegacyKeys();
  void refreshVideoState();
  void loadVideoDiagnostics();
  void loadVideoBrowserStatus();
  void loadVideoSessions().then(() => loadVideoLatestDigest());
  void loadVideoTaste();
  window.addEventListener("video-taste-changed", () => void loadVideoTaste());
  refreshTimer = window.setInterval(() => void refreshVideoState(), 2000);
  diagnosticsTimer = window.setInterval(() => void loadVideoDiagnostics(), 4000);
  unlistenSession = listen<unknown>("video-session-updated", (event) => {
    if (!isVideoSnapshot(event.payload)) return;
    publish({ snapshot: event.payload });
    if (["ended", "interrupted", "stopped"].includes(event.payload.phase)) {
      void loadVideoSessions();
    }
  });
  unlistenComment = listen<{ ok?: unknown; message?: unknown }>("video-auto-comment", (event) => {
    const message = typeof event.payload?.message === "string" ? event.payload.message : "自动评论没有完成";
    publish({ autoCommentNotice: { ok: event.payload?.ok === true, message } });
  });
}

function stopCoordinator() {
  if (!coordinatorStarted || retained > 0) return;
  coordinatorStarted = false;
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  if (diagnosticsTimer !== null) window.clearInterval(diagnosticsTimer);
  refreshTimer = null;
  diagnosticsTimer = null;
  void unlistenSession?.then((stop) => stop());
  void unlistenComment?.then((stop) => stop());
  unlistenSession = null;
  unlistenComment = null;
}

export function retainVideoCoordinator() {
  retained += 1;
  startCoordinator();
  return () => {
    retained = Math.max(0, retained - 1);
    stopCoordinator();
  };
}

export function subscribeVideoState(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVideoState() {
  return state;
}

export async function startVideoSession(
  provider: Platform,
  config: VideoConfig,
  accountId?: string,
  commentModel?: VideoCommentModelOptions,
) {
  await invoke("video_start_session", {
    provider,
    config: { ...config, provider, commentModel },
    accountId: accountId || undefined,
  });
  await Promise.all([refreshVideoState(), loadVideoSessions()]);
}

export async function stopVideoSession() {
  await invoke("video_stop_session");
  await Promise.all([refreshVideoState(), loadVideoSessions()]);
  await loadVideoLatestDigest();
}

export async function updateVideoConfig(patch: Partial<VideoConfig>) {
  const next = { ...state.config, ...patch };
  publish({ config: next });
  await invoke("video_update_config", { patch });
}

export async function closeVideoBrowser() {
  await invoke("video_close_browser");
  await Promise.all([refreshVideoState(), loadVideoBrowserStatus()]);
}

export async function takeVideoPending() {
  if (!isTauri()) return;
  try {
    const result = await invoke<DigestDraft | null>("video_take_pending_digest");
    publish({ preview: result ?? null });
    await refreshVideoState();
  } catch {
    publish({ preview: null });
  }
}

export async function clearVideoData(includeBrowserProfile: boolean) {
  await invoke("video_clear_data", { scope: "all", includeBrowserProfile });
  publish({ preview: null, sessions: [] });
  await refreshVideoState();
}

export async function createVideoAccount(input: {
  platform: Platform;
  displayName: string;
  handle: string;
  persona: string;
  goals: string;
}) {
  const account = await invoke<AgentAccount>("video_create_account", input);
  publish({ accounts: [...state.accounts.filter((item) => item.id !== account.id), account] });
  return account;
}

export async function openVideoAccountLogin(account: AgentAccount) {
  await invoke("video_open_login_window", { provider: account.platform, accountId: account.id });
  const awaiting = { ...account, status: "awaitingLogin" as const };
  publish({
    accounts: state.accounts.map((item) => item.id === account.id ? awaiting : item),
    activeAccount: awaiting,
  });
}

export async function markVideoAccountReady(accountId: string) {
  const account = await invoke<AgentAccount>("video_mark_account_ready", { accountId });
  publish({
    accounts: state.accounts.map((item) => item.id === account.id ? account : item),
    activeAccount: account,
  });
}

export async function setActiveVideoAccount(accountId: string) {
  const account = await invoke<AgentAccount>("video_set_active_account", { accountId });
  publish({ activeAccount: account });
  await Promise.all([refreshVideoState(), loadVideoSessions()]);
}

export async function probeVideoChannels() {
  if (!isTauri()) return;
  try {
    const result = await invoke<ChannelState[]>("video_probe_channels");
    if (Array.isArray(result)) {
      publish({
        diagnostics: result.map((channel) => ({
          at: Date.now(),
          sessionId: null,
          channel: channel.type,
          level: "info",
          code: channel.capability,
          message: channel.degradedReason ?? "可用",
        })),
      });
    }
  } catch {
    publish({ diagnostics: [] });
  }
  await loadVideoDiagnostics();
}
