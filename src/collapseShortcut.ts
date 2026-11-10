// 「收起面板」全局快捷键的本机存储。
export const COLLAPSE_SHORTCUT_STORAGE_KEY = "maltese-collapse-hotkey";
export const DEFAULT_COLLAPSE_SHORTCUT = "Ctrl+Alt+Shift+C";

export function loadCollapseShortcut(): string {
  try {
    return (
      window.localStorage.getItem(COLLAPSE_SHORTCUT_STORAGE_KEY) ??
      DEFAULT_COLLAPSE_SHORTCUT
    );
  } catch {
    return DEFAULT_COLLAPSE_SHORTCUT;
  }
}

export function saveCollapseShortcut(shortcut: string) {
  try {
    window.localStorage.setItem(COLLAPSE_SHORTCUT_STORAGE_KEY, shortcut);
  } catch {
    // localStorage 不可用时保持当前会话
  }
}
