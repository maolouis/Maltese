import assert from "node:assert/strict";
import test from "node:test";
import { FONT_PRESETS, customFontName, fontStack } from "../src/fontSettings.ts";

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
