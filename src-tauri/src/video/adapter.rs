//! 平台适配器：页面脚本与页面分类是唯一与页面结构耦合的地方。
//!
//! 脚本只读固定字段白名单，返回体积控制在 4 KB 以内。

use super::extract::{PageFacts, PageKind};
use super::model::Platform;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteractAction {
    Like,
    Favorite,
}

pub trait PlatformAdapter: Send + Sync {
    fn id(&self) -> Platform;
    fn feed_url(&self) -> &'static str;
    fn extract_script(&self) -> &'static str;
    /// 批量抓候选视频链接（不再用点击/滚动翻页）。
    fn candidate_script(&self) -> &'static str;
    fn interact_script(&self, action: InteractAction) -> Option<&'static str>;
    fn classify_page(&self, facts: &PageFacts) -> PageKind;
    /// 登录状态探针（小红书专用）；None 表示用通用逻辑。
    fn login_probe_script(&self) -> Option<&'static str> {
        None
    }
}

pub fn adapter_for(platform: Platform) -> &'static dyn PlatformAdapter {
    match platform {
        Platform::Bilibili => &BILIBILI,
        Platform::Douyin => &DOUYIN,
        Platform::Xiaohongshu => &XIAOHONGSHU,
    }
}

/// 分类优先级：验证码/风控 > 登录 > 推荐流 > 其他。
pub fn classify_hints(facts: &PageFacts) -> PageKind {
    if facts.hints.captcha_visible || facts.hints.risk_banner {
        return PageKind::RiskControl;
    }
    if facts.hints.login_visible {
        return PageKind::Login;
    }
    if facts.hints.on_feed || facts.platform.matches_url(facts.canonical_url.as_deref().unwrap_or("")) {
        return PageKind::Feed;
    }
    PageKind::Other
}

const BILIBILI_EXTRACT: &str = r#"
(() => {
  const pick = (sel) => document.querySelector(sel);
  const text = (sel) => (pick(sel)?.textContent || '').trim();
  const meta = (name) => (document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || '').trim();
  // 标题优先 og:title / h1，避免把「_哔哩哔哩bilibili / _哔哩哔哩_bilibili」站点后缀当成视频标题（会被当成伪条目丢弃）。
  const clean = (value) => (value || '')
    .replace(/\s*[-_–—]\s*哔哩哔哩.*$/i, '')
    .replace(/\s*[-_–—]\s*bilibili.*$/i, '')
    .trim();
  const title = clean(text('h1.video-title') || meta('og:title') || text('.video-title') || document.title);
  const description = text('.desc-info') || text('.video-desc') || meta('og:description') || meta('description');
  const author = text('.up-name') || text('.username') || meta('author');
  const tags = Array.from(document.querySelectorAll('.tag, .video-tag, a[href*="/search?keyword="]'))
    .map((node) => (node.textContent || '').trim())
    .filter(Boolean).slice(0, 10);
  const video = document.querySelector('video');
  const duration = Number.isFinite(video?.duration) ? Math.round(video.duration) : 0;
  const position = Number.isFinite(video?.currentTime) ? Math.round(video.currentTime) : 0;
  return {
    itemId: location.pathname.match(/\/video\/([^/?#]+)/)?.[1] || '',
    title, description, author, durationSeconds: duration, positionSeconds: position,
    playing: !!video && !video.paused && !video.ended,
    visible: document.visibilityState === 'visible',
    tags, liked: !!pick('.video-like.video-like--active, .like.active'),
    favorited: !!pick('.video-fav.video-fav--active, .collect.active'),
    coinOrShare: !!pick('.video-coin.video-coin--active, .coin.active'),
    commentSeconds: 0, authorClicked: false, seekBack: false, visits: 0,
    url: location.href,
    loginVisible: !!pick('.login-panel, .bili-login-dialog'),
    captchaVisible: !!pick('.geetest_panel, .captcha, iframe[src*="captcha" i]'),
    riskBanner: /(验证|风控|异常访问)/.test(document.body?.innerText?.slice(0, 2000) || ''),
    onFeed: /^\/($|index|recommend|popular)/.test(location.pathname)
  };
})()
"#;

/// 批量候选：`__INITIAL_STATE__` 的 bvid 优先，DOM 里的视频链接兜底。
/// 返回 `{state:[bvid…], hrefs:[…]}`；Rust 侧去重并按优先级入队。
const BILIBILI_CANDIDATES: &str = r#"
(() => {
  const out = { state: [], hrefs: [] };
  const pushState = (value) => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (!/^(BV[0-9A-Za-z]{8,}|av[0-9]{4,})$/.test(id)) return;
    if (out.state.length < 60 && !out.state.includes(id)) out.state.push(id);
  };
  try {
    const state = window.__INITIAL_STATE__ || {};
    const lists = [state.recommendList, state.related, state.relatedList, state.bangumi, state.seasonList];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 40)) {
        if (!item || typeof item !== 'object') continue;
        pushState(item.bvid || item.bvid_str || (item.videoData && item.videoData.bvid) || '');
      }
    }
    const videoData = state.videoData || {};
    if (videoData.bvid) pushState(videoData.bvid);
  } catch (e) {}
  try {
    const links = document.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]');
    for (const link of links) {
      if (out.hrefs.length >= 60) break;
      const href = link.getAttribute('href') || '';
      if (href && !out.hrefs.includes(href)) out.hrefs.push(href);
    }
  } catch (e) {}
  return out;
})()
"#;

