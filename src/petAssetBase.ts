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

/** 内置素材统一前缀：本地存储、插件清单里都用这个形式记路径。 */
export const PET_ASSET_PREFIX = "/assets/pets/";

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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把各种历史写法还原成 `/assets/pets/` 之后的相对路径：
 *   - `/assets/pets/idle/1.gif`（当前写法，可能是百分号编码的中文名）
 *   - `\assets\pets\idle\1.gif`
 *   - `http://asset.localhost/C:%5C...%5Cresources%5Cassets%5C...gif`（旧版存下的绝对地址）
 * 认不出来就返回 null，交给调用方原样使用。
 */
export function builtinAssetRelative(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/");

  if (normalized.startsWith(PET_ASSET_PREFIX)) {
    return safeDecode(normalized.slice(PET_ASSET_PREFIX.length));
  }

  const assetMatch = normalized.match(/^(?:https?|asset):\/\/asset\.localhost\/(.*)$/i);
  if (assetMatch) {
    const decoded = safeDecode(assetMatch[1]).replace(/\\/g, "/");
    const index = decoded.indexOf(PET_ASSET_PREFIX);
    if (index >= 0) {
      return safeDecode(decoded.slice(index + PET_ASSET_PREFIX.length));
    }
  }
  return null;
}

/**
 * 把 `/assets/pets/...` 解析成 webview 能加载的 URL。
 * 传进来的是绝对文件路径（用户自选素材）时保持原样，由调用方自己 convertFileSrc。
 */
export function petAssetUrl(path: string): string {
  if (!path) return path;
  const relative = builtinAssetRelative(path);
  if (relative === null) return path;
  if (!petBase) return `${PET_ASSET_PREFIX}${relative}`;
  const separator = petBase.endsWith("\\") || petBase.endsWith("/") ? "" : "\\";
  return convertFileSrc(`${petBase}${separator}${relative.replace(/\//g, "\\")}`);
}
