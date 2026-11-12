// 桌面图标台球（和线条小狗轮流打一杆）。
//
// 玩法参考开源项目 desktop-icon-billiards（GitHub@liuxiaogang-com，MIT）：
// 桌面图标当球、三角摆球、六个球洞、拉杆蓄力击球。
//
// Maltese 的做法：不真的移动桌面图标（跨进程写 explorer 的图标位置，进程异常
// 退出会把桌面留在乱序状态），而是在透明覆盖层里把「桌面图标数」摆成三角球阵、
// 在覆盖层里做完整物理与入袋。桌面本身保持原样。
//
// 对战规则：你打一杆 → 小狗打一杆，交替进行。小狗会调用本机模型（本地 LLM 或 DSH）
// 来决定打哪颗球、用多大力；模型不可用时退回几何最优解。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { loadLocalChatConfig } from "./localChat";
import "./Billiards.css";

type DesktopIconLayout = { visible: boolean; cells: unknown[]; error: string | null };

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  index: number;
  pocketed: boolean;
  fade: number;
};

type Pocket = { x: number; y: number; r: number };

type Turn = "you" | "dog";
type Phase = "aiming" | "rolling" | "dog-thinking" | "cleared";

const CUE_RADIUS = 15;
const FRICTION = 0.988;
const MIN_SPEED = 0.06;
const MAX_POWER = 27;
const WALL_BOUNCE = 0.74;
const POCKET_RADIUS = 24;

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 用三角形摆球：第 1 行 1 颗，第 2 行 2 颗…… */
function rackPositions(count: number, width: number, top: number, radius: number) {
  const positions: Array<{ x: number; y: number }> = [];
  const gapX = radius * 2.12;
  const gapY = radius * 1.87;
  let row = 0;
  while (positions.length < count) {
    const inRow = Math.min(row + 1, count - positions.length);
    const rowWidth = (row + inRow) / 2;
    const startX = width / 2 - (inRow - 1) * gapX / 2;
    for (let i = 0; i < inRow; i += 1) {
      positions.push({ x: startX + i * gapX, y: top + row * gapY });
    }
    row += 1;
    if (rowWidth > 8) break;
  }
  return positions;
}

