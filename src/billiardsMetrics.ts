export type ClearHistory = {
  durationsMs: number[];
};

/** 台球局面统一到 15–45 颗，真实桌面图标不足时由调用方补虚拟球。 */
export function normalizedBallCount(realCount: number): number {
  return Math.min(45, Math.max(15, Math.max(0, Math.floor(realCount))));
}

export function clearRank(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  if (seconds <= 45) return "S";
  if (seconds <= 90) return "A";
  if (seconds <= 180) return "B";
  return "C";
}

export function averageDurationMs(history: ClearHistory): number | null {
  const values = history.durationsMs.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function addClearDuration(history: ClearHistory, durationMs: number): ClearHistory {
  const next = Math.max(0, Math.round(durationMs));
  const durationsMs = [...history.durationsMs.filter((value) => Number.isFinite(value) && value > 0), next].slice(-20);
  return { durationsMs };
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}
