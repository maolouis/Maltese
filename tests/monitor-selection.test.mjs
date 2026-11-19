// 多屏放置单测：指纹匹配（同名不同分辨率 / 索引变化 / 拔屏）、锚点、DPI 换算、下拉选项。

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPinnedPosition,
  clampRectToWorkArea,
  cornerRectOnMonitor,
  matchMonitor,
  monitorKey,
  pinnedDefaultPosition,
  pinnedPhysicalSize,
  resolveBongoPreference,
  resolveExtrasTargetKey,
  resolveMonitorPreference,
  resolvePinnedWorkArea,
  screenSelectOptions,
  toPhysical,
} from "../src/monitorSelection.ts";

/** 本机真实布局：DISPLAY2 2560×1440 @100% 主屏(0,0) + DISPLAY1 1920×1080 @100% 左侧副屏(-1920,0)。 */
function monitors() {
  return [
    {
      name: "\\\\.\\DISPLAY2",
      key: monitorKey("\\\\.\\DISPLAY2", 2560, 1440, 0, 0),
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
      scale: 1,
      primary: true,
    },
    {
      name: "\\\\.\\DISPLAY1",
      key: monitorKey("\\\\.\\DISPLAY1", 1920, 1080, -1920, 0),
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
      scale: 1,
      primary: false,
    },
  ];
}

test("指纹匹配：完整一致 / 换分辨率（同名） / 换位置（同几何） / 拔屏", () => {
  const list = monitors();
  // 1) 完整一致
  const exact = matchMonitor({ key: list[1].key, name: list[1].name, width: 1920, height: 1080 }, list);
  assert.equal(exact.matchedBy, "exact");
  assert.equal(exact.monitor?.name, "\\\\.\\DISPLAY1");

  // 2) 同名不同分辨率：副屏换成 1600×900，仍要认回来（靠 name）
  const changed = list.map((monitor) =>
    monitor.name === "\\\\.\\DISPLAY1" ? { ...monitor, width: 1600, height: 900, key: monitorKey(monitor.name, 1600, 900, -1920, 0) } : monitor);
  const byName = matchMonitor(
    { key: monitorKey("\\\\.\\DISPLAY1", 1920, 1080, -1920, 0), name: "\\\\.\\DISPLAY1", width: 1920, height: 1080 },
    changed,
  );
  assert.equal(byName.matchedBy, "name");
  assert.equal(byName.monitor?.width, 1600);

  // 3) 索引变化：显示器 list 顺序反过来（索引只作显示序），靠 name 仍然命中
  const reversed = [...changed].reverse();
  const byName2 = matchMonitor(
    { key: monitorKey("\\\\.\\DISPLAY1", 1920, 1080, -1920, 0), name: "\\\\.\\DISPLAY1", width: 1920, height: 1080 },
    reversed,
  );
  assert.equal(byName2.monitor?.name, "\\\\.\\DISPLAY1");

  // 4) 换接口（名字变了）但几何一致 → geometry 兜底
  const renamed = list.map((monitor) =>
    monitor.name === "\\\\.\\DISPLAY1" ? { ...monitor, name: "\\\\.\\DISPLAY3", key: monitorKey("\\\\.\\DISPLAY3", 1920, 1080, -1920, 0) } : monitor);
  const byGeometry = matchMonitor(
    { key: monitorKey("\\\\.\\DISPLAY1", 1920, 1080, -1920, 0), name: "\\\\.\\DISPLAY1", width: 1920, height: 1080, x: -1920, y: 0 },
    renamed,
  );
  assert.equal(byGeometry.matchedBy, "geometry");
  assert.equal(byGeometry.monitor?.name, "\\\\.\\DISPLAY3");

  // 5) 拔屏：副屏不在列表里 → none（调用方回主屏 + 提示）
  const unplugged = list.filter((monitor) => monitor.primary);
  const missing = matchMonitor(
    { key: monitorKey("\\\\.\\DISPLAY1", 1920, 1080, -1920, 0), name: "\\\\.\\DISPLAY1", width: 1920, height: 1080, x: -1920, y: 0 },
    unplugged,
  );
  assert.equal(missing.matchedBy, "none");
  assert.equal(missing.monitor, null);
});

