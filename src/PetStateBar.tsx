// 聊天头部的「小狗状态」条：一行紧凑显示体力/情绪/亲密/专注，忙碌时右侧显示思考中。
//
// 轻量、可选：没有 vitals 数据或用户关掉 petVitalsEnabled 时整行不渲染（布局不变）。
// 数据源：localStorage["maltese-pet-vitals"]（防御式解析）+ storage / 自定义事件 / 2s 轮询。

import { useEffect, useMemo, useState } from "react";
import { loadVitalsSummary, type VitalsSummary } from "./petContext";
import {
  busyStateText,
  formatStateBar,
  readCollapsed,
  stateBarVisible,
  writeCollapsed,
} from "./petStateBarLogic";
import "./PetStateBar.css";

const SETTINGS_KEY = "focusd-island-settings";
const VITALS_UPDATED_EVENT = "maltese-pet-vitals-changed";

function readVitalsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 只有显式关闭才隐藏，旧版本没有该字段 → 默认显示。
    return parsed.petVitalsEnabled !== false;
  } catch {
    return true;
  }
}

export function PetStateBar({
  busy,
  waitSeconds,
  thinkingOn,
}: {
  busy: boolean;
  waitSeconds: number;
  thinkingOn: boolean;
}) {
  // 首次读取就写回默认值：新装/清缓存用户也有数据可显示（只有开关关闭才隐藏）。
  const [vitals, setVitals] = useState<VitalsSummary | null>(() =>
    loadVitalsSummary(window.localStorage, { writeDefault: true }),
  );
  const [enabled, setEnabled] = useState(readVitalsEnabled);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(window.localStorage));

  useEffect(() => {
    const refresh = () => {
      setVitals(loadVitalsSummary(window.localStorage, { writeDefault: true }));
      setEnabled(readVitalsEnabled());
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(VITALS_UPDATED_EVENT, refresh);
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(VITALS_UPDATED_EVENT, refresh);
      window.clearInterval(timer);
    };
  }, []);

  const visible = stateBarVisible(vitals, enabled);
  const text = useMemo(() => (vitals ? formatStateBar(vitals) : ""), [vitals]);
  if (!visible) return null;

  return (
    <div
      className={`pet-state${collapsed ? " pet-state--collapsed" : ""}${busy ? " pet-state--busy" : ""}`}
      role="status"
      aria-label={`小狗状态：${text}`}
      title={collapsed ? "展开小狗状态" : "收起小狗状态"}
    >
      <button
        type="button"
        className="pet-state__toggle"
        aria-expanded={!collapsed}
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          writeCollapsed(window.localStorage, next);
        }}
      >
        <span className="pet-state__dot" aria-hidden="true" />
        {!collapsed && <span className="pet-state__text">{text}</span>}
      </button>
      {!collapsed && (
        <span className="pet-state__hint">回复会参考它的状态</span>
      )}
      {busy && (
        <span className="pet-state__busy" aria-live="polite">
          {busyStateText(busy, waitSeconds, thinkingOn)}
        </span>
      )}
    </div>
  );
}

export default PetStateBar;