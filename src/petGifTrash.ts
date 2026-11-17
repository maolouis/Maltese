// 「恢复最近删除」用的回收站：记录存在 localStorage，自定义 GIF 的磁盘副本
// 放在应用数据目录的 pet-gifs-trash/ 下（由 Rust 侧的 park_pet_gif 复制）。
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  PET_GIF_TRASH_LIMIT,
  pushPetGifTrashEntry,
  removePetGifTrashEntry,
  sortPetGifTrash,
  type PetGifTrashEntry,
} from "./utils/petGifRemoval";

export const PET_GIF_TRASH_KEY = "maltese-pet-gif-trash";
export const PET_GIF_TRASH_EVENT = "maltese-pet-gif-trash-updated";

type ParkedPetGif = {
  trashPath: string;
  name: string;
};

function normalizeEntry(value: unknown): PetGifTrashEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const item = entry.item as Record<string, unknown> | null | undefined;
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" && item.id ? item.id : "";
  const name = typeof item.name === "string" && item.name ? item.name : "";
  if (!id || !name) return null;
  const src = typeof item.src === "string" && item.src ? item.src : undefined;
  const path = typeof item.path === "string" && item.path ? item.path : undefined;
  if (!src && !path) return null;
  const character = typeof entry.character === "string" && entry.character ? entry.character : "";
  const state = typeof entry.state === "string" && entry.state ? entry.state : "";
  if (!character || !state) return null;
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : `${character}-${state}-${id}`,
    character,
    state,
    index: Number.isFinite(entry.index) ? Number(entry.index) : 0,
    item: {
      id,
      name,
      src,
      path,
      custom: item.custom === true || Boolean(path),
    },
    deletedAt: Number.isFinite(entry.deletedAt) ? Number(entry.deletedAt) : 0,
    trashPath: typeof entry.trashPath === "string" && entry.trashPath ? entry.trashPath : undefined,
  };
}

export function loadPetGifTrash(): PetGifTrashEntry[] {
  try {
    const raw = window.localStorage.getItem(PET_GIF_TRASH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortPetGifTrash(
      parsed
        .map(normalizeEntry)
        .filter((entry): entry is PetGifTrashEntry => entry !== null)
        .slice(0, PET_GIF_TRASH_LIMIT),
    );
  } catch {
    return [];
  }
}

function savePetGifTrash(entries: PetGifTrashEntry[]) {
  try {
    window.localStorage.setItem(PET_GIF_TRASH_KEY, JSON.stringify(entries));
    window.dispatchEvent(new Event(PET_GIF_TRASH_EVENT));
  } catch {
    // localStorage 不可用时保持当前会话行为。
  }
}

/** 自定义 GIF 的磁盘副本交给 Rust 复制到 pet-gifs-trash/，返回副本路径。 */
export async function parkPetGifFile(path: string): Promise<ParkedPetGif> {
  if (!isTauri()) throw new Error("Tauri");
  return invoke<ParkedPetGif>("park_pet_gif", { path });
}

/** 把副本复制回原路径（原文件已被删除）。 */
export async function restorePetGifFile(trashPath: string, targetPath: string): Promise<void> {
  if (!isTauri()) throw new Error("Tauri");
  await invoke("restore_pet_gif", { trashPath, targetPath });
}

/** 回收站条目被挤出去时，删掉它的磁盘副本，避免垃圾文件一直堆积。 */
export async function discardParkedPetGif(trashPath: string | undefined): Promise<void> {
  if (!trashPath || !isTauri()) return;
  try {
    await invoke("discard_trashed_pet_gif", { trashPath });
  } catch {
    // 清副本失败不影响删除/恢复主流程。
  }
}

/**
 * 记录一次删除。返回插入后的列表；若挤掉了最旧一条，会顺手清掉它的磁盘副本。
 */
export function recordPetGifDeletion(entry: PetGifTrashEntry): PetGifTrashEntry[] {
  const { entries, evicted } = pushPetGifTrashEntry(loadPetGifTrash(), entry);
  savePetGifTrash(entries);
  if (evicted) void discardParkedPetGif(evicted.trashPath);
  return entries;
}

export function forgetPetGifDeletion(id: string): PetGifTrashEntry[] {
  const entries = removePetGifTrashEntry(loadPetGifTrash(), id);
  savePetGifTrash(entries);
  return entries;
}