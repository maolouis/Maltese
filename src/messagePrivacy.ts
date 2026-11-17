// 消息隐私：只提醒，不读取聊天内容。
//
// 2026-11-17 按 `docs/research-wechat-qq-message-source.md` 的结论移除了微信 OCR 链路。
// 旧版本有一个「读取消息内容」开关，存在 `focusd-island-wechat-read-content`；
// 新版本一律按 **false** 处理，并把这个旧键删掉（不迁移、不复活 OCR）。
//
// 新的展示开关只表示「愿不愿意看到来源 + 有新消息这类通用提示」，
// 默认关闭；即使打开，Rust 侧也不会提供任何聊天正文。

export const LEGACY_WECHAT_READ_CONTENT_KEY = "focusd-island-wechat-read-content";
export const MESSAGE_PREVIEW_KEY = "focusd-island-message-preview";

export type MessagePrivacyStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
};

/**
 * 清理旧版「读取消息内容」开关。返回是否真的删掉了旧键。
 * 无论旧值是什么（包括 `"true"`），都按关闭处理，不复活任何正文能力。
 */
export function dropLegacyWechatReadContent(storage: MessagePrivacyStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(LEGACY_WECHAT_READ_CONTENT_KEY) === null) return false;
    storage.removeItem(LEGACY_WECHAT_READ_CONTENT_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 「显示消息预览」开关：默认关；只有显式写入 `"true"` 才为开。 */
export function readMessagePreviewEnabled(storage: MessagePrivacyStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(MESSAGE_PREVIEW_KEY) === "true";
  } catch {
    return false;
  }
}

/** 写开关；非 true 一律按关闭存（避免残留旧值让预览意外打开）。 */
export function writeMessagePreviewEnabled(
  storage: (MessagePrivacyStorage & { setItem: (key: string, value: string) => void }) | null | undefined,
  enabled: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(MESSAGE_PREVIEW_KEY, enabled ? "true" : "false");
  } catch {
    // 隐私开关写不进去也不影响主流程。
  }
}