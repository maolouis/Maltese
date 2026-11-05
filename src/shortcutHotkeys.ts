export const SHORTCUT_HOTKEYS_STORAGE_KEY = "maltese-shortcut-hotkeys";

export type ShortcutHotkeyMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadShortcutHotkeys(): ShortcutHotkeyMap {
  try {
    const raw = window.localStorage.getItem(SHORTCUT_HOTKEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const next: ShortcutHotkeyMap = {};
    for (const [path, shortcut] of Object.entries(parsed)) {
      if (typeof shortcut === "string" && path && shortcut.trim()) {
        next[path] = shortcut.trim();
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function saveShortcutHotkeys(map: ShortcutHotkeyMap) {
  try {
    window.localStorage.setItem(SHORTCUT_HOTKEYS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 写入失败
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