// 桌宠形象（小白 / 小鸡毛 / 两只一起）与素材解析。
//
// 素材来自 LineDogPet 的 pets/xiaobai、pets/xiaojimao、pets/shared：
//   - xiaobai / xiaojimao 是两只可选小狗，各自有一套动作 GIF；
//   - shared 是「两只小狗同框」的共享池，不是独立角色。同框 GIF 只给「一起出现」
//     (duo) 用；小白 / 小鸡毛各自只播自己的素材，池子和数量都不含双狗图。
//
// 动作缺素材时按 LineDogPet 的回退链找视觉相近的动作，最后兜底小白 idle，
// 保证任何形象在任何状态下都有画面。

import { useCallback, useEffect, useState } from "react";
import { PET_CHARACTER_ASSETS } from "./petCharacterAssets.generated.ts";
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
  angry: "angry",
  cry: "cry",
  love: "love",
  ride: "ride",
  bath: "bath",
  costume: "costume",
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
  angry: ["nervous", "scared", "idle"],
  cry: ["scared", "nervous", "idle"],
  love: ["pet", "happy", "idle"],
  ride: ["play", "walk", "idle"],
  bath: ["relax", "idle"],
  costume: ["happy", "idle"],
};

/** 招牌动作固定播指定池里的那一张，和 LineDogPet 手感一致。 */
const FIXED_SHARED_FILES: Record<string, { character: string; fileName: string }> = {
  pickup: { character: "shared", fileName: "举起来.gif" },
  spin: { character: "shared", fileName: "转圈.gif" },
  // 这张是单只小鸡毛，归到小鸡毛池；界面仍固定用它作为追逐招牌动作。
  chase: { character: "xiaojimao", fileName: "狂奔.gif" },
};

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

function fixedSharedFrame(action: string, character: string): string | undefined {
  const entry = FIXED_SHARED_FILES[action];
  if (!entry) return undefined;
  // 双狗同框的招牌图（举起来/转圈）不再给单角色用，只保留角色专属招牌图。
  if (entry.character === "shared") return undefined;
  // 共享招牌图给所有单角色用；某个角色专属的招牌图只给该角色用。
  if (entry.character !== "shared" && entry.character !== character) return undefined;
  const pool = assetsOf(entry.character === "shared" ? "shared" : entry.character, action);
  return pool.find((frame) => decodeName(frame) === entry.fileName);
}

function fallbackIdle(): string[] {
  return collectFrames("xiaobai", "idle");
}

/**
 * 额外素材池：官方微博表情包里「内容唯一」的 9 张 + 旧版兜底 rest.gif。
 * 其余 287 张微博表情包与 chars 内容完全相同（生成脚本按 sha256 去重），不重复计入。
 * 两只单角色都能用（贴纸是通用线条小狗画风）；duo 只播同框池，不混单只素材。
 */
const EXTRA_POOLS = ["stickers", "legacy"] as const;

function extraPoolFrames(character: PetCharacterId, action: string): string[] {
  if (character === "duo") return [];
  const frames: string[] = [];
  for (const pool of EXTRA_POOLS) {
    frames.push(...(PET_CHARACTER_ASSETS[pool]?.[action] ?? []));
  }
  return frames;
}

/** 素材库分组（设置页总览用）：id -> 中文名。 */
export const PET_ASSET_GROUP_LABELS: Record<string, string> = {
  xiaobai: "小白",
  xiaojimao: "小鸡毛",
  shared: "双狗同框",
  stickers: "微博表情包（仅内容唯一）",
  legacy: "旧版兜底",
};

/** 素材库各分组条数（清单条目，不含被内容去重的重复文件）。 */
export function petAssetGroupCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [group, actions] of Object.entries(PET_CHARACTER_ASSETS)) {
    counts[group] = Object.values(actions).reduce((sum, files) => sum + files.length, 0);
  }
  return counts;
}

/** 素材库总条数（= 设置页「素材库 M」）。 */
export function petAssetTotalCount(): number {
  return Object.values(petAssetGroupCounts()).reduce((sum, count) => sum + count, 0);
}

/** 2026-11-17 去重：删掉与 chars 内容完全相同的 383 个副本（287 微博表情包 + 96 旧兜底）。
 *  数值写死是为了设置页能给出「少了多少 MB」的可核对说明；如以后再次清理，同步改这里。 */
export const PET_ASSET_DEDUPE = { removedFiles: 383, removedMB: 31 } as const;

/**
 * 单个状态最多轮播多少张：素材池里一个动作可能有 100 多张 GIF，
 * 全部预加载会吃掉几十 MB 内存，这里按均匀间隔抽一批，本次运行保持不变。
 */
const MAX_FRAMES_PER_STATE = 30;
/** 设置页提示用：轮播每个状态最多抽多少张（完整素材池仍然全部可选）。 */
export const PET_ROTATION_FRAMES_PER_STATE = MAX_FRAMES_PER_STATE;

const frameCache = new Map<string, string[]>();
const rawFrameCache = new Map<string, string[]>();

/** 同框（两条狗）素材只给 duo：单角色池一律不含 shared。 */
function computeFrames(
  character: PetCharacterId,
  state: string,
  _ownOnly: boolean,
): string[] {
  const action = STATE_TO_ACTION[state] ?? "idle";
  const fixed = fixedSharedFrame(action, character);
  if (fixed && character !== "duo") {
    // 抱起/转圈/追逐是 LineDogPet 的招牌动作，固定用指定池里的那一张。
    return [fixed, ...collectFrames(character, action).slice(0, 2)];
  }

  if (character === "duo") {
    const shared = sharedFrames(action);
    if (shared.length > 0) return shared;
    const own = collectFrames("xiaobai", action);
    return own.length > 0 ? own : fallbackIdle();
  }

  const own = [...collectFrames(character, action), ...extraPoolFrames(character, action)];
  // 单角色（小白 / 小鸡毛）只播自己的素材，不再混入双狗同框图；
  // 同框池只给「一起出现」(duo) 用。
  if (own.length > 0) return [...new Set(own)];
  const xiaobai = collectFrames("xiaobai", action);
  return xiaobai.length > 0 ? xiaobai : fallbackIdle();
}

/** 均匀抽样整个素材池，保证一次运行里各个动作的图都能轮到几张。 */function sampleFrames(frames: string[]): string[] {
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
