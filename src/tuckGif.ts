// 缩边 / 睡觉时用的那张 GIF。
//
// 默认跟随当前形象（小白睡觉就是小白、小鸡毛睡觉就是小鸡毛），
// 用户也可以在设置里换成自己的 GIF，路径存在 localStorage。
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export const TUCK_GIF_STORAGE_KEY = "maltese-tuck-gif";
export const TUCK_GIF_EVENT = "maltese-tuck-gif-updated";

export function loadTuckGifPath(): string {
  try {
    return window.localStorage.getItem(TUCK_GIF_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveTuckGifPath(path: string) {
  try {
    if (path) window.localStorage.setItem(TUCK_GIF_STORAGE_KEY, path);
    else window.localStorage.removeItem(TUCK_GIF_STORAGE_KEY);
    window.dispatchEvent(new Event(TUCK_GIF_EVENT));
  } catch {
    // localStorage 不可用时保持当前会话行为。
  }
}

export function useTuckGifPath(): string {
  const [path, setPath] = useState<string>(loadTuckGifPath);

  useEffect(() => {
    const update = () => setPath(loadTuckGifPath());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TUCK_GIF_STORAGE_KEY || event.key === null) update();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(TUCK_GIF_EVENT, update);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(TUCK_GIF_EVENT, update);
    };
  }, []);

  return path;
}

/** 有自定义 GIF 就用它，否则用调用方给的兜底帧。 */
export function useTuckGifSource(fallback: string): string {
  const path = useTuckGifPath();
  if (!path) return fallback;
  try {
    return convertFileSrc(path);
  } catch {
    return fallback;
  }
}
