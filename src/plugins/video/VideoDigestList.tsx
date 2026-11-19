// 小结与历史：待投递小结 + 历史会话（0 条也要说明原因，不能白屏）。

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, type ReactNode } from "react";
import type { AgentAccount, DigestDraft, SessionSummary, VideoSessionDetail } from "./types";
import { sessionReason } from "./videoPanelLogic";
import { loadVideoSessionDetail, openVideoLogsDir } from "./videoStateStore";

type Props = {
  pendingCount: number;
  preview: DigestDraft | null;
  latestDigest: DigestDraft | null;
  sessions: SessionSummary[];
  sessionsError: string | null;
  accounts: AgentAccount[];
  onTake: () => void;
  onLoadSessions: () => void;
};

function dateText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function clockText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** 会话时长：结束时用 endedAt-startedAt，未结束就显示「进行中 / 未记录」。 */
function sessionDuration(session: SessionSummary): string {
  if (!session.endedAt) return "时长未记录";
  return `时长 ${clockText(session.endedAt - session.startedAt)}`;
}

function verdictText(level: string | null | undefined): string {
  if (level === "strong") return "强兴趣";
  if (level === "weak") return "一般";
  if (level === "skip") return "跳过";
  return "";
}

function SessionHistoryItem({
  session,
  accountName,
}: {
  session: SessionSummary;
  accountName: string;
}) {
  const [detail, setDetail] = useState<VideoSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureDetail = async () => {
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await loadVideoSessionDetail(session.sessionId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const openLogs = () => {
    void openVideoLogsDir().catch(() => undefined);
  };

  return (
    <li className="video-history__item">
      <details
        className="video-history__entry"
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) void ensureDetail();
        }}
      >
        <summary className="video-history__summary">
          <span>{dateText(session.startedAt)}</span>
          <span className="video-automation__muted">
            {session.platform === "bilibili" ? "B站" : "抖音"}
            {` · ${accountName}`}
          </span>
          <span>条目 {session.itemCount}</span>
          <span>强兴趣 {session.strongCount}</span>
          <span>评论 {session.commentCount ?? 0}</span>
          <span className="video-automation__muted">
            {session.hasDigest ? "有小结" : "无小结"}
            {session.hasPending ? " · 待投递" : ""}
          </span>
          <span className="video-automation__muted">{sessionDuration(session)}</span>
          <span className="video-automation__muted">{sessionReason(session)}</span>
        </summary>

        <div className="video-history__detail">
          {loading && <p className="video-automation__muted">加载详情中…</p>}
          {error && (
            <p className="video-history__error" role="alert">
              详情加载失败：{error}
              <button type="button" className="video-automation__link" onClick={openLogs}>
                查看日志
              </button>
            </p>
          )}
          {detail && detail.items.length === 0 && (
            <p className="video-automation__muted">
              本次未采到视频（原因：{sessionReason(session)}）。
            </p>
          )}
          {detail && detail.items.length > 0 && (
            <ul className="video-history__items">
              {detail.items.map((item) => (
                <li key={item.itemKey} className="video-history__item-row">
                  <span className="video-history__title">《{item.title}》</span>
                  {item.author && (
                    <span className="video-automation__muted"> · {item.author}</span>
                  )}
                  {item.durationSeconds !== null && (
                    <span className="video-automation__muted">
                      {` · ${clockText(item.durationSeconds)}`}
                    </span>
                  )}
                  {verdictText(item.verdict?.level) && (
                    <span className="video-history__verdict">
                      {` · ${verdictText(item.verdict?.level)}`}
                    </span>
                  )}
                  {item.canonicalUrl && (
                    <button
                      type="button"
                      className="video-automation__link"
                      onClick={() => void openUrl(item.canonicalUrl!).catch(() => undefined)}
                    >
                      打开
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {detail && (
            <p className="video-history__digest">
              {detail.digest?.themeLine
                ? `摘要：${detail.digest.themeLine}`
                : "本轮没有生成摘要（采集条目不足或未到停止时机）。"}
            </p>
          )}
          {detail?.digest?.reflection && (
            <p className="video-history__reflection">「{detail.digest.reflection}」</p>
          )}
          {detail && detail.comments.length > 0 && (
            <div className="video-history__comments">
              <span className="assistant-panel__label">本轮评论</span>
              <ul>
                {detail.comments.map((comment, index) => (
                  <li key={`${comment.at}-${index}`}>
                    <span className="video-automation__muted">
                      {comment.dryRun
                        ? "预演"
                        : comment.verified
                          ? "已发并回读"
                          : "已发未回读"}
                      {` · ${comment.title || comment.url}`}：
                    </span>
                    {comment.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail && (
            <button type="button" className="video-automation__link" onClick={openLogs}>
              查看本轮日志
            </button>
          )}
        </div>
      </details>
    </li>
  );
}

const SUMMARY_COLLAPSE_KEY = "maltese-video-summary-collapsed";
const HISTORY_COLLAPSE_KEY = "maltese-video-history-collapsed";

function readCollapsed(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writeCollapsed(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // 存储不可用时只影响持久化，不影响本次折叠
  }
}

type SectionHeaderProps = {
  title: string;
  meta: string;
  collapsed: boolean;
  onToggle: () => void;
  extra?: ReactNode;
};

/** 区块标题行：整行可点 + 键盘可达 + 明确的「收起 ▲ / 展开 ▼」文字。 */
function SectionHeader({ title, meta, collapsed, onToggle, extra }: SectionHeaderProps) {
  return (
    <div
      className="video-section__head"
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      aria-label={`${title}，${collapsed ? "展开" : "收起"}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="video-section__title">{title}</span>
      <span className="video-section__meta">{meta}</span>
      <span className="video-section__toggle">{collapsed ? "展开 ▼" : "收起 ▲"}</span>
      {extra && (
        <span className="video-section__extra" onClick={(event) => event.stopPropagation()}>
          {extra}
        </span>
      )}
    </div>
  );
}

export function VideoDigestList({
  pendingCount,
  preview,
  latestDigest,
  sessions,
  sessionsError,
  accounts,
  onTake,
  onLoadSessions,
}: Props) {
  const effectivePreview = preview ?? latestDigest;
  const [copied, setCopied] = useState(false);
  // 最近小结默认展开（主要内容），历史默认收起；两者分别持久化。
  const [summaryCollapsed, setSummaryCollapsed] = useState(() =>
    readCollapsed(SUMMARY_COLLAPSE_KEY, false)
  );
  const [historyCollapsed, setHistoryCollapsed] = useState(() =>
    readCollapsed(HISTORY_COLLAPSE_KEY, true)
  );

  const toggleSummary = () => {
    const next = !summaryCollapsed;
    setSummaryCollapsed(next);
    writeCollapsed(SUMMARY_COLLAPSE_KEY, next);
  };
  const toggleHistory = () => {
    const next = !historyCollapsed;
    setHistoryCollapsed(next);
    writeCollapsed(HISTORY_COLLAPSE_KEY, next);
  };

  const copyDigest = async () => {
    if (!effectivePreview) return;
    const lines = [
      effectivePreview.themeLine?.trim() || "最近看的小结",
      ...effectivePreview.items.slice(0, 5).map(
        (item, index) =>
          `${index + 1}. ${item.title}${item.whyLine ? `（${item.whyLine}）` : ""}${
            item.durationSeconds !== null ? ` ${clockText(item.durationSeconds)}` : ""
          }`
      ),
    ];
    if (effectivePreview.reflection) {
      lines.push("", `小狗说：${effectivePreview.reflection}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const summaryMeta = `${effectivePreview ? `${effectivePreview.items.length} 条` : "暂无"}${
    pendingCount > 0 ? ` · 待投递 ${pendingCount}` : ""
  }`;

  return (
    <div className="video-automation__summary">
      {sessionsError && (
        <p className="video-history__error" role="alert">
          {sessionsError}
          <button
            type="button"
            className="video-automation__link"
            onClick={() => void openVideoLogsDir().catch(() => undefined)}
          >
            查看日志
          </button>
        </p>
      )}

      <section className="video-section">
        <SectionHeader
          title="最近小结"
          meta={summaryMeta}
          collapsed={summaryCollapsed}
          onToggle={toggleSummary}
          extra={
            <>
              <button type="button" className="video-automation__link" onClick={onLoadSessions}>
                刷新历史
              </button>
              <button
                type="button"
                className="video-automation__link"
                title="自检：写入一条示例评论并弹气泡，用于验证面板/气泡显示（不影响采集）"
                onClick={() => void invoke("video_comment_selftest", {})}
              >
                评论自检
              </button>
            </>
          }
        />
        {!summaryCollapsed && (
          <div className="video-section__body">
            {effectivePreview ? (
              <div className="video-digest-card__body">
                {effectivePreview.themeLine && (
                  <p className="video-digest-card__theme">{effectivePreview.themeLine}</p>
                )}
                <ol className="video-digest-card__items">
                  {effectivePreview.items.slice(0, 3).map((item, index) => (
                    <li key={item.itemKey} className="video-digest-card__row">
                      <span className="video-digest-card__index">{index + 1}</span>
                      <span className="video-digest-card__item-title" title={item.title}>
                        {item.title}
                      </span>
                      {item.whyLine && (
                        <span className="video-digest-card__why">{item.whyLine}</span>
                      )}
                      {item.durationSeconds !== null && (
                        <span className="video-digest-card__duration">
                          {clockText(item.durationSeconds)}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                {effectivePreview.reflection && (
                  <p className="video-digest-card__reflection">「{effectivePreview.reflection}」</p>
                )}
                <div className="video-digest-card__actions">
                  {pendingCount > 0 && (
                    <button type="button" className="video-automation__secondary" onClick={onTake}>
                      投递
                    </button>
                  )}
                  <button
                    type="button"
                    className="video-automation__secondary"
                    onClick={() => void copyDigest()}
                  >
                    {copied ? "已复制" : "复制小结"}
                  </button>
                </div>
                <p className="video-automation__muted">
                  生成方式：{effectivePreview.generator === "model" ? "模型" : "模板"}
                  {effectivePreview.reflectionSource
                    ? ` · 感悟：${effectivePreview.reflectionSource === "model" ? "模型" : "模板"}`
                    : ""}
                  {effectivePreview === latestDigest && !preview ? " · 最近一轮" : ""}
                </p>
              </div>
            ) : (
              <p className="video-automation__muted">
                还没有小结，跑一次视频后会出现在这里（采到条目并停止时自动生成）。
              </p>
            )}
          </div>
        )}
      </section>

      <section className="video-section">
        <SectionHeader
          title={`历史会话（${sessions.length}）`}
          meta={`${sessions.length} 轮`}
          collapsed={historyCollapsed}
          onToggle={toggleHistory}
        />
        {!historyCollapsed && (
          <div className="video-section__body">
            {sessions.length === 0 ? (
              <p className="video-automation__muted">
                暂无历史会话；小狗完成一轮观看后会自动显示在这里。
              </p>
            ) : (
              <ul className="video-history__list">
                {sessions.map((session) => (
                  <SessionHistoryItem
                    key={session.sessionId}
                    session={session}
                    accountName={
                      session.accountId
                        ? (accounts.find((account) => account.id === session.accountId)
                            ?.displayName ?? "已移除账号")
                        : "临时观看"
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
