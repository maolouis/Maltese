export const SHORTCUT_SCAN_DIR_KEY = "maltese-shortcut-scan-dir";
export const SHORTCUT_SCAN_DIR_EVENT = "maltese-shortcut-scan-dir-updated";
export const SHORTCUT_AUTO_DETECT_KEY = "maltese-shortcut-auto-detect";
export const SHORTCUT_AUTO_DETECT_EVENT = "maltese-shortcut-auto-detect-updated";

export function loadShortcutAutoDetect(): boolean {
  try {
    return window.localStorage.getItem(SHORTCUT_AUTO_DETECT_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveShortcutAutoDetect(enabled: boolean): boolean {
  try {
    window.localStorage.setItem(SHORTCUT_AUTO_DETECT_KEY, enabled ? "true" : "false");
  } catch {
    // 存储失败时当前会话仍使用传入值。
  }
  window.dispatchEvent(new CustomEvent(SHORTCUT_AUTO_DETECT_EVENT, { detail: enabled }));
  return enabled;
}

export function loadShortcutScanDir(): string {
  try {
    return (window.localStorage.getItem(SHORTCUT_SCAN_DIR_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function saveShortcutScanDir(value: string) {
  const next = value.trim();
  try {
    if (next) {
      window.localStorage.setItem(SHORTCUT_SCAN_DIR_KEY, next);
    } else {
      window.localStorage.removeItem(SHORTCUT_SCAN_DIR_KEY);
    }
  } catch {
    // 存储失败时仍让当前扫描使用输入值。
  }
  window.dispatchEvent(new CustomEvent(SHORTCUT_SCAN_DIR_EVENT, { detail: next }));
  return next;
}
