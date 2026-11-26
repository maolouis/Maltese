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
  /** 错峰延迟（0–120ms）。 */
  delayMs: number;
  /** 这只狗要说的台词（双狗剧本；缺省时接收端用通用台词兜底）。 */
  line?: string;
  /** 说话角色（决定 GIF 与台词是否一致）。 */
  speaker?: "xiaobai" | "xiaojimao";
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
      /** 是否附带一句小气泡（增强版：每次联动都带，1.2s）。 */
      bubble: boolean;
      /** 主狗在屏幕上的位置，陪玩狗据此决定「朝主狗方向」的位移方向。 */
      origin?: { x: number; y: number };
      /** 这次动作要不要同时通知 Bongo（happy/celebrate 必敲）。 */
      toBongo?: boolean;
      /** 剧本场景（pet / eating / cheerful / bongo），dev 日志与验收用。 */
      sceneId?: string;
      /** 主狗自己说的那句（随从说另一句；无随从时是自说）。 */
      mainLine?: string;
      /** 主狗那句的延迟（成对台词里另一只先说）。 */
      mainDelayMs?: number;
    }
  | {
      kind: "bongo-hit";
      source: string;
      seq: number;
      at: number;
    };

// ---- 防线参数（增强版：一眼看得见；仍保留节流/上限/回声抑制） ----
/** 首只陪玩狗必定触发（0.6 → 1.0）。 */
/** 实例联动 feature flag：先下线（2026-11-20），代码/文档保留，修好后改回 true 即可。 */
export const PET_LINK_ENABLED = false;

export const PET_LINK_PROBABILITY = 1;
/** 第二只仍按概率（0.5），单次最多 2 只。 */
export const PET_LINK_SECOND_PROBABILITY = 0.5;
export const PET_LINK_MAX_INSTANCES = 2;
/** 错峰 0–300ms → 0–120ms。 */
export const PET_LINK_STAGGER_MAX_MS = 120;
/** 同动作冷却 1.5s → 0.8s。 */
export const PET_LINK_ACTION_COOLDOWN_MS = 800;
export const PET_LINK_RATE_WINDOW_MS = 1000;
export const PET_LINK_RATE_LIMIT = 4;
/** 每次联动必带气泡；气泡冷却压到与动作冷却一致（800ms）。 */
export const PET_LINK_BUBBLE_COOLDOWN_MS = 800;
/** 陪玩狗动作持续时间（A1：2.6s±0.3s 后回 idle）。 */
export const PET_LINK_ACTION_MS = 2600;
/** 气泡停留（增强版 1.2s）。 */
export const PET_LINK_BUBBLE_MS = 1800;
/** 位移反馈：朝主狗方向 8–16px 再回位。 */
export const PET_LINK_SHIFT_MIN_PX = 8;
export const PET_LINK_SHIFT_MAX_PX = 16;
/** 缩放脉冲 1.0 → 1.08 → 1.0，260ms。 */
export const PET_LINK_PULSE_MS = 260;
export const PET_LINK_PULSE_SCALE = 1.08;
/** 主狗对 Bongo 敲击的摇尾巴/轻跳时长（300ms 内必响应）。 */
export const PET_LINK_MAIN_HOP_MS = 300;
export const PET_LINK_MAIN_REACTION_MS = 1200;
/** Bongo 连续敲击的最小间隔（毫秒），保证「敲一次→主狗一次」。 */
export const PET_LINK_BONGO_THROTTLE_MS = 250;
/** 预览按钮：临时窗口存在时间。 */
export const PET_LINK_PREVIEW_MS = 3000;

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

