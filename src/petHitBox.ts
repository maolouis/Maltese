// 桌宠的「真实可见范围」测量。
//
// 收起态窗口是固定的抠位（约 148×128），但小狗 GIF 只有 112×112，而且 GIF 里
// 本身还有一圈透明留白。整块抠位都能点，就会在狗旁边的空白处误触（切表情 / 双击开面板）。
// 这里把当前 GIF 的 alpha 包围盒量出来（按图片尺寸的比例），只让这块区域接鼠标事件。
import { useEffect, useState } from "react";

export type PetHitBox = { x: number; y: number; w: number; h: number };

/** 量不出来时的兜底：整张图（总比整块抠位小）。 */
export const DEFAULT_HIT_BOX: PetHitBox = { x: 0, y: 0, w: 1, h: 1 };

const ALPHA_THRESHOLD = 24;
// 采样时把图缩到这个边长内再扫，够精确且几乎不耗时间。
const SAMPLE_SIZE = 96;
// 在测得的包围盒外再留一点余量，避免贴边点击点不到。
const HIT_MARGIN = 0.02;

const cache = new Map<string, PetHitBox>();

function roundRatio(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

/** 测量一张图片（或 GIF 首帧）的可见像素包围盒，返回相对整图的比例。 */
export async function measurePetHitBox(src: string): Promise<PetHitBox> {
  const cached = cache.get(src);
  if (cached) return cached;

  const result = await new Promise<PetHitBox>((resolve) => {
    const image = new Image();
    image.decoding = "sync";
    image.onload = () => {
      try {
        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;
        if (!naturalWidth || !naturalHeight) {
          resolve(DEFAULT_HIT_BOX);
          return;
        }
        const scale = Math.min(1, SAMPLE_SIZE / Math.max(naturalWidth, naturalHeight));
        const width = Math.max(1, Math.round(naturalWidth * scale));
        const height = Math.max(1, Math.round(naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          resolve(DEFAULT_HIT_BOX);
          return;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0 || maxY < 0) {
          resolve(DEFAULT_HIT_BOX);
          return;
        }
        const box: PetHitBox = {
          x: roundRatio(Math.max(0, minX / width - HIT_MARGIN)),
          y: roundRatio(Math.max(0, minY / height - HIT_MARGIN)),
          w: roundRatio(Math.min(1, (maxX - minX + 1) / width + HIT_MARGIN * 2)),
          h: roundRatio(Math.min(1, (maxY - minY + 1) / height + HIT_MARGIN * 2)),
        };
        resolve(box);
      } catch {
        resolve(DEFAULT_HIT_BOX);
      }
    };
    image.onerror = () => resolve(DEFAULT_HIT_BOX);
    image.src = src;
  });

  cache.set(src, result);
  return result;
}

/** 拿到当前 GIF 的可见范围；换素材时自动重新测量。 */
export function usePetHitBox(src: string): PetHitBox {
  const [box, setBox] = useState<PetHitBox>(() => cache.get(src) ?? DEFAULT_HIT_BOX);

  useEffect(() => {
    if (!src) return;
    const cached = cache.get(src);
    if (cached) {
      setBox(cached);
      return;
    }
    let cancelled = false;
    void measurePetHitBox(src).then((measured) => {
      if (!cancelled) setBox(measured);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return box;
}