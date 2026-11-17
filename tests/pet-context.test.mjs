import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatVitalsContext,
  CHAT_CONTEXT_MAX_CHARS,
  describeRecentInteractions,
  formatVitalsLine,
  loadVitalsSummary,
  PET_VITALS_STORAGE_KEY,
  summarizeVitalsFrom,
  vitalsBehaviorHint,
} from "../src/petContext.ts";
import { buildPrompt, pickAngle, pickFallback } from "../src/proactiveChat.ts";

// 改动前（HEAD）同一 context 的 buildPrompt 输出：用于保证「无 vitals 时提示词逐字不变」。
const BASELINE_PROMPT = "你是住在主人电脑桌面上的线条小狗，现在主动找主人搭话。\n参考《亲爱的小狗》的设定：小白是白色马尔济斯，小鸡毛是金黄色小金毛；两只小狗是亲密的好朋狗，在四季日常里用无声默契和无条件信任互相陪伴，把幸福落在很小的事情上。\n当前是小白：安静、温柔、细心，带一点害羞和胆小；先观察主人的情绪，再轻声陪着说，不要突然说教。\n已知信息：\n- 现在时间：15:30（下午）\n- 主人正在：写代码\n\n要求：\n1. 只说一句话，12–30 个汉字，像熟人随口开口，不要客服腔、不要「您好」「很高兴为您服务」。\n2. 必须结合上面的具体信息（比如具体在做什么、坐了多久、在听什么），让人感觉你真的看见了。\n3. 可以有情绪：心疼、撒娇、好奇、调侃都行，但要有分寸，不要说教、不要连续发问。\n4. 这次的角度是「心疼主人累不累、身体舒不舒服」，只从这个角度说，别混进别的套路。\n5. 不要每次都用「记得喝水」「注意休息」这种万能句。\n6. 不要加引号、不要解释你为什么这么说。\n7. 可在正文后另起一行添加一个机器标记，格式为 [情绪:陪伴] 或 [互动:踢球]，只能从陪伴/开心/鼓励/好奇/惊讶/困倦/庆祝/倾听和踢球/招手/分身/庆祝中选择。没有合适的标记就不添加。\n\n直接输出你要说的那一句话。";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function context(extra = {}) {
  return {
    kind: "code",
    title: "",
    mediaTitle: "",
    idleSeconds: 0,
    now: new Date(2026, 10, 17, 15, 30),
    streakMinutes: 0,
    recentEvents: [],
    character: "xiaobai",
    ...extra,
  };
}

test("无 vitals 时主动提示词与旧版逐字一致（防回归）", () => {
  assert.equal(buildPrompt(context(), [], "care"), BASELINE_PROMPT);
});

test("有 vitals 时提示词包含状态摘要，且聊天上下文 ≤120 字", () => {
  const vitals = { energy: 32, mood: 78, bond: 64, focus: 20 };
  const prompt = buildPrompt(context({ vitals }), [], "care");
  assert.notEqual(prompt, BASELINE_PROMPT);
  assert.ok(prompt.includes("体力 32"), "提示词应带上体力档位");
  assert.ok(prompt.includes("心情不错"), "情绪分档要翻成人话");
  assert.ok(prompt.includes("它现在的状态"), "主动提示词里要有一行状态说明");

  const storage = memoryStorage({
    [PET_VITALS_STORAGE_KEY]: JSON.stringify({ ...vitals, updatedAt: Date.now(), lastAt: {} }),
  });
  const chatContext = buildChatVitalsContext(storage, 1_000_000);
  assert.ok(chatContext, "有状态时应生成聊天上下文");
  assert.ok(chatContext.includes("【小狗现在】"));
  assert.ok(chatContext.length <= CHAT_CONTEXT_MAX_CHARS, "上下文总长度必须 ≤120 字");
});

test("状态低/高的行为约束不同（安静撒娇 vs 更活泼）", () => {
  const tired = vitalsBehaviorHint({ energy: 20, mood: 50, bond: 50 });
  const happy = vitalsBehaviorHint({ energy: 80, mood: 85, bond: 60 });
  assert.ok(tired.includes("安静") || tired.includes("累"));
  assert.ok(happy.includes("活泼"));
  assert.notEqual(tired, happy);
});

test("近期互动来自 lastAt（3 分钟前被摸头），不含聊天正文", () => {
  const now = 10_000_000;
  const raw = {
    energy: 60, mood: 60, bond: 50, focus: 10,
    lastAt: { pet: now - 3 * 60_000, eat: now - 30_000, chat: now - 1_000 },
  };
  const list = describeRecentInteractions(raw, now);
  assert.deepEqual(list, ["刚刚和你聊过天", "刚刚被喂食", "3 分钟前被摸头"]);
  assert.ok(!list.join("").match(/[\u4e00-\u9fff]{20,}/), "不能把聊天正文塞进来");
});

test("损坏/缺字段的存储不报错、不生成上下文", () => {
  assert.equal(buildChatVitalsContext(memoryStorage()), null);
  assert.equal(buildChatVitalsContext(memoryStorage({ [PET_VITALS_STORAGE_KEY]: "not-json" })), null);
  assert.equal(buildChatVitalsContext(memoryStorage({ [PET_VITALS_STORAGE_KEY]: JSON.stringify({ energy: 50 }) })), null);
  assert.equal(summarizeVitalsFrom({ energy: 50, mood: 60 }), null);
  assert.equal(loadVitalsSummary(null), null);
  assert.equal(formatVitalsLine({ energy: 50, mood: 60, bond: 70 }).includes("体力 50"), true);
});

test("体力低时主动消息会选到「累/困/趴」类台词与安静角度", () => {
  const low = context({ vitals: { energy: 20, mood: 50, bond: 50 } });
  const line = pickFallback(low, [], "care");
  assert.ok(/困|累|趴|睡/.test(line), "低体力应优先累/困类台词，实际：" + line);
  const angle = pickAngle([], { energy: 20, mood: 50, bond: 50 });
  assert.ok(["care", "empathy", "self"].includes(angle), "低体力应选安静角度，实际：" + angle);
  // 没有 vitals 时 pickAngle 仍可能选任意角度（保持旧行为，不强制）
  assert.ok(typeof pickAngle([], null) === "string");
});