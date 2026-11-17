// 多屏放置单测：指纹匹配（同名不同分辨率 / 索引变化 / 拔屏）、锚点、DPI 换算、下拉选项。

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampRectToWorkArea,
  cornerRectOnMonitor,
  matchMonitor,
  monitorKey,
  resolveBongoPreference,
  resolveMonitorPreference,
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