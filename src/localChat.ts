export type ChatBackend = "dsh" | "local";

export type LocalChatConfig = {
  backend: ChatBackend;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  enableThinking: boolean;
  stream: boolean;
};

export const LOCAL_CHAT_STORAGE_KEY = "maltese-local-chat-settings";
export const LOCAL_CHAT_UPDATED_EVENT = "maltese-local-chat-settings-updated";

export const DEFAULT_LOCAL_CHAT: LocalChatConfig = {
  backend: "dsh",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "",
  apiKey: "",
  maxTokens: 256,
  temperature: 0.7,
  topP: 0.9,
  enableThinking: false,
  stream: true,
};

export function loadLocalChatConfig(): LocalChatConfig {
  try {
    const raw = window.localStorage.getItem(LOCAL_CHAT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LOCAL_CHAT };
    const parsed = JSON.parse(raw) as Partial<LocalChatConfig>;
    return {
      backend: parsed.backend === "local" ? "local" : "dsh",
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim()
        : DEFAULT_LOCAL_CHAT.baseUrl,
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
      stream: parsed.stream !== false,
    };
  } catch {
    return { ...DEFAULT_LOCAL_CHAT };
  }
}

export function saveLocalChatConfig(config: LocalChatConfig) {
  const next: LocalChatConfig = {
    backend: config.backend === "local" ? "local" : "dsh",
    baseUrl: config.baseUrl.trim() || DEFAULT_LOCAL_CHAT.baseUrl,
    model: config.model.trim(),
    apiKey: config.apiKey,
    maxTokens: Math.max(32, Math.min(2048, Math.round(config.maxTokens || DEFAULT_LOCAL_CHAT.maxTokens))),
    temperature: Math.max(0, Math.min(2, Number(config.temperature))),
    topP: Math.max(0.1, Math.min(1, Number(config.topP))),
    enableThinking: config.enableThinking === true,
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
