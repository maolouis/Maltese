// 自定义音效：用户选的音频文件存在应用数据目录，这里只记路径并负责播放。
import { convertFileSrc } from "@tauri-apps/api/core";

export const CUSTOM_SOUND_STORAGE_KEY = "maltese-custom-sound";

export function loadCustomSoundPath(): string {
  try {
    return window.localStorage.getItem(CUSTOM_SOUND_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCustomSoundPath(path: string) {
  try {
    if (path) window.localStorage.setItem(CUSTOM_SOUND_STORAGE_KEY, path);
    else window.localStorage.removeItem(CUSTOM_SOUND_STORAGE_KEY);
    window.dispatchEvent(new Event("maltese-custom-sound-updated"));
  } catch {
    // localStorage 不可用时保持当前会话
  }
}

/** 播放自定义音效；没有配置或播放失败时返回 false，调用方回退到合成音。 */
export function playCustomSound(path = loadCustomSoundPath()): boolean {
  if (!path) return false;
  try {
    const audio = new Audio(convertFileSrc(path));
    audio.volume = 0.7;
    void audio.play().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
