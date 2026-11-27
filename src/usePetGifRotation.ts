import { useEffect, useMemo, useRef, useState } from "react";

import { nextIndexAfterFramesChange, pushRecent, RECENT_LIMIT, RECENT_RETRY } from "./petRotationBag.ts";

export type AnimFrequency = "high" | "medium" | "low";

/** 把设置页的「动画切换频率」映射成轮播间隔毫秒数。 */
export function animFrequencyToIntervalMs(freq?: AnimFrequency): number {
  switch (freq) {
    case "high":
      return 5_000;
    case "low":
      return 20_000;
    default:
      return 10_000;
  }
}

type RotationOptions = {
  /** 每张 GIF 停留的毫秒数。 */
  intervalMs?: number;
  /** 为 false 时暂停轮播（例如主狗正在睡觉）。 */
  enabled?: boolean;
  /** 可选：提供给调用方「手动点一下切下一张并重置自动切换计时器」的函数句柄。 */
  stepRef?: { current: (() => string | null) | null };
};

const preloaded = new Set<string>();

/** 只预加载后面几张：素材池可能几百张，全量解码会吃掉几十 MB 内存。 */
const PRELOAD_AHEAD = 4;

function preload(frames: readonly string[], start = 0) {
  for (let offset = 0; offset < PRELOAD_AHEAD; offset += 1) {
    const frame = frames[(start + offset) % Math.max(1, frames.length)];
    if (!frame || preloaded.has(frame)) continue;
    preloaded.add(frame);
    const image = new Image();
    image.decoding = "async";
    image.src = frame;
  }
}

/**
 * 小狗 GIF 轮播。
 *
 * 旧实现：每次播放列表重建（vitals 分桶变化、设置变动）都把指针重置到 0，
 * 并且只按固定顺序循环，所以用户看到的一直是同一批、同一顺序的几张
 * （P1「根据状态要轮换表情包播放，不能一直是那几个」）。
 *
 * 现在：
 * - 列表重建时**不重置到 0**：新列表里还能找到刚播的那张就继续往后播（`nextIndexAfterFramesChange`）；
 * - 每次推进跳过**最近 8 个播放过的帧**（最多重试 5 次），避免短列表里连着重复；
 * - 切换状态（列表内容完全变了、旧帧不在新列表里）才从第一张开始。
 */
export function usePetGifRotation(
  frames: readonly string[],
  { intervalMs = 12_000, enabled = true, stepRef }: RotationOptions = {},
) {
  const [source, setSource] = useState(() => frames[0] ?? "");
  const indexRef = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const recentRef = useRef<string[]>(frames[0] ? [frames[0]] : []);
  // 合并后的轮播池可能几百张，每次 join 会白热 CPU；数组身份变了才重算。
  const key = useMemo(() => frames.join("|"), [frames]);

  useEffect(() => {
    if (frames.length === 0) {
      setSource("");
      if (stepRef) stepRef.current = null;
      return;
    }
    preload(frames);

    const advance = () => {
      if (frames.length <= 1) {
        const only = frames[0] ?? "";
        setSource(only);
        return only || null;
      }
      let nextIndex = indexRef.current;
      let candidate = "";
      for (let attempt = 0; attempt <= RECENT_RETRY; attempt += 1) {
        nextIndex = (nextIndex + 1) % frames.length;
        candidate = frames[nextIndex] ?? "";
        if (!candidate) break;
        // 帧池很小（≤ 窗口+1）时无法避免重复，只做“不连播同一张”。
        if (frames.length <= RECENT_LIMIT + 1) {
          if (candidate !== sourceRef.current) break;
          continue;
        }
        if (!recentRef.current.includes(candidate)) break;
      }
      indexRef.current = nextIndex;
      const nextFrame = candidate || frames[0] || "";
      recentRef.current = pushRecent(recentRef.current, nextFrame);
      setSource(nextFrame);
      preload(frames, indexRef.current + 1);
      return nextFrame || null;
    };

    if (!enabled || frames.length <= 1) {
      setSource(frames[0] ?? "");
      if (stepRef) stepRef.current = advance;
      return () => {
        if (stepRef) stepRef.current = null;
      };
    }

    // 重建列表时保留进度（能找到刚播的那张就继续），而不是每次都从第 1 张开始。
    indexRef.current = nextIndexAfterFramesChange(frames, sourceRef.current, indexRef.current);
    setSource(frames[indexRef.current] ?? frames[0] ?? "");
    recentRef.current = pushRecent(recentRef.current, frames[indexRef.current] ?? frames[0] ?? "");

    const period = Math.max(2_000, intervalMs);
    let timer = window.setInterval(advance, period);
    if (stepRef) {
      stepRef.current = () => {
        const nextFrame = advance();
        // 单击切完一张后从头计时，避免刚点完不到 1 秒又被定时跳走。
        window.clearInterval(timer);
        timer = window.setInterval(advance, period);
        return nextFrame;
      };
    }

    return () => {
      window.clearInterval(timer);
      if (stepRef) stepRef.current = null;
    };
  }, [enabled, intervalMs, key, stepRef]);

  return source;
}