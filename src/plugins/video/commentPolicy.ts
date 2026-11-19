// 视频「自动评论」策略层（纯函数，node --test 可直接跑）。
//
// 触发/去重/安全阀都在这里定义，Rust 侧只需要按契约调用：
// - 一条视频只在「采完且停留 ≥8s」后评论一次（同 canonicalUrl 去重）；
// - 两次评论最小间隔 3 分钟、单次会话最多 10 条；
// - 只评论视频页（首页/搜索页不评）；
// - 未登录/风控 → 本会话停止自动评论；
// - 生成失败用模板兜底，绝不发空。

export const COMMENT_MAX_CHARS = 40;
export const COMMENT_MIN_INTERVAL_MS = 3 * 60_000;
export const COMMENT_SESSION_LIMIT = 10;
export const COMMENT_MIN_WATCH_MS = 8_000;
export const COMMENT_TITLE_MAX_CHARS = 12;
export const COMMENT_RECENT_HISTORY = 5;
export const COMMENT_TEMPLATE = "这个讲得挺细的，先码住。";

/** 禁词/话术：命中就重写或跳过。 */
export const COMMENT_BANNED = [
  "三连",
  "求关注",
  "互关",
  "关注我",
  "点个赞",
  "投币",
  "私信",
  "加微信",
  "http://",
  "https://",
  "@",
] as const;

export type CommentBlockReason =
  | "disabled"
  | "not_video_page"
  | "login_or_risk"
  | "not_watched_enough"
  | "duplicate"
  | "interval"
  | "session_limit";

export type CommentDecision =
  | { allowed: true }
  | { allowed: false; reason: CommentBlockReason };

export type CommentState = {
  /** 自动评论开关（设置项，默认开）。 */
  enabled: boolean;
  /** 当前页面是不是视频详情页。 */
  onVideoPage: boolean;
  /** 页面是不是登录/风控页。 */
  loginOrRisk: boolean;
  /** 本会话已评论过的 canonicalUrl。 */
  commentedUrls: ReadonlyArray<string>;
  /** 本会话已发评论数。 */
  sessionCount: number;
  /** 上一次评论时间（毫秒时间戳，0 表示还没有）。 */
  lastAt: number;
  /** 当前视频累计观看毫秒数。 */
  watchedMs: number;
  /** 当前视频 canonicalUrl（去重键）。 */
  currentUrl?: string;
};

/** 是否允许给当前视频发评论（触发条件 + 安全阀）。 */
export function canCommentNow(state: CommentState, now: number = Date.now()): CommentDecision {
  if (!state.enabled) return { allowed: false, reason: "disabled" };
  if (state.loginOrRisk) return { allowed: false, reason: "login_or_risk" };
  if (!state.onVideoPage) return { allowed: false, reason: "not_video_page" };
  if (state.sessionCount >= COMMENT_SESSION_LIMIT) return { allowed: false, reason: "session_limit" };
  if (state.watchedMs < COMMENT_MIN_WATCH_MS) return { allowed: false, reason: "not_watched_enough" };
  if (state.commentedUrls.includes(state.currentUrl ?? "")) {
    return { allowed: false, reason: "duplicate" };
  }
  if (state.lastAt > 0 && now - state.lastAt < COMMENT_MIN_INTERVAL_MS) {
    return { allowed: false, reason: "interval" };
  }
  return { allowed: true };
}

/** 标题截断（气泡文案用，按字符数截断并加省略号）。 */
export function truncateTitle(title: string, max = COMMENT_TITLE_MAX_CHARS): string {
  const trimmed = (title ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 口径统一：折叠空白、去掉 @ 与 URL、限制 40 字；空则用模板兜底。 */
export function sanitizeComment(raw: string): string {
  let text = (raw ?? "").replace(/\s+/g, " ").trim();
  text = text.replace(/https?:\/\/\S+/gi, "").replace(/@\S+/g, "");
  for (const word of COMMENT_BANNED) {
    if (word === "@") continue;
    text = text.split(word).join("");
  }
  text = text.trim();
  if (text.length > COMMENT_MAX_CHARS) text = `${text.slice(0, COMMENT_MAX_CHARS - 1)}…`;
  return text || COMMENT_TEMPLATE;
}

/** 是否命中禁词（单测/调试用）。 */
export function hasBannedWords(text: string): boolean {
  const value = (text ?? "").toLowerCase();
  return COMMENT_BANNED.some((word) => word !== "@" && value.includes(word.toLowerCase()));
}

/** 最近 N 条是否重复（复读检查，比较规范化后的文本）。 */
export function isRepeatComment(text: string, recent: ReadonlyArray<string>, limit = COMMENT_RECENT_HISTORY): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, "").trim();
  const target = normalize(text);
  return recent.slice(-limit).some((item) => normalize(item) === target);
}

/** 气泡文案：成功/失败两种。 */
export function commentBubbleText(title: string, comment: string): string {
  return `刚给《${truncateTitle(title)}》评论了一句：${comment}`;
}

export function commentFailureBubble(reason: string): string {
  switch (reason) {
    case "no-input":
      return "评论框没找到，先不发了。";
    case "no-button":
      return "评论按钮没找到，先不发了。";
    case "comment-cdp":
      return "评论发送没成功，先不发了。";
    case "login_or_risk":
      return "现在像是登录/风控页，本轮先不评论啦。";
    default:
      return "这条评论没能发出去，先不发了。";
  }
}