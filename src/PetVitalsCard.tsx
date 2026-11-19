// 小狗的状态卡片（体力 / 情绪 / 亲密 / 专注）。
// 岛内设置页与独立设置窗口共用；纯展示 + 两个动作按钮，数值逻辑都在 petVitals.ts。

import { useState } from "react";
import { useTranslation } from "./i18n";
import { loadVitalsLog, vitalsLevel, type PetVitalsSnapshot } from "./petVitals";
import "./PetVitalsCard.css";

export type PetVitalsCardProps = {
  /** 总开关：关掉后退回原有待机轮播。 */
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  vitals: PetVitalsSnapshot;
  /** 是否正在待办中（专注会随时间上涨）。 */
  focusActive: boolean;
  /** 模型正在思考（只读标记，不写进指标）。 */
  thinking?: boolean;
  /** 摸摸头 / 喂零食：复用 App 的 triggerPetAction。 */
  onPet: () => void;
  onFeed: () => void;
  onRefresh?: () => void;
};

const BARS = [
  { key: "energy", floor: 15 },
  { key: "mood", floor: 20 },
  { key: "bond", floor: 30 },
  { key: "focus", floor: 0 },
] as const;

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function relativeAgo(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default function PetVitalsCard({
  enabled,
  onToggleEnabled,
  vitals,
  focusActive,
  thinking,
  onPet,
  onFeed,
  onRefresh,
}: PetVitalsCardProps) {
  const t = useTranslation();
  const copy = t.petVitals;
  const [expanded, setExpanded] = useState(false);
  const level = vitalsLevel(vitals);
  const recentVideo = (() => {
    try {
      const log = loadVitalsLog(window.localStorage);
      const entry = log.find((item) => item.kind === "video");
      if (entry && Date.now() - entry.at < 24 * 3_600_000) return entry;
    } catch {
      // 读不到日志不影响卡片。
    }
    return null;
  })();

  return (
    <div className="pet-vitals" data-enabled={enabled ? "on" : "off"}>
      <div className="pet-vitals__head">
        <span className="pet-vitals__title">{copy.title}</span>
        <label className="pet-vitals__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggleEnabled(event.target.checked)}
          />
          <span>{copy.toggle}</span>
        </label>
      </div>

      <p className="pet-vitals__hint">{copy.hint.replace(/\*\*/g, "")}</p>

      <p className="pet-vitals__level" data-level={level}>
        {copy.levels[level]}
        {focusActive ? ` · ${copy.focusing}` : ""}
      </p>
      {vitals.sleepMode && (
        <p className="pet-vitals__sleep" data-sleep-mode={vitals.sleepMode}>
          {vitals.sleepMode === "manual" ? copy.sleepingManual : copy.sleepingIdle}
        </p>
      )}
      {thinking && <p className="pet-vitals__thinking">{copy.thinking}</p>}

      <div className="pet-vitals__bars">
        {BARS.map(({ key, floor }) => {
          const value = Math.round(vitals[key]);
          const width = Math.max(0, Math.min(100, (value - floor) / (100 - floor) * 100));
          return (
            <div className="pet-vitals__bar" key={key} data-metric={key}>
              <span className="pet-vitals__bar-name">{copy[key]}</span>
              <span className="pet-vitals__bar-track" aria-hidden="true">
                <span className="pet-vitals__bar-fill" style={{ width: `${width}%` }} />
              </span>
              <span className="pet-vitals__bar-value">{value}</span>
              <span className="sr-only">{`${copy[key]} ${value}/100`}</span>
            </div>
          );
        })}
      </div>

      {!enabled && <p className="pet-vitals__off">{copy.off}</p>}

      <div className="pet-vitals__actions">
        <button type="button" className="pet-vitals__action" onClick={onPet} disabled={!enabled}>
          {copy.pet}
        </button>
        <button type="button" className="pet-vitals__action" onClick={onFeed} disabled={!enabled}>
          {copy.feed}
        </button>
        <button
          type="button"
          className="pet-vitals__link"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {copy.details}
        </button>
      </div>

      {expanded && (
        <div className="pet-vitals__details">
          <p>{copy.detailsHint}</p>
          <dl>
            <dt>{copy.lastUpdate(formatTime(vitals.updatedAt))}</dt>
            <dd />
            <dt>{copy.energy}</dt>
            <dd>{Math.round(vitals.energy)}</dd>
            <dt>{copy.mood}</dt>
            <dd>{Math.round(vitals.mood)}</dd>
            <dt>{copy.bond}</dt>
            <dd>{Math.round(vitals.bond)}</dd>
            <dt>{copy.focus}</dt>
            <dd>{Math.round(vitals.focus)}</dd>
            {vitals.sleepMode && (
              <>
                <dt>{copy.sleepLabel}</dt>
                <dd>{vitals.sleepMode === "manual" ? copy.sleepingManual : copy.sleepingIdle}</dd>
              </>
            )}
            {vitals.lastOfflineRecovery && vitals.lastOfflineRecovery.gained >= 1 && (
              <>
                <dt>{copy.offlineLabel}</dt>
                <dd>
                  {vitals.lastOfflineRecovery.capped
                    ? copy.offlineRecoveredCapped(
                        Math.round(vitals.lastOfflineRecovery.hours),
                        Math.round(vitals.lastOfflineRecovery.gained),
                      )
                    : copy.offlineRecovered(
                        Math.round(vitals.lastOfflineRecovery.hours),
                        Math.round(vitals.lastOfflineRecovery.gained),
                      )}
                </dd>
              </>
            )}
            {recentVideo && (
              <>
                <dt>{copy.recentLabel}</dt>
                <dd>{copy.recentVideo(relativeAgo(recentVideo.at))}</dd>
              </>
            )}
          </dl>
          <p className="pet-vitals__privacy">{copy.privacy}</p>
          {onRefresh && (
            <button type="button" className="pet-vitals__link" onClick={onRefresh}>
              {copy.refresh}
            </button>
          )}
        </div>
      )}
    </div>
  );
}