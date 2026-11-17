// 多实例联动总线（初版：L1 情绪传染 + L2 Bongo 呼应）。
//
// 「多实例」= 同一个 Maltese 进程里的多个透明 WebView 窗口（main / companion-* /
// bongo-pet）。它们同源（`http://tauri.localhost`），所以优先用
// `BroadcastChannel` 做窗口间广播：同步、不会丢事件、不需要在 Rust 侧注册命令；
// 没有 BroadcastChannel 时退回 Tauri 全局事件（`maltese-pet-link`）。
//
// 所有防线（概率 / 上限 / 错峰 / 冷却 / 限速 / 回声抑制）都在这一个文件里，
// 用纯函数实现，方便 `tests/pet-link-bus.test.mjs` 直接单测：
//   - 发送端不会因为联动失败影响主链路（post 包 try/catch，不 await）；
//   - 接收端只播动作、不再转发（`source === self` 直接丢弃）；
//   - 联动开关关闭时零事件。
//
// 设计文档：`docs/multi-instance-linkage-design.md` §2 L1/L2、§3 MVP、§5 风险。

import { emit, listen } from "@tauri-apps/api/event";

/** 主狗动作 → 联动动作（陪玩狗播哪个状态的帧）。 */
export type PetLinkAction = "pet" | "eating" | "happy" | "celebrate";

export type PetLinkTarget = {
  /** 目标窗口 label：companion-1 … companion-4。 */
  label: string;
  /** 错峰延迟（0–300ms）。 */
  delayMs: number;
};

export type PetLinkMessage =
  | {
      kind: "action";
      action: PetLinkAction;
      source: string;
      seq: number;
      at: number;
      /** 本次命中的陪玩狗（空数组表示没有实例参与）。 */
      targets: PetLinkTarget[];
      /** 是否附带一句小气泡（发送端按 ~1/3 决定）。 */
      bubble: boolean;
    }
  | {
      kind: "bongo-hit";
      source: string;
      seq: number;
      at: number;
    };

// ---- 防线参数（与设计文档 §5 一致，单测锁定这些数值） ----
export const PET_LINK_PROBABILITY = 0.6;
export const PET_LINK_MAX_INSTANCES = 2;
export const PET_LINK_STAGGER_MAX_MS = 300;
export const PET_LINK_ACTION_COOLDOWN_MS = 1500;
export const PET_LINK_RATE_WINDOW_MS = 1000;
export const PET_LINK_RATE_LIMIT = 4;
export const PET_LINK_BUBBLE_COOLDOWN_MS = 8000;
/** 陪玩狗动作持续时间（A1：2.6s±0.3s 后回 idle）。 */
export const PET_LINK_ACTION_MS = 2600;
/** 主狗动作被打断后的恢复时间（Bongo→主狗 A5：1.2s）。 */
export const PET_LINK_MAIN_REACTION_MS = 1200;

export const PET_LINK_CHANNEL_NAME = "maltese-pet-link";
export const PET_LINK_TAURI_EVENT = "maltese-pet-link";
export const PET_LINK_SETTINGS_KEY = "focusd-island-settings";

/** 主狗可触发的联动动作。返回 null 表示这个动作不联动。 */
export function linkActionForPetAction(action: string): PetLinkAction | null {
  if (action === "pet") return "pet";
  if (action === "eating") return "eating";
  if (action === "happy") return "happy";
  if (action === "celebrate") return "celebrate";
  return null;
}

/** 联动动作 → GIF 轮播状态（`rotationFramesForState` 的 state key）。 */
export function linkStateForAction(action: PetLinkAction): string {
  return action;
}

