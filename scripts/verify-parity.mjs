#!/usr/bin/env node
// 功能面回归检查：确认重构前后「功能没少」。
//
// 做法：把仓库里每个能力锚定到它必须有的一组符号（组件、命令、存储键、事件名）。
// 拆文件、改路径都不影响这些锚点；真正删掉功能才会失败。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

// 汇总源码（排除生成文件，避免噪音）
const sources = new Map();
for (const name of readdirSync(srcDir)) {
  if (!/\.(ts|tsx)$/.test(name)) continue;
  sources.set(name, readFileSync(join(srcDir, name), "utf8"));
}
const scriptsDir = join(root, "scripts");
const scriptTexts = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs") || name.endsWith(".ps1"))
  .map((name) => readFileSync(join(scriptsDir, name), "utf8"))
  .join("\n");
const rustDir = join(root, "src-tauri/src");
const rust = new Map();
for (const name of readdirSync(rustDir)) {
  if (!name.endsWith(".rs")) continue;
  rust.set(name, readFileSync(join(rustDir, name), "utf8"));
}

const all = (map) => [...map.values()].join("\n");
const front = all(sources);
const back = all(rust) + "\n" + scriptTexts;

// 能力 → 锚点（任一命中即可）
const features = [
  { name: "桌宠动画与形象", anchors: ["characterFramesForState", "PET_CHARACTER_ASSETS", "petAssetUrl"] },
  { name: "GIF 轮播设置", anchors: ["PetGifRotationSettings", "maltese-gif-settings-expanded"] },
  { name: "主动聊天（含角度去重）", anchors: ["buildPrompt", "pickAngle", "isRepeated"] },
  { name: "主动程度量化", anchors: ["proactivePlan", "describeProactivePlan"] },
  { name: "聊天与思考面板", anchors: ["PetChat", "ChatReasoning", "local_chat_stream"] },
  { name: "待办与归档", anchors: ["TodoNotebook", "focusd-island-todos"] },
  { name: "剪贴板历史", anchors: ["ClipboardHistoryPanel", "clipboard_history"] },
  { name: "音乐面板与歌词", anchors: ["MusicPlayerPanel", "parseLrc"] },
  { name: "视频自动翻页", anchors: ["VideoAutomationPanel", "video_automation"] },
  { name: "快捷入口与路径校验", anchors: ["AssistantPanel", "checkShortcutPath"] },
  { name: "插件页与台球", anchors: ["PluginsPanel", "Billiards", "desktop_icons_move"] },
  { name: "固定标签到桌面", anchors: ["PinnedPanel", "pin_page_to_desktop"] },
  { name: "翻译窗口", anchors: ["TranslationWindow", "translation"] },
  { name: "消息（QQ/微信/邮箱）", anchors: ["qq_mail", "qq_notifications", "wechat_ocr"] },
  { name: "更新链路", anchors: ["make-latest-json", "prepare-release-config", "updater"] },
  { name: "前端外置协议", anchors: ["web_protocol", "register_uri_scheme_protocol", "get_pet_asset_base"] },
  { name: "打包卫生检查", anchors: ["verify-packaging"] },
];

const problems = [];
console.log("[parity] 功能面检查：");
for (const feature of features) {
  const hit = feature.anchors.filter((anchor) => front.includes(anchor) || back.includes(anchor));
  const ok = hit.length > 0;
  console.log(`  ${ok ? "✓" : "✗"} ${feature.name}${ok ? "" : `（缺少：${feature.anchors.join(" / ")}）`}`);
  if (!ok) problems.push(feature.name);
}

// 关键文件仍在
for (const path of [
  "src/App.tsx",
  "src/PetChat.tsx",
  "src/PinnedPanel.tsx",
  "src/Billiards.tsx",
  "src/proactiveChat.ts",
  "src-tauri/src/lib.rs",
  "src-tauri/src/web_protocol.rs",
  "src-tauri/src/desktop_icons.rs",
]) {
  if (!existsSync(join(root, path))) problems.push(`缺少文件 ${path}`);
}

if (problems.length > 0) {
  console.log(`\n[parity] 未通过：${problems.join("、")}`);
  process.exit(1);
}
console.log(`\n[parity] 通过：${features.length} 项功能全部在位。`);