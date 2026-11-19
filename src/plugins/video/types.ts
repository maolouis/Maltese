// 「小狗自主刷视频」的前端类型。运行时窄化在边界处完成，不使用 any。

export type Platform = "bilibili" | "douyin";

export type AgentAccountStatus = "draft" | "awaitingLogin" | "ready" | "paused";

export type AgentAccount = {
  id: string;
  platform: Platform;
  displayName: string;
  handle: string;
  persona: string;
  goals: string;
  status: AgentAccountStatus;
  profileDir: string;
  createdAt: number;
  lastLoginAt: number | null;
  lastRunAt: number | null;
};

export type Phase =
  | "idle"
  | "preparing"
  | "awaitingLogin"
  | "collecting"
  | "userTakeover"
  | "digesting"
  | "ended"
  | "interrupted"
  | "blocked"
  | "stopped";

export type StopReason =
  | "userStop"
  | "durationLimit"
  | "itemLimit"
  | "browserClosed"
  | "sleepInterrupt"
  | "riskControl"
  | "leftRecommendFeed"
  | "crash"
  | "takeoverTimeout"
  | "browserUnavailable"
  | "loginRequired"
  | "parseFailed";

export type Capability = "full" | "enhanced" | "basic";

export type ChannelType = "cdp" | "extension" | "uia" | "smtc" | "windowTitle";

export type FailureReason =
  | "parserMismatch"
  | "channelTimeout"
  | "channelUnstable"
  | "loginRequired"
  | "riskControl"
  | "leftRecommendFeed"
  | "browserUnavailable"
  | "portBusy"
  | "navigationFailed"
  | "noResponse"
  | "startFailed";

export type DeliveryStatus = "delivered" | "bubbleOnly" | "pending" | "dropped";

export type DigestGenerator = "model" | "template";

export type InterestLevel = "strong" | "weak" | "discard" | "blocked";

export type ErrorCode =
  | "INVALID_PROVIDER"
  | "INVALID_CONFIG"
  | "BROWSER_UNAVAILABLE"
  | "PORT_BUSY"
  | "LOGIN_REQUIRED"
  | "RISK_CONTROL"
  | "URL_NOT_ALLOWED"
  | "SESSION_RUNNING"
  | "CDP_UNAVAILABLE"
  | "CDP_STALLED"
  | "CDP_RECONNECT_FAILED"
  | "BROWSER_CLOSED"
  | "LOGIN_WINDOW_NOT_VISIBLE"
  | "BROWSER_START_FAILED"
  | "ACCOUNT_NOT_READY"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_PLATFORM_MISMATCH"
  | "NOT_FOUND"
  | "PERSIST_FAILED"
  | "VIDEO_ERROR";

export type ChannelState = {
  type: ChannelType;
  capability: Capability;
  lastSuccessAt: number | null;
  failureReason: FailureReason | null;
  retryCount: number;
  degradedReason: string | null;
};

export type VideoSnapshot = {
  sessionId: string;
  provider: Platform;
  accountId: string | null;
  autoComment: boolean;
  phase: Phase;
  running: boolean;
  intervalSeconds: number;
  maxMinutes: number;
  steps: number;
  itemCount: number;
  strongCount: number;
  filteredCount: number;
  commentCount: number;
  commentDryRunCount: number;
  commentDryRun: boolean;
  lastCommentText: string;
  lastCommentDryRun: boolean;
  lastCommentVerified: boolean;
  lastCommentAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastActionAt: number | null;
  currentUrl: string;
  waitingForBrowser: boolean;
  foregroundTitle: string;
  foregroundProcess: string;
  channel: ChannelState;
  pendingCount: number;
  persistFailed: boolean;
  degraded: boolean;
  errorCode: string | null;
  error: string | null;
};

export type DigestItem = {
  itemKey: string;
  title: string;
  author: string | null;
  platform: Platform;
  durationSeconds: number | null;
  whyLine: string;
  clusterKey: string;
};

export type DigestDraft = {
  sessionId: string;
  themeLine: string | null;
  generator: DigestGenerator;
  items: DigestItem[];
  totalChars: number;
};

export type DiagnosticEntry = {
  at: number;
  sessionId: string | null;
  channel: ChannelType | null;
  level: string;
  code: string;
  message: string;
};

export type SessionSummary = {
  sessionId: string;
  platform: Platform;
  /** 旧版本历史没有账号归属时为 null，表示临时观看。 */
  accountId: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: StopReason | null;
  itemCount: number;
  strongCount: number;
  filteredCount: number;
  errorCode: string | null;
  deliveryStatus: DeliveryStatus | null;
};

export type VideoConfig = {
  provider: Platform;
  maxMinutes: number;
  pageIntervalSeconds: number;
  sampleIntervalSeconds: number;
  maxItems: number;
  dailyDeliveries: number;
  channelPriority: "auto" | "cdpOnly" | "noExtension";
  modelSummary: boolean;
  autoComment: boolean;
  commentDryRun: boolean;
  autoLike: boolean;
  autoFavorite: boolean;
  autoLikeDailyLimit: number;
  autoFavoriteDailyLimit: number;
  keepProfileOnClear: boolean;
};

