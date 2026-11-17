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
    fn next_action_script(&self) -> &'static str;
    fn interact_script(&self, action: InteractAction) -> Option<&'static str>;
    fn classify_page(&self, facts: &PageFacts) -> PageKind;
}

pub fn adapter_for(platform: Platform) -> &'static dyn PlatformAdapter {
    match platform {
        Platform::Bilibili => &BILIBILI,
        Platform::Douyin => &DOUYIN,
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
  const title = text('h1.video-title') || text('.video-title') || meta('og:title') || document.title;
  const description = text('.desc-info') || text('.video-desc') || meta('og:description') || meta('description');
  const author = text('.up-name') || text('.username') || meta('author');
  const tags = Array.from(document.querySelectorAll('.tag, .video-tag, a[href*="/search?keyword="]'))
    .map((node) => (node.textContent || '').trim())
    .filter(Boolean).slice(0, 10);
  const video = document.querySelector('video');
  const duration = Number.isFinite(video?.duration) ? Math.round(video.duration) : 0;
  const position = Number.isFinite(video?.currentTime) ? Math.round(video.currentTime) : 0;
  return {
    itemId: location.pathname.match(/\/video\/([^/?#]+|BV[^/?#]+)/)?.[1] || '',
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

const BILIBILI_NEXT: &str = r#"
(() => {
  const visible = (el) => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return box.width > 20 && box.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const detail = /\/video\//.test(location.pathname);
  if (!detail) {
    const seen = window.__malteseOpenedVideoHrefs || (window.__malteseOpenedVideoHrefs = {});
    const links = Array.from(document.querySelectorAll('a[href*="/video/"]'))
      .filter(visible)
      .map((link) => ({ link, href: link.href.split('#')[0] }))
      .filter(({ href }) => href && !seen[href]);
    if (links.length) {
      const target = links[0];
      seen[target.href] = true;
      target.link.click();
      return true;
    }
  }
  if (detail) {
    const nextVideo = document.querySelector('.bpx-player-ctrl-next, .next-button, [aria-label="下一个"]');
    if (nextVideo && visible(nextVideo)) {
      nextVideo.click();
      return true;
    }
    history.back();
    return true;
  }
  const video = document.querySelector('video');
  if (!video) return false;
  const next = document.querySelector('.bpx-player-ctrl-next, .next-button, [aria-label="下一个"]');
  if (next && /下一个|next/i.test((next.getAttribute('aria-label') || next.textContent || ''))) {
    next.click();
    return true;
  }
  window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'smooth' });
  return true;
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

const DOUYIN_NEXT: &str = r#"
(() => {
  const visible = (el) => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return box.width > 20 && box.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const detail = /\/video\//.test(location.pathname);
  if (!detail) {
    const seen = window.__malteseOpenedVideoHrefs || (window.__malteseOpenedVideoHrefs = {});
    const links = Array.from(document.querySelectorAll('a[href*="/video/"]'))
      .filter(visible)
      .map((link) => ({ link, href: link.href.split('#')[0] }))
      .filter(({ href }) => href && !seen[href]);
    if (links.length) {
      const target = links[0];
      seen[target.href] = true;
      target.link.click();
      return true;
    }
  }
  if (detail) {
    const nextVideo = document.querySelector('[data-e2e="video-next"], .arrow-next');
    if (nextVideo && visible(nextVideo)) {
      nextVideo.click();
      return true;
    }
    history.back();
    return true;
  }
  const container = document.querySelector('#slidelist, .slidelist, [data-e2e="feed-list"]');
  if (container) {
    container.scrollBy({ top: Math.round(container.clientHeight * 0.9), behavior: 'smooth' });
    return true;
  }
  const next = document.querySelector('[data-e2e="video-next"], .arrow-next');
  if (next) { next.click(); return true; }
  return false;
})()
"#;

pub struct BilibiliAdapter;
pub struct DouyinAdapter;

pub static BILIBILI: BilibiliAdapter = BilibiliAdapter;
pub static DOUYIN: DouyinAdapter = DouyinAdapter;

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

    fn next_action_script(&self) -> &'static str {
        BILIBILI_NEXT
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

    fn next_action_script(&self) -> &'static str {
        DOUYIN_NEXT
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
            assert!(adapter.next_action_script().len() < 4096);
            assert!(adapter.extract_script().contains("description"));
            assert!(adapter.next_action_script().contains("target.link.click"));
            assert!(adapter.next_action_script().contains("history.back"));
        }
    }

    #[test]
    fn douyin_has_no_interact_scripts() {
        let adapter = adapter_for(Platform::Douyin);
        assert!(adapter.interact_script(InteractAction::Like).is_none());
    }
}
