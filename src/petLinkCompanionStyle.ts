// 随从联动位移的缓动（纯函数：node --test 可以直接断言，防止再被行内注释吞掉）。
//
// D2：CompanionPet.tsx 的 style 里曾写成
//   `// 小鸡毛…（1200ms）。\n transition: …`
// —— `//` 吃到行尾，`transition` 整个变成注释，位移只能瞬跳。
// 现在过渡值从这里取，测试直接比对字符串，回归时单测会红。

import type { DuoSpeaker } from "./petLinkScript";

/** 小鸡毛「蹦过去」：快一点、带回弹。 */
export const COMPANION_SHIFT_FAST_MS = 260;
/** 小白「退半步再慢慢靠回」：慢一点、无回弹。 */
export const COMPANION_SHIFT_SLOW_MS = 1200;

export const COMPANION_SHIFT_FAST_EASING = "cubic-bezier(0.22, 1.2, 0.36, 1)";
export const COMPANION_SHIFT_SLOW_EASING = "cubic-bezier(0.33, 0.7, 0.4, 1)";

/** 角色 → CSS `transition` 值（小鸡毛 260ms / 小白 1200ms）。 */
export function companionShiftTransition(speaker: DuoSpeaker | string): string {
  if (speaker === "xiaojimao") {
    return `transform ${COMPANION_SHIFT_FAST_MS}ms ${COMPANION_SHIFT_FAST_EASING}`;
  }
  return `transform ${COMPANION_SHIFT_SLOW_MS}ms ${COMPANION_SHIFT_SLOW_EASING}`;
}

/** 位移停留时长：小鸡毛 520ms 蹦回去、小白 1200ms 慢慢回靠（与缓动对上）。 */
export const COMPANION_SHIFT_FAST_HOLD_MS = 520;
export const COMPANION_SHIFT_SLOW_HOLD_MS = COMPANION_SHIFT_SLOW_MS;

export function companionShiftHoldMs(speaker: DuoSpeaker | string): number {
  return speaker === "xiaojimao" ? COMPANION_SHIFT_FAST_HOLD_MS : COMPANION_SHIFT_SLOW_HOLD_MS;
}