/** 每次联动都附带一句短台词气泡（增强版：不再按 1/3 概率抽）。 */
export function shouldAttachBubble(_action: PetLinkAction): boolean {
  return true;
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
  /** 掷概率 + 选实例 + 分配错峰延迟；返回空数组表示这次不联动。
   * `force: true` 时跳过概率/冷却/限速（「试一下联动」按钮用，保证一次必中）。 */
  planTargets: (labels: string[], action: string, now: number, options?: { force?: boolean }) => PetLinkTarget[];
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

  const planTargets = (
    labels: string[],
    action: string,
    now: number,
    options?: { force?: boolean },
  ): PetLinkTarget[] => {
    if (labels.length === 0) return [];
    const force = options?.force === true;
    if (!force) {
      if (!canSend(action, now)) return [];
      if (random() >= probability) return [];
    }
    const cap = Math.min(labels.length, Math.max(0, maxInstances));
    if (cap <= 0) return [];
    // 增强版：首只必定触发；第二只仍按 0.5 概率（单次最多 2 只）。
    const wanted = !force && cap >= 2 && random() < PET_LINK_SECOND_PROBABILITY ? 2 : 1;
    const pool = [...labels];
    // Fisher–Yates：让「哪两只狗」随机，而不是永远 companion-1/2。
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool.slice(0, wanted).map((label, index) => ({
      label,
      // 0–120ms 错峰：第一个 0，其余随机（避免所有狗同一帧一起动）。
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
  // Bongo 走独立路由：主狗 happy/celebrate 带 toBongo 标记时，即使 targets 里没有
  // bongo-pet（它不在陪玩狗网格里），也必定收到一次敲击。
  const isBongo = options.self === "bongo-pet" && message.toBongo === true;
  const target = message.targets.find((item) => item.label === options.self);
  if (!target && !isBongo) return REJECT;
  const last = state.lastActionAt.get(message.action);
  if (last !== undefined && options.now - last < actionCooldownMs) return REJECT;
  state.lastActionAt.set(message.action, options.now);
  if (isBongo) {
    // Bongo 只做敲击反馈，不冒泡、不错峰。
    return { accept: true, bubble: false, delayMs: 0 };
  }
  if (!target) return REJECT;

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

export type PetLinkEmitOptions = {
  /** 跳过概率/冷却/限速（「试一下联动」按钮用）。 */
  force?: boolean;
  /** 覆盖目标窗口（预览时临时只发给 companion-1）。 */
  labels?: string[];
  /** 主狗屏幕位置，供陪玩狗算位移方向。 */
  origin?: { x: number; y: number };
  /** 是否同时通知 Bongo（happy/celebrate 必敲）。 */
  toBongo?: boolean;
  /** 双狗剧本：每个目标窗口要说的那句台词。 */
  lines?: Record<string, { line: string; speaker: "xiaobai" | "xiaojimao" }>;
  /** 剧本场景 id（pet / eating / cheerful / bongo）。 */
  sceneId?: string;
  /** 主狗自己说的那句。 */
  mainLine?: string;
  /** 主狗那句的延迟（成对台词里另一只先说）。 */
  mainDelayMs?: number;
  now?: number;
};

export type PetLinkBus = {
  /** 主狗动作：返回本次真正命中的目标（便于 dev 日志/验收），未联动返回空数组。 */
  emitAction: (action: PetLinkAction, options?: PetLinkEmitOptions) => PetLinkTarget[];
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
  const enabled = options.enabled ?? (() => PET_LINK_ENABLED && readPetLinkageEnabled());
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
    emitAction: (action, emitOptions) => {
      try {
        if (!PET_LINK_ENABLED && options.enabled === undefined) {
          console.info("[PET_LINK_DISABLED]", { action });
          return [];
        }
        if (!enabled()) return [];
        const labels = emitOptions?.labels ?? companionLabels();
        const at = emitOptions?.now ?? now();
        const planned = governor.planTargets(labels, action, at, { force: emitOptions?.force });
        // 把剧本台词挂到命中目标上（双狗各说一句，来自同一组）。
        const lines = emitOptions?.lines;
        const targets = planned.map((target) => {
          const entry = lines ? lines[target.label] : undefined;
          return entry ? { ...target, line: entry.line, speaker: entry.speaker } : target;
        });
        const toBongo = emitOptions?.toBongo === true;
        // 没有陪玩狗时也要把消息发出去（Bongo 可能在场 / 主狗要自说），
        // 否则「主狗 celebrate → Bongo 必敲」在 petCount=1 时永远收不到。
        if (targets.length === 0 && !toBongo && !emitOptions?.mainLine) return [];
        seq += 1;
        post({
          kind: "action",
          action,
          source: options.source,
          seq,
          at,
          targets,
          // 增强版：每次联动都带一句短台词。
          bubble: shouldAttachBubble(action),
          origin: emitOptions?.origin,
          toBongo,
          sceneId: emitOptions?.sceneId,
          mainLine: emitOptions?.mainLine,
          mainDelayMs: emitOptions?.mainDelayMs,
        });
        return targets;
      } catch {
        return [];
      }
    },
    emitBongoHit: () => {
      try {
        if (!PET_LINK_ENABLED && options.enabled === undefined) {
          console.info("[PET_LINK_DISABLED]", { action: "bongo-hit" });
          return;
        }
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