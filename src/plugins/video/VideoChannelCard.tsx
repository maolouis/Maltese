// 通道与诊断卡：展示当前通道、能力损失与最近诊断。

import type { ChannelState, DiagnosticEntry } from "./types";

type Props = {
  channel: ChannelState | null;
  diagnostics: DiagnosticEntry[];
  onProbe: () => void;
};

const CAPABILITY_LABEL: Record<string, string> = {
  full: "完整能力",
  enhanced: "增强能力",
  basic: "基础能力",
};

const CHANNEL_LABEL: Record<string, string> = {
  cdp: "调试通道",
  extension: "浏览器扩展",
  uia: "可访问性树",
  smtc: "系统媒体会话",
  windowTitle: "窗口标题",
};

function timeText(value: number | null): string {
  if (!value) return "尚未成功";
  return new Date(value * 1000).toLocaleTimeString();
}

export function VideoChannelCard({ channel, diagnostics, onProbe }: Props) {
  return (
    <div className="video-automation__section">
      <div className="video-automation__comment-head">
        <span className="assistant-panel__label">通道与诊断</span>
        <button type="button" onClick={onProbe}>重新自检</button>
      </div>
      {channel ? (
        <div className="video-channel">
          <p>
            当前：{CHANNEL_LABEL[channel.type] ?? channel.type}
            （{CAPABILITY_LABEL[channel.capability] ?? channel.capability}）
          </p>
          <p className="video-automation__hint">
            最近成功：{timeText(channel.lastSuccessAt)}
            {channel.failureReason ? ` · 失败：${channel.failureReason}` : ""}
          </p>
          {channel.degradedReason && (
            <p className="video-automation__hint video-automation__hint--warn">
              能力损失：{channel.degradedReason}
            </p>
          )}
        </div>
      ) : (
        <p className="video-automation__hint">还没有会话，点「重新自检」查看通道可用性。</p>
      )}
      {diagnostics.length > 0 && (
        <details className="video-automation__diagnostics">
          <summary>诊断日志（最近 {Math.min(diagnostics.length, 20)} 条）</summary>
          <ul>
            {diagnostics.slice(0, 20).map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                {entry.code} · {entry.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}