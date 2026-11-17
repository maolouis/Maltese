// 小狗的状态卡片（体力 / 情绪 / 亲密 / 专注）。
// 岛内设置页与独立设置窗口共用；纯展示 + 两个动作按钮，数值逻辑都在 petVitals.ts。

import { useState } from "react";
import { useTranslation } from "./i18n";
import { vitalsLevel, type PetVitalsSnapshot } from "./petVitals";
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