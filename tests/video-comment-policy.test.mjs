import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMENT_MAX_CHARS,
  COMMENT_MIN_INTERVAL_MS,
  COMMENT_SESSION_LIMIT,
  COMMENT_TEMPLATE,
  canCommentNow,
  commentBubbleText,
  commentFailureBubble,
  hasBannedWords,
  isRepeatComment,
  sanitizeComment,
  truncateTitle,
} from "../src/plugins/video/commentPolicy.ts";

const base = {
  enabled: true,
  onVideoPage: true,
  loginOrRisk: false,
  commentedUrls: [],
  sessionCount: 0,
  lastAt: 0,
  watchedMs: 10_000,
  currentUrl: "https://www.bilibili.com/video/BV1xx/",
};

test("触发条件：开关/页面/观看时长/去重/间隔/上限", () => {
  assert.equal(canCommentNow(base, 1_000_000).allowed, true);
  assert.deepEqual(canCommentNow({ ...base, enabled: false }), { allowed: false, reason: "disabled" });
  assert.deepEqual(canCommentNow({ ...base, onVideoPage: false }), { allowed: false, reason: "not_video_page" });
  assert.deepEqual(canCommentNow({ ...base, loginOrRisk: true }), { allowed: false, reason: "login_or_risk" });
  assert.deepEqual(canCommentNow({ ...base, watchedMs: 5_000 }), { allowed: false, reason: "not_watched_enough" });
  assert.deepEqual(
    canCommentNow({ ...base, commentedUrls: [base.currentUrl] }),
    { allowed: false, reason: "duplicate" },
  );
  assert.deepEqual(
    canCommentNow({ ...base, lastAt: 1_000_000 - 60_000 }, 1_000_000),
    { allowed: false, reason: "interval" },
  );
  assert.deepEqual(
    canCommentNow({ ...base, sessionCount: COMMENT_SESSION_LIMIT }),
    { allowed: false, reason: "session_limit" },
  );
  // 超过 3 分钟可再次评论另一条
  assert.equal(
    canCommentNow(
      { ...base, lastAt: 1_000_000 - COMMENT_MIN_INTERVAL_MS, commentedUrls: ["https://x/video/BVother/"] },
      1_000_000,
    ).allowed,
    true,
  );
});

test("评论清洗：≤40 字、去链接/@、禁词、空则模板", () => {
  assert.equal(sanitizeComment("  这个讲得  挺细的  "), "这个讲得 挺细的");
  assert.equal(sanitizeComment(""), COMMENT_TEMPLATE);
  assert.ok(sanitizeComment("x".repeat(100)).length <= COMMENT_MAX_CHARS);
  const cleaned = sanitizeComment("看完了求关注 @某人 https://example.com 已三连");
  assert.equal(hasBannedWords(cleaned), false, cleaned);
  assert.ok(!cleaned.includes("http"));
  assert.ok(!cleaned.includes("@"));
});

test("复读检查与标题截断", () => {
  assert.equal(isRepeatComment("这个讲得挺细的", ["这个讲得挺细的"]), true);
  assert.equal(isRepeatComment("这个讲得挺细的", ["别的"]), false);
  assert.equal(truncateTitle("高中时的“班草”后来都怎么样了？【农村青年录】"), "高中时的“班草”后来都怎…");
  assert.equal(truncateTitle("短标题"), "短标题");
});

test("气泡文案：成功含标题与评论，失败给中文原因", () => {
  const text = commentBubbleText("高中时的“班草”后来都怎么样了？", "讲得挺细的");
  assert.ok(text.includes("《高中时的“班草”后来都怎…》"));
  assert.ok(text.includes("讲得挺细的"));
  assert.equal(commentFailureBubble("no-input"), "评论框没找到，先不发了。");
  assert.equal(commentFailureBubble("no-button"), "评论按钮没找到，先不发了。");
  assert.equal(commentFailureBubble("comment-cdp"), "评论发送没成功，先不发了。");
});