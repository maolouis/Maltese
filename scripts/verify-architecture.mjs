#!/usr/bin/env node
// 架构规范性检查：防止单个模块继续膨胀、检查分层与循环依赖。
//
// 规则：
// 1. 单文件行数预算（超过即失败）：App.tsx 有独立的「不增长」预算，其它模块统一阈值；
// 2. 叶子模块不得反向 import App.tsx（否则形成环，拆分失去意义）；
// 3. 新拆分出来的模块必须只依赖 i18n / 类型 / store 等基础设施，依赖 App 视为违规；
// 4. 输出最大的 10 个文件，给下次拆分排序。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const problems = [];

// App.tsx 当前基线：9347 → 拆出 uiControls 后 9161。只允许持平或下降。
const APP_BUDGET = 9161;
const MODULE_BUDGET = 900; // 新拆分出来的模块不应超过 900 行
const ALLOW_APP_IMPORT = new Set(["main.tsx"]); // 只有入口可以 import App
// 已知债务：这些模块还依赖 App.tsx 里的组件，等 App 继续拆分后再清零（不允许新增）。
const KNOWN_APP_DEPENDENCIES = new Set(["PinnedPanel.tsx"]);

function lineCount(file) {
  return readFileSync(file, "utf8").split("\n").length;
}

const files = readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
  .map((entry) => ({ name: entry.name, lines: lineCount(join(srcDir, entry.name)) }))
  .sort((a, b) => b.lines - a.lines);

const app = files.find((file) => file.name === "App.tsx");
if (!app) problems.push("找不到 src/App.tsx");
else if (app.lines > APP_BUDGET) {
  problems.push(
    `App.tsx 又变大了：${app.lines} 行 > 预算 ${APP_BUDGET} 行。新功能请放到独立模块。`,
  );
}

for (const file of files) {
  if (file.name === "App.tsx") continue;
  if (file.lines > MODULE_BUDGET) {
    problems.push(`${file.name}：${file.lines} 行 > 模块预算 ${MODULE_BUDGET} 行，请继续拆分。`);
  }
}

// 叶子模块反向依赖 App（意味着拆分没有真正解耦）
for (const file of files) {
  if (ALLOW_APP_IMPORT.has(file.name) || file.name === "App.tsx") continue;
  const text = readFileSync(join(srcDir, file.name), "utf8");
  if (/from\s+"\.\/App"/.test(text) || /from\s+"\.\/App\.tsx"/.test(text)) {
    if (KNOWN_APP_DEPENDENCIES.has(file.name)) {
      console.log(`  ⚠ ${file.name} 仍依赖 App.tsx（已知债务，待 App 拆分后消除）`);
    } else {
      problems.push(`${file.name} 反向 import 了 App.tsx（循环依赖），应把共享逻辑下沉到独立模块。`);
    }
  }
}

const top = files.slice(0, 10);
console.log("[architecture] 最大的模块：");
for (const file of top) {
  const tag = file.name === "App.tsx" ? `（预算 ${APP_BUDGET}）` : file.lines > MODULE_BUDGET ? "（超标）" : "";
  console.log(`  ${String(file.lines).padStart(5)}  ${file.name} ${tag}`);
}

if (problems.length > 0) {
  console.log("\n[architecture] 未通过：");
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `\n[architecture] 通过：${files.length} 个模块，App.tsx ${app.lines} 行（≤${APP_BUDGET}），` +
    `其它模块 ≤${MODULE_BUDGET} 行，无反向依赖。`,
);