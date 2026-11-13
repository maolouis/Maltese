// 设置面板里的通用控件（滑块 / 取色 / 开关 / 外观模式 / 数字 / 语言）。
import { useTranslation, LOCALE_CODES, TRANSLATIONS, isLocaleCode, type LocaleCode } from "./i18n";

type AppearanceMode = "classic" | "liquidGlass";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-control">
      <span className="slider-control__meta">
        <span>{label}</span>
        <strong>
          {step < 1 ? value.toFixed(2) : Math.round(value)}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

export function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="color-control">
      <span className="color-control__meta">
        <span>{label}</span>
        <strong>{value.toUpperCase()}</strong>
      </span>
      <input
        type="color"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-control">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle-control__switch" aria-hidden="true" />
    </label>
  );
}

export function AppearanceModeControl({
  value,
  onChange,
}: {
  value: AppearanceMode;
  onChange: (value: AppearanceMode) => void;
}) {
  const t = useTranslation();
  return (
    <div className="appearance-mode-control">
      <span>{t.settings.appearance.title}</span>
      <div className="appearance-mode-control__segments" role="group">
        <button
          className={value === "classic" ? "appearance-mode-control--active" : ""}
          type="button"
          aria-pressed={value === "classic"}
          onClick={() => onChange("classic")}
        >
          {t.settings.appearance.classic}
        </button>
        <button
          className={
            value === "liquidGlass" ? "appearance-mode-control--active" : ""
          }
          type="button"
          aria-pressed={value === "liquidGlass"}
          onClick={() => onChange("liquidGlass")}
        >
          {t.settings.appearance.liquidGlass}
        </button>
      </div>
    </div>
  );
}

export function NumberControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="number-control">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const nextValue = Number(event.currentTarget.value);

          if (Number.isFinite(nextValue)) {
            onChange(clamp(Math.round(nextValue), min, max));
          }
        }}
      />
    </label>
  );
}

export function LocaleControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: LocaleCode;
  onChange: (locale: LocaleCode) => void;
}) {
  return (
    <label className="locale-control">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isLocaleCode(next)) {
            onChange(next);
          }
        }}
      >
        {LOCALE_CODES.map((code) => (
          <option key={code} value={code}>
            {TRANSLATIONS[code].localeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
