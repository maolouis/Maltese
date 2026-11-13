import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { Pin,
  Bell,
  Check,
  CircleDot,
  ClipboardList,
  Columns2,
  Copy,
  ExternalLink,
  Loader2,
  GripVertical,
  ImageIcon,
  Minus,
  Music2,
  NotebookPen,
  Pencil,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Repeat,
  Repeat1,
  RotateCcw,
  Save,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Star,
  Trash2,
  Volume2,
  X,
  ChevronDown,
} from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  QQNotificationControls,
  useQQNotifications,
  type QQNotificationsController,
} from "./QQNotifications";
import {
  WeChatReminderControls,
  useWeChatReminders,
  type WeChatRemindersController,
} from "./WeChatReminders";
import { useQQMail, type QQMailController } from "./QQMail";
import { MessagesPanel, messagePanelHeight, type MessageView } from "./Messages";
import { latestMessagePreview, type MessageSource } from "./messagePreview";
import { resolvePetGif } from "./petAssets";
import {
  rotationFramesForState,
  usePetGifRotationConfig,
  usePetGifRotationStates,
} from "./petGifRotation";
import { usePetGifRotation } from "./usePetGifRotation";
import { PET_CHARACTERS, characterFramesForState, savePetCharacter, usePetCharacter } from "./petCharacters";
import { TuckGifControl } from "./TuckGifControl";
import { useTuckGifSource } from "./tuckGif";
import { UpdatePanel } from "./UpdatePanel";
import { UpdateBanner } from "./UpdateBanner";
import {
  getUpdateState,
  startAutoUpdateCheck,
  subscribeToUpdate,
} from "./updaterController";
import { PetChat } from "./PetChat";
import { PluginsPanel } from "./PluginsPanel";
import { isOnboardingDone, markOnboardingDone, OnboardingPanel } from "./OnboardingPanel";
import { useFullscreenAvoid, useTodoRotation } from "./useIslandAutomation";
import { loadWakeShortcut, saveWakeShortcut } from "./wakeShortcut";
import { loadCollapseShortcut, saveCollapseShortcut } from "./collapseShortcut";
import { checkShortcutPath, missingPathMessage } from "./shortcutPath";
import { AppearanceModeControl, ColorControl, LocaleControl, NumberControl, SliderControl, ToggleControl } from "./uiControls";
import { petAssetUrl } from "./petAssetBase";
import { loadLocalChatConfig } from "./localChat";
import {
  buildPrompt as buildProactivePrompt,
  cleanTitle as cleanActivityTitle,
  describeProactivePlan,
  inQuietHours,
  isRepeated as isRepeatedProactiveLine,
  loadProactiveLevel,
  overHourlyLimit,
  pickAngle as pickProactiveAngle,
  proactivePlan,
  recordSpeakTime,
  saveProactiveLevel,
  pickFallback as pickProactiveFallback,
  recentLines as recentProactiveLines,
  rememberLine as rememberProactiveLine,
  type ProactiveAngle,
  type ProactiveContext,
} from "./proactiveChat";
import { playCustomSound } from "./customSound";
import { CustomSoundControl } from "./CustomSoundControl";
import { usePetHitBox } from "./petHitBox";
import {
  loadShortcutAutoDetect,
  loadShortcutScanDir,
  saveShortcutAutoDetect,
  saveShortcutScanDir,
  SHORTCUT_AUTO_DETECT_EVENT,
  SHORTCUT_SCAN_DIR_EVENT,
} from "./shortcutScanDir";
import {
  formatShortcutFromEvent,
  loadShortcutPanelHotkey,
  saveShortcutPanelHotkey,
} from "./shortcutPanelHotkey";
import { MediaWaveform } from "./MediaWaveform";
import {
  useLocale,
  useTranslation,
  type LocaleCode,
  type Translations,
} from "./i18n";
import { getCollapsedTextUnits, getTodoTitleLineCount } from "./utils/text";
import { formatTodoElapsed, getTodoElapsedMs } from "./todoTimer";
import { DiaryTimeline, type DiaryEvent } from "./DiaryTimeline";
import "./PetBubble.css";
import "./App.css";

export type IslandMode = "collapsed" | "expanded";

type PetOverlay = { mode: "hover" | "cloud"; title?: string; body?: string; image?: string; todoTitle?: string };

type IslandPage = "todo" | "music" | "clipboard" | "layout" | "qq" | "assistant" | "chat" | "video" | "onboarding";
type PetState =
  | "idle"
  | "listening"
  | "working"
  | "attention"
  | "pet"
  | "eating"
  | "pickup"
  | "scared"
  | "sleeping"
  | "celebrate"
  | "chin"
  | "spin"
  | "play"
  | "hide"
  | "chase"
  | "peek"
  | "happy"
  | "relax";
type PetAction = Exclude<PetState, "idle" | "listening" | "working" | "attention">;
type TodoPageMode = "today" | "daily" | "archive" | "review";
type ArchiveLayout = "cards" | "timeline";
type MediaKind = "music" | "video" | "image" | "unknown";

type MediaPlaybackStatus = "unavailable" | "playing" | "paused";
type AgentProvider = "codex" | "claudeCode";
type AgentTaskPhase = "idle" | "running" | "completed" | "failed" | "stale";
type AgentVisualState = "idle" | "running" | "attention";

type TodoItem = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number | null;
  /** 第一次开始做的时间；仅用于展示，计时以 activeSince/elapsedMs 为准。 */
  startedAt?: number | null;
  /** 当前这段计时的起点；暂停时为 null。 */
  activeSince?: number | null;
  /** 已经累计的计时毫秒数（暂停/完成时结算）。 */
  elapsedMs?: number;
};

type TodoArchive = {
  date: string;
  todos: TodoItem[];
  dailyNote: string;
  savedAt: number;
  savedToDisk: boolean;
  filePath?: string;
};

type SaveState = "idle" | "saving" | "saved" | "needs-path" | "error";
type SavePathState = "idle" | "saved";

type SaveTodoResult = {
  filePath: string;
};

type MediaRepeatMode = "none" | "track" | "list" | "unknown";

type MediaSessionInfo = {
  id: string;
  label: string;
  playing: boolean;
};

type KnownMediaSource = {
  id: string;
  label: string;
};

type MediaState = {
  available: boolean;
  audioActive: boolean;
  audioPeak: number;
  playbackStatus: MediaPlaybackStatus;
  title: string | null;
  artist: string | null;
  album: string | null;
  thumbnail: string | null;
  positionMs: number;
  durationMs: number;
  canSeek: boolean;
  canNext: boolean;
  canPrevious: boolean;
  shuffleActive: boolean | null;
  canShuffle: boolean;
  repeatMode: MediaRepeatMode;
  canRepeat: boolean;
  volume: number;
  sourceApp: string | null;
  /** "music" / "video" / "image" / "unknown"，来自系统媒体会话的 PlaybackType。 */
  mediaKind: MediaKind;
  activeSessionId: string | null;
  sessions: MediaSessionInfo[];
  updatedAt: number;
};

type ClipboardHistorySettings = {
  enabled: boolean;
  captureImages: boolean;
  maxItems: number;
};

type ClipboardHistoryImage = {
  width: number;
  height: number;
  byteSize: number;
  originalPath: string;
  thumbnailPath: string;
  thumbnailDataUrl?: string;
};

type ClipboardHistoryItem = {
  id: string;
  kind: "text" | "image";
  hash: string;
  createdAt: number;
  copiedAt: number;
  favorite?: boolean;
  note?: string;
  preview: string;
  text?: string;
  image?: ClipboardHistoryImage;
};

type ClipboardHistorySnapshot = {
  settings: ClipboardHistorySettings;
  items: ClipboardHistoryItem[];
};

type AudioLevel = {
  active: boolean;
  peak: number;
  updatedAt: number;
};

type AgentTaskStatus = {
  phase: AgentTaskPhase;
  taskId?: string;
  updatedAt: number;
};

type AgentStatusSnapshot = Record<AgentProvider, AgentTaskStatus> & {
  updatedAt: number;
  statusPath: string;
};

type AgentHooksInstallResult = {
  scriptsDir: string;
  statusPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  installedAt: number;
};

type AgentHooksInstallState = "idle" | "installing" | "installed" | "error";
type AppearanceMode = "classic" | "liquidGlass";
type IslandFont = "system" | "pixel";
type NativeGlassState = "active" | "css-fallback" | "disabled";

type IslandPosition = {
  x: number;
  y: number;
};

type BongoPosition = "bottomCenter" | "bottomLeft" | "bottomRight" | "topCenter";

type IslandSettings = {
  topEdgeLayoutVersion: 1;
  appearanceMode: AppearanceMode;
  fontFamily: IslandFont;
  glassIntensity: number;
  opacity: number;
  petOpacity: number;
  petCount: number;
  bongoEnabled: boolean;
  bongoSize: number;
  bongoOpacity: number;
  bongoMirror: boolean;
  bongoClickThrough: boolean;
  bongoPosition: BongoPosition;
  followMouse: boolean;
  cursorPetSize: number;
  collapsedScale: number;
  expandedScale: number;
  chatPanelHeight: number;
  marginY: number;
  taskTextColor: string;
  pulseColor: string;
  pulseBrightness: number;
  islandBackgroundColor: string;
  todoBackgroundColor: string;
  showTitle: boolean;
  showCollapsedText: boolean;
  showIdleTodoCount: boolean;
  rotateTodos: boolean;
  todoRotationSeconds: number;
  todoReminderMinutes: number;
  autoTuck: boolean;
  autoTuckSeconds: number;
  fullscreenAvoid: FullscreenAvoidMode;
  /** 全屏时是否连 Bongo / 陪伴狗 / 跟随小狗一起隐藏。 */
  fullscreenHideExtras: boolean;
  fpsMode: PetFpsMode;
  bubbleOn: boolean;
  bubbleDurationMs: number;
  clickSquash: boolean;
  lockCorner: PetLockCorner;
  clipboardBubble: boolean;
  bubbleTextColor: string;
  soundOn: boolean;
  hourlyChime: boolean;
  mouseInteractions: boolean;
  senseTime: boolean;
  nightCompanion: boolean;
  observeApps: boolean;
  musicChat: boolean;
  autoRotateExpressions: boolean;
  proactiveBubbles: boolean;
  proactiveChat: boolean;
  proactiveChatMinutes: number;
  /** 主动聊天方式：定时（interval）或跟随状态变化（state）。 */
  proactiveChatMode: ProactiveChatMode;
  /** 主动程度 0–100：同时决定冷却、每小时上限、稳定时长与免打扰时段。 */
  proactiveLevel: number;
  petFlipY: boolean;
  roam: boolean;
  sleepAfterSeconds: number;
  /** 缩边睡觉时露在屏幕边缘的小狗高度（逻辑像素）。 */
  tuckedVisibleHeight: number;
};

type PetFpsMode = "smooth" | "balanced" | "normal" | "saver";
type PetLockCorner = "" | "tl" | "tr" | "bl" | "br";

type FullscreenAvoidMode = "tuck" | "hide" | "off";

type ProactiveChatMode = "interval" | "state";

type IslandPreset = {
  id: string;
  name: string;
  settings: IslandSettings;
  createdAt: number;
  isDefault?: boolean;
};

type IslandShellProps = {
  qqMail: QQMailController;
  qqNotifications: QQNotificationsController;
  wechatReminders: WeChatRemindersController;
  onOpenMessages: (source: MessageSource) => void;
  mode: IslandMode;
  page: IslandPage;
  appearanceMode: AppearanceMode;
  nativeGlassState: NativeGlassState;
  isTucked: boolean;
  isDetached: boolean;
  showTitle: boolean;
  showCollapsedText: boolean;
  collapsedTaskTitle: string | null;
  collapsedTodoCount: number | null;
  mediaState: MediaState;
  agentVisualState: AgentVisualState;
  agentStatusLabel: string;
  petState: PetState;
  onPetAction: (action: PetAction) => void;
  onPetHoverStart: () => void;
  onPetHoverEnd: () => void;
  clickSquash: boolean;
  mouseInteractions: boolean;
  autoRotateExpressions: boolean;
  collapsedScale: number;
  sleepAfterSeconds: number;
  overlay: PetOverlay | null;
  overlayOpen: boolean;
  /** 原生算好的浮层方向；有值时优先于事件回传的方向。 */
  overlayPlacement: { side: "left" | "right"; vertical: "above" | "below" } | null;
  onOverlayEnter: () => void;
  onOverlayLeave: () => void;
  onOverlayClose: () => void;
  onOpenPage: (page: IslandPage) => void;
  onWindowDragStart: () => void;
  onCollapse: () => void;
  onResetPosition: () => void;
  onMinimize: () => void;
  onReveal: () => void;
  onSleepTuck: () => void;
  onSleepReveal: () => void;
  onPageChange: (page: IslandPage) => void;
  children: ReactNode;
};

const STORAGE_KEY = "focusd-island-settings";
const COLLAPSED_TEXT_DEFAULT_MIGRATION_KEY =
  "focusd-island-collapsed-text-default-v1";
const SETTINGS_PRESETS_STORAGE_KEY = "focusd-island-setting-presets";
const TODOS_STORAGE_KEY = "focusd-island-todos";
const ACTIVE_TODO_STORAGE_KEY = "focusd-island-active-todo";
const TODO_DATE_STORAGE_KEY = "focusd-island-current-date";
const TODO_ARCHIVE_STORAGE_KEY = "focusd-island-archives";
const DAILY_NOTE_STORAGE_KEY = "focusd-island-daily-note";
const DIARY_EVENTS_STORAGE_KEY = "focusd-island-diary-events";
const TODO_SAVE_DIRECTORY_STORAGE_KEY = "focusd-island-save-directory";
const TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY =
  "focusd-island-last-saved-signature";
const ISLAND_POSITION_STORAGE_KEY = "focusd-island-position";
const MUSIC_SOURCE_PRIORITY_STORAGE_KEY = "focusd-island-music-sources";
const MIN_COLLAPSED_ISLAND_WIDTH = 160;
const MAX_COLLAPSED_ISLAND_WIDTH = 180;
const MIN_COLLAPSED_TEXT_UNITS = 2;
const MAX_COLLAPSED_TEXT_UNITS = 12;
const BASE_EXPANDED_ISLAND_HEIGHT = 306;
const TODO_ARCHIVE_EXPANDED_ISLAND_HEIGHT = 352;
const MUSIC_EXPANDED_ISLAND_HEIGHT = 440;
const MUSIC_SETTINGS_EXPANDED_ISLAND_HEIGHT = 320;
const CLIPBOARD_EXPANDED_ISLAND_HEIGHT = 430;
const EDITOR_EXPANDED_ISLAND_HEIGHT = 430;
const TODO_ROW_HEIGHT = 46;
const TODO_GROW_START_ROWS = 2;
const TODO_SCROLL_START_ROWS = 6;
const MAX_CUSTOM_SETTING_PRESETS = 6;
const DEFAULT_TASK_TEXT_COLOR = "#ffffff";
const AUDIO_ACTIVE_THRESHOLD = 0.000015;
const DEFAULT_MEDIA_STATE: MediaState = {
  available: false,
  audioActive: false,
  audioPeak: 0,
  playbackStatus: "unavailable",
  title: null,
  artist: null,
  album: null,
  thumbnail: null,
  positionMs: 0,
  durationMs: 0,
  canSeek: false,
  canNext: false,
  canPrevious: false,
  shuffleActive: null,
  canShuffle: false,
  repeatMode: "unknown",
  canRepeat: false,
  volume: -1,
  sourceApp: null,
  mediaKind: "unknown",
  activeSessionId: null,
  sessions: [],
  updatedAt: 0,
};

function isSameMediaState(a: MediaState, b: MediaState): boolean {
  if (
    a.available !== b.available ||
    a.audioActive !== b.audioActive ||
    a.audioPeak !== b.audioPeak ||
    a.playbackStatus !== b.playbackStatus ||
    a.title !== b.title ||
    a.artist !== b.artist ||
    a.album !== b.album ||
    a.thumbnail !== b.thumbnail ||
    a.positionMs !== b.positionMs ||
    a.durationMs !== b.durationMs ||
    a.canSeek !== b.canSeek ||
    a.canNext !== b.canNext ||
    a.canPrevious !== b.canPrevious ||
    a.shuffleActive !== b.shuffleActive ||
    a.canShuffle !== b.canShuffle ||
    a.repeatMode !== b.repeatMode ||
    a.canRepeat !== b.canRepeat ||
    a.volume !== b.volume ||
    a.sourceApp !== b.sourceApp ||
    a.mediaKind !== b.mediaKind ||
    a.activeSessionId !== b.activeSessionId ||
    a.sessions.length !== b.sessions.length
  ) {
    return false;
  }

  return a.sessions.every((session, index) => {
    const other = b.sessions[index];
    return (
      session.id === other.id &&
      session.label === other.label &&
      session.playing === other.playing
    );
  });
}

const DEFAULT_AGENT_TASK_STATUS: AgentTaskStatus = {
  phase: "idle",
  updatedAt: 0,
};
const DEFAULT_AGENT_STATUS: AgentStatusSnapshot = {
  codex: DEFAULT_AGENT_TASK_STATUS,
  claudeCode: DEFAULT_AGENT_TASK_STATUS,
  updatedAt: 0,
  statusPath: "",
};
const AGENT_PROVIDERS: AgentProvider[] = ["codex", "claudeCode"];
const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: "Codex",
  claudeCode: "Claude Code",
};
const DEFAULT_CLIPBOARD_HISTORY: ClipboardHistorySnapshot = {
  settings: {
    enabled: true,
    captureImages: true,
    maxItems: 30,
  },
  items: [],
};
const DEFAULT_SETTINGS: IslandSettings = {
  topEdgeLayoutVersion: 1,
  appearanceMode: "classic",
  fontFamily: "system",
  glassIntensity: 72,
  opacity: 95,
  petOpacity: 100,
  petCount: 1,
  bongoEnabled: false,
  bongoSize: 440,
  bongoOpacity: 100,
  bongoMirror: true,
  bongoClickThrough: false,
  bongoPosition: "bottomCenter",
  followMouse: false,
  cursorPetSize: 75,
  collapsedScale: 0.89,
  expandedScale: 0.91,
  chatPanelHeight: 520,
  marginY: 0,
  taskTextColor: DEFAULT_TASK_TEXT_COLOR,
  pulseColor: "#3ae489",
  pulseBrightness: 100,
  islandBackgroundColor: "#2F2F37",
  todoBackgroundColor: "#ffffff",
  showTitle: false,
  showCollapsedText: true,
  showIdleTodoCount: true,
  rotateTodos: false,
  todoRotationSeconds: 5,
  todoReminderMinutes: 30,
  autoTuck: false,
  autoTuckSeconds: 30,
  fullscreenAvoid: "tuck",
  fullscreenHideExtras: true,
  fpsMode: "balanced",
  bubbleOn: true,
  bubbleDurationMs: 6000,
  clickSquash: true,
  lockCorner: "",
  clipboardBubble: true,
  bubbleTextColor: "#2b2f3a",
  soundOn: true,
  hourlyChime: false,
  mouseInteractions: true,
  senseTime: true,
  nightCompanion: true,
  observeApps: true,
  musicChat: true,
  autoRotateExpressions: true,
  proactiveBubbles: true,
  proactiveChat: false,
  proactiveChatMinutes: 30,
  proactiveChatMode: "interval",
  proactiveLevel: 50,
  petFlipY: false,
  roam: false,
  sleepAfterSeconds: 150,
  tuckedVisibleHeight: 80,
};
// 本次版本默认帮用户打开微信 / QQ 消息提醒（点击开关仍可关闭）。
try {
  const reminderFlag = "maltese-reminders-default-on-v2";
  if (!window.localStorage.getItem(reminderFlag)) {
    window.localStorage.setItem("focusd-island-wechat-reminders-enabled", "true");
    window.localStorage.setItem("focusd-island-qq-notifications-enabled", "true");
    // 允许再弹一次 Windows 通知访问授权，否则 QQ 提醒读不到新通知。
    window.localStorage.removeItem("focusd-island-qq-notification-access-requested");
    window.localStorage.setItem(reminderFlag, "1");
    // 本次起收起态默认趴在工作区底部（桌面边缘），清一次手动位置让新默认生效。
    const bottomFlag = "maltese-bottom-default-v1";
    if (!window.localStorage.getItem(bottomFlag)) {
      window.localStorage.removeItem("focusd-island-position");
      window.localStorage.setItem(bottomFlag, "1");
    }
  }
} catch {
  // 忽略隐私模式下的写入失败
}

const LEGACY_DEFAULT_PRESET_IDS = new Set(["default-white", "default-khaki"]);
const LEGACY_DEFAULT_PRESET_NAMES = new Set(["白色", "卡其"]);