test("锚点：锁角落在目标屏的工作区对应角（副屏在左时 x 为负）", () => {
  const secondaryWork = { x: -1920, y: 0, width: 1920, height: 1080 };
  const slot = { width: 259, height: 221 };
  const bottomRight = cornerRectOnMonitor(secondaryWork, "br", slot, 16);
  assert.deepEqual(bottomRight, { x: -1920 + 1920 - 259 - 16, y: 1080 - 221 - 16, width: 259, height: 221 });
  assert.ok(bottomRight.x < 0, "副屏右下角仍在负 x 区域");
  const topLeft = cornerRectOnMonitor(secondaryWork, "tl", slot, 16);
  assert.deepEqual(topLeft, { x: -1904, y: 16, width: 259, height: 221 });
  // 非法边距返回 null（调用方回默认锚点）
  assert.equal(cornerRectOnMonitor(secondaryWork, "br", slot, -1), null);
});

test("裁剪：跨屏切回主屏时旧坐标被夹进主屏工作区", () => {
  const primaryWork = { x: 0, y: 0, width: 2560, height: 1440 };
  assert.deepEqual(
    clampRectToWorkArea({ x: -1920, y: 900, width: 259, height: 221 }, primaryWork),
    { x: 0, y: 900, width: 259, height: 221 },
  );
  assert.deepEqual(
    clampRectToWorkArea({ x: 3000, y: 2000, width: 259, height: 221 }, primaryWork),
    { x: 2560 - 259, y: 1440 - 221, width: 259, height: 221 },
  );
});

test("DPI：换算用目标屏自己的 scale_factor（100% vs 150%）", () => {
  // 主屏 100%：259 逻辑 → 259 物理；副屏 150%：259 → 389（四舍五入）
  assert.equal(toPhysical(259, 1), 259);
  assert.equal(toPhysical(259, 1.5), 389);
  assert.equal(toPhysical(112, 1.25), 140);
  // 异常输入不炸
  assert.equal(toPhysical(Number.NaN, 1.5), 0);
  assert.equal(toPhysical(259, 0), 259);
  // 用错屏 scale 会出现「尺寸错位」——这条断言就是为了守住这条线：
  assert.notEqual(toPhysical(259, 1.5), toPhysical(259, 1));
});

test("下拉选项：只有一块屏时禁用；多屏时主屏在前、副屏按 x 从左到右", () => {
  const onlyOne = screenSelectOptions([monitors()[0]], { followLabel: "跟随上次位置", primaryLabel: "主屏" });
  assert.equal(onlyOne.length, 1);
  assert.equal(onlyOne[0].disabled, true);

  const many = screenSelectOptions(monitors(), { followLabel: "跟随上次位置", primaryLabel: "主屏" });
  assert.deepEqual(many.map((option) => option.value).slice(0, 2), ["last", "primary"]);
  assert.equal(many[2].value, monitors()[1].key);
  assert.match(many[2].label, /^副屏 1 · 1920×1080 @100%$/);
});

test("偏好解析：跟随上次=null、主屏=主屏指纹、副屏=指纹 key；Bongo 跟随小狗", () => {
  const list = monitors();
  assert.equal(resolveMonitorPreference("last", list, true), null);
  assert.equal(resolveMonitorPreference("primary", list, true), list[0].key);
  assert.equal(resolveMonitorPreference("primary", list, false), null);
  assert.equal(resolveMonitorPreference(list[1].key, list, true), list[1].key);
  // Bongo：跟随小狗 → 用小狗的偏好；显式选副屏 → 自己的指纹
  assert.equal(resolveBongoPreference("follow", list, list[1].key), list[1].key);
  assert.equal(resolveBongoPreference("follow", list, null), null);
  assert.equal(resolveBongoPreference(list[1].key, list, null), list[1].key);
});
// —— 「固定在桌面的标签页」(pinned) 跟随小狗屏幕 ——

