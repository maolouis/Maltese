export type ChatBackend = "dsh" | "local";

/** 思考深度：关 / 浅 / 标准 / 深，映射到 reasoning_effort 与思考预算。 */
export type ThinkingDepth = "off" | "shallow" | "normal" | "deep";

export const THINKING_DEPTHS: Array<{ value: ThinkingDepth; label: string; hint: string }> = [
  { value: "off", label: "关", hint: "不思考，最快，适合闲聊" },
  { value: "shallow", label: "浅", hint: "轻量推理，回复快" },
  { value: "normal", label: "标准", hint: "默认，平衡速度与质量" },
  { value: "deep", label: "深", hint: "多花时间推理，复杂问题更稳" },
];

export function thinkingEffort(depth: ThinkingDepth): "none" | "low" | "medium" | "high" {
  if (depth === "off") return "none";
  if (depth === "shallow") return "low";
  if (depth === "deep") return "high";
  return "medium";
}

export function thinkingBudget(depth: ThinkingDepth): number {
  if (depth === "off") return 0;
  if (depth === "shallow") return 128;
  if (depth === "deep") return 1536;
  return 512;
}

export type LocalChatConfig = {
  backend: ChatBackend;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  enableThinking: boolean;
  /** 思考深度；enableThinking 由它派生，保留字段兼容旧配置。 */
  thinkingDepth: ThinkingDepth;
  /** 是否在聊天里展示思考过程（默认折叠，可展开）。 */
  showThinking: boolean;
  stream: boolean;
};

export const LOCAL_CHAT_STORAGE_KEY = "maltese-local-chat-settings";
export const LOCAL_CHAT_UPDATED_EVENT = "maltese-local-chat-settings-updated";

export const DEFAULT_LOCAL_CHAT: LocalChatConfig = {
  backend: "local",
  // 默认留空：本地模型是用户自己装的服务，不同机器地址和模型名都不一样，
  // 不能把某台电脑的 Strata 部署（8080 / qwen3.6…）当成出厂默认。
  // 需要的话在设置里点 Ollama / LM Studio / Strata 预设，或手动填。
  baseUrl: "",
  model: "",
  apiKey: "",
  maxTokens: 256,
  temperature: 0.7,
  topP: 0.9,
  enableThinking: false,
  thinkingDepth: "off",
  showThinking: true,
  stream: true,
};

export function loadLocalChatConfig(): LocalChatConfig {
  try {
    const raw = window.localStorage.getItem(LOCAL_CHAT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LOCAL_CHAT };
    const parsed = JSON.parse(raw) as Partial<LocalChatConfig>;
    return {
      backend: parsed.backend === "local" ? "local" : "dsh",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
      model: typeof parsed.model === "string" ? parsed.model.trim() : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      maxTokens: typeof parsed.maxTokens === "number" && Number.isFinite(parsed.maxTokens)
        ? Math.max(32, Math.min(2048, Math.round(parsed.maxTokens)))
        : DEFAULT_LOCAL_CHAT.maxTokens,
      temperature: typeof parsed.temperature === "number" && Number.isFinite(parsed.temperature)
        ? Math.max(0, Math.min(2, parsed.temperature))
        : DEFAULT_LOCAL_CHAT.temperature,
      topP: typeof parsed.topP === "number" && Number.isFinite(parsed.topP)
        ? Math.max(0.1, Math.min(1, parsed.topP))
        : DEFAULT_LOCAL_CHAT.topP,
      enableThinking: parsed.enableThinking === true,
      thinkingDepth:
        parsed.thinkingDepth === "shallow" ||
        parsed.thinkingDepth === "normal" ||
        parsed.thinkingDepth === "deep"
          ? parsed.thinkingDepth
          : parsed.enableThinking === true
            ? "normal"
            : "off",
      showThinking: parsed.showThinking !== false,
      stream: parsed.stream !== false,
    };
  } catch {
    return { ...DEFAULT_LOCAL_CHAT };
  }
}

export function saveLocalChatConfig(config: LocalChatConfig) {
  const next: LocalChatConfig = {
    backend: config.backend === "local" ? "local" : "dsh",
    // 空值就是空值：以前这里会把清空的地址强行填回默认的 Strata 地址，用户清不掉。
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
    apiKey: config.apiKey,
    maxTokens: Math.max(32, Math.min(2048, Math.round(config.maxTokens || DEFAULT_LOCAL_CHAT.maxTokens))),
    temperature: Math.max(0, Math.min(2, Number(config.temperature))),
    topP: Math.max(0.1, Math.min(1, Number(config.topP))),
    enableThinking: config.thinkingDepth !== "off",
    thinkingDepth:
      config.thinkingDepth === "shallow" ||
      config.thinkingDepth === "normal" ||
      config.thinkingDepth === "deep"
        ? config.thinkingDepth
        : "off",
    showThinking: config.showThinking !== false,
    stream: config.stream !== false,
  };
  try {
    window.localStorage.setItem(LOCAL_CHAT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储失败时当前会话仍然使用内存里的配置。
  }
  window.dispatchEvent(new CustomEvent(LOCAL_CHAT_UPDATED_EVENT, { detail: next }));
  return next;
}
