import { petAssetUrl } from "./petAssetBase";
import { playCustomSound } from "./customSound";
import type { PetState } from "./petTypes";
export type CustomShortcut = { label: string; path: string };

export const CUSTOM_SHORTCUTS_KEY = "maltese-custom-shortcuts";
export const HIDDEN_SHORTCUTS_KEY = "maltese-hidden-shortcuts";
export const HIDDEN_SHORTCUT_ACTIONS_KEY = "maltese-hidden-shortcut-actions";
// 快捷入口的显示顺序：卡片 key 数组（内置工具 tool:<id>、文件快捷方式 path:<规范化路径>）。
// 只记录顺序，不存内容；删除/隐藏某条后它的 key 会自然失效。
export const SHORTCUT_ORDER_KEY = "maltese-shortcut-order";

export const PAGE_LABELS: Record<string, string> = {
  chat: "聊天",
  todo: "待办",
  music: "音乐",
  clipboard: "剪贴板",
  video: "看视频",
  agent: "Agent 控制台",
  qq: "消息",
  assistant: "快捷",
  layout: "设置",
};
export function shortcutPathKey(path: string): string {
  return path
    .replace(/\//g, "\\")
    .replace(/^\\\\\?\\/, "")
    .toLowerCase();
}

// 快捷卡片 key：内置工具和文件快捷方式统一成字符串，用来记住拖动后的顺序。
export function shortcutToolKey(id: string): string {
  return `tool:${id}`;
}

export function shortcutFileKey(path: string): string {
  return `path:${shortcutPathKey(path)}`;
}

export function loadShortcutOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(SHORTCUT_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function loadHiddenShortcuts(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_SHORTCUTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .map(shortcutPathKey)
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function loadHiddenShortcutActions(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_SHORTCUT_ACTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadCustomShortcuts(): CustomShortcut[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CustomShortcut =>
        Boolean(item)
        && typeof (item as CustomShortcut).label === "string"
        && typeof (item as CustomShortcut).path === "string")
      .slice(0, 24);
  } catch {
    return [];
  }
}



// 前台程序 → 对应的小狗动作（文字气泡之外再换一套 GIF）。
export const ACTIVITY_MOODS: Record<string, PetState> = {
  code: "working",
  document: "relax",
  meeting: "attention",
  chat: "happy",
  browser: "peek",
  design: "spin",
  video: "relax",
  game: "chase",
};

// 睡觉/缩边时固定趴睡帧；其余表情由设置页的轮播顺序决定。
// 注意：素材外置后必须在运行期解析（模块加载时资源目录还没初始化，写死会拿到 404 路径）。
export const sleepingFrame = () => petAssetUrl("/assets/pets/rest.gif");

// 根据前台进程生成的情感互动台词（相当于 LineDogPet 的“偷偷观察你”）。
export const ACTIVITY_LINES: Record<string, string[]> = {
  code: [
    "又在写代码呀，我趴在旁边不吵你，卡住了就摸摸我",
    "敲代码辛苦啦，记得眨眨眼、动动肩膀～",
    "这段逻辑是不是有点绕？先喝口水，回来再想",
    "陪你 debug：错的不一定是你，可能是世界",
    "写累了就看看我，摇尾巴不要钱",
    "今天的代码也会乖乖听话的，加油",
  ],
  document: [
    "在写东西呀，我安静地趴在旁边陪着你",
    "文档慢慢写，写不完也没关系，先照顾好自己的眼睛",
    "这一段写得真好，虽然我看不懂（摇尾巴）",
    "记得保存一下哦，我可不想看你重写",
    "写累了就把手放在我头上歇一会儿",
  ],
  meeting: [
    "在开会呀，我小声一点，不打扰你",
    "会议结束记得起来走两步，坐久了对腰不好",
    "要是听累了，就偷偷看我一眼，我在呢",
  ],
  chat: [
    "在聊天呀，替我向对方问好～",
    "聊得开心就好，别忘了喝水",
    "消息一条条来，你也可以慢慢回",
  ],
  browser: [
    "在网上逛什么呢？别被标题党骗走太多时间啦",
    "刷一会儿就休息一下吧，眼睛也要放假",
    "看到喜欢的可以复制给我，我帮你记着",
  ],
  design: [
    "在做设计呀，你的审美一定很好",
    "配色改来改去很正常的，别急",
    "画累了看看远方，我在这儿蹲着",
  ],
  video: [
    "看视频呀，好看的话记得跟我讲讲剧情",
    "追剧别忘了时间，眼睛要休息",
  ],
  game: [
    "打游戏啦？赢了记得摸摸我庆祝一下",
    "输一局也没关系，下一把一定行",
    "玩累了就歇会儿，我陪你趴着",
  ],
};

// 用 WebAudio 合成一声很短的小狗哼唧，避免额外音频素材。
let petAudioContext: AudioContext | null = null;
export function playPetChirp(kind: "soft" | "happy" = "soft") {
  // 用户配置了自定义音效就优先播放它，失败再回落到合成音。
  if (playCustomSound()) {
    return;
  }
  try {
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    petAudioContext = petAudioContext ?? new Ctx();
    const context = petAudioContext;
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    const base = kind === "happy" ? 720 : 520;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(base, now);
    oscillator.frequency.exponentialRampToValueAtTime(base * 1.35, now + 0.08);
    oscillator.frequency.exponentialRampToValueAtTime(base * 0.88, now + 0.17);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.26);
  } catch {
    // 音效失败不影响交互
  }
}
