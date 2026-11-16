import assert from "node:assert/strict";
import {
  createPetInteraction,
  inferPetEmotion,
  interactionFromAction,
  interactionFromEmotion,
  parsePetReply,
} from "../src/petInteractions.ts";

const parsed = parsePetReply("我在旁边陪你写完这一段。\n[情绪:陪伴]\n[互动:踢球]");
assert.equal(parsed.text, "我在旁边陪你写完这一段。");
assert.equal(parsed.emotion, "comfort");
assert.equal(parsed.interaction, "kick-ball");

const plain = parsePetReply("没有机器标记也应该保持原文");
assert.deepEqual(plain, { text: "没有机器标记也应该保持原文", emotion: undefined, interaction: undefined });

assert.equal(inferPetEmotion("这次完成得太棒啦", "code"), "celebrate");
assert.equal(inferPetEmotion("我在这儿陪你", "other"), "comfort");
assert.equal(interactionFromAction("chase"), "kick-ball");
assert.equal(interactionFromAction("pet"), "single-hop");
assert.equal(interactionFromEmotion("encourage"), "clone-wave");

const session = createPetInteraction({
  kind: "kick-ball",
  primary: "xiaobai",
  now: 123,
});
assert.equal(session.primary, "xiaobai");
assert.equal(session.secondary, "xiaojimao");
assert.equal(session.startedAt, 123);
assert.equal(session.kind, "kick-ball");

const single = createPetInteraction({ kind: "single-hop", primary: "xiaobai", now: 123 });
assert.equal(single.durationMs, 2400);

console.log("pet-interactions tests passed");