type LegacyIslandSettings = Partial<IslandSettings> & {
  margin?: number;
  sizeScale?: number;
  taskTitleColor?: string;
  pendingTodoColor?: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function getColorSetting(value: unknown, fallback: string) {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value
    : fallback;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAgentAttentionPhase(phase: AgentTaskPhase) {
  return phase === "failed" || phase === "stale";
}

function getAgentVisualState(snapshot: AgentStatusSnapshot): AgentVisualState {
  const statuses = AGENT_PROVIDERS.map((provider) => snapshot[provider]);

  if (statuses.some((status) => isAgentAttentionPhase(status.phase))) {
    return "attention";
  }

  if (statuses.some((status) => status.phase === "running")) {
    return "running";
  }

  return "idle";
}

function getAgentStatusLabel(snapshot: AgentStatusSnapshot, t: Translations) {
  const attentionProvider = AGENT_PROVIDERS.find((provider) =>
    isAgentAttentionPhase(snapshot[provider].phase),
  );

  if (attentionProvider) {
    const phase = snapshot[attentionProvider].phase;
    const providerLabel = AGENT_PROVIDER_LABELS[attentionProvider];
    return phase === "stale"
      ? t.agent.stale(providerLabel)
      : t.agent.failed(providerLabel);
  }

  const runningProvider = AGENT_PROVIDERS.find(
    (provider) => snapshot[provider].phase === "running",
  );

  if (runningProvider) {
    return t.agent.running(AGENT_PROVIDER_LABELS[runningProvider]);
  }

  return t.agent.idleOrDone;
}

function getAgentPhaseLabel(phase: AgentTaskPhase, t: Translations) {
  switch (phase) {
    case "running":
      return t.agent.phase.running;
    case "completed":
      return t.agent.phase.completed;
    case "failed":
      return t.agent.phase.failed;
    case "stale":
      return t.agent.phase.stale;
    case "idle":
    default:
      return t.agent.phase.idle;
  }
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = HEX_COLOR_PATTERN.test(hex)
    ? hex.slice(1)
    : DEFAULT_SETTINGS.pulseColor.slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizeClipboardSettings(
  settings: ClipboardHistorySettings,
): ClipboardHistorySettings {
  return {
    ...settings,
    maxItems: clamp(Math.round(settings.maxItems), 5, 200),
  };
}

function normalizeBongoPosition(value: unknown): BongoPosition {
  return value === "bottomLeft" || value === "bottomRight" || value === "topCenter"
    ? value
    : "bottomCenter";
}

function normalizeSettings(
  settings: LegacyIslandSettings | null | undefined,
): IslandSettings {
  const taskTextColor = getColorSetting(
    settings?.taskTextColor ?? settings?.pendingTodoColor,
    getColorSetting(settings?.taskTitleColor, DEFAULT_SETTINGS.taskTextColor),
  );
  const hasPreviousDefaultScales =
    settings?.collapsedScale === 0.81 && settings.expandedScale === 0.88;
  const collapsedScale = hasPreviousDefaultScales
    ? 0.82
    : settings?.collapsedScale ?? settings?.sizeScale ?? DEFAULT_SETTINGS.collapsedScale;
  const expandedScale = hasPreviousDefaultScales
    ? DEFAULT_SETTINGS.expandedScale
    : settings?.expandedScale ?? settings?.sizeScale ?? DEFAULT_SETTINGS.expandedScale;
  const marginY = settings?.marginY ?? settings?.margin ?? DEFAULT_SETTINGS.marginY;
  const hasPreviousDefaultMargin =
    settings?.topEdgeLayoutVersion !== 1 && (marginY === 31 || marginY === 12);

  return {
    topEdgeLayoutVersion: 1,
    fontFamily: settings?.fontFamily === "pixel" ? "pixel" : "system",
    // 云朵窗口主题：彻底停用灵动岛玻璃外观，避免残留亚克力模糊底。
    appearanceMode: "classic",
    glassIntensity: clamp(
      Number(settings?.glassIntensity ?? DEFAULT_SETTINGS.glassIntensity),
      25,
      100,
    ),
    opacity: clamp(Number(settings?.opacity ?? DEFAULT_SETTINGS.opacity), 50, 100),
    petOpacity: clamp(
      Number(settings?.petOpacity ?? DEFAULT_SETTINGS.petOpacity),
      30,
      100,
    ),
    petCount: clamp(
      Math.round(Number(settings?.petCount ?? DEFAULT_SETTINGS.petCount)),
      1,
      5,
    ),
    bongoEnabled: settings?.bongoEnabled === true,
    bongoSize: clamp(
      Math.round(Number(settings?.bongoSize ?? DEFAULT_SETTINGS.bongoSize)),
      220,
      700,
    ),
    bongoOpacity: clamp(
      Math.round(Number(settings?.bongoOpacity ?? DEFAULT_SETTINGS.bongoOpacity)),
      30,
      100,
    ),
    bongoMirror: settings?.bongoMirror !== false,
    bongoClickThrough: settings?.bongoClickThrough === true,
    bongoPosition: normalizeBongoPosition(settings?.bongoPosition),
    followMouse: settings?.followMouse === true,
    cursorPetSize: clamp(
      Math.round(Number(settings?.cursorPetSize ?? DEFAULT_SETTINGS.cursorPetSize)),
      30,
      180,
    ),
    collapsedScale: clamp(
      Number(collapsedScale),
      0.5,
      1.8,
    ),
    expandedScale: clamp(
      Number(expandedScale),
      0.5,
      1.8,
    ),
    chatPanelHeight: clamp(
      Math.round(Number(settings?.chatPanelHeight ?? DEFAULT_SETTINGS.chatPanelHeight)),
      360,
      900,
    ),
    marginY: clamp(
      Number(hasPreviousDefaultMargin ? DEFAULT_SETTINGS.marginY : marginY),
      0,
      160,
    ),
    taskTextColor,
    pulseColor: getColorSetting(
      settings?.pulseColor,
      DEFAULT_SETTINGS.pulseColor,
    ),
    pulseBrightness: clamp(
      Number(settings?.pulseBrightness ?? DEFAULT_SETTINGS.pulseBrightness),
      50,
      160,
    ),
    islandBackgroundColor: getColorSetting(
      settings?.islandBackgroundColor,
      DEFAULT_SETTINGS.islandBackgroundColor,
    ),
    todoBackgroundColor: getColorSetting(
      settings?.todoBackgroundColor,
      DEFAULT_SETTINGS.todoBackgroundColor,
    ),
    showTitle:
      typeof settings?.showTitle === "boolean"
        ? settings.showTitle
        : DEFAULT_SETTINGS.showTitle,
    showCollapsedText:
      typeof settings?.showCollapsedText === "boolean"
        ? settings.showCollapsedText
        : DEFAULT_SETTINGS.showCollapsedText,
    showIdleTodoCount:
      typeof settings?.showIdleTodoCount === "boolean"
        ? settings.showIdleTodoCount
        : DEFAULT_SETTINGS.showIdleTodoCount,
    // 未完成的待办永远保留，不再由“自动写入下一天”开关控制。
    rotateTodos: settings?.rotateTodos === true,
    todoRotationSeconds: typeof settings?.todoRotationSeconds === "number" && Number.isFinite(settings.todoRotationSeconds)
      ? clamp(Math.round(settings.todoRotationSeconds), 1, 3_600)
      : DEFAULT_SETTINGS.todoRotationSeconds,
    todoReminderMinutes:
      typeof settings?.todoReminderMinutes === "number" &&
      Number.isFinite(settings.todoReminderMinutes)
        ? clamp(Math.round(settings.todoReminderMinutes), 1, 180)
        : DEFAULT_SETTINGS.todoReminderMinutes,
    autoTuck: settings?.autoTuck === true,
    autoTuckSeconds: typeof settings?.autoTuckSeconds === "number" && Number.isFinite(settings.autoTuckSeconds)
      ? clamp(Math.round(settings.autoTuckSeconds), 1, 3_600)
      : DEFAULT_SETTINGS.autoTuckSeconds,
    fullscreenAvoid: settings?.fullscreenAvoid === "hide" || settings?.fullscreenAvoid === "off"
      ? settings.fullscreenAvoid
      : DEFAULT_SETTINGS.fullscreenAvoid,
    fullscreenHideExtras: settings?.fullscreenHideExtras !== false,
    fpsMode: settings?.fpsMode === "smooth" || settings?.fpsMode === "normal" || settings?.fpsMode === "saver"
      ? settings.fpsMode
      : DEFAULT_SETTINGS.fpsMode,
    bubbleOn: settings?.bubbleOn !== false,
    bubbleDurationMs: typeof settings?.bubbleDurationMs === "number" && Number.isFinite(settings.bubbleDurationMs)
      ? clamp(Math.round(settings.bubbleDurationMs), 1500, 20000)
      : DEFAULT_SETTINGS.bubbleDurationMs,
    bubbleTextColor:
      typeof settings?.bubbleTextColor === "string" && /^#[0-9a-fA-F]{6}$/.test(settings.bubbleTextColor)
        ? settings.bubbleTextColor
        : DEFAULT_SETTINGS.bubbleTextColor,
    soundOn: settings?.soundOn !== false,
    hourlyChime: settings?.hourlyChime === true,
    mouseInteractions: settings?.mouseInteractions !== false,
    senseTime: settings?.senseTime !== false,
    sleepAfterSeconds: clamp(
      Number(settings?.sleepAfterSeconds ?? DEFAULT_SETTINGS.sleepAfterSeconds),
      30,
      1800,
    ),
    tuckedVisibleHeight: clamp(
      Number(settings?.tuckedVisibleHeight ?? DEFAULT_SETTINGS.tuckedVisibleHeight),
      24,
      140,
    ),
    nightCompanion: settings?.nightCompanion !== false,
    observeApps: settings?.observeApps !== false,
    musicChat: settings?.musicChat !== false,
    autoRotateExpressions: settings?.autoRotateExpressions !== false,
    proactiveBubbles: settings?.proactiveBubbles !== false,
    proactiveChat: settings?.proactiveChat === true,
    proactiveChatMinutes: clamp(
      Math.round(Number(settings?.proactiveChatMinutes ?? DEFAULT_SETTINGS.proactiveChatMinutes)),
      5,
      240,
    ),
    proactiveChatMode: settings?.proactiveChatMode === "state" ? "state" : "interval",
    proactiveLevel: clamp(
      Math.round(Number(settings?.proactiveLevel ?? loadProactiveLevel())),
      0,
      100,
    ),
    petFlipY: settings?.petFlipY === true,
    roam: settings?.roam === true,
    clickSquash: settings?.clickSquash !== false,
    lockCorner: settings?.lockCorner === "tl" || settings?.lockCorner === "tr" || settings?.lockCorner === "bl" || settings?.lockCorner === "br"
      ? settings.lockCorner
      : "",
    clipboardBubble: settings?.clipboardBubble !== false,
  };
}

function getDefaultSettingPresets(): IslandPreset[] {
  return [];
}

function mergeWithDefaultSettingPresets(presets: IslandPreset[]) {
  const defaultPresets = getDefaultSettingPresets();
  const customPresets = presets
    .filter(
      (preset) =>
        !preset.isDefault &&
        !LEGACY_DEFAULT_PRESET_IDS.has(preset.id) &&
        !LEGACY_DEFAULT_PRESET_NAMES.has(preset.name.trim()),
    )
    .map((preset) => ({ ...preset, isDefault: false }))
    .slice(0, MAX_CUSTOM_SETTING_PRESETS);

  return [...defaultPresets, ...customPresets];
}

function isDefaultSettingPreset(presetId: string) {
  return LEGACY_DEFAULT_PRESET_IDS.has(presetId);
}

function getCollapsedIslandWidth(text: string) {
  const visualUnits = getCollapsedTextUnits(text);
  const widthProgress =
    (clamp(
      visualUnits,
      MIN_COLLAPSED_TEXT_UNITS,
      MAX_COLLAPSED_TEXT_UNITS,
    ) -
      MIN_COLLAPSED_TEXT_UNITS) /
    (MAX_COLLAPSED_TEXT_UNITS - MIN_COLLAPSED_TEXT_UNITS);

  return Math.round(
    MIN_COLLAPSED_ISLAND_WIDTH +
      widthProgress *
        (MAX_COLLAPSED_ISLAND_WIDTH - MIN_COLLAPSED_ISLAND_WIDTH),
  );
}

function getTodoVisualRows(todoList: TodoItem[]) {
  return todoList.reduce(
    (total, todo) => total + getTodoTitleLineCount(todo.title),
    0,
  );
}

function loadSettings(): IslandSettings {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    window.localStorage.setItem(COLLAPSED_TEXT_DEFAULT_MIGRATION_KEY, "1");
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandSettings> & {
      margin?: number;
    };
    const normalized = normalizeSettings(parsed);

    if (
      window.localStorage.getItem(COLLAPSED_TEXT_DEFAULT_MIGRATION_KEY) !== "1"
    ) {
      const migrated = { ...normalized, showCollapsedText: true };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      window.localStorage.setItem(COLLAPSED_TEXT_DEFAULT_MIGRATION_KEY, "1");
      return migrated;
    }

    return normalized;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadIslandPosition(): IslandPosition | null {
  const stored = window.localStorage.getItem(ISLAND_POSITION_STORAGE_KEY);

  if (!stored) {
    return null;
  }

  try {
    const position = JSON.parse(stored) as Partial<IslandPosition>;
    if (
      typeof position.x !== "number" ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      return null;
    }

    return { x: Math.round(position.x), y: Math.round(position.y) };
  } catch {
    return null;
  }
}

function loadSettingPresets(t: Translations): IslandPreset[] {
  const stored = window.localStorage.getItem(SETTINGS_PRESETS_STORAGE_KEY);

  if (!stored) {
    return getDefaultSettingPresets();
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandPreset>[];

    if (!Array.isArray(parsed)) {
      return getDefaultSettingPresets();
    }

    const presets = parsed
      .map((preset, index) => ({
        id:
          typeof preset.id === "string" && preset.id
            ? preset.id
            : createTodoId(),
        name:
          typeof preset.name === "string" && preset.name.trim()
            ? preset.name.trim()
            : t.settings.presets.defaultName(index + 1),
        settings: normalizeSettings(preset.settings),
        createdAt:
          typeof preset.createdAt === "number" ? preset.createdAt : Date.now(),
        isDefault: false,
      }));

    return mergeWithDefaultSettingPresets(presets);
  } catch {
    return getDefaultSettingPresets();
  }
}

function normalizeTodo(todo: Partial<TodoItem>): TodoItem {
  const completed = Boolean(todo.completed);
  return {
    id: typeof todo.id === "string" && todo.id ? todo.id : createTodoId(),
    title: todo.title?.trim() ?? "",
    completed,
    createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
    completedAt:
      completed && typeof todo.completedAt === "number" ? todo.completedAt : null,
    startedAt: typeof todo.startedAt === "number" ? todo.startedAt : null,
    activeSince:
      !completed && typeof todo.activeSince === "number"
        ? todo.activeSince
        : null,
    elapsedMs:
      typeof todo.elapsedMs === "number" && Number.isFinite(todo.elapsedMs)
        ? Math.max(0, todo.elapsedMs)
        : 0,
  };
}

function loadTodos(): TodoItem[] {
  const stored = window.localStorage.getItem(TODOS_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<TodoItem>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((todo) => typeof todo.title === "string" && todo.title.trim())
      .map(normalizeTodo);
  } catch {
    return [];
  }
}

function loadActiveTodoId() {
  return window.localStorage.getItem(ACTIVE_TODO_STORAGE_KEY);
}

function loadMusicSourcePriority(): KnownMediaSource[] {
  try {
    const stored = window.localStorage.getItem(
      MUSIC_SOURCE_PRIORITY_STORAGE_KEY,
    );

    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored) as Partial<KnownMediaSource>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    return parsed
      .filter(
        (source): source is KnownMediaSource =>
          typeof source?.id === "string" &&
          source.id.length > 0 &&
          typeof source.label === "string",
      )
      .filter((source) => {
        if (seen.has(source.id)) {
          return false;
        }
        seen.add(source.id);
        return true;
      })
      .map((source) => ({ id: source.id, label: source.label }));
  } catch {
    return [];
  }
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getDisplayDateParts(date: string, t: Translations) {
  const [fallbackYear = date, fallbackMonth = "", fallbackDay = ""] =
    date.split("-");
  const parsedDate = new Date(`${date}T00:00:00`);
  const hasValidDate = !Number.isNaN(parsedDate.getTime());
  const weekdayFormatter = new Intl.DateTimeFormat(t.localeTag, {
    weekday: "long",
  });

  return {
    year: hasValidDate ? String(parsedDate.getFullYear()) : fallbackYear,
    month: hasValidDate
      ? String(parsedDate.getMonth() + 1).padStart(2, "0")
      : fallbackMonth,
    day: hasValidDate
      ? String(parsedDate.getDate()).padStart(2, "0")
      : fallbackDay,
    weekday: hasValidDate ? weekdayFormatter.format(parsedDate) : "",
  };
}

function loadCurrentTodoDate() {
  return window.localStorage.getItem(TODO_DATE_STORAGE_KEY) ?? getLocalDateString();
}

function loadTodoArchives(): TodoArchive[] {
  const stored = window.localStorage.getItem(TODO_ARCHIVE_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<TodoArchive>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((archive) => typeof archive.date === "string" && archive.date)
      .map((archive) => ({
        date: archive.date ?? getLocalDateString(),
        todos: Array.isArray(archive.todos)
          ? archive.todos
              .filter(
                (todo) => typeof todo.title === "string" && todo.title.trim(),
              )
              .map(normalizeTodo)
          : [],
        dailyNote:
          typeof archive.dailyNote === "string" ? archive.dailyNote : "",
        savedAt: typeof archive.savedAt === "number" ? archive.savedAt : 0,
        savedToDisk: Boolean(archive.savedToDisk),
        filePath:
          typeof archive.filePath === "string" ? archive.filePath : undefined,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function loadSaveDirectory() {
  return window.localStorage.getItem(TODO_SAVE_DIRECTORY_STORAGE_KEY) ?? "";
}

function loadDailyNote() {
  return window.localStorage.getItem(DAILY_NOTE_STORAGE_KEY) ?? "";
}

function loadDiaryEvents(): DiaryEvent[] {
  const stored = window.localStorage.getItem(DIARY_EVENTS_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<DiaryEvent>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (event) =>
          typeof event.id === "string" &&
          typeof event.date === "string" &&
          typeof event.at === "number" &&
          (event.kind === "pet" || event.kind === "todo") &&
          typeof event.text === "string" &&
          event.text.trim(),
      )
      .map((event) => ({
        id: event.id!,
        date: event.date!,
        at: event.at!,
        kind: event.kind as DiaryEvent["kind"],
        text: event.text!.trim(),
      }))
      .slice(-500);
  } catch {
    return [];
  }
}

function getTodoSignature(date: string, todos: TodoItem[], dailyNote: string) {
  return JSON.stringify({
    date,
    todos: todos.map((todo) => ({
      title: todo.title,
      completed: todo.completed,
    })),
    dailyNote,
  });
}

function formatTodosAsMarkdown(todos: TodoItem[]) {
  return todos
    .map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.title}`)
    .join("\n");
}

function formatTodoDocumentAsMarkdown(todos: TodoItem[], dailyNote: string) {
  const todoMarkdown = formatTodosAsMarkdown(todos);
  const dailyMarkdown = dailyNote.trimEnd();

  if (todoMarkdown && dailyMarkdown) {
    return `${todoMarkdown}\n\n${dailyMarkdown}`;
  }

  return todoMarkdown || dailyMarkdown;
}

function createTodoId() {
  if ("crypto" in window && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function IslandShell({
  qqMail,
  qqNotifications,
  wechatReminders,
  onOpenMessages,
  mode,
  page,
  appearanceMode,
  nativeGlassState,
  isTucked,
  isDetached,
  showTitle,
  showCollapsedText,
  collapsedTaskTitle,
  collapsedTodoCount,
  mediaState,
  agentVisualState,
  agentStatusLabel,
  petState,
  onPetAction,
  onPetHoverStart,
  onPetHoverEnd,
  clickSquash,
  mouseInteractions,
  autoRotateExpressions,
  collapsedScale,
  sleepAfterSeconds,
  overlay,
  overlayOpen,
  overlayPlacement,
  onOverlayEnter,
  onOverlayLeave,
  onOverlayClose,
  onOpenPage,
  onWindowDragStart,
  onCollapse,
  onResetPosition,
  onMinimize,
  onReveal,
  onSleepTuck,
  onSleepReveal,
  onPageChange,
  children,
}: IslandShellProps) {
  const t = useTranslation();
  const glassFrameRef = useRef<number | null>(null);
  // 右键小狗 →「固定当前标签到桌面」：把当前页交给 pinned 窗口。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen("maltese-pin-current-page", () => {
      void invoke("pin_page_to_desktop", { page }).catch(() => undefined);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [page]);
  const didDragRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const lastClickAtRef = useRef(0);
  const windowDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const isExpanded = mode === "expanded";

  // 方向键切换顶部标签：上下左右都按顺序前后翻一页（输入框里不拦截）。
  useEffect(() => {
    if (!isExpanded) {
      return;
    }
    const order: IslandPage[] = ["todo", "music", "clipboard", "assistant", "chat", "video"];
    const handler = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      const index = order.indexOf(page);
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const from = index === -1 ? 0 : index;
      onPageChange(order[(from + step + order.length) % order.length]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isExpanded, onPageChange, page]);
  const [isPreparing, setIsPreparing] = useState(isTauri);
  const qqPreview = qqNotifications.preview;
  const qqNotificationCount = qqNotifications.snapshot.items.length;
  const wechatPending = wechatReminders.snapshot.pending;
  const wechatPreviewAt = wechatReminders.previewReceivedAt;
  const [latestPreviewAt, setLatestPreviewAt] = useState(0);
  const preview = latestMessagePreview([
    qqPreview ? { ...qqPreview, source: "qq", receivedAt: qqNotifications.previewReceivedAt ?? 0 } : null,
    wechatPreviewAt !== null ? {
      source: "wechat",
      title: wechatReminders.snapshot.title?.trim() || t.messages.wechat,
      body: wechatReminders.snapshot.body?.trim() || t.messages.newReminder,
      receivedAt: wechatPreviewAt,
    } : null,
    qqMail.preview ? { source: "qqMail", title: qqMail.preview.sender, body: qqMail.preview.subject, receivedAt: qqMail.previewReceivedAt ?? 0 } : null,
  ], latestPreviewAt);
  useEffect(() => {
    if (preview && preview.receivedAt > latestPreviewAt) {
      setLatestPreviewAt(preview.receivedAt);
    }
  }, [latestPreviewAt, preview]);
  const messageBadgeLabel = t.messages.badge(qqNotificationCount, wechatPending);
  const isLiquidGlass = appearanceMode === "liquidGlass";
  const petSlotWidth = Math.max(148, 152 * collapsedScale + 16);
  const petSlotHeight = Math.max(124, 128 * collapsedScale + 16);
  const petCharacter = usePetCharacter();
  const gifRotationConfig = usePetGifRotationConfig(petCharacter);
  const gifRotationStates = usePetGifRotationStates();
  const [petSquash, setPetSquash] = useState(false);
  // 参考 LineDogPet：只有整个系统闲置一段时间才睡觉，用户一动键鼠立刻醒。
  const [systemIdleSeconds, setSystemIdleSeconds] = useState(0);
  const [wakeUntil, setWakeUntil] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let alive = true;
    const poll = () => {
      void invoke<number>("get_system_idle_seconds")
        .then((seconds) => {
          if (alive) setSystemIdleSeconds(Number(seconds) || 0);
        })
        .catch(() => undefined);
      if (alive) setNowTick(Date.now());
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const wakePet = useCallback(() => {
    setWakeUntil(Date.now() + 30_000);
    setSystemIdleSeconds(0);
    setNowTick(Date.now());
  }, []);
  // 只有收起态才进入睡眠缩边。展开面板/聊天时如果仍按系统闲置判断睡眠，
  // 每次打开都会被睡眠 effect 立刻重新缩回去，表现为“点了没反应”。
  const restingAsleep =
    mode === "collapsed" &&
    petState === "idle" &&
    systemIdleSeconds >= sleepAfterSeconds &&
    nowTick > wakeUntil;
  // 主狗按设置页里的顺序轮播当前表情；睡觉/缩边时固定趴睡帧。
  const carouselFrames = rotationFramesForState(
    gifRotationConfig,
    petState,
    gifRotationStates,
    petCharacter,
  );
  const petCarouselSrc = usePetGifRotation(carouselFrames, {
    intervalMs: 10_000,
    enabled:
      autoRotateExpressions && !(petState === "idle" && (restingAsleep || isTucked)),
  });
  // 缩边/睡觉帧默认跟随当前形象（曾经固定用 rest.gif，结果小白睡着会变成小鸡毛）。
  const tuckedGifSrc = useTuckGifSource(
    characterFramesForState(petCharacter, "sleeping")[0] ?? SLEEPING_FRAME,
  );
  const showingTuckedGif = petState === "idle" && (restingAsleep || isTucked);
  // 「趴下睡」的姿势统一用这张图：闲置自动趴下、缩边、手动点「让小狗睡觉」都走它。
  const showingSleepPose = showingTuckedGif || petState === "sleeping";
  // 单击切表情：先固定一张，等自动轮播/状态变化时再交还给轮播。
  const [clickedFrame, setClickedFrame] = useState<string | null>(null);
  const basePetGifSrc = showingSleepPose ? tuckedGifSrc : petCarouselSrc;
  const displayedPetGifSrc = clickedFrame ?? basePetGifSrc;
  // 只让「真正看得见的狗」接收鼠标事件，抠位里的空白处不再误触。
  const petHitBox = usePetHitBox(displayedPetGifSrc);
  const playNextExpression = () => {
    if (carouselFrames.length === 0) return;
    const current = carouselFrames.indexOf(displayedPetGifSrc);
    const next = carouselFrames[(current + 1) % carouselFrames.length];
    setClickedFrame(next);
  };
  useEffect(() => {
    setClickedFrame(null);
  }, [petState, showingSleepPose]);
  // 睡眠缩边与全屏避让共用 isTucked，必须记住“这次是谁缩的边”。
  // 否则全屏避让缩边后会被睡眠逻辑立刻展开，反之亦然，表现为边缘频闪。
  const sleepTuckedRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    if (restingAsleep && !isTucked) {
      sleepTuckedRef.current = true;
      onSleepTuck();
    } else if (!restingAsleep && isTucked && sleepTuckedRef.current) {
      sleepTuckedRef.current = false;
      onSleepReveal();
    }
  }, [isTucked, onSleepReveal, onSleepTuck, restingAsleep]);
  const [panelSide, setPanelSide] = useState<"right" | "left">("right");
  const [panelVertical, setPanelVertical] = useState<"above" | "below">("above");
  const [tuckEdge, setTuckEdge] = useState<"top" | "bottom">("bottom");
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const unlisten = listen<string>("maltese-tuck-edge", (event) => {
      setTuckEdge(event.payload === "top" ? "top" : "bottom");
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);
  // Rust 侧决定云朵面板长在小狗左边还是右边（靠屏幕边缘时自动换边）。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const unlisten = listen<string>("maltese-panel-side", (event) => {
      setPanelSide(event.payload === "left" ? "left" : "right");
    });
    const unlistenVertical = listen<string>("maltese-panel-vertical", (event) => {
      setPanelVertical(event.payload === "below" ? "below" : "above");
    });
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenVertical.then((dispose) => dispose());
    };
  }, []);
  // 收起大小变化时先关掉浮层，避免放大中的窗口和新的槽位尺寸打架。
  // 注意：依赖里不能放 overlay，否则浮层一出现就会立刻被关掉（表现为气泡出不来 / 频闪）。
  const lastScaleRef = useRef(collapsedScale);
  useEffect(() => {
    if (lastScaleRef.current === collapsedScale) {
      return;
    }
    lastScaleRef.current = collapsedScale;
    if (overlayOpen) {
      onOverlayClose();
    }
  }, [collapsedScale, overlayOpen, onOverlayClose]);

  // 方向完全以原生为准（overlayPlacement 由 plan_island_overlay 在放大窗口之前给出）。
  // 之前这里用 window.screenX / screen.availWidth 自己预判，和原生算法不一致时
  // 会把小狗钉到错误的一侧，面板就展开到反方向去了。
  const overlaySide = overlayPlacement?.side ?? panelSide;
  const overlayVertical = overlayPlacement?.vertical ?? panelVertical;
  const className = [
    "island",
    `island--${mode}`,
    `island--${page}`,
    `island--appearance-${appearanceMode}`,
    isPreparing && !isExpanded ? "island--preparing" : "",
    isDetached ? "island--detached" : "island--docked",
    isLiquidGlass ? `island--glass-${nativeGlassState}` : "",
    showTitle ? "" : "island--title-hidden",
    overlayOpen ? "island--overlay-open" : "",
    overlayOpen ? `island--overlay-${overlaySide}` : "",
    overlayOpen && overlayVertical === "below" ? "island--overlay-below" : "",
    mode === "expanded" ? `island--panel-${panelSide}` : "",
    mode === "expanded" && panelVertical === "below" ? "island--panel-below" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const agentStatusIconClassName = [
    "island__agent-status-icon",
    `island__agent-status-icon--${agentVisualState}`,
  ].join(" ");
  const collapsedLabel = showCollapsedText
    ? collapsedTaskTitle
      ? t.messages.collapsedTask(collapsedTaskTitle)
      : collapsedTodoCount !== null
        ? t.island.pendingTodos(collapsedTodoCount)
        : "Maltese"
    : "Maltese";

  useEffect(
    () => () => {
      if (glassFrameRef.current !== null) {
        window.cancelAnimationFrame(glassFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isPreparing) {
      return;
    }
    if (isExpanded) {
      setIsPreparing(false);
      return;
    }

    let didCancel = false;
    let frame: number | null = null;
    let timer: number | null = null;
    // Opacity zero skips rasterization. Give the first panel a brief paint at
    // sub-pixel alpha while it is inert, before the first user-triggered reveal.
    void document.fonts.ready.then(() => {
      if (didCancel) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          timer = window.setTimeout(() => setIsPreparing(false), 180);
        });
      });
    });

    return () => {
      didCancel = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isExpanded, isPreparing]);

  const handleGlassPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        !isLiquidGlass ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        glassFrameRef.current !== null
      ) {
        return;
      }

      const island = event.currentTarget;
      const rect = island.getBoundingClientRect();
      const pointerX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const pointerY = clamp((event.clientY - rect.top) / rect.height, 0, 1);

      glassFrameRef.current = window.requestAnimationFrame(() => {
        glassFrameRef.current = null;
        island.style.setProperty("--glass-pointer-x", `${pointerX * 100}%`);
        island.style.setProperty("--glass-pointer-y", `${pointerY * 100}%`);
      });
    },
    [isLiquidGlass],
  );

  const resetGlassPointer = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!isLiquidGlass) {
        return;
      }

      if (glassFrameRef.current !== null) {
        window.cancelAnimationFrame(glassFrameRef.current);
        glassFrameRef.current = null;
      }

      event.currentTarget.style.setProperty("--glass-pointer-x", "50%");
      event.currentTarget.style.setProperty("--glass-pointer-y", "18%");
    },
    [isLiquidGlass],
  );

  const prepareWindowDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      didDragRef.current = false;
      // 展开（云朵面板）时拖拽会把面板偏移记成小狗位置，只允许收起态拖动。
      // 按住鼠标左键即可拖动；移动阈值在 handleWindowDragMove 里判断，
      // 因而不影响单击摸摸头、双击庆祝和右键聊天。
      if (
        event.button !== 0
        || isTucked
        || mode !== "collapsed"
        || overlayOpen
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "button:not(.island__open-button), input, textarea, select, a, [contenteditable='true'], [data-window-drag='false']",
        )
      ) {
        return;
      }

      windowDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isTucked, mode, overlayOpen],
  );

  const handleWindowDragMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = windowDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || event.buttons !== 1) {
        return;
      }

      if (
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3
      ) {
        return;
      }

      windowDragRef.current = null;
      didDragRef.current = true;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      onWindowDragStart();
    },
    [onWindowDragStart],
  );

  const cancelWindowDrag = useCallback(() => {
    windowDragRef.current = null;
  }, []);

  return (
    <section
      className={className}
      style={{ ["--pet-slot-w" as string]: `${petSlotWidth}px`, ["--pet-slot-h" as string]: `${petSlotHeight}px` } as CSSProperties}
      aria-label={collapsedLabel}
      onClick={(event) => {
        // 浮层打开时窗口比小狗大很多，空白区域不应该触发页面切换。
        if (!isExpanded && !overlayOpen && event.target === event.currentTarget) {
          onOpenPage(page);
        }
      }}
      onPointerMove={handleGlassPointerMove}
      onPointerLeave={resetGlassPointer}
      onMouseEnter={() => {
        if (isTucked) {
          wakePet();
          onReveal();
        }
      }}
    >
      <div className="island__surface">
        {isLiquidGlass && (
          <div className="island__glass" aria-hidden="true">
            <span className="island__glass-refraction" />
            <span className="island__glass-highlight" />
          </div>
        )}
        <div
          className="island__collapsed island__collapsed--pet-only"
        >
          <span
            className={`maltese-pet maltese-pet--large${petSquash ? " maltese-pet--squash" : ""}${isTucked && tuckEdge === "top" ? " maltese-pet--flip" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={collapsedLabel}
            title="单击切换下一张表情，双击打开互动面板，按住左键拖动换位置"
            data-pet-hit-box={`${petHitBox.x},${petHitBox.y},${petHitBox.w},${petHitBox.h}`}
          >
            <span className="maltese-pet__stage">
              <img
                src={displayedPetGifSrc}
                alt=""
                draggable={false}
                className={showingSleepPose ? "maltese-pet__rest" : ""}
                onError={(event) => {
                  // 自定义 GIF 被手动删除时不要让小狗变成破图，退回内置素材。
                  event.currentTarget.src =
                    characterFramesForState(petCharacter, petState)[0] ?? resolvePetGif(petState);
                }}
              />
              {/* 只有这块（GIF 的可见像素范围）接鼠标事件，四周留白不再误触。 */}
              <span
                className="maltese-pet__hit"
                onPointerDown={(event) => {
                wakePet();
                prepareWindowDrag(event);
              }}
              onPointerMove={(event) => {
                handleWindowDragMove(event);
              }}
              onPointerUp={cancelWindowDrag}
              onPointerCancel={cancelWindowDrag}
              onMouseEnter={() => {
                // 鼠标一靠近就醒（LineDogPet 的 wake 行为）
                wakePet();
              }}
              onMouseLeave={onPetHoverEnd}
              onClick={(event) => {
                event.stopPropagation();
                wakePet();
                if (!mouseInteractions || didDragRef.current) {
                  return;
                }
                // 自己按时间间隔判定双击：系统 dblclick 和拖动/指针捕获打架，
                // 这里用两次点击的间隔更可靠，也能在确认双击前不切表情。
                const now = Date.now();
                if (now - lastClickAtRef.current < 320) {
                  lastClickAtRef.current = 0;
                  if (clickTimerRef.current !== null) {
                    window.clearTimeout(clickTimerRef.current);
                    clickTimerRef.current = null;
                  }
                  onPetHoverStart();
                  return;
                }
                lastClickAtRef.current = now;
                if (clickTimerRef.current !== null) {
                  window.clearTimeout(clickTimerRef.current);
                }
                clickTimerRef.current = window.setTimeout(() => {
                  clickTimerRef.current = null;
                  if (clickSquash) {
                    setPetSquash(true);
                    window.setTimeout(() => setPetSquash(false), 240);
                  }
                  playNextExpression();
                }, 340);
              }}
              onDoubleClick={(event) => {
                // 兜底：系统 dblclick 能触发时也走同一个入口（重复调用只会刷新内容，不会反复改窗口）。
                event.stopPropagation();
                if (!mouseInteractions) {
                  return;
                }
                if (clickTimerRef.current !== null) {
                  window.clearTimeout(clickTimerRef.current);
                  clickTimerRef.current = null;
                }
                lastClickAtRef.current = 0;
                onPetHoverStart();
              }}
                onContextMenu={(event) => {
                  // 右键小狗直接打开聊天；配置/隐藏到托盘在任务栏托盘菜单，
                  // 睡觉在鼠标悬停面板，避免再弹一层菜单。
                  event.preventDefault();
                  event.stopPropagation();
                  if (mouseInteractions) {
                    onOpenPage("chat");
                  }
                }}
                style={{
                  left: `${petHitBox.x * 100}%`,
                  top: `${petHitBox.y * 100}%`,
                  width: `${petHitBox.w * 100}%`,
                  height: `${petHitBox.h * 100}%`,
                }}
              />
            </span>
          </span>
        </div>

        {mode === "collapsed" && overlay && (
          <div
            className={`island-overlay island-overlay--${overlay.mode}`}
            onMouseEnter={onOverlayEnter}
            onMouseLeave={onOverlayLeave}
            onContextMenu={(event) => event.stopPropagation()}
          >
            {overlay.mode === "cloud" ? (
              <div className="pet-cloud pet-bubble-cloud" role="status">
                {overlay.title && <strong className="pet-bubble-cloud__title">{overlay.title}</strong>}
                {overlay.image && <img className="pet-bubble-cloud__image" src={overlay.image} alt="" draggable={false} />}
                {overlay.body && <p className="pet-bubble-cloud__body">{overlay.body}</p>}
                <span className="pet-cloud__tail pet-cloud__tail--1" aria-hidden="true" />
                <span className="pet-cloud__tail pet-cloud__tail--2" aria-hidden="true" />
              </div>
            ) : (
              <div className="pet-cloud pet-bubble-panel">
                <div className="pet-bubble-panel__scroll">
                  <div className="pet-bubble-panel__actions" aria-label="和小狗互动">
                    {([
                      ["pet", "🐾 摸头"],
                      ["chin", "😌 挠下巴"],
                      ["pickup", "🤗 抱抱"],
                      ["spin", "🌀 转圈"],
                      ["play", "🎾 陪玩"],
                      ["hide", "🙈 躲猫猫"],
                      ["chase", "🏃 追球"],
                      ["eating", "🍖 喂食"],
                      ["sleeping", "😴 睡觉"],
                    ] as const).map(([action, label]) => (
                      <button key={action} type="button" onClick={() => onPetAction(action)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="pet-bubble-panel__status">
                    <span className="pet-bubble-panel__active-todo">
                      📌 正在做：{overlay.todoTitle ?? "还没有开始待办"}
                    </span>
                    {collapsedTodoCount !== null && <span>📋 待办还剩 {collapsedTodoCount} 个</span>}
                    {mediaState.playbackStatus === "playing" && mediaState.title && (
                      <span>
                        🎵 {mediaState.title}
                        {mediaState.artist ? ` · ${mediaState.artist}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="pet-bubble-panel__links" aria-label="快捷操作">
                    <button type="button" onClick={() => onOpenPage("todo")}>待办</button>
                    <button type="button" onClick={() => onOpenPage("music")}>音乐</button>
                    <button type="button" onClick={() => onOpenPage("clipboard")}>剪贴板</button>
                    <button type="button" onClick={() => onOpenPage("chat")}>聊天</button>
                    <button type="button" onClick={() => onOpenPage("video")}>看视频</button>
                    <button type="button" onClick={() => onOpenPage("qq")}>消息</button>
                    <button type="button" onClick={() => onOpenPage("assistant")}>快捷</button>
                  </div>
                  <button
                    type="button"
                    className="pet-bubble-panel__pin"
                    title="把这个标签页固定在桌面上，随时能看"
                    onClick={() => {
                      void invoke("pin_page_to_desktop", { page }).catch(() => undefined);
                      onOverlayClose();
                    }}
                  >
                    📌 固定「{PAGE_LABELS[page] ?? "当前标签"}」到桌面
                  </button>
                  <button
                    type="button"
                    className="pet-bubble-panel__sleep"
                    onClick={() => onPetAction("sleeping")}
                  >
                    让小狗睡觉
                  </button>
                </div>
                <span className="pet-cloud__tail pet-cloud__tail--1" aria-hidden="true" />
                <span className="pet-cloud__tail pet-cloud__tail--2" aria-hidden="true" />
              </div>
            )}
          </div>
        )}

        <div
          id="island-panel"
          className="island__expanded"
          aria-hidden={!isExpanded}
          inert={!isExpanded}
        >
          <UpdateBanner />
          <header className="island__header">
            <div className="island__title">
              <CircleDot
                className={agentStatusIconClassName}
                size={16}
                strokeWidth={2.2}
                aria-label={agentStatusLabel}
              />
              {showTitle && <span>Maltese</span>}
            </div>

            <nav className="island__tabs" aria-label="Maltese 功能切换">
              <button
                className={`island-tab ${
                  page === "todo" ? "dot-button--active" : ""
                }`}
                type="button"
                title={t.island.todoList}
                aria-label={t.island.todoList}
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("todo");
                }}
              >待办</button>
              <button
                className={`island-tab ${
                  page === "music" ? "dot-button--active" : ""
                }`}
                type="button"
                title={t.island.music}
                aria-label={t.island.music}
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("music");
                }}
              >音乐</button>
              <button
                className={`island-tab ${
                  page === "clipboard" ? "dot-button--active" : ""
                }`}
                type="button"
                title={t.island.clipboardHistory}
                aria-label={t.island.clipboardHistory}
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("clipboard");
                }}
              >剪贴板</button>
              <button
                className={`island-tab ${page === "assistant" ? "dot-button--active" : ""}`}
                type="button"
                title="Maltese 快捷面板"
                aria-label="Maltese 快捷面板"
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("assistant");
                }}
              >快捷入口</button>
              <button
                className={`island-tab ${page === "chat" ? "dot-button--active" : ""}`}
                type="button"
                title={t.chat.title}
                aria-label={t.island.chat}
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("chat");
                }}
              >{t.island.chat}</button>
              <button
                className={`island-tab ${page === "video" ? "dot-button--active" : ""}`}
                type="button"
                title={t.island.plugins}
                aria-label={t.island.plugins}
                onClick={(event) => {
                  event.stopPropagation();
                  onPageChange("video");
                }}
              >{t.island.plugins}</button>
              <button
                className="island-tab"
                type="button"
                title={t.island.layoutEditor}
                aria-label={t.island.layoutEditor}
                onClick={(event) => {
                  event.stopPropagation();
                  void invoke("open_settings_window").catch(() => onPageChange("layout"));
                }}
              >设置</button>
            </nav>

            <button
              className="island__collapse-target"
              type="button"
              aria-label={t.island.collapseIsland}
              title={t.island.collapseIsland}
              data-window-drag="false"
              onClick={(event) => {
                event.stopPropagation();
                onCollapse();
              }}
            >
              <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
              <span>收起</span>
            </button>

            <div className="window-actions">
              <button
                className="icon-button island-pin-button"
                type="button"
                title={`把「${PAGE_LABELS[page] ?? "当前标签"}」固定到桌面`}
                aria-label="固定当前标签到桌面"
                onClick={(event) => {
                  event.stopPropagation();
                  void invoke("pin_page_to_desktop", { page }).catch(() => undefined);
                }}
              >
                <Pin size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <button className={`icon-button island-message-button${page === "qq" ? " island-message-button--active" : ""}`} type="button" aria-label={t.messages.label(messageBadgeLabel)} aria-pressed={page === "qq"} title={t.messages.title} onClick={() => onOpenMessages(wechatPending ? "wechat" : "qq")}>
                <Bell size={17} strokeWidth={1.8} />
                {(qqNotificationCount > 0 || wechatPending) && <span className="island-message-button__dot" aria-hidden="true" />}
              </button>
              <button
                className={`icon-button island-reset-button${
                  isDetached ? " island-reset-button--available" : ""
                }`}
                type="button"
                title={t.island.resetPositionLabel}
                aria-label={t.island.resetPositionLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onResetPosition();
                }}
              >
                <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                type="button"
                title={t.island.minimizeToTray}
                aria-label={t.island.minimizeToTray}
                onClick={(event) => {
                  event.stopPropagation();
                  onMinimize();
                }}
              >
                <Minus size={18} strokeWidth={2.2} />
              </button>
            </div>
          </header>
          <div className="island__content">{children}</div>
        </div>
      </div>
    </section>
  );
}

function LayoutEditor({
  locale,
  settings,
  qqNotifications,
  wechatReminders,
  clipboardSettings,
  saveDirectoryDraft,
  savePathState,
  highlightSavePath,
  presets,
  launchAtStartup,
  agentStatus,
  clearingAgentProvider,
  agentHooksInstallState,
  agentHooksInstallResult,
  agentHooksInstallError,
  onLocaleChange,
  onSettingsChange,
  onClipboardSettingsChange,
  onReset,
  onSaveDirectoryDraftChange,
  onSaveDirectory,
  onSavePreset,
  onApplyPreset,
  onRenamePreset,
  onDeletePreset,
  onLaunchAtStartupChange,
  onClearAgentStatus,
  onInstallAgentHooks,
}: {
  locale: LocaleCode;
  settings: IslandSettings;
  qqNotifications: QQNotificationsController;
  wechatReminders: WeChatRemindersController;
  clipboardSettings: ClipboardHistorySettings;
  saveDirectoryDraft: string;
  savePathState: SavePathState;
  highlightSavePath: boolean;
  presets: IslandPreset[];
  launchAtStartup: boolean;
  agentStatus: AgentStatusSnapshot;
  clearingAgentProvider: AgentProvider | null;
  agentHooksInstallState: AgentHooksInstallState;
  agentHooksInstallResult: AgentHooksInstallResult | null;
  agentHooksInstallError: string;
  onLocaleChange: (locale: LocaleCode) => void;
  onSettingsChange: (settings: IslandSettings) => void;
  onClipboardSettingsChange: (settings: ClipboardHistorySettings) => void;
  onReset: () => void;
  onSaveDirectoryDraftChange: (value: string) => void;
  onSaveDirectory: () => void;
  onSavePreset: () => void;
  onApplyPreset: (presetId: string) => void;
  onRenamePreset: (presetId: string, name: string) => void;
  onDeletePreset: (presetId: string) => void;
  onLaunchAtStartupChange: (enabled: boolean) => void;
  onClearAgentStatus: (provider: AgentProvider) => void;
  onInstallAgentHooks: () => void;
}) {
  const t = useTranslation();
  const savePathPanelRef = useRef<HTMLElement | null>(null);
  const savePathInputRef = useRef<HTMLInputElement | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [projectLinkFailed, setProjectLinkFailed] = useState(false);

  const openProjectLink = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) {
      return;
    }

    event.preventDefault();
    const url = event.currentTarget.href;
    setProjectLinkFailed(false);

    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open project link", error);
      setProjectLinkFailed(true);
    }
  };

  const startPresetRename = useCallback((preset: IslandPreset) => {
    setEditingPresetId(preset.id);
    setPresetNameDraft(preset.name);
  }, []);

  const commitPresetRename = useCallback(() => {
    if (!editingPresetId) {
      return;
    }

    onRenamePreset(editingPresetId, presetNameDraft);
    setEditingPresetId(null);
    setPresetNameDraft("");
  }, [editingPresetId, onRenamePreset, presetNameDraft]);

  useEffect(() => {
    if (!highlightSavePath) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const editorPanel = savePathPanelRef.current?.closest(".editor-panel");

      if (editorPanel instanceof HTMLElement && savePathPanelRef.current) {
        editorPanel.scrollTo({
          top: savePathPanelRef.current.offsetTop - 12,
          behavior: "smooth",
        });
      }

      savePathInputRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [highlightSavePath]);

  const petCharacter = usePetCharacter();
  const agentStatusRows = AGENT_PROVIDERS.map((provider) => {
    const status = agentStatus[provider];
    return {
      provider,
      label: AGENT_PROVIDER_LABELS[provider],
      phase: status.phase,
      phaseLabel: getAgentPhaseLabel(status.phase, t),
      needsAttention: isAgentAttentionPhase(status.phase),
    };
  });
  const agentStatusLabel = getAgentStatusLabel(agentStatus, t);

  return (
    <div className="editor-panel">
      <div className="editor-panel__header">
        <span>{t.settings.title}</span>
        <button
          className="reset-button"
          type="button"
          title={t.settings.reset}
          aria-label={t.settings.reset}
          onClick={onReset}
        >
          <RefreshCcw size={15} strokeWidth={2.2} />
        </button>
      </div>

      <section className="settings-section settings-section--language">
        <div className="settings-section__header">
          <span>{t.settings.language.title}</span>
        </div>
        <LocaleControl
          label={t.settings.language.label}
          value={locale}
          onChange={onLocaleChange}
        />
      </section>

      <section className="settings-section settings-section--layout">
        <div className="settings-section__header">
          <span>{t.settings.layout.title}</span>
        </div>
        <AppearanceModeControl
          value={settings.appearanceMode}
          onChange={(appearanceMode) =>
            onSettingsChange({ ...settings, appearanceMode })
          }
        />
        <div className="appearance-mode-control">
          <span>{t.settings.appearance.font}</span>
          <div className="appearance-mode-control__segments" role="group" aria-label={t.settings.appearance.fontLabel}>
            {([["system", t.settings.appearance.systemFont], ["pixel", t.settings.appearance.pixelFont]] as const).map(([fontFamily, label]) => (
              <button
                key={fontFamily}
                className={settings.fontFamily === fontFamily ? "appearance-mode-control--active" : ""}
                type="button"
                aria-pressed={settings.fontFamily === fontFamily}
                onClick={() => onSettingsChange({ ...settings, fontFamily })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {settings.appearanceMode === "liquidGlass" && (
          <SliderControl
            label={t.settings.appearance.glassStrength}
            value={settings.glassIntensity}
            min={25}
            max={100}
            step={1}
            suffix="%"
            onChange={(glassIntensity) =>
              onSettingsChange({ ...settings, glassIntensity })
            }
          />
        )}
        <SliderControl
          label={t.settings.layout.opacity}
          value={settings.opacity}
          min={50}
          max={100}
          step={1}
          suffix="%"
          onChange={(opacity) => onSettingsChange({ ...settings, opacity })}
        />
        <SliderControl
          label="小狗不透明度"
          value={settings.petOpacity}
          min={30}
          max={100}
          step={1}
          suffix="%"
          onChange={(petOpacity) => onSettingsChange({ ...settings, petOpacity })}
        />
        <SliderControl
          label={t.settings.layout.collapsedScale}
          value={settings.collapsedScale}
          min={0.5}
          max={1.8}
          step={0.01}
          suffix="x"
          onChange={(collapsedScale) => onSettingsChange({ ...settings, collapsedScale })}
        />
        <SliderControl
          label={t.settings.layout.expandedScale}
          value={settings.expandedScale}
          min={0.5}
          max={1.8}
          step={0.01}
          suffix="x"
          onChange={(expandedScale) => onSettingsChange({ ...settings, expandedScale })}
        />
        <SliderControl
          label="聊天框高度"
          value={settings.chatPanelHeight}
          min={360}
          max={900}
          step={10}
          suffix="px"
          onChange={(chatPanelHeight) => onSettingsChange({ ...settings, chatPanelHeight })}
        />
        <SliderControl
          label={t.settings.layout.marginY}
          value={settings.marginY}
          min={0}
          max={160}
          step={1}
          suffix="px"
          onChange={(marginY) => onSettingsChange({ ...settings, marginY })}
        />
        <SliderControl
          label={t.settings.layout.tuckedVisibleHeight}
          value={settings.tuckedVisibleHeight}
          min={24}
          max={140}
          step={1}
          suffix="px"
          onChange={(tuckedVisibleHeight) =>
            onSettingsChange({ ...settings, tuckedVisibleHeight })
          }
        />
        <ToggleControl
          label={t.settings.layout.launchAtStartup}
          checked={launchAtStartup}
          onChange={onLaunchAtStartupChange}
        />
        <ToggleControl
          label={t.settings.layout.showCollapsedText}
          checked={settings.showCollapsedText}
          onChange={(showCollapsedText) =>
            onSettingsChange({ ...settings, showCollapsedText })
          }
        />
        <ToggleControl
          label={t.settings.layout.showIdleTodoCount}
          checked={settings.showIdleTodoCount}
          onChange={(showIdleTodoCount) =>
            onSettingsChange({ ...settings, showIdleTodoCount })
          }
        />
        <ToggleControl
          label={t.settings.layout.showTitle}
          checked={settings.showTitle}
          onChange={(showTitle) => onSettingsChange({ ...settings, showTitle })}
        />
        <ToggleControl
          label={t.settings.layout.autoTuck}
          checked={settings.autoTuck}
          onChange={(autoTuck) => onSettingsChange({ ...settings, autoTuck })}
        />
        {settings.autoTuck && (
          <NumberControl
            label={t.settings.layout.autoTuckSeconds}
            value={settings.autoTuckSeconds}
            min={1}
            max={3_600}
            onChange={(autoTuckSeconds) => onSettingsChange({ ...settings, autoTuckSeconds })}
          />
        )}
        <div className="appearance-mode-control">
          <span>{t.settings.layout.fullscreenAvoid}</span>
          <div className="appearance-mode-control__segments" role="group">
            <button
              className={settings.fullscreenAvoid === "tuck" ? "appearance-mode-control--active" : ""}
              type="button"
              aria-pressed={settings.fullscreenAvoid === "tuck"}
              onClick={() => onSettingsChange({ ...settings, fullscreenAvoid: "tuck" })}
            >
              {t.settings.layout.fullscreenAvoidTuck}
            </button>
            <button
              className={settings.fullscreenAvoid === "hide" ? "appearance-mode-control--active" : ""}
              type="button"
              aria-pressed={settings.fullscreenAvoid === "hide"}
              onClick={() => onSettingsChange({ ...settings, fullscreenAvoid: "hide" })}
            >
              {t.settings.layout.fullscreenAvoidHide}
            </button>
            <button
              className={settings.fullscreenAvoid === "off" ? "appearance-mode-control--active" : ""}
              type="button"
              aria-pressed={settings.fullscreenAvoid === "off"}
              onClick={() => onSettingsChange({ ...settings, fullscreenAvoid: "off" })}
            >
              {t.settings.layout.fullscreenAvoidOff}
            </button>
          </div>
        </div>
        {settings.fullscreenAvoid !== "off" && (
          <ToggleControl
            label="全屏时连 Bongo 一起隐藏"
            checked={settings.fullscreenHideExtras}
            onChange={(fullscreenHideExtras) => onSettingsChange({ ...settings, fullscreenHideExtras })}
          />
        )}
      </section>

      <section className="settings-section settings-section--pet-bubble">
        <div className="settings-section__header">
          <span>小狗气泡与动画</span>
        </div>
        <div className="appearance-mode-control">
          <span>动画流畅度</span>
          <div className="appearance-mode-control__segments" role="group" aria-label="动画流畅度">
            {([
              ["smooth", "流畅"],
              ["balanced", "均衡"],
              ["normal", "普通"],
              ["saver", "省电"],
            ] as const).map(([fpsMode, label]) => (
              <button
                key={fpsMode}
                className={settings.fpsMode === fpsMode ? "appearance-mode-control--active" : ""}
                type="button"
                aria-pressed={settings.fpsMode === fpsMode}
                onClick={() => onSettingsChange({ ...settings, fpsMode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ToggleControl
          label="点击时 Q 弹反馈"
          checked={settings.clickSquash}
          onChange={(clickSquash) => onSettingsChange({ ...settings, clickSquash })}
        />
        <ToggleControl
          label="消息/动作显示云朵气泡"
          checked={settings.bubbleOn}
          onChange={(bubbleOn) => onSettingsChange({ ...settings, bubbleOn })}
        />
        {settings.bubbleOn && (
          <NumberControl
            label="气泡停留时长（毫秒）"
            value={settings.bubbleDurationMs}
            min={1500}
            max={30000}
            onChange={(bubbleDurationMs) => onSettingsChange({ ...settings, bubbleDurationMs })}
          />
        )}
        {settings.bubbleOn && (
          <ToggleControl
            label="剪贴板新增内容用气泡提醒"
            checked={settings.clipboardBubble}
            onChange={(clipboardBubble) => onSettingsChange({ ...settings, clipboardBubble })}
          />
        )}
        <div className="appearance-mode-control">
          <span>气泡文字颜色</span>
          <input
            className="pet-color-input"
            type="color"
            value={settings.bubbleTextColor}
            aria-label="气泡文字颜色"
            onChange={(event) => onSettingsChange({ ...settings, bubbleTextColor: event.currentTarget.value })}
          />
        </div>
        <ToggleControl
          label="开启音效（摸头/互动时轻轻哼一声）"
          checked={settings.soundOn}
          onChange={(soundOn) => onSettingsChange({ ...settings, soundOn })}
        />
        <CustomSoundControl />
        <ToggleControl
          label="整点轻轻叫一声"
          checked={settings.hourlyChime}
          onChange={(hourlyChime) => onSettingsChange({ ...settings, hourlyChime })}
        />
        <ToggleControl
          label="开启鼠标交互（点击摸头 / 拖拽抱起）"
          checked={settings.mouseInteractions}
          onChange={(mouseInteractions) => onSettingsChange({ ...settings, mouseInteractions })}
        />
        <ToggleControl
          label="收起动画上下翻转显示"
          checked={settings.petFlipY}
          onChange={(petFlipY) => onSettingsChange({ ...settings, petFlipY })}
        />
        <div className="appearance-mode-control">
          <span>复位位置</span>
          <div className="appearance-mode-control__segments" role="group" aria-label="复位位置">
            {([
              ["", "底部居中"],
              ["tl", "左上"],
              ["tr", "右上"],
              ["bl", "左下"],
              ["br", "右下"],
            ] as const).map(([lockCorner, label]) => (
              <button
                key={label}
                className={settings.lockCorner === lockCorner ? "appearance-mode-control--active" : ""}
                type="button"
                aria-pressed={settings.lockCorner === lockCorner}
                onClick={() => onSettingsChange({ ...settings, lockCorner })}
              >
                {label}
              </button>
            ))}
          </div>
          <small className="settings-section__hint">
            选四角会立即把桌宠放到对应角落；点「复位」也会回到这里。
          </small>
        </div>
      </section>

      <section className="settings-section settings-section--desktop-pets">
        <div className="settings-section__header">
          <span>桌宠形态</span>
        </div>
        <div className="appearance-mode-control">
          <span>小狗形象</span>
          <div className="appearance-mode-control__segments" role="group" aria-label="小狗形象">
            {PET_CHARACTERS.map((character) => (
              <button
                key={character.id}
                className={petCharacter === character.id ? "appearance-mode-control--active" : ""}
                type="button"
                aria-pressed={petCharacter === character.id}
                title={character.hintZh}
                onClick={() => savePetCharacter(character.id)}
              >
                {character.zh}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-section__hint">
          陪玩狗、Bongo 模式和鼠标跟随宠会使用独立的透明小窗口，不会挡住桌面点击。
        </p>
        <SliderControl
          label="小狗数量（含主狗）"
          value={settings.petCount}
          min={1}
          max={5}
          step={1}
          suffix="只"
          onChange={(petCount) => onSettingsChange({ ...settings, petCount })}
        />
        <ToggleControl
          label="Bongo 模式（小狗趴在键盘上，跟着按键动）"
          checked={settings.bongoEnabled}
          onChange={(bongoEnabled) => onSettingsChange({ ...settings, bongoEnabled })}
        />
        {settings.bongoEnabled && (
          <>
            <SliderControl
              label="Bongo 大小"
              value={settings.bongoSize}
              min={220}
              max={700}
              step={10}
              suffix="px"
              onChange={(bongoSize) => onSettingsChange({ ...settings, bongoSize })}
            />
            <SliderControl
              label="Bongo 不透明度"
              value={settings.bongoOpacity}
              min={30}
              max={100}
              step={1}
              suffix="%"
              onChange={(bongoOpacity) => onSettingsChange({ ...settings, bongoOpacity })}
            />
            <ToggleControl
              label="水平镜像（让素材朝向和真实键盘一致）"
              checked={settings.bongoMirror}
              onChange={(bongoMirror) => onSettingsChange({ ...settings, bongoMirror })}
            />
            <ToggleControl
              label="鼠标穿透 Bongo（只能看，不能拖动）"
              checked={settings.bongoClickThrough}
              onChange={(bongoClickThrough) => onSettingsChange({ ...settings, bongoClickThrough })}
            />
            <div className="appearance-mode-control">
              <span>Bongo 默认位置</span>
              <div className="appearance-mode-control__segments" role="group" aria-label="Bongo 默认位置">
                {([
                  ["bottomCenter", "底部居中"],
                  ["bottomLeft", "左下"],
                  ["bottomRight", "右下"],
                  ["topCenter", "顶部居中"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={settings.bongoPosition === value}
                    className={settings.bongoPosition === value ? "appearance-mode-control--active" : ""}
                    onClick={() => onSettingsChange({ ...settings, bongoPosition: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        <ToggleControl
          label="跟随鼠标（在光标旁显示一只小尺寸小狗）"
          checked={settings.followMouse}
          onChange={(followMouse) => onSettingsChange({ ...settings, followMouse })}
        />
        {settings.followMouse && (
          <SliderControl
            label="跟随宠大小"
            value={settings.cursorPetSize}
            min={30}
            max={180}
            step={1}
            suffix="px"
            onChange={(cursorPetSize) => onSettingsChange({ ...settings, cursorPetSize })}
          />
        )}
      </section>

      <section className="settings-section settings-section--messages">
        <div className="settings-section__header"><span>{t.settings.messageReception}</span></div>
        <QQNotificationControls controller={qqNotifications} />
        <WeChatReminderControls controller={wechatReminders} />
      </section>

      <section className="settings-section settings-section--companion">
        <div className="settings-section__header">
          <span>感知与陪伴</span>
        </div>
        <p className="settings-section__hint">
          全部在本地完成，不截图、不联网。只读取前台窗口的进程名，用来决定说哪句陪你。
        </p>
        <ToggleControl
          label="偷偷观察你（写代码 / 写文档 / 开会 / 看视频时陪你说一句）"
          checked={settings.observeApps}
          onChange={(observeApps) => onSettingsChange({ ...settings, observeApps })}
        />
        <ToggleControl
          label="时间感知（早上 / 中午 / 晚上不同的问候）"
          checked={settings.senseTime}
          onChange={(senseTime) => onSettingsChange({ ...settings, senseTime })}
        />
        <ToggleControl
          label="夜间陪伴（23 点后提醒你早点休息）"
          checked={settings.nightCompanion}
          onChange={(nightCompanion) => onSettingsChange({ ...settings, nightCompanion })}
        />
        <ToggleControl
          label="听歌互动（切歌时说一句正在听的歌）"
          checked={settings.musicChat}
          onChange={(musicChat) => onSettingsChange({ ...settings, musicChat })}
        />
        <ToggleControl
          label="自动切换表情（关闭后单张 GIF 保持不动）"
          checked={settings.autoRotateExpressions}
          onChange={(autoRotateExpressions) => onSettingsChange({ ...settings, autoRotateExpressions })}
        />
        <ToggleControl
          label="根据行为弹出气泡（前台程序 / 时间 / 音乐 / 剪贴板 / 整点）"
          checked={settings.proactiveBubbles}
          onChange={(proactiveBubbles) => onSettingsChange({ ...settings, proactiveBubbles })}
        />
        <ToggleControl
          label="让模型观察并主动找你聊天（本机模型 / DSH）"
          checked={settings.proactiveChat}
          onChange={(proactiveChat) => onSettingsChange({ ...settings, proactiveChat })}
        />
        {settings.proactiveChat && (
          <div className="appearance-mode-control">
            <span>主动聊天自测</span>
            <div className="appearance-mode-control__segments">
              <button
                type="button"
                onClick={() => {
                  // 手动触发一次：先收起面板，回到挂机态才能弹云朵气泡。
                  window.dispatchEvent(new Event("maltese-collapse-panel"));
                  window.setTimeout(() => {
                    window.dispatchEvent(new Event("maltese-proactive-chat-now"));
                  }, 600);
                }}
              >
                立即试一句
              </button>
            </div>
          </div>
        )}
        {settings.proactiveChat && (
          <>
            <div className="appearance-mode-control">
              <span>主动聊天方式</span>
              <div className="appearance-mode-control__segments" role="group" aria-label="主动聊天方式">
                <button
                  type="button"
                  className={settings.proactiveChatMode === "interval" ? "appearance-mode-control--active" : ""}
                  aria-pressed={settings.proactiveChatMode === "interval"}
                  onClick={() => onSettingsChange({ ...settings, proactiveChatMode: "interval" })}
                >
                  定时
                </button>
                <button
                  type="button"
                  className={settings.proactiveChatMode === "state" ? "appearance-mode-control--active" : ""}
                  aria-pressed={settings.proactiveChatMode === "state"}
                  onClick={() => onSettingsChange({ ...settings, proactiveChatMode: "state" })}
                >
                  跟随状态
                </button>
              </div>
            </div>
            <SliderControl
              label="主动程度"
              value={settings.proactiveLevel}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(proactiveLevel) => {
                saveProactiveLevel(proactiveLevel);
                onSettingsChange({ ...settings, proactiveLevel });
              }}
            />
            <p className="settings-hint">
              {settings.proactiveLevel === 0
                ? "0% —— 小狗不会主动开口，只在被叫到时说话。"
                : `${settings.proactiveLevel}% —— ${describeProactivePlan(proactivePlan(settings.proactiveLevel))}`}
            </p>
          </>
        )}
        <SliderControl
          label="多久没动静就趴下睡"
          value={settings.sleepAfterSeconds}
          min={30}
          max={900}
          step={15}
          suffix="s"
          onChange={(sleepAfterSeconds) => onSettingsChange({ ...settings, sleepAfterSeconds })}
        />
        <TuckGifControl />
      </section>

      <section className="settings-section settings-section--todo">
        <div className="settings-section__header">
          <span>{t.settings.todo.title}</span>
        </div>
        <ToggleControl
          label={t.settings.todo.rotateTodos}
          checked={settings.rotateTodos}
          onChange={(rotateTodos) => onSettingsChange({ ...settings, rotateTodos })}
        />
        {settings.rotateTodos && (
          <NumberControl
            label={t.settings.todo.rotationSeconds}
            value={settings.todoRotationSeconds}
            min={1}
            max={3_600}
            onChange={(todoRotationSeconds) => onSettingsChange({ ...settings, todoRotationSeconds })}
          />
        )}
        <NumberControl
          label={t.settings.todo.reminderMinutes}
          value={settings.todoReminderMinutes}
          min={1}
          max={180}
          onChange={(todoReminderMinutes) => onSettingsChange({ ...settings, todoReminderMinutes })}
        />
      </section>

      <section className="settings-section settings-section--agent-hooks">
        <div className="settings-section__header">
          <span>{t.settings.agent.title}</span>
          <button
            className={[
              "agent-hooks-button",
              agentHooksInstallState === "installed"
                ? "agent-hooks-button--installed"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            disabled={agentHooksInstallState === "installing"}
            onClick={onInstallAgentHooks}
          >
            {agentHooksInstallState === "installed" ? (
              <Check size={13} strokeWidth={2.6} />
            ) : (
              <RefreshCcw size={13} strokeWidth={2.4} />
            )}
            <span>
              {agentHooksInstallState === "installing"
                ? t.settings.agent.installing
                : agentHooksInstallState === "installed"
                  ? t.settings.agent.installed
                  : t.settings.agent.install}
            </span>
          </button>
        </div>
        <div
          className={[
            "agent-status-panel",
            `agent-status-panel--${getAgentVisualState(agentStatus)}`,
          ].join(" ")}
        >
          <div className="agent-status-panel__summary">
            <span>{t.settings.agent.currentStatus}</span>
            <strong>{agentStatusLabel}</strong>
          </div>
          <div className="agent-status-panel__rows">
            {agentStatusRows.map((row) => (
              <div
                className={[
                  "agent-status-row",
                  row.needsAttention ? "agent-status-row--attention" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={row.provider}
              >
                <span>{row.label}</span>
                <strong>{row.phaseLabel}</strong>
                {row.needsAttention ? (
                  <button
                    className="agent-status-clear-button"
                    type="button"
                    disabled={clearingAgentProvider === row.provider}
                    title={t.settings.agent.clearStatusFor(row.label)}
                    aria-label={t.settings.agent.clearStatusFor(row.label)}
                    onClick={() => onClearAgentStatus(row.provider)}
                  >
                    <X size={12} strokeWidth={2.4} />
                    <span>
                      {clearingAgentProvider === row.provider
                        ? t.settings.agent.clearing
                        : t.settings.agent.clearStatus}
                    </span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        {agentHooksInstallState === "installed" && agentHooksInstallResult ? (
          <div className="agent-hooks-status agent-hooks-status--ok">
            <span>{t.settings.agent.scriptsDir}</span>
            <strong title={agentHooksInstallResult.scriptsDir}>
              {agentHooksInstallResult.scriptsDir}
            </strong>
          </div>
        ) : null}
        {agentHooksInstallState === "error" ? (
          <div className="agent-hooks-status agent-hooks-status--error">
            {agentHooksInstallError}
          </div>
        ) : null}
      </section>

      <section className="settings-section settings-section--clipboard">
        <div className="settings-section__header">
          <span>{t.settings.clipboard.title}</span>
        </div>
        <ToggleControl
          label={t.settings.clipboard.enabled}
          checked={clipboardSettings.enabled}
          onChange={(enabled) =>
            onClipboardSettingsChange({ ...clipboardSettings, enabled })
          }
        />
        <ToggleControl
          label={t.settings.clipboard.captureImages}
          checked={clipboardSettings.captureImages}
          onChange={(captureImages) =>
            onClipboardSettingsChange({ ...clipboardSettings, captureImages })
          }
        />
        <NumberControl
          label={t.settings.clipboard.maxItems}
          value={clipboardSettings.maxItems}
          min={5}
          max={200}
          onChange={(maxItems) =>
            onClipboardSettingsChange({ ...clipboardSettings, maxItems })
          }
        />
      </section>

      <section className="settings-section settings-section--colors">
        <div className="settings-section__header">
          <span>{t.settings.colors.title}</span>
        </div>
        <div className="color-grid">
          <ColorControl
            label={t.settings.colors.taskText}
            value={settings.taskTextColor}
            onChange={(taskTextColor) =>
              onSettingsChange({ ...settings, taskTextColor })
            }
          />
          <ColorControl
            label={t.settings.colors.pulse}
            value={settings.pulseColor}
            onChange={(pulseColor) =>
              onSettingsChange({ ...settings, pulseColor })
            }
          />
          <ColorControl
            label={t.settings.colors.islandBackground}
            value={settings.islandBackgroundColor}
            onChange={(islandBackgroundColor) =>
              onSettingsChange({ ...settings, islandBackgroundColor })
            }
          />
          <ColorControl
            label={t.settings.colors.todoPaper}
            value={settings.todoBackgroundColor}
            onChange={(todoBackgroundColor) =>
              onSettingsChange({ ...settings, todoBackgroundColor })
            }
          />
        </div>
        <SliderControl
          label={t.settings.colors.pulseBrightness}
          value={settings.pulseBrightness}
          min={50}
          max={160}
          step={1}
          suffix="%"
          onChange={(pulseBrightness) =>
            onSettingsChange({ ...settings, pulseBrightness })
          }
        />
      </section>

      <section className="settings-section settings-section--presets">
        <div className="settings-section__header">
          <span>{t.settings.presets.title}</span>
          <button
            className="preset-save-button"
            type="button"
            onClick={onSavePreset}
          >
            <Save size={13} strokeWidth={2.2} />
            <span>{t.settings.presets.saveCurrent}</span>
          </button>
        </div>
        {presets.length === 0 ? (
          <div className="preset-empty">{t.settings.presets.empty}</div>
        ) : (
          <div className="preset-list" role="list">
            {presets.map((preset) => (
              <div
                className={[
                  "preset-item",
                  preset.isDefault ? "preset-item--default" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={preset.id}
                role="listitem"
              >
                {editingPresetId === preset.id ? (
                  <input
                    className="preset-name-input"
                    value={presetNameDraft}
                    aria-label={t.settings.presets.nameLabel}
                    autoFocus
                    onChange={(event) =>
                      setPresetNameDraft(event.currentTarget.value)
                    }
                    onBlur={commitPresetRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitPresetRename();
                      }

                      if (event.key === "Escape") {
                        setEditingPresetId(null);
                        setPresetNameDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    className="preset-name-button"
                    type="button"
                    title={
                      preset.isDefault
                        ? t.settings.presets.defaultPreset
                        : t.settings.presets.rename
                    }
                    disabled={preset.isDefault}
                    onClick={() => {
                      if (!preset.isDefault) {
                        startPresetRename(preset);
                      }
                    }}
                  >
                    {preset.name}
                  </button>
                )}
                <button
                  className="preset-apply-button"
                  type="button"
                  onClick={() => onApplyPreset(preset.id)}
                >
                  {t.settings.presets.apply}
                </button>
                {preset.isDefault ? (
                  <span className="preset-delete-spacer" aria-hidden="true" />
                ) : (
                  <button
                    className="preset-delete-button"
                    type="button"
                    title={t.settings.presets.delete}
                    aria-label={t.settings.presets.deleteNamed(preset.name)}
                    onClick={() => onDeletePreset(preset.id)}
                  >
                    <Trash2 size={13} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        className={[
          "settings-section",
          "settings-section--storage",
          "save-path-panel",
          highlightSavePath ? "save-path-panel--attention" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ref={savePathPanelRef}
      >
        <div className="settings-section__header save-path-panel__header">
          <span>{t.settings.save.title}</span>
        </div>
        <div className="save-path-row">
          <label className="save-path-field">
            <span>{t.settings.save.folder}</span>
            <input
              ref={savePathInputRef}
              value={saveDirectoryDraft}
              placeholder={t.settings.save.folderPlaceholder}
              aria-label={t.settings.save.folderLabel}
              onChange={(event) =>
                onSaveDirectoryDraftChange(event.currentTarget.value)
              }
            />
          </label>
          <button
            className={[
              "save-path-button",
              savePathState === "saved" ? "save-path-button--saved" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={onSaveDirectory}
          >
            {savePathState === "saved" ? (
              <>
                <Check className="save-check-icon" size={15} strokeWidth={2.6} />
                <span>{t.settings.save.saved}</span>
              </>
            ) : (
              <>
                <Save size={14} strokeWidth={2.2} />
                <span>{t.settings.save.save}</span>
              </>
            )}
          </button>
        </div>
      </section>

      <section className="settings-section settings-section--project">
        <div className="settings-section__header">
          <span>{t.settings.project.title}</span>
        </div>
        <UpdatePanel />
        <a
          className="project-link project-link--star"
          href="https://github.com/flyl1u/fly-island"
          target="_blank"
          rel="noopener noreferrer"
          onClick={openProjectLink}
        >
          <Star className="project-link__icon" size={19} strokeWidth={1.8} aria-hidden="true" />
          <span className="project-link__copy">
            <strong>{t.settings.project.star}</strong>
            <span>{t.settings.project.starHint}</span>
          </span>
          <ExternalLink className="project-link__arrow" size={14} aria-hidden="true" />
        </a>
        {projectLinkFailed && (
          <p className="project-link-error" role="alert">{t.settings.project.openFailed}</p>
        )}
      </section>
    </div>
  );
}

function TodoNotebook({
  todos,
  dailyNote,
  diaryEvents,
  draft,
  activeTodoId,
  currentDate,
  pageMode,
  archives,
  archiveLayout,
  selectedArchive,
  saveState,
  onDraftChange,
  onAddTodo,
  onToggleTodo,
  onUpdateTodo,
  onStartTodo,
  onDeleteTodo,
  onReorderTodo,
  onSaveToday,
  onShowArchive,
  onShowDaily,
  onShowToday,
  onDailyNoteChange,
  onArchiveLayoutChange,
  onSelectArchive,
}: {
  todos: TodoItem[];
  dailyNote: string;
  diaryEvents: DiaryEvent[];
  draft: string;
  activeTodoId: string | null;
  currentDate: string;
  pageMode: TodoPageMode;
  archives: TodoArchive[];
  archiveLayout: ArchiveLayout;
  selectedArchive: TodoArchive | null;
  saveState: SaveState;
  onDraftChange: (value: string) => void;
  onAddTodo: () => void;
  onToggleTodo: (id: string) => void;
  onUpdateTodo: (id: string, title: string) => void;
  onStartTodo: (id: string) => void;
  onDeleteTodo: (id: string) => void;
  onReorderTodo: (sourceId: string, targetId: string) => void;
  onSaveToday: () => void;
  onShowArchive: () => void;
  onShowDaily: () => void;
  onShowToday: () => void;
  onDailyNoteChange: (value: string) => void;
  onArchiveLayoutChange: (layout: ArchiveLayout) => void;
  onSelectArchive: (date: string) => void;
}) {
  const t = useTranslation();
  const displayedTodos =
    pageMode === "review" ? selectedArchive?.todos ?? [] : todos;
  const isTodayMode = pageMode === "today";
  const isDailyMode = pageMode === "daily";
  const isArchiveMode = pageMode === "archive";
  const isReviewMode = pageMode === "review";
  const openCount = displayedTodos.filter((todo) => !todo.completed).length;
  const listClassName = [
    "todo-list",
    displayedTodos.length > TODO_SCROLL_START_ROWS ? "todo-list--scroll" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const inputPlaceholder =
    pageMode === "today"
      ? t.notebook.addTaskFor(currentDate)
      : t.notebook.reviewTodos;
  const archiveTitle =
    archiveLayout === "cards"
      ? t.notebook.notebookCards
      : t.notebook.twoColumnTimeline;
  const notebookClassName = [
    "todo-notebook",
    isDailyMode ? "todo-notebook--daily" : "",
    isArchiveMode ? "todo-notebook--archive" : "",
    isReviewMode ? "todo-notebook--review" : "",
    isArchiveMode ? `todo-notebook--archive-${archiveLayout}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [todoTitleDraft, setTodoTitleDraft] = useState("");
  const [draggedTodoId, setDraggedTodoId] = useState<string | null>(null);
  const [dragOverTodoId, setDragOverTodoId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // 拖动排序是待办的基础交互，不再藏在设置项后面。
  const canReorderTodos = isTodayMode;

  const startTodoTitleEdit = useCallback((todo: TodoItem) => {
    if (!isTodayMode) {
      return;
    }

    setEditingTodoId(todo.id);
    setTodoTitleDraft(todo.title);
  }, [isTodayMode]);

  const commitTodoTitleEdit = useCallback(() => {
    if (!editingTodoId) {
      return;
    }

    const nextTitle = todoTitleDraft.trim();

    if (nextTitle) {
      onUpdateTodo(editingTodoId, nextTitle);
    }

    setEditingTodoId(null);
    setTodoTitleDraft("");
  }, [editingTodoId, onUpdateTodo, todoTitleDraft]);

  const getTodoIdAtPoint = useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const todoElement = element?.closest("[data-todo-id]");

    return todoElement instanceof HTMLElement
      ? todoElement.dataset.todoId ?? null
      : null;
  }, []);

  const startTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, todoId: string) => {
      if (!canReorderTodos || editingTodoId === todoId) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraggedTodoId(todoId);
      setDragOverTodoId(null);
    },
    [canReorderTodos, editingTodoId],
  );

  const moveTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedTodoId) {
        return;
      }

      event.preventDefault();
      const targetTodoId = getTodoIdAtPoint(event.clientX, event.clientY);
      setDragOverTodoId(
        targetTodoId && targetTodoId !== draggedTodoId ? targetTodoId : null,
      );
    },
    [draggedTodoId, getTodoIdAtPoint],
  );

  const finishTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedTodoId) {
        return;
      }

      event.preventDefault();
      const targetTodoId =
        dragOverTodoId || getTodoIdAtPoint(event.clientX, event.clientY);

      if (targetTodoId && targetTodoId !== draggedTodoId) {
        onReorderTodo(draggedTodoId, targetTodoId);
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      setDraggedTodoId(null);
      setDragOverTodoId(null);
    },
    [dragOverTodoId, draggedTodoId, getTodoIdAtPoint, onReorderTodo],
  );

  const cancelTodoDrag = useCallback(() => {
    setDraggedTodoId(null);
    setDragOverTodoId(null);
  }, []);

  return (
    <section className={notebookClassName} aria-label={t.notebook.sectionLabel}>
      <div className="todo-notebook__spine">
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--today",
            isTodayMode || isDailyMode ? "todo-spine-button--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title={t.notebook.backToToday}
          aria-label={t.notebook.backToToday}
          onClick={onShowToday}
        />
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--save",
            saveState === "saved" ? "todo-spine-button--saved" : "",
            saveState === "saving" ? "todo-spine-button--saving" : "",
            saveState === "needs-path" || saveState === "error"
              ? "todo-spine-button--attention"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title={t.notebook.saveToday}
          aria-label={t.notebook.saveTodayMarkdown}
          onClick={onSaveToday}
        >
          {saveState === "saved" && (
            <Check className="save-check-icon" size={12} strokeWidth={3} />
          )}
        </button>
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--archive",
            pageMode === "archive" || pageMode === "review"
              ? "todo-spine-button--active"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title={t.notebook.reviewSaved}
          aria-label={t.notebook.reviewSaved}
          onClick={onShowArchive}
        />
      </div>

      <div className="todo-notebook__topline">
        <div className="todo-notebook__title-group">
          <span className="todo-notebook__tab">
            {isDailyMode ? (
              <NotebookPen size={15} strokeWidth={2.1} />
            ) : (
              <ClipboardList size={15} strokeWidth={2.1} />
            )}
            {isReviewMode
              ? selectedArchive?.date ?? t.notebook.reviewTab
              : isDailyMode
                ? t.notebook.dailyTab
                : t.notebook.tasksTab}
          </span>
          {!isArchiveMode && !isReviewMode && (
            <button
              className={[
                "todo-page-toggle",
                isDailyMode ? "todo-page-toggle--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              title={isDailyMode ? t.notebook.backToTasks : t.notebook.openDailyNote}
              aria-label={
                isDailyMode ? t.notebook.backToTasks : t.notebook.openDailyNote
              }
              onClick={isDailyMode ? onShowToday : onShowDaily}
            >
              {isDailyMode ? (
                <ClipboardList size={14} strokeWidth={2.2} />
              ) : (
                <NotebookPen size={14} strokeWidth={2.2} />
              )}
            </button>
          )}
        </div>
        {isArchiveMode ? (
          <div className="archive-layout-toggle" aria-label={archiveTitle}>
            <button
              className={archiveLayout === "cards" ? "archive-layout-toggle--active" : ""}
              type="button"
              title={t.notebook.notebookCards}
              aria-label={t.notebook.notebookCards}
              onClick={() => onArchiveLayoutChange("cards")}
            >
              <ClipboardList size={14} strokeWidth={2.1} />
            </button>
            <button
              className={archiveLayout === "timeline" ? "archive-layout-toggle--active" : ""}
              type="button"
              title={t.notebook.twoColumnTimeline}
              aria-label={t.notebook.twoColumnTimeline}
              onClick={() => onArchiveLayoutChange("timeline")}
            >
              <Columns2 size={14} strokeWidth={2.1} />
            </button>
          </div>
        ) : (
          <span className="todo-notebook__open-count">
            {t.notebook.openCount(openCount)}
          </span>
        )}
      </div>

      {isTodayMode && (
        <form
          className="todo-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAddTodo();
          }}
        >
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          <input
            value={draft}
            placeholder={inputPlaceholder}
            aria-label={t.notebook.addTaskHint}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
          <button
            className="todo-form__add"
            type="submit"
            disabled={!draft.trim()}
            title={t.notebook.addTaskHint}
          >
            {t.notebook.add}
          </button>
        </form>
      )}

      {isArchiveMode ? (
        <ArchiveBrowser
          archives={archives}
          layout={archiveLayout}
          onSelectArchive={onSelectArchive}
        />
      ) : isDailyMode ? (
        <div className="daily-note-panel">
          <DiaryTimeline
            events={diaryEvents}
            title={t.diary.title}
            empty={t.diary.empty}
            localeTag={t.localeTag}
          />
          <textarea
            className="daily-note"
            value={dailyNote}
            placeholder={t.notebook.dailyPlaceholder}
            aria-label={t.notebook.dailyNoteLabel}
            spellCheck={false}
            onChange={(event) => onDailyNoteChange(event.currentTarget.value)}
          />
        </div>
      ) : (
        <div className={listClassName} role="list">
          {displayedTodos.length === 0 ? (
            <div className="todo-empty">
              {isReviewMode ? t.todo.emptyReview : t.todo.empty}
            </div>
          ) : (
            displayedTodos.map((todo) => {
              const isActive =
                isTodayMode && todo.id === activeTodoId && !todo.completed;
              const titleLineCount = getTodoTitleLineCount(todo.title);
              const elapsed = getTodoElapsedMs(todo, clockNow);
              const elapsedLabel = formatTodoElapsed(elapsed, t.localeTag);

              return (
                <div
                  className={[
                    "todo-item",
                    todo.completed ? "todo-item--done" : "",
                    isActive ? "todo-item--active" : "",
                    canReorderTodos ? "todo-item--reorderable" : "",
                    draggedTodoId === todo.id ? "todo-item--dragging" : "",
                    dragOverTodoId === todo.id ? "todo-item--drag-over" : "",
                    !isTodayMode ? "todo-item--readonly" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={todo.id}
                  role="listitem"
                  data-todo-id={todo.id}
                  style={
                    {
                      "--todo-title-min-height": `${titleLineCount * 19}px`,
                    } as CSSProperties
                  }
                >
                  <button
                    className="todo-check"
                    type="button"
                    aria-pressed={todo.completed}
                    disabled={!isTodayMode}
                    title={todo.completed ? t.todo.markIncomplete : t.todo.complete}
                    aria-label={t.todo.actionOnTask(
                      todo.completed ? t.todo.markIncomplete : t.todo.complete,
                      todo.title,
                    )}
                    onClick={() => onToggleTodo(todo.id)}
                  >
                    {todo.completed && <Check size={14} strokeWidth={2.5} />}
                  </button>
                  {isTodayMode && editingTodoId === todo.id ? (
                    <input
                      className="todo-title-input"
                      value={todoTitleDraft}
                      aria-label={t.todo.editTitle}
                      autoFocus
                      onChange={(event) =>
                        setTodoTitleDraft(event.currentTarget.value)
                      }
                      onBlur={commitTodoTitleEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitTodoTitleEdit();
                        }

                        if (event.key === "Escape") {
                          setEditingTodoId(null);
                          setTodoTitleDraft("");
                        }
                      }}
                    />
                  ) : isTodayMode ? (
                    <button
                      className="todo-title todo-title--editable"
                      type="button"
                      title={t.todo.editTitle}
                      onClick={() => startTodoTitleEdit(todo)}
                    >
                      <span className="todo-title__text">{todo.title}</span>
                      {(elapsed > 0 || todo.activeSince) && (
                        <span
                          className={`todo-elapsed${isActive ? " todo-elapsed--active" : ""}`}
                          title={t.todo.elapsed(elapsedLabel)}
                        >
                          {elapsedLabel}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="todo-title">{todo.title}</span>
                  )}
                  {isTodayMode && (
                    <>
                      <button
                        className={["todo-start", isActive ? "todo-start--active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        type="button"
                        title={isActive ? t.todo.stop : t.todo.start}
                        aria-label={t.todo.actionOnTask(
                          isActive ? t.todo.stop : t.todo.start,
                          todo.title,
                        )}
                        disabled={todo.completed}
                        onClick={() => onStartTodo(todo.id)}
                      >
                        <Play size={13} strokeWidth={2.4} />
                        <span>{isActive ? t.todo.stop : t.todo.start}</span>
                      </button>
                      <button
                        className="todo-delete"
                        type="button"
                        title={t.todo.delete}
                        aria-label={t.todo.deleteTask(todo.title)}
                        onClick={() => onDeleteTodo(todo.id)}
                      >
                        <Trash2 size={14} strokeWidth={2.2} />
                      </button>
                      {canReorderTodos && (
                        <button
                          className="todo-drag-handle"
                          type="button"
                          title={t.todo.reorder}
                          aria-label={t.todo.reorderTask(todo.title)}
                          disabled={editingTodoId === todo.id}
                          onPointerDown={(event) => startTodoDrag(event, todo.id)}
                          onPointerMove={moveTodoDrag}
                          onPointerUp={finishTodoDrag}
                          onPointerCancel={cancelTodoDrag}
                        >
                          <GripVertical size={15} strokeWidth={2.4} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function ArchiveBrowser({
  archives,
  layout,
  onSelectArchive,
}: {
  archives: TodoArchive[];
  layout: ArchiveLayout;
  onSelectArchive: (date: string) => void;
}) {
  const t = useTranslation();
  const handleHorizontalWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (layout !== "cards") {
      return;
    }

    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY + event.deltaX;
  };

  if (archives.length === 0) {
    return <div className="todo-empty">{t.archive.noSavedLists}</div>;
  }

  if (layout === "timeline") {
    return (
      <div className="archive-timeline" role="list">
        {archives.map((archive) => (
          <button
            className="archive-timeline__item"
            key={archive.date}
            type="button"
            role="listitem"
            onClick={() => onSelectArchive(archive.date)}
          >
            <span className="archive-timeline__dot" />
            <span>{archive.date}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="archive-cards" role="list" onWheel={handleHorizontalWheel}>
      {archives.map((archive) => {
        const previewTodos = archive.todos.slice(0, 3);
        const dateParts = getDisplayDateParts(archive.date, t);

        return (
          <button
            className="archive-card"
            key={archive.date}
            type="button"
            role="listitem"
            onClick={() => onSelectArchive(archive.date)}
          >
            <span className="archive-card__eyebrow">{t.archive.eyebrow}</span>
            <strong className="archive-card__date">
              <span>{dateParts.year}</span>
              <span>
                {dateParts.month}
                <em>/</em>
                {dateParts.day}
              </span>
            </strong>
            <span className="archive-card__preview">
              {previewTodos.length > 0 ? (
                previewTodos.map((todo) => (
                  <span className="archive-card__todo" key={todo.id}>
                    <span
                      className={[
                        "archive-card__todo-mark",
                        todo.completed ? "archive-card__todo-mark--done" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                    <span>{todo.title}</span>
                  </span>
                ))
              ) : (
                <span className="archive-card__empty">{t.archive.noTasks}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MusicPlayerPanel({
  mediaState,
  isTrackChanging,
  commandError,
  sourcePriority,
  settingsOpen,
  onToggleSettings,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onSetVolume,
  onToggleShuffle,
  onCycleRepeat,
  onReorderSource,
  onRemoveSource,
  lyrics,
}: {
  mediaState: MediaState;
  lyrics: LyricsState;
  isTrackChanging: boolean;
  commandError: string | null;
  sourcePriority: KnownMediaSource[];
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
  onSetVolume: (level: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onReorderSource: (sourceId: string, targetId: string) => void;
  onRemoveSource: (sourceId: string) => void;
}) {
  const t = useTranslation();
  const [draggedSourceId, setDraggedSourceId] = useState<string | null>(null);
  const [dragOverSourceId, setDragOverSourceId] = useState<string | null>(null);

  const isPlaying = mediaState.playbackStatus === "playing";
  const hasTrack = Boolean(mediaState.title);

  const prevDisabled = mediaState.available && !mediaState.canPrevious;
  const nextDisabled = mediaState.available && !mediaState.canNext;

  const liveSessions = mediaState.sessions;

  const getSourceIdAtPoint = useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const sourceElement = element?.closest("[data-source-id]");
    return sourceElement instanceof HTMLElement
      ? sourceElement.dataset.sourceId ?? null
      : null;
  }, []);

  const startSourceDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraggedSourceId(sourceId);
      setDragOverSourceId(null);
    },
    [],
  );

  const moveSourceDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedSourceId) {
        return;
      }
      event.preventDefault();
      const targetId = getSourceIdAtPoint(event.clientX, event.clientY);
      setDragOverSourceId(
        targetId && targetId !== draggedSourceId ? targetId : null,
      );
    },
    [draggedSourceId, getSourceIdAtPoint],
  );

  const finishSourceDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedSourceId) {
        return;
      }
      event.preventDefault();
      const targetId =
        dragOverSourceId || getSourceIdAtPoint(event.clientX, event.clientY);

      if (targetId && targetId !== draggedSourceId) {
        onReorderSource(draggedSourceId, targetId);
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      setDraggedSourceId(null);
      setDragOverSourceId(null);
    },
    [dragOverSourceId, draggedSourceId, getSourceIdAtPoint, onReorderSource],
  );

  const cancelSourceDrag = useCallback(() => {
    setDraggedSourceId(null);
    setDragOverSourceId(null);
  }, []);

  const settingsButton = (
    <button
      className={[
        "music-icon-button",
        settingsOpen ? "music-icon-button--on" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      type="button"
      title={settingsOpen ? t.music.closeSettings : t.music.openSettings}
      aria-label={settingsOpen ? t.music.closeSettings : t.music.openSettings}
      aria-pressed={settingsOpen}
      onClick={onToggleSettings}
    >
      {settingsOpen ? (
        <X size={16} strokeWidth={2.4} />
      ) : (
        <Settings size={16} strokeWidth={2.2} />
      )}
    </button>
  );

  return (
    <section
      className={[
        "music-player",
        !settingsOpen && !mediaState.available ? "music-player--empty music-player--core" : "",
        settingsOpen ? "music-player--settings" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={t.music.playerLabel}
      title={!settingsOpen && commandError ? commandError : undefined}
    >
      {settingsOpen ? (
        <>
          <div className="music-player__settings-head">
            <span className="music-player__settings-title">
              {t.music.settingsTitle}
            </span>
            {settingsButton}
          </div>
          <p className="music-player__settings-hint">{t.music.settingsHint}</p>
          {sourcePriority.length === 0 ? (
            <div className="music-source-empty">{t.music.noSources}</div>
          ) : (
            <div className="music-source-list" role="list">
              {sourcePriority.map((source) => {
                const live = liveSessions.find(
                  (session) => session.id === source.id,
                );
                return (
                  <div
                    key={source.id}
                    className={[
                      "music-source-item",
                      draggedSourceId === source.id
                        ? "music-source-item--dragging"
                        : "",
                      dragOverSourceId === source.id
                        ? "music-source-item--drag-over"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    role="listitem"
                    data-source-id={source.id}
                  >
                    <button
                      className="music-source-drag"
                      type="button"
                      title={t.music.reorderSource}
                      aria-label={t.music.reorderSource}
                      onPointerDown={(event) =>
                        startSourceDrag(event, source.id)
                      }
                      onPointerMove={moveSourceDrag}
                      onPointerUp={finishSourceDrag}
                      onPointerCancel={cancelSourceDrag}
                    >
                      <GripVertical size={15} strokeWidth={2.4} />
                    </button>
                    <span
                      className={[
                        "music-source-dot",
                        live?.playing ? "music-source-dot--playing" : "",
                        live ? "music-source-dot--live" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-hidden="true"
                    />
                    <span className="music-source-label" title={source.id}>
                      {source.label}
                    </span>
                    {!live && (
                      <button
                        className="music-source-remove"
                        type="button"
                        title={t.music.removeSource}
                        aria-label={t.music.removeSource}
                        onClick={() => onRemoveSource(source.id)}
                      >
                        <Trash2 size={14} strokeWidth={2.2} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="music-player__body">
          <div className="music-player__details">
            <div className="music-player__artwork" aria-hidden="true">
              {mediaState.thumbnail ? (
                <img src={mediaState.thumbnail} alt="" draggable={false} />
              ) : (
                <Music2 size={42} strokeWidth={1.7} />
              )}
            </div>
            <div className="music-player__meta">
              <span
                className="music-player__track"
                title={mediaState.title ?? undefined}
              >
                {mediaState.title ?? t.music.noMedia}
              </span>
              {hasTrack && (
                <span
                  className="music-player__artist"
                  title={mediaState.artist ?? undefined}
                >
                  {mediaState.artist ?? t.music.unknownArtist}
                </span>
              )}
              {hasTrack && mediaState.album && (
                <span className="music-player__album" title={mediaState.album}>
                  {mediaState.album}
                </span>
              )}
              {hasTrack && mediaState.sourceApp && (
                <span className="music-player__source">来源：{mediaState.sourceApp}</span>
              )}
              {!hasTrack && (
                <span className="music-player__hint">
                  {mediaState.audioActive
                    ? "检测到正在播放声音，但还没读到歌曲信息；打开网易云客户端播放后会自动识别"
                    : "正在读取本机网易云 / 其他播放器，无需登录；播放时自动识别"}
                </span>
              )}
            </div>
            {hasTrack && mediaState.durationMs > 0 && (
              <div className="music-player__progress">
                <span className="music-player__time">{formatMediaTime(mediaState.positionMs)}</span>
                <input
                  className="music-player__seek"
                  type="range"
                  min={0}
                  max={Math.max(mediaState.durationMs, 1)}
                  value={Math.min(mediaState.positionMs, Math.max(mediaState.durationMs, 1))}
                  disabled={!mediaState.canSeek || mediaState.durationMs <= 0}
                  onChange={(event) => onSeek(Number(event.currentTarget.value))}
                  aria-label="播放进度"
                />
                <span className="music-player__time">{formatMediaTime(mediaState.durationMs)}</span>
              </div>
            )}
          </div>
          <div className="music-player__stack">
            <div className="music-player__head-aside">
              {settingsButton}
            </div>

            {commandError && (
              <p className="music-player__error" role="alert">
                {t.music.controlFailed}
              </p>
            )}

            <MediaWaveform
              playing={isPlaying || mediaState.audioActive}
              audioPeak={mediaState.audioPeak}
            />

            <div className="music-player__controls">
              <button
                className={`music-control-button music-toggle-button${mediaState.shuffleActive ? " music-toggle-button--active" : ""}`}
                type="button"
                title="随机播放"
                aria-label="随机播放"
                aria-pressed={Boolean(mediaState.shuffleActive)}
                disabled={mediaState.available && !mediaState.canShuffle}
                onClick={onToggleShuffle}
              >
                <Shuffle size={16} strokeWidth={2.2} />
              </button>
              <button
                className="music-control-button"
                type="button"
                title={t.music.previous}
                aria-label={t.music.previousTrack}
                disabled={prevDisabled}
                onClick={onPrevious}
              >
                <SkipBack size={18} strokeWidth={2.4} />
              </button>
              <button
                className="music-control-button music-control-button--primary"
                type="button"
                title={isPlaying ? t.music.pause : t.music.play}
                aria-label={isPlaying ? t.music.pause : t.music.play}
                aria-busy={isTrackChanging}
                onClick={onPlayPause}
              >
                {isTrackChanging ? (
                  <RefreshCcw
                    className="music-control-button__track-change"
                    size={19}
                    strokeWidth={2.4}
                  />
                ) : isPlaying ? (
                  <Pause size={20} strokeWidth={2.5} />
                ) : (
                  <Play size={20} strokeWidth={2.5} />
                )}
              </button>
              <button
                className="music-control-button"
                type="button"
                title={t.music.next}
                aria-label={t.music.nextTrack}
                disabled={nextDisabled}
                onClick={onNext}
              >
                <SkipForward size={18} strokeWidth={2.4} />
              </button>
              <button
                className={`music-control-button music-toggle-button${mediaState.repeatMode === "track" || mediaState.repeatMode === "list" ? " music-toggle-button--active" : ""}`}
                type="button"
                title={mediaState.repeatMode === "track" ? "单曲循环" : mediaState.repeatMode === "list" ? "列表循环" : "循环播放"}
                aria-label="循环播放"
                aria-pressed={mediaState.repeatMode === "track" || mediaState.repeatMode === "list"}
                disabled={mediaState.available && !mediaState.canRepeat}
                onClick={onCycleRepeat}
              >
                {mediaState.repeatMode === "track" ? (
                  <Repeat1 size={16} strokeWidth={2.2} />
                ) : (
                  <Repeat size={16} strokeWidth={2.2} />
                )}
              </button>
            </div>

            <div className="music-player__volume">
              <Volume2 size={14} strokeWidth={2.2} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((mediaState.volume ?? 0.7) * 100)}
                onChange={(event) => onSetVolume(Number(event.currentTarget.value) / 100)}
                aria-label="音量"
              />
            </div>
          </div>
        </div>
      )}
      {!settingsOpen && mediaState.available && mediaState.durationMs > 0 && (
        <MusicLyrics lyrics={lyrics} />
      )}
    </section>
  );
}

function formatMediaTime(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "00:00";
  }
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseLrc(lrc: string) {
  const lines: Array<{ time: number; text: string }> = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const match = raw.match(/^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!match) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fraction = match[3] ? Number(match[3].padEnd(3, "0")) : 0;
    const text = match[4].trim();
    if (!text) continue;
    lines.push({ time: minutes * 60_000 + seconds * 1000 + fraction, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 歌词：按当前播放进度高亮并自动滚动到中间行。
type LyricLine = { time: number; text: string };
type LyricsState = {
  lines: LyricLine[];
  status: "idle" | "loading" | "error" | "empty";
  activeIndex: number;
  activeText: string | null;
};

// 只在能拿到播放进度（系统媒体会话）时取歌词，避免出现「无法调用」的歌词面板。
function useLyrics(
  title: string | null,
  artist: string | null,
  positionMs: number,
  enabled: boolean,
): LyricsState {
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "empty">("idle");

  useEffect(() => {
    if (!enabled || !title || !isTauri()) {
      setLines([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void invoke<{ lrc: string; songTitle: string }>("fetch_lyrics", { title, artist })
      .then((result) => {
        if (cancelled) return;
        const parsed = parseLrc(result.lrc).map((line) => ({ time: line.time, text: line.text }));
        setLines(parsed);
        setStatus(parsed.length ? "idle" : "empty");
      })
      .catch(() => {
        if (cancelled) return;
        setLines([]);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [artist, enabled, title]);

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time <= positionMs) index = i;
      else break;
    }
    return index;
  }, [lines, positionMs]);

  return {
    lines,
    status,
    activeIndex,
    activeText: activeIndex >= 0 ? lines[activeIndex]?.text ?? null : null,
  };
}

function MusicLyrics({ lyrics }: { lyrics: LyricsState }) {
  const activeRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [lyrics.activeIndex]);

  if (lyrics.lines.length === 0) {
    return null;
  }

  return (
    <div className="music-lyrics" aria-label="歌词">
      {lyrics.lines.map((line, index) => (
        <p
          key={`${line.time}-${index}`}
          ref={index === lyrics.activeIndex ? activeRef : undefined}
          className={`music-lyrics__line${index === lyrics.activeIndex ? " music-lyrics__line--active" : ""}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

function ClipboardHistoryPanel({
  snapshot,
  onCopyItem,
  onToggleFavorite,
  onUpdateNote,
  onDeleteItem,
  onClear,
}: {
  snapshot: ClipboardHistorySnapshot;
  onCopyItem: (id: string) => Promise<boolean> | boolean;
  onToggleFavorite: (id: string) => Promise<void> | void;
  onUpdateNote: (id: string, note: string) => Promise<boolean> | boolean;
  onDeleteItem: (id: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
}) {
  const t = useTranslation();
  const [query, setQuery] = useState("");
  const [clipboardView, setClipboardView] = useState<"all" | "favorites">("all");
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const copiedResetRef = useRef<number | null>(null);
  const confirmDeleteResetRef = useRef<number | null>(null);
  const confirmClearResetRef = useRef<number | null>(null);
  const itemElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const itemPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const normalizedQuery = query.trim().toLowerCase();
  const favoriteItems = useMemo(
    () => snapshot.items.filter((item) => item.favorite),
    [snapshot.items],
  );
  const viewedItems = clipboardView === "favorites" ? favoriteItems : snapshot.items;
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) {
      return viewedItems;
    }

    return viewedItems.filter((item) => {
      const haystack = [
        item.preview,
        item.text ?? "",
        item.note ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, viewedItems]);

  useEffect(
    () => () => {
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }

      if (confirmDeleteResetRef.current !== null) {
        window.clearTimeout(confirmDeleteResetRef.current);
      }

      if (confirmClearResetRef.current !== null) {
        window.clearTimeout(confirmClearResetRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const visibleIds = new Set(filteredItems.map((item) => item.id));
    const nextPositions = new Map<string, DOMRect>();
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    itemElementsRef.current.forEach((element, id) => {
      if (!visibleIds.has(id)) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const previousRect = itemPositionsRef.current.get(id);
      nextPositions.set(id, nextRect);

      if (!previousRect || prefersReducedMotion) {
        return;
      }

      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;

      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      element.getAnimations().forEach((animation) => animation.cancel());
      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 280,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
    });

    itemPositionsRef.current = nextPositions;
  }, [filteredItems]);

  useEffect(() => {
    if (confirmDeleteResetRef.current !== null) {
      window.clearTimeout(confirmDeleteResetRef.current);
      confirmDeleteResetRef.current = null;
    }

    if (!confirmDeleteId) {
      return;
    }

    confirmDeleteResetRef.current = window.setTimeout(() => {
      setConfirmDeleteId(null);
      confirmDeleteResetRef.current = null;
    }, 3000);

    return () => {
      if (confirmDeleteResetRef.current !== null) {
        window.clearTimeout(confirmDeleteResetRef.current);
        confirmDeleteResetRef.current = null;
      }
    };
  }, [confirmDeleteId]);

  useEffect(() => {
    if (confirmClearResetRef.current !== null) {
      window.clearTimeout(confirmClearResetRef.current);
      confirmClearResetRef.current = null;
    }

    if (!isConfirmingClear) {
      return;
    }

    confirmClearResetRef.current = window.setTimeout(() => {
      setIsConfirmingClear(false);
      confirmClearResetRef.current = null;
    }, 3000);

    return () => {
      if (confirmClearResetRef.current !== null) {
        window.clearTimeout(confirmClearResetRef.current);
        confirmClearResetRef.current = null;
      }
    };
  }, [isConfirmingClear]);

  useEffect(() => {
    if (!confirmDeleteId && !isConfirmingClear) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const isConfirmControl = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches("[data-clipboard-confirm-control='true']"),
        );

      if (isConfirmControl) {
        return;
      }

      setConfirmDeleteId(null);
      setIsConfirmingClear(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [confirmDeleteId, isConfirmingClear]);

  useEffect(() => {
    if (
      confirmDeleteId &&
      !snapshot.items.some((item) => item.id === confirmDeleteId)
    ) {
      setConfirmDeleteId(null);
    }

    if (snapshot.items.length === 0) {
      setIsConfirmingClear(false);
    }

    if (
      editingNoteId &&
      !snapshot.items.some((item) => item.id === editingNoteId)
    ) {
      setEditingNoteId(null);
      setNoteDraft("");
      setIsSavingNote(false);
    }
  }, [confirmDeleteId, editingNoteId, snapshot.items]);

  const showCopiedState = useCallback((id: string) => {
    setCopiedItemId(id);

    if (copiedResetRef.current !== null) {
      window.clearTimeout(copiedResetRef.current);
    }

    copiedResetRef.current = window.setTimeout(() => {
      setCopiedItemId(null);
      copiedResetRef.current = null;
    }, 1100);
  }, []);

  const handleCopyItem = useCallback(
    (id: string) => {
      void Promise.resolve(onCopyItem(id)).then((didCopy) => {
        if (didCopy) {
          showCopiedState(id);
        }
      });
    },
    [onCopyItem, showCopiedState],
  );

  const handleToggleFavorite = useCallback(
    (id: string) => {
      setConfirmDeleteId(null);
      void Promise.resolve(onToggleFavorite(id));
    },
    [onToggleFavorite],
  );

  const startEditingNote = useCallback((item: ClipboardHistoryItem) => {
    setConfirmDeleteId(null);
    setEditingNoteId(item.id);
    setNoteDraft(item.note ?? "");
  }, []);

  const cancelEditingNote = useCallback(() => {
    if (isSavingNote) {
      return;
    }

    setEditingNoteId(null);
    setNoteDraft("");
  }, [isSavingNote]);

  const saveNote = useCallback(
    (id: string) => {
      if (isSavingNote) {
        return;
      }

      setIsSavingNote(true);
      void Promise.resolve(onUpdateNote(id, noteDraft)).then((didSave) => {
        setIsSavingNote(false);
        if (didSave) {
          setEditingNoteId(null);
          setNoteDraft("");
        }
      });
    },
    [isSavingNote, noteDraft, onUpdateNote],
  );

  const handleDeleteItem = useCallback(
    (id: string) => {
      if (confirmDeleteId !== id) {
        setIsConfirmingClear(false);
        setConfirmDeleteId(id);
        return;
      }

      setConfirmDeleteId(null);
      setIsConfirmingClear(false);
      void Promise.resolve(onDeleteItem(id));
    },
    [confirmDeleteId, onDeleteItem],
  );

  const handleClear = useCallback(() => {
    if (!isConfirmingClear) {
      setConfirmDeleteId(null);
      setIsConfirmingClear(true);
      return;
    }

    setIsConfirmingClear(false);
    setConfirmDeleteId(null);
    void Promise.resolve(onClear());
  }, [isConfirmingClear, onClear]);

  return (
    <section className="clipboard-panel" aria-label={t.clipboard.title}>
      <header className="clipboard-panel__header">
        <div className="clipboard-panel__title">
          <ClipboardList size={16} strokeWidth={2.2} />
          <span>{t.clipboard.title}</span>
          <strong>{snapshot.items.length}</strong>
          {favoriteItems.length > 0 && (
            <em aria-label={t.clipboard.favoriteCount(favoriteItems.length)}>
              <Star size={10} strokeWidth={2.4} fill="currentColor" />
              {favoriteItems.length}
            </em>
          )}
        </div>
        <div className="clipboard-panel__tools">
          <button
            className={[
              "clipboard-clear-button",
              isConfirmingClear ? "clipboard-clear-button--confirming" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            disabled={snapshot.items.length === 0}
            title={isConfirmingClear ? t.clipboard.confirmClear : t.clipboard.clear}
            aria-label={
              isConfirmingClear ? t.clipboard.confirmClear : t.clipboard.clearHistory
            }
            onClick={handleClear}
            data-clipboard-confirm-control="true"
          >
            {isConfirmingClear ? (
              <Check className="save-check-icon" size={14} strokeWidth={2.7} />
            ) : (
              <Trash2 size={14} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </header>

      <div className="clipboard-segments" aria-label={t.clipboard.segments}>
        <button
          className={clipboardView === "all" ? "clipboard-segment--active" : ""}
          type="button"
          aria-pressed={clipboardView === "all"}
          onClick={() => setClipboardView("all")}
        >
          {t.clipboard.all}
        </button>
        <button
          className={clipboardView === "favorites" ? "clipboard-segment--active" : ""}
          type="button"
          aria-pressed={clipboardView === "favorites"}
          onClick={() => setClipboardView("favorites")}
        >
          {t.clipboard.favorites}
        </button>
      </div>

      <label className="clipboard-search">
        <Search size={15} strokeWidth={2.2} />
        <input
          value={query}
          placeholder={t.clipboard.searchPlaceholder}
          aria-label={t.clipboard.searchLabel}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {query && (
          <button
            type="button"
            title={t.clipboard.clearSearch}
            aria-label={t.clipboard.clearSearch}
            onClick={() => setQuery("")}
          >
            <X size={14} strokeWidth={2.4} />
          </button>
        )}
      </label>

      <div className="clipboard-list" role="list">
        {filteredItems.length === 0 ? (
          <div className="clipboard-empty">
            {snapshot.items.length === 0
              ? t.clipboard.emptyAll
              : clipboardView === "favorites" && favoriteItems.length === 0
                ? t.clipboard.emptyFavorites
                : t.clipboard.emptySearch}
          </div>
        ) : (
          filteredItems.map((item) => (
            <article
              className="clipboard-item"
              key={item.id}
              role="listitem"
              ref={(node) => {
                if (node) {
                  itemElementsRef.current.set(item.id, node);
                } else {
                  itemElementsRef.current.delete(item.id);
                }
              }}
            >
              <button
                className="clipboard-item__main"
                type="button"
                title={t.clipboard.copyBack}
                onClick={() => handleCopyItem(item.id)}
              >
                {item.kind === "image" ? (
                  <span className="clipboard-item__thumb">
                    {item.image?.thumbnailDataUrl ? (
                      <img src={item.image.thumbnailDataUrl} alt="" />
                    ) : (
                      <ImageIcon size={20} strokeWidth={2.1} />
                    )}
                  </span>
                ) : (
                  <span className="clipboard-item__text-icon">
                    <ClipboardList size={17} strokeWidth={2.1} />
                  </span>
                )}
                <span className="clipboard-item__body">
                  <span className="clipboard-item__preview">{item.preview}</span>
                </span>
              </button>
              <div className="clipboard-item__note">
                {editingNoteId === item.id ? (
                  <form
                    className="clipboard-note-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveNote(item.id);
                    }}
                  >
                    <input
                      autoFocus
                      value={noteDraft}
                      maxLength={80}
                      placeholder={t.clipboard.notePlaceholder}
                      aria-label={t.clipboard.noteInputLabel}
                      disabled={isSavingNote}
                      onChange={(event) => setNoteDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEditingNote();
                        }
                      }}
                    />
                    <button
                      type="submit"
                      title={t.clipboard.saveNote}
                      aria-label={t.clipboard.saveNote}
                      disabled={isSavingNote}
                    >
                      <Check size={13} strokeWidth={2.6} />
                    </button>
                    <button
                      type="button"
                      title={t.clipboard.cancelEdit}
                      aria-label={t.clipboard.cancelEditNote}
                      disabled={isSavingNote}
                      onClick={cancelEditingNote}
                    >
                      <X size={13} strokeWidth={2.5} />
                    </button>
                  </form>
                ) : (
                  <button
                    className={item.note ? "clipboard-note clipboard-note--filled" : "clipboard-note"}
                    type="button"
                    title={item.note ? t.clipboard.editNote(item.note) : t.clipboard.addNote}
                    aria-label={
                      item.note ? t.clipboard.editNote(item.note) : t.clipboard.addNoteLabel
                    }
                    onClick={() => startEditingNote(item)}
                  >
                    <Pencil size={12} strokeWidth={2.3} />
                    <span>{item.note || t.clipboard.noteFallback}</span>
                  </button>
                )}
              </div>
              <div className="clipboard-item__actions">
                <button
                  className={[
                    "clipboard-favorite-button",
                    item.favorite ? "clipboard-favorite-button--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  title={item.favorite ? t.clipboard.unfavorite : t.clipboard.favorite}
                  aria-label={
                    item.favorite
                      ? t.clipboard.unfavoriteItem
                      : t.clipboard.favoriteItem
                  }
                  aria-pressed={item.favorite}
                  onClick={() => handleToggleFavorite(item.id)}
                >
                  <Star
                    size={14}
                    strokeWidth={2.3}
                    fill={item.favorite ? "currentColor" : "none"}
                  />
                </button>
                <button
                  className={[
                    "clipboard-delete-button",
                    confirmDeleteId === item.id ? "clipboard-delete-button--confirming" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  title={
                    confirmDeleteId === item.id
                      ? t.clipboard.confirmDelete
                      : t.clipboard.delete
                  }
                  aria-label={t.clipboard.deleteItem}
                  onClick={() => handleDeleteItem(item.id)}
                  data-clipboard-confirm-control="true"
                >
                  {confirmDeleteId === item.id ? (
                    <Check className="save-check-icon" size={14} strokeWidth={2.7} />
                  ) : (
                    <Trash2 size={14} strokeWidth={2.3} />
                  )}
                </button>
                <button
                  className={[
                    "clipboard-copy-button",
                    copiedItemId === item.id ? "clipboard-copy-button--copied" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  title={copiedItemId === item.id ? t.clipboard.copied : t.clipboard.copy}
                  aria-label={t.clipboard.copyBack}
                  onClick={() => handleCopyItem(item.id)}
                >
                  {copiedItemId === item.id ? (
                    <Check className="save-check-icon" size={14} strokeWidth={2.7} />
                  ) : (
                    <Copy size={14} strokeWidth={2.3} />
                  )}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

type VideoAutomationSnapshot = {
  provider: "bilibili" | "douyin";
  running: boolean;
  intervalSeconds: number;
  maxMinutes: number;
  steps: number;
  startedAt: number | null;
  lastActionAt: number | null;
  currentUrl: string;
  waitingForBrowser: boolean;
  foregroundTitle: string;
  foregroundProcess: string;
  error: string | null;
};

const DEFAULT_VIDEO_AUTOMATION: VideoAutomationSnapshot = {
  provider: "bilibili",
  running: false,
  intervalSeconds: 45,
  maxMinutes: 30,
  steps: 0,
  startedAt: null,
  lastActionAt: null,
  currentUrl: "",
  waitingForBrowser: false,
  foregroundTitle: "",
  foregroundProcess: "",
  error: null,
};

function VideoAutomationPanel({ onNotice }: { onNotice: (notice: string) => void }) {
  const [snapshot, setSnapshot] = useState<VideoAutomationSnapshot>(DEFAULT_VIDEO_AUTOMATION);
  const [provider, setProvider] = useState<"bilibili" | "douyin">("bilibili");
  const [intervalSeconds, setIntervalSeconds] = useState(45);
  const [maxMinutes, setMaxMinutes] = useState(30);
  // 评论区互动：生成一句评论 → 复制 / 直接敲进已聚焦的评论框。
  const [comment, setComment] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [autoComment, setAutoComment] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-video-auto-comment") === "on";
    } catch {
      return false;
    }
  });
  // 自动发送：剪贴板里的评论直接用 Ctrl+V + Enter 发出去。
  // 需要先把光标放进评论框（点一次），之后每轮都能自动发。
  const [autoSendComment, setAutoSendComment] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-video-auto-send-comment") === "on";
    } catch {
      return false;
    }
  });

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<VideoAutomationSnapshot>("get_video_automation_state");
      setSnapshot(next);
      setProvider(next.provider);
      setIntervalSeconds(next.intervalSeconds);
      setMaxMinutes(next.maxMinutes);
    } catch {
      // Browser preview can run without the native API.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveConfig = useCallback(async () => {
    await invoke("set_video_automation_config", {
      config: {
        intervalSeconds: Math.max(15, Math.round(intervalSeconds)),
        maxMinutes: Math.max(1, Math.round(maxMinutes)),
      },
    });
  }, [intervalSeconds, maxMinutes]);

  const start = async () => {
    try {
      await saveConfig();
      await invoke("start_video_automation", { provider });
      await refresh();
      onNotice((provider === "bilibili" ? "B站" : "抖音") + " 自动刷视频已开始，请先在浏览器完成登录");
    } catch (error) {
      onNotice("自动刷视频启动失败：" + String(error));
    }
  };

  const stop = async () => {
    try {
      await invoke("stop_video_automation");
      await refresh();
      onNotice("自动刷视频已暂停");
    } catch (error) {
      onNotice("停止自动刷视频失败：" + String(error));
    }
  };

  const generateComment = useCallback(async () => {
    setCommentBusy(true);
    const title = snapshot.foregroundTitle || "";
    const fallback = [
      "这个视频讲得挺清楚的，学到了。",
      "刚好在找这个内容，谢谢分享。",
      "看到这里忍不住点赞，up 主加油。",
      "节奏很舒服，看着不累。",
    ];
    try {
      const config = loadLocalChatConfig();
      const prompt = `你是正在看视频的观众，视频标题是「${title || "未知视频"}」。请写一条不超过 20 个字的中文弹幕风格评论，自然、不夸张、不带话题标签。`;
      let text = "";
      try {
        if (config.backend === "local" && config.model) {
          text = await invoke<string>("local_chat", {
            baseUrl: config.baseUrl,
            model: config.model,
            apiKey: config.apiKey.trim() || null,
            message: prompt,
            history: [],
            character: "xiaobai",
            images: null,
          });
        } else {
          const reply = await invoke<{ text: string }>("dsh_chat", {
            message: prompt,
            sessionId: null,
            character: "xiaobai",
          });
          text = reply.text;
        }
      } catch {
        text = "";
      }
      const line = (text || "").trim().replace(/^["「『]|["」』]$/g, "");
      setComment(line || fallback[Math.floor(Math.random() * fallback.length)]);
    } finally {
      setCommentBusy(false);
    }
  }, [snapshot.foregroundTitle]);

  const copyComment = useCallback(async (text: string) => {
    try {
      await invoke("set_clipboard_text", { text });
      return true;
    } catch {
      return false;
    }
  }, []);

  // 自动评论：每次翻页后生成一句并放进剪贴板，用户点开评论框直接 Ctrl+V。
  const lastStepsRef = useRef(0);
  useEffect(() => {
    if (!autoComment) {
      lastStepsRef.current = snapshot.steps;
      return;
    }
    if (snapshot.steps > lastStepsRef.current) {
      lastStepsRef.current = snapshot.steps;
      void (async () => {
        await generateComment();
      })();
    }
  }, [autoComment, generateComment, snapshot.steps]);

  useEffect(() => {
    if (!autoComment || !comment) return;
    void (async () => {
      const ok = await copyComment(comment);
      if (!ok || !autoSendComment) return;
      try {
        await invoke("press_shortcut", { shortcut: "ctrl+v" });
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        await invoke("press_shortcut", { shortcut: "enter" });
      } catch {
        // 光标不在评论框时按不出去，忽略
      }
    })();
  }, [autoComment, autoSendComment, comment, copyComment]);
  return (
    <section className="video-automation" aria-label="自动刷视频">
      <div className="video-automation__head">
        <div>
          <span className="assistant-panel__label">自动翻页</span>
          <strong>{snapshot.running ? snapshot.waitingForBrowser ? "等待视频页回到前台" : "正在观看" : "已暂停"}</strong>
        </div>
        <span className="video-automation__steps">已翻页 {snapshot.steps} 次</span>
      </div>
      <div className="video-automation__controls">
        <select value={provider} onChange={(event) => setProvider(event.target.value as "bilibili" | "douyin")}>
          <option value="bilibili">B站推荐流</option>
          <option value="douyin">抖音推荐流</option>
        </select>
        <label>间隔 <input type="number" min={15} max={600} value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value) || 45)} /> 秒</label>
        <label>上限 <input type="number" min={1} max={240} value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.target.value) || 30)} /> 分钟</label>
        {snapshot.running ? (
          <button type="button" onClick={() => void stop()}>暂停</button>
        ) : (
          <button type="button" onClick={() => void start()}>开始</button>
        )}
      </div>
      <p className="video-automation__hint">
        打开有窗口浏览器并登录，保持视频页在前台；首次翻页约 6 秒后执行，之后按间隔翻页。
        切到其他窗口时会自动暂停，不抢焦点、不乱按键。
      </p>
      <div className="video-automation__comment">
        <div className="video-automation__comment-head">
          <span className="assistant-panel__label">评论区</span>
          <label className="video-automation__comment-toggle">
            <input
              type="checkbox"
              checked={autoComment}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoComment(next);
                try {
                  window.localStorage.setItem("maltese-video-auto-comment", next ? "on" : "off");
                } catch {
                  // 忽略
                }
              }}
            />
            <span>每次翻页后自动准备一句评论</span>
          </label>
          <label className="video-automation__comment-toggle">
            <input
              type="checkbox"
              checked={autoSendComment}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoSendComment(next);
                try {
                  window.localStorage.setItem("maltese-video-auto-send-comment", next ? "on" : "off");
                } catch {
                  // 忽略
                }
              }}
            />
            <span>自动发送（先把光标点进评论框）</span>
          </label>
        </div>
        <textarea
          value={comment}
          rows={2}
          placeholder="小狗会按当前视频写一句，也可以自己改"
          onChange={(event) => setComment(event.currentTarget.value)}
        />
        <div className="video-automation__comment-actions">
          <button type="button" disabled={commentBusy} onClick={() => void generateComment()}>
            {commentBusy ? "生成中…" : "生成评论"}
          </button>
          <button
            type="button"
            disabled={!comment.trim()}
            onClick={() =>
              void copyComment(comment).then((ok) =>
                onNotice(ok ? "评论已复制，点开评论框 Ctrl+V 即可" : "复制失败"),
              )
            }
          >
            复制
          </button>
          <button
            type="button"
            disabled={!comment.trim()}
            onClick={() =>
              void (async () => {
                const ok = await copyComment(comment);
                try {
                  await invoke("type_text", { text: comment });
                  onNotice("已把评论敲进当前输入框，回车发送即可");
                } catch (error) {
                  onNotice(`输入失败：${String(error)}${ok ? "（评论已复制）" : ""}`);
                }
              })()
            }
          >
            输入到评论框
          </button>
        </div>
        <p className="video-automation__hint">
          先用鼠标点一下网页里的评论输入框，再点「输入到评论框」。勾选「自动发送」后，每轮会自动粘贴并回车；
          光标不在评论框时不会乱发。
        </p>
        <div className="video-automation__publish">
          <span className="assistant-panel__label">投稿 / 开播（半自动）</span>
          <div className="video-automation__comment-actions">
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  const title = snapshot.foregroundTitle || "";
                  const desc = comment || "（在这里补充简介）";
                  await invoke("set_clipboard_text", {
                    text: `${title}\n${desc}\n\n（由 Maltese 准备的标题与简介，粘贴到投稿页即可）`,
                  }).catch(() => undefined);
                  await invoke("open_local_path", {
                    path:
                      provider === "bilibili"
                        ? "https://member.bilibili.com/platform/upload/video/frame"
                        : "https://creator.douyin.com/creator-micro/content/upload",
                  }).catch(() => undefined);
                  onNotice("已打开投稿页，标题和简介已复制，粘贴即可；发布需要你本人确认。");
                })()
              }
            >
              准备投稿
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  await invoke("open_local_path", {
                    path:
                      provider === "bilibili"
                        ? "https://link.bilibili.com/p/center/index#/user-center/my-info/live-data"
                        : "https://creator.douyin.com/creator-micro/content/manage?enter_from=live",
                  }).catch(() => undefined);
                  onNotice("已打开直播中心；开播的实名认证、推流信息需要你在网页里确认。");
                })()
              }
            >
              打开直播中心
            </button>
          </div>
          <p className="video-automation__hint">
            上传视频与开播涉及实名认证、版权与平台风控，Maltese 只帮你打开官方页面并准备好文案，
            不会代替你点发布或推流。
          </p>
        </div>
      </div>
      {snapshot.running && snapshot.waitingForBrowser && snapshot.foregroundTitle && (
        <p className="video-automation__hint video-automation__hint--warn">
          当前前台：{snapshot.foregroundTitle}
          {snapshot.foregroundProcess ? `（${snapshot.foregroundProcess}）` : ""}
          ，请点一下浏览器里的 B 站/抖音页面。
        </p>
      )}
    </section>
  );
}

function VideoPage() {
  const [notice, setNotice] = useState("");
  const t = useTranslation();

  return (
    <section className="plugins-page" aria-label={t.plugins.title}>
      <div id="video-automation-plugin" className="plugin-video-card">
        <div className="plugin-video-card__head">
          <div>
            <span className="assistant-panel__label">{t.plugins.builtin}</span>
            <strong>自动刷视频</strong>
          </div>
          <small>内置在宿主里的插件，不占用快捷方式</small>
        </div>
        <VideoAutomationPanel onNotice={setNotice} />
        {notice && <p className="video-page__notice" role="status">{notice}</p>}
      </div>
      <PluginsPanel
        onOpenBuiltin={() => {
          document.getElementById("video-automation-plugin")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }}
      />
    </section>
  );
}

type CustomShortcut = { label: string; path: string };

const CUSTOM_SHORTCUTS_KEY = "maltese-custom-shortcuts";
const HIDDEN_SHORTCUTS_KEY = "maltese-hidden-shortcuts";
const HIDDEN_SHORTCUT_ACTIONS_KEY = "maltese-hidden-shortcut-actions";

const PAGE_LABELS: Record<string, string> = {
  chat: "聊天",
  todo: "待办",
  music: "音乐",
  clipboard: "剪贴板",
  video: "看视频",
  qq: "消息",
  assistant: "快捷",
  layout: "设置",
};
function shortcutPathKey(path: string): string {
  return path
    .replace(/\//g, "\\")
    .replace(/^\\\\\?\\/, "")
    .toLowerCase();
}

function loadHiddenShortcuts(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_SHORTCUTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .map(shortcutPathKey)
      .slice(0, 200);
  } catch {
    return [];
  }
}

function loadHiddenShortcutActions(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_SHORTCUT_ACTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function loadCustomShortcuts(): CustomShortcut[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CustomShortcut =>
        Boolean(item)
        && typeof (item as CustomShortcut).label === "string"
        && typeof (item as CustomShortcut).path === "string")
      .slice(0, 24);
  } catch {
    return [];
  }
}



// 前台程序 → 对应的小狗动作（文字气泡之外再换一套 GIF）。
const ACTIVITY_MOODS: Record<string, PetState> = {
  code: "working",
  document: "relax",
  meeting: "attention",
  chat: "happy",
  browser: "peek",
  design: "spin",
  video: "relax",
  game: "chase",
};

// 睡觉/缩边时固定趴睡帧；其余表情由设置页的轮播顺序决定。
const SLEEPING_FRAME = petAssetUrl("/assets/pets/rest.gif");

// 根据前台进程生成的情感互动台词（相当于 LineDogPet 的“偷偷观察你”）。
const ACTIVITY_LINES: Record<string, string[]> = {
  code: [
    "又在写代码呀，我趴在旁边不吵你，卡住了就摸摸我",
    "敲代码辛苦啦，记得眨眨眼、动动肩膀～",
    "这段逻辑是不是有点绕？先喝口水，回来再想",
    "陪你 debug：错的不一定是你，可能是世界",
    "写累了就看看我，摇尾巴不要钱",
    "今天的代码也会乖乖听话的，加油",
  ],
  document: [
    "在写东西呀，我安静地趴在旁边陪着你",
    "文档慢慢写，写不完也没关系，先照顾好自己的眼睛",
    "这一段写得真好，虽然我看不懂（摇尾巴）",
    "记得保存一下哦，我可不想看你重写",
    "写累了就把手放在我头上歇一会儿",
  ],
  meeting: [
    "在开会呀，我小声一点，不打扰你",
    "会议结束记得起来走两步，坐久了对腰不好",
    "要是听累了，就偷偷看我一眼，我在呢",
  ],
  chat: [
    "在聊天呀，替我向对方问好～",
    "聊得开心就好，别忘了喝水",
    "消息一条条来，你也可以慢慢回",
  ],
  browser: [
    "在网上逛什么呢？别被标题党骗走太多时间啦",
    "刷一会儿就休息一下吧，眼睛也要放假",
    "看到喜欢的可以复制给我，我帮你记着",
  ],
  design: [
    "在做设计呀，你的审美一定很好",
    "配色改来改去很正常的，别急",
    "画累了看看远方，我在这儿蹲着",
  ],
  video: [
    "看视频呀，好看的话记得跟我讲讲剧情",
    "追剧别忘了时间，眼睛要休息",
  ],
  game: [
    "打游戏啦？赢了记得摸摸我庆祝一下",
    "输一局也没关系，下一把一定行",
    "玩累了就歇会儿，我陪你趴着",
  ],
};

// 用 WebAudio 合成一声很短的小狗哼唧，避免额外音频素材。
let petAudioContext: AudioContext | null = null;
function playPetChirp(kind: "soft" | "happy" = "soft") {
  // 用户配置了自定义音效就优先播放它，失败再回落到合成音。
  if (playCustomSound()) {
    return;
  }
  try {
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    petAudioContext = petAudioContext ?? new Ctx();
    const context = petAudioContext;
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    const base = kind === "happy" ? 720 : 520;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(base, now);
    oscillator.frequency.exponentialRampToValueAtTime(base * 1.35, now + 0.08);
    oscillator.frequency.exponentialRampToValueAtTime(base * 0.88, now + 0.17);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.26);
  } catch {
    // 音效失败不影响交互
  }
}

export function AssistantPanel() {
  const t = useTranslation();
  const panelRef = useRef<HTMLElement | null>(null);
  const appSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState("选择一个入口，线条小狗会陪你完成下一步");
  const [discoveredShortcuts, setDiscoveredShortcuts] = useState<Array<{ label: string; path: string; kind: string; category: string }>>([]);
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcut[]>(loadCustomShortcuts);
  const [hiddenShortcuts, setHiddenShortcuts] = useState<string[]>(loadHiddenShortcuts);
  const [hiddenShortcutActions, setHiddenShortcutActions] = useState<string[]>(loadHiddenShortcutActions);
  const [autoDetectShortcuts, setAutoDetectShortcuts] = useState(loadShortcutAutoDetect);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPath, setDraftPath] = useState("");
  // 路径格式错误时直接显示在输入框下面，而不是只在角落闪一句提示。
  const [draftPathError, setDraftPathError] = useState("");
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const [panelHotkey, setPanelHotkey] = useState(loadShortcutPanelHotkey);
  const [recordingPanelHotkey, setRecordingPanelHotkey] = useState(false);
  const [panelHotkeyError, setPanelHotkeyError] = useState("");
  const [scanDir, setScanDir] = useState(loadShortcutScanDir);
  const [scanDraft, setScanDraft] = useState(loadShortcutScanDir);
  const [scanError, setScanError] = useState("");
  const [appQuery, setAppQuery] = useState("");
  const [appResults, setAppResults] = useState<Array<{ label: string; path: string; kind: string; category: string }>>([]);
  const [appSearching, setAppSearching] = useState(false);
  const [appActiveIndex, setAppActiveIndex] = useState(-1);

  // 结果刷新后重置选中项，避免上下键停在一个已经不存在的位置。
  useEffect(() => {
    setAppActiveIndex(-1);
  }, [appResults]);

  useEffect(() => {
    // 面板可能是热键打开的：窗口刚显示时 DOM 还没拿到焦点，单次 focus 会被吞掉。
    // 这里补几次重试，并在窗口重新获得焦点时再抢一次，保证能直接打字。
    const focusSearch = () => appSearchInputRef.current?.focus();
    const timers = [0, 60, 180, 400].map((ms) => window.setTimeout(focusSearch, ms));
    const handleWindowFocus = () => focusSearch();
    window.addEventListener("focus", handleWindowFocus);
    void getCurrentWindow().setFocus().catch(() => undefined);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, []);

  // 热键重复按（面板已展开时）也要把焦点拉回搜索框。
  useEffect(() => {
    const focusSearch = () => appSearchInputRef.current?.focus();
    window.addEventListener("maltese-focus-app-search", focusSearch);
    return () => window.removeEventListener("maltese-focus-app-search", focusSearch);
  }, []);

  useEffect(() => {
    if (!clearAllArmed) {
      return;
    }
    const timer = window.setTimeout(() => setClearAllArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [clearAllArmed]);

  useEffect(() => {
    void invoke<string>("set_wake_shortcut", { shortcut: loadWakeShortcut() })
      .then((registered) => saveWakeShortcut(registered))
      .catch(() => undefined);
  }, []);
  // 快捷方式列表默认只扫描桌面；设置扫描目录后只扫描该目录。
  useEffect(() => {
    setScanError("");
    if (!autoDetectShortcuts) {
      setDiscoveredShortcuts([]);
      return;
    }
    void invoke<Array<{ label: string; path: string; kind: string; category: string }>>(
      "discover_shortcuts",
      { scanDir: scanDir || null },
    )
      .then(setDiscoveredShortcuts)
      .catch((error) => {
        setDiscoveredShortcuts([]);
        setScanError(String(error));
      });
  }, [autoDetectShortcuts, scanDir]);

  useEffect(() => {
    const sync = () => {
      const next = loadShortcutScanDir();
      setScanDir(next);
      setScanDraft(next);
      setAutoDetectShortcuts(loadShortcutAutoDetect());
    };
    const syncAuto = () => setAutoDetectShortcuts(loadShortcutAutoDetect());
    window.addEventListener("storage", sync);
    window.addEventListener(SHORTCUT_SCAN_DIR_EVENT, sync);
    window.addEventListener(SHORTCUT_AUTO_DETECT_EVENT, syncAuto);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SHORTCUT_SCAN_DIR_EVENT, sync);
      window.removeEventListener(SHORTCUT_AUTO_DETECT_EVENT, syncAuto);
    };
  }, []);

  useEffect(() => {
    const query = appQuery.trim();
    if (!query) {
      setAppResults([]);
      setAppSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAppSearching(true);
      void (async () => {
        // 文件型快捷方式（桌面/开始菜单的 .lnk、.exe）+ Windows 登记的应用（含商店应用）。
        const [fileResults, startApps] = await Promise.all([
          invoke<Array<{ label: string; path: string; kind: string; category: string }>>(
            "discover_installed_apps",
            { query },
          ).catch(() => []),
          invoke<Array<{ label: string; appId: string }>>("discover_start_apps", {
            query,
          }).catch(() => []),
        ]);
        const known = new Set(fileResults.map((item) => item.label.toLowerCase()));
        const storeResults = startApps
          .filter((app) => !known.has(app.label.toLowerCase()))
          .map((app) => ({
            label: app.label,
            // shell:AppsFolder 的启动方式需要单独命令，这里用前缀标记。
            path: `app:${app.appId}`,
            kind: "appx",
            category: "store",
          }));
        return [...fileResults, ...storeResults];
      })()
        .then((results) => {
          if (!cancelled) setAppResults(results);
        })
        .finally(() => {
          if (!cancelled) setAppSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [appQuery]);
  // 读取快捷方式图标（.lnk / exe / 脚本）
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    const paths = [...new Set([
      ...discoveredShortcuts.map((shortcut) => shortcut.path),
      ...customShortcuts.map((shortcut) => shortcut.path),
    ])].filter((path) => !path.startsWith("app:")).slice(0, 30);
    void Promise.all(paths.map(async (path) => {
      try {
        const icon = await invoke<string | null>("get_shortcut_icon", { path });
        return [path, icon] as const;
      } catch {
        return [path, null] as const;
      }
    })).then((entries) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, string> = {};
      for (const [path, icon] of entries) {
        if (icon) {
          next[path] = icon;
        }
      }
      setIcons(next);
    });
    return () => {
      cancelled = true;
    };
  }, [customShortcuts, discoveredShortcuts]);

  const persistCustomShortcuts = (next: CustomShortcut[]) => {
    setCustomShortcuts(next);
    try {
      window.localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(next));
    } catch {
      // 忽略写入失败
    }
  };

  const persistHiddenShortcuts = (next: string[]) => {
    const unique = [...new Set(next.map(shortcutPathKey))].slice(0, 200);
    setHiddenShortcuts(unique);
    try {
      window.localStorage.setItem(HIDDEN_SHORTCUTS_KEY, JSON.stringify(unique));
    } catch {
      // 忽略写入失败
    }
  };

  const persistHiddenShortcutActions = (next: string[]) => {
    const unique = [...new Set(next)].slice(0, 100);
    setHiddenShortcutActions(unique);
    try {
      window.localStorage.setItem(HIDDEN_SHORTCUT_ACTIONS_KEY, JSON.stringify(unique));
    } catch {
      // 忽略写入失败
    }
  };

  const hideShortcut = (label: string, path: string) => {
    persistHiddenShortcuts([...hiddenShortcuts, path]);
    setNotice(`${label} 已从列表移除（不会删除桌面文件）`);
  };

  const hideShortcutAction = (id: string, label: string) => {
    persistHiddenShortcutActions([...hiddenShortcutActions, id]);
    setNotice(`${label} 已从快捷入口移除`);
  };

  const restoreHiddenShortcuts = () => {
    persistHiddenShortcuts([]);
    persistHiddenShortcutActions([]);
    setNotice("已恢复被隐藏的快捷方式");
  };

  const addCustomShortcut = async () => {
    // 先校验路径格式：错在哪、该写成什么样，都直接显示在输入框下面。
    const check = checkShortcutPath(draftPath);
    if (!check.ok) {
      setDraftPathError(check.message);
      return;
    }
    const path = check.normalized;
    if (customShortcuts.some((shortcut) => shortcutPathKey(shortcut.path) === shortcutPathKey(path))) {
      setDraftPathError("这个路径已经在快捷入口里了。");
      return;
    }
    // 再确认文件真的在：格式对但路径写错是最常见的情况。
    try {
      const result = await invoke<{
        exists: boolean;
        isFile: boolean;
        isDir: boolean;
        error: string | null;
      }>("check_local_path", { path });
      if (!result.exists) {
        setDraftPathError(missingPathMessage(path));
        return;
      }
      if (result.isDir) {
        setDraftPathError("这是一个文件夹，请填到具体的程序文件（例如 .exe / .lnk / .bat）。");
        return;
      }
    } catch {
      // 检查命令不可用时放行，避免挡住用户
    }
    const fallbackLabel = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    persistCustomShortcuts([...customShortcuts, { label: draftLabel.trim() || fallbackLabel, path }].slice(0, 24));
    setDraftLabel("");
    setDraftPath("");
    setDraftPathError("");
    setAdding(false);
    setNotice("已添加快捷方式");
  };

  const addSystemApp = (app: { label: string; path: string }) => {
    if (customShortcuts.some((shortcut) => shortcut.path === app.path)) {
      setNotice(`${app.label} 已经在快捷入口里`);
      return;
    }
    if (discoveredShortcuts.some((shortcut) => shortcutPathKey(shortcut.path) === shortcutPathKey(app.path))) {
      persistHiddenShortcuts([...hiddenShortcuts, app.path]);
    }
    persistCustomShortcuts([
      ...customShortcuts,
      { label: app.label, path: app.path },
    ].slice(0, 60));
    setAppQuery("");
    setAppResults([]);
    setNotice(`已添加 ${app.label}`);
  };

  const applyScanDir = () => {
    const next = saveShortcutScanDir(scanDraft);
    setScanDraft(next);
    setScanDir(next);
  };

  // 点击后立即在卡片上转圈：Rust 只负责把进程交给 shell，这里再把“从点击到
  // 系统接受启动”的耗时写进提示，至少让用户看到反馈，而不是干等。
  const runLaunch = (key: string, label: string, task: () => Promise<unknown>) => {
    setLaunchingKey(key);
    const started = performance.now();
    void task()
      .then(() => {
        const elapsed = Math.round(performance.now() - started);
        setNotice(`${label} 已打开（${elapsed} ms）`);
      })
      .catch((error) => setNotice(`${label} 打开失败：${String(error)}`))
      .finally(() => {
        const elapsed = performance.now() - started;
        // 太快返回时也保持一小段转圈，避免只闪一下看不出反馈。
        window.setTimeout(() => setLaunchingKey(null), Math.max(0, 450 - elapsed));
      });
  };

  const launchPath = (label: string, path: string) => {
    if (path.startsWith("app:")) {
      // 商店应用：交给 shell:AppsFolder 启动。
      runLaunch(path, label, () => invoke("launch_start_app", { appId: path.slice(4) }));
      return;
    }
    const isCustom = customShortcuts.some((shortcut) => shortcut.path === path);
    const command = isCustom ? "launch_custom_shortcut" : "launch_discovered_shortcut";
    runLaunch(path, label, () =>
      invoke(command, isCustom ? { path } : { path, scanDir: scanDir || null }),
    );
  };

  const handleAppSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 快捷键打开面板后不用动鼠标：直接输入，↑↓ 选，回车打开。
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (appResults.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setAppActiveIndex((current) => {
        const next = current + step;
        return (next + appResults.length) % appResults.length;
      });
      return;
    }
    if (event.key === "Escape") {
      if (appQuery) {
        event.preventDefault();
        setAppQuery("");
        setAppActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Enter") {
      const target = appActiveIndex >= 0 ? appResults[appActiveIndex] : appResults[0];
      if (target) {
        event.preventDefault();
        launchPath(target.label, target.path);
      }
    }
  };

  const actions = [
    { id: "netease", label: "网易云音乐", detail: "打开本机网易云客户端", tool: "netease" },
    { id: "doubao", label: "豆包", detail: "打开本机豆包客户端", tool: "doubao" },
    { id: "youdaodict", label: "有道词典", detail: "打开本地词典客户端", tool: "youdaodict" },
    { id: "calculator", label: "计算器", detail: "快速算一笔", tool: "calculator" },
  ];
  const hiddenShortcutSet = new Set(hiddenShortcuts);
  const hiddenActionSet = new Set(hiddenShortcutActions);
  const visibleActions = actions.filter((action) => !hiddenActionSet.has(action.id));
  const discoveredActions = discoveredShortcuts
    .filter((shortcut) => !hiddenShortcutSet.has(shortcutPathKey(shortcut.path)));
  const removableShortcutCount =
    visibleActions.length +
    discoveredShortcuts.filter((shortcut) => !hiddenShortcutSet.has(shortcutPathKey(shortcut.path))).length +
    customShortcuts.length;

  useEffect(() => {
    if (!recordingPanelHotkey) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingPanelHotkey(false);
        return;
      }
      if (event.repeat) return;
      const combo = formatShortcutFromEvent(event);
      if (!combo) {
        setPanelHotkeyError(t.assistant.panelHotkeyModifierRequired);
        return;
      }
      setRecordingPanelHotkey(false);
      void invoke<string>("set_shortcut_panel_hotkey", { shortcut: combo })
        .then((registered) => {
          setPanelHotkey(registered);
          saveShortcutPanelHotkey(registered);
          setPanelHotkeyError("");
          setNotice(t.assistant.panelHotkeySet(registered));
        })
        .catch((error) => setPanelHotkeyError(String(error)));
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingPanelHotkey, t.assistant.panelHotkeyModifierRequired, t.assistant.panelHotkeySet]);

  const clearPanelHotkey = () => {
    if (!panelHotkey) return;
    void invoke("set_shortcut_panel_hotkey", { shortcut: "" })
      .then(() => {
        setPanelHotkey("");
        saveShortcutPanelHotkey("");
        setPanelHotkeyError("");
        setNotice(t.assistant.panelHotkeyCleared);
      })
      .catch((error) => setPanelHotkeyError(String(error)));
  };

  const clearAllShortcuts = () => {
    if (!removableShortcutCount) {
      return;
    }
    if (!clearAllArmed) {
      setClearAllArmed(true);
      setNotice(t.assistant.clearAllHint(removableShortcutCount));
      return;
    }
    // 自动发现项只写隐藏列表，自定义项清空 localStorage；两者都不碰真实文件。
    persistHiddenShortcuts([
      ...hiddenShortcuts,
      ...discoveredShortcuts.map((shortcut) => shortcut.path),
    ]);
    persistHiddenShortcutActions([
      ...hiddenShortcutActions,
      ...actions.map((action) => action.id),
    ]);
    persistCustomShortcuts([]);
    setClearAllArmed(false);
    setAdding(false);
    setNotice(t.assistant.clearAllDone(removableShortcutCount));
  };

  const handleAction = (tool: string, label: string) => {
    runLaunch(`tool:${tool}`, label, () => invoke("launch_tool", { tool }));
  };

  // 只有拿到真实程序图标时才占一个图标位；没有图标就让文字铺满卡片，
  // 不再显示“哔/抖/链”这类占地方的单字占位块。
  const renderIcon = (path: string) =>
    icons[path]
      ? <span className="assistant-card__emoji" aria-hidden="true"><img src={icons[path]} alt="" draggable={false} /></span>
      : null;

  return (
    <section ref={panelRef} className="assistant-panel" aria-label="Maltese 快捷面板">
      <div className="assistant-panel__head">
        <span className="assistant-panel__notice">{notice}</span>
        <div className="assistant-panel__head-actions">
          <button
            type="button"
            className="assistant-panel__settings"
            onClick={() => {
              void invoke("open_settings_window").catch(() => setNotice("设置窗口打开失败，可在桌宠右键菜单里重试"));
            }}
          >
            设置
          </button>
        </div>
      </div>
      <div className="assistant-panel__app-search">
        <span className="assistant-panel__label">搜索应用直接打开</span>
        <input
          ref={appSearchInputRef}
          value={appQuery}
          onChange={(event) => setAppQuery(event.currentTarget.value)}
          onKeyDown={handleAppSearchKeyDown}
          placeholder="输入应用名，↑↓ 选择，回车打开"
          spellCheck={false}
        />
        {appQuery.trim() && (
          <div className="assistant-panel__app-results">
            {appSearching ? (
              <small>正在搜索系统应用…</small>
            ) : appResults.length > 0 ? (
              appResults.slice(0, 12).map((app, index) => (
                <button
                  key={app.path}
                  type="button"
                  className={index === appActiveIndex ? "assistant-panel__app-result--active" : undefined}
                  onMouseEnter={() => setAppActiveIndex(index)}
                  onClick={() => addSystemApp(app)}
                  title={app.path}
                >
                  <span>{app.label}</span>
                  <small>
                    {app.kind === "lnk"
                      ? "开始菜单"
                      : app.kind === "appx"
                        ? "商店应用"
                        : `.${app.kind}`}
                  </small>
                  <strong>＋</strong>
                </button>
              ))
            ) : (
              <small>没有找到匹配的系统应用</small>
            )}
          </div>
        )}
      </div>
      <div className="assistant-panel__section-head">
        <span>快捷方式</span>
        <div className="assistant-panel__section-meta">
          {hiddenShortcuts.length + hiddenShortcutActions.length > 0 && (
            <button
              type="button"
              className="assistant-panel__restore"
              onClick={restoreHiddenShortcuts}
            >
              恢复隐藏（{hiddenShortcuts.length + hiddenShortcutActions.length}）
            </button>
          )}
          {removableShortcutCount > 0 && (
            <button
              type="button"
              className={`assistant-panel__clear-all${clearAllArmed ? " assistant-panel__clear-all--armed" : ""}`}
              title={t.assistant.clearAllHint(removableShortcutCount)}
              onClick={clearAllShortcuts}
            >
              {clearAllArmed ? t.assistant.clearAllConfirm : t.assistant.clearAll}
            </button>
          )}
        </div>
      </div>
      <div className="assistant-panel__grid">
        {visibleActions.map((action) => (
          <div key={action.id} className="assistant-card assistant-card--custom">
            <button
              type="button"
              className="assistant-card__launch"
              data-window-drag="false"
              disabled={launchingKey === `tool:${action.id}`}
              onClick={() => handleAction(action.tool, action.label)}
            >
              <span className="assistant-card__copy">
                <strong>{action.label}</strong>
                <small>{launchingKey === `tool:${action.id}` ? "正在启动…" : action.detail}</small>
              </span>
              {launchingKey === `tool:${action.id}` ? (
                <Loader2 className="assistant-card__spin" size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="assistant-card__remove"
              title="从快捷入口移除"
              aria-label={`从快捷入口移除 ${action.label}`}
              onClick={() => hideShortcutAction(action.id, action.label)}
            >
              ×
            </button>
          </div>
        ))}
        {discoveredActions.map((shortcut) => (
          <div key={shortcut.path} className="assistant-card assistant-card--custom">
            <button
              type="button"
              className="assistant-card__launch"
              data-window-drag="false"
              disabled={launchingKey === shortcut.path}
              onClick={() => launchPath(shortcut.label, shortcut.path)}
            >
              {renderIcon(shortcut.path)}
              <span className="assistant-card__copy">
                <strong title={shortcut.label}>{shortcut.label}</strong>
                <small title={shortcut.path}>
                  {launchingKey === shortcut.path
                    ? "正在启动…"
                    : shortcut.kind === "lnk"
                      ? "桌面快捷方式"
                      : `自动发现 · .${shortcut.kind}`}
                </small>
              </span>
              {launchingKey === shortcut.path ? (
                <Loader2 className="assistant-card__spin" size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="assistant-card__remove"
              title="从列表移除（不删除桌面文件）"
              aria-label={`从列表移除 ${shortcut.label}`}
              onClick={() => hideShortcut(shortcut.label, shortcut.path)}
            >
              ×
            </button>
          </div>
        ))}
        {customShortcuts.map((shortcut) => (
          <div key={`custom-${shortcut.path}`} className="assistant-card assistant-card--custom">
            <button
              type="button"
              className="assistant-card__launch"
              disabled={launchingKey === shortcut.path}
              onClick={() => launchPath(shortcut.label, shortcut.path)}
            >
              {renderIcon(shortcut.path)}
              <span className="assistant-card__copy">
                <strong title={shortcut.label}>{shortcut.label}</strong>
                <small title={shortcut.path}>
                  {launchingKey === shortcut.path ? "正在启动…" : "自定义快捷方式"}
                </small>
              </span>
              {launchingKey === shortcut.path ? (
                <Loader2 className="assistant-card__spin" size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="assistant-card__remove"
              title="删除这个快捷方式"
              aria-label="删除这个快捷方式"
              onClick={() => persistCustomShortcuts(customShortcuts.filter((item) => item.path !== shortcut.path))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="assistant-panel__manage">
        <div className="assistant-panel__section-head">
          <span>添加与设置</span>
          <div className="assistant-panel__section-meta">
            <button
              type="button"
              className="assistant-panel__add"
              onClick={() => setAdding((value) => !value)}
            >
              {adding ? "取消" : "＋ 新增快捷方式"}
            </button>
          </div>
        </div>
        {adding && (
          <div className="assistant-panel__add-form">
            <input
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.currentTarget.value)}
              placeholder="名称（可选）"
            />
            <input
              value={draftPath}
              className={draftPathError ? "assistant-panel__add-input is-error" : "assistant-panel__add-input"}
              aria-invalid={Boolean(draftPathError)}
              aria-describedby={draftPathError ? "shortcut-path-error" : undefined}
              onChange={(event) => {
                setDraftPath(event.currentTarget.value);
                if (draftPathError) setDraftPathError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addCustomShortcut();
              }}
              placeholder="程序或脚本路径，例如 C:\\Tools\\tool.exe"
            />
            <button type="button" onClick={() => void addCustomShortcut()}>添加</button>
            {draftPathError && (
              <p className="assistant-panel__add-error" id="shortcut-path-error" role="alert">
                {draftPathError}
              </p>
            )}
          </div>
        )}
        <div className="assistant-panel__panel-hotkey">
          <span className="assistant-panel__label">{t.assistant.panelHotkey}</span>
          <button
            type="button"
            className={`assistant-panel__hotkey-button${recordingPanelHotkey ? " assistant-panel__hotkey-button--recording" : ""}${panelHotkeyError ? " assistant-panel__hotkey-button--error" : ""}`}
            title={panelHotkeyError || t.assistant.panelHotkeyHint}
            aria-label={t.assistant.panelHotkeyHint}
            onClick={() => {
              setPanelHotkeyError("");
              setRecordingPanelHotkey(true);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              clearPanelHotkey();
            }}
          >
            {recordingPanelHotkey
              ? t.assistant.panelHotkeyRecording
              : panelHotkey || t.assistant.panelHotkeyEmpty}
          </button>
          <small role={panelHotkeyError ? "alert" : undefined}>
            {panelHotkeyError || t.assistant.panelHotkeyHint}
          </small>
        </div>
        <div className="assistant-panel__scan-dir">
          <label className="assistant-panel__scan-toggle">
            <input
              type="checkbox"
              checked={autoDetectShortcuts}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoDetectShortcuts(next);
                saveShortcutAutoDetect(next);
              }}
            />
            <span>自动识别快捷方式</span>
          </label>
          <span className="assistant-panel__label">自动扫描目录</span>
          <div className="assistant-panel__scan-row">
            <input
              value={scanDraft}
              disabled={!autoDetectShortcuts}
              onChange={(event) => setScanDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyScanDir();
              }}
              placeholder="留空只扫描桌面，或填一个快捷方式目录"
              spellCheck={false}
            />
            <button type="button" disabled={!autoDetectShortcuts} onClick={applyScanDir}>扫描</button>
          </div>
          <small className={scanError ? "assistant-panel__scan-error" : undefined}>
            {!autoDetectShortcuts
              ? "自动识别已关闭；只保留自定义快捷方式。"
              : scanError || (scanDir ? `只扫描：${scanDir}` : "读取桌面和系统开始菜单，不扫描 Program Files。")}
          </small>
        </div>
      </div>
    </section>
  );
}

function IslandApp({
  locale,
  onLocaleChange,
}: {
  locale: LocaleCode;
  onLocaleChange: (locale: LocaleCode) => void;
}) {
  const t = useTranslation();
  const proactiveCharacter = usePetCharacter();
  const [mode, setMode] = useState<IslandMode>("collapsed");
  const [isTucked, setIsTucked] = useState(false);
  const qqNotifications = useQQNotifications(mode === "collapsed" && !isTucked);
  const wechatReminders = useWeChatReminders(mode === "collapsed" && !isTucked);
  const qqMail = useQQMail(mode === "collapsed" && !isTucked);
  const [messageSource, setMessageSource] = useState<MessageView>("qq");
  const [isPositionDetached, setIsPositionDetached] = useState(() => loadIslandPosition() !== null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [page, setPage] = useState<IslandPage>("todo");
  const [onboardingOpen, setOnboardingOpen] = useState(() => isTauri() && !isOnboardingDone());
  useEffect(() => {
    if (onboardingOpen) {
      setMode("expanded");
      setPage("onboarding");
    }
  }, [onboardingOpen]);
  const finishOnboarding = useCallback(() => {
    markOnboardingDone();
    setOnboardingOpen(false);
    setMode("collapsed");
  }, []);
  const [mediaState, setMediaState] =
    useState<MediaState>(DEFAULT_MEDIA_STATE);
  // 前台程序类型（用来判断是不是在看视频）。系统媒体会话对浏览器经常只报
  // Unknown，光靠 PlaybackType 认不出视频，所以这里补一份前台窗口类型。
  const [activeActivityKind, setActiveActivityKind] = useState("");
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    const tick = () => {
      void invoke<{ kind: string }>("get_active_activity")
        .then((info) => {
          if (!cancelled) setActiveActivityKind(info?.kind ?? "");
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 判定「现在播的是视频而不是音乐」。三道依据按可靠性排序：
  // 1) 系统明确上报 Video / Image；
  // 2) 前台是浏览器且这段媒体没有歌手信息（浏览器播视频通常只有标题）；
  // 3) 前台窗口类型已经是 video（B 站客户端、播放器、全屏视频页）。
  const mediaLooksLikeVideo = useMemo(() => {
    if (mediaState.mediaKind === "video" || mediaState.mediaKind === "image") {
      return true;
    }
    const source = (mediaState.sourceApp ?? "").toLowerCase();
    const browserSource =
      /chrome|edge|firefox|brave|opera|360|qqbrowser|sogou|arc/.test(source);
    // 有些浏览器把「网站名」塞进 artist 字段，这种也不算歌手。
    const artistText = (mediaState.artist ?? "").trim();
    const artistIsSiteName =
      artistText === "" ||
      /^(youtube|bilibili|哔哩哔哩|netflix|爱奇艺|iqiyi|腾讯视频|优酷|youku|抖音|douyin|微博|weibo|vimeo|twitch)$/i.test(
        artistText,
      );
    if (browserSource && artistIsSiteName) {
      return true;
    }
    if (activeActivityKind === "video") {
      return true;
    }
    return false;
  }, [activeActivityKind, mediaState.artist, mediaState.mediaKind, mediaState.sourceApp]);

  // 播视频时不要拉歌词：浏览器播视频也会上报「正在播放 + 时长」，
  // 之前会把它当音乐去搜歌词，出现视频配歌词的错乱。
  const lyrics = useLyrics(
    mediaState.title,
    mediaState.artist,
    mediaState.positionMs,
    mediaState.available && mediaState.durationMs > 0 && !mediaLooksLikeVideo,
  );
  const [isMediaTrackChanging, setIsMediaTrackChanging] = useState(false);
  const [mediaCommandError, setMediaCommandError] = useState<string | null>(
    null,
  );
  const [musicSourcePriority, setMusicSourcePriority] = useState<
    KnownMediaSource[]
  >(loadMusicSourcePriority);
  const [musicSettingsOpen, setMusicSettingsOpen] = useState(false);
  const mediaTargetRef = useRef<string | null>(null);
  const [agentStatus, setAgentStatus] =
    useState<AgentStatusSnapshot>(DEFAULT_AGENT_STATUS);
  const [petAction, setPetAction] = useState<PetAction | null>(null);
  const [activityMood, setActivityMood] = useState<PetState | null>(null);
  const activityMoodTimer = useRef<number | null>(null);
  const petActionTimer = useRef<number | null>(null);
  const isRefreshingAgentStatus = useRef(false);
  const isRefreshingMediaState = useRef(false);
  const isRefreshingAudioLevel = useRef(false);
  const isRunningMediaCommand = useRef(false);
  const mediaPlaybackIntent = useRef<{
    status: MediaPlaybackStatus;
    expiresAt: number;
  } | null>(null);
  const [settings, setSettings] = useState<IslandSettings>(loadSettings);
  const showActivityMood = useCallback((mood: PetState | undefined) => {
    if (!mood) {
      return;
    }
    setActivityMood(mood);
    if (activityMoodTimer.current !== null) {
      window.clearTimeout(activityMoodTimer.current);
    }
    activityMoodTimer.current = window.setTimeout(() => {
      activityMoodTimer.current = null;
      setActivityMood(null);
    }, 9000);
  }, []);

  const soundOnRef = useRef(settings.soundOn);
  useEffect(() => {
    soundOnRef.current = settings.soundOn;
  }, [settings.soundOn]);

  const [nativeGlassState, setNativeGlassState] =
    useState<NativeGlassState>("disabled");
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [settingPresets, setSettingPresets] = useState<IslandPreset[]>(() =>
    loadSettingPresets(t),
  );
  const [todos, setTodos] = useState<TodoItem[]>(loadTodos);
  const [dailyNote, setDailyNote] = useState(loadDailyNote);
  const [diaryEvents, setDiaryEvents] = useState<DiaryEvent[]>(loadDiaryEvents);
  const [draftTodo, setDraftTodo] = useState("");
  const [activeTodoId, setActiveTodoId] = useState<string | null>(
    loadActiveTodoId,
  );
  const [currentTodoDate, setCurrentTodoDate] =
    useState<string>(loadCurrentTodoDate);
  const [archives, setArchives] = useState<TodoArchive[]>(loadTodoArchives);
  const [todoPageMode, setTodoPageMode] = useState<TodoPageMode>("today");
  const [archiveLayout, setArchiveLayout] = useState<ArchiveLayout>("cards");
  const [selectedArchiveDate, setSelectedArchiveDate] = useState<string | null>(
    null,
  );
  const [saveDirectory, setSaveDirectory] = useState(loadSaveDirectory);
  const [saveDirectoryDraft, setSaveDirectoryDraft] =
    useState(loadSaveDirectory);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savePathState, setSavePathState] = useState<SavePathState>("idle");
  const [clipboardHistory, setClipboardHistory] =
    useState<ClipboardHistorySnapshot>(DEFAULT_CLIPBOARD_HISTORY);
  const [agentHooksInstallState, setAgentHooksInstallState] =
    useState<AgentHooksInstallState>("idle");
  const [agentHooksInstallResult, setAgentHooksInstallResult] =
    useState<AgentHooksInstallResult | null>(null);
  const [agentHooksInstallError, setAgentHooksInstallError] = useState("");
  const [clearingAgentProvider, setClearingAgentProvider] =
    useState<AgentProvider | null>(null);
  const shouldInitializeDefaultSaveDirectory = useRef(
    window.localStorage.getItem(TODO_SAVE_DIRECTORY_STORAGE_KEY) === null,
  );
  const defaultSaveDirectoryRequestInFlight = useRef(false);
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveRequestId = useRef(0);
  const saveStateResetTimer = useRef<number | null>(null);
  const didHydrateAutoSave = useRef(false);
  const didCheckDate = useRef(false);
  const didShowInitialWindow = useRef(false);
  const islandPositionRef = useRef<IslandPosition | null>(loadIslandPosition());
  const selectedArchive =
    archives.find((archive) => archive.date === selectedArchiveDate) ?? null;
  const pendingTodoIds = useMemo(
    () => todos.filter((todo) => !todo.completed).map((todo) => todo.id),
    [todos],
  );
  const displayedTodoId = useTodoRotation(
    pendingTodoIds,
    activeTodoId,
    settings.rotateTodos,
    settings.todoRotationSeconds,
    mode !== "collapsed" || isTucked || !settings.showCollapsedText ||
      Boolean(qqNotifications.preview || wechatReminders.previewReceivedAt !== null || qqMail.preview),
  );
  const collapsedTaskTitle = useMemo(() => {
    const activeTodo = todos.find(
      (todo) => todo.id === displayedTodoId && !todo.completed,
    );
    return activeTodo?.title ?? null;
  }, [displayedTodoId, todos]);
  // 悬停气泡只展示“已经点过开始”的那一条，而不是轮播中的任意待办。
  const activeTodo = useMemo(
    () =>
      todos.find((todo) => todo.id === activeTodoId && !todo.completed) ?? null,
    [activeTodoId, todos],
  );
  const activeTodoTitle = activeTodo?.title ?? null;
  const collapsedTodoCount = settings.showIdleTodoCount && !collapsedTaskTitle
    ? todos.filter((todo) => !todo.completed).length
    : null;
  const collapsedIslandWidth = useMemo(
    () =>
      getCollapsedIslandWidth(
        settings.showCollapsedText
          ? collapsedTaskTitle ?? (collapsedTodoCount !== null
            ? t.island.pendingTodos(collapsedTodoCount)
            : settings.showTitle ? "Maltese" : "")
          : "",
      ),
    [collapsedTaskTitle, collapsedTodoCount, settings.showCollapsedText, settings.showTitle, t],
  );
  const isTodoArchivePage =
    page === "todo" && (todoPageMode === "archive" || todoPageMode === "review");
  const visibleTodoRows = Math.min(
    Math.max(
      todoPageMode === "daily" || isTodoArchivePage
        ? TODO_GROW_START_ROWS
        : getTodoVisualRows(todos),
      1,
    ),
    TODO_SCROLL_START_ROWS,
  );
  const expandedIslandHeight =
    page === "todo"
      ? isTodoArchivePage
        ? TODO_ARCHIVE_EXPANDED_ISLAND_HEIGHT
        : BASE_EXPANDED_ISLAND_HEIGHT +
          Math.max(0, visibleTodoRows - TODO_GROW_START_ROWS) * TODO_ROW_HEIGHT
      : page === "music"
        ? musicSettingsOpen
          ? MUSIC_SETTINGS_EXPANDED_ISLAND_HEIGHT
          : MUSIC_EXPANDED_ISLAND_HEIGHT + (mediaCommandError ? 24 : 0)
        : page === "clipboard"
          ? CLIPBOARD_EXPANDED_ISLAND_HEIGHT
          : page === "assistant"
            ? 520
          : page === "chat"
            ? settings.chatPanelHeight
          : page === "video"
            ? 430
          : page === "qq"
            ? messagePanelHeight(messageSource, Boolean(qqMail.selectedMail))
            : EDITOR_EXPANDED_ISLAND_HEIGHT;
  const layoutSync = useRef<{
    frame: number | null;
    inFlight: boolean;
    pending: IslandSettings;
    active: IslandSettings;
  }>({
    frame: null,
    inFlight: false,
    pending: settings,
    active: settings,
  });

  const stageStyle = useMemo(
    () => {
      const glassStrength = settings.glassIntensity / 100;
      const glassMaskOpacity = settings.opacity / 100;

      return ({
        "--island-opacity": settings.opacity / 100,
        "--pet-opacity": settings.petOpacity / 100,
        "--island-scale": mode === "collapsed" ? settings.collapsedScale : settings.expandedScale,
        // 小狗本体尺寸永远跟随“收起大小”，展开面板时也不变。
        "--pet-scale": settings.collapsedScale,
        "--collapsed-island-width": `${collapsedIslandWidth}px`,
        "--expanded-island-height": `${expandedIslandHeight}px`,
        "--task-text-color": settings.taskTextColor,
        "--pet-bubble-text": settings.bubbleTextColor,
        "--island-pulse-color": settings.pulseColor,
        "--island-pulse-glow-color": hexToRgba(settings.pulseColor, 0.72),
        "--island-pulse-brightness": `${settings.pulseBrightness}%`,
        "--island-background-color": settings.islandBackgroundColor,
        "--glass-intensity": glassStrength,
        "--glass-mask-opacity": glassMaskOpacity,
        "--glass-soft-alpha": 0.045 + glassStrength * 0.045,
        "--glass-shadow-alpha": 0.14 + glassStrength * 0.1,
        "--glass-inset-alpha": 0.2 + glassStrength * 0.2,
        "--glass-cyan-alpha": glassStrength * 0.16,
        "--glass-magenta-alpha": glassStrength * 0.1,
        "--glass-glow-alpha": 0.16 + glassStrength * 0.14,
        "--glass-accent-alpha": glassStrength * 0.055,
        "--glass-refraction-opacity": 0.45 + glassStrength * 0.38,
        "--glass-border-alpha": 0.1 + glassStrength * 0.18,
        "--glass-inner-accent-alpha": glassStrength * 0.08,
        "--glass-highlight-opacity": 0.34 + glassStrength * 0.38,
        "--glass-panel-accent-alpha": glassStrength * 0.085,
        "--glass-panel-blur": `${10 + glassStrength * 9}px`,
        "--glass-tint-color": hexToRgba(
          settings.islandBackgroundColor,
          glassMaskOpacity,
        ),
        "--glass-collapsed-tint-color": hexToRgba(
          settings.islandBackgroundColor,
          glassMaskOpacity,
        ),
        "--todo-background-color": settings.todoBackgroundColor,
      }) as CSSProperties;
    },
    [
      expandedIslandHeight,
      collapsedIslandWidth,
      mode,
      settings.glassIntensity,
      settings.islandBackgroundColor,
      settings.opacity,
      settings.petOpacity,
      settings.bubbleTextColor,
      settings.pulseBrightness,
      settings.pulseColor,
      settings.collapsedScale,
      settings.expandedScale,
      settings.taskTextColor,
      settings.todoBackgroundColor,
    ],
  );

  const syncNativeLayout = useCallback(async (nextSettings: IslandSettings) => {
    try {
      await invoke("set_island_layout", {
        layout: {
          collapsedScale: nextSettings.collapsedScale,
          expandedScale: nextSettings.expandedScale,
          marginY: nextSettings.marginY,
          tuckedVisibleHeight: nextSettings.tuckedVisibleHeight,
        },
      });
    } catch (error) {
      console.error("Failed to sync island layout", error);
    }
  }, []);

  const flushNativeLayout = useCallback(() => {
    const syncState = layoutSync.current;

    if (syncState.inFlight) {
      return;
    }

    const nextSettings = syncState.pending;
    syncState.active = nextSettings;
    syncState.inFlight = true;

    void syncNativeLayout(nextSettings).finally(() => {
      const latestState = layoutSync.current;
      latestState.inFlight = false;

      if (latestState.pending !== latestState.active) {
        latestState.frame = window.requestAnimationFrame(() => {
          latestState.frame = null;
          flushNativeLayout();
        });
      }
    });
  }, [syncNativeLayout]);

  const scheduleNativeLayout = useCallback(
    (nextSettings: IslandSettings) => {
      const syncState = layoutSync.current;
      syncState.pending = nextSettings;

      if (syncState.frame !== null || syncState.inFlight) {
        return;
      }

      syncState.frame = window.requestAnimationFrame(() => {
        syncState.frame = null;
        flushNativeLayout();
      });
    },
    [flushNativeLayout],
  );

  const syncNativeInteraction = useCallback(
    async (
      nextMode: IslandMode,
      nextSettings: IslandSettings,
      nextExpandedHeight: number,
      nextCollapsedWidth: number,
      nextIsTucked: boolean,
    ) => {
      try {
        const glassState = await invoke<NativeGlassState>(
          "set_island_interaction",
          {
          mode: nextMode,
          collapsedScale: nextSettings.collapsedScale,
          expandedScale: nextSettings.expandedScale,
          marginY: nextSettings.marginY,
          expandedHeight: nextExpandedHeight,
          collapsedWidth: nextCollapsedWidth,
          customPosition: islandPositionRef.current,
          tuckedVisibleHeight: nextSettings.tuckedVisibleHeight,
          isTucked: nextIsTucked,
          animatePosition: !reducedMotion,
            glassEnabled: nextSettings.appearanceMode === "liquidGlass",
            glassIntensity: nextSettings.glassIntensity,
            glassTint: nextSettings.islandBackgroundColor,
          },
        );
        setNativeGlassState(glassState);
      } catch (error) {
        console.error("Failed to sync island interaction", error);
        setNativeGlassState(
          nextSettings.appearanceMode === "liquidGlass"
            ? "css-fallback"
            : "disabled",
        );
      }
    },
    [reducedMotion],
  );

  const showReadyIsland = useCallback(async () => {
    if (didShowInitialWindow.current) {
      return;
    }

    didShowInitialWindow.current = true;

    try {
      await invoke("show_ready_island");
    } catch (error) {
      console.error("Failed to show island", error);
    }
  }, []);

  const refreshClipboardHistory = useCallback(async () => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "get_clipboard_history",
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to read clipboard history", error);
    }
  }, []);

  const refreshAgentStatus = useCallback(async () => {
    if (isRefreshingAgentStatus.current) {
      return;
    }

    isRefreshingAgentStatus.current = true;
    try {
      const snapshot = await invoke<AgentStatusSnapshot>("get_agent_status");
      setAgentStatus((currentState) =>
        currentState.statusPath === snapshot.statusPath &&
        AGENT_PROVIDERS.every((provider) =>
          currentState[provider].phase === snapshot[provider].phase &&
          currentState[provider].taskId === snapshot[provider].taskId,
        )
          ? currentState
          : snapshot,
      );
    } catch (error) {
      console.error("Failed to read agent status", error);
      setAgentStatus(DEFAULT_AGENT_STATUS);
    } finally {
      isRefreshingAgentStatus.current = false;
    }
  }, []);

  const clearAgentStatus = useCallback(async (provider: AgentProvider) => {
    setClearingAgentProvider(provider);
    try {
      const snapshot = await invoke<AgentStatusSnapshot>("clear_agent_status", {
        provider,
      });
      setAgentStatus(snapshot);
    } catch (error) {
      console.error("Failed to clear agent status", error);
    } finally {
      setClearingAgentProvider(null);
    }
  }, []);

  const updateClipboardSettings = useCallback(
    async (nextSettings: ClipboardHistorySettings) => {
      const normalizedSettings = normalizeClipboardSettings(nextSettings);

      setClipboardHistory((currentHistory) => ({
        ...currentHistory,
        settings: normalizedSettings,
      }));

      try {
        const snapshot = await invoke<ClipboardHistorySnapshot>(
          "set_clipboard_history_settings",
          { settings: normalizedSettings },
        );
        setClipboardHistory(snapshot);
      } catch (error) {
        console.error("Failed to update clipboard history settings", error);
        void refreshClipboardHistory();
      }
    },
    [refreshClipboardHistory],
  );

  const copyClipboardHistoryItem = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "copy_clipboard_history_item",
        { id },
      );
      setClipboardHistory(snapshot);
      return true;
    } catch (error) {
      console.error("Failed to copy clipboard history item", error);
      return false;
    }
  }, []);

  const toggleClipboardHistoryFavorite = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "toggle_clipboard_history_favorite",
        { id },
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to toggle clipboard history favorite", error);
    }
  }, []);

  const updateClipboardHistoryItemNote = useCallback(
    async (id: string, note: string) => {
      try {
        const snapshot = await invoke<ClipboardHistorySnapshot>(
          "set_clipboard_history_item_note",
          { id, note },
        );
        setClipboardHistory(snapshot);
        return true;
      } catch (error) {
        console.error("Failed to update clipboard history item note", error);
        return false;
      }
    },
    [],
  );

  const deleteClipboardHistoryItem = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "delete_clipboard_history_item",
        { id },
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to delete clipboard history item", error);
    }
  }, []);

  const clearClipboardHistoryItems = useCallback(async () => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "clear_clipboard_history",
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to clear clipboard history", error);
    }
  }, []);

  const minimizeIsland = useCallback(async () => {
    try {
      await invoke("minimize_island");
    } catch (error) {
      console.error("Failed to minimize island", error);
    }
  }, []);

  const startIslandDrag = useCallback(() => {
    setIsPositionDetached(true);
    void invoke("start_island_drag").catch((error) => {
      setIsPositionDetached(isPositionDetached);
      console.error("Failed to start island drag", error);
    });
  }, [isPositionDetached]);

  const resetIslandPosition = useCallback(async () => {
    try {
      const nextSettings = { ...settings, marginY: DEFAULT_SETTINGS.marginY };
      await syncNativeLayout(nextSettings);
      islandPositionRef.current = null;
      window.localStorage.removeItem(ISLAND_POSITION_STORAGE_KEY);
      if (settings.lockCorner) {
        await invoke("lock_island_corner", { corner: settings.lockCorner });
        setIsPositionDetached(true);
      } else {
        await invoke("reset_island_position");
        setIsPositionDetached(false);
      }
      setSettings(nextSettings);
    } catch (error) {
      console.error("Failed to reset island position", error);
    }
  }, [settings, syncNativeLayout]);

  const previousLockCorner = useRef<PetLockCorner | null>(null);
  useEffect(() => {
    const previous = previousLockCorner.current;
    previousLockCorner.current = settings.lockCorner;
    if (previous === settings.lockCorner) {
      return;
    }
    // 首次加载时只有选了四角才需要重新落位；默认底部居中要保留用户拖过的位置。
    if (previous === null && !settings.lockCorner) {
      return;
    }
    void resetIslandPosition();
  }, [resetIslandPosition, settings.lockCorner]);

  type TuckReason = "sleep" | "fullscreen" | "manual";
  const tuckReasonsRef = useRef<Record<TuckReason, boolean>>({
    sleep: false,
    fullscreen: false,
    manual: false,
  });

  const setIslandMode = useCallback((nextMode: IslandMode) => {
    tuckReasonsRef.current = { sleep: false, fullscreen: false, manual: false };
    setMode(nextMode);
    setIsTucked(false);
  }, []);

  const tuckIsland = useCallback((reason: TuckReason = "manual") => {
    // 这里不能走 setIslandMode：它会清空原因栈，导致“睡眠中进入全屏”后
    // 睡眠原因丢失，醒来时无法恢复。
    setMode("collapsed");
    tuckReasonsRef.current[reason] = true;
    setIsTucked(true);
  }, []);

  const revealIsland = useCallback((reason: TuckReason = "manual") => {
    tuckReasonsRef.current[reason] = false;
    if (reason === "manual") {
      tuckReasonsRef.current.fullscreen = false;
    }
    const reasons = tuckReasonsRef.current;
    if (!reasons.sleep && !reasons.fullscreen && !reasons.manual) {
      setIsTucked(false);
    }
  }, []);

  const tuckForSleep = useCallback(() => tuckIsland("sleep"), [tuckIsland]);
  const revealForSleep = useCallback(() => revealIsland("sleep"), [revealIsland]);
  const tuckForFullscreen = useCallback(() => tuckIsland("fullscreen"), [tuckIsland]);
  const revealForFullscreen = useCallback(() => revealIsland("fullscreen"), [revealIsland]);

  // 缩边只由“睡着”驱动（见 restingAsleep），闲置计时缩边不再使用。
  useFullscreenAvoid(
    settings.fullscreenAvoid,
    mode === "collapsed",
    isTucked,
    isTauri(),
    tuckForFullscreen,
    revealForFullscreen,
    settings.fullscreenHideExtras,
  );

  // ---------- 小狗侧边浮层（hover 互动面板 + 云朵消息框 + 右键菜单） ----------
  // 浮层渲染在主窗口内部，主窗口临时变宽，不再依赖额外的气泡窗口。
  const [petOverlay, setPetOverlay] = useState<PetOverlay | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // 原生算好的浮层方向（plan_island_overlay）；有值时优先于事件回传。
  const [overlayPlacement, setOverlayPlacement] = useState<
    { side: "left" | "right"; vertical: "above" | "below" } | null
  >(null);
  const petOverlayRef = useRef<PetOverlay | null>(null);
  // 用时间戳做起点，保证 WebView 重载后 generation 仍大于原生侧记录的值。
  const overlayGenerationRef = useRef(Date.now());
  const overlayHoveredRef = useRef(false);
  const overlayHideTimerRef = useRef<number | null>(null);
  const pageOpenMaskRef = useRef<number | null>(null);
  const updateState = useSyncExternalStore(subscribeToUpdate, getUpdateState);
  const shownUpdateVersionRef = useRef("");

  const applyPetOverlay = useCallback((next: PetOverlay | null) => {
    const current = petOverlayRef.current;
    // 同一个浮层换内容（例如连续消息气泡）只更新 DOM，不要反复放大/缩小原生窗口。
    // 原来每次消息都调用 set_island_overlay，窗口连续 resize 会看起来在闪。
    if (next && current && current.mode === next.mode) {
      petOverlayRef.current = next;
      setPetOverlay(next);
      setOverlayOpen(true);
      return;
    }
    overlayGenerationRef.current = Math.max(Date.now(), overlayGenerationRef.current + 1);
    const generation = overlayGenerationRef.current;
    petOverlayRef.current = next;
    if (next) {
      // 严格三步，避免中间帧：①让原生只算方向 → ②把小狗按该方向钉到窗口角上
      // （下一帧 React 提交，此时窗口还是原尺寸，画面不动）→ ③原生一次性改几何。
      void (async () => {
        let plan: { side: "left" | "right"; vertical: "above" | "below" } | null = null;
        try {
          plan = await invoke<{ side: "left" | "right"; vertical: "above" | "below" }>(
            "plan_island_overlay",
            { overlay: next.mode },
          );
        } catch {
          // 拿不到方向就退回事件回传，宁可晚一帧也不要摆错方向
        }
        if (overlayGenerationRef.current !== generation) {
          return;
        }
        // 必须同步提交：方向类和面板要在原生改几何之前就落到 DOM 上，
        // 否则窗口先变大、小狗还没钉住，中间那帧就是闪一下的来源。
        flushSync(() => {
          setOverlayPlacement(plan);
          setOverlayOpen(true);
        });
        invoke("set_island_overlay", { overlay: next.mode, generation })
          .catch(() => undefined)
          .finally(() => {
            if (overlayGenerationRef.current === generation) {
              setPetOverlay(next);
            }
          });
      })();
      return;
    }
    // 先移除面板，缩回窗口并回到原位后再取消底部锚定，小狗全程不移动。
    setPetOverlay(null);
    window.requestAnimationFrame(() => {
      if (overlayGenerationRef.current !== generation) {
        return;
      }
      void invoke("set_island_overlay", { overlay: null, generation })
        .catch(() => undefined)
        .finally(() => {
          if (overlayGenerationRef.current === generation) {
            setOverlayOpen(false);
            setOverlayPlacement(null);
          }
        });
    });
  }, []);

  // 从气泡直接切到展开页时，不再先发一次原生 close 再展开。
  // 两次窗口尺寸变化会在右键/点气泡入口时产生频闪；这里只清 UI，
  // 由 set_island_interaction 的展开几何接管窗口。
  const clearPetOverlayForPage = useCallback(() => {
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    overlayGenerationRef.current = Math.max(Date.now(), overlayGenerationRef.current + 1);
    petOverlayRef.current = null;
    setPetOverlay(null);
    setOverlayOpen(false);
    setOverlayPlacement(null);
  }, []);

  const hidePetOverlay = useCallback(() => {
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    // 没有气泡时不要再发一次原生 close：右键打开聊天时这次多余的
    // “缩回再展开”会让窗口频闪。关闭请求只在确实有浮层时发。
    if (!petOverlayRef.current) {
      return;
    }
    applyPetOverlay(null);
  }, [applyPetOverlay]);

  const showPetHoverBubble = useCallback(() => {
    if (!isTauri() || mode !== "collapsed") {
      return;
    }
    if (isTucked) {
      revealIsland();
    }
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    applyPetOverlay({ mode: "hover", todoTitle: activeTodoTitle ?? undefined });
  }, [activeTodoTitle, applyPetOverlay, isTucked, mode, revealIsland]);

  // 气泡已经打开时切换“开始”的待办，文字同步更新，不重新放大窗口。
  useEffect(() => {
    if (petOverlayRef.current?.mode !== "hover") {
      return;
    }
    const next = {
      ...petOverlayRef.current,
      todoTitle: activeTodoTitle ?? undefined,
    };
    petOverlayRef.current = next;
    setPetOverlay(next);
  }, [activeTodoTitle]);

  const scheduleBubbleHide = useCallback(() => {
    // 云朵消息按自己的 TTL 关闭，不能被小狗/浮层的一次 mouseleave 提前收掉。
    // 气泡向左弹出时窗口整体左移，更容易产生 mouseleave；旧逻辑会在 420ms
    // 后关掉气泡，看起来就是“消息有时候不显示”。
    if (petOverlayRef.current?.mode === "cloud") {
      return;
    }
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
    }
    overlayHideTimerRef.current = window.setTimeout(() => {
      if (!overlayHoveredRef.current) {
        hidePetOverlay();
      }
    }, 420);
  }, [hidePetOverlay]);

  // 展开面板或缩边时收起浮层，避免主窗口维持放大的尺寸。
  useEffect(() => {
    if (mode !== "collapsed" && petOverlayRef.current) {
      hidePetOverlay();
    }
  }, [hidePetOverlay, mode]);

  useEffect(() => {
    if (isTucked && petOverlayRef.current) {
      hidePetOverlay();
    }
  }, [hidePetOverlay, isTucked]);

  const markOverlayEnter = useCallback(() => {
    overlayHoveredRef.current = true;
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
  }, []);

  const markOverlayLeave = useCallback(() => {
    overlayHoveredRef.current = false;
    scheduleBubbleHide();
  }, [scheduleBubbleHide]);

  // 统一的云朵气泡出口：收起态才浮出；被自动缩边（tucked）时先悄悄把小狗露出来。
  const showCloudBubble = useCallback((title: string, body: string, image?: string) => {
    if (!isTauri() || !settings.bubbleOn || mode !== "collapsed") {
      return;
    }
    if (isTucked) {
      revealIsland();
    }
    void invoke("show_island_no_focus").catch(() => undefined);
    applyPetOverlay({ mode: "cloud", title, body, image });
    if (overlayHideTimerRef.current !== null) {
      window.clearTimeout(overlayHideTimerRef.current);
    }
    overlayHideTimerRef.current = window.setTimeout(() => {
      hidePetOverlay();
    }, settings.bubbleDurationMs);
  }, [applyPetOverlay, hidePetOverlay, isTucked, mode, revealIsland, settings.bubbleDurationMs, settings.bubbleOn]);

  // 让模型观察本机状态并主动说一句；说完弹云朵气泡，聊天记录里也留一条。
  // 支持两种模式：
  //   interval —— 每隔 N 分钟说一次（定时）；
  //   state    —— 只在前台程序 / 播放状态这类“情境”稳定变化后说（跟随状态）。
  // 这个 effect 的依赖必须尽量少，否则切歌/开关面板会把计时基准重置成“现在”，
  // 主动聊天就永远不到点。
  const lastProactiveChatAt = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const mediaRef = useRef(mediaState);
  mediaRef.current = mediaState;
  // 状态模式用：上一次的情境、情境开始时间、上次说过的情境。
  // 同类活动从什么时候开始，用来算「忙了多久」。
  const proactiveStreakRef = useRef<{ kind: string; since: number }>({ kind: "", since: 0 });
  const proactiveSituationRef = useRef<{ key: string; since: number; firedFor: string }>({
    key: "",
    since: 0,
    firedFor: "",
  });

  useEffect(() => {
    if (!isTauri() || !settings.proactiveChat) {
      return;
    }
    // 最近发生过什么（待办开始/完成、摸头等），让主动关心的内容有据可依。
    const recentDiaryTexts = (count: number): string[] => {
      try {
        const raw = window.localStorage.getItem("focusd-island-diary-events");
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Array<{ text?: string; at?: number }>;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter((item) => typeof item.text === "string" && item.text.trim())
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
          .slice(0, count)
          .map((item) => String(item.text).trim().slice(0, 24));
      } catch {
        return [];
      }
    };
    // 主动程度 → 冷却 / 每小时上限 / 稳定时长 / 免打扰，四件事一起生效。
    const plan = proactivePlan(settings.proactiveLevel);
    const cooldownMs = plan.cooldownMinutes * 60_000;
    const mode_ = settings.proactiveChatMode;
    if (lastProactiveChatAt.current === 0) {
      lastProactiveChatAt.current = Date.now();
    }
    const appendChat = (text: string) => {
      try {
        const key = "focusd-island-pet-chat-messages";
        const raw = window.localStorage.getItem(key);
        const list = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
        list.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: "assistant",
          text,
          at: Date.now(),
        });
        window.localStorage.setItem(key, JSON.stringify(list.slice(-200)));
      } catch {
        // 存储不可用时只弹气泡
      }
    };

    const tick = async (force = false) => {
      // 面板展开或正在聊天时先不插话，等回到挂机状态再处理。
      if (modeRef.current !== "collapsed") return;
      const now = Date.now();
      // 免打扰时段与每小时上限：手动「立即试一句」也遵守上限，但不吃静默时段。
      if (inQuietHours(plan) && !force) return;
      if (overHourlyLimit(plan, now)) return;

      let kind = "other";
      let windowTitle = "";
      try {
        const activity = await invoke<{ kind: string; process: string; title: string }>(
          "get_active_activity",
        );
        kind = activity?.kind || "other";
        windowTitle = cleanActivityTitle(activity?.title ?? "");
      } catch {
        // 忽略
      }
      const media = mediaRef.current;
      const mediaPlaying = media.playbackStatus === "playing" && Boolean(media.title);
      let idleSeconds = 0;
      try {
        idleSeconds = await invoke<number>("get_system_idle_seconds");
      } catch {
        // 忽略
      }
      // 同一类活动持续多久：用来判断「是不是忙太久了」。
      if (proactiveStreakRef.current.kind !== kind) {
        proactiveStreakRef.current = { kind, since: now };
      }
      const streakMinutes = Math.max(0, Math.round((now - proactiveStreakRef.current.since) / 60_000));
      const observe: ProactiveContext = {
        kind,
        title: windowTitle,
        mediaTitle: mediaPlaying ? `${media.title}${media.artist ? ` - ${media.artist}` : ""}` : "",
        idleSeconds,
        now: new Date(),
        streakMinutes,
        recentEvents: recentDiaryTexts(3),
        character: proactiveCharacter,
      };

      if (!force && mode_ === "state") {
        // 情境 = 前台程序类型 + 是否在播放 + 是否离开电脑。
        const situation = `${kind}|${mediaPlaying ? "playing" : "silent"}|${idleSeconds > 600 ? "away" : "here"}`;
        const state = proactiveSituationRef.current;
        if (state.key !== situation) {
          proactiveSituationRef.current = { ...state, key: situation, since: now };
          return;
        }
        // 情境要稳定 3 分钟以上才说话，避免频繁切换应用时不停打扰。
        if (now - state.since < plan.stabilityMinutes * 60_000) return;
        // 同一个情境只主动说一次，且不能突破冷却时间。
        if (state.firedFor === situation) return;
        if (now - lastProactiveChatAt.current < cooldownMs) return;
      } else if (!force && now - lastProactiveChatAt.current < cooldownMs) {
        return;
      }

      lastProactiveChatAt.current = now;
      if (!force && mode_ === "state") {
        proactiveSituationRef.current = {
          ...proactiveSituationRef.current,
          firedFor: `${kind}|${mediaPlaying ? "playing" : "silent"}|${idleSeconds > 600 ? "away" : "here"}`,
        };
      }

      // 把最近说过的话带进提示词，并要求换角度；模型不听话时再重试。
      const avoid = recentProactiveLines();
      // 每次挑一个最近最少用过的角度，避免老在「心疼你」这一套里打转。
      const angle: ProactiveAngle = pickProactiveAngle();
      // 流式生成：一有开头就把气泡弹出来，边生成边更新正文。
      // 之前是等整句生成完才弹，本机大模型要好几秒，看起来就是「回话后很久才冒出气泡」。
      const onFirstTextRef = { fired: false };
      const bubbleTitle =
        observe.kind === "code"
          ? "小狗在旁边"
          : observe.kind === "video" || observe.kind === "browser"
            ? "小狗也在看"
            : observe.kind === "meeting"
              ? "陪你开会"
              : "小狗想你了";
      const askOnce = async (extra: string, silent = false) => {
        const prompt = buildProactivePrompt(observe, avoid, angle) + extra;
        const config = loadLocalChatConfig();
        if (config.backend === "local" && config.model) {
          const requestId = `proactive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let streamed = "";
          // 先把监听装好，保证第一个字就能拿到。
          const unlisten = await listen<{ requestId: string; kind: string; text: string }>(
            "local-chat-stream",
            (event) => {
              if (event.payload.requestId !== requestId) return;
              if (event.payload.kind !== "delta") return;
              streamed += event.payload.text;
              if (silent) return;
              // 够 6 个字就先把气泡弹出来（标题按场景），后面继续补全。
              if (!onFirstTextRef.fired && streamed.trim().length >= 6) {
                onFirstTextRef.fired = true;
                const partial = streamed.trim().replace(/^["「『]/, "");
                showCloudBubble(bubbleTitle, partial);
              } else if (onFirstTextRef.fired) {
                const partial = streamed.trim().replace(/^["「『]/, "");
                if (partial) {
                  // 同一个 mode 只更新 DOM，不会反复调整窗口。
                  applyPetOverlay({ mode: "cloud", title: bubbleTitle, body: partial });
                }
              }
            },
          );
          try {
            const text = await invoke<string>("local_chat_stream", {
              requestId,
              baseUrl: config.baseUrl,
              model: config.model,
              apiKey: config.apiKey.trim() || null,
              message: prompt,
              history: [],
              character: proactiveCharacter,
              images: null,
              settings: {
                // 只要一句 12–30 字的话，128 token 足够；给太多反而拖慢。
                maxTokens: 128,
                // 重试时把温度拉高，逼模型换一种说法。
                temperature: silent ? 1 : 0.85,
                topP: 0.9,
                enableThinking: false,
                reasoningEffort: "none",
                reasoningBudgetTokens: 0,
              },
            });
            return text;
          } finally {
            unlisten();
          }
        }
        const reply = await invoke<{ text: string }>("dsh_chat", {
          message: prompt,
          sessionId: null,
          character: proactiveCharacter,
        });
        return reply.text;
      };
      let line = "";
      try {
        // 本地模型没启动时先拉起 Strata，否则会一路退化成模板台词。
        const config = loadLocalChatConfig();
        if (config.backend === "local" && config.model) {
          const readyAt = Number(window.localStorage.getItem("maltese-local-model-ready") || 0);
          if (Date.now() - readyAt > 10 * 60_000) {
            const ready = await invoke<boolean>("ensure_local_model", {
              baseUrl: config.baseUrl,
            }).catch(() => false);
            if (ready) {
              window.localStorage.setItem("maltese-local-model-ready", String(Date.now()));
            }
          }
        }
        line = (await askOnce("")) ?? "";
      } catch {
        line = "";
      }
      line = line.trim().replace(/^["「『]|["」』]$/g, "");
      if (line && isRepeatedProactiveLine(line, avoid)) {
        // 撞车了：连续要两次，措辞一次比一次强硬，温度也更高。
        for (const hint of [
          "\n\n刚才那句和以前太像了，换一个完全不同的角度和开头。",
          `\n\n还是太像了。不要再用这些开头：${avoid.slice(0, 5).map((item) => item.slice(0, 4)).join(" / ")}。换一个更具体、更有画面感的说法。`,
        ]) {
          try {
            const retry = (await askOnce(hint, true)) ?? "";
            const cleaned = retry.trim().replace(/^["「『]|["」』]$/g, "");
            if (cleaned && !isRepeatedProactiveLine(cleaned, avoid)) {
              line = cleaned;
              break;
            }
          } catch {
            // 保留当前这句
          }
        }
      }
      if (!line || isRepeatedProactiveLine(line, avoid)) {
        line = pickProactiveFallback(observe, avoid, angle);
      }
      if (!line) return;
      rememberProactiveLine(line, { kind: observe.kind, angle });
      recordSpeakTime(Date.now());
      // 模型调用可能花几秒，弹之前再确认一次仍在挂机。
      if (modeRef.current !== "collapsed") return;
      if (onFirstTextRef.fired) {
        // 气泡已经在流式阶段弹出来了，这里只把正文补成最终版本（不重复弹窗）。
        applyPetOverlay({ mode: "cloud", title: bubbleTitle, body: line });
        appendChat(line);
        try {
          window.localStorage.setItem("maltese-proactive-last", String(Date.now()));
          window.dispatchEvent(new Event("maltese-proactive-chat-done"));
        } catch {
          // 忽略
        }
        return;
      }
      // 标题也给点变化，不要永远是「小狗想你了」。
      const greetingPool =
        kind === "code"
          ? ["小狗在旁边", "偷偷看你写代码", "小狗想搭把手"]
          : kind === "video" || kind === "browser"
            ? ["小狗也在看", "凑过来一起看", "小狗探头"]
            : kind === "meeting"
              ? ["陪你开会", "小狗安静陪着"]
              : ["小狗想你了", "小狗探头", "突然想起你"];
      // 上次用过的标题不再连着用，避免「小狗想你了」刷屏。
      let greeting = greetingPool[Math.floor(Math.random() * greetingPool.length)];
      try {
        const lastTitle = window.localStorage.getItem("maltese-proactive-last-title") || "";
        const alternatives = greetingPool.filter((item) => item !== lastTitle);
        if (alternatives.length > 0) {
          greeting = alternatives[Math.floor(Math.random() * alternatives.length)];
        }
        window.localStorage.setItem("maltese-proactive-last-title", greeting);
      } catch {
        // 忽略
      }
      showCloudBubble(greeting, line);
      appendChat(line);
      try {
        window.localStorage.setItem("maltese-proactive-last", String(Date.now()));
        window.dispatchEvent(new Event("maltese-proactive-chat-done"));
      } catch {
        // 忽略
      }
    };

    const timer = window.setInterval(() => void tick(), 30_000);
    const runNow = () => void tick(true);
    window.addEventListener("maltese-proactive-chat-now", runNow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("maltese-proactive-chat-now", runNow);
    };
  }, [
    proactiveCharacter,
    settings.proactiveChat,
    settings.proactiveChatMinutes,
    settings.proactiveChatMode,
    showCloudBubble,
  ]);  // 收起态收到新版本时主动弹一次云朵气泡；展开态由 UpdateBanner 提示。
  useEffect(() => {
    if (
      updateState.stage !== "available" ||
      !updateState.nextVersion ||
      mode !== "collapsed" ||
      !settings.bubbleOn
    ) {
      return;
    }
    if (shownUpdateVersionRef.current === updateState.nextVersion) return;
    shownUpdateVersionRef.current = updateState.nextVersion;
    showCloudBubble(
      t.updateNotice.bubbleTitle(updateState.nextVersion),
      t.updateNotice.bubbleBody,
    );
  }, [mode, settings.bubbleOn, showCloudBubble, t, updateState.nextVersion, updateState.stage]);

  // 主窗口启动后自动检查更新；设置窗口和其他辅助窗口不重复检查。
  useEffect(() => {
    if (!isTauri()) return;
    if (getCurrentWindow().label !== "main") return;
    startAutoUpdateCheck();
  }, []);

  // 进行中待办：开始后先确认一次，之后按设置的间隔提醒当前待办和已计时。
  useEffect(() => {
    if (!activeTodo || mode !== "collapsed" || !settings.bubbleOn) {
      return;
    }

    const reminderInterval = Math.max(1, settings.todoReminderMinutes) * 60_000;
    const startedKey = `todo-reminder-${activeTodo.id}`;
    const lastReminder = window.localStorage.getItem("focusd-todo-reminder-key");
    if (lastReminder !== startedKey) {
      window.localStorage.setItem("focusd-todo-reminder-key", startedKey);
      showCloudBubble(
        t.todo.reminderStartedTitle,
        t.todo.reminderStartedBody(
          activeTodo.title,
          settings.todoReminderMinutes,
        ),
      );
    }

    const timer = window.setInterval(() => {
      const elapsed = getTodoElapsedMs(activeTodo, Date.now());
      showCloudBubble(
        t.todo.reminderTitle,
        t.todo.reminderBody(
          activeTodo.title,
          formatTodoElapsed(elapsed, t.localeTag),
        ),
      );
    }, reminderInterval);

    return () => {
      window.clearInterval(timer);
      // 不要在这里删除 startedKey：mode/缩边变化会让 effect 重建，
      // 删除后每次收起/睡觉都会重复弹一次“开始计时”气泡。
      // 同一个待办只在真正开始时提示一次，切到下一条待办自然会换 key。
    };
  }, [
    activeTodo,
    mode,
    settings.bubbleOn,
    settings.todoReminderMinutes,
    showCloudBubble,
    t,
  ]);

  // 消息通知 → 云朵气泡
  const lastCloudAtRef = useRef(0);
  useEffect(() => {
    if (!isTauri() || mode !== "collapsed" || !settings.bubbleOn) {
      return;
    }
    const candidate =
      (qqMail.preview
        ? { title: qqMail.preview.sender, body: qqMail.preview.subject, at: qqMail.previewReceivedAt ?? 0 }
        : null) ??
      (qqNotifications.preview
        ? {
            title: (qqNotifications.preview as { title?: string; sender?: string }).title
              ?? (qqNotifications.preview as { sender?: string }).sender
              ?? "QQ",
            body: (qqNotifications.preview as { body?: string }).body ?? "新消息",
            at: qqNotifications.previewReceivedAt ?? 0,
          }
        : null) ??
      (wechatReminders.previewReceivedAt
        ? {
            title: wechatReminders.snapshot.title?.trim() || "微信",
            body: wechatReminders.snapshot.body?.trim() || "收到新消息",
            at: wechatReminders.previewReceivedAt,
          }
        : null);
    if (!candidate || candidate.at <= lastCloudAtRef.current) {
      return;
    }
    lastCloudAtRef.current = candidate.at;
    showCloudBubble(candidate.title, candidate.body);
  }, [mode, qqMail.preview, qqMail.previewReceivedAt, qqNotifications.preview, qqNotifications.previewReceivedAt, settings.bubbleOn, showCloudBubble, wechatReminders.previewReceivedAt, wechatReminders.snapshot.body, wechatReminders.snapshot.title]);

  // 正在播放的曲目切换 → 云朵气泡（带一点情感互动）
  const lastTrackRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isTauri() || mode !== "collapsed" || !settings.bubbleOn || !settings.proactiveBubbles || !settings.musicChat) {
      return;
    }
    // 播视频时不要说「正在听」，那是视频不是音乐。
    if (mediaLooksLikeVideo) {
      return;
    }
    if (mediaState.playbackStatus !== "playing" || !mediaState.title) {
      return;
    }
    const key = `${mediaState.title}|${mediaState.artist ?? ""}`;
    if (key === lastTrackRef.current) {
      return;
    }
    if (lastTrackRef.current !== null) {
      const artist = mediaState.artist ? `，${mediaState.artist} 唱得真好听` : "";
      showCloudBubble(`🎵 ${mediaState.title}`, `你也喜欢听《${mediaState.title}》呀${artist}～ 我陪你一起听`);
    }
    lastTrackRef.current = key;
  }, [mediaLooksLikeVideo, mediaState.artist, mediaState.playbackStatus, mediaState.title, mode, settings.bubbleOn, settings.musicChat, settings.proactiveBubbles, showCloudBubble]);

  // 剪贴板新增内容 → 云朵气泡（显示内容摘要）
  const lastClipboardIdRef = useRef<string | null>(null);
  useEffect(() => {
    const first = clipboardHistory.items[0];
    if (!first) {
      return;
    }
    if (lastClipboardIdRef.current === null || first.id === lastClipboardIdRef.current) {
      lastClipboardIdRef.current = first.id;
      return;
    }
    lastClipboardIdRef.current = first.id;
    if (!settings.clipboardBubble || !settings.proactiveBubbles) {
      return;
    }
    const preview = (first.preview ?? "").trim();
    const image = first.kind === "image" ? first.image?.thumbnailDataUrl : undefined;
    showCloudBubble(
      first.kind === "image" ? "📋 剪贴板 · 图片" : "📋 剪贴板",
      preview
        ? preview.length > 140 ? `${preview.slice(0, 140)}…` : preview
        : first.kind === "image"
          ? "已复制一张图片"
          : "已复制新内容",
      image,
    );
  }, [clipboardHistory.items, settings.clipboardBubble, settings.proactiveBubbles, showCloudBubble]);

  // 微信气泡统一由上面的消息候选逻辑发出，避免同一事件弹两次。

  // 按前台进程感知「你在做什么」并说一句对应的话（纯本地，默认开启）。
  const lastActivityRef = useRef<{ kind: string; at: number }>({ kind: "", at: 0 });
  useEffect(() => {
    if (!isTauri() || !settings.observeApps || !settings.bubbleOn || !settings.proactiveBubbles || mode !== "collapsed") {
      return;
    }
    let cancelled = false;
    const tick = () => {
      void invoke<{ kind: string; process: string; title: string }>("get_active_activity")
        .then((info) => {
          if (cancelled) {
            return;
          }
          const lines = ACTIVITY_LINES[info.kind];
          const now = Date.now();
          if (
            lines &&
            info.kind !== lastActivityRef.current.kind &&
            now - lastActivityRef.current.at > 4 * 60_000
          ) {
            lastActivityRef.current = { kind: info.kind, at: now };
            showActivityMood(ACTIVITY_MOODS[info.kind]);
            showCloudBubble("小狗观察中", lines[Math.floor(Math.random() * lines.length)]);
          }
        })
        .catch(() => undefined);
    };
    const first = window.setTimeout(tick, 10_000);
    const timer = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [mode, settings.bubbleOn, settings.observeApps, settings.proactiveBubbles, showActivityMood, showCloudBubble]);

  // 整点轻轻叫一声
  useEffect(() => {
    if (!isTauri() || !settings.hourlyChime || !settings.bubbleOn || !settings.proactiveBubbles) {
      return;
    }
    const tick = () => {
      const now = new Date();
      if (now.getMinutes() !== 0) {
        return;
      }
      const key = `maltese-chime-${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
      try {
        if (window.localStorage.getItem(key)) {
          return;
        }
        window.localStorage.setItem(key, "1");
      } catch {
        return;
      }
      if (settings.soundOn) {
        playPetChirp("happy");
      }
      showCloudBubble("汪汪～", `${now.getHours()} 点啦，起来喝口水、伸个懒腰吧`);
    };
    const timer = window.setInterval(tick, 20_000);
    return () => window.clearInterval(timer);
  }, [settings.bubbleOn, settings.hourlyChime, settings.proactiveBubbles, settings.soundOn, showCloudBubble]);

  // 时间感知 / 夜间陪伴：每天第一次启动时问候一句
  useEffect(() => {
    if (!isTauri() || !settings.bubbleOn) {
      return;
    }
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const key = "maltese-greeting-day";
    try {
      if (window.localStorage.getItem(key) === today) {
        return;
      }
      window.localStorage.setItem(key, today);
    } catch {
      return;
    }
    const hour = now.getHours();
    if ((hour >= 23 || hour < 5) && settings.nightCompanion) {
      showCloudBubble("夜深了", "这么晚还在忙呀，早点休息，我在旁边陪着你");
    } else if (settings.senseTime) {
      const line =
        hour < 9
          ? "早上好呀，今天也慢慢来，不用急着赶"
          : hour < 12
            ? "上午好，记得喝口水再继续"
            : hour < 14
              ? "中午啦，吃点好吃的犒劳自己"
              : hour < 18
                ? "下午好，累了就摸摸我，充个电"
                : "晚上好，今天辛苦了，剩下的明天再说";
      showCloudBubble("小狗问候", line);
    }
  }, [settings.bubbleOn, settings.nightCompanion, settings.senseTime, showCloudBubble]);

  // 气泡文字颜色存到 localStorage，气泡窗口读取后应用。
  useEffect(() => {
    try {
      window.localStorage.setItem("maltese-bubble-color", settings.bubbleTextColor);
    } catch {
      // 忽略写入失败
    }
  }, [settings.bubbleTextColor]);

  // 多宠物、Bongo 模式、鼠标跟随宠都由 Rust 维护独立透明窗口。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void invoke("sync_desktop_extras", {
      config: {
        petCount: settings.petCount,
        bongoEnabled: settings.bongoEnabled,
        bongoSize: settings.bongoSize,
        bongoOpacity: settings.bongoOpacity,
        bongoMirror: settings.bongoMirror,
        bongoClickThrough: settings.bongoClickThrough,
        bongoPosition: settings.bongoPosition,
        followMouse: settings.followMouse,
        cursorPetSize: settings.cursorPetSize,
      },
    }).catch(() => undefined);
  }, [
    settings.bongoClickThrough,
    settings.bongoEnabled,
    settings.bongoMirror,
    settings.bongoOpacity,
    settings.bongoPosition,
    settings.bongoSize,
    settings.cursorPetSize,
    settings.followMouse,
    settings.petCount,
  ]);

  // 独立设置窗口保存后，主窗口立即重新加载设置。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen("maltese-settings-updated", () => {
      setSettings(loadSettings());
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 随机闲逛：收起状态下每隔一会儿挪一小步
  useEffect(() => {
    // 固定在某个角落时不再随机闲逛，否则用户会觉得小狗自己往左上角跑。
    if (!isTauri() || !settings.roam || settings.lockCorner) {
      return;
    }
    const timer = window.setInterval(() => {
      if (mode !== "collapsed") {
        return;
      }
      void invoke("roam_island_step").catch(() => undefined);
    }, 32_000);
    return () => window.clearInterval(timer);
  }, [mode, settings.lockCorner, settings.roam]);

  // 全局快捷键只负责隐藏 / 显示；从缩边状态回来时退出缩边。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{ visible?: boolean }>("maltese-hotkey-toggle", (event) => {
      if (event.payload?.visible) {
        setIsTucked(false);
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const openIslandPage = useCallback((nextPage: IslandPage) => {
    clearPetOverlayForPage();
    if (mode !== "expanded") {
      // 窗口从收起尺寸放大时，WebView 会短暂保留旧画面，狗看起来在左上角
      // 有一层重影。放大期间先隐藏收起态小狗，等新面板完成首帧再显示。
      document.documentElement.classList.add("maltese-page-opening");
      if (pageOpenMaskRef.current !== null) {
        window.clearTimeout(pageOpenMaskRef.current);
      }
      pageOpenMaskRef.current = window.setTimeout(() => {
        pageOpenMaskRef.current = null;
        document.documentElement.classList.remove("maltese-page-opening");
      }, 320);
    }
    setPage(nextPage);
    setMode("expanded");
    setIsTucked(false);
  }, [clearPetOverlayForPage, mode]);

  // 快捷面板只有一个系统级热键：打开整个快捷方式面板，而不是逐个启动应用。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const saved = loadShortcutPanelHotkey();
    if (saved) {
      void invoke<string>("set_shortcut_panel_hotkey", { shortcut: saved }).catch((error) => {
        console.error("Failed to register shortcut panel hotkey", error);
      });
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen("maltese-open-shortcut-panel", () => {
      openIslandPage("assistant");
      // 等 AssistantPanel 挂载并注册监听后再触发聚焦。
      window.setTimeout(() => {
        window.dispatchEvent(new Event("maltese-focus-app-search"));
      }, 120);
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.error("Failed to listen for shortcut panel hotkey", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openIslandPage]);

  const openMessages = useCallback((source: MessageSource) => {
    qqMail.closeReader();
    setMessageSource(source);
    openIslandPage("qq");
  }, [openIslandPage, qqMail.closeReader]);

  const collapseIsland = useCallback(() => {
    setIslandMode("collapsed");
  }, [setIslandMode]);

  // 启动时就把保存的「显示/隐藏」组合键注册上（以前只在快捷面板挂载时才注册，
  // 用户改过键的话要等打开面板才生效）。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void invoke<string>("set_wake_shortcut", { shortcut: loadWakeShortcut() })
      .then((registered) => saveWakeShortcut(registered))
      .catch(() => undefined);
  }, []);
  // 「收起面板」全局快捷键：注册保存的组合键，按下后把展开态收起来。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void invoke<string>("set_collapse_shortcut", { shortcut: loadCollapseShortcut() })
      .then((registered) => saveCollapseShortcut(registered))
      .catch(() => undefined);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen("maltese-collapse-panel", () => collapseIsland()).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [collapseIsland]);

  const refreshMediaState = useCallback(async () => {
    if (isRefreshingMediaState.current) {
      return;
    }

    isRefreshingMediaState.current = true;

    try {
      const nextMediaState = await invoke<MediaState>("get_media_state", {
        target: mediaTargetRef.current ?? undefined,
      });

      setMediaState((currentState) => {
        const intent = mediaPlaybackIntent.current;
        const playbackStatus =
          intent && Date.now() < intent.expiresAt
            ? intent.status
            : nextMediaState.playbackStatus;

        if (intent && Date.now() >= intent.expiresAt) {
          mediaPlaybackIntent.current = null;
        }

        const nextPeak = Math.max(
          currentState.audioPeak * 0.82,
          nextMediaState.audioPeak,
        );
        const audioActive = playbackStatus !== "paused" &&
          (nextMediaState.audioActive || nextPeak > AUDIO_ACTIVE_THRESHOLD);
        const audioPeak = audioActive ? nextPeak : 0;

        const merged: MediaState = {
          ...nextMediaState,
          audioActive,
          audioPeak,
          playbackStatus,
        };

        if (isSameMediaState(currentState, merged)) {
          return currentState;
        }

        return merged;
      });
    } catch (error) {
      console.error("Failed to read media state", error);
      setMediaState(DEFAULT_MEDIA_STATE);
    } finally {
      isRefreshingMediaState.current = false;
    }
  }, []);

  const runMediaCommand = useCallback(
    async (
      command:
        | "media_play_pause"
        | "media_next"
        | "media_previous"
        | "media_toggle_shuffle"
        | "media_cycle_repeat",
    ) => {
      if (isRunningMediaCommand.current) {
        return;
      }

      // 没有 SMTC 会话（例如网易云客户端）时，用全局媒体键控制播放。
      if (!mediaState.available) {
        const mediaKey =
          command === "media_play_pause"
            ? "toggle"
            : command === "media_next"
              ? "next"
              : command === "media_previous"
                ? "previous"
                : null;
        if (!mediaKey) {
          return;
        }
        setMediaCommandError(null);
        try {
          await invoke("media_press_key", { command: mediaKey });
          if (command === "media_play_pause") {
            const nextStatus: MediaPlaybackStatus =
              mediaState.playbackStatus === "playing" ? "paused" : "playing";
            mediaPlaybackIntent.current = {
              status: nextStatus,
              expiresAt: Date.now() + 1200,
            };
            setMediaState((currentState) => ({
              ...currentState,
              playbackStatus: nextStatus,
              audioPeak: nextStatus === "paused" ? 0 : currentState.audioPeak,
              updatedAt: Date.now(),
            }));
          }
          window.setTimeout(() => void refreshMediaState(), 700);
        } catch (error) {
          setMediaCommandError(String(error));
        }
        return;
      }

      const target = mediaTargetRef.current ?? undefined;
      const isPlayPause = command === "media_play_pause";
      const isTrackChange =
        command === "media_next" || command === "media_previous";
      const isTransport = isPlayPause || isTrackChange;

      const intendedStatus: MediaPlaybackStatus = isPlayPause
        ? mediaState.playbackStatus === "playing"
          ? "paused"
          : "playing"
        : mediaState.playbackStatus;

      if (isTransport) {
        mediaPlaybackIntent.current = {
          status: intendedStatus,
          expiresAt: Date.now() + (isPlayPause ? 1200 : 1800),
        };

        if (isPlayPause) {
          setMediaState((currentState) => ({
            ...currentState,
            available: intendedStatus === "playing" || currentState.available,
            audioActive:
              intendedStatus === "playing" && currentState.audioActive,
            audioPeak:
              intendedStatus === "paused" ? 0 : currentState.audioPeak,
            playbackStatus: intendedStatus,
            updatedAt: Date.now(),
          }));
        }
      }

      isRunningMediaCommand.current = true;
      setIsMediaTrackChanging(isTrackChange);
      setMediaCommandError(null);
      try {
        const nextMediaState = await invoke<MediaState>(command, { target });

        if (!isTransport) {
          setMediaState((currentState) =>
            isSameMediaState(currentState, nextMediaState)
              ? currentState
              : nextMediaState,
          );
          return;
        }

        setMediaState((currentState) => {
          if (intendedStatus === "paused") {
            return {
              ...nextMediaState,
              audioActive: false,
              audioPeak: 0,
              playbackStatus: intendedStatus,
            };
          }

          return {
            ...nextMediaState,
            audioActive:
              nextMediaState.audioActive || currentState.audioActive,
            audioPeak: Math.max(
              nextMediaState.audioPeak,
              currentState.audioPeak * 0.82,
            ),
            playbackStatus: intendedStatus,
          };
        });
      } catch (error) {
        console.error(`Failed to run media command: ${command}`, error);
        setMediaCommandError(String(error));
        mediaPlaybackIntent.current = null;
        await refreshMediaState();
      } finally {
        isRunningMediaCommand.current = false;
        setIsMediaTrackChanging(false);
      }
    },
    [mediaState.playbackStatus, refreshMediaState],
  );

  const seekMedia = useCallback(async (positionMs: number) => {
    try {
      const nextState = await invoke<MediaState>("media_seek", {
        positionMs: Math.max(0, Math.round(positionMs)),
        target: mediaTargetRef.current ?? undefined,
      });
      setMediaState((current) => ({ ...current, ...nextState }));
    } catch (error) {
      setMediaCommandError(String(error));
    }
  }, []);

  const setMediaVolume = useCallback(async (level: number) => {
    const clamped = Math.min(Math.max(level, 0), 1);
    setMediaState((current) => ({ ...current, volume: clamped }));
    try {
      await invoke("media_set_volume", { level: clamped });
    } catch (error) {
      setMediaCommandError(String(error));
    }
  }, []);

  const reorderMusicSource = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) {
        return;
      }

      setMusicSourcePriority((current) => {
        const sourceIndex = current.findIndex(
          (source) => source.id === sourceId,
        );
        const targetIndex = current.findIndex(
          (source) => source.id === targetId,
        );

        if (
          sourceIndex < 0 ||
          targetIndex < 0 ||
          sourceIndex === targetIndex
        ) {
          return current;
        }

        const next = [...current];
        const [moved] = next.splice(sourceIndex, 1);
        next.splice(targetIndex, 0, moved);
        return next;
      });
    },
    [],
  );

  const removeMusicSource = useCallback((sourceId: string) => {
    setMusicSourcePriority((current) =>
      current.filter((source) => source.id !== sourceId),
    );
  }, []);

  useEffect(() => {
    let didCancel = false;

    const refreshAudioLevel = async () => {
      if (didCancel || isRefreshingAudioLevel.current) {
        return;
      }

      isRefreshingAudioLevel.current = true;

      try {
        const audioLevel = await invoke<AudioLevel>("get_audio_level");

        if (didCancel) {
          return;
        }

        setMediaState((currentState) => {
          const intent = mediaPlaybackIntent.current;
          const isPauseIntent =
            intent &&
            Date.now() < intent.expiresAt &&
            intent.status === "paused";

          if (currentState.playbackStatus === "paused" || isPauseIntent) {
            if (
              currentState.playbackStatus === "paused" &&
              !currentState.audioActive &&
              currentState.audioPeak === 0
            ) {
              return currentState;
            }
            return {
              ...currentState,
              audioActive: false,
              audioPeak: 0,
              playbackStatus: "paused",
            };
          }

          const decayedPeak = currentState.audioPeak * 0.82;
          const nextPeak = audioLevel.active
            ? Math.max(decayedPeak, audioLevel.peak)
            : decayedPeak;
          const audioActive =
            (audioLevel.active || nextPeak > AUDIO_ACTIVE_THRESHOLD * 1.5);
          const audioPeak = audioActive ? nextPeak : 0;

          if (
            currentState.audioActive === audioActive &&
            currentState.audioPeak === audioPeak
          ) {
            return currentState;
          }

          return {
            ...currentState,
            audioActive,
            audioPeak,
          };
        });
      } catch (error) {
        console.error("Failed to read audio level", error);
      } finally {
        isRefreshingAudioLevel.current = false;
      }
    };

    void refreshAudioLevel();

    const interval = window.setInterval(() => {
      void refreshAudioLevel();
    }, 500);

    return () => {
      didCancel = true;
      window.clearInterval(interval);
    };
  }, []);

  const recordDiaryEvent = useCallback((kind: DiaryEvent["kind"], text: string) => {
    const at = Date.now();
    setDiaryEvents((current) =>
      [
        ...current,
        {
          id: createTodoId(),
          date: getLocalDateString(new Date(at)),
          at,
          kind,
          text,
        },
      ].slice(-500),
    );
  }, []);

  const addTodo = useCallback(() => {
    const title = draftTodo.trim();

    if (!title) {
      return;
    }

    setTodos((currentTodos) => [
      {
        id: createTodoId(),
        title,
        completed: false,
        createdAt: Date.now(),
      },
      ...currentTodos,
    ]);
    setDraftTodo("");
  }, [draftTodo]);

  const toggleTodo = useCallback((id: string) => {
    const todo = todos.find((item) => item.id === id);

    if (!todo) {
      return;
    }

    const now = Date.now();
    const nextCompleted = !todo.completed;

    if (nextCompleted) {
      const elapsed = getTodoElapsedMs(todo, now);
      setTodos((currentTodos) =>
        currentTodos.map((item) =>
          item.id === id
            ? {
                ...item,
                completed: true,
                completedAt: now,
                activeSince: null,
                elapsedMs: elapsed,
              }
            : item,
        ),
      );
      if (activeTodoId === id) {
        setActiveTodoId(null);
      }
      recordDiaryEvent(
        "todo",
        t.diary.completed(todo.title, formatTodoElapsed(elapsed, t.localeTag)),
      );
      return;
    }

    setTodos((currentTodos) =>
      currentTodos.map((item) =>
        item.id === id
          ? { ...item, completed: false, completedAt: null }
          : item,
      ),
    );
    recordDiaryEvent("todo", t.diary.reopened(todo.title));
  }, [activeTodoId, recordDiaryEvent, t, todos]);

  const updateTodoTitle = useCallback((id: string, title: string) => {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return;
    }

    setTodos((currentTodos) =>
      currentTodos.map((todo) =>
        todo.id === id ? { ...todo, title: nextTitle } : todo,
      ),
    );
  }, []);

  const startTodo = useCallback(
    (id: string) => {
      const todo = todos.find((item) => item.id === id);

      if (!todo || todo.completed) {
        return;
      }

      const now = Date.now();

      if (activeTodoId === id) {
        const elapsed = getTodoElapsedMs(todo, now);
        setTodos((currentTodos) =>
          currentTodos.map((item) =>
            item.id === id
              ? { ...item, activeSince: null, elapsedMs: elapsed }
              : item,
          ),
        );
        setActiveTodoId(null);
        recordDiaryEvent(
          "todo",
          t.diary.paused(todo.title, formatTodoElapsed(elapsed, t.localeTag)),
        );
        return;
      }

      setTodos((currentTodos) =>
        currentTodos.map((item) =>
          item.id === id
            ? {
                ...item,
                startedAt: item.startedAt ?? now,
                activeSince: now,
              }
            : item,
        ),
      );
      setActiveTodoId(id);
      setIslandMode("collapsed");
      recordDiaryEvent("todo", t.diary.started(todo.title));
    },
    [activeTodoId, recordDiaryEvent, setIslandMode, t, todos],
  );

  const deleteTodo = useCallback((id: string) => {
    setTodos((currentTodos) => currentTodos.filter((todo) => todo.id !== id));
    setActiveTodoId((currentId) => (currentId === id ? null : currentId));
  }, []);

  const reorderTodo = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    setTodos((currentTodos) => {
      const sourceIndex = currentTodos.findIndex((todo) => todo.id === sourceId);
      const targetIndex = currentTodos.findIndex((todo) => todo.id === targetId);

      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return currentTodos;
      }

      const nextTodos = [...currentTodos];
      const [movedTodo] = nextTodos.splice(sourceIndex, 1);
      const insertIndex = targetIndex;
      nextTodos.splice(insertIndex, 0, movedTodo);

      return nextTodos;
    });
  }, []);

  const upsertArchive = useCallback(
    (
      date: string,
      todoList: TodoItem[],
      nextDailyNote: string,
      savedToDisk: boolean,
      filePath?: string,
    ) => {
      const archive: TodoArchive = {
        date,
        todos: todoList,
        dailyNote: nextDailyNote,
        savedAt: Date.now(),
        savedToDisk,
        filePath,
      };

      setArchives((currentArchives) =>
        [archive, ...currentArchives.filter((item) => item.date !== date)].sort(
          (a, b) => b.date.localeCompare(a.date),
        ),
      );
    },
    [],
  );

  const saveTodosToDisk = useCallback(
    async (date: string, todoList: TodoItem[], nextDailyNote: string) => {
      const directory = saveDirectory.trim();

      if (!directory) {
        throw new Error("Missing todo save path.");
      }

      const result = await invoke<SaveTodoResult>("save_todo_markdown", {
        directory,
        date,
        content: formatTodoDocumentAsMarkdown(todoList, nextDailyNote),
      });

      upsertArchive(date, todoList, nextDailyNote, true, result.filePath);
      window.localStorage.setItem(
        TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
        getTodoSignature(date, todoList, nextDailyNote),
      );

      return result;
    },
    [saveDirectory, upsertArchive],
  );

  const showTodoSavedState = useCallback(() => {
    if (saveStateResetTimer.current !== null) {
      window.clearTimeout(saveStateResetTimer.current);
    }

    setSaveState("saved");
    saveStateResetTimer.current = window.setTimeout(() => {
      setSaveState("idle");
      saveStateResetTimer.current = null;
    }, 1200);
  }, []);

  const saveTodayTodos = useCallback(async () => {
    if (!saveDirectory.trim()) {
      setSaveState("needs-path");
      setPage("layout");
      setMode("expanded");
      setIsTucked(false);
      return;
    }

    setSaveState("saving");

    try {
      await saveTodosToDisk(currentTodoDate, todos, dailyNote);
      showTodoSavedState();
    } catch (error) {
      console.error("Failed to save todo markdown", error);
      setSaveState("error");
    }
  }, [
    currentTodoDate,
    dailyNote,
    saveDirectory,
    saveTodosToDisk,
    showTodoSavedState,
    todos,
  ]);

  const saveDirectoryFromEditor = useCallback(() => {
    const nextDirectory = saveDirectoryDraft.trim();

    setSaveDirectory(nextDirectory);
    setSaveDirectoryDraft(nextDirectory);
    setSaveState("idle");
    setSavePathState("saved");
    window.setTimeout(() => setSavePathState("idle"), 1200);
  }, [saveDirectoryDraft]);

  const showArchive = useCallback(() => {
    setTodoPageMode("archive");
    setSelectedArchiveDate(null);
    setDraftTodo("");
  }, []);

  const showToday = useCallback(() => {
    setTodoPageMode("today");
    setSelectedArchiveDate(null);
    setDraftTodo("");
  }, []);

  const showDaily = useCallback(() => {
    setTodoPageMode("daily");
    setSelectedArchiveDate(null);
    setDraftTodo("");
  }, []);

  const selectArchive = useCallback(
    (date: string) => {
      if (date === currentTodoDate) {
        showToday();
        return;
      }

      setSelectedArchiveDate(date);
      setTodoPageMode("review");
      setDraftTodo("");
    },
    [currentTodoDate, showToday],
  );

  const rolloverToToday = useCallback(
    async (nextDate: string) => {
      const signature = getTodoSignature(currentTodoDate, todos, dailyNote);
      const lastSavedSignature = window.localStorage.getItem(
        TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
      );
      // 只把“已打勾完成”的待办归入历史；未完成的永远留在列表里，
// 跨天/重启/更新都不清空，并保留原来的 id、创建时间和计时。
      const carriedTodos = todos.filter((todo) => !todo.completed);

      if (
        (todos.length > 0 || dailyNote.trim()) &&
        signature !== lastSavedSignature
      ) {
        if (saveDirectory.trim()) {
          try {
            await saveTodosToDisk(currentTodoDate, todos, dailyNote);
          } catch (error) {
            console.error("Failed to auto-save todo markdown", error);
            upsertArchive(currentTodoDate, todos, dailyNote, false);
          }
        } else {
          upsertArchive(currentTodoDate, todos, dailyNote, false);
        }
      }

      setTodos(carriedTodos);
      setDailyNote("");
      setActiveTodoId((current) =>
        current && carriedTodos.some((todo) => todo.id === current) ? current : null,
      );
      setCurrentTodoDate(nextDate);
      setTodoPageMode("today");
      setSelectedArchiveDate(null);

      if (carriedTodos.length > 0) {
        window.localStorage.removeItem(TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
          getTodoSignature(nextDate, [], ""),
        );
      }
    },
    [
      currentTodoDate,
      dailyNote,
      saveDirectory,
      saveTodosToDisk,
      todos,
      upsertArchive,
    ],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    scheduleNativeLayout(DEFAULT_SETTINGS);
  }, [scheduleNativeLayout]);

  const saveSettingsPreset = useCallback(() => {
    setSettingPresets((currentPresets) => {
      const customPresetCount = currentPresets.filter(
        (preset) => !preset.isDefault && !isDefaultSettingPreset(preset.id),
      ).length;
      const preset: IslandPreset = {
        id: createTodoId(),
        name: t.settings.presets.defaultName(customPresetCount + 1),
        settings,
        createdAt: Date.now(),
        isDefault: false,
      };

      return mergeWithDefaultSettingPresets([preset, ...currentPresets]);
    });
  }, [settings, t]);

  const applySettingsPreset = useCallback(
    (presetId: string) => {
      const preset = settingPresets.find((item) => item.id === presetId);

      if (!preset) {
        return;
      }

      const nextSettings = normalizeSettings(preset.settings);
      setSettings(nextSettings);
      scheduleNativeLayout(nextSettings);
    },
    [scheduleNativeLayout, settingPresets],
  );

  const renameSettingsPreset = useCallback((presetId: string, name: string) => {
    const nextName = name.trim();

    if (
      !nextName ||
      isDefaultSettingPreset(presetId) ||
      LEGACY_DEFAULT_PRESET_NAMES.has(nextName)
    ) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.map((preset) =>
        preset.id === presetId ? { ...preset, name: nextName } : preset,
      ),
    );
  }, []);

  const deleteSettingsPreset = useCallback((presetId: string) => {
    if (isDefaultSettingPreset(presetId)) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.filter((preset) => preset.id !== presetId),
    );
  }, []);

  const updateLaunchAtStartup = useCallback(async (enabled: boolean) => {
    setLaunchAtStartup(enabled);

    try {
      await invoke("set_launch_at_startup", { enabled });
    } catch (error) {
      console.error("Failed to update launch at startup", error);
      setLaunchAtStartup(!enabled);
    }
  }, []);

  const installAgentHooks = useCallback(async () => {
    setAgentHooksInstallState("installing");
    setAgentHooksInstallError("");

    try {
      const result = await invoke<AgentHooksInstallResult>(
        "install_agent_status_hooks",
      );
      setAgentHooksInstallResult(result);
      setAgentHooksInstallState("installed");
      void refreshAgentStatus();
    } catch (error) {
      console.error("Failed to install agent status hooks", error);
      setAgentHooksInstallError(getErrorMessage(error));
      setAgentHooksInstallState("error");
    }
  }, [refreshAgentStatus]);

  useEffect(() => {
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch((error) => {
        console.error("Failed to read launch at startup", error);
      });
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void refreshClipboardHistory();

    let didCancel = false;
    let unlistenChanges: (() => void) | null = null;

    void listen("clipboard-history-changed", () => {
      void refreshClipboardHistory();
    })
      .then((nextUnlisten) => {
        if (didCancel) {
          nextUnlisten();
        } else {
          unlistenChanges = nextUnlisten;
        }
      })
      .catch((error) => {
        console.error("Failed to listen for clipboard history changes", error);
      });

    return () => {
      didCancel = true;
      unlistenChanges?.();
    };
  }, [refreshClipboardHistory]);

  useEffect(() => {
    void refreshMediaState();

    const interval = window.setInterval(() => {
      void refreshMediaState();
    }, 1500);

    return () => window.clearInterval(interval);
  }, [refreshMediaState]);

  const effectiveMediaTarget = useMemo(() => {
    if (mediaState.sessions.length === 0) {
      return null;
    }

    const present = new Map(
      mediaState.sessions.map((session) => [session.id, session]),
    );

    for (const source of musicSourcePriority) {
      if (present.get(source.id)?.playing) {
        return source.id;
      }
    }
    for (const source of musicSourcePriority) {
      if (present.has(source.id)) {
        return source.id;
      }
    }
    return null;
  }, [musicSourcePriority, mediaState.sessions]);

  useEffect(() => {
    if (mediaTargetRef.current === effectiveMediaTarget) {
      return;
    }
    mediaTargetRef.current = effectiveMediaTarget;
    mediaPlaybackIntent.current = null;
    void refreshMediaState();
  }, [effectiveMediaTarget, refreshMediaState]);

  useEffect(() => {
    if (mediaState.sessions.length === 0) {
      return;
    }

    setMusicSourcePriority((current) => {
      const known = new Set(current.map((source) => source.id));
      const additions = mediaState.sessions
        .filter((session) => !known.has(session.id))
        .map((session) => ({ id: session.id, label: session.label }));

      return additions.length > 0 ? [...current, ...additions] : current;
    });
  }, [mediaState.sessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MUSIC_SOURCE_PRIORITY_STORAGE_KEY,
        JSON.stringify(musicSourcePriority),
      );
    } catch {
      // Ignore storage write failures (private mode, quota, etc.).
    }
  }, [musicSourcePriority]);

  useEffect(() => {
    if (page !== "music") {
      setMusicSettingsOpen(false);
    }
  }, [page]);

  useEffect(() => {
    void refreshAgentStatus();

    const interval = window.setInterval(() => {
      void refreshAgentStatus();
    }, 200);

    return () => window.clearInterval(interval);
  }, [refreshAgentStatus]);

  useEffect(() => {
    if (
      !shouldInitializeDefaultSaveDirectory.current ||
      saveDirectory.trim() ||
      defaultSaveDirectoryRequestInFlight.current
    ) {
      return;
    }

    let didCancel = false;
    defaultSaveDirectoryRequestInFlight.current = true;

    void invoke<string>("get_default_todo_save_directory")
      .then((defaultDirectory) => {
        if (didCancel) {
          return;
        }

        const nextDirectory = defaultDirectory.trim();

        if (!nextDirectory) {
          return;
        }

        shouldInitializeDefaultSaveDirectory.current = false;
        setSaveDirectory((currentDirectory) =>
          currentDirectory.trim() ? currentDirectory : nextDirectory,
        );
        setSaveDirectoryDraft((currentDirectory) =>
          currentDirectory.trim() ? currentDirectory : nextDirectory,
        );
      })
      .catch((error) => {
        console.error("Failed to resolve default todo save path", error);
      })
      .finally(() => {
        if (!didCancel) {
          defaultSaveDirectoryRequestInFlight.current = false;
        }
      });

    return () => {
      didCancel = true;
      defaultSaveDirectoryRequestInFlight.current = false;
    };
  }, [saveDirectory]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(
      SETTINGS_PRESETS_STORAGE_KEY,
      JSON.stringify(settingPresets),
    );
  }, [settingPresets]);

  useEffect(() => {
    window.localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
  }, [todos]);

  // 固定在桌面的「待办」窗口改的是同一份 localStorage，这里跟着同步。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== TODOS_STORAGE_KEY || !event.newValue) return;
      try {
        const parsed = JSON.parse(event.newValue) as typeof todos;
        if (Array.isArray(parsed)) setTodos(parsed);
      } catch {
        // 忽略坏数据
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(DAILY_NOTE_STORAGE_KEY, dailyNote);
  }, [dailyNote]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DIARY_EVENTS_STORAGE_KEY,
        JSON.stringify(diaryEvents),
      );
    } catch {
      // localStorage quota is not worth blocking diary interactions.
    }
  }, [diaryEvents]);

  useEffect(() => {
    window.localStorage.setItem(TODO_DATE_STORAGE_KEY, currentTodoDate);
  }, [currentTodoDate]);

  useEffect(() => {
    window.localStorage.setItem(TODO_ARCHIVE_STORAGE_KEY, JSON.stringify(archives));
  }, [archives]);

  useEffect(() => {
    if (!saveDirectory && shouldInitializeDefaultSaveDirectory.current) {
      return;
    }

    window.localStorage.setItem(TODO_SAVE_DIRECTORY_STORAGE_KEY, saveDirectory);
  }, [saveDirectory]);

  useEffect(() => {
    if (!didHydrateAutoSave.current) {
      didHydrateAutoSave.current = true;
      return;
    }

    if (autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    if (!saveDirectory.trim()) {
      return;
    }

    const signature = getTodoSignature(currentTodoDate, todos, dailyNote);
    const lastSavedSignature = window.localStorage.getItem(
      TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
    );

    if (!todos.length && !dailyNote.trim() && !lastSavedSignature) {
      return;
    }

    if (signature === lastSavedSignature) {
      return;
    }

    const timer = window.setTimeout(() => {
      autoSaveTimer.current = null;
      autoSaveRequestId.current += 1;
      const requestId = autoSaveRequestId.current;

      void saveTodosToDisk(currentTodoDate, todos, dailyNote)
        .catch((error) => {
          if (requestId === autoSaveRequestId.current) {
            console.error("Failed to auto-save todo markdown", error);
            setSaveState("error");
          }
        });
    }, 700);

    autoSaveTimer.current = timer;

    return () => {
      if (autoSaveTimer.current === timer) {
        window.clearTimeout(timer);
        autoSaveTimer.current = null;
      }
    };
  }, [
    currentTodoDate,
    dailyNote,
    saveDirectory,
    saveTodosToDisk,
    todos,
  ]);

  useEffect(
    () => () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current);
      }

      if (saveStateResetTimer.current !== null) {
        window.clearTimeout(saveStateResetTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeTodoId) {
      window.localStorage.setItem(ACTIVE_TODO_STORAGE_KEY, activeTodoId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_TODO_STORAGE_KEY);
  }, [activeTodoId]);

  // 重启/切换进行中待办时，从当前这一刻继续计时；关闭应用的时间不计入。
  useEffect(() => {
    if (!activeTodoId) {
      return;
    }

    const now = Date.now();
    setTodos((currentTodos) => {
      let changed = false;
      const nextTodos = currentTodos.map((todo) => {
        if (todo.id !== activeTodoId || todo.completed) {
          return todo;
        }
        changed = true;
        return {
          ...todo,
          startedAt: todo.startedAt ?? now,
          activeSince: now,
        };
      });
      return changed ? nextTodos : currentTodos;
    });
  }, [activeTodoId]);

  useEffect(() => {
    if (
      activeTodoId &&
      !todos.some((todo) => todo.id === activeTodoId && !todo.completed)
    ) {
      setActiveTodoId(null);
    }
  }, [activeTodoId, todos]);

  useEffect(() => {
    if (didCheckDate.current) {
      return;
    }

    didCheckDate.current = true;
    const today = getLocalDateString();

    if (currentTodoDate !== today) {
      void rolloverToToday(today);
    }
  }, [currentTodoDate, rolloverToToday]);

  useEffect(() => {
    const checkForNewDay = () => {
      const today = getLocalDateString();

      if (currentTodoDate !== today) {
        void rolloverToToday(today);
      }
    };

    const interval = window.setInterval(checkForNewDay, 30_000);
    return () => window.clearInterval(interval);
  }, [currentTodoDate, rolloverToToday]);

  useEffect(() => {
    scheduleNativeLayout(settings);
  }, [settings.collapsedScale, settings.expandedScale, settings.marginY, settings.tuckedVisibleHeight, scheduleNativeLayout]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let didCancel = false;
    let unlisten: (() => void) | null = null;

    void listen<IslandPosition>("island-position-changed", ({ payload }) => {
      islandPositionRef.current = payload;
      setIsPositionDetached(true);
      window.localStorage.setItem(
        ISLAND_POSITION_STORAGE_KEY,
        JSON.stringify(payload),
      );
    })
      .then((nextUnlisten) => {
        if (didCancel) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error) => {
        console.error("Failed to listen for island position changes", error);
      });

    return () => {
      didCancel = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () => setReducedMotion(query.matches);
    query.addEventListener("change", updateReducedMotion);
    return () => query.removeEventListener("change", updateReducedMotion);
  }, []);

  useEffect(() => {
    void syncNativeInteraction(
      mode,
      settings,
      expandedIslandHeight,
      collapsedIslandWidth,
      isTucked,
    ).finally(() => {
      void showReadyIsland();
    });
  }, [
    expandedIslandHeight,
    collapsedIslandWidth,
    isTucked,
    mode,
    settings.marginY,
    settings.appearanceMode,
    settings.glassIntensity,
    settings.islandBackgroundColor,
    settings.collapsedScale,
    settings.expandedScale,
    settings.tuckedVisibleHeight,
    showReadyIsland,
    syncNativeInteraction,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        collapseIsland();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapseIsland]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let didCancel = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused && mode === "expanded") {
          collapseIsland();
        }
      })
      .then((nextUnlisten) => {
        if (didCancel) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error) => {
        console.error("Failed to listen for island focus changes", error);
      });

    return () => {
      didCancel = true;
      unlisten?.();
    };
  }, [collapseIsland, mode]);

  const agentVisualState = useMemo(
    () => getAgentVisualState(agentStatus),
    [agentStatus],
  );
  const agentStatusLabel = useMemo(
    () => getAgentStatusLabel(agentStatus, t),
    [agentStatus, t],
  );
  const triggerPetAction = useCallback((action: PetAction) => {
    hidePetOverlay();
    if (soundOnRef.current) {
      playPetChirp(action === "celebrate" || action === "spin" || action === "play" ? "happy" : "soft");
    }
    recordDiaryEvent("pet", t.diary.pet(t.diary.petActions[action]));
    setPetAction(action);
    if (action === "sleeping") {
      // 睡觉不是五秒动作：立刻缩到最近的屏幕边缘，保持趴睡，鼠标靠近才醒。
      tuckIsland("manual");
    }
    if (petActionTimer.current !== null) {
      window.clearTimeout(petActionTimer.current);
    }
    petActionTimer.current = window.setTimeout(() => {
      petActionTimer.current = null;
      setPetAction(null);
    }, action === "sleeping" ? 5000 : 2600);
  }, [recordDiaryEvent, t, tuckIsland]);
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<{ action?: string }>("maltese-pet-action", (event) => {
      const action = event.payload?.action;
      const allowed: PetAction[] = ["pet", "eating", "pickup", "scared", "sleeping", "celebrate", "chin", "spin", "play", "hide", "chase"];
      if (action && allowed.includes(action as PetAction)) {
        triggerPetAction(action as PetAction);
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [triggerPetAction]);
  const petState = useMemo<PetState>(() => {
    if (petAction) {
      return petAction;
    }
    if (activityMood) {
      return activityMood;
    }
    // 播视频（浏览器看剧/B 站）不算「在听音乐」：不要切到听歌表情。
    if (!mediaLooksLikeVideo && (mediaState.playbackStatus === "playing" || mediaState.audioActive)) {
      return "listening";
    }
    if (agentVisualState === "attention" || qqNotifications.preview || qqMail.preview) {
      return "attention";
    }
    if (agentVisualState === "running") {
      return "working";
    }
    return "idle";
  }, [activityMood, agentVisualState, mediaLooksLikeVideo, mediaState.audioActive, mediaState.playbackStatus, petAction, qqMail.preview, qqNotifications.preview]);

  return (
    <main
      className={`stage stage--font-${settings.fontFamily}`}
      style={stageStyle}
    >
      <IslandShell
        qqMail={qqMail}
        qqNotifications={qqNotifications}
        wechatReminders={wechatReminders}
        onOpenMessages={openMessages}
        mode={mode}
        page={page}
        appearanceMode={settings.appearanceMode}
        nativeGlassState={nativeGlassState}
        isTucked={isTucked}
        isDetached={isPositionDetached || settings.marginY > 0}
        showTitle={settings.showTitle}
        showCollapsedText={settings.showCollapsedText}
        collapsedTaskTitle={collapsedTaskTitle}
        collapsedTodoCount={collapsedTodoCount}
        mediaState={mediaState}
        agentVisualState={agentVisualState}
        agentStatusLabel={agentStatusLabel}
        petState={petState}
        onPetAction={triggerPetAction}
        onPetHoverStart={showPetHoverBubble}
        onPetHoverEnd={scheduleBubbleHide}
        collapsedScale={settings.collapsedScale}
        sleepAfterSeconds={settings.sleepAfterSeconds}
        overlay={petOverlay}
        overlayOpen={overlayOpen}
        overlayPlacement={overlayPlacement}
        onOverlayEnter={markOverlayEnter}
        onOverlayLeave={markOverlayLeave}
        onOverlayClose={hidePetOverlay}
        onOpenPage={openIslandPage}
        clickSquash={settings.clickSquash}
        autoRotateExpressions={settings.autoRotateExpressions}
        mouseInteractions={settings.mouseInteractions}
        onWindowDragStart={startIslandDrag}
        onCollapse={collapseIsland}
        onResetPosition={resetIslandPosition}
        onMinimize={minimizeIsland}
        onReveal={revealIsland}
        onSleepTuck={tuckForSleep}
        onSleepReveal={revealForSleep}
        onPageChange={setPage}
      >
        {page === "qq" && (
          <div className="message-panel">
            <MessagesPanel qqMail={qqMail} qqNotifications={qqNotifications} wechatReminders={wechatReminders} source={messageSource} onSourceChange={openMessages} />
          </div>
        )}
        {page === "layout" && (
          <LayoutEditor
            locale={locale}
            settings={settings}
            qqNotifications={qqNotifications}
            wechatReminders={wechatReminders}
            clipboardSettings={clipboardHistory.settings}
            saveDirectoryDraft={saveDirectoryDraft}
            savePathState={savePathState}
            highlightSavePath={saveState === "needs-path"}
            presets={settingPresets}
            launchAtStartup={launchAtStartup}
            agentStatus={agentStatus}
            clearingAgentProvider={clearingAgentProvider}
            agentHooksInstallState={agentHooksInstallState}
            agentHooksInstallResult={agentHooksInstallResult}
            agentHooksInstallError={agentHooksInstallError}
            onLocaleChange={onLocaleChange}
            onSettingsChange={setSettings}
            onClipboardSettingsChange={updateClipboardSettings}
            onReset={resetSettings}
            onSaveDirectoryDraftChange={setSaveDirectoryDraft}
            onSaveDirectory={saveDirectoryFromEditor}
            onSavePreset={saveSettingsPreset}
            onApplyPreset={applySettingsPreset}
            onRenamePreset={renameSettingsPreset}
            onDeletePreset={deleteSettingsPreset}
            onLaunchAtStartupChange={updateLaunchAtStartup}
            onClearAgentStatus={clearAgentStatus}
            onInstallAgentHooks={installAgentHooks}
          />
        )}
        {page === "music" && (
          <MusicPlayerPanel
            mediaState={mediaState}
            isTrackChanging={isMediaTrackChanging}
            commandError={mediaCommandError}
            sourcePriority={musicSourcePriority}
            settingsOpen={musicSettingsOpen}
            onToggleSettings={() => setMusicSettingsOpen((open) => !open)}
            onPlayPause={() => void runMediaCommand("media_play_pause")}
            onNext={() => void runMediaCommand("media_next")}
            onPrevious={() => void runMediaCommand("media_previous")}
            onSeek={(positionMs) => void seekMedia(positionMs)}
            onSetVolume={(level) => void setMediaVolume(level)}
            onToggleShuffle={() => void runMediaCommand("media_toggle_shuffle")}
            onCycleRepeat={() => void runMediaCommand("media_cycle_repeat")}
            lyrics={lyrics}
            onReorderSource={reorderMusicSource}
            onRemoveSource={removeMusicSource}
          />
        )}
        {page === "clipboard" && (
          <ClipboardHistoryPanel
            snapshot={clipboardHistory}
            onCopyItem={copyClipboardHistoryItem}
            onToggleFavorite={(id) => void toggleClipboardHistoryFavorite(id)}
            onUpdateNote={updateClipboardHistoryItemNote}
            onDeleteItem={(id) => void deleteClipboardHistoryItem(id)}
            onClear={() => void clearClipboardHistoryItems()}
          />
        )}
        {page === "assistant" && <AssistantPanel />}
        {page === "video" && <VideoPage />}
        {page === "chat" && <PetChat />}
        {page === "onboarding" && <OnboardingPanel onFinish={finishOnboarding} />}
        {page === "todo" && (
          <TodoNotebook
            todos={todos}
            dailyNote={dailyNote}
            diaryEvents={diaryEvents}
            draft={draftTodo}
            activeTodoId={activeTodoId}
            currentDate={currentTodoDate}
            pageMode={todoPageMode}
            archives={archives}
            archiveLayout={archiveLayout}
            selectedArchive={selectedArchive}
            saveState={saveState}
            onDraftChange={setDraftTodo}
            onAddTodo={addTodo}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodoTitle}
            onStartTodo={startTodo}
            onDeleteTodo={deleteTodo}
            onReorderTodo={reorderTodo}
            onSaveToday={saveTodayTodos}
            onShowArchive={showArchive}
            onShowDaily={showDaily}
            onShowToday={showToday}
            onDailyNoteChange={setDailyNote}
            onArchiveLayoutChange={setArchiveLayout}
            onSelectArchive={selectArchive}
          />
        )}
      </IslandShell>
    </main>
  );
}

function App() {
  const { locale, setLocale } = useLocale();

  return (
    <IslandApp locale={locale} onLocaleChange={setLocale} />
  );
}

export default App;