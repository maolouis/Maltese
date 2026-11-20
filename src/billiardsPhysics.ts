export type Ball = {
  index: number;
  virtual: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pocketed: boolean;
  /** 图标格子中心到左上角的半格偏移（开局按真实格子尺寸记录） */
  halfX: number;
  halfY: number;
  /** 上一次同步给桌面的位置，用来减少消息量 */
  sentX: number;
  sentY: number;
};

export type Pocket = { x: number; y: number; r: number };
export type Turn = "you" | "dog";
export type Phase = "aiming" | "rolling" | "dog-thinking" | "cleared";

export const CUE_RADIUS = 15;
export const FRICTION = 0.988;
export const MIN_SPEED = 0.05;
export const MAX_POWER = 26;
export const WALL_BOUNCE = 0.74;
export const POCKET_RADIUS = 26;
export const CLEAR_HISTORY_KEY = "maltese-billiards-clear-history";

export type GuidePrediction = {
  points: Array<{ x: number; y: number }>;
  hitBall: Ball | null;
};

export function predictGuide(cue: { x: number; y: number }, aim: { x: number; y: number }, balls: Ball[], width: number, height: number): GuidePrediction {
  const rawX = cue.x - aim.x;
  const rawY = cue.y - aim.y;
  const rawLength = Math.hypot(rawX, rawY);
  if (rawLength < 4) return { points: [{ x: cue.x, y: cue.y }], hitBall: null };
  let direction = { x: rawX / rawLength, y: rawY / rawLength };
  let position = { x: cue.x, y: cue.y };
  const points = [position];
  let hitBall: Ball | null = null;
  const margin = CUE_RADIUS;

  for (let bounce = 0; bounce < 3; bounce += 1) {
    let wallDistance = Number.POSITIVE_INFINITY;
    let wallAxis: "x" | "y" | null = null;
    if (direction.x > 0) {
      wallDistance = (width - margin - position.x) / direction.x;
      wallAxis = "x";
    } else if (direction.x < 0) {
      wallDistance = (margin - position.x) / direction.x;
      wallAxis = "x";
    }
    if (direction.y > 0) {
      const distance = (height - margin - position.y) / direction.y;
      if (distance < wallDistance) {
        wallDistance = distance;
        wallAxis = "y";
      }
    } else if (direction.y < 0) {
      const distance = (margin - position.y) / direction.y;
      if (distance < wallDistance) {
        wallDistance = distance;
        wallAxis = "y";
      }
    }

    let ballDistance = Number.POSITIVE_INFINITY;
    let nextBall: Ball | null = null;
    for (const ball of balls) {
      if (ball.pocketed) continue;
      const offsetX = ball.x - position.x;
      const offsetY = ball.y - position.y;
      const along = offsetX * direction.x + offsetY * direction.y;
      if (along <= 0) continue;
      const perpendicular = Math.abs(offsetX * direction.y - offsetY * direction.x);
      const radius = ball.r + CUE_RADIUS + 3;
      if (perpendicular > radius) continue;
      const approach = Math.sqrt(Math.max(0, radius * radius - perpendicular * perpendicular));
      const distance = along - approach;
      if (distance > 3 && distance < ballDistance) {
        ballDistance = distance;
        nextBall = ball;
      }
    }

    if (nextBall && ballDistance < wallDistance) {
      const hit = { x: position.x + direction.x * ballDistance, y: position.y + direction.y * ballDistance };
      points.push(hit);
      hitBall = nextBall;
      break;
    }
    if (!wallAxis || !Number.isFinite(wallDistance) || wallDistance <= 0) break;
    position = { x: position.x + direction.x * wallDistance, y: position.y + direction.y * wallDistance };
    points.push(position);
    if (wallAxis === "x") direction = { x: -direction.x, y: direction.y };
    else direction = { x: direction.x, y: -direction.y };
    position = { x: position.x + direction.x * 2, y: position.y + direction.y * 2 };
    points.push(position);
  }
  if (points.length < 2) points.push({ x: cue.x + direction.x * 180, y: cue.y + direction.y * 180 });
  return { points, hitBall };
}
