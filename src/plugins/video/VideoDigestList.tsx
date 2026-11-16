// 小结与历史：待投递小结、历史会话与清空入口。

import type { DigestDraft, SessionSummary } from "./types";

type Props = {
  pendingCount: number;
  preview: DigestDraft | null;
  sessions: SessionSummary[];
  onTake: () => void;
  onLoadSessions: () => void;
  onClear: (includeBrowserProfile: boolean) => void;
};

const STOP_LABEL: Record<string, string> = {
  userStop: "手动停止",
  durationLimit: "到达时长上限",
  itemLimit: "到达条目上限",
  browserClosed: "浏览器已关闭",
  sleepInterrupt: "休眠中断",
  riskControl: "平台风控",
  leftRecommendFeed: "离开推荐流",
  crash: "异常崩溃",
  takeoverTimeout: "用户接管超时",
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
  onClear,
}: Props) {
  return (
    <div className="video-automation__section">
      <div className="video-automation__comment-head">
        <span className="assistant-panel__label">小结与历史</span>
        <span className="video-automation__steps">待投递 {pendingCount}</span>
      </div>

      {pendingCount > 0 && (
        <button type="button" onClick={onTake}>查看待投递小结</button>
      )}
      {pendingCount === 0 && !preview && (
        <p className="video-automation__hint">小狗还没有攒下新的小结。</p>
      )}

      {preview && (
        <div className="video-digest">
          {preview.themeLine && <p>{preview.themeLine}</p>}
          <ul>
            {preview.items.map((item) => (
              <li key={item.itemKey}>
                《{item.title}》：{item.whyLine}
              </li>
            ))}
          </ul>
          <p className="video-automation__hint">
            生成方式：{preview.generator === "model" ? "模型" : "模板"}
          </p>
        </div>
      )}

      <div className="video-automation__comment-head">
        <span className="assistant-panel__label">历史会话</span>
        <button type="button" onClick={onLoadSessions}>刷新</button>
      </div>
      {sessions.length === 0 ? (
        <p className="video-automation__hint">还没有历史会话。</p>
      ) : (
        <ul className="video-digest">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              {dateText(session.startedAt)} · {session.platform === "bilibili" ? "B站" : "抖音"}
              · {STOP_LABEL[session.stopReason ?? ""] ?? "已结束"}
              · 条目 {session.itemCount} / 强兴趣 {session.strongCount}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => onClear(false)}
        className="video-automation__danger"
      >
        清空小狗的观看数据（保留登录）
      </button>
      <p className="video-automation__hint">
        清空后历史、画像与待投递都会删除；登录 profile 默认保留，勾选清空会需要重新登录。
      </p>
    </div>
  );
}