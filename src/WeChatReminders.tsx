import { useTranslation } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Power, ScanText } from "lucide-react";
import { MessageSourceIcon } from "./MessageSourceIcon";
import "./WeChatReminders.css";

const ENABLED_KEY = "focusd-island-wechat-reminders-enabled";
const READ_CONTENT_KEY = "focusd-island-wechat-read-content";

type ReminderSnapshot = {
  revision: number;
  enabled: boolean;
  status: "disabled" | "waiting" | "listening" | "error";
  pending: boolean;
  lastAttentionAt: number | null;
  error: string | null;
  title: string | null;
  body: string | null;
  contentError: string | null;
  readContent: boolean;
};

type ReminderEvent = { snapshot: ReminderSnapshot; windowVisible: boolean };

const EMPTY_SNAPSHOT: ReminderSnapshot = {
  revision: 0, enabled: false, status: "disabled", pending: false,
  lastAttentionAt: null, error: null, title: null, body: null,
  contentError: null, readContent: true,
};

export function useWeChatReminders(canPreview: boolean) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState(isTauri);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewReceivedAt, setPreviewReceivedAt] = useState<number | null>(null);
  const canPreviewRef = useRef(canPreview);
  const revisionRef = useRef(-1);
  const attentionRef = useRef<number | null>(null);
  const actionPending = useRef(false);

  useLayoutEffect(() => {
    canPreviewRef.current = canPreview;
    if (!canPreview) setPreviewReceivedAt(null);
  }, [canPreview]);

  const acceptSnapshot = useCallback((next: ReminderSnapshot) => {
    if (next.revision < revisionRef.current) return false;
    revisionRef.current = next.revision;
    attentionRef.current = next.lastAttentionAt;
    setSnapshot(next);
    return true;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<ReminderEvent>("wechat-reminder-changed", ({ payload }) => {
        const newlyPending = payload.snapshot.pending
          && payload.snapshot.lastAttentionAt !== attentionRef.current;
        if (cancelled || !acceptSnapshot(payload.snapshot)) return;
        if (!payload.snapshot.enabled || !payload.snapshot.pending
          || payload.snapshot.status !== "listening" || !payload.windowVisible || !canPreviewRef.current) {
          setPreviewReceivedAt(null);
        } else if (newlyPending) {
          setPreviewReceivedAt(Date.now());
        }
      });
      if (cancelled) { unlisten(); return; }
      const readContent = window.localStorage.getItem(READ_CONTENT_KEY) !== "false";
      const next = await invoke<ReminderSnapshot>("set_wechat_reminders_enabled", {
        enabled: window.localStorage.getItem(ENABLED_KEY) !== "false",
      });
      if (!cancelled) acceptSnapshot(next);
      const nextContent = await invoke<ReminderSnapshot>("set_wechat_read_content", {
        enabled: readContent,
      });
      if (!cancelled) acceptSnapshot(nextContent);
    })().catch((error: unknown) => {
      if (!cancelled) setActionError(String(error));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [acceptSnapshot]);

  useEffect(() => {
    if (previewReceivedAt === null) return;
    const timer = window.setTimeout(() => setPreviewReceivedAt(null),
      Math.max(0, previewReceivedAt + 5_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [previewReceivedAt]);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    if (!isTauri()) {
      setActionError(t.wechat.desktopOnly);
      return false;
    }
    actionPending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(String(error));
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, [t]);

  const setEnabled = useCallback((enabled: boolean) => run(async () => {
    acceptSnapshot(await invoke<ReminderSnapshot>("set_wechat_reminders_enabled", { enabled }));
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (!enabled) setPreviewReceivedAt(null);
  }), [acceptSnapshot, run]);

  const setReadContent = useCallback((enabled: boolean) => run(async () => {
    acceptSnapshot(await invoke<ReminderSnapshot>("set_wechat_read_content", { enabled }));
    window.localStorage.setItem(READ_CONTENT_KEY, String(enabled));
  }), [acceptSnapshot, run]);

  const openWeChat = useCallback(() => run(async () => {
    await invoke("open_wechat");
    setPreviewReceivedAt(null);
  }), [run]);

  return {
    snapshot, busy, actionError, setEnabled, setReadContent, openWeChat,
    previewReceivedAt: canPreview && snapshot.pending ? previewReceivedAt : null,
  };
}

export type WeChatRemindersController = ReturnType<typeof useWeChatReminders>;

export function WeChatReminderControls({ controller, compact = false }: { controller: WeChatRemindersController; compact?: boolean }) {
  const { snapshot, busy, actionError, setEnabled, setReadContent } = controller;
  const t = useTranslation();
  return <div className={`qq-panel__controls${compact ? " qq-panel__controls--compact" : ""}`}>
    {compact ? <>
      <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label={t.wechat.receive} title={snapshot.enabled ? t.wechat.pause : t.wechat.receive} disabled={busy} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button>
      <button className="icon-button" type="button" role="switch" aria-checked={snapshot.readContent} aria-label={t.wechat.readContent} title={t.wechat.readContentHint} disabled={busy} onClick={() => void setReadContent(!snapshot.readContent)}><ScanText size={15} strokeWidth={1.8} /></button>
    </> : <>
      <label className="qq-panel__toggle" title={snapshot.enabled ? t.wechat.pause : t.wechat.receive}>
        <span>{t.messages.wechatReminders}</span>
        <span className="message-status" data-state={snapshot.status} role="status" aria-label={t.wechat.status[snapshot.status]} title={t.wechat.status[snapshot.status]} />
        <input type="checkbox" role="switch" aria-label={t.wechat.receive} checked={snapshot.enabled} disabled={busy}
          onChange={(event) => void setEnabled(event.currentTarget.checked)} />
      </label>
      <label className="qq-panel__toggle" title={t.wechat.readContentHint}>
        <span>{t.wechat.readContent}</span>
        <input type="checkbox" role="switch" aria-label={t.wechat.readContent} checked={snapshot.readContent} disabled={busy}
          onChange={(event) => void setReadContent(event.currentTarget.checked)} />
      </label>
    </>}
    {!compact && (actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
  </div>;
}

export function WeChatReminderPanel({ controller, navigation }: { controller: WeChatRemindersController; navigation: ReactNode }) {
  const { snapshot, busy, actionError, openWeChat } = controller;
  const t = useTranslation();
  const pending = snapshot.enabled && snapshot.status === "listening" && snapshot.pending;
  const hasContent = pending && Boolean(snapshot.title?.trim());
  const label = snapshot.status === "listening" ? pending ? t.messages.newReminder : t.wechat.noReminders : t.wechat.status[snapshot.status];
  return (
    <section className="qq-panel" aria-label={t.messages.wechatReminders}>
      <header className="qq-panel__header">
        {navigation}
        <div className="qq-panel__toolbar"><WeChatReminderControls controller={controller} compact /><button className="icon-button" type="button" title={t.wechat.open} aria-label={t.wechat.open} disabled={busy} onClick={() => void openWeChat()}><ArrowUpRight size={16} strokeWidth={1.8} /></button></div>
      </header>
      {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
      {hasContent ? <article className="wechat-message-card" role="status">
        <div className="wechat-message-card__avatar"><MessageSourceIcon source="wechat" size={24} /></div>
        <div className="wechat-message-card__copy">
          <strong>{snapshot.title}</strong>
          <p>{snapshot.body?.trim() || t.messages.newMessage}</p>
          {snapshot.contentError && <small>{snapshot.contentError}</small>}
        </div>
      </article> : <div className={`qq-panel__empty${pending ? " wechat-reminder-state--pending" : ""}`} role="status">
        <span className="message-empty-icon"><MessageSourceIcon source="wechat" size={28} /></span>
        <span>{pending ? snapshot.contentError ?? t.wechat.contentUnavailable : label}</span>
      </div>}
    </section>
  );
}
