// 「试一下联动」：临时拉一只随从演示一次完整联动，3 秒后复原。
//
// 关键约束：**不改用户持久配置**。
// - 不写 localStorage、不改 React settings 状态；
// - 只把临时配置传给 Rust 的一次性同步命令 `sync_desktop_extras`（窗口显示用），
//   结束后再用真实配置同步一次，把临时窗口收回去；
// - 用 `force: true` 广播一次联动（跳过概率/冷却），保证一次必中；
// - 单例锁避免连点叠加；无论成功失败都走 finally 复原。

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getPetLinkBus,
  PET_LINK_PREVIEW_MS,
  PET_LINK_SETTINGS_KEY,
} from "./petLinkBus";

type PreviewSettings = {
  petCount: number;
  bongoEnabled: boolean;
  bongoSize: number;
  bongoOpacity: number;
  bongoMirror: boolean;
  bongoClickThrough: boolean;
  bongoPosition: string;
  followMouse: boolean;
  cursorPetSize: number;
};

const FALLBACK_SETTINGS: PreviewSettings = {
  petCount: 1,
  bongoEnabled: false,
  bongoSize: 440,
  bongoOpacity: 100,
  bongoMirror: true,
  bongoClickThrough: false,
  bongoPosition: "bottomCenter",
  followMouse: false,
  cursorPetSize: 75,
};

function readSettings(): PreviewSettings {
  try {
    const raw = window.localStorage.getItem(PET_LINK_SETTINGS_KEY);
    if (!raw) return FALLBACK_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PreviewSettings>;
    return {
      petCount: Number.isFinite(Number(parsed.petCount)) ? Number(parsed.petCount) : FALLBACK_SETTINGS.petCount,
      bongoEnabled: parsed.bongoEnabled === true,
      bongoSize: Number.isFinite(Number(parsed.bongoSize)) ? Number(parsed.bongoSize) : FALLBACK_SETTINGS.bongoSize,
      bongoOpacity: Number.isFinite(Number(parsed.bongoOpacity)) ? Number(parsed.bongoOpacity) : FALLBACK_SETTINGS.bongoOpacity,
      bongoMirror: parsed.bongoMirror !== false,
      bongoClickThrough: parsed.bongoClickThrough === true,
      bongoPosition: typeof parsed.bongoPosition === "string" ? parsed.bongoPosition : FALLBACK_SETTINGS.bongoPosition,
      followMouse: parsed.followMouse === true,
      cursorPetSize: Number.isFinite(Number(parsed.cursorPetSize)) ? Number(parsed.cursorPetSize) : FALLBACK_SETTINGS.cursorPetSize,
    };
  } catch {
    return FALLBACK_SETTINGS;
  }
}

function extrasConfig(settings: PreviewSettings, petCount: number, bongoEnabled: boolean) {
  return {
    petCount,
    bongoEnabled,
    bongoSize: settings.bongoSize,
    bongoOpacity: settings.bongoOpacity,
    bongoMirror: settings.bongoMirror,
    bongoClickThrough: settings.bongoClickThrough,
    bongoPosition: settings.bongoPosition,
    followMouse: settings.followMouse,
    cursorPetSize: settings.cursorPetSize,
  };
}

let running = false;

/** 返回 true 表示演示已播放（不代表窗口一定可见，日志里会记录失败）。 */
export async function previewPetLinkage(): Promise<boolean> {
  if (!isTauri() || running) return false;
  running = true;
  const settings = readSettings();
  try {
    // 1) 临时把随从数量提到 2（只作用于本次原生同步，不落盘）。
    await invoke("sync_desktop_extras", {
      config: extrasConfig(settings, Math.max(2, settings.petCount), settings.bongoEnabled),
    });
    // 2) 等 Rust 建好并显示随从窗口。
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const origin = await getCurrentWindow()
      .outerPosition()
      .then((pos) => ({ x: pos.x, y: pos.y }))
      .catch(() => undefined);
    // 3) 强制发一次联动：跳过概率/冷却，只发给 companion-1，保证看得见。
    getPetLinkBus("main").emitAction("pet", {
      force: true,
      labels: ["companion-1"],
      origin,
      toBongo: settings.bongoEnabled,
    });
    await new Promise((resolve) => window.setTimeout(resolve, PET_LINK_PREVIEW_MS));
    return true;
  } catch (error) {
    console.error("preview_pet_link failed", error);
    return false;
  } finally {
    // 4) 无论成功失败都按真实配置复原（临时窗口收回）。
    await invoke("sync_desktop_extras", {
      config: extrasConfig(settings, settings.petCount, settings.bongoEnabled),
    }).catch((error) => console.error("preview_pet_link restore failed", error));
    running = false;
  }
}