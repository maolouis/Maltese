import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptLinkMessage,
  createLinkGovernor,
  createLinkReceiverState,
  createPetLinkBus,
  PET_LINK_ACTION_COOLDOWN_MS,
  PET_LINK_BUBBLE_COOLDOWN_MS,
  PET_LINK_MAX_INSTANCES,
  PET_LINK_RATE_LIMIT,
  PET_LINK_STAGGER_MAX_MS,
  readCompanionLabels,
  readPetLinkageEnabled,
} from "../src/petLinkBus.ts";

const LABELS = ["companion-1", "companion-2", "companion-3", "companion-4"];

function sequenceRandom(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

// ---------------------------------------------------------------------------
// 发送端防线
// ---------------------------------------------------------------------------

test("概率为 0 时一次都不联动", () => {
  const governor = createLinkGovernor({ probability: 0, random: () => 0.99 });
  assert.deepEqual(governor.planTargets(LABELS, "pet", 1_000), []);
});

test("概率命中时随机 1–2 只，不会超过单次上限", () => {
  // 第一次 random：概率命中(0.1 < 0.6)；第二次 random 0.9 → 1 只
  const single = createLinkGovernor({ probability: 0.6, random: sequenceRandom([0.1, 0.9, 0.2, 0.3, 0.4]) });
  const one = single.planTargets(LABELS, "pet", 1_000);
  assert.equal(one.length, 1);
  assert.ok(LABELS.includes(one[0].label));

  // 第二次 random 0.1 → 2 只
  const double = createLinkGovernor({ probability: 0.6, random: sequenceRandom([0.1, 0.1, 0.5, 0.6, 0.7, 0.8]) });
  const two = double.planTargets(LABELS, "pet", 1_000);
  assert.equal(two.length, 2);
  assert.ok(two.length <= PET_LINK_MAX_INSTANCES);
});

test("错峰延迟都在 0–120ms 且第一只不延迟", () => {
  const governor = createLinkGovernor({
    probability: 1,
    random: sequenceRandom([0, 0, 0.5, 0.6, 0.7, 0.9, 0.99]),
  });
  const targets = governor.planTargets(LABELS, "pet", 1_000);
  assert.ok(targets.length >= 1);
  assert.equal(targets[0].delayMs, 0);
  for (const target of targets) {
    assert.ok(target.delayMs >= 0 && target.delayMs <= PET_LINK_STAGGER_MAX_MS);
  }
});

test("同动作 0.8s 冷却：连续两次只发一次", () => {
  const governor = createLinkGovernor({ probability: 1, random: () => 0.1 });
  assert.ok(governor.planTargets(LABELS, "pet", 1_000).length > 0);
  assert.equal(governor.planTargets(LABELS, "pet", 1_000 + PET_LINK_ACTION_COOLDOWN_MS - 1).length, 0);
  assert.ok(governor.planTargets(LABELS, "pet", 1_000 + PET_LINK_ACTION_COOLDOWN_MS).length > 0);
});

test("全局每秒最多 4 次（不同动作也不超过）", () => {
  const governor = createLinkGovernor({ probability: 1, random: () => 0.1 });
  let sent = 0;
  for (const [index, action] of ["pet", "eating", "happy", "celebrate", "pet"].entries()) {
    if (governor.planTargets(LABELS, action, 1_000 + index).length > 0) sent += 1;
  }
  assert.equal(sent, PET_LINK_RATE_LIMIT);
  // 冷却与 1 秒窗口都滑过后可以继续
  assert.ok(governor.planTargets(LABELS, "pet", 3_000).length > 0);
});

// ---------------------------------------------------------------------------
// 接收端防线
// ---------------------------------------------------------------------------

function actionMessage(overrides = {}) {
  return {
    kind: "action",
    action: "pet",
    source: "main",
    seq: 1,
    at: 1_000,
    targets: [{ label: "companion-2", delayMs: 120 }],
    bubble: true,
    ...overrides,
  };
}

test("回声抑制：自己发出的事件直接丢弃", () => {
  const state = createLinkReceiverState();
  const result = acceptLinkMessage(
    actionMessage({ source: "companion-2" }),
    state,
    { self: "companion-2", now: 1_000, enabled: true },
  );
  assert.equal(result.accept, false);
});

test("旧 seq 与非目标实例都不响应", () => {
  const state = createLinkReceiverState();
  assert.equal(
    acceptLinkMessage(actionMessage({ seq: 2 }), state, { self: "companion-2", now: 1_000 }).accept,
    true,
  );
  // 旧事件
  assert.equal(
    acceptLinkMessage(actionMessage({ seq: 1, action: "eating" }), state, { self: "companion-2", now: 1_000 })
      .accept,
    false,
  );
  // 目标里没有自己
  assert.equal(
    acceptLinkMessage(actionMessage({ seq: 5, targets: [{ label: "companion-1", delayMs: 0 }] }), state, {
      self: "companion-2",
      now: 1_000,
    }).accept,
    false,
  );
});

test("接收端同动作 0.8s 冷却与加延迟透传", () => {
  const state = createLinkReceiverState();
  const first = acceptLinkMessage(actionMessage({ seq: 1 }), state, { self: "companion-2", now: 1_000 });
  assert.equal(first.accept, true);
  assert.equal(first.delayMs, 120);
  // 同一动作 1.5s 内再来：丢弃
  assert.equal(
    acceptLinkMessage(actionMessage({ seq: 2 }), state, { self: "companion-2", now: 1_500 }).accept,
    false,
  );
  // 冷却过后可以
  assert.equal(
    acceptLinkMessage(actionMessage({ seq: 3 }), state, {
      self: "companion-2",
      now: 1_000 + PET_LINK_ACTION_COOLDOWN_MS,
    }).accept,
    true,
  );
});

test("每次联动都带气泡（气泡冷却与动作冷却一致）", () => {
  const state = createLinkReceiverState();
  const first = acceptLinkMessage(actionMessage({ seq: 1, bubble: true }), state, {
    self: "companion-2",
    now: 1_000,
  });
  assert.equal(first.accept, true);
  assert.equal(first.bubble, true);
  const second = acceptLinkMessage(actionMessage({ seq: 2, bubble: true }), state, {
    self: "companion-2",
    now: 1_000 + PET_LINK_ACTION_COOLDOWN_MS,
  });
  assert.equal(second.accept, true);
  // 增强版：气泡冷却压到与动作冷却一致（800ms），每次被接受的动作都带一句台词。
  assert.equal(second.bubble, true, "冷却与动作冷却一致，每次联动都可冒泡");
});

// ---------------------------------------------------------------------------
// 总线：开关 / 消息形态 / 发送失败不影响主链路
// ---------------------------------------------------------------------------

function fakeChannel() {
  const posted = [];
  let handler = null;
  return {
    posted,
    post: (message) => posted.push(message),
    subscribe: (next) => {
      handler = next;
      return () => undefined;
    },
    dispatch: (message) => handler?.(message),
  };
}

test("开关关闭时：动作与 Bongo 事件一律不发", () => {
  const channel = fakeChannel();
  const bus = createPetLinkBus({
    source: "main",
    channel,
    enabled: () => false,
    companionLabels: () => LABELS,
    now: () => 1_000,
    random: () => 0.99,
  });
  assert.deepEqual(bus.emitAction("pet"), []);
  bus.emitBongoHit();
  assert.equal(channel.posted.length, 0);
});

test("开启时：动作带 source/seq/targets，Bongo 事件单独一种 kind", () => {
  const channel = fakeChannel();
  const bus = createPetLinkBus({
    source: "main",
    channel,
    enabled: () => true,
    companionLabels: () => LABELS,
    now: () => 1_000,
    random: () => 0.1,
  });
  const targets = bus.emitAction("pet");
  assert.ok(targets.length >= 1);
  assert.ok(targets.length <= PET_LINK_MAX_INSTANCES);
  assert.equal(channel.posted.length, 1);
  const message = channel.posted[0];
  assert.equal(message.kind, "action");
  assert.equal(message.action, "pet");
  assert.equal(message.source, "main");
  assert.equal(message.seq, 1);
  assert.deepEqual(message.targets, targets);

  bus.emitBongoHit();
  assert.equal(channel.posted.length, 2);
  assert.equal(channel.posted[1].kind, "bongo-hit");
  assert.equal(channel.posted[1].source, "main");
});

test("开关与陪玩狗数量都从设置里读（默认开、默认 1 只）", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
  };
  assert.equal(readPetLinkageEnabled(storage), true, "没写过设置时默认开");
  assert.deepEqual(readCompanionLabels(storage), [], "默认只有主狗，没有陪玩狗");

  store.set("focusd-island-settings", JSON.stringify({ petLinkage: false, petCount: 3 }));
  assert.equal(readPetLinkageEnabled(storage), false);
  assert.deepEqual(readCompanionLabels(storage), ["companion-1", "companion-2"]);
});

