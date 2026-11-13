// 桌宠素材（GIF）在安装后位于 `<安装目录>\resources\assets\pets`，
// 不再打进前端产物，所以运行时要把 `/assets/pets/...` 换成真实文件路径。
//
// 开发环境（vite dev）和浏览器里没有资源目录，base 为空时原样返回 `/assets/pets/...`，
// 由 public 目录兜底 —— 但 public 里的 pets 已经移走了，所以开发时请用
// `pnpm tauri dev`（走资源目录）或临时把 assets/pets 软链回 public。
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke, isTauri } from "@tauri-apps/api/core";

let petBase = "";
let initialized = false;

/** 启动时调用一次：拿到资源目录里的 pets 路径；失败就保持空（退回原路径）。 */
export async function initPetAssetBase(): Promise<string> {
  if (initialized) return petBase;
  initialized = true;
  if (!isTauri()) return petBase;
  try {
    petBase = await invoke<string>("get_pet_asset_base");
  } catch {
    petBase = "";
  }
  return petBase;
}

export function getPetAssetBase(): string {
  return petBase;
}

/**
 * 把 `/assets/pets/...` 解析成 webview 能加载的 URL。
 * GIF 文件名是 URL 编码过的（中文名），这里解码后再交给 convertFileSrc。
 */
export function petAssetUrl(path: string): string {
  if (!path) return path;
  if (!petBase) return path;
  if (!path.startsWith("/assets/pets/")) return path;
  const relative = path.slice("/assets/pets/".length);
  let decoded = relative;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    // 保持原样
  }
  const separator = petBase.endsWith("\\") || petBase.endsWith("/") ? "" : "\\";
  return convertFileSrc(`${petBase}${separator}${decoded.replace(/\//g, "\\")}`);
}