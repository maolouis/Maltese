// 新手引导向导逻辑、状态存储与中英文词典单测。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TRANSLATIONS } from "../src/i18n/index.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

test("新手引导包含完整 6 个阶段且中英文词典一一对应", () => {
  const stepKeys = ["partner", "appearance", "gestures", "features", "system", "done"];
  for (const locale of ["zh-CN", "en"]) {
    const dict = TRANSLATIONS[locale].onboarding;
    assert.ok(dict, `${locale} missing onboarding`);
    assert.equal(typeof dict.stepBadge, "function");
    assert.ok(dict.stepBadge(1, 6).includes("1"));
    for (const key of stepKeys) {
      assert.ok(dict.steps[key]?.trim(), `${locale}.onboarding.steps.${key}`);
    }
    assert.ok(TRANSLATIONS[locale].settings.project.replayOnboarding.trim());
    assert.ok(TRANSLATIONS[locale].settings.project.replayOnboardingHint.trim());
  }
});

test("新手引导源码闸口：覆盖角色选择、外观切换、手势试玩、热键重置与设置页重开入口", () => {
  const panel = read("src/OnboardingPanel.tsx");
  assert.match(panel, /ONBOARDING_STEP_KEYS\s*=\s*\[\s*"partner",\s*"appearance",\s*"gestures",\s*"features",\s*"system",\s*"done"/);
  assert.match(panel, /savePetCharacter/);
  assert.match(panel, /DEFAULT_WAKE_SHORTCUT/);
  assert.match(panel, /set_launch_at_startup/);
  assert.match(panel, /onExploreTodo/);

  const app = read("src/App.tsx");
  assert.match(app, /onReplayOnboarding=\{openOnboardingGuide\}/);
  assert.match(app, /ONBOARDING_OPEN_EVENT/);
  assert.match(app, /isTauri\(\)\s*&&\s*!isOnboardingDone\(\)\s*\?\s*"expanded"\s*:\s*"collapsed"/);
  assert.match(app, /if\s*\(onboardingOpenRef\.current\)\s*return;/);

  const settingsWin = read("src/SettingsWindow.tsx");
  assert.match(settingsWin, /emit\("maltese-open-onboarding"\)/);
});
