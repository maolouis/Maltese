// 视频面板的纯展示逻辑（不碰 React / Tauri，便于 node --test 直接单测）。
//
// QA 报告 `docs/qa-video-plugin-2026-11-17.md` 的 U3/U5/U7/U8 都出在这里：
// 失败原因必须能持久显示、0 条要有真实原因、英文错误码和 `[object Object]` 一律不出现在界面上。

import { errorMessageForCode } from "./types.ts";
import type { AgentAccountStatus, StopReason } from "./types.ts";

/** 账号状态在界面上一律显示中文（QA D3）：下拉与「登录：」共用这一份文案。 */
const ACCOUNT_STATUS_LABEL: Record<AgentAccountStatus, string> = {
  draft: "草稿",
  awaitingLogin: "等待登录",
  ready: "已就绪",
  paused: "已暂停",
};

export function accountStatusLabel(status: string): string {
  return ACCOUNT_STATUS_LABEL[status as AgentAccountStatus] ?? status;
}

export type VideoErrorInfo = { code: string | null; message: string };

const FALLBACK_MESSAGE = "操作失败，请稍后再试。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 把 `invoke` 的 reject 值统一成中文提示（U8）：
 * Rust 侧 `VideoError` 是对象，直接 `String(error)` 会变成 `[object Object]`。
 */
export function describeVideoError(error: unknown, fallback: string = FALLBACK_MESSAGE): VideoErrorInfo {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed || trimmed === "[object Object]") {
      return { code: null, message: fallback };
    }
    return { code: null, message: trimmed };
  }
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : null;
    const rawMessage = typeof error.message === "string" ? error.message.trim() : "";
    const message =
      rawMessage && rawMessage !== "[object Object]"
        ? rawMessage
        : errorMessageForCode(code, fallback);
    return { code, message };
  }
  return { code: null, message: fallback };
}

/**
 * 面板上要显示的失败原因：优先本次调用失败，其次用 Rust snapshot 里持久化的错误
 * （U3：浮层被抢焦点收起、面板重挂载后，组件 state 会丢，snapshot 不会）。
 */
