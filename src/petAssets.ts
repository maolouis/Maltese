import { petAssetUrl } from "./petAssetBase";

// 线条小狗 GIF 素材清单与随机选取逻辑。
// 素材来源：LineDogPet（小白角色），已复制到 public/assets/pets/<state>/<n>.gif。
// 每个状态的第 0 项是既有的根级 GIF（作为默认/兜底），其余为随机变体。

export type PetVisualState =
  | "idle"
  | "resting"
  | "listening"
  | "working"
  | "attention"
  | "pet"
  | "eating"
  | "pickup"
  | "scared"
  | "sleeping"
  | "celebrate"
  | "happy"
  | "relax"
  | "chin"
  | "spin"
  | "play"
  | "hide"
  | "chase"
  | "peek";

const variants = (state: string, count: number): string[] => {
  const list = [`/assets/pets/${state}.gif`];
  for (let i = 1; i <= count; i += 1) {
    list.push(`/assets/pets/${state}/${i}.gif`);
  }
  return list;
};

// 只有子目录变体、没有根级同名 GIF 的状态（来自 LineDogPet 的额外动作）。
const subVariants = (state: string, count: number): string[] => {
  const list: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    list.push(`/assets/pets/${state}/${i}.gif`);
  }
  return list;
};

export const PET_GIF_VARIANTS: Record<PetVisualState, string[]> = {
  // 收起态固定显示睡觉小狗（来自用户提供的动图转制）
  idle: variants("idle", 8),
  resting: ["/assets/pets/rest.gif"],
  listening: variants("listening", 8),
  working: variants("working", 6),
  attention: variants("attention", 6),
  pet: variants("pet", 2),
  // 历史原因根级文件名为 eat.gif，而状态名是 eating。
  eating: ["/assets/pets/eat.gif", ...variants("eating", 4).slice(1)],
  pickup: variants("pickup", 4),
  scared: variants("scared", 4),
  sleeping: variants("sleeping", 6),
  celebrate: variants("celebrate", 4),
  happy: variants("happy", 6),
  relax: variants("relax", 4),
  chin: subVariants("chin", 2),
  spin: subVariants("spin", 3),
  play: subVariants("play", 4),
  hide: subVariants("hide", 2),
  chase: subVariants("chase", 3),
  peek: subVariants("peek", 8),
};

// 状态名兼容：历史上 eating 的 GIF 文件名为 eat.gif。
const FALLBACK_FILE: Record<string, string> = {
  eating: "/assets/pets/eat.gif",
};

export function resolvePetGif(state: string, exclude?: string): string {
  const list = PET_GIF_VARIANTS[state as PetVisualState];
  if (!list || list.length === 0) {
    return petAssetUrl(FALLBACK_FILE[state] ?? `/assets/pets/${state}.gif`);
  }
  if (list.length === 1) {
    return petAssetUrl(list[0]);
  }
  let picked = list[Math.floor(Math.random() * list.length)];
  // 尽量避免连续两次同一张图。
  let guard = 0;
  while (picked === exclude && guard < 4) {
    picked = list[Math.floor(Math.random() * list.length)];
    guard += 1;
  }
  return petAssetUrl(picked);
}
