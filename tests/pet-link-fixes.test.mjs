// 双狗联动 QA 缺陷单（docs/qa-pet-linkage-2026-11-17.md）D1–D7 的回归单测。
// 纯函数为主 + 少数源码断言（防「行内注释吞掉 style 属性」这类只能靠读源码发现的回归）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildLinkPlan,
  pairHash,
  pickPairIndex,
  PET_LINK_MIN_PAIRS_PER_SCENE,
  PET_LINK_NO_REPEAT_WINDOW,
  rememberPairHash,
  resolveCompanionRoles,
  PET_LINK_HISTORY_LIMIT,
} from "../src/petLinkScript.ts";
import {
  buildPreviewPlan,
  PET_LINK_PREVIEW_LABELS,
  previewLinesByLabel,
} from "../src/petLinkPreviewPlan.ts";
import {
  companionShiftHoldMs,
  companionShiftTransition,
  COMPANION_SHIFT_FAST_MS,
  COMPANION_SHIFT_SLOW_MS,
} from "../src/petLinkCompanionStyle.ts";
import {
  createSedentaryStreak,
  noteSedentaryActivity,
  sedentaryStreakMinutes,
  SEDENTARY_STANDUP_MINUTES,
  shouldFireStandup,
} from "../src/petLinkSedentary.ts";
import { TRANSLATIONS } from "../src/i18n/index.ts";

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

function bankOf(count = 6) {
  return {
    pairs: Array.from({ length: count }, (_, index) => ({
      active: `毛${index}`,
      shy: `白${index}`,
      main: `主${index}`,
    })),
  };
}

// —— D1：petCount=1 时「试一下联动」的临时随从必须说话 ——

test("D1 预览：永远按「有随从」造剧本，petCount=1 时临时随从也说一句", () => {
  // 预览模块不再看 petCount：labels 恒为 companion-1（Rust 侧临时拉起来的就是它）。
  assert.deepEqual([...PET_LINK_PREVIEW_LABELS], ["companion-1"]);
  for (const mainCharacter of ["xiaobai", "xiaojimao", "duo"]) {
    const plan = buildPreviewPlan({ bank: bankOf(), mainCharacter, recent: [] });
    assert.ok(plan, `${mainCharacter}: 预览必须有剧本`);
    assert.equal(plan.lines.length, 1, `${mainCharacter}: 临时随从必须拿到一句台词`);
    const companion = plan.lines[0];
    assert.equal(companion.who, "companion-1");
    assert.ok(companion.line.trim(), "随从台词不能为空");
    assert.ok(plan.mainLine && plan.mainLine.trim(), "主狗也要说另一句");
    assert.notEqual(companion.speaker, plan.mainSpeaker, "两只狗不能是同一角色说同一句");
    assert.notEqual(companion.line, plan.mainLine, "两只狗的台词必须不同");
    // 主狗窗口只显示主狗那句、随从窗口只显示随从那句。
    const lines = previewLinesByLabel(plan);
    assert.deepEqual(Object.keys(lines), ["companion-1"]);
    assert.equal(lines["companion-1"].line, companion.line);
  }
});

test("D1 预览：台词库缺失也不会让随从静默（lines 为 undefined，随从退回通用台词）", () => {
  const plan = buildPreviewPlan({ bank: undefined, mainCharacter: "xiaobai", recent: [] });
  assert.equal(plan, null);
  assert.equal(previewLinesByLabel(plan), undefined);
  // 但预览仍会广播 companion-1 目标（见 petLinkPreview.ts 的 labels: PET_LINK_PREVIEW_LABELS），
  // 随从窗口 acceptLinkMessage 能收到 target，就会用 i18n 通用台词冒泡。
  const preview = read("src/petLinkPreview.ts");
  assert.match(preview, /labels:\s*\[\.\.\.PET_LINK_PREVIEW_LABELS\]/);
  assert.doesNotMatch(preview, /hasCompanion/, "旧的 petCount>1 分支已移除");
});

// —— D3：两只随从不能同角色/同台词 ——

test("D3 双随从：主狗非 duo 时两只随从角色互不相同、台词也不同", () => {
  for (const mainCharacter of ["xiaobai", "xiaojimao"]) {
    const roles = resolveCompanionRoles(["companion-1", "companion-2"], mainCharacter);
    assert.equal(new Set(roles.map((role) => role.speaker)).size, 2, `${mainCharacter}: 两只随从角色必须不同`);
    const plan = buildLinkPlan({
      action: "pet",
      labels: ["companion-1", "companion-2"],
      bank: bankOf(),
      mainCharacter,
      recent: [],
      random: () => 0,
    });
    assert.ok(plan);
    assert.equal(plan.lines.length, 2);
    assert.equal(new Set(plan.lines.map((line) => line.speaker)).size, 2, `${mainCharacter}: speaker 不能重复`);
    assert.equal(new Set(plan.lines.map((line) => line.line)).size, 2, `${mainCharacter}: 台词不能重复`);
    // 两个随从覆盖一问一答后主狗不再抢话（不会出现第三句重复）。
    assert.equal(plan.mainLine, null);
  }
});

