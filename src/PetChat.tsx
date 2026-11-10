import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ImagePlus, LoaderCircle, Send, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { useTranslation } from "./i18n";
import { LocalChatSettings } from "./LocalChatSettings";
import { usePetCharacter } from "./petCharacters";
import {
  loadLocalChatConfig,
  LOCAL_CHAT_UPDATED_EVENT,
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
};

type LocalChatStreamEvent = {
  requestId: string;
  kind: "delta" | "done" | "error";
  text: string;
};

const MESSAGES_KEY = "focusd-island-pet-chat-messages";
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
  const [imageData, setImageData] = useState<string | null>(null);
  const [streamingReply, setStreamingReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatConfig, setChatConfig] = useState<LocalChatConfig>(loadLocalChatConfig);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    }
  }, [messages, busy]);

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

  const attachImage = useCallback((file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setImageData(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !imageData) || busy) return;
    if (!isTauri()) {
      setError(t.chat.desktopOnly);
      return;
    }
    if (chatConfig.backend === "local" && !chatConfig.model.trim()) {
      setError(t.chat.modelNotConfigured);
      setShowModelSettings(true);
      return;
    }
    if (chatConfig.backend === "dsh" && imageData) {
      setError(t.chat.multimodalLocalOnly);
      return;
    }
    const currentImage = imageData;
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      text,
      at: Date.now(),
      imageCount: currentImage ? 1 : undefined,
    };
    const next = [...messages, userMessage];
    persist(next);
    setDraft("");
    setImageData(null);
    setError(null);
    setBusy(true);
    setStreamingReply("");
    try {
      let replyText: string;
      if (chatConfig.backend === "local") {
        const requestId = createId();
        const unlisten = chatConfig.stream
          ? await listen<LocalChatStreamEvent>("local-chat-stream", (event) => {
            if (event.payload.requestId !== requestId) return;
            if (event.payload.kind === "delta") {
              setStreamingReply((current) => current + event.payload.text);
            } else if (event.payload.kind === "error") {
              setError(event.payload.text);
            }
          })
          : null;
        try {
          const localPayload = {
            requestId,
            baseUrl: chatConfig.baseUrl,
            model: chatConfig.model,
            apiKey: chatConfig.apiKey.trim() || null,
            message: text,
            history: messages.slice(-16).map((message) => ({
              role: message.role,
              content: message.text,
            })),
            character,
            images: currentImage ? [currentImage] : null,
            settings: {
              maxTokens: chatConfig.maxTokens,
              temperature: chatConfig.temperature,
              topP: chatConfig.topP,
              enableThinking: chatConfig.enableThinking,
            },
          };
          replyText = await invoke<string>(
            chatConfig.stream ? "local_chat_stream" : "local_chat",
            chatConfig.stream
              ? localPayload
              : {
                baseUrl: localPayload.baseUrl,
                model: localPayload.model,
                apiKey: localPayload.apiKey,
                message: localPayload.message,
                history: localPayload.history,
                character: localPayload.character,
              },
          );
        } finally {
          unlisten?.();
        }
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
      persist([
        ...next,
        {
          id: createId(),
          role: "assistant",
          text: replyText,
          at: Date.now(),
        },
      ]);
      setStreamingReply("");
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
    chatConfig.enableThinking,
    chatConfig.maxTokens,
    chatConfig.model,
    chatConfig.stream,
    chatConfig.temperature,
    chatConfig.topP,
    character,
    draft,
    imageData,
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
    setImageData(null);
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
            <p>{message.text}</p>
            {message.imageCount ? (
              <small className="pet-chat__image-note">{t.chat.imageAttached(message.imageCount)}</small>
            ) : null}
            <time dateTime={new Date(message.at).toISOString()}>
              {new Date(message.at).toLocaleTimeString(t.localeTag, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))}
        {busy && streamingReply && (
          <div className="pet-chat__bubble pet-chat__bubble--assistant">
            <p>{streamingReply}</p>
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

      {imageData && (
        <div className="pet-chat__attachment">
          <img src={imageData} alt={t.chat.imageAttached(1)} />
          <button
            type="button"
            title={t.chat.imageRemove}
            aria-label={t.chat.imageRemove}
            onClick={() => setImageData(null)}
          >
            <X size={13} />
          </button>
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
              attachImage(event.currentTarget.files?.[0]);
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
          disabled={busy || (!draft.trim() && !imageData)}
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
