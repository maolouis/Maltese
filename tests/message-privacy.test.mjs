import assert from "node:assert/strict";
import test from "node:test";
import {
  dropLegacyWechatReadContent,
  LEGACY_WECHAT_READ_CONTENT_KEY,
  MESSAGE_PREVIEW_KEY,
  readMessagePreviewEnabled,
  writeMessagePreviewEnabled,
} from "../src/messagePrivacy.ts";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

test("旧版「读取消息内容=true」按关闭处理并删除旧键", () => {
  const storage = memoryStorage({ [LEGACY_WECHAT_READ_CONTENT_KEY]: "true" });
  assert.equal(dropLegacyWechatReadContent(storage), true);
  assert.equal(storage.getItem(LEGACY_WECHAT_READ_CONTENT_KEY), null, "旧键必须被删掉");
  // 删掉之后也不存在任何「读取正文」的开关值为 true
  assert.equal(storage.getItem(MESSAGE_PREVIEW_KEY), null);
});

test("旧键不存在时什么都不做", () => {
  const storage = memoryStorage();
  assert.equal(dropLegacyWechatReadContent(storage), false);
  assert.equal(dropLegacyWechatReadContent(null), false);
  assert.equal(dropLegacyWechatReadContent(undefined), false);
});

test("存储抛错时静默返回 false，不影响启动", () => {
  const storage = {
    getItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {},
  };
  assert.equal(dropLegacyWechatReadContent(storage), false);
});

test("「显示消息预览」默认关，只有显式 true 才开", () => {
  const storage = memoryStorage();
  assert.equal(readMessagePreviewEnabled(storage), false, "没写过默认关");
  writeMessagePreviewEnabled(storage, true);
  assert.equal(readMessagePreviewEnabled(storage), true);
  writeMessagePreviewEnabled(storage, false);
  assert.equal(readMessagePreviewEnabled(storage), false);
  assert.equal(readMessagePreviewEnabled(null), false);
});

test("写开关遇到异常也不抛错", () => {
  const storage = {
    getItem: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.doesNotThrow(() => writeMessagePreviewEnabled(storage, true));
});