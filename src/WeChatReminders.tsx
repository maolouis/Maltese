import { useTranslation } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Power } from "lucide-react";
import { MessageSourceIcon } from "./MessageSourceIcon";
import "./WeChatReminders.css";

const ENABLED_KEY = "focusd-island-wechat-reminders-enabled";

/**
 * 微信提醒状态：**只有「有新消息」这个信号**。
 *
 * 2026-11-17 按 `docs/research-wechat-qq-message-source.md` 的结论删掉了 OCR
 * 截屏识别链路：不再读取发送人/正文，也不再出现 `title/body/contentError`。
 * 界面上只显示「微信有新消息 + 时间」。
 */
type ReminderSnapshot = {
  revision: number;
  enabled: boolean;
  status: "disabled" | "waiting" | "listening" | "error";
  pending: boolean;
  lastAttentionAt: number | null;
  error: string | null;
};

type ReminderEvent = { snapshot: ReminderSnapshot; windowVisible: boolean };

const EMPTY_SNAPSHOT: ReminderSnapshot = {
  revision: 0,
  enabled: false,
  status: "disabled",
  pending: false,
  lastAttentionAt: null,
  error: null,
};

function formatReminderTime(value: number | null, localeTag: string): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * `canNotify`：只有收起态、没缩边时才把「新提醒」冒到云朵气泡上；
 * 不涉及任何消息正文。
 */
export function useWeChatReminders(canNotify: boolean) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState(isTauri);
  const [actionError, setActionError] = useState<string | null>(null);
  const [noticedAt, setNoticedAt] = useState<number | null>(null);
  const canNotifyRef = useRef(canNotify);
  const revisionRef = useRef(-1);
  const attentionRef = useRef<number | null>(null);
  const actionPending = useRef(false);

  useLayoutEffect(() => {
    canNotifyRef.current = canNotify;
    if (!canNotify) setNoticedAt(null);
  }, [canNotify]);

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
          || payload.snapshot.status !== "listening" || !payload.windowVisible || !canNotifyRef.current) {
          setNoticedAt(null);
        } else if (newlyPending) {
          setNoticedAt(Date.now());
        }
      });
      if (cancelled) { unlisten(); return; }
      const next = await invoke<ReminderSnapshot>("set_wechat_reminders_enabled", {
        enabled: window.localStorage.getItem(ENABLED_KEY) !== "false",
      });
      if (!cancelled) acceptSnapshot(next);
    })().catch((error: unknown) => {
      if (!cancelled) setActionError(String(error));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [acceptSnapshot]);

  useEffect(() => {
    if (noticedAt === null) return;
    const timer = window.setTimeout(() => setNoticedAt(null),
      Math.max(0, noticedAt + 5_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [noticedAt]);

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
    if (!enabled) setNoticedAt(null);
  }), [acceptSnapshot, run]);

  const openWeChat = useCallback(() => run(async () => {
    await invoke("open_wechat");
    setNoticedAt(null);
  }), [run]);

  return {
    snapshot, busy, actionError, setEnabled, openWeChat,
    noticedAt: canNotify && snapshot.pending ? noticedAt : null,
    /** 兼容旧字段名：只是「新提醒时间」，不含任何正文。 */
    previewReceivedAt: canNotify && snapshot.pending ? noticedAt : null,
  };
}

export type WeChatRemindersController = ReturnType<typeof useWeChatReminders>;

export function WeChatReminderControls({ controller, compact = false }: { controller: WeChatRemindersController; compact?: boolean }) {
  const { snapshot, busy, actionError, setEnabled } = controller;
  const t = useTranslation();
  return <div className={`qq-panel__controls${compact ? " qq-panel__controls--compact" : ""}`}>
    {compact ? <>
      <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label={t.wechat.receive} title={snapshot.enabled ? t.wechat.pause : t.wechat.receive} disabled={busy} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button>
    </> : <>
      <label className="qq-panel__toggle" title={snapshot.enabled ? t.wechat.pause : t.wechat.receive}>
        <span>{t.messages.wechatReminders}</span>
        <span className="message-status" data-state={snapshot.status} role="status" aria-label={t.wechat.status[snapshot.status]} title={t.wechat.status[snapshot.status]} />
        <input type="checkbox" role="switch" aria-label={t.wechat.receive} checked={snapshot.enabled} disabled={busy}
          onChange={(event) => void setEnabled(event.currentTarget.checked)} />
      </label>
    </>}
    {!compact && (actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
  </div>;
}

export function WeChatReminderPanel({ controller, navigation }: { controller: WeChatRemindersController; navigation: ReactNode }) {
  const { snapshot, busy, actionError, openWeChat } = controller;
  const t = useTranslation();
  const pending = snapshot.enabled && snapshot.status === "listening" && snapshot.pending;
  const label = snapshot.status === "listening" ? pending ? t.messages.newReminder : t.wechat.noReminders : t.wechat.status[snapshot.status];
  const time = formatReminderTime(snapshot.lastAttentionAt, t.localeTag);
  return (
    <section className="qq-panel" aria-label={t.messages.wechatReminders}>
      <header className="qq-panel__header">
        {navigation}
        <div className="qq-panel__toolbar"><WeChatReminderControls controller={controller} compact /><button className="icon-button" type="button" title={t.wechat.open} aria-label={t.wechat.open} disabled={busy} onClick={() => void openWeChat()}><ArrowUpRight size={16} strokeWidth={1.8} /></button></div>
      </header>
      {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
      {pending ? <article className="wechat-message-card" role="status">
        <div className="wechat-message-card__avatar"><MessageSourceIcon source="wechat" size={24} /></div>
        <div className="wechat-message-card__copy">
          <strong>{t.messages.wechat}</strong>
          <p>{t.messages.newReminder}{time ? ` · ${time}` : ""}</p>
          <small>{t.wechat.privacyNote}</small>
        </div>
      </article> : <div className="qq-panel__empty" role="status">
        <span className="message-empty-icon"><MessageSourceIcon source="wechat" size={28} /></span>
        <span>{label}</span>
      </div>}
    </section>
  );
}