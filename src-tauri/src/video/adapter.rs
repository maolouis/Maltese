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
  const description = (text('#detail-desc') || text('.note-content .desc') || text('.desc') || meta('og:description') || meta('description')).trim();
  const author = (text('.author-wrapper .username') || text('.author .name') || text('.username') || meta('author')).trim();
  const tags = Array.from(document.querySelectorAll('#detail-desc a[href*="search_result"], .note-content a[href*="keyword"], a[href*="search_result?keyword="]'))
    .map((node) => '#' + (node.textContent || '').trim().replace(/^#/, ''))
    .filter((tag) => tag.length > 1)
    .slice(0, 10);
  const seen = new Set();
  const imageUrls = [];
  const looksLikeIcon = (src) => /(avatar|emoji|icon|feeds\/|comment|static|fe-platform|guide|logo|sprite|watermark)/i.test(src);
  const collectImage = (src) => {
    if (!/^https?:/.test(src)) return;
    if (looksLikeIcon(src)) return;
    if (seen.has(src)) return;
    seen.add(src);
    imageUrls.push(src);
  };
  for (const image of document.querySelectorAll('.swiper-slide img, .note-slider img, #noteContainer img, .media-container img, .note-content img')) {
    const src = image.currentSrc || image.src || image.getAttribute('data-src') || '';
    collectImage(src);
    if (imageUrls.length >= 18) break;
  }
  if (imageUrls.length === 0) {
    for (const image of document.querySelectorAll('img')) {
      const src = image.currentSrc || image.src || image.getAttribute('data-src') || '';
      if (/(sns-webpic|sns-img|xhscdn)/i.test(src)) collectImage(src);
      if (imageUrls.length >= 18) break;
    }
  }
  if (imageUrls.length === 0) {
    const og = meta('og:image');
    if (/^https?:/.test(og)) imageUrls.push(og);
  }
  const video = document.querySelector('video');
  const bodyText = (document.body?.innerText || '').slice(0, 4000);
  const countText = (selector) => {
    const node = pick(selector);
    return node ? (node.textContent || '').trim() : '';
  };
  const likeText = countText('.like-wrapper .count') || countText('[class*="like"] .count');
  const collectText = countText('.collect-wrapper .count') || countText('[class*="collect"] .count');
  const parseCount = (value) => {
    if (!value) return 0;
    const number = parseFloat(value);
    if (!Number.isFinite(number)) return 0;
    if (/[wW万]/.test(value)) return Math.round(number * 10000);
    if (/[kK千]/.test(value)) return Math.round(number * 1000);
    return Math.round(number);
  };
  let publishedAt = 0;
  const dateMatch = bodyText.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dateMatch) {
    const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
    publishedAt = Math.floor(date.getTime() / 1000);
  }
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
    captchaVisible: !!pick('.captcha, [class*="captcha"], .geetest_panel'),
    riskBanner: /(当前账号存在异常|访问频繁|操作过于频繁|验证|风控)/.test(bodyText.slice(0, 2000)),
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
