import { useEffect, useMemo, useState } from "react";
import {
  customFontName,
  fetchSystemFonts,
  FONT_PRESETS,
  type SystemFontsSnapshot,
} from "./fontSettings";

export interface SystemFontSelectProps {
  label: string;
  value: string | undefined;
  onChange: (nextFont: string) => void;
  compact?: boolean;
}

export function SystemFontSelect({
  label,
  value,
  onChange,
  compact = false,
}: SystemFontSelectProps) {
  const [snapshot, setSnapshot] = useState<SystemFontsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSystemFonts().then((result) => {
      if (!cancelled) {
        setSnapshot(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedValue = (value ?? "").trim() || "default";
  const extraSavedFont = useMemo(() => {
    const custom = customFontName(selectedValue);
    if (!custom) return "";
    if (snapshot?.fonts.includes(custom)) return "";
    return custom;
  }, [selectedValue, snapshot]);

  const activeFontLabel = snapshot?.activeFont
    ? `默认（系统现用：${snapshot.activeFont}）`
    : FONT_PRESETS[0].label;

  return (
    <div className={compact ? "appearance-mode-control" : "sw-font"}>
      <span>{label}</span>
      <select
        className={compact ? "sw-input" : undefined}
        style={
          compact
            ? {
                maxWidth: 210,
                borderRadius: 8,
                padding: "4px 8px",
                fontSize: 12,
                border: "1px solid rgba(148, 163, 184, 0.45)",
                background: "rgba(255, 255, 255, 0.9)",
                color: "#1e293b",
              }
            : undefined
        }
        value={selectedValue}
        aria-label={label}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next === "default" ? "" : next);
        }}
      >
        <optgroup label="预设">
          <option value="default">{activeFontLabel}</option>
          {FONT_PRESETS.slice(1).map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </optgroup>
        {snapshot && snapshot.fonts.length > 0 && (
          <optgroup label={`本机现用与已安装字体（${snapshot.fonts.length} 款）`}>
            {extraSavedFont && (
              <option value={extraSavedFont}>{extraSavedFont}（当前配置）</option>
            )}
            {snapshot.fonts.map((font) => (
              <option key={font} value={font}>
                {font === snapshot.activeFont ? `${font}（系统现用）` : font}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
