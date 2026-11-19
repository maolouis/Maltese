import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadTs(relativePath) {
  const source = ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  runInNewContext(source, {
    exports,
    require: (name) => {
      if (name.includes("@tauri-apps/api/core")) return { invoke: async () => undefined };
      throw new Error(`unexpected require: ${name}`);
    },
    console,
    Date,
    Number,
  });
  return exports;
}

const {
  diffTaskRows,
  formatTaskElapsed,
  isTerminalStage,
  taskProgressPercent,
  taskRowChanged,
} = loadTs("../src/taskProgressView.ts");
const { canInferTask } = loadTs("../src/taskProgressInference.ts");

function task(overrides = {}) {
  return {
    id: "todo-1",
    kind: "todo",
    stage: "executing",
    title: "加个待办",
    source: "frontend",
    startedAt: 1_000,
    updatedAt: 2_000,
    expectedSecs: 60,
    progress: { current: 1, total: 3 },
    detail: null,
    error: null,
    revision: 3,
    ...overrides,
  };
}

test("diffTaskRows returns only added/changed/removed rows", () => {
  const previous = [
    task(),
    task({ id: "search-1", kind: "search", title: "查资料" }),
  ];
  const next = [
    task({ stage: "done", updatedAt: 3_000, revision: 4 }),
    task({ id: "search-1", kind: "search", title: "查资料" }),
    task({ id: "agent-1", kind: "agent", title: "跑 agent" }),
  ];
  const diff = diffTaskRows(previous, next);
  assert.deepEqual([...diff.added].map((item) => item.id), ["agent-1"]);
  assert.deepEqual([...diff.changed].map((item) => item.id), ["todo-1"]);
  assert.equal(diff.removedIds.length, 0);
  assert.deepEqual([...diff.changedIds].sort(), ["agent-1", "todo-1"]);
});

test("diffTaskRows is empty when snapshot is unchanged", () => {
  const previous = [task(), task({ id: "video-1", kind: "video" })];
  const diff = diffTaskRows(previous, previous.map((item) => ({ ...item })));
  assert.equal(diff.added.length, 0);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.removedIds.length, 0);
});

test("diffTaskRows reports removed ids", () => {
  const previous = [task(), task({ id: "video-1", kind: "video" })];
  const diff = diffTaskRows(previous, [task()]);
  assert.deepEqual([...diff.removedIds], ["video-1"]);
});

test("taskRowChanged detects progress-only changes", () => {
  assert.equal(taskRowChanged(task(), task()), false);
  assert.equal(taskRowChanged(task(), task({ progress: { current: 2, total: 3 } })), true);
  assert.equal(taskRowChanged(task(), task({ stage: "waiting_confirm" })), true);
});

test("taskProgressPercent clamps and handles missing total", () => {
  assert.equal(taskProgressPercent(task({ progress: { current: 1, total: 4 } })), 25);
  assert.equal(taskProgressPercent(task({ progress: { current: 9, total: 4 } })), 100);
  assert.equal(taskProgressPercent(task({ progress: null })), null);
  assert.equal(taskProgressPercent(task({ progress: { current: 0, total: 0 } })), null);
});

test("terminal stages are detected", () => {
  for (const stage of ["done", "failed", "cancelled", "stalled"]) {
    assert.equal(isTerminalStage(stage), true);
  }
  for (const stage of ["requested", "planning", "executing", "waiting_confirm", "delivering"]) {
    assert.equal(isTerminalStage(stage), false);
  }
});

test("formatTaskElapsed renders mm:ss and h:mm:ss", () => {
  assert.equal(formatTaskElapsed(0, 5_000), "00:05");
  assert.equal(formatTaskElapsed(0, 65_000), "01:05");
  assert.equal(formatTaskElapsed(0, 3_725_000), "1:02:05");
});

test("inference throttle only runs once per 30s", () => {
  assert.equal(canInferTask(0, 1_000), true);
  assert.equal(canInferTask(10_000, 20_000), false);
  assert.equal(canInferTask(10_000, 40_000), true);
});