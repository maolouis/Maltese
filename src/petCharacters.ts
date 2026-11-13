// 桌宠形象（小白 / 小鸡毛 / 两只一起）与素材解析。
//
// 素材来自 LineDogPet 的 pets/xiaobai、pets/xiaojimao、pets/shared：
//   - xiaobai / xiaojimao 是两只可选小狗，各自有一套动作 GIF；
//   - shared 是「两只小狗同框」的共享池，不是独立角色。默认角色的某个动作
//     有同框素材时会按比例插进轮播里；选「一起出现」时只播同框素材。
//
// 动作缺素材时按 LineDogPet 的回退链找视觉相近的动作，最后兜底小白 idle，
// 保证任何形象在任何状态下都有画面。

import { useCallback, useEffect, useState } from "react";
import { PET_CHARACTER_ASSETS } from "./petCharacterAssets.generated";
import { petAssetUrl } from "./petAssetBase";

export type PetCharacterId = "xiaobai" | "xiaojimao" | "duo";

export const PET_CHARACTER_STORAGE_KEY = "maltese-pet-character";
export const PET_CHARACTER_UPDATED_EVENT = "maltese-pet-character-updated";

export const PET_CHARACTERS: ReadonlyArray<{
  id: PetCharacterId;
  zh: string;
  en: string;
  hintZh: string;
}> = [
  { id: "xiaobai", zh: "小白", en: "Xiaobai", hintZh: "白色线条小狗" },
  { id: "xiaojimao", zh: "小鸡毛", en: "Jijimao", hintZh: "金黄色线条小狗" },
  {
    id: "duo",
    zh: "小白和小鸡毛",
    en: "Both",
    hintZh: "两只小狗同框出镜",
  },
];

export const PET_CHARACTER_LABELS: Record<PetCharacterId, string> = {
  xiaobai: "小白",
  xiaojimao: "小鸡毛",
  duo: "小白和小鸡毛",
};

/** 界面状态 -> LineDogPet 的动作目录名。 */
const STATE_TO_ACTION: Record<string, string> = {
  idle: "idle",
  resting: "relax",
  listening: "peek",
  working: "work",
  attention: "paper",
  pet: "pet",
  eating: "eat",
  pickup: "pickup",
  scared: "scared",
  sleeping: "sleep",
  celebrate: "hop",
  happy: "happy",
  relax: "relax",
  chin: "chin",
  spin: "spin",
  play: "play",
  hide: "hide",
  chase: "chase",
  peek: "peek",
};

/** 动作缺素材时的视觉近似回退链（取自 LineDogPet 的 ACTION_FALLBACK）。 */
const ACTION_FALLBACK: Record<string, string[]> = {
  idle: [],
  happy: ["idle"],
  pet: ["happy", "idle"],
  chin: ["groom", "happy", "idle"],
  pickup: ["hop", "happy", "idle"],
  spin: ["play", "happy", "idle"],
  hop: ["happy", "idle"],
  sleep: ["idle"],
  deep: ["sleep", "idle"],
  walk: ["idle"],
  chase: ["walk", "idle"],
  scared: ["nervous", "idle"],
  nervous: ["scared", "idle"],
  relax: ["groom", "idle"],
  groom: ["relax", "idle"],
  eat: ["happy", "idle"],
  paper: ["work", "idle"],
  work: ["idle"],
  peek: ["play", "idle"],
  play: ["happy", "idle"],
  hide: ["scared", "idle"],
};

/** 招牌动作固定播共享池里的那一张，和 LineDogPet 手感一致。 */
const FIXED_SHARED_FILES: Record<string, string> = {
  pickup: "举起来.gif",
  spin: "转圈.gif",
  chase: "狂奔.gif",
};

/** 默认角色轮播里同框素材的露面比例：每 3 张本角色图插 1 张同框图。 */
const SHARED_EVERY = 3;