export default function Billiards() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [iconCount, setIconCount] = useState(0);
  const [phase, setPhase] = useState<Phase>("aiming");
  const [turn, setTurn] = useState<Turn>("you");
  const [youScore, setYouScore] = useState(0);
  const [dogScore, setDogScore] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [tip, setTip] = useState("按住左键往后拉，松手击球");
  const [dogLine, setDogLine] = useState("");

  const ballsRef = useRef<Ball[]>([]);
  const cueRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const pocketsRef = useRef<Pocket[]>([]);
  const aimRef = useRef({ active: false, x: 0, y: 0 });
  const dogRef = useRef({ x: 0, y: 0, t: 0, happy: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const phaseRef = useRef<Phase>("aiming");
  const turnRef = useRef<Turn>("you");
  const pottedThisShot = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  phaseRef.current = phase;
  turnRef.current = turn;

  /** 重置整局：读桌面图标数，摆三角。 */
  const reset = useCallback(async () => {
    if (!isTauri()) {
      setTip("需要在桌面应用里玩。");
      return;
    }
    try {
      const layout = await invoke<DesktopIconLayout>("desktop_icon_layout");
      if (!layout.visible) {
        setTip(layout.error ?? "没有读到桌面图标（图标可能被隐藏了）");
        setIconCount(0);
        return;
      }
      const canvas = canvasRef.current;
      const width = canvas?.clientWidth ?? window.innerWidth;
      const height = canvas?.clientHeight ?? window.innerHeight;
      sizeRef.current = { w: width, h: height, dpr: window.devicePixelRatio || 1 };

      const count = Math.max(0, Math.min(45, layout.cells.length));
      setIconCount(count);
      const radius = Math.max(12, Math.min(17, width / 46));
      const positions = rackPositions(count, width, height * 0.2, radius);
      ballsRef.current = positions.map((position, index) => ({
        x: position.x,
        y: position.y,
        vx: 0,
        vy: 0,
        r: radius,
        index,
        pocketed: false,
        fade: 1,
      }));
      setRemaining(count);

      // 六洞：四角 + 两个中袋
      const inset = 10;
      pocketsRef.current = [
        { x: inset, y: inset, r: POCKET_RADIUS },
        { x: width / 2, y: inset, r: POCKET_RADIUS },
        { x: width - inset, y: inset, r: POCKET_RADIUS },
        { x: inset, y: height - inset, r: POCKET_RADIUS },
        { x: width / 2, y: height - inset, r: POCKET_RADIUS },
        { x: width - inset, y: height - inset, r: POCKET_RADIUS },
      ];

      cueRef.current = { x: width / 2, y: height - 110, vx: 0, vy: 0 };
      dogRef.current = { x: width / 2 + 60, y: height - 60, t: 0, happy: 0 };
      setYouScore(0);
      setDogScore(0);
      setTurn("you");
      setPhase("aiming");
      setDogLine("");
      setTip(count > 0 ? "按住左键往后拉，松手击球" : "桌面上没有图标可玩");
      startedAtRef.current = null;
      setElapsed(0);
    } catch (error) {
      setTip(`读取桌面图标失败：${String(error)}`);
    }
  }, []);

  useEffect(() => {
    void reset();
    let unlisten: (() => void) | null = null;
    void listen("maltese-billiards-start", () => {
      void reset();
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [reset]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (startedAtRef.current) setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void invoke("close_billiards_window").catch(() => undefined);
      if (event.key.toLowerCase() === "r") void reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reset]);

  // ---------- 小狗的一杆：让模型决定打哪颗、多大力 ----------
  const planDogShot = useCallback(async () => {
    const balls = ballsRef.current.filter((ball) => !ball.pocketed);
    const cue = cueRef.current;
    const pockets = pocketsRef.current;
    if (balls.length === 0) return null;

    // 几何兜底：挑「离洞最近、且白球能直线打到」的一颗。
    const geometric = () => {
      let best: { ball: Ball; pocket: Pocket; score: number } | null = null;
      for (const ball of balls) {
        for (const pocket of pockets) {
          const toPocket = Math.hypot(pocket.x - ball.x, pocket.y - ball.y);
          const toBall = Math.hypot(ball.x - cue.x, ball.y - cue.y);
          const score = toPocket + toBall * 0.6;
          if (!best || score < best.score) best = { ball, pocket, score };
        }
      }
      return best;
    };

    let chosenIndex: number | null = null;
    let power = 0.75;
    let comment = "";

    // 先问模型（本地 LLM / DSH），只让它挑编号和力度，物理仍由本地算。
    try {
      const config = loadLocalChatConfig();
      const pocketsText = pockets
        .map((pocket, index) => `洞${index + 1}(${Math.round(pocket.x)},${Math.round(pocket.y)})`)
        .join(" ");
      const ballsText = balls
        .slice(0, 15)
        .map((ball) => `#${ball.index}(${Math.round(ball.x)},${Math.round(ball.y)})`)
        .join(" ");
      const prompt = [
        "你在和主人打桌面台球。画面坐标：左上角(0,0)，右下角约(1600,900)。",
        `白球在(${Math.round(cue.x)},${Math.round(cue.y)})。`,
        `球洞：${pocketsText}。`,
        `剩余目标球：${ballsText}。`,
        "请选择这一杆要打的球和力度，只输出一行 JSON：{\"target\": 编号, \"power\": 0.3~1}。不要解释。",
      ].join("\n");
      let reply = "";
      if (config.backend === "local" && config.model) {
        reply = await invoke<string>("local_chat", {
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey.trim() || null,
          message: prompt,
          history: [],
          character: "xiaobai",
          images: null,
          settings: {
            maxTokens: 48,
            temperature: 0.3,
            topP: 0.9,
            enableThinking: false,
            reasoningEffort: "none",
            reasoningBudgetTokens: 0,
          },
        });
      } else {
        const answer = await invoke<{ text: string }>("dsh_chat", {
          message: prompt,
          sessionId: null,
          character: "xiaobai",
        });
        reply = answer.text;
      }
      const match = reply.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { target?: number; power?: number };
        if (typeof parsed.target === "number" && balls.some((ball) => ball.index === parsed.target)) {
          chosenIndex = parsed.target;
        }
        if (typeof parsed.power === "number") {
          power = Math.min(1, Math.max(0.3, parsed.power));
        }
      }
    } catch {
      // 模型不可用就用几何解
    }

    let targetBall = chosenIndex !== null ? balls.find((ball) => ball.index === chosenIndex) ?? null : null;
    let pocket = pockets[0];
    if (!targetBall) {
      const best = geometric();
      if (!best) return null;
      targetBall = best.ball;
      pocket = best.pocket;
    } else {
      // 模型只给了球，洞挑最近的
      pocket = pockets.reduce((closest, current) =>
        Math.hypot(current.x - targetBall!.x, current.y - targetBall!.y) <
        Math.hypot(closest.x - targetBall!.x, closest.y - targetBall!.y)
          ? current
          : closest,
      );
    }

    // 打「幽灵球」：白球要撞到目标球指向球洞的反向延长点
    const dx = pocket.x - targetBall.x;
    const dy = pocket.y - targetBall.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ghostX = targetBall.x - (dx / distance) * (targetBall.r + CUE_RADIUS);
    const ghostY = targetBall.y - (dy / distance) * (targetBall.r + CUE_RADIUS);
    const aimX = ghostX - cue.x;
    const aimY = ghostY - cue.y;
    const aimDistance = Math.hypot(aimX, aimY) || 1;
    const speed = MAX_POWER * power;
    comment = `小狗瞄准了 #${targetBall.index + 1} 号球`;
    return {
      vx: (aimX / aimDistance) * speed,
      vy: (aimY / aimDistance) * speed,
      comment,
    };
  }, []);

  const fireDogShot = useCallback(async () => {
    if (phaseRef.current === "rolling") return;
    setPhase("dog-thinking");
    setTip("小狗在想这一杆怎么打…");
    const shot = await planDogShot();
    if (!shot) {
      setPhase("aiming");
      setTurn("you");
      setTip("没有可打的球了");
      return;
    }
    setDogLine(shot.comment);
    startedAtRef.current = startedAtRef.current ?? Date.now();
    pottedThisShot.current = 0;
    cueRef.current.vx = shot.vx;
    cueRef.current.vy = shot.vy;
    setPhase("rolling");
    setDogLine("");
  }, [planDogShot]);

  // ---------- 物理 + 绘制 ----------
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
      sizeRef.current = { w: width, h: height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const step = () => {
      const { w, h } = sizeRef.current;
      const balls = ballsRef.current;
      const cue = cueRef.current;
      const pockets = pocketsRef.current;

      // 白球
      cue.x += cue.vx;
      cue.y += cue.vy;
      cue.vx *= FRICTION;
      cue.vy *= FRICTION;
      if (Math.hypot(cue.vx, cue.vy) < MIN_SPEED) {
        cue.vx = 0;
        cue.vy = 0;
      }
      if (cue.x - CUE_RADIUS < 0) { cue.x = CUE_RADIUS; cue.vx = Math.abs(cue.vx) * WALL_BOUNCE; }
      if (cue.x + CUE_RADIUS > w) { cue.x = w - CUE_RADIUS; cue.vx = -Math.abs(cue.vx) * WALL_BOUNCE; }
      if (cue.y - CUE_RADIUS < 0) { cue.y = CUE_RADIUS; cue.vy = Math.abs(cue.vy) * WALL_BOUNCE; }
      if (cue.y + CUE_RADIUS > h) { cue.y = h - CUE_RADIUS; cue.vy = -Math.abs(cue.vy) * WALL_BOUNCE; }

      // 白球落袋：回到开球点，不算分
      for (const pocket of pockets) {
        if (Math.hypot(cue.x - pocket.x, cue.y - pocket.y) < pocket.r) {
          cue.x = w / 2;
          cue.y = h - 110;
          cue.vx = 0;
          cue.vy = 0;
          pottedThisShot.current += 100; // 标记本杆有犯规，不计分
        }
      }

      // 目标球
      for (const ball of balls) {
        if (ball.pocketed) {
          ball.fade = Math.max(0, ball.fade - 0.04);
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
        if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx) * WALL_BOUNCE; }
        if (ball.x + ball.r > w) { ball.x = w - ball.r; ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE; }
        if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy) * WALL_BOUNCE; }
        if (ball.y + ball.r > h) { ball.y = h - ball.r; ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE; }

        // 落袋
        for (const pocket of pockets) {
          if (Math.hypot(ball.x - pocket.x, ball.y - pocket.y) < pocket.r) {
            ball.pocketed = true;
            pottedThisShot.current += 1;
            break;
          }
        }
      }

      // 白球撞目标球
      for (const ball of balls) {
        if (ball.pocketed) continue;
        const dx = ball.x - cue.x;
        const dy = ball.y - cue.y;
        const distance = Math.hypot(dx, dy);
        const minDistance = ball.r + CUE_RADIUS;
        if (distance > 0 && distance < minDistance) {
          const nx = dx / distance;
          const ny = dy / distance;
          const speed = Math.hypot(cue.vx, cue.vy);
          const overlap = minDistance - distance;
          ball.x += nx * overlap;
          ball.y += ny * overlap;
          cue.vx = -nx * speed * 0.42;
          cue.vy = -ny * speed * 0.42;
          ball.vx += nx * speed * 0.85;
          ball.vy += ny * speed * 0.85;
        }
      }

      // 球与球
      for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i];
        if (a.pocketed) continue;
        for (let j = i + 1; j < balls.length; j += 1) {
          const b = balls[j];
          if (b.pocketed) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy);
          const minDistance = a.r + b.r;
          if (distance > 0 && distance < minDistance) {
            const nx = dx / distance;
            const ny = dy / distance;
            const overlap = (minDistance - distance) / 2;
            a.x -= nx * overlap;
            a.y -= ny * overlap;
            b.x += nx * overlap;
            b.y += ny * overlap;
            const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (relative < 0) continue;
            const impulse = relative * 0.78;
            a.vx += nx * impulse;
            a.vy += ny * impulse;
            b.vx -= nx * impulse;
            b.vy -= ny * impulse;
          }
        }
      }

      // 停止 → 结算
      const moving =
        Math.hypot(cue.vx, cue.vy) > 0 ||
        balls.some((ball) => !ball.pocketed && Math.hypot(ball.vx, ball.vy) > 0);
      if (!moving && phaseRef.current === "rolling") {
        const potted = pottedThisShot.current;
        const foul = potted >= 100;
        const scored = foul ? 0 : potted;
        pottedThisShot.current = 0;
        const left = balls.filter((ball) => !ball.pocketed).length;
        if (turnRef.current === "you") {
          if (scored > 0) setYouScore((value) => value + scored);
          setRemaining(left);
          if (left === 0) {
            setPhase("cleared");
            dogRef.current.happy = 1;
            return;
          }
          setTurn("dog");
          setTip("轮到小狗了…");
          setPhase("dog-thinking");
          // 让小狗接着打
          window.setTimeout(() => {
            void fireDogShot();
          }, 550);
        } else {
          if (scored > 0) setDogScore((value) => value + scored);
          setRemaining(left);
          if (left === 0) {
            setPhase("cleared");
            dogRef.current.happy = 1;
            return;
          }
          setTurn("you");
          setTip("轮到你了：按住左键往后拉，松手击球");
          setPhase("aiming");
        }
        setDogLine("");
      }

      // 小狗跟着白球
      const dog = dogRef.current;
      dog.t += 0.05;
      if (dog.happy > 0) dog.happy = Math.max(0, dog.happy - 0.01);
      const targetX = cue.x + 52;
      const targetY = Math.min(h - 44, Math.max(h * 0.6, cue.y + 66));
      dog.x += (targetX - dog.x) * 0.06;
      dog.y += (targetY - dog.y) * 0.06;

      // ---------- 绘制 ----------
      context.clearRect(0, 0, w, h);

      // 台面
      const margin = 16;
      context.beginPath();
      context.roundRect(margin, margin, w - margin * 2, h - margin * 2, 18);
      context.fillStyle = "rgba(14, 116, 90, 0.16)";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "rgba(45, 212, 191, 0.45)";
      context.stroke();

      // 球洞
      for (const pocket of pockets) {
        context.beginPath();
        context.arc(pocket.x, pocket.y, pocket.r, 0, Math.PI * 2);
        context.fillStyle = "rgba(2, 6, 23, 0.62)";
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = "rgba(45, 212, 191, 0.5)";
        context.stroke();
      }

      // 目标球
      for (const ball of balls) {
        if (ball.fade <= 0) continue;
        context.beginPath();
        context.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
        context.fillStyle = `rgba(250, 250, 252, ${0.92 * ball.fade})`;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = `rgba(56, 189, 248, ${0.85 * ball.fade})`;
        context.stroke();
        context.beginPath();
        context.arc(ball.x, ball.y, ball.r * 0.34, 0, Math.PI * 2);
        context.fillStyle = `rgba(56, 189, 248, ${0.55 * ball.fade})`;
        context.fill();
      }

      // 白球
      context.beginPath();
      context.arc(cue.x, cue.y, CUE_RADIUS, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.96)";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "rgba(148, 163, 184, 0.9)";
      context.stroke();

      // 瞄准线与力度
      if (aimRef.current.active && phaseRef.current === "aiming") {
        const aim = aimRef.current;
        const dx = cue.x - aim.x;
        const dy = cue.y - aim.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 4) {
          const nx = dx / distance;
          const ny = dy / distance;
          const length = Math.min(460, distance * 1.7);
          context.beginPath();
          context.setLineDash([10, 8]);
          context.moveTo(cue.x, cue.y);
          context.lineTo(cue.x + nx * length, cue.y + ny * length);
          context.strokeStyle = "rgba(250, 204, 21, 0.8)";
          context.lineWidth = 2;
          context.stroke();
          context.setLineDash([]);
          const power = Math.min(1, distance / 260);
          context.fillStyle = "rgba(15, 23, 42, 0.5)";
          context.fillRect(cue.x - 42, cue.y + 24, 84, 6);
          context.fillStyle = power > 0.75 ? "rgba(248, 113, 113, 0.95)" : "rgba(74, 222, 128, 0.95)";
          context.fillRect(cue.x - 42, cue.y + 24, 84 * power, 6);
        }
      }

      // 小狗
      const bob = Math.sin(dog.t) * (dog.happy > 0 ? 7 : 2);
      context.save();
      context.translate(dog.x, dog.y + bob);
      context.beginPath();
      context.ellipse(0, 15, 20, 5, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(2, 6, 23, 0.2)";
      context.fill();
      context.beginPath();
      context.ellipse(0, 0, 17, 12, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.96)";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "rgba(100, 116, 139, 0.85)";
      context.stroke();
      for (const [ex, rotation] of [[-11, -0.4], [11, 0.4]] as const) {
        context.beginPath();
        context.ellipse(ex, -8, 5.5, 7.5, rotation, 0, Math.PI * 2);
        context.fillStyle = "rgba(255, 255, 255, 0.96)";
        context.fill();
        context.stroke();
      }
      context.beginPath();
      context.arc(-5.5, -1, 1.9, 0, Math.PI * 2);
      context.arc(5.5, -1, 1.9, 0, Math.PI * 2);
      context.fillStyle = "rgba(30, 41, 59, 0.9)";
      context.fill();
      context.beginPath();
      context.arc(0, 4.5, 2.2, 0, Math.PI * 2);
      context.fill();
      context.restore();

      if (dogLine) {
        context.font = "600 13px system-ui, sans-serif";
        context.fillStyle = "rgba(56, 189, 248, 0.95)";
        context.fillText(dogLine, dog.x + 24, dog.y - 16 + bob);
      }

      frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [dogLine, fireDogShot]);

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || phaseRef.current !== "aiming" || turnRef.current !== "you") return;
    aimRef.current = { active: true, ...pointerPosition(event) };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    aimRef.current = { active: true, ...pointerPosition(event) };
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    const point = pointerPosition(event);
    aimRef.current.active = false;
    const cue = cueRef.current;
    const dx = cue.x - point.x;
    const dy = cue.y - point.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 12) return;
    const power = Math.min(1, distance / 260) * MAX_POWER;
    startedAtRef.current = startedAtRef.current ?? Date.now();
    pottedThisShot.current = 0;
    cue.vx = (dx / distance) * power;
    cue.vy = (dy / distance) * power;
    setTip("球在滚…");
    setPhase("rolling");
  };

  const yourTurn = turn === "you" && phase === "aiming";

  return (
    <div className="billiards">
      <canvas
        ref={canvasRef}
        className={`billiards__canvas${yourTurn ? " billiards__canvas--ready" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          aimRef.current.active = false;
        }}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div className="billiards__bar">
        <span className={`billiards__turn${turn === "you" ? " billiards__turn--you" : ""}`}>
          {phase === "cleared" ? "清台！" : turn === "you" ? "你的回合" : "小狗的回合"}
        </span>
        <span className="billiards__score">
          你 {youScore} : {dogScore} 小狗
        </span>
        <span>剩余 {remaining}</span>
        <span>{formatTime(elapsed)}</span>
        <button type="button" className="billiards__btn" onClick={() => void reset()} title="重开（R）">
          重开
        </button>
        <button
          type="button"
          className="billiards__btn"
          onClick={() => void invoke("close_billiards_window").catch(() => undefined)}
          title="退出（Esc）"
        >
          <X size={13} /> 退出
        </button>
      </div>

      <p className="billiards__tip">
        {phase === "cleared"
          ? `清台完成：你 ${youScore} 分，小狗 ${dogScore} 分`
          : tip + (iconCount > 0 ? `（桌面 ${iconCount} 个图标）` : "")}
      </p>

      <p className="billiards__credit">玩法参考 desktop-icon-billiards · GitHub@liuxiaogang-com（MIT）</p>
    </div>
  );
}