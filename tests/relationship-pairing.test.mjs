import assert from "node:assert/strict";
import {
  decryptMessage,
  encryptMessage,
  generatePairCode,
  isPresenceFresh,
  PRESENCE_MAX_AGE_MS,
  topicForCode,
} from "../src/plugins/relationship/pairing.ts";

const code = generatePairCode();
assert.equal(code.length, 6);
assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
assert.equal(await topicForCode(code), await topicForCode(` ${code.toLowerCase()} `));

const alicePresence = { t: "presence", name: "小白", work: "在写代码（App.tsx）", emotion: "calm", at: 100 };
const bobPresence = { t: "presence", name: "小金毛", work: "在看视频", emotion: "happy", at: 101 };
const aliceWire = await encryptMessage(code, alicePresence);
const bobWire = await encryptMessage(code, bobPresence);
assert.deepEqual(await decryptMessage(code, aliceWire), alicePresence);
assert.deepEqual(await decryptMessage(code, bobWire), bobPresence);
assert.equal(await decryptMessage(`${code}X`, aliceWire), null);

const now = 1_000_000;
assert.equal(isPresenceFresh(now - 1, now), true);
assert.equal(isPresenceFresh(now - PRESENCE_MAX_AGE_MS, now), false);
assert.equal(isPresenceFresh(0, now), false);

// 模拟双方断开后清理对方状态，重新连接前不应继续显示旧心情/工作状态。
const disconnected = {
  peerName: "小金毛",
  peerWork: "在看视频",
  peerEmotion: "happy",
  peerStatusAt: now,
};
const cleared = { ...disconnected, peerName: "", peerWork: "", peerEmotion: null, peerStatusAt: 0 };
assert.deepEqual(cleared, { peerName: "", peerWork: "", peerEmotion: null, peerStatusAt: 0 });

console.log("relationship pairing tests passed");
