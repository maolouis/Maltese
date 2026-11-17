// 聊天状态条（小狗自我状态）的纯逻辑：格式化、显隐、阈值跨越与节流。
//
// 只做展示与「一次灰色小提示」，不写聊天记录、不发给模型；node --test 可直接测。

export type StateVitals = {
  energy: number;
  mood: number;
  bond: number;
  focus?: number;
};

export const STATE_BAR_COLLAPSED_KEY = "maltese-pet-statebar-collapsed";
export const STATE_HINT_SHOWN_KEY = "maltese-pet-state-hint-shown";
export const STATE_NOTICE_AT_KEY = "maltese-pet-state-notice-at";
/** 灰色状态提示每 10 分钟最多一次。 */
export const STATE_NOTICE_THROTTLE_MS = 10 * 60_000;
/** 体力跌破该值算「累了」。 */
export const STATE_ENERGY_LOW = 35;
/** 情绪超过该值算「心情好」。 */
export const STATE_MOOD_HIGH = 75;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `体力 32 · 情绪 78 · 亲密 64 · 专注 20` */
export function formatStateBar(vitals: StateVitals): string {
  const parts = [
    `体力 ${clamp(vitals.energy)}`,
    `情绪 ${clamp(vitals.mood)}`,
    `亲密 ${clamp(vitals.bond)}`,
  ];
  if (typeof vitals.focus === "number" && Number.isFinite(vitals.focus)) {
    parts.push(`专注 ${clamp(vitals.focus)}`);
  }
  return parts.join(" · ");
}

/** 没有状态数据或用户关掉 vitals 时整行隐藏。 */
export function stateBarVisible(
  vitals: StateVitals | null | undefined,
  enabled = true,
): vitals is StateVitals {
  if (!enabled) return false;
  if (!vitals) return false;
  return (
    Number.isFinite(vitals.energy) &&
    Number.isFinite(vitals.mood) &&
    Number.isFinite(vitals.bond)
  );
}

/** 阈值跨越 →（可选）一条灰色提示；同一类跨越返回固定文案，便于节流与去重。 */
export function detectThresholdCross(
  previous: StateVitals | null,
  next: StateVitals | null,
  characterLabel = "小狗",
): { kind: "tired" | "happy"; text: string } | null {
  if (!next) return null;
  const label = characterLabel || "小狗";
  if (previous && previous.energy >= STATE_ENERGY_LOW && next.energy < STATE_ENERGY_LOW) {
    return { kind: "tired", text: `（${label}看起来有点累了）` };
  }
  if (previous && previous.mood <= STATE_MOOD_HIGH && next.mood > STATE_MOOD_HIGH) {
    return { kind: "happy", text: `（${label}心情不错）` };
  }
  return null;
}

/** 节流：距离上次提示不足 10 分钟就不再提示。 */
export function shouldShowNotice(
  lastNoticeAt: number | null | undefined,
  now: number,
  throttleMs: number = STATE_NOTICE_THROTTLE_MS,
): boolean {
  if (!lastNoticeAt || !Number.isFinite(lastNoticeAt)) return true;
  return now - lastNoticeAt >= throttleMs;
}

/** 折叠状态读/写（localStorage 不可用时安全降级）。 */
export function readCollapsed(storage: Pick<Storage, "getItem"> | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STATE_BAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCollapsed(storage: Pick<Storage, "setItem"> | null, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(STATE_BAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 忽略
  }
}

/** 忙碌态文案：加载/思考/等待统一说清楚，右侧显示已等待秒数。 */
export function busyStateText(busy: boolean, waitSeconds: number, thinkingOn: boolean): string {
  if (!busy) return "";
  const base = waitSeconds >= 3 ? "小狗在加载模型或思考" : thinkingOn ? "小狗正在思考" : "小狗在想";
  return waitSeconds >= 1 ? `${base}… ${waitSeconds}s` : `${base}…`;
}