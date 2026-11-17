import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_BUSY_GRACE_MS,
  CHAT_MIN_REPLY_TOKENS,
  chatMaxTokens,
  chatTimeouts,
  clearChatBusy,
  describeChatError,
  isLikelyQueued,
  isTemplateRejection,
  markChatBusy,
  shouldAbortStream,
  shouldPersistReply,
  shouldSkipProactiveForChat,
} from "../src/chatGuard.ts";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("思考预算联动：max_tokens 至少是「预算 + 256」，关思考时保留用户设置", () => {
  assert.equal(chatMaxTokens(256, "off"), 256, "关思考不该被抬高");
  assert.equal(chatMaxTokens(256, "shallow"), 256 + 256);
  assert.equal(chatMaxTokens(256, "normal"), 512 + 256);
  assert.equal(chatMaxTokens(256, "deep"), 1536 + 256);
  // 用户设置本来就很大时取较大值
  assert.equal(chatMaxTokens(2048, "normal"), 2048);
  // 浅档预算 256 → 512 下限生效
  assert.equal(chatMaxTokens(32, "shallow"), CHAT_MIN_REPLY_TOKENS);
  // 异常输入不炸
  assert.equal(chatMaxTokens(Number.NaN, "off"), 256);
});

test("分级超时：首字与总时长随思考档位变化", () => {
  // 实测修正：首次 prefill 可到 16–55s，固定 8s 首字会误杀正常请求。
  assert.deepEqual(chatTimeouts("off"), { firstTokenMs: 15_000, totalMs: 180_000, idleMs: 45_000 });
  assert.deepEqual(chatTimeouts("normal"), { firstTokenMs: 25_000, totalMs: 180_000, idleMs: 45_000 });
  assert.deepEqual(chatTimeouts("deep"), { firstTokenMs: 25_000, totalMs: 180_000, idleMs: 45_000 });
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 14_000, depth: "off" }).abort, false);
  // 没有任何事件时不再中止（可能单槽位排队/加载中），只到总时长才停
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 16_000, depth: "off" }).abort, false);
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 16_000, depth: "off" }).abort, false);
  assert.equal(isLikelyQueued({ startedAt: 0, lastActivityAt: null, now: 30_000, depth: "normal" }), true);
  assert.equal(isLikelyQueued({ startedAt: 0, lastActivityAt: 10_000, now: 60_000, depth: "normal" }), false);
  // 已经开始输出（哪怕是思考流）后，不能因为「首字慢」被误杀
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 54_000, now: 55_000, depth: "normal" }).abort, false);
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 30_000, now: 76_000, depth: "normal" }).abort, true, "45s 空窗要中止");
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 170_000, now: 181_000, depth: "deep" }).abort, true, "总时长兜底");
});

test("对话优先：正在聊天或刚结束 60s 内，主动聊天让路", () => {
  const storage = memoryStorage();
  const now = 1_000_000;
  assert.equal(shouldSkipProactiveForChat(storage, now), false, "没人聊天时不影响主动聊天");
  markChatBusy(storage, now);
  assert.equal(shouldSkipProactiveForChat(storage, now + 1_000), true);
  assert.equal(shouldSkipProactiveForChat(storage, now + CHAT_BUSY_GRACE_MS - 1), true);
  assert.equal(shouldSkipProactiveForChat(storage, now + CHAT_BUSY_GRACE_MS + 1), false);
  clearChatBusy(storage);
  assert.equal(shouldSkipProactiveForChat(storage, now + 1_000), false);
  // 坏数据/空 storage 不抛
  assert.equal(shouldSkipProactiveForChat(memoryStorage({ "maltese-chat-in-progress": "oops" }), now), false);
  assert.equal(shouldSkipProactiveForChat(null, now), false);
});

test("取消或空正文不追加消息（避免空气泡/半截回复）", () => {
  assert.equal(shouldPersistReply("你好呀", false), true);
  assert.equal(shouldPersistReply("   ", false), false);
  assert.equal(shouldPersistReply("", false), false);
  assert.equal(shouldPersistReply(null, false), false);
  assert.equal(shouldPersistReply("已经生成了一半", true), false, "用户点了停止就不再写回");
});

test("发送标记可重复覆盖、清理后不残留", () => {
  const storage = memoryStorage();
  markChatBusy(storage, 10);
  markChatBusy(storage, 20);
  assert.equal(storage.getItem("maltese-chat-in-progress"), "20");
  clearChatBusy(storage);
  assert.equal(storage.getItem("maltese-chat-in-progress"), null);
  // 存储抛错也不能影响聊天
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => markChatBusy(broken, 1));
  assert.doesNotThrow(() => clearChatBusy(broken));
  assert.equal(shouldSkipProactiveForChat(broken, 1), false);
});
test("错误映射：连不上/超时/模板拒绝都有中文原因与错误码", () => {
  const down = describeChatError("连接不到本地模型服务（http://127.0.0.1:8080）");
  assert.equal(down.code, "CHAT_BACKEND_DOWN");
  assert.ok(down.message.includes("模型"));
  const timeout = describeChatError(new Error("模型 15 秒内没有任何输出，已停止。可能还在加载，稍后重试。"));
  assert.equal(timeout.code, "CHAT_TIMEOUT");
  const bad = describeChatError({ code: 400, message: "Bad Request: messages template invalid" });
  assert.equal(bad.code, "CHAT_BAD_REQUEST");
  assert.equal(isTemplateRejection({ code: 400, message: "template mismatch" }), true);
  assert.equal(isTemplateRejection("ECONNREFUSED"), false);
  const unknown = describeChatError({ weird: true });
  assert.equal(unknown.code, "CHAT_UNKNOWN");
  assert.ok(unknown.message.includes("重试"));
  assert.ok(unknown.raw.includes("weird"));
});

test("错误文案统一：加载失败 / 连不上 / 已停止 都有中文可操作原因", () => {
  const notReady = describeChatError("模型还没加载好（unloaded）");
  assert.equal(notReady.code, "CHAT_MODEL_NOT_READY");
  assert.ok(notReady.message.includes("模型没能加载"));
  const down = describeChatError("连接不到本地模型服务（http://127.0.0.1:8080/v1）");
  assert.equal(down.code, "CHAT_BACKEND_DOWN");
  assert.equal(down.message, notReady.message, "三类文案要一致");
  const stopped = describeChatError("已停止");
  assert.equal(stopped.code, "CHAT_STOPPED");
  assert.ok(stopped.message.startsWith("已停止生成"));
});
