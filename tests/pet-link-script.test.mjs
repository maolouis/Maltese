import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinkPlan,
  loadPetLinkHistory,
  mainSpeakerFor,
  pairHash,
  PET_LINK_NO_REPEAT_WINDOW,
  pickPairIndex,
  rememberPairHash,
  resolveCompanionRole,
  savePetLinkHistory,
  sceneIdForAction,
} from "../src/petLinkScript.ts";

function bank() {
  return {
    pairs: [
      { active: "毛一", shy: "白一", main: "主一" },
      { active: "毛二", shy: "白二", main: "主二" },
      { active: "毛三", shy: "白三", main: "主三" },
    ],
  };
}

test("场景映射：摸头/喂食/开心 对应不同桥段", () => {
  assert.equal(sceneIdForAction("pet"), "pet");
  assert.equal(sceneIdForAction("eating"), "eating");
  assert.equal(sceneIdForAction("happy"), "cheerful");
  assert.equal(sceneIdForAction("celebrate"), "cheerful");
});

test("角色身份：随从奇数=小白、偶数=小鸡毛，与主狗重复时交换", () => {
  assert.equal(resolveCompanionRole("companion-1", "xiaobai").speaker, "xiaojimao");
  assert.equal(resolveCompanionRole("companion-2", "xiaobai").speaker, "xiaojimao");
  assert.equal(resolveCompanionRole("companion-1", "xiaojimao").speaker, "xiaobai");
  assert.equal(resolveCompanionRole("companion-2", "xiaojimao").speaker, "xiaobai");
  // 主狗是 duo 时不做交换
  assert.equal(resolveCompanionRole("companion-1", "duo").speaker, "xiaobai");
  assert.equal(resolveCompanionRole("companion-2", "duo").speaker, "xiaojimao");
  assert.equal(mainSpeakerFor("xiaobai"), "xiaobai");
  assert.equal(mainSpeakerFor("xiaojimao"), "xiaojimao");
});

test("一次联动产出 ≥2 条成对台词（主狗 + 随从，来自同一组）", () => {
  const plan = buildLinkPlan({
    action: "pet",
    labels: ["companion-1"],
    bank: bank(),
    mainCharacter: "xiaobai",
    recent: [],
    random: () => 0,
  });
  assert.ok(plan, "必须产出剧本");
  // 主狗（小白）说回应句，随从（小鸡毛）说主动句
  assert.equal(plan.mainLine, "白一");
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0].line, "毛一");
  assert.equal(plan.lines[0].speaker, "xiaojimao");
  // 小鸡毛先说，主狗那句 120ms 后
  assert.equal(plan.lines[0].delayMs, 0);
  assert.equal(plan.mainDelayMs, 120);
});

test("两只随从：各说一句，主狗不再重复", () => {
  const plan = buildLinkPlan({
    action: "pet",
    labels: ["companion-1", "companion-2"],
    bank: bank(),
    mainCharacter: "duo",
    recent: [],
    random: () => 0,
  });
  assert.ok(plan);
  const speakers = plan.lines.map((line) => line.speaker).sort();
  assert.deepEqual(speakers, ["xiaobai", "xiaojimao"]);
  assert.equal(plan.mainLine, null, "两个角色都覆盖了，主狗不再抢话");
  // 成对：来自同一组（白一/毛一）
  assert.deepEqual(plan.lines.map((line) => line.line).sort(), ["白一", "毛一"].sort());
});

test("没有随从：主狗自说一句（A/B 剧本），且回退到 main 台词", () => {
  const plan = buildLinkPlan({
    action: "pet",
    labels: [],
    bank: bank(),
    mainCharacter: "xiaobai",
    recent: [],
    random: () => 0,
  });
  assert.ok(plan);
  assert.equal(plan.lines.length, 0);
  assert.equal(plan.mainLine, "白一");
});

test("台词去重：最近 5 条说过的组不再抽（滚动回退到最久未用）", () => {
  const sceneId = "pet";
  // 最近说过 0、1 两组（最多 3 组）→ 只能抽 2
  const recent = [pairHash(sceneId, 0), pairHash(sceneId, 1)];
  assert.equal(pickPairIndex(3, recent, sceneId, () => 0), 2);
  // 三组都说过了 → 回退到全部候选（取 random 决定的那组），不会返回 null
  const all = [0, 1, 2].map((index) => pairHash(sceneId, index));
  assert.notEqual(pickPairIndex(3, all, sceneId, () => 0), null);
  // 最近窗口只取前 5 条
  assert.equal(PET_LINK_NO_REPEAT_WINDOW, 5);
});

test("history：只存 hash、滚动保留最新在前、读写容错", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  let history = [];
  history = rememberPairHash(history, "pet:0");
  history = rememberPairHash(history, "pet:1");
  assert.deepEqual(history, ["pet:1", "pet:0"]);
  history = rememberPairHash(history, "pet:0");
  assert.deepEqual(history, ["pet:0", "pet:1"], "重复项要前置而不是重复存");
  savePetLinkHistory(storage, history);
  assert.deepEqual(loadPetLinkHistory(storage), ["pet:0", "pet:1"]);
  assert.deepEqual(loadPetLinkHistory(null), []);
  assert.deepEqual(loadPetLinkHistory({ getItem: () => "not-json", setItem: () => {} }), []);
});

test("force 预览：固定第一组，保证一次看到完整剧本", () => {
  const plan = buildLinkPlan({
    action: "pet",
    labels: ["companion-1"],
    bank: bank(),
    mainCharacter: "xiaojimao",
    recent: [pairHash("pet", 0), pairHash("pet", 1), pairHash("pet", 2)],
    force: true,
  });
  assert.ok(plan);
  assert.equal(plan.pairIndex, 0);
  assert.equal(plan.mainLine, "毛一");
  assert.equal(plan.lines[0]?.line, "白一");
});

test("空台词库/空名单都不会崩", () => {
  assert.equal(buildLinkPlan({ action: "pet", labels: ["companion-1"], bank: undefined, mainCharacter: "xiaobai", recent: [] }), null);
  assert.equal(buildLinkPlan({ action: "pet", labels: ["companion-1"], bank: { pairs: [] }, mainCharacter: "xiaobai", recent: [] }), null);
  assert.equal(pickPairIndex(0, [], "pet"), null);
});