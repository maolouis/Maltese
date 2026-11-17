// 通道与诊断卡：展示当前通道、能力损失与最近诊断（放在「高级设置」里）。
// QA U7：英文错误码一律翻成中文人话，原始码只放在 tooltip 里。

import type { ChannelState, DiagnosticEntry } from "./types";
import { failureReasonText } from "./videoPanelLogic";

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

const DIAGNOSTIC_LEVEL_LABEL: Record<string, string> = {
  error: "错误",
  warn: "警告",
  info: "提示",
};

function timeText(value: number | null): string {
  if (!value) return "尚未成功";
  return new Date(value * 1000).toLocaleTimeString();
}

function diagnosticText(entry: DiagnosticEntry): string {
  const level = DIAGNOSTIC_LEVEL_LABEL[entry.level] ?? "提示";
  return `${level} · ${entry.message}`;
}

export function VideoChannelCard({ channel, diagnostics, onProbe }: Props) {
  return (
    <div className="video-automation__channel">
      <div className="video-automation__summary-head">
        <span className="assistant-panel__label">自检与诊断</span>
        <button type="button" className="video-automation__link" onClick={onProbe}>
          重新自检
        </button>
      </div>
      {channel ? (
        <div className="video-channel">
          <p className="video-automation__muted">
            当前：{CHANNEL_LABEL[channel.type] ?? "未知通道"}（{CAPABILITY_LABEL[channel.capability] ?? "能力未知"}） · 最近成功：{timeText(channel.lastSuccessAt)}
            {channel.failureReason ? ` · 上次失败：${failureReasonText(channel.failureReason)}` : ""}
          </p>
          {channel.degradedReason && (
            <p className="video-automation__muted">能力损失：{channel.degradedReason}</p>
          )}
        </div>
      ) : (
        <p className="video-automation__muted">还没有会话，点「重新自检」查看通道可用性。</p>
      )}
      {diagnostics.length > 0 && (
        <details className="video-automation__diagnostics">
          <summary>诊断日志（最近 {Math.min(diagnostics.length, 20)} 条）</summary>
          <ul>
            {diagnostics.slice(0, 20).map((entry, index) => (
              <li key={`${entry.at}-${index}`} title={entry.code}>
                {diagnosticText(entry)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}