const BILIBILI_LIKE: &str = r#"
(() => {
  const button = document.querySelector('.video-like, .like');
  if (!button || !/点赞|like/i.test(button.getAttribute('aria-label') || button.textContent || '点赞')) return false;
  button.click();
  return true;
})()
"#;

const BILIBILI_FAVORITE: &str = r#"
(() => {
  const button = document.querySelector('.video-fav, .collect');
  if (!button || !/收藏|favorite|collect/i.test(button.getAttribute('aria-label') || button.textContent || '收藏')) return false;
  button.click();
  return true;
})()
"#;

const DOUYIN_EXTRACT: &str = r#"
(() => {
  const pick = (sel) => document.querySelector(sel);
  const text = (sel) => (pick(sel)?.textContent || '').trim();
  const meta = (name) => (document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || '').trim();
  const visible = document.visibilityState === 'visible';
  const title = text('[data-e2e="video-desc"]') || text('.video-desc') || document.title;
  const description = text('[data-e2e="video-desc"]') || meta('og:description') || meta('description');
  const author = text('[data-e2e="video-author"]') || text('.author-name');
  const video = document.querySelector('video');
  const duration = Number.isFinite(video?.duration) ? Math.round(video.duration) : 0;
  const position = Number.isFinite(video?.currentTime) ? Math.round(video.currentTime) : 0;
  const itemId = location.pathname.match(/\/video\/(\d+)/)?.[1] || '';
  return {
    itemId, title, description, author, durationSeconds: duration, positionSeconds: position,
    playing: !!video && !video.paused && !video.ended, visible,
    tags: Array.from(document.querySelectorAll('[data-e2e="video-tag"], .tag'))
      .map((node) => (node.textContent || '').trim()).filter(Boolean).slice(0, 10),
    liked: !!pick('[data-e2e="video-like"].active'),
    favorited: !!pick('[data-e2e="video-collect"].active'),
    coinOrShare: false, commentSeconds: 0, authorClicked: false, seekBack: false, visits: 0,
    url: location.href,
    loginVisible: !!pick('.login-modal, [data-e2e="login-modal"]'),
    captchaVisible: !!pick('.captcha, [class*="captcha" i]'),
    riskBanner: /(验证|风控|异常)/.test(document.body?.innerText?.slice(0, 2000) || ''),
    onFeed: location.pathname === '/' || /^\/discover/.test(location.pathname)
  };
})()
"#;