test("D3 单随从仍然避开主狗角色（不能因为修双随从把单随从改坏）", () => {
  assert.equal(resolveCompanionRoles(["companion-1"], "xiaobai")[0].speaker, "xiaojimao");
  assert.equal(resolveCompanionRoles(["companion-1"], "xiaojimao")[0].speaker, "xiaobai");
  assert.equal(resolveCompanionRoles(["companion-1"], "duo")[0].speaker, "xiaobai");
});

// —— D4：台词库每组 ≥6 组，5 条窗口才真的能不重复 ——

test("D4 台词库：zh/en 每个场景 ≥ 去重窗口+1 组（当前 6 组）", () => {
  const scenes = ["pet", "eating", "cheerful", "bongo", "standup", "night", "welcome"];
  for (const locale of ["zh-CN", "en"]) {
    const dict = TRANSLATIONS[locale];
    for (const scene of scenes) {
      const pairs = dict.petLink.scenes[scene].pairs;
      assert.ok(
        pairs.length >= PET_LINK_MIN_PAIRS_PER_SCENE,
        `${locale}.${scene} 只有 ${pairs.length} 组，< ${PET_LINK_MIN_PAIRS_PER_SCENE}（窗口 ${PET_LINK_NO_REPEAT_WINDOW}）`,
      );
      for (const pair of pairs) {
        assert.ok(pair.active.trim() && pair.shy.trim() && pair.main.trim(), `${locale}.${scene} 台词不能有空串`);
        assert.notEqual(pair.active, pair.shy, `${locale}.${scene} 一问一答不能同句`);
      }
    }
    // zh/en 组数必须一致（i18n 键树对比也依赖这一点）。
    assert.deepEqual(
      scenes.map((scene) => dict.petLink.scenes[scene].pairs.length),
      scenes.map((scene) => TRANSLATIONS[locale].petLink.scenes[scene].pairs.length),
    );
  }
});

test("D4 去重窗口：6 组库抽 30 次，最近 5 条内 0 次重复（修复前 27/30）", () => {
  const sceneId = "pet";
  const pairsLength = 6;
  let history = [];
  let violations = 0;
  let previous = null;
  for (let draw = 0; draw < 30; draw += 1) {
    const index = pickPairIndex(pairsLength, history, sceneId, () => ((draw * 7919) % 1000) / 1000);
    assert.notEqual(index, null);
    const hash = pairHash(sceneId, index);
    if (history.slice(0, PET_LINK_NO_REPEAT_WINDOW).includes(hash)) violations += 1;
    if (previous === hash) violations += 1;
    previous = hash;
    history = rememberPairHash(history, hash, PET_LINK_HISTORY_LIMIT);
  }
  assert.equal(violations, 0, `最近 ${PET_LINK_NO_REPEAT_WINDOW} 条内重复 ${violations} 次`);
});

test("D4 去重窗口：确认为 5（文档口径），场景只有 3 组时才会退化成复读", () => {
  assert.equal(PET_LINK_NO_REPEAT_WINDOW, 5);
  assert.equal(PET_LINK_MIN_PAIRS_PER_SCENE, 6);
  const three = [0, 1, 2].map((index) => pairHash("pet", index));
  // 3 组全说过 → 只能回退到全集随机（这就是 D4 的根因，扩到 6 组后不再发生）。
  assert.notEqual(pickPairIndex(3, three, "pet", () => 0), null);
});

// —— D2：位移缓动真的生效 ——

