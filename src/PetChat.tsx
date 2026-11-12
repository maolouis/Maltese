import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, Hand, ImagePlus, LoaderCircle, Send, Settings2, Sparkles, Trash2, Wrench, X } from "lucide-react";
import { useTranslation } from "./i18n";
import { LocalChatSettings } from "./LocalChatSettings";
import { PetSkillsSettings } from "./PetSkillsSettings";
import { ChatText } from "./ChatText";
import { ChatReasoning } from "./ChatReasoning";
import {
  loadCustomSkills,
  loadEnabledSkills,
  parseSkillCall,
  runSkill,
  skillsPrompt,
} from "./petSkills";
import { usePetCharacter } from "./petCharacters";
import {
  loadLocalChatConfig,
  LOCAL_CHAT_UPDATED_EVENT,
  thinkingBudget,
  thinkingEffort,
  type LocalChatConfig,
} from "./localChat";
import "./PetChat.css";

type DshChatReply = { text: string; sessionId: string | null };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  imageCount?: number;
  /** 消息里展示的缩略图（data URL）；发送给模型的是另一份更大的图。 */
  thumbnails?: string[];
  /** 小狗实际执行了什么动作（例如记待办），显示成一条小提示。 */
  toolNote?: string;
  /** 模型的思考过程（折叠展示）。 */
  reasoning?: string;
};

type LocalChatStreamEvent = {
  requestId: string;
  kind: "delta" | "done" | "error" | "reasoning";
  text: string;
};

const MESSAGES_KEY = "focusd-island-pet-chat-messages";
const MAX_IMAGES = 4;
const SEND_IMAGE_MAX_SIDE = 1280;
const THUMB_IMAGE_MAX_SIDE = 360;

/** 把图片文件压到指定最长边，返回 data URL（避免把几 MB 的原图塞进请求/存储）。 */
async function fileToDataUrl(file: File, maxSide: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return "";
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", quality);
}
const SESSION_KEY = "focusd-island-pet-chat-session";
const MAX_MESSAGES = 60;

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ChatMessage =>
        Boolean(item)
        && typeof item === "object"
        && (item as ChatMessage).role !== undefined
        && typeof (item as ChatMessage).text === "string",
      )
      .slice(-MAX_MESSAGES);
  } catch {
    return [];
  }
}