const DOUYIN_CANDIDATES: &str = r#"
(() => {
  const out = { state: [], hrefs: [] };
  try {
    const links = document.querySelectorAll('a[href*="/video/"]');
    for (const link of links) {
      if (out.hrefs.length >= 60) break;
      const href = link.getAttribute('href') || '';
      if (href && !out.hrefs.includes(href)) out.hrefs.push(href);
    }
  } catch (e) {}
  return out;
})()
"#;


/// 小红书笔记详情页：标题/作者/正文/标签/图片/互动数/发布时间/xsec_token。
/// 注意：图片只记录直链，不下载、不转存（防盗链与版权见 docs/video-plugin-xiaohongshu.md）。
const XIAOHONGSHU_EXTRACT: &str = r#"
(() => {
  const pick = (sel) => document.querySelector(sel);
  const text = (sel) => (pick(sel)?.textContent || '').trim();
  const firstText = (selectors) => {
    for (const sel of selectors) {
      const value = text(sel);
      if (value) return value;
    }
    return '';
  };
  const meta = (name) => (document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]')?.content || '').trim();
  const stripSite = (value) => {
    const cleaned = (value || '').replace(/\s*[-_]\s*小红书.*$/, '').trim();
    if (!cleaned || /^小红书/.test(cleaned) || /生活兴趣社区/.test(cleaned)) return '';
    return cleaned;
  };
  let title = stripSite(text('#detail-title'))
    || stripSite(text('.note-content .title'))
    || stripSite(text('h1'))
    || stripSite(meta('og:title'))
    || stripSite(text('[class*="noteTitle"], [class*="note-title"]'))
    || '';
  if (!title) {
    const noteText = ((document.querySelector('#detail-desc, .note-content') || {}).innerText || '').trim();
    title = noteText.split('\n').map((line) => line.trim()).find((line) => line.length >= 4) || '';
    title = stripSite(title.slice(0, 40));
  }
  if (!title) title = stripSite(document.title);

  const description = (
    firstText(['#detail-desc', '.note-content .desc', '.desc', '[class*="desc"]'])
    || meta('og:description')
    || meta('description')
  ).trim();
  const author = (
    firstText(['.author-wrapper .username', '.author .name', '.author-container .name', '.username'])
    || meta('author')
  ).trim();

  // 标签：正文里的 # 开头链接 / search_result 链接。
  const tagKeys = new Set();
  const tags = [];
  const tagNodes = Array.from(document.querySelectorAll('#detail-desc a, .note-content a, .desc a, a[href*="search_result"], a[href*="keyword="]'));
  for (const node of tagNodes) {
    const raw = (node.textContent || '').trim();
    if (!raw.startsWith('#')) continue;
    const tag = '#' + raw.replace(/^#+/, '');
    if (tag.length < 2 || tagKeys.has(tag)) continue;
    tagKeys.add(tag);
    tags.push(tag);
    if (tags.length >= 10) break;
  }

  // 图片：src / data-src / srcset 第一项；按去 query 的路径去重。
  const imageKeys = new Set();
  const imageUrls = [];
  const isPlaceholderUrl = (url) => /^(data|blob):/i.test(url) || /placeholder|spacer|blank\.(gif|png)/i.test(url);
  const looksLikeIcon = (url) => /(avatar|emoji|icon|feeds\/|comment|static|fe-platform|guide|logo|sprite|watermark)/i.test(url);
  const resolveImage = (image) => {
    const src = image.currentSrc || image.src || '';
    const data = image.getAttribute('data-src') || '';
    const srcset = image.getAttribute('srcset') || '';
    const first = ((srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '');
    return [src, data, first].find((value) => /^https?:/.test(value) && !isPlaceholderUrl(value)) || '';
  };
  const isTinyPlaceholder = (image) => {
    try {
      if (!image.complete) return false; // 还没加载完：保留 URL，交给上层判断
      return image.naturalWidth <= 1 || image.naturalHeight <= 1;
    } catch (e) {
      return false;
    }
  };
  const collectImage = (image) => {
    if (!image) return;
    const url = resolveImage(image);
    if (!url || looksLikeIcon(url)) return;
    if (isTinyPlaceholder(image)) return;
    const key = url.split('?')[0].split('#')[0];
    if (imageKeys.has(key)) return;
    imageKeys.add(key);
    imageUrls.push(url);
  };
  for (const image of document.querySelectorAll('.note-slider img, .swiper-slide img, .media-container img, #noteContainer img, .note-content img, picture source')) {
    if (image.tagName === 'SOURCE') {
      const srcset = image.getAttribute('srcset') || '';
      const first = ((srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '');
      if (/^https?:/.test(first) && !isPlaceholderUrl(first) && !looksLikeIcon(first)) {
        const key = first.split('?')[0].split('#')[0];
        if (!imageKeys.has(key)) {
          imageKeys.add(key);
          imageUrls.push(first);
        }
      }
    } else {
      collectImage(image);
    }
    if (imageUrls.length >= 18) break;
  }
  if (imageUrls.length === 0) {
    for (const image of document.querySelectorAll('img')) {
      const src = image.currentSrc || image.src || image.getAttribute('data-src') || '';
      if (/(sns-webpic|sns-img|xhscdn)/i.test(src) && !isPlaceholderUrl(src)) collectImage(image);
      if (imageUrls.length >= 18) break;
    }
  }
  if (imageUrls.length === 0) {
    const og = meta('og:image');
    if (/^https?:/.test(og) && !isPlaceholderUrl(og)) imageUrls.push(og);
  }

  const video = document.querySelector('video');
  const bodyText = (document.body?.innerText || '').slice(0, 4000);

  const parseCount = (value) => {
    if (!value) return 0;
    const cleaned = value.replace(/[+＋\s]/g, '');
    const number = parseFloat(cleaned);
    if (!Number.isFinite(number)) return 0;
    if (/[wW万]/.test(cleaned)) return Math.round(number * 10000);
    if (/[kK千]/.test(cleaned)) return Math.round(number * 1000);
    return Math.round(number);
  };
  const likeText = firstText([
    '.like-wrapper .count',
    '.interact-container .count',
    '[class*="like"] .count',
    '[data-testid*="like"] .count',
    '.like .count',
  ]);
  const collectText = firstText([
    '.collect-wrapper .count',
    '.interact-container .count',
    '[class*="collect"] .count',
    '[class*="star"] .count',
    '.collect .count',
  ]);

  const pad = (value) => String(value).padStart(2, '0');
  const parseDateText = (raw) => {
    const value = (raw || '').trim();
    if (!value) return 0;
    const now = Date.now();
    if (/刚刚/.test(value)) return Math.floor(now / 1000);
    let match = value.match(/(\d+)\s*分钟前/);
    if (match) return Math.floor((now - Number(match[1]) * 60000) / 1000);
    match = value.match(/(\d+)\s*小时前/);
    if (match) return Math.floor((now - Number(match[1]) * 3600000) / 1000);
    if (/昨天/.test(value)) {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      date.setHours(0, 0, 0, 0);
      return Math.floor(date.getTime() / 1000);
    }
    match = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Math.floor(date.getTime() / 1000);
    }
    match = value.match(/(\d{1,2})[-/.月](\d{1,2})/);
    if (match) {
      const nowDate = new Date();
      const date = new Date(nowDate.getFullYear(), Number(match[1]) - 1, Number(match[2]));
      if (date.getTime() > now + 86400000) date.setFullYear(date.getFullYear() - 1);
      return Math.floor(date.getTime() / 1000);
    }
    return 0;
  };
  const dateText = firstText(['.date', '.bottom-container .date', 'time', '[class*="date"]']);
  const publishedAt = parseDateText(dateText) || parseDateText(bodyText);
  const tokenMatch = location.search.match(/[?&]xsec_token=([^&#]+)/);

  return {
    itemId: (location.pathname.match(/\/explore\/([0-9a-zA-Z]+)/) || location.pathname.match(/\/discovery\/item\/([0-9a-zA-Z]+)/) || [])[1] || '',
    title, description, author,
    durationSeconds: Number.isFinite(video?.duration) ? Math.round(video.duration) : 0,
    positionSeconds: Number.isFinite(video?.currentTime) ? Math.round(video.currentTime) : 0,
    playing: !!video && !video.paused && !video.ended,
    visible: document.visibilityState === 'visible',
    tags, liked: false, favorited: false, coinOrShare: false,
    commentSeconds: 0, authorClicked: false, seekBack: false, visits: 0,
    url: location.href,
    imageUrls, noteType: video ? 'video' : 'image',
    likeCount: parseCount(likeText), collectCount: parseCount(collectText),
    publishedAt,
    xsecToken: tokenMatch ? decodeURIComponent(tokenMatch[1]) : '',
    coverUrl: imageUrls[0] || (/^https?:/.test(meta('og:image')) ? meta('og:image') : ''),
    loginVisible: !!pick('.login-container, .login-mask, .sign-container') || /登录后查看|请先登录/.test(bodyText.slice(0, 800)),
    captchaVisible: (() => {
      const node = pick('.captcha, [class*="captcha"], .geetest_panel, iframe[src*="captcha" i]');
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })(),
    // 风控只认具体短语，避免正文里普通「验证」二字误判成风控。
    riskBanner: /(当前账号存在异常|账号存在异常|访问频繁|操作过于频繁|请完成安全验证|安全验证|滑块验证|完成验证后继续)/.test(bodyText.slice(0, 2000)),
    onFeed: /^\/(explore|discovery)?\/?$/.test(location.pathname)
  };
})()
"#;

/// 小红书 feed 候选：**必须带 xsec_token 的 /explore/<id> 链接**（裸链接会 403）。
/// 返回 {urls:[完整链接…]}，Rust 侧按 noteId 去重后逐条 Page.navigate。
const XIAOHONGSHU_CANDIDATES: &str = r#"
(() => {
  const out = { urls: [] };
  const add = (raw) => {
    if (!raw) return;
    try {
      const url = new URL(raw, location.origin);
      if (!/\/explore\/[0-9a-zA-Z]{20,32}/.test(url.pathname) && !/\/discovery\/item\/[0-9a-zA-Z]{20,32}/.test(url.pathname)) return;
      if (!/[?&]xsec_token=/.test(url.search)) return; // 没 token 的裸链接会 403，直接丢
      url.hash = '';
      const full = url.toString();
      if (!out.urls.includes(full) && out.urls.length < 60) out.urls.push(full);
    } catch (e) {}
  };
  const feedUrl = (id, token) => '/explore/' + id + '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_feed';
  try {
    const state = window.__INITIAL_STATE__ || {};
    const feeds = (state.feed && (state.feed.feeds || state.feed.value)) || state.feeds || [];
    if (Array.isArray(feeds)) {
      for (const item of feeds.slice(0, 80)) {
        const note = item?.noteCard || item?.note || item;
        const id = note?.noteId || note?.note_id || item?.id;
        const token = item?.xsecToken || item?.xsec_token || note?.xsecToken || note?.xsec_token;
        if (typeof id === 'string' && /^[0-9a-zA-Z]{20,32}$/.test(id) && typeof token === 'string' && token) {
          add(feedUrl(id, token));
        }
      }
    }
    // 深度兜底：state 里任意对象同时带 noteId + xsecToken 就收
    const visited = new Set();
    let budget = 3000;
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 6 || budget <= 0) return;
      if (visited.has(node)) return;
      visited.add(node);
      budget -= 1;
      const id = node.noteId || node.note_id;
      const token = node.xsecToken || node.xsec_token;
      if (typeof id === 'string' && /^[0-9a-zA-Z]{20,32}$/.test(id) && typeof token === 'string' && token) {
        add(feedUrl(id, token));
      }
      for (const key in node) {
        if (key === 'noteCard' || key === 'note' || Array.isArray(node[key]) || typeof node[key] === 'object') {
          walk(node[key], depth + 1);
        }
      }
    })(state, 0);
  } catch (e) {}
  for (const link of document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')) {
    if (out.urls.length >= 60) break;
    add(link.getAttribute('href') || '');
  }
  return out;
})()
"#;

pub struct BilibiliAdapter;
pub struct XiaohongshuAdapter;
pub struct DouyinAdapter;

pub static BILIBILI: BilibiliAdapter = BilibiliAdapter;
pub static DOUYIN: DouyinAdapter = DouyinAdapter;
pub static XIAOHONGSHU: XiaohongshuAdapter = XiaohongshuAdapter;

impl PlatformAdapter for BilibiliAdapter {
    fn id(&self) -> Platform {
        Platform::Bilibili
    }

    fn feed_url(&self) -> &'static str {
        Platform::Bilibili.feed_url()
    }

    fn extract_script(&self) -> &'static str {
        BILIBILI_EXTRACT
    }

    fn candidate_script(&self) -> &'static str {
        BILIBILI_CANDIDATES
    }

    fn interact_script(&self, action: InteractAction) -> Option<&'static str> {
        match action {
            InteractAction::Like => Some(BILIBILI_LIKE),
            InteractAction::Favorite => Some(BILIBILI_FAVORITE),
        }
    }

    fn classify_page(&self, facts: &PageFacts) -> PageKind {
        classify_hints(facts)
    }
}