console.log("pet link bus tests passed");
// ---------------------------------------------------------------------------
// 增强版：一眼看得见（首只必中 / force 预览 / Bongo 必定收到 / origin）
// ---------------------------------------------------------------------------

test("增强版：首只必触发，第二只保留 0.5 概率且最多 2 只", () => {
  // random：第一次是概率判定（默认 1.0，必过），第二次是「第二只」判定（0.1 < 0.5 → 要 2 只）
  const twoGovernor = createLinkGovernor({ random: sequenceRandom([0.1, 0.1, 0.5, 0.6, 0.7, 0.8]) });
  const two = twoGovernor.planTargets(["companion-1", "companion-2", "companion-3"], "pet", 1_000);
  assert.equal(two.length, 2);
  // 第二次概率判定之后 0.9 ≥ 0.5 → 只要 1 只（第二只按概率）
  const oneGovernor = createLinkGovernor({ random: sequenceRandom([0.1, 0.9, 0.5, 0.6, 0.7]) });
  const one = oneGovernor.planTargets(["companion-1", "companion-2"], "pet", 1_000);
  assert.equal(one.length, 1);
  assert.equal(one[0].label, "companion-1", "命中第一只时错峰为 0");
});

test("force：跳过概率与冷却，预览一次必中且只发第一只", () => {
  const governor = createLinkGovernor({ probability: 0, random: () => 0.99 });
  // 正常概率 0 → 不发
  assert.deepEqual(governor.planTargets(["companion-1"], "pet", 1_000), []);
  // force 绕过概率/冷却
  const forced = governor.planTargets(["companion-1"], "pet", 1_000, { force: true });
  assert.equal(forced.length, 1);
  assert.equal(forced[0].delayMs, 0);
  // 连点也不受冷却影响
  assert.equal(governor.planTargets(["companion-1"], "pet", 1_000, { force: true }).length, 1);
});

