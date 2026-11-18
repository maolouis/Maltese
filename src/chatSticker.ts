// 聊天「表情包信使」：从模型输出里抽受控标记 <sticker:xxx>，映射到素材库动作。
//
// 指令由 Rust 侧 persona 注入（local_chat.rs / dsh_chat.rs 的 sticker 参数），
// 前端只做解析、白名单校验、去重和渲染。
// 设计原则：任何解析失败都静默忽略，绝不显示破图。

/** 白名单（按 docs/research-chat-sticker.md 扩充到 12 个）。 */
export const STICKER_IDS = [
  "happy",
  "celebrate",
  "love",
  "pet",
  "play",
  "sleeping",
  "eating",
  "chin",
  "peek",
  "cry",
  "angry",
  "relax",
] as const;

export type StickerId = (typeof STICKER_IDS)[number];

/** 标记 id → 素材动作目录。 */
export const STICKER_ACTION: Record<StickerId, string> = {
  happy: "happy",
  celebrate: "hop",
  love: "love",
  pet: "pet",
  play: "play",
  sleeping: "sleep",
  eating: "eat",
  chin: "chin",
  peek: "peek",
  cry: "cry",
  angry: "angry",
  relax: "relax",
};

/** 这些 id 优先用「微博表情包」素材池（素材更贴表情包语境）。 */
export const STICKER_PREFERS_STICKERS_POOL = new Set<string>(["happy", "pet", "eating", "sleeping"]);

/** 系统指令（由 Rust 侧 persona 使用，前端仅保留常量便于文档/测试对齐）。 */
export const STICKER_INSTRUCTION =
  "如果你想说点什么但文字不够，可以在回复末尾单独一行输出 <sticker:表情>，表情只能取以下之一：" +
  "happy、celebrate、love、pet、play、sleeping、eating、chin、peek、cry、angry、relax；最多一个，不确定就不要输出。";

const IDS = STICKER_IDS.join("|");
/** 规范写法 `<sticker:relax>`；也容忍模型偷懒写 `<relax>`。 */
const STICKER_PATTERN = new RegExp("<sticker:\\s*([a-zA-Z_]+)\\s*>", "gi");
const ID_ONLY_PATTERN = new RegExp("<(" + IDS + ")>", "gi");
/** 移除所有标记（含未写完的一半），用于清洗正文。 */
const MARKER_PATTERN = new RegExp("<sticker:[^>]*>?", "gi");

export function isStickerId(value: unknown): value is StickerId {
  return typeof value === "string" && (STICKER_IDS as readonly string[]).includes(value);
}

/**
 * 从模型输出里抽出第一个合法标记并移除所有标记文本。
 * 非法/拼错的 id 也把标记删掉（不猜、不显示）。
 */
export function extractSticker(text: string): { text: string; sticker: StickerId | null } {
  if (!text) return { text: "", sticker: null };
  let sticker: StickerId | null = null;
  const candidates = [
    ...text.matchAll(STICKER_PATTERN),
    ...text.matchAll(ID_ONLY_PATTERN),
  ];
  for (const match of candidates) {
    const id = (match[1] ?? "").toLowerCase();
    if (isStickerId(id)) {
      sticker = id;
      break;
    }
  }
  const cleaned = text
    .replace(MARKER_PATTERN, "")
    .replace(ID_ONLY_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: cleaned, sticker };
}

/** 流式展示时先把标记（可能还没写完整）隐藏掉。 */
export function stripStickerMarkup(text: string): string {
  // 流式时标记可能只写到一半（`<sticker:hap` / `<relax`），连未闭合的一起隐藏。
  return text
    .replace(/<sticker:[^>]*>?/gi, "")
    .replace(new RegExp("<(?:" + IDS + ")>", "gi"), "")
    .replace(new RegExp("<(?:" + IDS + ")$", "i"), "")
    .replace(/<sticker:[^>]*$/, "");
}

/** 连续 3 条不重复同一 sticker：候选在最近 3 条里出现过就返回 null。 */
export function dedupeSticker(
  recent: Array<string | null | undefined>,
  candidate: StickerId | null | undefined,
): StickerId | null {
  if (!candidate || !isStickerId(candidate)) return null;
  const lastThree = recent.slice(-3);
  return lastThree.includes(candidate) ? null : candidate;
}

/** 历史消息兼容：老记录没有 sticker 字段 / 字段非法时正常返回 null。 */
export function stickerOfMessage(message: { sticker?: unknown } | null | undefined): StickerId | null {
  if (!message) return null;
  return isStickerId(message.sticker) ? message.sticker : null;
}

/** 素材池顺序：微博 stickers（部分 id）→ 当前角色 → duo 回退 shared → xiaobai。 */
export function stickerPoolOrder(id: StickerId, character: string): Array<{ group: string; action: string }> {
  const action = STICKER_ACTION[id];
  const pools: Array<{ group: string; action: string }> = [];
  if (STICKER_PREFERS_STICKERS_POOL.has(id)) pools.push({ group: "stickers", action });
  pools.push({ group: character, action });
  if (character === "duo") {
    pools.push({ group: "shared", action });
    pools.push({ group: "xiaobai", action });
  }
  return pools;
}

/** 表情包内联显示宽度（px）：
 * - 正常 144–160（按气泡宽度微调），最小 128、最大 180；
 * - 源 GIF 比 128 还小（例如 120）时按自然尺寸渲染，避免拉伸糊掉；
 * - 放大预览用原始尺寸（CSS 再限制到窗口 60%）。
 */
export function stickerDisplayWidth(naturalWidth: number, bubbleWidth = 360): number {
  const target = Math.round(Math.min(160, Math.max(144, bubbleWidth * 0.4)));
  const natural = Number.isFinite(naturalWidth) && naturalWidth > 0 ? Math.round(naturalWidth) : 0;
  if (natural > 0 && natural < 128) return natural;
  return Math.min(180, Math.max(128, target));
}

/**
 * 把模型输出拆成「文字 + 可选表情包」两条消息的数据（纯函数，便于单测）：
 * - 文字部分去掉标记；只剩标记时 text 为空字符串（调用方不产生文字消息）；
 * - sticker 只取第一个白名单 id，其余忽略；最近 3 条内出现过则丢弃（不显示）。
 */
export function splitAssistantReply(
  rawText: string,
  recentStickers: Array<string | null | undefined> = [],
): { text: string; sticker: StickerId | null } {
  const parsed = extractSticker(rawText ?? "");
  return {
    text: parsed.text,
    sticker: dedupeSticker(recentStickers, parsed.sticker),
  };
}