function decodeName(src: string): string {
  const tail = src.slice(src.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function assetsOf(character: string, action: string): string[] {
  return PET_CHARACTER_ASSETS[character]?.[action] ?? [];
}

function collectFrames(character: string, action: string): string[] {
  for (const candidate of [action, ...(ACTION_FALLBACK[action] ?? [])]) {
    const frames = assetsOf(character, candidate);
    if (frames.length > 0) return frames;
  }
  return [];
}

function sharedFrames(action: string): string[] {
  for (const candidate of [action, ...(ACTION_FALLBACK[action] ?? [])]) {
    const frames = assetsOf("shared", candidate);
    if (frames.length > 0) return frames;
  }
  return [];
}

function fixedSharedFrame(action: string): string | undefined {
  const fileName = FIXED_SHARED_FILES[action];
  if (!fileName) return undefined;
  const pool = assetsOf("shared", action);
  return pool.find((frame) => decodeName(frame) === fileName);
}

function fallbackIdle(): string[] {
  return collectFrames("xiaobai", "idle");
}

function interleaveShared(own: string[], shared: string[]): string[] {
  if (shared.length === 0) return own;
  const out: string[] = [];
  let sharedIndex = 0;
  own.forEach((frame, index) => {
    out.push(frame);
    if ((index + 1) % SHARED_EVERY === 0) {
      out.push(shared[sharedIndex % shared.length]);
      sharedIndex += 1;
    }
  });
  // 结尾补一张同框图，避免素材少时整轮都没轮到。
  if (sharedIndex === 0) out.push(shared[0]);
  return [...new Set(out)];
}

/**
 * 单个状态最多轮播多少张：素材池里一个动作可能有 100 多张 GIF，
 * 全部预加载会吃掉几十 MB 内存，这里按均匀间隔抽一批，本次运行保持不变。
 */
const MAX_FRAMES_PER_STATE = 30;

const frameCache = new Map<string, string[]>();
const rawFrameCache = new Map<string, string[]>();

function computeFrames(
  character: PetCharacterId,
  state: string,
  ownOnly: boolean,
): string[] {
  const action = STATE_TO_ACTION[state] ?? "idle";
  const fixed = fixedSharedFrame(action);
  if (fixed && character !== "duo") {
    // 抱起/转圈/追逐是 LineDogPet 的招牌动作，固定用同框那一张。
    return [fixed, ...collectFrames(character, action).slice(0, 2)];
  }

  if (character === "duo") {
    const shared = sharedFrames(action);
    if (shared.length > 0) return shared;
    const own = collectFrames("xiaobai", action);
    return own.length > 0 ? own : fallbackIdle();
  }

  const own = collectFrames(character, action);
  if (ownOnly) {
    if (own.length > 0) return own;
    return collectFrames("xiaobai", action).length > 0
      ? collectFrames("xiaobai", action)
      : fallbackIdle();
  }
  const shared = sharedFrames(action);
  const merged = interleaveShared(own, shared);
  if (merged.length > 0) return merged;
  const xiaobai = collectFrames("xiaobai", action);
  return xiaobai.length > 0 ? xiaobai : fallbackIdle();
}

/** 均匀抽样整个素材池，保证一次运行里各个动作的图都能轮到几张。 */
function sampleFrames(frames: string[]): string[] {
  if (frames.length <= MAX_FRAMES_PER_STATE) return frames;
  const stride = frames.length / MAX_FRAMES_PER_STATE;
  const offset = Math.floor(Math.random() * frames.length);
  const picked: string[] = [];
  for (let index = 0; index < MAX_FRAMES_PER_STATE; index += 1) {
    picked.push(frames[Math.floor(offset + index * stride) % frames.length]);
  }
  return [...new Set(picked)];
}

/**
 * 某个形象在某个界面状态下的 GIF 列表（顺序稳定，可直接用于轮播）。
 *
 * @param ownOnly 跟随鼠标/陪玩小窗这类“只该有一只狗”的场景传 true，
 *                避免同框图和小尺寸窗口抢戏。
 */
export function characterFramesForState(
  character: PetCharacterId,
  state: string,
  { ownOnly = false }: { ownOnly?: boolean } = {},
): string[] {
  const key = `${character}|${state}|${ownOnly ? "own" : "all"}`;
  const cached = frameCache.get(key);
  if (cached) return cached;
  const frames = characterFramePaths(character, state, { ownOnly }).map(petAssetUrl);
  frameCache.set(key, frames);
  return frames;
}

/**
 * 同上，但返回 `/assets/pets/...` 原始路径。
 *
 * 本地存储里只该存这种「与安装目录无关」的路径：装到哪都能解析，
 * 也不会因为升级/换盘符变成失效的绝对地址。
 */
export function characterFramePaths(
  character: PetCharacterId,
  state: string,
  { ownOnly = false }: { ownOnly?: boolean } = {},
): string[] {
  const key = `${character}|${state}|${ownOnly ? "own" : "all"}`;
  const cached = rawFrameCache.get(key);
  if (cached) return cached;
  const frames = sampleFrames(computeFrames(character, state, ownOnly));
  rawFrameCache.set(key, frames);
  return frames;
}

/** 设置页「全选」用的完整素材池（不抽样）。 */
export function characterAllFrames(character: PetCharacterId, state: string): string[] {
  return computeFrames(character, state, false).map(petAssetUrl);
}

/** 该形象在某状态下可用的素材总量（设置页展示用）。 */
export function characterActionCount(character: PetCharacterId, state: string): number {
  return characterFramesForState(character, state).length;
}

export function isPetCharacterId(value: unknown): value is PetCharacterId {
  return value === "xiaobai" || value === "xiaojimao" || value === "duo";
}

export function loadPetCharacter(): PetCharacterId {
  try {
    const raw = window.localStorage.getItem(PET_CHARACTER_STORAGE_KEY);
    return isPetCharacterId(raw) ? raw : "xiaobai";
  } catch {
    return "xiaobai";
  }
}

export function savePetCharacter(character: PetCharacterId) {
  try {
    window.localStorage.setItem(PET_CHARACTER_STORAGE_KEY, character);
    window.dispatchEvent(new Event(PET_CHARACTER_UPDATED_EVENT));
  } catch {
    // localStorage 不可用时保持当前会话行为。
  }
}

/** 主窗口、陪玩狗、跟随狗、设置窗口之间同步形象切换。 */
export function usePetCharacter(): PetCharacterId {
  const [character, setCharacter] = useState<PetCharacterId>(loadPetCharacter);

  const refresh = useCallback(() => setCharacter(loadPetCharacter()), []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PET_CHARACTER_STORAGE_KEY || event.key === null) refresh();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PET_CHARACTER_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PET_CHARACTER_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  return character;
}