impl PlatformAdapter for DouyinAdapter {
    fn id(&self) -> Platform {
        Platform::Douyin
    }

    fn feed_url(&self) -> &'static str {
        Platform::Douyin.feed_url()
    }

    fn extract_script(&self) -> &'static str {
        DOUYIN_EXTRACT
    }

    fn candidate_script(&self) -> &'static str {
        DOUYIN_CANDIDATES
    }

    fn interact_script(&self, action: InteractAction) -> Option<&'static str> {
        // 抖音本期只做采集，不提供自动互动脚本。
        let _ = action;
        None
    }

    fn classify_page(&self, facts: &PageFacts) -> PageKind {
        classify_hints(facts)
    }
}

/// 小红书登录探针：三级判定（URL 重定向 / 登录用户标识 / 登录弹窗遮罩）。
/// 只有「无用户标识 + 弹窗可见」才算登录墙，避免把登录按钮容器误判成未登录。
const XIAOHONGSHU_LOGIN_PROBE: &str = r#"
(function () {
  const href = location.href;
  const redirected = /\/login\b|redirectPath=/i.test(href);
  let userId = '';
  let nickname = '';
  try {
    const state = window.__INITIAL_STATE__ || {};
    const user = state.user || {};
    userId = String(user.userId || user.user_id || (user.userInfo && user.userInfo.userId) || '');
    nickname = String(user.nickname || user.nickName || user.name || (user.userInfo && user.userInfo.nickname) || '');
  } catch (e) {
    nickname = '';
  }
  try {
    if (!nickname) {
      const nameNode = document.querySelector('.user .name, .user .username, .user-info .name');
      nickname = ((nameNode && nameNode.textContent) || '').trim();
    }
  } catch (e) {}
  let hasAvatar = Boolean(userId);
  try {
    const avatar = document.querySelector('.user .avatar, .user .avatar img, .user-info, [class*="user-avatar"], [class*="avatar-wrapper"] img');
    if (avatar) {
      const box = avatar.getBoundingClientRect();
      hasAvatar = hasAvatar || (box.width > 4 && box.height > 4);
    }
  } catch (e) {}
  let loginModal = false;
  try {
    const nodes = Array.from(document.querySelectorAll('.login-container, .login-mask, [class*="login-modal"], .mask'));
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      if (box.width <= 40 || box.height <= 40) continue;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.05) continue;
      const input = node.querySelector('input');
      if (input && input.getBoundingClientRect().width > 20) { loginModal = true; break; }
    }
  } catch (e) {}
  return {
    href,
    redirected,
    hasAvatar,
    userId,
    nickname,
    loginModal,
    loginWall: redirected || (!hasAvatar && loginModal),
  };
})()
"#;

