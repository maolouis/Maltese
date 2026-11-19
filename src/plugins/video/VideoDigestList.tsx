// 小结与历史：待投递小结 + 历史会话（0 条也要说明原因，不能白屏）。

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
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
  return (
    <div className="video-automation__summary">
      <div className="video-automation__summary-head">
        <span className="assistant-panel__label">最近小结</span>
        <span className="video-automation__muted">待投递 {pendingCount}</span>
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
      </div>

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

      {pendingCount > 0 && (
        <button type="button" className="video-automation__secondary" onClick={onTake}>
          查看待投递小结
        </button>
      )}

      {effectivePreview ? (
        <div className="video-digest">
          {effectivePreview.themeLine && <p>{effectivePreview.themeLine}</p>}
          <ul>
            {effectivePreview.items.slice(0, 3).map((item) => (
              <li key={item.itemKey}>
                《{item.title}》：{item.whyLine}
              </li>
            ))}
          </ul>
          <p className="video-automation__muted">
            生成方式：{effectivePreview.generator === "model" ? "模型" : "模板"}
            {effectivePreview === latestDigest && !preview ? " · 最近一轮" : ""}
          </p>
        </div>
      ) : (
        <p className="video-automation__muted">
          还没有小结，跑一次视频后会出现在这里（采到条目并停止时自动生成）。
        </p>
      )}

      <div className="video-history">
        <div className="video-history__head">
          <span className="assistant-panel__label">历史会话（{sessions.length}）</span>
        </div>
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
                    ? (accounts.find((account) => account.id === session.accountId)?.displayName ??
                      "已移除账号")
                    : "临时观看"
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}