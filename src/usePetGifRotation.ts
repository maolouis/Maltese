import { useEffect, useRef, useState } from "react";

type RotationOptions = {
  /** 每张 GIF 停留的毫秒数。 */
  intervalMs?: number;
  /** 为 false 时暂停轮播（例如主狗正在睡觉）。 */
  enabled?: boolean;
};

const preloaded = new Set<string>();

function preload(frames: readonly string[]) {
  for (const frame of frames) {
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
 * 按用户设置好的顺序逐张循环，而不是随机跳；这样设置页里的顺序就是
 * 实际播放顺序。切换表情/顺序后从第一张重新开始，并提前预加载。
 */
export function usePetGifRotation(
  frames: readonly string[],
  { intervalMs = 12_000, enabled = true }: RotationOptions = {},
) {
  const [source, setSource] = useState(() => frames[0] ?? "");
  const indexRef = useRef(0);
  const key = frames.join("|");

  useEffect(() => {
    if (frames.length === 0) {
      setSource("");
      return;
    }
    preload(frames);

    if (!enabled || frames.length <= 1) {
      indexRef.current = 0;
      setSource(frames[0] ?? "");
      return;
    }

    indexRef.current = 0;
    setSource(frames[0] ?? "");
    const timer = window.setInterval(() => {
      indexRef.current = (indexRef.current + 1) % frames.length;
      setSource(frames[indexRef.current] ?? frames[0] ?? "");
    }, Math.max(2_000, intervalMs));

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, key]);

  return source;
}