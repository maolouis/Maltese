export const SHORTCUT_SCAN_DIR_KEY = "maltese-shortcut-scan-dir";
export const SHORTCUT_SCAN_DIR_EVENT = "maltese-shortcut-scan-dir-updated";

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