test("主狗 happy/celebrate 带 toBongo：Bongo 不在 targets 里也必定收到一次敲击", () => {
  const state = createLinkReceiverState();
  const message = actionMessage({
    seq: 1,
    action: "celebrate",
    targets: [{ label: "companion-1", delayMs: 0 }],
    toBongo: true,
  });
  const bongo = acceptLinkMessage(message, state, { self: "bongo-pet", now: 1_000 });
  assert.equal(bongo.accept, true);
  assert.equal(bongo.bubble, false, "Bongo 只敲击不冒泡");
  // 没有 toBongo 标记时不响应
  const state2 = createLinkReceiverState();
  const withoutFlag = acceptLinkMessage(actionMessage({ seq: 1, action: "happy" }), state2, {
    self: "bongo-pet",
    now: 1_000,
  });
  assert.equal(withoutFlag.accept, false);
});

test("消息带 origin 与必带 bubble，陪玩狗据此算位移方向", () => {
  const channel = fakeChannel();
  const bus = createPetLinkBus({
    source: "main",
    channel,
    enabled: () => true,
    companionLabels: () => ["companion-1"],
    now: () => 1_000,
    random: () => 0.99,
  });
  const targets = bus.emitAction("celebrate", {
    origin: { x: 1800, y: 1200 },
    toBongo: true,
  });
  assert.equal(targets.length, 1);
  const message = channel.posted[0];
  assert.equal(message.kind, "action");
  assert.equal(message.bubble, true, "增强版每次联动都带气泡");
  assert.equal(message.toBongo, true);
  assert.deepEqual(message.origin, { x: 1800, y: 1200 });
});

test("没有陪玩狗但 toBongo 时仍然发出消息（否则 Bongo 永远收不到）", () => {
  const channel = fakeChannel();
  const bus = createPetLinkBus({
    source: "main",
    channel,
    enabled: () => true,
    companionLabels: () => [],
    now: () => 1_000,
    random: () => 0.99,
  });
  assert.deepEqual(bus.emitAction("celebrate", { toBongo: true }), []);
  assert.equal(channel.posted.length, 1, "没有随从也要把 celebrate 发给 Bongo");
  assert.equal(channel.posted[0].toBongo, true);
  // 没有随从也没有 toBongo：不发
  assert.equal(bus.emitAction("pet").length, 0);
  assert.equal(channel.posted.length, 1);
});
