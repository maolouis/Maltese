import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeSticker,
  extractSticker,
  isStickerId,
  STICKER_ACTION,
  STICKER_IDS,
  stickerOfMessage,
  stickerPoolOrder,
  stripStickerMarkup,
} from "../src/chatSticker.ts";

test("标记抽取：合法 id 取出并从正文移除", () => {
  const parsed = extractSticker("今天也辛苦啦 😊\n<sticker:happy>");
  assert.equal(parsed.sticker, "happy");
  assert.equal(parsed.text, "今天也辛苦啦 😊");
});

test("非法 id / 缺标记：标记被删掉、不产生表情包", () => {
  assert.deepEqual(extractSticker("嘿嘿 <sticker:banana>"), { text: "嘿嘿", sticker: null });
  assert.deepEqual(extractSticker("普通回复"), { text: "普通回复", sticker: null });
  assert.deepEqual(extractSticker(""), { text: "", sticker: null });
  // 大写与空格容错
  assert.equal(extractSticker("好耶 <STICKER: Celebrate >").sticker, "celebrate");
});

test("白名单与素材动作映射齐全，且没有写着不存在的动作", () => {
  for (const id of STICKER_IDS) {
    assert.ok(isStickerId(id));
    assert.ok(STICKER_ACTION[id], `缺少动作映射：${id}`);
  }
  assert.equal(isStickerId("banana"), false);
});

test("连续 3 条不重复同一 sticker", () => {
  assert.equal(dedupeSticker([], "happy"), "happy");
  assert.equal(dedupeSticker(["happy"], "happy"), null);
  assert.equal(dedupeSticker(["happy", "play"], "happy"), null);
  assert.equal(dedupeSticker(["happy", "play", "sleeping"], "happy"), null, "最近 3 条内去重");
  assert.equal(dedupeSticker(["happy", "play", "sleeping", "pet"], "happy"), "happy", "第 4 条前可重复");
  assert.equal(dedupeSticker([], null), null);
  assert.equal(dedupeSticker([], "banana"), null);
});

test("流式展示先隐藏未写完的标记", () => {
  assert.equal(stripStickerMarkup("好耶 <sticker:hap"), "好耶 ");
  assert.equal(stripStickerMarkup("好耶 <sticker:happy>"), "好耶 ");
});

test("旧消息兼容：没有 sticker 字段 / 非法字段都返回 null", () => {
  assert.equal(stickerOfMessage({}), null);
  assert.equal(stickerOfMessage(null), null);
  assert.equal(stickerOfMessage({ sticker: "banana" }), null);
  assert.equal(stickerOfMessage({ sticker: "sleeping" }), "sleeping");
});
test("白名单 12 个 id，且素材池顺序符合预研（stickers → 角色 → duo 回退）", () => {
  assert.equal(STICKER_IDS.length, 12);
  for (const id of ["love", "chin", "peek", "cry", "angry", "relax"]) {
    assert.ok(STICKER_IDS.includes(id), "缺少 id：" + id);
  }
  const happy = stickerPoolOrder("happy", "xiaobai");
  assert.deepEqual(happy[0], { group: "stickers", action: "happy" }, "happy 优先微博表情包池");
  const love = stickerPoolOrder("love", "xiaobai");
  assert.deepEqual(love[0], { group: "xiaobai", action: "love" }, "love 没有表情包池，走角色素材");
  const duo = stickerPoolOrder("sleeping", "duo");
  assert.deepEqual(duo.slice(-2), [
    { group: "shared", action: "sleep" },
    { group: "xiaobai", action: "sleep" },
  ]);
});