export function PetChat() {
  const t = useTranslation();
  const character = usePetCharacter();
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    window.localStorage.getItem(SESSION_KEY),
  );
  const [draft, setDraft] = useState("");
  // 待发送的图片：sendImages 给模型，thumbnails 存消息里展示。
  const [attachments, setAttachments] = useState<{
    send: string;
    thumb: string;
  }[]>([]);
  const [streamingReply, setStreamingReply] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatConfig, setChatConfig] = useState<LocalChatConfig>(loadLocalChatConfig);
  // 是否展示思考过程：模型设置里的开关，默认展示但折叠。
  const showThinking = chatConfig.showThinking !== false;
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-agent-mode") !== "off";
    } catch {
      return true;
    }
  });
  const [enabledSkills] = useState(loadEnabledSkills);
  const [customSkills] = useState(loadCustomSkills);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 打开聊天总是停在最新一条：挂载时直接跳到底部（不要动画），
  // 之后消息变化、窗口/面板高度变化（展开动画、聊天框高度设置）都重新贴底。
  // 之前只在 messages 变化时滚一次，面板还在播放展开动画，scrollHeight 还没长完，
  // 结果打开就停在上方，得手动往下翻。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages, busy, streamingReply]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setChatConfig(loadLocalChatConfig());
    window.addEventListener("storage", sync);
    window.addEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    };
  }, []);

  const persist = useCallback((next: ChatMessage[]) => {
    const trimmed = next.slice(-MAX_MESSAGES);
    setMessages(trimmed);
    try {
      window.localStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
    } catch {
      // 存储满了也不影响当前会话。
    }
  }, []);

  const addImages = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setError(t.chat.imageLimit(MAX_IMAGES));
      return;
    }
    setError(null);
    const next: { send: string; thumb: string }[] = [];
    for (const file of imageFiles.slice(0, room)) {
      try {
        const send = await fileToDataUrl(file, SEND_IMAGE_MAX_SIDE, 0.9);
        if (!send) continue;
        next.push({ send, thumb: await fileToDataUrl(file, THUMB_IMAGE_MAX_SIDE, 0.72) });
      } catch {
        setError(t.chat.imageReadFailed);
      }
    }
    if (next.length > 0) {
      setAttachments((current) => [...current, ...next].slice(0, MAX_IMAGES));
    }
  }, [attachments.length, t.chat.imageLimit, t.chat.imageReadFailed]);

  // 非流式的模型调用：给「先决定动作、再总结」这类两步流程用。
  const askModel = useCallback(
    async (
      message: string,
      history: ChatMessage[],
      images: string[] | null,
      options?: { maxTokens?: number; temperature?: number },
    ) => {
      if (chatConfig.backend === "dsh") {
        const reply = await invoke<DshChatReply>("dsh_chat", {
          message,
          sessionId,
          character,
        });
        if (reply.sessionId) {
          setSessionId(reply.sessionId);
          window.localStorage.setItem(SESSION_KEY, reply.sessionId);
        }
        return reply.text;
      }
      // 思考深度按设置传入：关闭时不思考，深档给更多推理预算。
      const depth = chatConfig.thinkingDepth;
      const ensureModel = async () => {
        try {
          const ready = await invoke<boolean>("ensure_local_model", { baseUrl: chatConfig.baseUrl });
          return Boolean(ready);
        } catch {
          return false;
        }
      };
      try {
        return await invoke<string>("local_chat_stream", {
          requestId: createId(),
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
          character,
          images: images && images.length > 0 ? images : null,
          settings: {
            maxTokens: options?.maxTokens ?? chatConfig.maxTokens,
            temperature: options?.temperature ?? chatConfig.temperature,
            topP: chatConfig.topP,
            // 判断/总结这类短调用一律关掉思考，否则会被思考吃光预算。
            enableThinking: options ? false : depth !== "off",
            reasoningEffort: options ? "none" : thinkingEffort(depth),
            reasoningBudgetTokens: options ? 0 : thinkingBudget(depth),
          },
        });
      } catch (streamError) {
        // 连不上：先看是不是 Strata 没开，开了再试一次；仍失败就退回非流式。
        const text = String(streamError);
        if (text.includes("连接不到") || text.includes("Connection")) {
          const ready = await ensureModel();
          if (ready) {
            try {
              return await invoke<string>("local_chat_stream", {
                requestId: createId(),
                baseUrl: chatConfig.baseUrl,
                model: chatConfig.model,
                apiKey: chatConfig.apiKey.trim() || null,
                message,
                history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
                character,
                images: images && images.length > 0 ? images : null,
                settings: {
                  maxTokens: options?.maxTokens ?? chatConfig.maxTokens,
                  temperature: options?.temperature ?? chatConfig.temperature,
                  topP: chatConfig.topP,
                  enableThinking: options ? false : depth !== "off",
                  reasoningEffort: options ? "none" : thinkingEffort(depth),
                  reasoningBudgetTokens: options ? 0 : thinkingBudget(depth),
                },
              });
            } catch {
              // 继续走非流式
            }
          }
        }
        return invoke<string>("local_chat", {
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
          character,
          images: images && images.length > 0 ? images : null,
        });
      }
    },
    [
      character,
      chatConfig.apiKey,
      chatConfig.backend,
      chatConfig.baseUrl,
      chatConfig.maxTokens,
      chatConfig.model,
      chatConfig.temperature,
      chatConfig.thinkingDepth,
      chatConfig.topP,
      sessionId,
    ],
  );
  // 带界面的流式回复：边生成边把字显示出来，并把最终文本返回给调用方。
  const streamLocalReply = useCallback(
    async (message: string, history: ChatMessage[], images: string[]) => {
      const requestId = createId();
      const unlisten = chatConfig.stream
        ? await listen<LocalChatStreamEvent>("local-chat-stream", (event) => {
          if (event.payload.requestId !== requestId) return;
          if (event.payload.kind === "delta") {
            setStreamingReply((current) => current + event.payload.text);
          } else if (event.payload.kind === "reasoning") {
            setStreamingReasoning((current) => current + event.payload.text);
          } else if (event.payload.kind === "error") {
            setError(event.payload.text);
          }
        })
        : null;
      try {
        const depth = chatConfig.thinkingDepth;
        const payload = {
          requestId,
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
          character,
          images: images.length > 0 ? images : null,
          settings: {
            maxTokens: chatConfig.maxTokens,
            temperature: chatConfig.temperature,
            topP: chatConfig.topP,
            enableThinking: depth !== "off",
            reasoningEffort: thinkingEffort(depth),
            reasoningBudgetTokens: thinkingBudget(depth),
          },
        };
        if (chatConfig.stream) {
          return await invoke<string>("local_chat_stream", payload);
        }
        return await invoke<string>("local_chat", {
          baseUrl: payload.baseUrl,
          model: payload.model,
          apiKey: payload.apiKey,
          message: payload.message,
          history: payload.history,
          character: payload.character,
          images: payload.images,
        });
      } finally {
        unlisten?.();
      }
    },
    [
      character,
      chatConfig.apiKey,
      chatConfig.baseUrl,
      chatConfig.maxTokens,
      chatConfig.model,
      chatConfig.stream,
      chatConfig.temperature,
      chatConfig.thinkingDepth,
      chatConfig.topP,
    ],
  );
  const send = useCallback(async () => {
    const text = draft.trim();
    const sendImages = attachments.map((item) => item.send);
    const thumbnails = attachments.map((item) => item.thumb);
    if ((!text && sendImages.length === 0) || busy) return;
    if (!isTauri()) {
      setError(t.chat.desktopOnly);
      return;
    }
    if (chatConfig.backend === "local" && !chatConfig.model.trim()) {
      setError(t.chat.modelNotConfigured);
      setShowModelSettings(true);
      return;
    }
    if (chatConfig.backend === "dsh" && sendImages.length > 0) {
      setError(t.chat.multimodalLocalOnly);
      return;
    }
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      text,
      at: Date.now(),
      imageCount: thumbnails.length > 0 ? thumbnails.length : undefined,
      thumbnails: thumbnails.length > 0 ? thumbnails : undefined,
    };
    const next = [...messages, userMessage];
    persist(next);
    setDraft("");
    setAttachments([]);
    setError(null);
    setBusy(true);
    setStreamingReply("");
    setStreamingReasoning("");
    try {
      let replyText: string | undefined;
      // 「动手」流程：先让模型判断要不要调用本机技能。
      // 关键是这一步必须“短”：只给紧凑的技能清单、关思考、限 96 token，
      // 判断完再走正常的流式回复。之前把完整聊天历史 + 长提示词都塞进去，
      // 每句话都要等两轮完整生成才开始出字，看起来就是「回话很慢」。
      if (agentEnabled && chatConfig.backend === "local" && sendImages.length === 0) {
        const decision = await askModel(
          `${skillsPrompt(enabledSkills, customSkills)}\n\n主人说：${text}`,
          [],
          null,
          { maxTokens: 128, temperature: 0.1 },
        );
        const call = parseSkillCall(decision);
        if (call) {
          const result = await runSkill(call.action, call.args);
          const toolNote = result.ok ? result.message : `没做成：${result.message}`;
          let summary = "";
          try {
            summary = await askModel(
              `主人说：${text}\n你刚才执行的动作结果：${result.message}\n请用一句不超过 30 字的中文口语回复主人，不要输出 JSON，也不要重复格式。`,
              [],
              null,
              { maxTokens: 96, temperature: 0.8 },
            );
          } catch {
            summary = "";
          }
          replyText = (summary || result.message).trim();
          persist([
            ...next,
            {
              id: createId(),
              role: "assistant",
              text: replyText,
              at: Date.now(),
              toolNote,
            },
          ]);
          setStreamingReply("");
          setBusy(false);
          return;
        }
        // 不需要动手：丢掉这次判断结果，继续走正常流式回复，
        // 让用户第一秒就能看到字，而不是等决策那句话变成长回复。
      }
      if (chatConfig.backend === "local") {
        replyText = await streamLocalReply(text, messages, sendImages);
      } else {
        const reply = await invoke<DshChatReply>("dsh_chat", {
          message: text,
          sessionId,
          character,
        });
        if (reply.sessionId) {
          setSessionId(reply.sessionId);
          window.localStorage.setItem(SESSION_KEY, reply.sessionId);
        }
        replyText = reply.text;
      }
      const reasoningText = streamingReasoning.trim().slice(0, 4000);
      persist([
        ...next,
        {
          id: createId(),
          role: "assistant",
          text: replyText,
          at: Date.now(),
          reasoning: reasoningText ? reasoningText : undefined,
        },
      ]);
      setStreamingReply("");
      setStreamingReasoning("");
    } catch (reason) {
      setError(String(reason));
      setStreamingReply("");
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    chatConfig.apiKey,
    chatConfig.backend,
    chatConfig.baseUrl,
    chatConfig.thinkingDepth,
    chatConfig.maxTokens,
    chatConfig.model,
    chatConfig.stream,
    chatConfig.temperature,
    chatConfig.topP,
    character,
    attachments,
    draft,
    messages,
    persist,
    sessionId,
    t.chat.desktopOnly,
    t.chat.modelNotConfigured,
    t.chat.multimodalLocalOnly,
  ]);

  const clear = useCallback(() => {
    persist([]);
    setSessionId(null);
    setAttachments([]);
    setStreamingReply("");
    setError(null);
    window.localStorage.removeItem(SESSION_KEY);
  }, [persist]);

  return (
    <section className="pet-chat" aria-label={t.chat.title}>
      <header className="pet-chat__header">
        <div className="pet-chat__heading">
          <span className="pet-chat__spark"><Sparkles size={15} strokeWidth={1.9} /></span>
          <div>
            <strong>{t.chat.title}</strong>
            <small>
              {busy
                ? t.chat.thinking
                : chatConfig.backend === "local"
                  ? t.chat.modelBadgeLocal(chatConfig.model)
                  : t.chat.hint}
            </small>
          </div>
        </div>
        <div className="pet-chat__header-actions">
          <button
            className={`pet-chat__model-toggle${agentEnabled ? " is-active" : ""}`}
            type="button"
            title={agentEnabled ? "动手模式：开（点一下关闭）" : "动手模式：关（点一下开启）"}
            aria-label="动手模式"
            aria-pressed={agentEnabled}
            onClick={() => {
              const nextValue = !agentEnabled;
              setAgentEnabled(nextValue);
              try {
                window.localStorage.setItem("maltese-agent-mode", nextValue ? "on" : "off");
              } catch {
                // 忽略
              }
            }}
          >
            <Hand size={15} strokeWidth={1.8} />
          </button>
          <button
            className={`pet-chat__model-toggle${showSkills ? " is-active" : ""}`}
            type="button"
            title="技能"
            aria-label="技能"
            aria-expanded={showSkills}
            onClick={() => setShowSkills((open) => !open)}
          >
            <Wrench size={15} strokeWidth={1.8} />
          </button>
          <button
            className={`pet-chat__model-toggle${showModelSettings ? " is-active" : ""}`}
            type="button"
            title={t.chat.modelSettings}
            aria-label={t.chat.modelSettings}
            aria-expanded={showModelSettings}
            onClick={() => setShowModelSettings((open) => !open)}
          >
            <Settings2 size={15} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            type="button"
            title={t.chat.clear}
            aria-label={t.chat.clear}
            disabled={busy || messages.length === 0}
            onClick={clear}
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {showModelSettings && (
        <LocalChatSettings onClose={() => setShowModelSettings(false)} />
      )}
      {showSkills && (
        <div className="pet-chat__skills">
          <PetSkillsSettings />
        </div>
      )}

      <div className="pet-chat__list" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="pet-chat__empty">
            <span className="pet-chat__empty-dog" aria-hidden="true">🐶</span>
            <p>{t.chat.empty}</p>
            <small>{t.chat.emptyHint}</small>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`pet-chat__bubble pet-chat__bubble--${message.role}`}
          >
            {message.thumbnails && message.thumbnails.length > 0 && (
              <div className="pet-chat__thumbs">
                {message.thumbnails.map((thumb, index) => (
                  <img key={index} src={thumb} alt={t.chat.imageAttached(index + 1)} />
                ))}
              </div>
            )}
            {showThinking && message.reasoning ? (
              <ChatReasoning text={message.reasoning} />
            ) : null}
            {message.text && <ChatText text={message.text} />}
            {message.toolNote ? (
              <small className="pet-chat__tool-note">{message.toolNote}</small>
            ) : null}
            <div className="pet-chat__meta">
              <time dateTime={new Date(message.at).toISOString()}>
                {new Date(message.at).toLocaleTimeString(t.localeTag, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <button
                type="button"
                className="pet-chat__copy"
                title="复制这条消息"
                aria-label="复制这条消息"
                onClick={() => {
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(message.text);
                    } catch {
                      await invoke("set_clipboard_text", { text: message.text }).catch(() => undefined);
                    }
                  })();
                }}
              >
                <Copy size={11} strokeWidth={2} />
              </button>
            </div>
          </div>
        ))}
        {busy && (streamingReasoning || streamingReply) && (
          <div className="pet-chat__bubble pet-chat__bubble--assistant">
            {showThinking && streamingReasoning ? (
              <ChatReasoning text={streamingReasoning} streaming />
            ) : null}
            {streamingReply ? <ChatText text={streamingReply} /> : null}
          </div>
        )}
        {busy && (
          <div className="pet-chat__bubble pet-chat__bubble--assistant pet-chat__bubble--typing" role="status">
            <LoaderCircle size={15} className="pet-chat__spin" />
            <span>{t.chat.thinking}</span>
          </div>
        )}
      </div>

      {error && <p className="pet-chat__error" role="alert">{error}</p>}

      {attachments.length > 0 && (
        <div className="pet-chat__attachments">
          {attachments.map((item, index) => (
            <div className="pet-chat__attachment" key={index}>
              <img src={item.thumb} alt={t.chat.imageAttached(index + 1)} />
              <button
                type="button"
                title={t.chat.imageRemove}
                aria-label={t.chat.imageRemove}
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="pet-chat__composer">
        <label className="pet-chat__attach" title={t.chat.imageAttach} aria-label={t.chat.imageAttach}>
          <ImagePlus size={16} strokeWidth={1.9} />
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              void addImages(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        </label>
        <textarea
          value={draft}
          rows={2}
          maxLength={4000}
          placeholder={t.chat.placeholder}
          aria-label={t.chat.placeholder}
          disabled={busy}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onPaste={(event) => {
            // 直接 Ctrl+V 粘贴截图 / 复制的图片，不用先存成文件。
            const items = Array.from(event.clipboardData?.items ?? []);
            const files = items
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (files.length > 0) {
              event.preventDefault();
              void addImages(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="pet-chat__send"
          type="button"
          disabled={busy || (!draft.trim() && attachments.length === 0)}
          title={t.chat.send}
          aria-label={t.chat.send}
          onClick={() => void send()}
        >
          <Send size={16} strokeWidth={2} />
        </button>
      </div>
    </section>
  );
}
