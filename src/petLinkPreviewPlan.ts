// 「试一下联动」的剧本（纯函数，方便 node --test 直接单测）。
//
// D1：预览会在 500ms 内临时拉起 companion-1，所以剧本**永远按「有随从」造**：
// 那只临时随从没有真实身份，由 resolveCompanionRoles 给它一个（companion-1 → 小白，
// 主狗是小白时换成小鸡毛），主狗说另一句 —— 与用户文档「两只狗各说一句」一致。
// 之前用 `settings.petCount > 1` 判断，petCount=1 时 labels=[]，随从窗口虽然被拉起来
// 却收不到 targets（被 acceptLinkMessage 丢弃），于是「只站着不说话」。

import {
  buildLinkPlan,
  type LinkPlan,
  type SceneBank,
} from "./petLinkScript.ts";

/** 预览固定只拉这一只临时随从（Rust 侧 sync_desktop_extras 的第一个 companion 窗口）。 */
export const PET_LINK_PREVIEW_LABELS = ["companion-1"] as const;

export function buildPreviewPlan(options: {
  bank: SceneBank | undefined;
  mainCharacter: string;
  recent: string[];
}): LinkPlan | null {
  return buildLinkPlan({
    action: "pet",
    labels: [...PET_LINK_PREVIEW_LABELS],
    bank: options.bank,
    mainCharacter: options.mainCharacter,
    recent: options.recent,
    // 预览必须一次必中：固定第一组、跳过概率/冷却。
    force: true,
  });
}

/** 把剧本里「随从说的那句」整理成 bus 的 `lines`（主狗那句单独走 mainLine）。 */
export function previewLinesByLabel(
  plan: LinkPlan | null,
): Record<string, { line: string; speaker: "xiaobai" | "xiaojimao" }> | undefined {
  if (!plan) return undefined;
  return plan.lines
    .filter((line) => line.who !== "main")
    .reduce<Record<string, { line: string; speaker: "xiaobai" | "xiaojimao" }>>((acc, line) => {
      acc[line.who] = { line: line.line, speaker: line.speaker };
      return acc;
    }, {});
}