// 桌面图标台球（和线条小狗一起玩）。
//
// 玩法参考开源项目 desktop-icon-billiards（GitHub@liuxiaogang-com，MIT）：
// 把桌面图标当成球，瞄准、蓄力、松手击球，球会碰撞、滚动、入袋。
//
// Maltese 的版本刻意不真的搬动桌面图标（那需要跨进程写 explorer 的 ListView，
// 进程异常退出会把用户桌面搞乱），而是在一层透明覆盖窗口里按图标的真实屏幕位置
// 画出「球」并做物理：桌面保持原样，玩法和手感尽量接近。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import "./Billiards.css";

type DesktopIconCell = { x: number; y: number; w: number; h: number };
type DesktopIconLayout = {
  visible: boolean;
  areaX: number;
  areaY: number;
  areaW: number;
  areaH: number;
  cells: DesktopIconCell[];
  error: string | null;
};

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 对应桌面图标的格子（屏幕坐标），未入袋前用于碰撞 */
  cell: DesktopIconCell;
  pocketed: boolean;
  pocketT: number;
};

type Phase = "aiming" | "rolling" | "cleared";

const FRICTION = 0.988;
const MIN_SPEED = 0.06;
const MAX_POWER = 26;
const WALL_BOUNCE = 0.72;

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function Billiards() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [layout, setLayout] = useState<DesktopIconLayout | null>(null);
  const [phase, setPhase] = useState<Phase>("aiming");
  const [score, setScore] = useState(0);
  const [shots, setShots] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState("按住左键蓄力，松手击球；按 Esc 退出");
  const [dogMood, setDogMood] = useState<"idle" | "cheer" | "watch">("idle");

  const ballsRef = useRef<Ball[]>([]);
  const cueRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const aimRef = useRef({ active: false, x: 0, y: 0 });
  const dogRef = useRef({ x: 0, y: 0, t: 0 });
  const canvasSizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const phaseRef = useRef<Phase>("aiming");

  phaseRef.current = phase;

  const total = ballsRef.current.length;
  // layout 只用于展示「桌面 N 个图标」，让玩家知道这一局从哪来。
  const desktopIconCount = layout?.cells.length ?? 0;
  const remaining = useMemo(
    () => ballsRef.current.filter((ball) => !ball.pocketed).length,
    // ballsRef 变化不触发渲染，用 score 作为「版本号」。
    [score],
  );

  // 载入桌面图标布局，并把屏幕坐标换算成画布坐标。
  const loadLayout = useCallback(async () => {
    if (!isTauri()) {
      setNotice("需要在桌面应用里玩。");
      return;
    }
    try {
      const next = await invoke<DesktopIconLayout>("desktop_icon_layout");
      setLayout(next);
      if (!next.visible) {
        setNotice(next.error ?? "没有读到桌面图标（图标可能被隐藏了）");
        return;
      }
      // 窗口位置 = 工作区左上角，屏幕坐标减去它即为画布坐标。
      const position = await getCurrentWindow().outerPosition();
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      const width = canvas?.clientWidth ?? window.innerWidth;
      const height = canvas?.clientHeight ?? window.innerHeight;
      canvasSizeRef.current = { w: width, h: height, dpr };

      const cells = next.cells
        .map((cell) => ({
          x: cell.x - position.x,
          y: cell.y - position.y,
          w: cell.w,
          h: cell.h,
        }))
        // 只保留落在窗口里的图标
        .filter((cell) => cell.x > -60 && cell.y > -60 && cell.x < width + 60 && cell.y < height + 60);

      ballsRef.current = cells.map((cell) => ({
        x: cell.x + cell.w / 2,
        y: cell.y + cell.h / 2,
        vx: 0,
        vy: 0,
        r: Math.max(14, Math.min(cell.w, cell.h) * 0.34),
        cell,
        pocketed: false,
        pocketT: 0,
      }));
      cueRef.current = { x: width * 0.5, y: height - 120, vx: 0, vy: 0 };
      dogRef.current = { x: width * 0.5, y: height - 56, t: 0 };
      setPhase("aiming");
      setScore(0);
      setShots(0);
      setStartedAt(null);
      setElapsed(0);
      setNotice(cells.length > 0
        ? `桌面有 ${cells.length} 个图标，按住左键蓄力，松手击球`
        : "桌面上没有可玩的图标");
    } catch (error) {
      setNotice(`读取桌面图标失败：${String(error)}`);
    }
  }, []);

  useEffect(() => {
    void loadLayout();
    let unlisten: (() => void) | null = null;
    void listen("maltese-billiards-start", () => {
      void loadLayout();
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [loadLayout]);

  // 计时
  useEffect(() => {
    if (startedAt === null || phase === "cleared") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => window.clearInterval(timer);
  }, [phase, startedAt]);

  const close = useCallback(() => {
    void invoke("close_billiards_window").catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key.toLowerCase() === "r") void loadLayout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, loadLayout]);

  // 画布指针：按下蓄力，松手击球
  const pointerToCanvas = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (phaseRef.current === "rolling") return;
    const point = pointerToCanvas(event);
    aimRef.current = { active: true, x: point.x, y: point.y };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    const point = pointerToCanvas(event);
    aimRef.current = { active: true, x: point.x, y: point.y };
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    const point = pointerToCanvas(event);
    aimRef.current.active = false;
    const cue = cueRef.current;
    // 从白球往「松手位置的反方向」击出：手感像拉杆。
    const dx = cue.x - point.x;
    const dy = cue.y - point.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 12) return;
    const power = Math.min(1, distance / 260) * MAX_POWER;
    cue.vx = (dx / distance) * power;
    cue.vy = (dy / distance) * power;
    setShots((value) => value + 1);
    setStartedAt((value) => value ?? Date.now());
    setPhase("rolling");
    setDogMood("watch");
  };

  // 物理循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvasSizeRef.current = { w: width, h: height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const step = () => {
      const { w, h } = canvasSizeRef.current;
      const balls = ballsRef.current;
      const cue = cueRef.current;

      // 白球物理
      cue.x += cue.vx;
      cue.y += cue.vy;
      cue.vx *= FRICTION;
      cue.vy *= FRICTION;
      if (Math.hypot(cue.vx, cue.vy) < MIN_SPEED) {
        cue.vx = 0;
        cue.vy = 0;
      }
      // 库边反弹
      if (cue.x - 16 < 0) { cue.x = 16; cue.vx = Math.abs(cue.vx) * WALL_BOUNCE; }
      if (cue.x + 16 > w) { cue.x = w - 16; cue.vx = -Math.abs(cue.vx) * WALL_BOUNCE; }
      if (cue.y - 16 < 0) { cue.y = 16; cue.vy = Math.abs(cue.vy) * WALL_BOUNCE; }
      if (cue.y + 16 > h) { cue.y = h - 16; cue.vy = -Math.abs(cue.vy) * WALL_BOUNCE; }

      // 白球撞图标球：把图标轻轻推开（只是画出来的球，桌面图标不动）
      for (const ball of balls) {
        if (ball.pocketed) {
          ball.pocketT += 0.06;
          continue;
        }
        ball.x += ball.vx;
        ball.y += ball.vy;
        ball.vx *= FRICTION;
        ball.vy *= FRICTION;
        if (Math.hypot(ball.vx, ball.vy) < MIN_SPEED) {
          ball.vx = 0;
          ball.vy = 0;
        }
        ball.x = Math.max(ball.r, Math.min(w - ball.r, ball.x));
        ball.y = Math.max(ball.r, Math.min(h - ball.r, ball.y));

        const dx = ball.x - cue.x;
        const dy = ball.y - cue.y;
        const distance = Math.hypot(dx, dy);
        const hitDistance = ball.r + 16;
        if (distance > 0 && distance < hitDistance) {
          const nx = dx / distance;
          const ny = dy / distance;
          const speed = Math.hypot(cue.vx, cue.vy);
          // 白球被顶开，图标球获得速度
          cue.vx = -nx * speed * 0.55;
          cue.vy = -ny * speed * 0.55;
          ball.vx += nx * speed * 0.9;
          ball.vy += ny * speed * 0.9;
          if (speed > 6) {
            ball.pocketed = true;
            ball.pocketT = 0;
            setScore((value) => value + 1);
            setDogMood("cheer");
            window.setTimeout(() => setDogMood("watch"), 900);
          }
        }
      }

      // 全部停住就回到瞄准状态
      const moving =
        Math.hypot(cue.vx, cue.vy) > 0 ||
        balls.some((ball) => !ball.pocketed && Math.hypot(ball.vx, ball.vy) > 0);
      if (!moving && phaseRef.current === "rolling") {
        const left = balls.filter((ball) => !ball.pocketed).length;
        if (left === 0) {
          setPhase("cleared");
          setDogMood("cheer");
        } else {
          setPhase("aiming");
        }
      }

      // 小狗跟着白球跑
      const dog = dogRef.current;
      dog.t += 0.05;
      const targetX = cue.x + 26;
      const targetY = Math.min(h - 40, Math.max(h * 0.55, cue.y + 70));
      dog.x += (targetX - dog.x) * 0.07;
      dog.y += (targetY - dog.y) * 0.07;

      // ---------- 绘制 ----------
      context.clearRect(0, 0, w, h);

      // 图标球（桌面图标的位置）
      for (const ball of balls) {
        const alpha = ball.pocketed ? Math.max(0, 1 - ball.pocketT) : 1;
        if (alpha <= 0) continue;
        const radius = ball.r * (ball.pocketed ? Math.max(0.2, 1 - ball.pocketT) : 1);
        context.beginPath();
        context.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(96, 165, 250, ${0.20 * alpha})`;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = `rgba(147, 197, 253, ${0.85 * alpha})`;
        context.stroke();
        // 小圆点表示"这是一颗图标球"
        context.beginPath();
        context.arc(ball.x - radius * 0.28, ball.y - radius * 0.28, radius * 0.16, 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 255, 255, ${0.6 * alpha})`;
        context.fill();
      }

      // 白球
      context.beginPath();
      context.arc(cue.x, cue.y, 16, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.92)";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "rgba(148, 163, 184, 0.9)";
      context.stroke();

      // 瞄准线
      if (aimRef.current.active && phaseRef.current !== "rolling") {
        const aim = aimRef.current;
        const dx = cue.x - aim.x;
        const dy = cue.y - aim.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 4) {
          const nx = dx / distance;
          const ny = dy / distance;
          const length = Math.min(420, distance * 1.6);
          context.beginPath();
          context.setLineDash([9, 7]);
          context.moveTo(cue.x, cue.y);
          context.lineTo(cue.x + nx * length, cue.y + ny * length);
          context.strokeStyle = "rgba(250, 204, 21, 0.85)";
          context.lineWidth = 2;
          context.stroke();
          context.setLineDash([]);
          // 力度条
          const power = Math.min(1, distance / 260);
          context.fillStyle = "rgba(15, 23, 42, 0.55)";
          context.fillRect(cue.x - 40, cue.y + 26, 80, 6);
          context.fillStyle = `rgba(${Math.round(120 + power * 130)}, ${Math.round(220 - power * 120)}, 120, 0.95)`;
          context.fillRect(cue.x - 40, cue.y + 26, 80 * power, 6);
        }
      }

      // 小狗（用几个圆拼一只简笔小狗，跟着白球）
      const dogSprite = dogRef.current;
      const bob = Math.sin(dogSprite.t) * (dogMood === "cheer" ? 6 : 2);
      context.save();
      context.translate(dogSprite.x, dogSprite.y + bob);
      // 影子
      context.beginPath();
      context.ellipse(0, 16, 22, 6, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(15, 23, 42, 0.22)";
      context.fill();
      // 身体
      context.beginPath();
      context.ellipse(0, 0, 18, 13, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.95)";
      context.fill();
      context.strokeStyle = "rgba(100, 116, 139, 0.85)";
      context.lineWidth = 2;
      context.stroke();
      // 耳朵
      context.beginPath();
      context.ellipse(-12, -9, 6, 8, -0.4, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.95)";
      context.fill();
      context.stroke();
      context.beginPath();
      context.ellipse(12, -9, 6, 8, 0.4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      // 眼睛 + 鼻子
      context.beginPath();
      context.arc(-6, -1, 2, 0, Math.PI * 2);
      context.arc(6, -1, 2, 0, Math.PI * 2);
      context.fillStyle = "rgba(30, 41, 59, 0.9)";
      context.fill();
      context.beginPath();
      context.arc(0, 5, 2.4, 0, Math.PI * 2);
      context.fill();
      context.restore();

      if (dogMood === "cheer") {
        context.font = "600 15px system-ui, sans-serif";
        context.fillStyle = "rgba(250, 204, 21, 0.95)";
        context.fillText("好球！", dogSprite.x + 26, dogSprite.y - 14 + bob);
      }

      frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [dogMood]);

  const progress = total > 0 ? Math.round((score / total) * 100) : 0;

  return (
    <div className="billiards">
      <canvas
        ref={canvasRef}
        className="billiards__canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          aimRef.current.active = false;
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div className="billiards__hud">
        <span>用时 {formatTime(elapsed)}</span>
        <span>进球 {score}</span>
        <span>剩余 {remaining}</span>
        {desktopIconCount > 0 && <span>桌面 {desktopIconCount} 个图标</span>}
        <span>进度 {progress}%</span>
        <span>杆数 {shots}</span>
        <button
          type="button"
          className="billiards__btn"
          onClick={() => void loadLayout()}
          title="重新摆球（R）"
        >
          重开
        </button>
        <button type="button" className="billiards__btn" onClick={close} title="退出（Esc）">
          <X size={13} /> 退出
        </button>
      </div>
      <p className="billiards__notice">{phase === "cleared" ? `清台！用时 ${formatTime(elapsed)}，共 ${shots} 杆` : notice}</p>
      <p className="billiards__credit">
        玩法参考开源项目 desktop-icon-billiards · 作者 GitHub@liuxiaogang-com（MIT）
      </p>
    </div>
  );
}