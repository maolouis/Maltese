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
  isQueueing,
  isTemplateRejection,
  markChatBusy,
  shouldAbortStream,
  shouldPersistReply,
  shouldSkipProactiveForChat,
} from "../src/chatGuard.ts";

/** 与 Rust 取消登记表同名语义的小型模拟：验证「按 requestId 成对登记/取出」。 */
const cancelledIds = new Set();
function markCancelledForTest(id) { cancelledIds.add(id); }
function takeCancelledForTest(id) { return cancelledIds.delete(id); }
function isCancelledForTest(id) { return cancelledIds.has(id); }

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
  assert.deepEqual(chatTimeouts("off"), { firstTokenMs: 15_000, totalMs: 300_000, idleMs: 45_000 });
  assert.deepEqual(chatTimeouts("normal"), { firstTokenMs: 25_000, totalMs: 300_000, idleMs: 45_000 });
  assert.deepEqual(chatTimeouts("deep"), { firstTokenMs: 25_000, totalMs: 300_000, idleMs: 45_000 });
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 14_000, depth: "off" }).abort, false);
  // 没有任何事件时不再中止（可能单槽位排队/加载中），只到总时长才停
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 16_000, depth: "off" }).abort, false);
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 16_000, depth: "off" }).abort, false);
  assert.equal(isLikelyQueued({ startedAt: 0, lastActivityAt: null, now: 30_000, depth: "normal" }), true);
  assert.equal(isLikelyQueued({ startedAt: 0, lastActivityAt: 10_000, now: 60_000, depth: "normal" }), false);
  // 已经开始输出（哪怕是思考流）后，不能因为「首字慢」被误杀
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 54_000, now: 55_000, depth: "normal" }).abort, false);
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 30_000, now: 76_000, depth: "normal" }).abort, true, "45s 空窗要中止");
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 290_000, now: 301_000, depth: "deep" }).abort, true, "总时长兜底 300s");
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
  const timeout = describeChatError(new Error("已经开始输出后 45 秒没有新内容，已停止。"));
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

test("排队不中止、开始输出后空窗才生效（三态）", () => {
  // 排队 200s 仍无事件：不中止（上限 240s）
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 200_000, depth: "normal" }).abort, false);
  assert.equal(isQueueing({ startedAt: 0, lastActivityAt: null, now: 5_000, depth: "normal" }), true);
  assert.equal(isQueueing({ startedAt: 0, lastActivityAt: null, now: 1_000, depth: "normal" }), false);
  // 排队超过 240s：结束，但文案是排队（映射 CHAT_QUEUED），不是超时
  const queued = shouldAbortStream({ startedAt: 0, lastActivityAt: null, now: 245_000, depth: "normal" });
  assert.equal(queued.abort, true);
  assert.ok(queued.reason.includes("排队"));
  assert.equal(describeChatError(queued.reason).code, "CHAT_QUEUED");
  // 已开始输出：45s 空窗才中止，且映射 CHAT_TIMEOUT
  const silent = shouldAbortStream({ startedAt: 0, lastActivityAt: 100_000, now: 146_000, depth: "normal" });
  assert.equal(silent.abort, true);
  assert.ok(silent.reason.includes("输出"));
  assert.equal(describeChatError(silent.reason).code, "CHAT_TIMEOUT");
  // 已开始输出且勤快：不中止
  assert.equal(shouldAbortStream({ startedAt: 0, lastActivityAt: 140_000, now: 150_000, depth: "normal" }).abort, false);
});

test("两个聊天入口并发：各自计时/取消互不影响", () => {
  // 入口 A 排队中（无事件），入口 B 已开始输出：B 的空窗逻辑不该影响 A
  const a = { startedAt: 0, lastActivityAt: null, now: 60_000, depth: "normal" };
  const b = { startedAt: 0, lastActivityAt: 58_000, now: 60_000, depth: "normal" };
  assert.equal(shouldAbortStream(a).abort, false);
  assert.equal(shouldAbortStream(b).abort, false);
  // A 到达排队上限只结束 A；B 仍在输出
  assert.equal(shouldAbortStream({ ...a, now: 245_000 }).abort, true);
  assert.equal(shouldAbortStream({ ...b, lastActivityAt: 244_000, now: 245_000 }).abort, false);
  // 取消只按 requestId 命中：登记/取出是成对的
  const idA = "req-a";
  const idB = "req-b";
  markCancelledForTest(idA);
  assert.equal(isCancelledForTest(idB), false);
  assert.equal(takeCancelledForTest(idA), true);
  assert.equal(isCancelledForTest(idA), false, "取走后不残留");
});