impl PlatformAdapter for XiaohongshuAdapter {
    fn id(&self) -> Platform {
        Platform::Xiaohongshu
    }

    fn feed_url(&self) -> &'static str {
        Platform::Xiaohongshu.feed_url()
    }

    fn extract_script(&self) -> &'static str {
        XIAOHONGSHU_EXTRACT
    }

    fn candidate_script(&self) -> &'static str {
        XIAOHONGSHU_CANDIDATES
    }

    fn interact_script(&self, action: InteractAction) -> Option<&'static str> {
        // 小红书本期只读采集，不做点赞/收藏。
        let _ = action;
        None
    }

    fn classify_page(&self, facts: &PageFacts) -> PageKind {
        classify_hints(facts)
    }

    fn login_probe_script(&self) -> Option<&'static str> {
        Some(XIAOHONGSHU_LOGIN_PROBE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::extract::{normalize_facts, RawFacts};

    fn facts(hints: crate::video::extract::PageHints) -> PageFacts {
        let raw = RawFacts {
            title: "标题".to_string(),
            url: "https://www.bilibili.com/video/BV1".to_string(),
            on_feed: hints.on_feed,
            login_visible: hints.login_visible,
            captcha_visible: hints.captcha_visible,
            risk_banner: hints.risk_banner,
            ..RawFacts::default()
        };
        let mut facts = normalize_facts(raw, Platform::Bilibili, 1.0).expect("facts");
        facts.hints = hints;
        facts
    }

    #[test]
    fn classifies_four_page_kinds() {
        let adapter = adapter_for(Platform::Bilibili);
        assert_eq!(
            adapter.classify_page(&facts(Default::default())),
            PageKind::Feed
        );
        assert_eq!(
            adapter.classify_page(&facts(crate::video::extract::PageHints {
                login_visible: true,
                ..Default::default()
            })),
            PageKind::Login
        );
        assert_eq!(
            adapter.classify_page(&facts(crate::video::extract::PageHints {
                captcha_visible: true,
                ..Default::default()
            })),
            PageKind::RiskControl
        );
        let mut other = facts(Default::default());
        other.canonical_url = Some("https://example.com/x".to_string());
        other.hints.on_feed = false;
        assert_eq!(adapter.classify_page(&other), PageKind::Other);
    }

    #[test]
    fn scripts_stay_within_budget() {
        for adapter in [adapter_for(Platform::Bilibili), adapter_for(Platform::Douyin)] {
            assert!(adapter.extract_script().len() < 4096);
            assert!(adapter.candidate_script().len() < 4096);
            assert!(adapter.extract_script().contains("description"));
            // 稳定性改造后不再点击卡片/滚轮翻页，候选脚本只抓链接。
            assert!(!adapter.candidate_script().contains(".click("));
            assert!(!adapter.candidate_script().contains("scrollBy"));
            assert!(adapter.candidate_script().contains("hrefs"));
        }
        let xhs = adapter_for(Platform::Xiaohongshu);
        assert!(xhs.extract_script().contains("imageUrls"));
        assert!(xhs.extract_script().contains("xsecToken"));
        assert!(xhs.candidate_script().contains("xsec_token"));
        assert!(xhs.candidate_script().len() < 4096);
        assert!(!xhs.candidate_script().contains(".click("));
    }

    #[test]
    fn bilibili_candidate_script_reads_initial_state_first() {
        let script = adapter_for(Platform::Bilibili).candidate_script();
        assert!(script.contains("__INITIAL_STATE__"));
        assert!(script.contains("recommendList"));
        assert!(script.contains("a[href*=\"/video/BV\"]"));
    }

    #[test]
    fn douyin_has_no_interact_scripts() {
        let adapter = adapter_for(Platform::Douyin);
        assert!(adapter.interact_script(InteractAction::Like).is_none());
    }
}
