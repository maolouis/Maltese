// 当前视频口味：只显示画像正/负标签 + 恢复默认口味（聊天说的口味变化会出现在这里）。

import { useState } from "react";
import type { TasteProfile } from "./types";

type Props = {
  taste: TasteProfile | null;
  busy: boolean;
  onReset: () => Promise<void>;
};

export function VideoTasteCard({ taste, busy, onReset }: Props) {
  const [resetting, setResetting] = useState(false);
  const positive = taste?.positiveTags ?? [];
  const negative = taste?.negativeTags ?? [];
  const empty = positive.length === 0 && negative.length === 0;

  const reset = async () => {
    if (resetting || busy) return;
    setResetting(true);
    try {
      await onReset();
    } catch {
      // 失败保留旧标签，下次轮询会刷新
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="video-taste">
      <div className="video-taste__head">
        <span className="assistant-panel__label">我的视频口味</span>
        <button
          type="button"
          className="video-automation__link"
          disabled={resetting || busy || empty}
          onClick={() => void reset()}
        >
          {resetting ? "恢复中…" : "恢复默认口味"}
        </button>
      </div>
      {empty ? (
        <p className="video-automation__muted">
          还没调过口味。在聊天里说「少刷游戏区」「多来点纪录片」就会出现在这里。
        </p>
      ) : (
        <div className="video-taste__tags">
          {negative.map((tag) => (
            <span key={`negative-${tag}`} className="video-taste__tag video-taste__tag--negative">
              少看 {tag}
            </span>
          ))}
          {positive.map((tag) => (
            <span key={`positive-${tag}`} className="video-taste__tag video-taste__tag--positive">
              多看 {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}