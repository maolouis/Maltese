// 「试一下联动」：临时拉一只随从演示一次完整联动，3 秒后复原。
//
// 关键约束：**不改用户持久配置**。
// - 不写 localStorage、不改 React settings 状态；
// - 只把临时配置传给 Rust 的一次性同步命令 `sync_desktop_extras`（窗口显示用），
//   结束后再用真实配置同步一次，把临时窗口收回去；
// - 用 `force: true` 广播一次联动（跳过概率/冷却），保证一次必中；
// - 单例锁避免连点叠加；无论成功失败都走 finally 复原。

import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { loadPetCharacter } from "./petCharacters";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getPetLinkBus,
  PET_LINK_PREVIEW_MS,
  PET_LINK_SETTINGS_KEY,
} from "./petLinkBus";
import {
  buildLinkPlan,
  loadPetLinkHistory,
  PET_LINK_SOLO_SECOND_MS,
  rememberPairHash,
  savePetLinkHistory,
  type SceneBanks,
} from "./petLinkScript";

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

/**
 * 返回 true 表示演示已播放（不代表窗口一定可见，日志里会记录失败）。
 * `scenes` / `mainCharacter` 由调用方从 i18n 与当前形象传入（台词不硬编码在本模块）。
 */
export async function previewPetLinkage(options?: {
  scenes?: SceneBanks;
  mainCharacter?: string;
}): Promise<boolean> {
  if (!isTauri() || running) return false;
  running = true;
  const settings = readSettings();
  const mainCharacter = options?.mainCharacter ?? loadPetCharacter();
  const bank = options?.scenes?.pet;
  const recent = loadPetLinkHistory();
  // 预览按当前配置播完整剧本：有随从就让随从说一句、主狗说另一句；
  // 没有随从（petCount=1）就让主狗自说两句（A/B 剧本），保证一次看到「成对台词」。
  const companionLabels = ["companion-1"];
  const hasCompanion = settings.petCount > 1;
  const plan = bank
    ? buildLinkPlan({
        action: "pet",
        labels: hasCompanion ? companionLabels : [],
        bank,
        mainCharacter,
        recent,
        force: true,
      })
    : null;
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
    const lines = plan
      ? plan.lines
          .filter((line) => line.who !== "main")
          .reduce<Record<string, { line: string; speaker: "xiaobai" | "xiaojimao" }>>((acc, line) => {
            acc[line.who] = { line: line.line, speaker: line.speaker };
            return acc;
          }, {})
      : undefined;
    // 3) 强制发一次完整联动：跳过概率/冷却，剧本台词一起下发。
    getPetLinkBus("main").emitAction("pet", {
      force: true,
      labels: hasCompanion ? companionLabels : [],
      origin,
      toBongo: settings.bongoEnabled,
      sceneId: plan?.sceneId ?? "pet",
      lines,
      mainLine: plan?.mainLine ?? undefined,
      mainDelayMs: plan?.mainDelayMs ?? 0,
    });
    if (plan) {
      savePetLinkHistory(window.localStorage, rememberPairHash(recent, plan.hash));
      // 主狗那句交给主窗口显示（预览可能是在设置窗口点的）。
      if (plan.mainLine) {
        void emit("maltese-pet-link-say", {
          title: mainSaysTitle(mainCharacter),
          line: plan.mainLine,
          delayMs: plan.mainDelayMs,
        }).catch(() => undefined);
      }
      if (!hasCompanion) {
        const pair = bank?.pairs[plan.pairIndex];
        if (pair?.main) {
          void emit("maltese-pet-link-say", {
            title: mainSaysTitle(mainCharacter),
            line: pair.main,
            delayMs: PET_LINK_SOLO_SECOND_MS,
          }).catch(() => undefined);
        }
      }
    }
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

function mainSaysTitle(character: string): string {
  if (character === "xiaobai") return "小白";
  if (character === "xiaojimao") return "小鸡毛";
  return "小白和小鸡毛";
}