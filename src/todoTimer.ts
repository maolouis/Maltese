// 待办计时：只累计“开始做”的时段，暂停/完成时冻结，重新开始继续累加。
export type TodoTimerState = {
  elapsedMs?: number;
  activeSince?: number | null;
};

export function getTodoElapsedMs(todo: TodoTimerState, now: number) {
  const accumulated = Number.isFinite(todo.elapsedMs) ? Math.max(0, todo.elapsedMs ?? 0) : 0;
  const running = todo.activeSince ? Math.max(0, now - todo.activeSince) : 0;
  return accumulated + running;
}

export function formatTodoElapsed(milliseconds: number, localeTag = "zh-CN") {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const isEnglish = localeTag.toLowerCase().startsWith("en");

  if (isEnglish) {
    if (totalMinutes === 0) {
      return "<1m";
    }
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(" ");
  }

  if (days > 0) {
    return `${days}天${hours}时${minutes}分`;
  }
  if (hours > 0) {
    return `${hours}时${minutes}分`;
  }
  return totalMinutes > 0 ? `${minutes}分` : "不到1分";
}