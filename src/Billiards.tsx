// 桌面图标台球：真实的桌面快捷方式图标就是球。
//
// 参照开源项目 desktop-icon-billiards（GitHub@liuxiaogang-com，MIT）：
// 开局把桌面图标摆成三角球阵，瞄准蓄力击球，图标会在桌面上滚动、碰撞、入袋，
// 退出时恢复原位置。
//
// 这里由 Maltese 负责物理与渲染（覆盖层只画白球 / 球洞 / 瞄准线 / 小狗 / 顶部条），
// 真实图标位置通过 `desktop_icons_move` 批量搬动；桌面原位置在开局时备份，
// 退出、关窗、甚至上次异常退出后再次启动都会恢复。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { loadLocalChatConfig } from "./localChat";
import "./Billiards.css";

type DesktopIconCell = { index: number; x: number; y: number; w: number; h: number };
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
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pocketed: boolean;
  /** 上一次同步给桌面的位置，用来减少消息量 */
  sentX: number;
  sentY: number;
};

type Pocket = { x: number; y: number; r: number };
type Turn = "you" | "dog";
type Phase = "aiming" | "rolling" | "dog-thinking" | "cleared";

const CUE_RADIUS = 15;
const FRICTION = 0.988;
const MIN_SPEED = 0.05;
const MAX_POWER = 26;
const WALL_BOUNCE = 0.74;
const POCKET_RADIUS = 26;
/** 图标左上角到球心的偏移：图标格子的中心就是球心 */
export default function Billiards() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [count, setCount] = useState(0);
  const [phase, setPhase] = useState<Phase>("aiming");
  const [turn, setTurn] = useState<Turn>("you");
  const [youScore, setYouScore] = useState(0);
  const [dogScore, setDogScore] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [tip, setTip] = useState("按住左键往后拉，松手击球");
  const [dogLine, setDogLine] = useState("");
  const [errorText, setErrorText] = useState("");

  const ballsRef = useRef<Ball[]>([]);
  const cueRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const pocketsRef = useRef<Pocket[]>([]);
  const aimRef = useRef({ active: false, x: 0, y: 0 });
  const dogRef = useRef({ x: 0, y: 0, t: 0, happy: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const phaseRef = useRef<Phase>("aiming");
  const turnRef = useRef<Turn>("you");
  const pottedRef = useRef(0);
  const foulRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const syncAtRef = useRef(0);
  const runningRef = useRef(false);
  // 是否已经进入一局。隐藏的台球窗口会随应用一起挂载，
  // 绝不能在挂载时就开局（否则一启动应用桌面图标就被搬走，见 issue #1）。
  const [inGame, setInGame] = useState(false);

  phaseRef.current = phase;
  turnRef.current = turn;

  /** 把图标摆成三角球阵（屏幕坐标），并记录原始位置用于恢复。 */
  const start = useCallback(async () => {
    if (!isTauri()) {
      setErrorText("需要在桌面应用里玩。");
      return;
    }
    setErrorText("");
    try {
      const layout = await invoke<DesktopIconLayout>("desktop_icons_begin_game");
      if (!layout.visible) {
        setErrorText(layout.error ?? "没有读到桌面图标（图标可能被隐藏了）");
        setCount(0);
        setRemaining(0);
        return;
      }
      const canvas = canvasRef.current;
      const width = canvas?.clientWidth ?? window.innerWidth;
      const height = canvas?.clientHeight ?? window.innerHeight;
      sizeRef.current = { w: width, h: height, dpr: window.devicePixelRatio || 1 };

      const windowPos = { x: layout.areaX, y: layout.areaY };
      const cells = layout.cells.slice(0, 45);
      const total = cells.length;
      setCount(total);
      setRemaining(total);

      // 三角摆球：以窗口内坐标计算，再换算成屏幕坐标。
      const radius = Math.max(16, Math.min(26, width / 42));
      const gapX = radius * 2.16;
      const gapY = radius * 1.9;
      const rackTop = height * 0.22;
      const positions: Array<{ x: number; y: number }> = [];
      let row = 0;
      while (positions.length < total) {
        const inRow = Math.min(row + 1, total - positions.length);
        const startX = width / 2 - (inRow - 1) * gapX / 2;
        for (let i = 0; i < inRow; i += 1) {
          positions.push({ x: startX + i * gapX, y: rackTop + row * gapY });
        }
        row += 1;
      }

      ballsRef.current = cells.map((cell, i) => {
        const target = positions[i] ?? { x: width / 2, y: rackTop };
        return {
          index: cell.index,
          x: target.x,
          y: target.y,
          vx: 0,
          vy: 0,
          r: radius,
          pocketed: false,
          sentX: Number.NaN,
          sentY: Number.NaN,
        };
      });

      // 六洞
      const inset = 8;
      pocketsRef.current = [
        { x: inset, y: inset, r: POCKET_RADIUS },
        { x: width / 2, y: inset, r: POCKET_RADIUS },
        { x: width - inset, y: inset, r: POCKET_RADIUS },
        { x: inset, y: height - inset, r: POCKET_RADIUS },
        { x: width / 2, y: height - inset, r: POCKET_RADIUS },
        { x: width - inset, y: height - inset, r: POCKET_RADIUS },
      ];

      cueRef.current = { x: width / 2, y: height * 0.72, vx: 0, vy: 0 };
      dogRef.current = { x: width / 2 + 70, y: height * 0.82, t: 0, happy: 0 };

      // 立刻把真实图标摆到三角位置（图标左上角 = 球心 - 半个格子）
      const half = { x: (cells[0]?.w ?? 48) / 2, y: (cells[0]?.h ?? 48) / 2 };
      await invoke("desktop_icons_move", {
        moves: ballsRef.current.map((ball) => ({
          index: ball.index,
          x: Math.round(windowPos.x + ball.x - half.x),
          y: Math.round(windowPos.y + ball.y - half.y),
        })),
      });

      setYouScore(0);
      setDogScore(0);
      setTurn("you");
      setPhase("aiming");
      setDogLine("");
      setTip("按住左键往后拉，松手击球");
      startedAtRef.current = null;
      setElapsed(0);
      runningRef.current = true;
      setInGame(true);
    } catch (error) {
      runningRef.current = false;
      setInGame(false);
      setErrorText(`开局失败：${String(error)}`);
    }
  }, []);

  /** 退出：恢复桌面图标 */
  const quit = useCallback(async () => {
    runningRef.current = false;
    setInGame(false);
    try {
      await invoke("close_billiards_window");
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    // 注意：这里不能自动 start()。窗口虽然隐藏，但页面在应用启动时就已挂载，
    // 自动开局会把用户桌面图标直接搬走。只有「打开台球」事件或点开始才开局。
    let unlisten: (() => void) | null = null;
    void listen("maltese-billiards-start", () => {
      void start();
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void quit();
      if (event.key.toLowerCase() === "r" && runningRef.current) void start();
    };
    window.addEventListener("keydown", onKey);
    // 关掉窗口时也要恢复（标题栏关闭 / Alt+F4 / 系统关闭）
    const onUnload = () => {
      void invoke("desktop_icons_restore").catch(() => undefined);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
      void invoke("desktop_icons_restore").catch(() => undefined);
    };
  }, [quit, start]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (startedAtRef.current) setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // ---------- 小狗的一杆：让模型决定打哪颗、多大力度 ----------
  const planDogShot = useCallback(async () => {
    const balls = ballsRef.current.filter((ball) => !ball.pocketed);
    const cue = cueRef.current;
    const pockets = pocketsRef.current;
    if (balls.length === 0) return null;

    const geometric = () => {
      let best: { ball: Ball; pocket: Pocket; score: number } | null = null;
      for (const ball of balls) {
        for (const pocket of pockets) {
          const score = Math.hypot(pocket.x - ball.x, pocket.y - ball.y) + Math.hypot(ball.x - cue.x, ball.y - cue.y) * 0.6;
          if (!best || score < best.score) best = { ball, pocket, score };
        }
      }
      return best;
    };

    let targetBall: Ball | null = null;
    let power = 0.75;

    try {
      const config = loadLocalChatConfig();
      const { w, h } = sizeRef.current;
      const prompt = [
        "你在和主人打桌面台球，帮自己算这一杆。",
        `台面坐标：左上(0,0)，右下(${Math.round(w)},${Math.round(h)})，单位像素。`,
        `白球在(${Math.round(cue.x)},${Math.round(cue.y)})。`,
        `球洞：${pockets.map((p, i) => `洞${i + 1}(${Math.round(p.x)},${Math.round(p.y)})`).join(" ")}。`,
        `剩余目标球：${balls.slice(0, 15).map((b) => `#${b.index}(${Math.round(b.x)},${Math.round(b.y)})`).join(" ")}。`,
        "只输出一行 JSON：{\"target\": 球的编号, \"power\": 0.3到1之间的力度}。不要解释。",
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
        if (typeof parsed.target === "number") {
          targetBall = balls.find((ball) => ball.index === parsed.target) ?? null;
        }
        if (typeof parsed.power === "number") power = Math.min(1, Math.max(0.3, parsed.power));
      }
    } catch {
      // 模型不可用 → 几何兜底
    }

    let pocket: Pocket;
    if (!targetBall) {
      const best = geometric();
      if (!best) return null;
      targetBall = best.ball;
      pocket = best.pocket;
    } else {
      pocket = pockets.reduce((closest, current) =>
        Math.hypot(current.x - targetBall!.x, current.y - targetBall!.y) <
        Math.hypot(closest.x - targetBall!.x, closest.y - targetBall!.y)
          ? current
          : closest,
      );
    }

    // 幽灵球瞄准
    const dx = pocket.x - targetBall.x;
    const dy = pocket.y - targetBall.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ghostX = targetBall.x - (dx / distance) * (targetBall.r + CUE_RADIUS);
    const ghostY = targetBall.y - (dy / distance) * (targetBall.r + CUE_RADIUS);
    const aimX = ghostX - cue.x;
    const aimY = ghostY - cue.y;
    const aimDistance = Math.hypot(aimX, aimY) || 1;
    const speed = MAX_POWER * power;
    return {
      vx: (aimX / aimDistance) * speed,
      vy: (aimY / aimDistance) * speed,
      comment: `小狗盯上了 ${targetBall.index + 1} 号图标`,
    };
  }, []);

  const fireDogShot = useCallback(async () => {
    if (phaseRef.current === "rolling") return;
    setPhase("dog-thinking");
    setTip("小狗在想这一杆…");
    const shot = await planDogShot();
    if (!shot) {
      setPhase("aiming");
      setTurn("you");
      setTip("这一局打完了");
      return;
    }
    setDogLine(shot.comment);
    startedAtRef.current = startedAtRef.current ?? Date.now();
    pottedRef.current = 0;
    foulRef.current = false;
    cueRef.current.vx = shot.vx;
    cueRef.current.vy = shot.vy;
    setPhase("rolling");
    setDogLine("");
  }, [planDogShot]);

  // ---------- 物理 + 把真实图标搬到球的位置 ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const step = () => {
      if (!runningRef.current) {
        frame = window.requestAnimationFrame(step);
        return;
      }
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
      for (const pocket of pockets) {
        if (Math.hypot(cue.x - pocket.x, cue.y - pocket.y) < pocket.r) {
          cue.x = w / 2;
          cue.y = h * 0.72;
          cue.vx = 0;
          cue.vy = 0;
          foulRef.current = true;
        }
      }

      // 目标球
      for (const ball of balls) {
        if (ball.pocketed) continue;
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
        for (const pocket of pockets) {
          if (Math.hypot(ball.x - pocket.x, ball.y - pocket.y) < pocket.r) {
            ball.pocketed = true;
            ball.vx = 0;
            ball.vy = 0;
            pottedRef.current += 1;
            break;
          }
        }
      }

      // 碰撞：白球 × 目标球
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
          cue.vx = -nx * speed * 0.4;
          cue.vy = -ny * speed * 0.4;
          ball.vx += nx * speed * 0.9;
          ball.vy += ny * speed * 0.9;
        }
      }
      // 目标球 × 目标球
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
            const impulse = relative * 0.8;
            a.vx += nx * impulse;
            a.vy += ny * impulse;
            b.vx -= nx * impulse;
            b.vy -= ny * impulse;
          }
        }
      }

      // 把真实图标搬到球的位置（每秒约 25 次，避免刷爆消息）
      const now = performance.now();
      if (runningRef.current && now - syncAtRef.current > 40) {
        syncAtRef.current = now;
        const layout = ballsRef.current;
        const moves = layout.map((ball) => ({
          index: ball.index,
          x: Math.round(window.screenX + ball.x - ball.r),
          y: Math.round(window.screenY + ball.y - ball.r * 0.92),
        }));
        void invoke("desktop_icons_move", { moves }).catch(() => undefined);
        for (const ball of layout) {
          ball.sentX = ball.x;
          ball.sentY = ball.y;
        }
      }

      // 停止 → 结算
      const moving =
        Math.hypot(cue.vx, cue.vy) > 0 ||
        balls.some((ball) => !ball.pocketed && Math.hypot(ball.vx, ball.vy) > 0);
      if (!moving && phaseRef.current === "rolling") {
        const scored = foulRef.current ? 0 : pottedRef.current;
        pottedRef.current = 0;
        foulRef.current = false;
        const left = balls.filter((ball) => !ball.pocketed).length;
        setRemaining(left);
        if (turnRef.current === "you") {
          if (scored > 0) setYouScore((value) => value + scored);
          if (left === 0) {
            setPhase("cleared");
            dogRef.current.happy = 1;
          } else {
            setTurn("dog");
            setTip("轮到小狗了…");
            setPhase("dog-thinking");
            window.setTimeout(() => void fireDogShot(), 520);
          }
        } else {
          if (scored > 0) setDogScore((value) => value + scored);
          if (left === 0) {
            setPhase("cleared");
            dogRef.current.happy = 1;
          } else {
            setTurn("you");
            setTip("轮到你了：按住左键往后拉，松手击球");
            setPhase("aiming");
          }
        }
        setDogLine("");
      }

      // 小狗
      const dog = dogRef.current;
      dog.t += 0.05;
      if (dog.happy > 0) dog.happy = Math.max(0, dog.happy - 0.01);
      dog.x += (cue.x + 60 - dog.x) * 0.06;
      dog.y += (Math.min(h - 40, Math.max(h * 0.62, cue.y + 70)) - dog.y) * 0.06;

      // ---------- 绘制（只有白球、洞、瞄线、小狗、边框；图标是桌面上的真实图标） ----------
      context.clearRect(0, 0, w, h);
      const margin = 10;
      context.beginPath();
      context.roundRect(margin, margin, w - margin * 2, h - margin * 2, 20);
      context.strokeStyle = "rgba(45, 212, 191, 0.35)";
      context.lineWidth = 2;
      context.stroke();

      for (const pocket of pockets) {
        context.beginPath();
        context.arc(pocket.x, pocket.y, pocket.r, 0, Math.PI * 2);
        context.fillStyle = "rgba(2, 6, 23, 0.55)";
        context.fill();
        context.strokeStyle = "rgba(45, 212, 191, 0.45)";
        context.lineWidth = 2;
        context.stroke();
      }

      context.beginPath();
      context.arc(cue.x, cue.y, CUE_RADIUS, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.96)";
      context.fill();
      context.strokeStyle = "rgba(148, 163, 184, 0.9)";
      context.lineWidth = 2;
      context.stroke();

      if (aimRef.current.active && phaseRef.current === "aiming") {
        const aim = aimRef.current;
        const dx = cue.x - aim.x;
        const dy = cue.y - aim.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 4) {
          const nx = dx / distance;
          const ny = dy / distance;
          const length = Math.min(520, distance * 1.8);
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
      context.strokeStyle = "rgba(100, 116, 139, 0.85)";
      context.lineWidth = 2;
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

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || phaseRef.current !== "aiming" || turnRef.current !== "you") return;
    aimRef.current = { active: true, ...pointOf(event) };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    aimRef.current = { active: true, ...pointOf(event) };
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimRef.current.active) return;
    const point = pointOf(event);
    aimRef.current.active = false;
    const cue = cueRef.current;
    const dx = cue.x - point.x;
    const dy = cue.y - point.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 12) return;
    const power = Math.min(1, distance / 260) * MAX_POWER;
    startedAtRef.current = startedAtRef.current ?? Date.now();
    pottedRef.current = 0;
    foulRef.current = false;
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
        {inGame ? (
          <>
            <span className={`billiards__turn${turn === "you" ? " billiards__turn--you" : ""}`}>
              {phase === "cleared" ? "清台！" : turn === "you" ? "你的回合" : "小狗的回合"}
            </span>
            <span className="billiards__score">
              你 {youScore} : {dogScore} 小狗
            </span>
            <span>剩余 {remaining}</span>
            <span>{Math.floor(elapsed / 1000)}s</span>
            <button type="button" className="billiards__btn" onClick={() => void start()} title="重开（R）">
              重开
            </button>
          </>
        ) : (
          <span className="billiards__turn">还没开局</span>
        )}
        <button type="button" className="billiards__btn" onClick={() => void quit()} title="退出并恢复桌面（Esc）">
          <X size={13} /> 退出
        </button>
      </div>

      {!inGame && (
        <div className="billiards__gate">
          <strong>和小狗打台球</strong>
          <p>开始后才会把桌面图标摆成球阵；退出（或按 Esc）会把图标放回原来的位置。</p>
          {errorText && <p className="billiards__gate-error">{errorText}</p>}
          <button type="button" className="billiards__btn billiards__btn--primary" onClick={() => void start()}>
            开始这一局
          </button>
        </div>
      )}

      <p className="billiards__tip">
        {inGame
          ? errorText ||
            (phase === "cleared"
              ? `清台完成：你 ${youScore} 分，小狗 ${dogScore} 分（退出后桌面自动恢复）`
              : `${tip}${count > 0 ? ` · 桌面 ${count} 个图标就是 ${count} 颗球` : ""}`)
          : "只有点「开始这一局」才会动桌面图标"}
      </p>

      <p className="billiards__credit">玩法参考 desktop-icon-billiards · GitHub@liuxiaogang-com（MIT）</p>
    </div>
  );
}