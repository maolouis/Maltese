// 任务进度兜底推断：只在「没有命中技能」的回复之后异步跑一次，不阻塞首字。
// - 30s 内只跑一次（单槽位模型，避免每条闲聊都多一轮生成）；
// - 页面隐藏时不跑；
// - 失败/超时静默忽略，不写任何任务。
import { invoke } from "@tauri-apps/api/core";

export const TASK_INFER_LAST_KEY = "maltese-task-infer-last";
export const TASK_INFER_MIN_INTERVAL_MS = 30_000;

/** 纯函数，便于 node:test 直接测。 */
export function canInferTask(lastAt: number, now: number): boolean {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  return now - lastAt >= TASK_INFER_MIN_INTERVAL_MS;
}

export async function maybeInferTaskProgress(text: string, reply: string): Promise<void> {
  try {
    if (typeof document !== "undefined" && document.hidden) return;
    const lastAt = Number(window.localStorage.getItem(TASK_INFER_LAST_KEY) ?? 0);
    if (!canInferTask(lastAt, Date.now())) return;
    try {
      window.localStorage.setItem(TASK_INFER_LAST_KEY, String(Date.now()));
    } catch {
      // 存储不可用时仍然允许这次推断
    }
    await invoke("task_infer", { text, reply });
  } catch {
    // 兜底推断失败不影响聊天
  }
}