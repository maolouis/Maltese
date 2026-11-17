// 「所在屏幕」设置卡：小狗 / Bongo 各一个下拉（主屏 / 副屏 N / 跟随上次位置）。
// 显示器列表从 Rust 的 `list_monitors` 取（指纹 = 名字 + 分辨率），每 5s 刷新一次处理热插拔。
// 只有一块屏时下拉禁用并显示「只有一块屏幕」。

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "./i18n";
import {
  screenSelectOptions,
  type MonitorFingerprint,
  type ScreenSelectOption,
} from "./monitorSelection";
import "./ScreenPlacementCard.css";

export type ScreenPlacementCardProps = {
  islandScreen: string;
  bongoScreen: string;
  onChange: (next: { islandScreen: string; bongoScreen: string }) => void;
};

export default function ScreenPlacementCard({
  islandScreen,
  bongoScreen,
  onChange,
}: ScreenPlacementCardProps) {
  const t = useTranslation();
  const copy = t.screenPlacement;
  const [monitors, setMonitors] = useState<MonitorFingerprint[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const load = () => {
      void invoke<MonitorFingerprint[]>("list_monitors")
        .then((list) => {
          if (!cancelled && Array.isArray(list)) setMonitors(list);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const onlyOne = monitors.length <= 1;
  const islandOptions = screenSelectOptions(monitors, {
    followLabel: copy.followLast,
    primaryLabel: copy.primary,
  });
  const bongoOptions: ScreenSelectOption[] = [
    { value: "follow", label: copy.followIsland },
    ...screenSelectOptions(monitors, { followLabel: copy.followLast, primaryLabel: copy.primary }),
  ];
  // 只有一块屏时选项里只有「主屏」，避免选到不存在的屏。
  const islandValue = onlyOne ? "primary" : islandScreen;
  const bongoValue = onlyOne ? "follow" : bongoScreen;

  return (
    <div className="screen-placement">
      <div className="screen-placement__head">{copy.title}</div>
      <p className="screen-placement__hint">{copy.hint}</p>
      <div className="screen-placement__row">
        <label htmlFor="screen-placement-island">{copy.island}</label>
        <select
          id="screen-placement-island"
          value={islandValue}
          disabled={onlyOne}
          onChange={(event) => onChange({ islandScreen: event.target.value, bongoScreen })}
        >
          {onlyOne
            ? <option value="primary">{copy.onlyOne}</option>
            : islandOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
        </select>
      </div>
      <div className="screen-placement__row">
        <label htmlFor="screen-placement-bongo">{copy.bongo}</label>
        <select
          id="screen-placement-bongo"
          value={bongoValue}
          disabled={onlyOne}
          onChange={(event) => onChange({ islandScreen, bongoScreen: event.target.value })}
        >
          {onlyOne
            ? <option value="follow">{copy.onlyOne}</option>
            : bongoOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
        </select>
      </div>
      {onlyOne ? (
        <p className="screen-placement__note">{copy.onlyOne}</p>
      ) : (
        <ul className="screen-placement__screens">
          {monitors.map((monitor) => (
            <li key={monitor.key} data-primary={monitor.primary ? "1" : "0"}>
              {monitor.primary ? copy.primary : monitor.name}
              {" · "}
              {copy.resolution(monitor.width, monitor.height, Math.round(monitor.scale * 100))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}