export const SHORTCUT_PANEL_HOTKEY_STORAGE_KEY = "maltese-shortcut-panel-hotkey";
// 旧版本给每个快捷方式分别存热键；升级后不再使用，读到就清掉。
const LEGACY_SHORTCUT_HOTKEYS_KEY = "maltese-shortcut-hotkeys";

export function loadShortcutPanelHotkey(): string {
  try {
    window.localStorage.removeItem(LEGACY_SHORTCUT_HOTKEYS_KEY);
    return window.localStorage.getItem(SHORTCUT_PANEL_HOTKEY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveShortcutPanelHotkey(shortcut: string) {
  try {
    const value = shortcut.trim();
    if (value) {
      window.localStorage.setItem(SHORTCUT_PANEL_HOTKEY_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(SHORTCUT_PANEL_HOTKEY_STORAGE_KEY);
    }
  } catch {
    // localStorage 不可用时，本次会话仍可设置热键。
  }
}

/** 把 KeyboardEvent 转成 Rust 端 parse_shortcut_binding 认识的组合键字符串。 */
export function formatShortcutFromEvent(event: KeyboardEvent): string | null {
  const modifiers = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Win",
  ].filter(Boolean) as string[];
  if (!modifiers.length) return null;

  const key = event.key;
  if (!key || ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock"].includes(key)) {
    return null;
  }
  const normalized =
    key === " "
      ? "Space"
      : key === "Escape"
        ? "Esc"
        : key.length === 1
          ? key.toUpperCase()
          : key;
  return [...modifiers, normalized].join("+");
}