test("D2 位移缓动：小鸡毛 260ms、小白 1200ms，且停留时长与缓动匹配", () => {
  assert.equal(COMPANION_SHIFT_FAST_MS, 260);
  assert.equal(COMPANION_SHIFT_SLOW_MS, 1200);
  const fast = companionShiftTransition("xiaojimao");
  const slow = companionShiftTransition("xiaobai");
  assert.match(fast, /^transform 260ms cubic-bezier\(/);
  assert.match(slow, /^transform 1200ms cubic-bezier\(/);
  assert.notEqual(fast, slow);
  assert.equal(companionShiftHoldMs("xiaojimao"), 520);
  assert.equal(companionShiftHoldMs("xiaobai"), 1200);
});

test("D2 源码断言：CompanionPet 的 style 里 transition 是独立属性（不再被 // 注释吞掉）", () => {
  const source = read("src/CompanionPet.tsx");
  assert.match(source, /transition:\s*`\$\{companionShiftTransition\(/, "transition 必须是真实 style 属性");
  // 回归特征：字面 \n + 行尾把 transition 吞进注释（缺陷单里的原样）。
  assert.doesNotMatch(source, /\\n\s*transition:/, "不能再出现字面 \\n 把 transition 塞进注释");
  // 被摸扁用独立的 scale，避免和位移的 transform 过渡打架。
  assert.match(read("src/DesktopExtras.css"), /\.companion-pet--squash img\s*\{[^}]*scale:/);
});

// —— D5：S5 久坐与主动聊天解耦 ——

test("D5 久坐：初值 since=0 不会误触发（修复前第一个 60s 就可能提醒）", () => {
  const streak = createSedentaryStreak();
  assert.equal(sedentaryStreakMinutes(streak, 1_700_000_000_000), 0);
  assert.equal(
    shouldFireStandup({ streak, now: 1_700_000_000_000, idleSeconds: 10, lastStandupAt: 0 }),
    false,
  );
});

test("D5 久坐：主动聊天关闭时 S5 仍然正确（只靠自己采样的活动时间戳）", () => {
  // 打开主动聊天时 tick 会刷新 proactiveStreakRef；这里完全不碰它，只喂独立 streak。
  const start = 1_700_000_000_000;
  let streak = createSedentaryStreak();
  // 第 1 次采样是「coding」，从此开始计时（不会把 1970 年当起点）。
  streak = noteSedentaryActivity(streak, "coding", start);
  streak = noteSedentaryActivity(streak, "coding", start + 60_000);
  assert.equal(sedentaryStreakMinutes(streak, start + 39 * 60_000), 39);
  assert.equal(
    shouldFireStandup({ streak, now: start + 39 * 60_000, idleSeconds: 5, lastStandupAt: 0 }),
    false,
    "39 分钟还不提醒",
  );
  assert.equal(
    shouldFireStandup({ streak, now: start + SEDENTARY_STANDUP_MINUTES * 60_000, idleSeconds: 5, lastStandupAt: 0 }),
    true,
    "满 40 分钟且人在电脑前 → 提醒",
  );
  // 静默时段 / 每小时上限只会影响主动聊天，不会让 streak 变旧或归零。
  assert.equal(sedentaryStreakMinutes(streak, start + 41 * 60_000), 41);
});

test("D5 久坐：人不在（闲置 ≥120s）不提醒；换活动类型重新计时；45 分钟冷却", () => {
  const start = 1_700_000_000_000;
  let streak = noteSedentaryActivity(createSedentaryStreak(), "coding", start);
  assert.equal(
    shouldFireStandup({ streak, now: start + 41 * 60_000, idleSeconds: 600, lastStandupAt: 0 }),
    false,
    "离开电脑不算久坐",
  );
  // 换应用 → 重新计时
  streak = noteSedentaryActivity(streak, "video", start + 41 * 60_000);
  assert.equal(sedentaryStreakMinutes(streak, start + 50 * 60_000), 9);
  assert.equal(
    shouldFireStandup({ streak, now: start + 50 * 60_000, idleSeconds: 5, lastStandupAt: 0 }),
    false,
  );
  // 满 40 分钟后提醒一次，冷却期内不再提醒
  const last = start + 81 * 60_000;
  assert.equal(shouldFireStandup({ streak, now: last, idleSeconds: 5, lastStandupAt: 0 }), true);
  assert.equal(shouldFireStandup({ streak, now: last + 44 * 60_000, idleSeconds: 5, lastStandupAt: last }), false);
  assert.equal(shouldFireStandup({ streak, now: last + 45 * 60_000, idleSeconds: 5, lastStandupAt: last }), true);
  // 空采样（拿不到前台活动）不推进、也不改基准
  assert.deepEqual(noteSedentaryActivity(streak, "", last), streak);
});

test("D5 源码断言：S5 不再读 proactiveStreakRef，改用独立 streak", () => {
  const source = read("src/App.tsx");
  assert.match(source, /import \{[\s\S]*shouldFireStandup[\s\S]*\} from "\.\/petLinkSedentary"/);
  assert.match(source, /duoStreakRef\.current = noteSedentaryActivity\(/);
  assert.match(source, /shouldFireStandup\(\{[\s\S]*?streak: duoStreakRef\.current/);
  // S5 判定不能再引用主动聊天的 ref（第 9332 行以后那段 60s 检查里）。
  const s5Block = source.slice(source.indexOf("S5 久坐 / S6 夜间 / S7 回归"));
  assert.doesNotMatch(s5Block.slice(0, 3000), /proactiveStreakRef/);
});

// —— D6 / D7：文案口径与可访问名 ——

test("D6 文案：预览说明收窄为「不改设置，仅记一条去重历史」", () => {
  assert.match(TRANSLATIONS["zh-CN"].petLink.previewHint, /不改你的设置/);
  assert.match(TRANSLATIONS["zh-CN"].petLink.previewHint, /去重历史/);
  assert.match(TRANSLATIONS.en.petLink.previewHint, /settings stay unchanged/);
  assert.match(TRANSLATIONS.en.petLink.previewHint, /line-dedupe entry/);
  const preview = read("src/petLinkPreview.ts");
  assert.doesNotMatch(preview, /不写 localStorage/);
  assert.match(preview, /maltese-pet-link-history/);
});

test("D7 随从气泡有可访问名（aria-label 带上台词原文）", () => {
  assert.equal(TRANSLATIONS["zh-CN"].petLink.bubbleAria("我也要！"), "台词：我也要！");
  assert.equal(TRANSLATIONS.en.petLink.bubbleAria("Me too!"), "Line: Me too!");
  const source = read("src/CompanionPet.tsx");
  assert.match(source, /className="companion-pet__bubble"[\s\S]{0,200}aria-label=\{t\.petLink\.bubbleAria\(bubble\)\}/);
});