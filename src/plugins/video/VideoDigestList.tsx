// 小结与历史：待投递小结 + 历史会话（QA §1 #7：只保留必要内容，清空数据移到「高级设置」）。

import type { DigestDraft, SessionSummary } from "./types";
import { sessionReason } from "./videoPanelLogic";

type Props = {
  pendingCount: number;
  preview: DigestDraft | null;
  sessions: SessionSummary[];
  onTake: () => void;
  onLoadSessions: () => void;
};

function dateText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export function VideoDigestList({
  pendingCount,
  preview,
  sessions,
  onTake,
  onLoadSessions,
}: Props) {
  return (
    <div className="video-automation__summary">
      <div className="video-automation__summary-head">
        <span className="assistant-panel__label">最近小结</span>
        <span className="video-automation__muted">待投递 {pendingCount}</span>
        <button type="button" className="video-automation__link" onClick={onLoadSessions}>
          刷新历史
        </button>
      </div>

      {pendingCount > 0 && (
        <button type="button" className="video-automation__secondary" onClick={onTake}>
          查看待投递小结
        </button>
      )}

      {preview ? (
        <div className="video-digest">
          {preview.themeLine && <p>{preview.themeLine}</p>}
          <ul>
            {preview.items.slice(0, 3).map((item) => (
              <li key={item.itemKey}>
                《{item.title}》：{item.whyLine}
              </li>
            ))}
          </ul>
          <p className="video-automation__muted">
            生成方式：{preview.generator === "model" ? "模型" : "模板"}
          </p>
        </div>
      ) : (
        <p className="video-automation__muted">
          还没有攒到小结；小狗看一会儿再停下，就会整理最近看到的内容。
        </p>
      )}

      {sessions.length > 0 && (
        <details className="video-automation__history">
          <summary>历史会话（{sessions.length}）</summary>
          <ul className="video-digest">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                {dateText(session.startedAt)} · {session.platform === "bilibili" ? "B站" : "抖音"}
                · {sessionReason(session)}
                · 条目 {session.itemCount}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}