const PHASES: readonly Phase[] = [
  "idle",
  "preparing",
  "awaitingLogin",
  "collecting",
  "userTakeover",
  "digesting",
  "ended",
  "interrupted",
  "blocked",
  "stopped",
];

const PLATFORMS: readonly Platform[] = ["bilibili", "douyin"];

const CAPABILITIES: readonly Capability[] = ["full", "enhanced", "basic"];

const CHANNEL_TYPES: readonly ChannelType[] = [
  "cdp",
  "extension",
  "uia",
  "smtc",
  "windowTitle",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isChannelState(value: unknown): value is ChannelState {
  if (!isRecord(value)) return false;
  return (
    CHANNEL_TYPES.includes(value.type as ChannelType) &&
    CAPABILITIES.includes(value.capability as Capability) &&
    isNullableNumber(value.lastSuccessAt) &&
    (value.failureReason === null || typeof value.failureReason === "string") &&
    isNumber(value.retryCount) &&
    (value.degradedReason === null || typeof value.degradedReason === "string")
  );
}

export function isVideoSnapshot(value: unknown): value is VideoSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    PLATFORMS.includes(value.provider as Platform) &&
    (value.accountId === null || typeof value.accountId === "string") &&
    (value.autoComment === undefined || typeof value.autoComment === "boolean") &&
    PHASES.includes(value.phase as Phase) &&
    typeof value.running === "boolean" &&
    isNumber(value.intervalSeconds) &&
    isNumber(value.maxMinutes) &&
    isNumber(value.steps) &&
    isNumber(value.itemCount) &&
    isNumber(value.strongCount) &&
    isNumber(value.filteredCount) &&
    isNullableNumber(value.startedAt) &&
    isNullableNumber(value.endedAt) &&
    isNullableNumber(value.lastActionAt) &&
    typeof value.currentUrl === "string" &&
    typeof value.waitingForBrowser === "boolean" &&
    typeof value.foregroundTitle === "string" &&
    typeof value.foregroundProcess === "string" &&
    isChannelState(value.channel) &&
    isNumber(value.pendingCount) &&
    typeof value.persistFailed === "boolean" &&
    typeof value.degraded === "boolean" &&
    (value.errorCode === null || typeof value.errorCode === "string") &&
    (value.error === null || typeof value.error === "string")
  );
}

export function isDigestDraft(value: unknown): value is DigestDraft {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== "string") return false;
  if (value.themeLine !== null && typeof value.themeLine !== "string") return false;
  if (value.generator !== "model" && value.generator !== "template") return false;
  if (!isNumber(value.totalChars)) return false;
  if (!Array.isArray(value.items)) return false;
  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    return (
      typeof item.itemKey === "string" &&
      typeof item.title === "string" &&
      (item.author === null || typeof item.author === "string") &&
      PLATFORMS.includes(item.platform as Platform) &&
      isNullableNumber(item.durationSeconds) &&
      typeof item.whyLine === "string" &&
      typeof item.clusterKey === "string"
    );
  });
}


export function errorMessageForCode(code: string | null, fallback: string): string {
  switch (code) {
    case "BROWSER_UNAVAILABLE":
      return "没有找到 Chrome 或 Edge（需要 120 及以上版本）。";
    case "PORT_BUSY":
      return "本机调试端口被占用，请稍后再试。";
    case "LOGIN_REQUIRED":
      return "请先在小狗专用浏览器里登录一次。";
    case "RISK_CONTROL":
      return "平台要求验证，小狗已经停下来了。";
    case "URL_NOT_ALLOWED":
      return "只能打开 B 站 / 抖音官方页面。";
    case "SESSION_RUNNING":
      return "请先停止当前观看会话。";
    case "CDP_UNAVAILABLE":
      return "小狗专用浏览器没有及时打开调试接口，本轮已经停止。";
    case "CDP_STALLED":
      return "视频页面连续无响应，本轮已经停止。";
    case "CDP_RECONNECT_FAILED":
      return "视频页面连接多次失败，本轮已经停止。";
    case "BROWSER_CLOSED":
      return "小狗专用浏览器已关闭，本轮已经停止。";
    case "LOGIN_WINDOW_NOT_VISIBLE":
      return "专用浏览器没有出现可见的登录窗口，请先关闭它再重试。";
    case "BROWSER_START_FAILED":
      return "专用浏览器没能启动起来，请稍后重试。";
    case "ACCOUNT_NOT_READY":
      return "请先完成小狗账号登录，再开始运营。";
    case "ACCOUNT_NOT_FOUND":
      return "找不到这个小狗账号。";
    case "ACCOUNT_PLATFORM_MISMATCH":
      return "小狗账号的平台和当前选择不一致。";
    case "INVALID_CONFIG":
      return "配置超出允许范围，请检查输入。";
    default:
      return fallback;
  }
}
