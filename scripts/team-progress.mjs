#!/usr/bin/env node
// 团队进度看板：读取 .arts/team-progress.json，打印「任务级 + 步骤级」进度。
//
// 约定：团队模式里每个任务在 .arts/team-progress.json 里登记一条记录，
// 每完成/推进一个步骤就更新它（人和 agent 都遵守同一份结构）。
// 用法：
//   node scripts/team-progress.mjs           # 打印看板
//   node scripts/team-progress.mjs --watch   # 每 2 秒刷新（Ctrl+C 退出）
//   node scripts/team-progress.mjs --json    # 输出原始 JSON（给别的工具用）
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, ".arts", "team-progress.json");
const args = process.argv.slice(2);

if (args.includes("--json")) {
  if (!existsSync(statePath)) {
    console.log("[]");
    process.exit(0);
  }
  process.stdout.write(readFileSync(statePath, "utf8"));
  process.exit(0);
}

function readState() {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    return { error: String(error) };
  }
}

const STATUS_LABEL = {
  pending: "待开始",
  running: "进行中",
  blocked: "已阻塞",
  done: "已完成",
  failed: "失败",
};

function bar(done, total) {
  const size = 12;
  const filled = total > 0 ? Math.round((done / total) * size) : 0;
  return `${"█".repeat(filled)}${"░".repeat(size - filled)} ${done}/${total}`;
}

function minutesSince(iso) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 60000));
}

function render() {
  const state = readState();
  if (!state) {
    console.log("还没有团队进度（.arts/team-progress.json 不存在）。");
    console.log("约定见 docs/team-progress.md。");
    return;
  }
  if (state.error) {
    console.log(`进度文件解析失败：${state.error}`);
    return;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const updated = state.updatedAt ? ` · 更新于 ${state.updatedAt}` : "";
  console.log(`团队进度（${tasks.length} 个任务）${updated}\n`);

  for (const task of tasks) {
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const done = steps.filter((step) => step.status === "done").length;
    const current =
      steps.find((step) => step.status === "running") ??
      steps.find((step) => step.status === "blocked") ??
      steps.find((step) => step.status === "failed");
    const status = STATUS_LABEL[task.status] ?? task.status ?? "未知";
    const owner = task.owner ? `@${task.owner}` : "未分配";
    const age = minutesSince(task.updatedAt);
    console.log(`■ ${task.title ?? task.id}`);
    console.log(
      `  ${status} · ${owner} · ${bar(done, steps.length)}${age === null ? "" : ` · ${age} 分钟前更新`}`,
    );
    if (task.eta) console.log(`  预计：${task.eta}`);
    if (current) {
      console.log(`  当前步骤：${current.title}（${STATUS_LABEL[current.status] ?? current.status}）`);
      if (current.log) console.log(`  最近：${current.log}`);
    }
    for (const step of steps) {
      const mark = step.status === "done" ? "✓" : step.status === "running" ? "▶" : step.status === "failed" ? "✗" : "·";
      console.log(`    ${mark} ${step.title}${step.log ? ` — ${step.log}` : ""}`);
    }
    console.log("");
  }
}

render();

if (args.includes("--watch")) {
  setInterval(() => {
    console.clear();
    render();
  }, 2000);
}