export function resolvePanelError(input: {
  localError?: VideoErrorInfo | null;
  snapshotErrorCode?: string | null;
  snapshotError?: string | null;
  interruptedPhase?: boolean;
}): VideoErrorInfo | null {
  if (input.localError) return input.localError;
  const code = input.snapshotErrorCode ?? null;
  const raw = (input.snapshotError ?? "").trim();
  if (code || raw) {
    const message = raw && raw !== "[object Object]" ? raw : errorMessageForCode(code, FALLBACK_MESSAGE);
    return { code, message };
  }
  if (input.interruptedPhase) {
    return { code: null, message: "本轮中断了，原因见下方历史记录。" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 状态条
// ---------------------------------------------------------------------------

export function phaseText(
  running: boolean,
  phase: string,
  waiting: boolean,
  errorCode?: string | null,
): string {
  if (running) {
    if (phase === "preparing") return "正在准备小狗浏览器…";
    if (phase === "awaitingLogin") return "等待你登录一次";
    if (phase === "userTakeover") return "你接管了，先让你看";
    return waiting ? "等待视频页加载" : "小狗正在看";
  }
  if (phase === "digesting") return "正在整理小结";
  if (phase === "ended") return "这一轮看完了";
  if (phase === "stopped") return "已停止";
  if (phase === "interrupted") {
    return errorCode ? `本轮失败：${errorMessageForCode(errorCode, "未完成")}` : "本轮中断了";
  }
  if (phase === "blocked") return "平台要求验证，已停下";
  return "已暂停";
}

// ---------------------------------------------------------------------------
// 历史会话原因（U5/J7）
// ---------------------------------------------------------------------------

export const STOP_REASON_LABEL: Record<string, string> = {
  userStop: "手动停止",
  durationLimit: "到达时长上限",
  itemLimit: "到达条目上限",
  browserClosed: "浏览器已关闭",
  sleepInterrupt: "休眠中断",
  riskControl: "平台风控",
  leftRecommendFeed: "离开推荐流",
  crash: "异常中断",
  takeoverTimeout: "用户接管超时",
  browserUnavailable: "浏览器没准备好",
  loginRequired: "需要登录",
  parseFailed: "页面没解析到内容",
};

/** 0 条/失败会话的「人话」原因：优先用 stopReason，其次用 errorCode，最后兜底。 */
export function sessionReason(session: {
  stopReason: StopReason | string | null;
  errorCode?: string | null;
  itemCount: number;
}): string {
  const reason = session.stopReason ?? "";
  if (reason === "browserUnavailable") return "专用浏览器没启动起来（调试接口不可用）";
  if (reason === "loginRequired") return "需要先在专用浏览器里登录一次";
  if (reason === "parseFailed") return "页面没有解析到内容（可能未登录或页面结构变了）";
  if (reason === "riskControl") return "平台要求验证，狗已经停下来了";
  if (session.errorCode) {
    return errorMessageForCode(session.errorCode, STOP_REASON_LABEL[reason] ?? "已结束");
  }
  if (session.itemCount === 0 && reason === "crash") {
    return "页面没有解析到内容（可能未登录或页面结构变了）";
  }
  return STOP_REASON_LABEL[reason] ?? "已结束";
}

// ---------------------------------------------------------------------------
// 通道/自检文案（U7）
// ---------------------------------------------------------------------------

export const FAILURE_REASON_LABEL: Record<string, string> = {
  parserMismatch: "页面结构变了，解析失败",
  channelTimeout: "调试通道超时",
  channelUnstable: "调试通道不稳定",
  loginRequired: "需要登录",
  riskControl: "平台要求验证",
  leftRecommendFeed: "离开了推荐流",
  browserUnavailable: "浏览器不可用",
  portBusy: "调试端口被占用",
  navigationFailed: "页面打开失败",
  noResponse: "调试接口无响应",
  startFailed: "启动失败",
};

export function failureReasonText(reason: string | null | undefined): string {
  if (!reason) return "";
  return FAILURE_REASON_LABEL[reason] ?? "未知原因";
}

// ---------------------------------------------------------------------------
// 专用浏览器复用（U1/J6）
// ---------------------------------------------------------------------------

export type BrowserReuse = "owned" | "external" | "fresh";

export type BrowserStatus = {
  pid: number | null;
  port: number | null;
  profileDir: string;
  markerPresent: boolean;
  markerPidAlive: boolean;
  cdpReady: boolean;
  reuse: BrowserReuse | string;
};

/**
 * 和 Rust `browser::reuse_decision` 同一张表：内存实例 → 上次残留实例 → 清理后重开。
 * 前端用它决定高级设置里怎么解释（单测覆盖这张表）。
 */
export function decideBrowserReuse(input: {
  ownedAliveAndReady: boolean;
  markerMatchesProfile: boolean;
  markerPidAlive: boolean;
  markerCdpReady: boolean;
}): BrowserReuse {
  if (input.ownedAliveAndReady) return "owned";
  if (input.markerMatchesProfile && input.markerPidAlive && input.markerCdpReady) return "external";
  return "fresh";
}

export function browserStatusText(status: BrowserStatus | null): string {
  if (!status) return "浏览器状态未知（点「刷新」可重新检测）";
  const portText = status.port ? `端口 ${status.port}` : "端口未知";
  if (status.reuse === "owned") return `已连接本次启动的专用浏览器（${portText}）`;
  if (status.reuse === "external") return `检测到上次留下的专用浏览器（${portText}），会直接复用`;
  if (status.markerPidAlive) {
    return "检测到残留的专用浏览器，但调试接口不可用：开始前会先关掉它再启动";
  }
  return "没有残留实例，开始时会启动新的专用浏览器";
}