import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PET_GIF_VARIANTS } from "./petAssets";
import {
  characterFramesForState,
  loadPetCharacter,
  type PetCharacterId,
} from "./petCharacters";

/** 旧版按状态存的配置键，读取时迁移到小白。 */
const LEGACY_STORAGE_KEY = "maltese-pet-gif-rotation";
export const PET_GIF_ROTATION_STORAGE_PREFIX = "maltese-pet-gif-rotation:";
export const PET_GIF_ROTATION_UPDATED_EVENT = "maltese-pet-gif-rotation-updated";
export const PET_GIF_ROTATION_STATES_KEY = "maltese-pet-gif-rotation-states";
export const PET_GIF_ROTATION_STATES_EVENT = "maltese-pet-gif-rotation-states-updated";

export type PetGifRotationItem = {
  id: string;
  /** 内置素材路径；自定义素材使用 path。 */
  src?: string;
  /** 自定义 GIF 在应用数据目录中的绝对路径。 */
  path?: string;
  name: string;
  custom?: boolean;
};

export type PetGifRotationConfig = Record<string, PetGifRotationItem[]>;

export function petGifRotationKey(character: PetCharacterId): string {
  return `${PET_GIF_ROTATION_STORAGE_PREFIX}${character}`;
}

export const PET_STATE_LABELS: Record<string, string> = {
  idle: "待机",
  resting: "休息",
  listening: "聆听",
  working: "工作",
  attention: "注意",
  pet: "摸摸",
  eating: "吃东西",
  pickup: "抱起",
  scared: "害怕",
  sleeping: "睡觉",
  celebrate: "庆祝",
  happy: "开心",
  relax: "放松",
  chin: "托腮",
  spin: "转圈",
  play: "玩耍",
  hide: "躲藏",
  chase: "追逐",
  peek: "偷看",
};

export function petGifFileName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const tail = normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

export function defaultPetGifItems(
  state: string,
  character: PetCharacterId = "xiaobai",
): PetGifRotationItem[] {
  const frames = characterFramesForState(character, state);
  return frames.map((src) => ({
    id: src,
    src,
    name: petGifFileName(src),
    custom: false,
  }));
}

export function defaultPetGifRotationConfig(
  character: PetCharacterId = "xiaobai",
): PetGifRotationConfig {
  const config: PetGifRotationConfig = {};
  for (const state of Object.keys(PET_GIF_VARIANTS)) {
    config[state] = defaultPetGifItems(state, character);
  }
  return config;
}

function normalizeItem(value: unknown): PetGifRotationItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const src = typeof item.src === "string" && item.src ? item.src : undefined;
  const path = typeof item.path === "string" && item.path ? item.path : undefined;
  if (!src && !path) return null;
  return {
    id:
      typeof item.id === "string" && item.id
        ? item.id
        : path ?? src ?? `${Date.now()}-${Math.random()}`,
    src,
    path,
    name:
      typeof item.name === "string" && item.name
        ? item.name
        : petGifFileName(path ?? src ?? "GIF"),
    custom: item.custom === true || Boolean(path),
  };
}

