// 任务列表的纯逻辑：类型、阶段、耗时/进度格式化、以及 1s 轮询用的「变化行」diff。
// 单独成文件便于 node:test 用 TypeScript transpile 直接测（见 tests/task-progress-view.test.mjs）。

export type TaskKind =
  | "chat"
  | "search"
  | "settings"
  | "todo"
  | "video"
  | "daily"
  | "agent"
  | "other";

export type TaskStage =
  | "requested"
  | "planning"
  | "executing"
  | "waiting_confirm"
  | "delivering"
  | "done"
  | "failed"
  | "cancelled"
  | "stalled";

export type TaskProgressCount = { current: number; total: number };

export type TaskProgress = {
  id: string;
  kind: TaskKind;
  stage: TaskStage;
  title: string;
  source: string;
  startedAt: number;
  updatedAt: number;
  expectedSecs: number;
  progress: TaskProgressCount | null;
  detail: string | null;
  error: string | null;
  revision: number;
};

export type TaskListSnapshot = {
  tasks: TaskProgress[];
  revision: number;
  now: number;
  activeCount: number;
};

export type TaskRowDiff = {
  added: TaskProgress[];
  changed: TaskProgress[];
  removedIds: string[];
  changedIds: string[];
};

export const TERMINAL_STAGES: TaskStage[] = ["done", "failed", "cancelled", "stalled"];

export function isTerminalStage(stage: TaskStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** 进度百分比：没有 progress / total<=0 返回 null（UI 显示不确定进度）。 */
export function taskProgressPercent(task: TaskProgress): number | null {
  if (!task.progress || task.progress.total <= 0) return null;
  const percent = (task.progress.current / task.progress.total) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** 固定两位的 mm:ss / h:mm:ss，避免每秒跳动时宽度变化。 */
export function formatTaskElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** 两行任务是否等价：阶段/进度/标题/错误/详情/更新时间任一变化都算变化。 */
export function taskRowChanged(previous: TaskProgress, next: TaskProgress): boolean {
  return (
    previous.stage !== next.stage ||
    previous.title !== next.title ||
    previous.detail !== next.detail ||
    previous.error !== next.error ||
    previous.updatedAt !== next.updatedAt ||
    previous.revision !== next.revision ||
    (previous.progress?.current ?? -1) !== (next.progress?.current ?? -1) ||
    (previous.progress?.total ?? -1) !== (next.progress?.total ?? -1)
  );
}

/** 1s 轮询的 diff：只返回新增/变化的行和被删掉的行，避免整表重渲染。 */
export function diffTaskRows(previous: TaskProgress[], next: TaskProgress[]): TaskRowDiff {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  const nextIds = new Set(next.map((task) => task.id));
  const added: TaskProgress[] = [];
  const changed: TaskProgress[] = [];
  for (const task of next) {
    const before = previousById.get(task.id);
    if (!before) added.push(task);
    else if (taskRowChanged(before, task)) changed.push(task);
  }
  const removedIds = previous.filter((task) => !nextIds.has(task.id)).map((task) => task.id);
  return {
    added,
    changed,
    removedIds,
    changedIds: [...added, ...changed].map((task) => task.id),
  };
}