/** 该动作要不要顺带冒一句小气泡（Bongo 呼应不冒泡）。 */
export function shouldAttachBubble(action: PetLinkAction): boolean {
  return action !== "celebrate";
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 只读联动开关；没写过任何设置时默认开（产品口径）。 */
export function readPetLinkageEnabled(storage: Storage | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(PET_LINK_SETTINGS_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.petLinkage !== false;
  } catch {
    return true;
  }
}

/** 陪玩狗窗口 label 列表（主狗数量 - 1，最多 4 个）。 */
export function readCompanionLabels(storage: Storage | null = safeStorage()): string[] {
  let petCount = 1;
  if (storage) {
    try {
      const raw = storage.getItem(PET_LINK_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = Number(parsed.petCount);
        if (Number.isFinite(value)) petCount = Math.round(value);
      }
    } catch {
      // 设置损坏时按默认 1 只处理。
    }
  }
  const count = Math.max(0, Math.min(4, petCount - 1));
  return Array.from({ length: count }, (_, index) => `companion-${index + 1}`);
}

// ---------------------------------------------------------------------------
// 发送端防线：概率 / 单次上限 / 错峰 / 同动作冷却 / 全局限速
// ---------------------------------------------------------------------------

export type LinkGovernorOptions = {
  random?: () => number;
  probability?: number;
  maxInstances?: number;
  staggerMaxMs?: number;
  actionCooldownMs?: number;
  rateWindowMs?: number;
  rateLimit?: number;
};

export type LinkGovernor = {
  /** 未被限速/冷却时可以发送（会记账）。 */
  canSend: (action: string, now: number) => boolean;
  /** 掷概率 + 选实例 + 分配错峰延迟；返回空数组表示这次不联动。 */
  planTargets: (labels: string[], action: string, now: number) => PetLinkTarget[];
  /** 测试/重连用：清空记账。 */
  reset: () => void;
};

export function createLinkGovernor(options: LinkGovernorOptions = {}): LinkGovernor {
  const random = options.random ?? Math.random;
  const probability = options.probability ?? PET_LINK_PROBABILITY;
  const maxInstances = options.maxInstances ?? PET_LINK_MAX_INSTANCES;
  const staggerMaxMs = options.staggerMaxMs ?? PET_LINK_STAGGER_MAX_MS;
  const actionCooldownMs = options.actionCooldownMs ?? PET_LINK_ACTION_COOLDOWN_MS;
  const rateWindowMs = options.rateWindowMs ?? PET_LINK_RATE_WINDOW_MS;
  const rateLimit = options.rateLimit ?? PET_LINK_RATE_LIMIT;

  let sentAt: number[] = [];
  const lastByAction = new Map<string, number>();

  const canSend = (action: string, now: number): boolean => {
    sentAt = sentAt.filter((at) => now - at < rateWindowMs);
    if (sentAt.length >= rateLimit) return false;
    const last = lastByAction.get(action);
    if (last !== undefined && now - last < actionCooldownMs) return false;
    sentAt.push(now);
    lastByAction.set(action, now);
    return true;
  };

  const planTargets = (labels: string[], action: string, now: number): PetLinkTarget[] => {
    if (labels.length === 0) return [];
    if (!canSend(action, now)) return [];
    if (random() >= probability) return [];
    const cap = Math.min(labels.length, Math.max(0, maxInstances));
    if (cap <= 0) return [];
    const wanted = cap >= 2 && random() < 0.5 ? 2 : 1;
    const pool = [...labels];
    // Fisher–Yates：让「哪两只狗」随机，而不是永远 companion-1/2。
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool.slice(0, wanted).map((label, index) => ({
      label,
      // 0–300ms 错峰：第一个 0，其余随机（避免所有狗同一帧一起动）。
      delayMs: index === 0 ? 0 : Math.floor(random() * (staggerMaxMs + 1)),
    }));
  };

  return {
    canSend,
    planTargets,
    reset: () => {
      sentAt = [];
      lastByAction.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// 接收端防线：回声抑制 / 旧事件丢弃 / 同动作冷却 / 气泡冷却
// ---------------------------------------------------------------------------

export type LinkReceiverState = {
  lastSeq: number;
  lastActionAt: Map<string, number>;
  lastBubbleAt: Map<string, number>;
};

export function createLinkReceiverState(): LinkReceiverState {
  return { lastSeq: 0, lastActionAt: new Map(), lastBubbleAt: new Map() };
}

export type LinkAcceptOptions = {
  /** 自己的窗口 label（companion-2 / bongo-pet / main）。 */
  self: string;
  now: number;
  enabled?: boolean;
  actionCooldownMs?: number;
  bubbleCooldownMs?: number;
};

export type LinkAcceptResult = {
  accept: boolean;
  /** 这次要不要冒泡（气泡冷却已通过才算）。 */
  bubble: boolean;
  delayMs: number;
};

const REJECT: LinkAcceptResult = { accept: false, bubble: false, delayMs: 0 };

/**
 * 接收端判定（纯函数，直接改传入的 state）：
 * - 开关关闭 / 自己的事件（回声环）/ 旧 seq / 不在 targets 里 → 丢弃；
 * - 同动作 1.5s 冷却；小气泡每实例 8s 冷却。
 */
export function acceptLinkMessage(
  message: PetLinkMessage,
  state: LinkReceiverState,
  options: LinkAcceptOptions,
): LinkAcceptResult {
  if (options.enabled === false) return REJECT;
  if (message.source === options.self) return REJECT;
  if (message.seq <= state.lastSeq) return REJECT;
  state.lastSeq = message.seq;
  if (message.kind !== "action") return { accept: false, bubble: false, delayMs: 0 };

  const actionCooldownMs = options.actionCooldownMs ?? PET_LINK_ACTION_COOLDOWN_MS;
  const bubbleCooldownMs = options.bubbleCooldownMs ?? PET_LINK_BUBBLE_COOLDOWN_MS;
  const target = message.targets.find((item) => item.label === options.self);
  if (!target) return REJECT;
  const last = state.lastActionAt.get(message.action);
  if (last !== undefined && options.now - last < actionCooldownMs) return REJECT;
  state.lastActionAt.set(message.action, options.now);

  let bubble = false;
  if (message.bubble) {
    const lastBubble = state.lastBubbleAt.get(message.action);
    if (lastBubble === undefined || options.now - lastBubble >= bubbleCooldownMs) {
      state.lastBubbleAt.set(message.action, options.now);
      bubble = true;
    }
  }
  return { accept: true, bubble, delayMs: Math.max(0, target.delayMs) };
}

// ---------------------------------------------------------------------------
// 通道：BroadcastChannel（首选）/ Tauri 全局事件（兜底）
// ---------------------------------------------------------------------------

type LinkChannel = {
  post: (message: PetLinkMessage) => void;
  subscribe: (handler: (message: PetLinkMessage) => void) => () => void;
};

type BroadcastChannelLike = {
  postMessage: (value: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

function isPetLinkMessage(value: unknown): value is PetLinkMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "action" && candidate.kind !== "bongo-hit") return false;
  return typeof candidate.source === "string" && typeof candidate.seq === "number";
}

/** BroadcastChannel 通道：所有窗口同源，同步广播、不需要等待 IPC。 */
export function createBroadcastLinkChannel(
  createChannel: (name: string) => BroadcastChannelLike | null = (name) =>
    typeof BroadcastChannel === "function" ? (new BroadcastChannel(name) as unknown as BroadcastChannelLike) : null,
): LinkChannel | null {
  const channel = createChannel(PET_LINK_CHANNEL_NAME);
  if (!channel) return null;
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // 联动失败不影响主链路。
      }
    },
    subscribe: (handler) => {
      channel.onmessage = (event) => {
        if (isPetLinkMessage(event.data)) handler(event.data);
      };
      return () => {
        channel.onmessage = null;
      };
    },
  };
}

/** Tauri 全局事件通道：没有 BroadcastChannel 的环境兜底。 */
export function createTauriLinkChannel(): LinkChannel {
  return {
    post: (message) => {
      void emit(PET_LINK_TAURI_EVENT, message).catch(() => undefined);
    },
    subscribe: (handler) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<PetLinkMessage>(PET_LINK_TAURI_EVENT, (event) => {
        if (isPetLinkMessage(event.payload)) handler(event.payload);
      })
        .then((cleanup) => {
          if (disposed) cleanup();
          else unlisten = cleanup;
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

export type PetLinkBus = {
  /** 主狗动作：返回本次真正命中的目标（便于 dev 日志/验收），未联动返回空数组。 */
  emitAction: (action: PetLinkAction, now?: number) => PetLinkTarget[];
  /** Bongo 敲击：广播给主狗（主狗只播 happy，不转发）。 */
  emitBongoHit: () => void;
  subscribe: (handler: (message: PetLinkMessage) => void) => () => void;
};

export type PetLinkBusOptions = {
  source: string;
  channel?: LinkChannel | null;
  governor?: LinkGovernor;
  now?: () => number;
  random?: () => number;
  enabled?: () => boolean;
  companionLabels?: () => string[];
};

const devMode = Boolean(import.meta.env?.DEV);

export function createPetLinkBus(options: PetLinkBusOptions): PetLinkBus {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const governor = options.governor ?? createLinkGovernor({ random });
  const channel = options.channel === undefined ? createBroadcastLinkChannel() ?? createTauriLinkChannel() : options.channel;
  const enabled = options.enabled ?? (() => readPetLinkageEnabled());
  const companionLabels = options.companionLabels ?? (() => readCompanionLabels());
  let seq = 0;

  const post = (message: PetLinkMessage) => {
    if (!channel) return;
    channel.post(message);
    // 设计文档 §5：dev 下一行调试日志，生产静默。
    if (devMode) {
      console.debug("[pet-link]", message.kind, message);
    }
  };

  return {
    emitAction: (action, currentTime) => {
      try {
        if (!enabled()) return [];
        const labels = companionLabels();
        const at = currentTime ?? now();
        const targets = governor.planTargets(labels, action, at);
        if (targets.length === 0) return [];
        seq += 1;
        post({
          kind: "action",
          action,
          source: options.source,
          seq,
          at,
          targets,
          bubble: shouldAttachBubble(action) && random() < 1 / 3,
        });
        return targets;
      } catch {
        return [];
      }
    },
    emitBongoHit: () => {
      try {
        if (!enabled()) return;
        seq += 1;
        post({ kind: "bongo-hit", source: options.source, seq, at: now() });
      } catch {
        // 忽略：联动不能影响 Bongo 自身显示。
      }
    },
    subscribe: (handler) => (channel ? channel.subscribe(handler) : () => undefined),
  };
}

let singleton: PetLinkBus | null = null;

/** 每个窗口一个总线单例；source 用窗口 label（main / companion-1 / bongo-pet）。 */
export function getPetLinkBus(source: string): PetLinkBus {
  if (!singleton) singleton = createPetLinkBus({ source });
  return singleton;
}

export function resetPetLinkBusForTests() {
  singleton = null;
}