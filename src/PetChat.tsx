import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LoaderCircle, Send, Settings2, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "./i18n";
import { LocalChatSettings } from "./LocalChatSettings";
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
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    window.localStorage.getItem(SESSION_KEY),
  );
  const [draft, setDraft] = useState("");
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

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!isTauri()) {
      setError(t.chat.desktopOnly);
      return;
    }
    if (chatConfig.backend === "local" && !chatConfig.model.trim()) {
      setError(t.chat.modelNotConfigured);
      setShowModelSettings(true);
      return;
    }
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      text,
      at: Date.now(),
    };
    const next = [...messages, userMessage];
    persist(next);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      let replyText: string;
      if (chatConfig.backend === "local") {
        replyText = await invoke<string>("local_chat", {
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message: text,
          history: messages.slice(-16).map((message) => ({
            role: message.role,
            content: message.text,
          })),
        });
      } else {
        const reply = await invoke<DshChatReply>("dsh_chat", {
          message: text,
          sessionId,
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
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    chatConfig.apiKey,
    chatConfig.backend,
    chatConfig.baseUrl,
    chatConfig.model,
    draft,
    messages,
    persist,
    sessionId,
    t.chat.desktopOnly,
    t.chat.modelNotConfigured,
  ]);

  const clear = useCallback(() => {
    persist([]);
    setSessionId(null);
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
            <time dateTime={new Date(message.at).toISOString()}>
              {new Date(message.at).toLocaleTimeString(t.localeTag, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))}
        {busy && (
          <div className="pet-chat__bubble pet-chat__bubble--assistant pet-chat__bubble--typing" role="status">
            <LoaderCircle size={15} className="pet-chat__spin" />
            <span>{t.chat.thinking}</span>
          </div>
        )}
      </div>

      {error && <p className="pet-chat__error" role="alert">{error}</p>}

      <div className="pet-chat__composer">
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
          disabled={busy || !draft.trim()}
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