export const WAKE_SHORTCUT_STORAGE_KEY = "maltese-wake-shortcut";
export const DEFAULT_WAKE_SHORTCUT = "Ctrl+Alt+Shift+M";

// 旧版本的默认值与部分输入法/截图工具冲突，启动时迁移到新的默认组合。
const LEGACY_DEFAULT_WAKE_SHORTCUT = "Ctrl+Alt+M";

export function loadWakeShortcut(): string {
  const stored = window.localStorage
    .getItem(WAKE_SHORTCUT_STORAGE_KEY)
    ?.trim();

  if (!stored || stored === LEGACY_DEFAULT_WAKE_SHORTCUT) {
    return DEFAULT_WAKE_SHORTCUT;
  }

  return stored;
}

export function saveWakeShortcut(shortcut: string) {
  window.localStorage.setItem(WAKE_SHORTCUT_STORAGE_KEY, shortcut);
}