function readConfig(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function loadPetGifRotationConfig(
  character: PetCharacterId = loadPetCharacter(),
): PetGifRotationConfig {
  const defaults = defaultPetGifRotationConfig(character);
  // 小白沿用旧版按状态保存的配置；其他形象第一次使用时直接用素材默认值。
  const saved =
    readConfig(petGifRotationKey(character)) ??
    (character === "xiaobai" ? readConfig(LEGACY_STORAGE_KEY) : null);
  if (typeof saved !== "object" || saved === null) return defaults;
  const table = saved as Record<string, unknown>;
  for (const state of Object.keys(defaults)) {
    const list = table[state];
    if (!Array.isArray(list)) continue;
    // 显式保存空数组是合法的：用户删光后，主狗会退回默认顺序显示。
    defaults[state] = list
      .map(normalizeItem)
      .filter((item): item is PetGifRotationItem => item !== null);
  }
  return defaults;
}

export function savePetGifRotationConfig(
  config: PetGifRotationConfig,
  character: PetCharacterId = loadPetCharacter(),
) {
  try {
    window.localStorage.setItem(petGifRotationKey(character), JSON.stringify(config));
    window.dispatchEvent(new Event(PET_GIF_ROTATION_UPDATED_EVENT));
  } catch {
    // localStorage 不可用时仍让当前会话继续运行。
  }
}

export function loadPetGifRotationStates(): string[] {
  const valid = Object.keys(PET_GIF_VARIANTS);
  try {
    const raw = window.localStorage.getItem(PET_GIF_ROTATION_STATES_KEY);
    if (!raw) return ["idle"];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ["idle"];
    const states = [...new Set(parsed.filter((value): value is string =>
      typeof value === "string" && valid.includes(value),
    ))];
    return states.length > 0 ? states : ["idle"];
  } catch {
    return ["idle"];
  }
}

export function savePetGifRotationStates(states: string[]) {
  const valid = new Set(Object.keys(PET_GIF_VARIANTS));
  const normalized = [...new Set(states.filter((state) => valid.has(state)))];
  const next = normalized.length > 0 ? normalized : ["idle"];
  try {
    window.localStorage.setItem(PET_GIF_ROTATION_STATES_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(PET_GIF_ROTATION_STATES_EVENT));
  } catch {
    // localStorage 不可用时保持当前会话行为。
  }
  return next;
}

/** 设置窗口保存后，主窗口/陪玩狗/跟随狗通过 storage 事件同步。 */
export function usePetGifRotationStates(): string[] {
  const [states, setStates] = useState<string[]>(loadPetGifRotationStates);

  useEffect(() => {
    const update = () => setStates(loadPetGifRotationStates());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PET_GIF_ROTATION_STATES_KEY || event.key === null) {
        update();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PET_GIF_ROTATION_STATES_EVENT, update);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PET_GIF_ROTATION_STATES_EVENT, update);
    };
  }, []);

  return states;
}

export function petGifItemSrc(item: PetGifRotationItem): string {
  if (item.path) {
    try {
      return convertFileSrc(item.path);
    } catch {
      return item.path;
    }
  }
  return item.src ?? "";
}

export function rotationFramesForState(
  config: PetGifRotationConfig,
  state: string,
  rotationStates?: string[],
  character: PetCharacterId = loadPetCharacter(),
): string[] {
  const framesFor = (target: string): string[] => {
    const configured = (config[target] ?? [])
      .map(petGifItemSrc)
      .filter((src) => Boolean(src));
    // 用户把某一类表情删空时，不要显示破图，退回该形象的内置素材。
    return configured.length > 0
      ? configured
      : characterFramesForState(character, target);
  };

  // 动作/情绪表情仍优先显示自己的 GIF；只有待机轮播会合并用户勾选的状态。
  if (state !== "idle" || !rotationStates || rotationStates.length === 0) {
    return framesFor(state);
  }

  const merged = rotationStates.flatMap((target) => framesFor(target));
  return [...new Set(merged)];
}

/** 设置窗口保存后，主窗口/陪玩狗/跟随狗通过 storage 事件同步。 */
export function usePetGifRotationConfig(
  character: PetCharacterId = loadPetCharacter(),
): PetGifRotationConfig {
  const [config, setConfig] = useState<PetGifRotationConfig>(() =>
    loadPetGifRotationConfig(character),
  );

  useEffect(() => {
    setConfig(loadPetGifRotationConfig(character));
    const update = () => setConfig(loadPetGifRotationConfig(character));
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === petGifRotationKey(character) ||
        event.key === LEGACY_STORAGE_KEY ||
        event.key === null
      ) {
        update();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PET_GIF_ROTATION_UPDATED_EVENT, update);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PET_GIF_ROTATION_UPDATED_EVENT, update);
    };
  }, [character]);

  return config;
}
