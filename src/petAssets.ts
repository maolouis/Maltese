// 桌宠 GIF 的「最后兜底」解析：某个状态没有任何角色素材时，从清单里取一张能加载的图。
//
// 2026-11-17 去重后，旧版根级兜底素材（`assets/pets/<state>.gif` 与 `assets/pets/<state>/<n>.gif`）
// 除 `rest.gif` 外已全部删除（它们与 chars 内容完全相同），所以这里**不再维护根级路径表**，
// 统一走生成的素材清单（chars/xiaobai），保证任何状态都能拿到磁盘上真实存在的文件。

import { petAssetUrl } from "./petAssetBase";
import { characterFramePaths } from "./petCharacters";

export type PetVisualState =
  | "idle"
  | "resting"
  | "listening"
  | "working"
  | "attention"
  | "pet"
  | "eating"
  | "pickup"
  | "scared"
  | "sleeping"
  | "celebrate"
  | "happy"
  | "relax"
  | "chin"
  | "spin"
  | "play"
  | "hide"
  | "chase"
  | "peek";

/** 旧兜底里唯一保留的孤儿图：趴睡（`resting` 用）。 */
const REST_GIF = "/assets/pets/rest.gif";

/** 某状态下候选的原始路径（清单驱动，至少有一张）。 */
export function petGifCandidates(state: string): string[] {
  if (state === "resting") return [REST_GIF];
  const frames = characterFramePaths("xiaobai", state);
  if (frames.length > 0) return frames;
  // 清单里也没有这个状态：退回小白待机，保证不出现破图。
  return characterFramePaths("xiaobai", "idle");
}

export function resolvePetGif(state: string, exclude?: string): string {
  const list = petGifCandidates(state).map(petAssetUrl);
  if (list.length === 0) return petAssetUrl(REST_GIF);
  if (list.length === 1) return list[0];
  let picked = list[Math.floor(Math.random() * list.length)];
  // 尽量避免连续两次同一张图。
  let guard = 0;
  while (picked === exclude && guard < 4) {
    picked = list[Math.floor(Math.random() * list.length)];
    guard += 1;
  }
  return picked;
}