test("pinned 目标屏：跟随 islandScreen 偏好的副屏；偏好为空/屏被拔 → 回主屏", () => {
  const list = monitors();
  const secondaryKey = list[1].key;
  // 跟随副屏
  const pinnedOnSecondary = resolvePinnedWorkArea(secondaryKey, list);
  assert.equal(pinnedOnSecondary?.monitor.name, "\\\\.\\DISPLAY1");
  assert.deepEqual(pinnedOnSecondary?.work, { x: -1920, y: 0, width: 1920, height: 1080 });
  // 「跟随上次位置」/空偏好 → 主屏
  assert.equal(resolvePinnedWorkArea("last", list)?.monitor.primary, true);
  assert.equal(resolvePinnedWorkArea(null, list)?.monitor.primary, true);
  // 显式主屏
  assert.equal(resolvePinnedWorkArea("primary", list)?.monitor.primary, true);
  // 副屏被拔（指纹不在列表里）→ 主屏
  assert.equal(resolvePinnedWorkArea(secondaryKey, [list[0]])?.monitor.primary, true);
  // 空列表 → null（调用方保持原位）
  assert.equal(resolvePinnedWorkArea(secondaryKey, []), null);
});

test("pinned 默认位置：目标屏右下角留 24px（副屏 x 为负也不越界）", () => {
  const secondaryWork = { x: -1920, y: 0, width: 1920, height: 1080 };
  const size = { width: 420, height: 560 };
  const position = pinnedDefaultPosition(secondaryWork, size);
  assert.deepEqual(position, { x: -1920 + 1920 - 420 - 24, y: 1080 - 560 - 24 });
  assert.ok(position.x < 0, "副屏右下角仍在负 x 区域");
  assert.ok(position.x + size.width <= 0, "整个窗口都在副屏内");
  // 工作区比窗口还小时贴左上角，不出现负坐标
  const tiny = { x: 0, y: 0, width: 300, height: 300 };
  assert.deepEqual(pinnedDefaultPosition(tiny, size), { x: 0, y: 0 });
});

test("pinned 换屏夹取：旧位置属于主屏时夹进副屏工作区，不会甩到屏外", () => {
  const secondaryWork = { x: -1920, y: 0, width: 1920, height: 1080 };
  const size = { width: 420, height: 560 };
  // 用户在主屏拖动过 (2285,1203)，切到副屏后必须夹到副屏内
  const clamped = clampPinnedPosition({ x: 2285, y: 1203 }, size, secondaryWork);
  assert.ok(clamped.x >= -1920 && clamped.x + size.width <= 0, `x 越界：${clamped.x}`);
  assert.ok(clamped.y >= 0 && clamped.y + size.height <= 1080, `y 越界：${clamped.y}`);
  assert.deepEqual(clamped, { x: -1920 + 1920 - 420, y: 1080 - 560 });
  // 已在屏内则原样保留（尊重拖动记忆）
  const inside = { x: -800, y: 200 };
  assert.deepEqual(clampPinnedPosition(inside, size, secondaryWork), inside);
});

test("pinned DPI：物理尺寸按目标屏 scale 换算（100% vs 150%）", () => {
  assert.deepEqual(pinnedPhysicalSize({ width: 420, height: 560 }, 1), { width: 420, height: 560 });
  assert.deepEqual(pinnedPhysicalSize({ width: 420, height: 560 }, 1.5), { width: 630, height: 840 });
  assert.deepEqual(pinnedPhysicalSize(undefined, 1.25), { width: 525, height: 700 });
});

test("Bongo 跟随小狗：偏好为空时跟小狗实际所在屏，不回主屏；显式偏好优先级更高", () => {
  const secondaryKey = "\\\\.\\DISPLAY1|1920x1080@-1920,0";
  // islandScreen=跟随上次位置 / 没设置 → 偏好 null，必须用小狗实际所在屏
  assert.equal(resolveExtrasTargetKey(null, null, secondaryKey), secondaryKey);
  // 显式选了「小狗屏幕」→ 用偏好指纹
  assert.equal(resolveExtrasTargetKey(null, "pref-island", secondaryKey), "pref-island");
  // Bongo 单独指定 → 优先级最高
  assert.equal(resolveExtrasTargetKey("pref-bongo", "pref-island", null), "pref-bongo");
  // 显示器枚举未就绪（全空）→ null，调用方回主屏
  assert.equal(resolveExtrasTargetKey(null, null, null), null);
});
