import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FONT_PRESETS,
  customFontName,
  fontStack,
  normalizeSystemFontSnapshot,
} from "../src/fontSettings.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

test("预设字体栈", () => {
  assert.equal(fontStack("default"), "inherit");
  assert.equal(fontStack(""), "inherit");
  assert.ok(fontStack("pixel").includes("Fusion Pixel"));
  assert.ok(fontStack("sans").includes("Segoe UI"));
  assert.ok(fontStack("serif").includes("serif"));
  assert.equal(FONT_PRESETS.length, 4);
});

test("自定义字体名与回退", () => {
  const stack = fontStack("华文中宋");
  assert.ok(stack.startsWith('"华文中宋"'));
  assert.ok(stack.includes("system-ui"));
  // 引号被清理，防止破坏 CSS
  assert.ok(!fontStack('bad"name').includes('bad"'));
  assert.equal(customFontName("pixel"), "");
  assert.equal(customFontName("华文中宋"), "华文中宋");
});

test("系统现用字体归一化：现用字体置顶、过滤 @ 竖排变体并去重，设置页不再要求手输字体名", () => {
  const snap = normalizeSystemFontSnapshot({
    activeFont: "Microsoft YaHei UI",
    activeVariants: ["Microsoft YaHei UI", "Segoe UI"],
    fonts: ["@Microsoft YaHei UI", "霞鹜文楷", "Microsoft YaHei UI", 'Bad"Font'],
  });
  assert.equal(snap.activeFont, "Microsoft YaHei UI");
  assert.equal(snap.fonts[0], "Microsoft YaHei UI");
  assert.ok(!snap.fonts.some((f) => f.startsWith("@")));
  assert.ok(snap.fonts.includes("霞鹜文楷"));
  assert.ok(snap.fonts.includes("BadFont"));

  const settingsWin = read("src/SettingsWindow.tsx");
  assert.match(settingsWin, /<SystemFontSelect/);
  assert.doesNotMatch(settingsWin, /placeholder="自定义字体名/);

  const rust = read("src-tauri/src/system_fonts.rs");
  assert.match(rust, /SPI_GETNONCLIENTMETRICS/);
  assert.match(rust, /EnumFontFamiliesExW/);
});
