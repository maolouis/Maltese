import type { Dispatch, RefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Copy,
  Hand,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Send,
  Settings2,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { ChatReasoning } from "./ChatReasoning";
import { ChatText } from "./ChatText";
import { LocalChatSettings } from "./LocalChatSettings";
import { PetSkillsSettings } from "./PetSkillsSettings";
import { PetStateBar } from "./PetStateBar";
import type { Translations } from "./i18n";
import type { LocalChatConfig } from "./localChat";
import { stickerDisplayWidth, stickerOfMessage, type StickerId } from "./chatSticker";
import type { ChatMessage } from "./petChatTypes";

type Attachment = { send: string; thumb: string };

type PetChatViewProps = {
  t: Translations;
  avatarSrc: string;
  avatarName: string;
  busy: boolean;
  chatConfig: LocalChatConfig;
  agentEnabled: boolean;
  setAgentEnabled: Dispatch<SetStateAction<boolean>>;
  showSkills: boolean;
  setShowSkills: Dispatch<SetStateAction<boolean>>;
  showModelSettings: boolean;
  setShowModelSettings: Dispatch<SetStateAction<boolean>>;
  messages: ChatMessage[];
  clear: () => void;
  thinkingOn: boolean;
  waitSeconds: number;
  showThinking: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  stickerUrl: (id: StickerId | null | undefined) => string | null;
  stickerWidth: number;
  setStickerWidth: Dispatch<SetStateAction<number>>;
  setStickerPreview: Dispatch<SetStateAction<string | null>>;
  streamingReasoning: string;
  streamingReply: string;
  modelLoading: boolean;
  sendQueue: string[];
  queueing: boolean;
  thinkingLabel: string;
  stopGeneration: () => void;
  stateNotices: string[];
  error: string | null;
  failedPrompt: string | null;
  retryFailed: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  addImages: (files: File[]) => Promise<void>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  send: (overrideText?: string) => Promise<void>;
  stickerPreview: string | null;
};

export function PetChatView({
  t,
  avatarSrc,
  avatarName,
  busy,
  chatConfig,
  agentEnabled,
  setAgentEnabled,
  showSkills,
  setShowSkills,
  showModelSettings,
  setShowModelSettings,
  messages,
  clear,
  thinkingOn,
  waitSeconds,
  showThinking,
  listRef,
  stickerUrl,
  stickerWidth,
  setStickerWidth,
  setStickerPreview,
  streamingReasoning,
  streamingReply,
  modelLoading,
  sendQueue,
  queueing,
  thinkingLabel,
  stopGeneration,
  stateNotices,
  error,
  failedPrompt,
  retryFailed,
  attachments,
  setAttachments,
  addImages,
  draft,
  setDraft,
  textareaRef,
  send,
  stickerPreview,
}: PetChatViewProps) {
  return (

    <section className="pet-chat" aria-label={t.chat.title}>
      <header className="pet-chat__header">
        <div className="pet-chat__heading">
          <img
            className="pet-chat__avatar pet-chat__avatar--header"
            src={avatarSrc}
            alt={avatarName}
            title={avatarName}
            draggable={false}
          />
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

      {/* 小狗状态条：一行紧凑显示体力/情绪/亲密/专注；无数据时整行不渲染。 */}
      <PetStateBar busy={busy} waitSeconds={waitSeconds} thinkingOn={thinkingOn} />

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
            <img
              className="pet-chat__avatar pet-chat__avatar--empty"
              src={avatarSrc}
              alt={avatarName}
              draggable={false}
            />
            <p>{t.chat.empty}</p>
            <small>{t.chat.emptyHint}</small>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`pet-chat__row pet-chat__row--${message.role}`}
          >
            {message.role === "assistant" && (
              <img
                className="pet-chat__avatar"
                src={avatarSrc}
                alt={avatarName}
                title={avatarName}
                draggable={false}
              />
            )}
            <div
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
              {message.kind === "sticker" && !message.text ? null : null}
              {(() => {
                // 独立表情包消息或旧记录的内联字段都走同一套渲染。
                const url = stickerUrl(stickerOfMessage(message));
                return url ? (
                  <button
                    type="button"
                    className="pet-chat__sticker"
                    title="点一下放大"
                    aria-label="表情包，点击放大"
                    onClick={() => setStickerPreview(url)}
                  >
                    <img
                      src={url}
                      alt=""
                      loading="lazy"
                      style={{ width: `${stickerWidth}px`, height: `${stickerWidth}px` }}
                      onLoad={(event) => {
                        const natural = event.currentTarget.naturalWidth;
                        setStickerWidth(stickerDisplayWidth(natural, 360));
                      }}
                      onError={(event) => {
                        const box = event.currentTarget.closest(".pet-chat__sticker");
                        if (box instanceof HTMLElement) box.style.display = "none";
                      }}
                    />
                  </button>
                ) : null;
              })()}
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
          </div>
        ))}
        {busy && (streamingReasoning || streamingReply) && (
          <div className="pet-chat__row pet-chat__row--assistant">
            <img
              className="pet-chat__avatar"
              src={avatarSrc}
              alt={avatarName}
              title={avatarName}
              draggable={false}
            />
            <div className="pet-chat__bubble pet-chat__bubble--assistant">
              {showThinking && streamingReasoning ? (
                <ChatReasoning text={streamingReasoning} streaming />
              ) : null}
              {streamingReply ? <ChatText text={streamingReply} /> : null}
            </div>
          </div>
        )}
        {busy && (
          <div className="pet-chat__row pet-chat__row--assistant">
            <img
              className="pet-chat__avatar"
              src={avatarSrc}
              alt={avatarName}
              title={avatarName}
              draggable={false}
            />
            <div className="pet-chat__bubble pet-chat__bubble--assistant pet-chat__bubble--typing" role="status">
              <LoaderCircle size={15} className="pet-chat__spin" />
              <span>
                {modelLoading
                  ? `正在加载本地模型…（已 ${waitSeconds}s，首次约 1–4 分钟）`
                  : sendQueue.length > 0
                    ? `已排队 ${sendQueue.length} 条，等前面回答完就发…`
                    : queueing
                    ? `前面还有请求，排队中…（已 ${waitSeconds}s）`
                    : waitSeconds >= 3
                    ? `小狗在加载模型或思考，稍等（${waitSeconds}s）`
                    : thinkingOn
                      ? "小狗正在思考…"
                      : t.chat.thinking}
                {!modelLoading && waitSeconds >= 1 && waitSeconds < 3 ? `（${waitSeconds}s）` : ""}
              </span>
              <button
                type="button"
                className="pet-chat__stop"
                title="停止生成"
                aria-label="停止生成"
                onClick={stopGeneration}
              >
                <Square size={11} strokeWidth={2.4} />
                停止
              </button>
            </div>
          </div>
        )}
        {busy && thinkingOn && waitSeconds >= 3 && !streamingReasoning && (
          <p className="pet-chat__hint">
            思考深度：{thinkingLabel}，模型在推理；深度越大首字越慢，可在设置里调到「关」或「浅」加快回复。
          </p>
        )}
        {/* 状态阈值跨越的灰色小字：不写进消息、不发给模型 */}
        {stateNotices.map((notice, index) => (
          <p key={`${notice}-${index}`} className="pet-chat__state-notice">
            {notice}
          </p>
        ))}
      </div>

      {error && (
        <p className="pet-chat__error" role="alert">
          <span>{error}</span>
          {failedPrompt && !busy && (
            <button type="button" className="pet-chat__retry" onClick={retryFailed}>
              <RotateCcw size={12} strokeWidth={2.2} />
              重试
            </button>
          )}
        </p>
      )}

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
          ref={textareaRef}
          value={draft}
          rows={2}
          maxLength={4000}
          placeholder={t.chat.placeholder}
          aria-label={t.chat.placeholder}
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
            // 中文输入法合成候选词期间按 Enter 是上屏，绝不能提前触发发送。
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="pet-chat__send"
          type="button"
          disabled={!draft.trim() && attachments.length === 0}
          title={t.chat.send}
          aria-label={t.chat.send}
          onClick={() => void send()}
        >
          <Send size={16} strokeWidth={2} />
        </button>
      </div>
      {stickerPreview && (
        <button
          type="button"
          className="pet-chat__sticker-preview"
          aria-label="关闭表情包预览"
          onClick={() => setStickerPreview(null)}
        >
          <img src={stickerPreview} alt="" />
        </button>
      )}    </section>
  );
}
