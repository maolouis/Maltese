//! 候选视频队列：批量取链接 → 去重 → 逐条直接导航。
//!
//! 刷视频不稳定的根因是「点击卡片 / 滚轮翻页」：页面自己会跳回首页，
//! 导航目标也不受控。这里改成确定性路线：
//! 1. 从页面数据源一次性抓 N 条 `/video/` 链接（`__INITIAL_STATE__` 优先，DOM 链接兜底）；
//! 2. 每条 URL 只做 `Page.navigate`，轮询 `location.href` 命中 bvid 后才算采集；
//! 3. 失败计连败，连败 2 次拉黑，不再反复撞同一堵墙。
//!
//! 本模块是纯逻辑（无 I/O、无 tokio），便于单测。

use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use super::model::Platform;

/// 单次补货最多接收多少条候选（页面数据源一般能给出 20–50 条）。
pub const MAX_CANDIDATES_PER_FILL: usize = 50;
/// 队列低于这个值就补货，保证连续采集时队列不会断流。
pub const REFILL_THRESHOLD: usize = 8;
/// 同一条 URL 连续失败到这个次数就拉黑。
pub const BLACKLIST_AFTER_FAILURES: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedCandidate {
    pub id: String,
    pub url: String,
}

/// 从任意写法里归一化出内容 id（B 站 `BV1xx…`/`av123`、抖音 `123456`、小红书 24 位 hex）。
pub fn normalize_video_id(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.len() < 2 || value.len() > 32 {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("bv") {
        let rest = &value[2..];
        if rest.len() >= 8 && rest.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Some(format!("BV{rest}"));
        }
        return None;
    }
    if lower.starts_with("av") {
        let rest = &value[2..];
        if !rest.is_empty() && rest.len() <= 12 && rest.chars().all(|ch| ch.is_ascii_digit()) {
            return Some(format!("av{rest}"));
        }
        return None;
    }
    if value.len() >= 5 && value.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(value.to_string());
    }
    // 小红书 noteId：24 位左右 hex（也允许字母数字混排，长度 20–32）。
    if (20..=32).contains(&value.len()) && value.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return Some(value.to_string());
    }
    None
}

/// 从 URL（含 `?spm_id_from=…`、`#reply`、相对路径）里取视频 id。
pub fn video_id_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    for marker in ["/video/", "/explore/", "/discovery/item/"] {
        if let Some(position) = lower.find(marker) {
            let rest = &url[position + marker.len()..];
            let segment = rest.split(['/', '?', '#']).next().unwrap_or("");
            if let Some(id) = normalize_video_id(segment) {
                return Some(id);
            }
        }
    }
    None
}

/// 归一化成可稳定直接导航的详情页 URL（去掉 query / fragment）。
pub fn canonical_video_url(id: &str, platform: Platform) -> Option<String> {
    let id = normalize_video_id(id)?;
    let host = match platform {
        Platform::Bilibili => "https://www.bilibili.com/video/",
        Platform::Douyin => "https://www.douyin.com/video/",
        Platform::Xiaohongshu => "https://www.xiaohongshu.com/explore/",
    };
    Some(format!("{host}{id}"))
}

/// 当前页面是否命中期望视频：只比较视频 id，忽略 query / fragment / 末尾斜杠。
/// `expected` 既可以是 bvid（`BV1xx…`），也可以是完整 URL。
pub fn url_matches_video_id(actual: &str, expected: &str) -> bool {
    let Some(expected) = normalize_video_id(expected).or_else(|| video_id_from_url(expected)) else {
        return false;
    };
    video_id_from_url(actual).map(|id| id == expected).unwrap_or(false)
}

/// 站点级标题（首页/错误页），不是视频标题。
pub fn is_site_title(title: &str) -> bool {
    let text = title.trim();
    if text.is_empty() {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    if lower == "bilibili" || text == "哔哩哔哩" || text == "哔哩哔哩_bilibili" {
        return true;
    }
    if text.contains("干杯~") && text.chars().count() < 40 {
        return true;
    }
    text == "抖音-记录美好生活" || text == "抖音"
        || text == "小红书" || text == "小红书 - 你的生活兴趣社区"
}

/// 页面探针（CDP `Runtime.evaluate` 返回值）。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageProbe {
    pub href: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub has_video: bool,
    #[serde(default)]
    pub og_title: String,
}

impl PageProbe {
    /// 加载完成的判定：URL 命中该 bvid + 标题不是站点标题 + 有 video 元素或 og:title。
    pub fn is_ready(&self, expected_id: &str) -> bool {
        url_matches_video_id(&self.href, expected_id)
            && !is_site_title(&self.title)
            && (self.has_video || !self.og_title.trim().is_empty())
    }
}

/// 队列兜底页：队列见底时先回这些页面重新抓链接（不点卡片）。
pub fn fallback_candidate_pages(platform: Platform) -> &'static [&'static str] {
    match platform {
        Platform::Bilibili => &[
            "https://www.bilibili.com/v/popular/all",
            "https://www.bilibili.com/v/popular/rank/all",
        ],
        Platform::Douyin => &["https://www.douyin.com/"],
        Platform::Xiaohongshu => &["https://www.xiaohongshu.com/explore"],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureOutcome {
    /// 还没到拉黑阈值，之后补货时仍可重试。
    Retry(u32),
    /// 连续失败达到阈值：丢弃并拉黑。
    Blacklisted(u32),
}

/// 候选队列：待导航 + 已采集合 + 失败计数 + 黑名单。
#[derive(Default)]
pub struct CandidateQueue {
    pending: VecDeque<QueuedCandidate>,
    /// 当前队列里已经有的 id（出队即移除，失败过的 URL 之后补货还能回来重试）。
    queued: HashSet<String>,
    collected: HashSet<String>,
    failures: HashMap<String, u32>,
    blacklist: HashSet<String>,
}

impl CandidateQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// 批量入队，返回真正新增的条数（已采/已拉黑/已在队列里的会跳过）。
    pub fn push_candidates(&mut self, candidates: Vec<QueuedCandidate>) -> usize {
        let mut added = 0usize;
        for candidate in candidates {
            if self.pending.len() >= MAX_CANDIDATES_PER_FILL {
                break;
            }
            if self.collected.contains(&candidate.id)
                || self.blacklist.contains(&candidate.id)
                || self.queued.contains(&candidate.id)
            {
                continue;
            }
            self.queued.insert(candidate.id.clone());
            self.pending.push_back(candidate);
            added += 1;
        }
        added
    }

    /// 取队首；已采/已拉黑的残留项直接跳过。
    pub fn next_candidate(&mut self) -> Option<QueuedCandidate> {
        while let Some(candidate) = self.pending.pop_front() {
            self.queued.remove(&candidate.id);
            if self.collected.contains(&candidate.id) || self.blacklist.contains(&candidate.id) {
                continue;
            }
            return Some(candidate);
        }
        None
    }

    /// 把一条候选塞回队首（登录墙等「这条还没试完」的场景）。
    pub fn requeue(&mut self, candidate: QueuedCandidate) {
        if self.collected.contains(&candidate.id) || self.blacklist.contains(&candidate.id) {
            return;
        }
        if !self.queued.insert(candidate.id.clone()) {
            return;
        }
        self.pending.push_front(candidate);
    }

    pub fn mark_collected(&mut self, id: &str) {
        if let Some(id) = normalize_video_id(id) {
            self.failures.remove(&id);
            self.collected.insert(id);
        }
    }

    pub fn record_failure(&mut self, id: &str) -> FailureOutcome {
        let Some(id) = normalize_video_id(id) else {
            return FailureOutcome::Retry(1);
        };
        let count = self.failures.entry(id.clone()).or_insert(0);
        *count = count.saturating_add(1);
        let count = *count;
        if count >= BLACKLIST_AFTER_FAILURES {
            self.blacklist.insert(id);
            FailureOutcome::Blacklisted(count)
        } else {
            FailureOutcome::Retry(count)
        }
    }

    pub fn failure_count(&self, id: &str) -> u32 {
        normalize_video_id(id)
            .and_then(|id| self.failures.get(&id).copied())
            .unwrap_or(0)
    }

    pub fn is_blacklisted(&self, id: &str) -> bool {
        normalize_video_id(id)
            .map(|id| self.blacklist.contains(&id))
            .unwrap_or(false)
    }

    pub fn remaining(&self) -> usize {
        self.pending.len()
    }

    pub fn collected_count(&self) -> usize {
        self.collected.len()
    }

    pub fn blacklist_len(&self) -> usize {
        self.blacklist.len()
    }

    /// 队首前 3 条，用于 `CANDIDATES` 日志抽样。
    pub fn sample(&self, limit: usize) -> Vec<String> {
        self.pending
            .iter()
            .take(limit)
            .map(|candidate| candidate.url.clone())
            .collect()
    }
}

/// 把页面脚本返回的 `{state:[bvid…], hrefs:[…]}` 转成有序候选：
/// `__INITIAL_STATE__` 优先，DOM 链接兜底，最后按 id 去重。
/// 把页面给的相对链接补成绝对地址（保留 query；去掉 fragment）。
fn absolute_url(raw: &str, platform: Platform) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    if without_fragment.starts_with("http://") || without_fragment.starts_with("https://") {
        return Some(without_fragment.to_string());
    }
    if !without_fragment.starts_with('/') {
        return None;
    }
    let host = match platform {
        Platform::Bilibili => "https://www.bilibili.com",
        Platform::Douyin => "https://www.douyin.com",
        Platform::Xiaohongshu => "https://www.xiaohongshu.com",
    };
    Some(format!("{host}{without_fragment}"))
}

/// 解析页面候选：`state`（裸 id）→ `urls`（带 xsec_token 的完整链接，小红书必须用这个）
/// → `hrefs`（DOM 链接兜底）。按内容 id 去重。
pub fn parse_candidates(payload: &Value, platform: Platform) -> Vec<QueuedCandidate> {
    let mut result: Vec<QueuedCandidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |id: String, url: String| {
        if seen.contains(&id) {
            return;
        }
        seen.insert(id.clone());
        result.push(QueuedCandidate { id, url });
    };

    if let Some(list) = payload.get("state").and_then(Value::as_array) {
        for value in list {
            if let Some(raw) = value.as_str() {
                if let Some(id) = normalize_video_id(raw) {
                    if let Some(url) = canonical_video_url(&id, platform) {
                        push(id, url);
                    }
                }
            }
        }
    }
    if let Some(list) = payload.get("urls").and_then(Value::as_array) {
        for value in list {
            if let Some(raw) = value.as_str() {
                if let (Some(id), Some(url)) = (video_id_from_url(raw), absolute_url(raw, platform)) {
                    push(id, url);
                }
            }
        }
    }
    if let Some(list) = payload.get("hrefs").and_then(Value::as_array) {
        for value in list {
            if let Some(raw) = value.as_str() {
                if let Some(id) = video_id_from_url(raw) {
                    let url = absolute_url(raw, platform)
                        .or_else(|| canonical_video_url(&id, platform));
                    if let Some(url) = url {
                        push(id, url);
                    }
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_id_from_urls_with_query_and_fragment() {
        assert_eq!(
            video_id_from_url("https://www.bilibili.com/video/BV1hXWP6dEVL/?spm_id_from=333.788&vd_source=abc"),
            Some("BV1hXWP6dEVL".to_string())
        );
        assert_eq!(
            video_id_from_url("/video/BV1JNsr67EbT#reply"),
            Some("BV1JNsr67EbT".to_string())
        );
        assert_eq!(
            video_id_from_url("https://www.bilibili.com/video/av123456/"),
            Some("av123456".to_string())
        );
        assert_eq!(
            video_id_from_url("https://www.douyin.com/video/730123456789"),
            Some("730123456789".to_string())
        );
        assert_eq!(video_id_from_url("https://www.bilibili.com/"), None);
        assert_eq!(video_id_from_url("https://www.bilibili.com/video/BV1"), None);
    }

    #[test]
    fn url_match_ignores_query_and_trailing_slash() {
        assert!(url_matches_video_id(
            "https://www.bilibili.com/video/BV1hXWP6dEVL/?spm_id_from=333.788.playrecommendByOp.0&vd_source=x",
            "BV1hXWP6dEVL"
        ));
        assert!(url_matches_video_id(
            "https://www.bilibili.com/video/BV1hXWP6dEVL",
            "https://www.bilibili.com/video/BV1hXWP6dEVL/?spm_id_from=1"
        ));
        assert!(!url_matches_video_id(
            "https://www.bilibili.com/video/BV1other000/",
            "BV1hXWP6dEVL"
        ));
        assert!(!url_matches_video_id("https://www.bilibili.com/", "BV1hXWP6dEVL"));
    }

    #[test]
    fn candidates_keep_state_before_links_and_dedupe() {
        let payload = json!({
            "state": ["BV1stateA000", "BV1shared00", "", "not-an-id"],
            "hrefs": [
                "/video/BV1shared00/?spm_id_from=1",
                "/video/BV1linkB000/",
                "https://www.bilibili.com/video/BV1stateA000/?spm=2",
                "https://www.bilibili.com/v/",
            ],
        });
        let candidates = parse_candidates(&payload, Platform::Bilibili);
        let ids: Vec<&str> = candidates.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["BV1stateA000", "BV1shared00", "BV1linkB000"]);
        assert_eq!(
            candidates[0].url,
            "https://www.bilibili.com/video/BV1stateA000"
        );
    }

    #[test]
    fn queue_dedupes_and_skips_collected() {
        let mut queue = CandidateQueue::new();
        let first = parse_candidates(
            &json!({"state": ["BV1aaa00000", "BV1bbb00000"], "hrefs": ["/video/BV1aaa00000/"]}),
            Platform::Bilibili,
        );
        assert_eq!(queue.push_candidates(first), 2);
        assert_eq!(queue.remaining(), 2);

        // 同一批再推一次不重复入队。
        let again = parse_candidates(
            &json!({"state": ["BV1aaa00000", "BV1bbb00000"]}),
            Platform::Bilibili,
        );
        assert_eq!(queue.push_candidates(again), 0);

        let head = queue.next_candidate().expect("head");
        assert_eq!(head.id, "BV1aaa00000");
        queue.mark_collected(&head.id);
        assert_eq!(queue.collected_count(), 1);

        // 已采的不会再被补货回来。
        let refill = parse_candidates(
            &json!({"state": ["BV1aaa00000", "BV1ccc00000"]}),
            Platform::Bilibili,
        );
        assert_eq!(queue.push_candidates(refill), 1);
        assert_eq!(queue.next_candidate().map(|c| c.id), Some("BV1bbb00000".to_string()));
        assert_eq!(queue.next_candidate().map(|c| c.id), Some("BV1ccc00000".to_string()));
    }

    #[test]
    fn two_consecutive_failures_blacklist_url() {
        let mut queue = CandidateQueue::new();
        queue.push_candidates(parse_candidates(
            &json!({"state": ["BV1bad00000"]}),
            Platform::Bilibili,
        ));
        // 与真实流程一致：先出队再导航，失败后这条 URL 已经不在队列里。
        assert_eq!(
            queue.next_candidate().map(|candidate| candidate.id),
            Some("BV1bad00000".to_string())
        );
        assert_eq!(queue.remaining(), 0);
        assert_eq!(queue.record_failure("BV1bad00000"), FailureOutcome::Retry(1));
        assert_eq!(queue.failure_count("BV1bad00000"), 1);
        assert!(!queue.is_blacklisted("BV1bad00000"));
        // 失败一次后补货还能回来重试（连败 2 次才拉黑）。
        assert_eq!(
            queue.push_candidates(parse_candidates(
                &json!({"state": ["BV1bad00000"]}),
                Platform::Bilibili
            )),
            1
        );
        assert_eq!(queue.remaining(), 1);
        assert_eq!(
            queue.next_candidate().map(|candidate| candidate.id),
            Some("BV1bad00000".to_string())
        );
        assert_eq!(
            queue.record_failure("BV1bad00000"),
            FailureOutcome::Blacklisted(2)
        );
        assert!(queue.is_blacklisted("BV1bad00000"));
        // 拉黑后再补货不会回队。
        assert_eq!(
            queue.push_candidates(parse_candidates(
                &json!({"state": ["BV1bad00000"]}),
                Platform::Bilibili
            )),
            0
        );
        assert_eq!(queue.remaining(), 0);
    }

    #[test]
    fn success_resets_failure_counter() {
        let mut queue = CandidateQueue::new();
        queue.record_failure("BV1flaky0000");
        assert_eq!(queue.failure_count("BV1flaky0000"), 1);
        queue.mark_collected("BV1flaky0000");
        assert_eq!(queue.failure_count("BV1flaky0000"), 0);
        assert!(!queue.is_blacklisted("BV1flaky0000"));
    }

    #[test]
    fn next_candidate_skips_stale_entries() {
        let mut queue = CandidateQueue::new();
        queue.push_candidates(parse_candidates(
            &json!({"state": ["BV1aaa00000", "BV1bbb00000"], "hrefs": ["/video/BV1ccc00000/"]}),
            Platform::Bilibili,
        ));
        // 模拟「已经采过 / 已拉黑」但还留在队列里的残留项。
        queue.mark_collected("BV1aaa00000");
        queue.record_failure("BV1bbb00000");
        queue.record_failure("BV1bbb00000");
        assert_eq!(queue.next_candidate().map(|c| c.id), Some("BV1ccc00000".to_string()));
        assert!(queue.next_candidate().is_none());
    }

    #[test]
    fn page_ready_requires_video_or_og_title_and_real_title() {
        let ready = PageProbe {
            href: "https://www.bilibili.com/video/BV1hXWP6dEVL/?spm_id_from=1".to_string(),
            title: "【英雄联盟】S16 决赛".to_string(),
            has_video: true,
            og_title: String::new(),
        };
        assert!(ready.is_ready("BV1hXWP6dEVL"));

        let og_only = PageProbe {
            has_video: false,
            og_title: "【英雄联盟】S16 决赛".to_string(),
            ..ready.clone()
        };
        assert!(og_only.is_ready("BV1hXWP6dEVL"));

        let site = PageProbe {
            title: "哔哩哔哩 (゜-゜)つロ 干杯~-bilibili".to_string(),
            ..ready.clone()
        };
        assert!(!site.is_ready("BV1hXWP6dEVL"));

        let empty = PageProbe {
            title: "视频".to_string(),
            has_video: false,
            og_title: String::new(),
            ..ready.clone()
        };
        assert!(!empty.is_ready("BV1hXWP6dEVL"));

        let wrong = PageProbe {
            href: "https://www.bilibili.com/video/BV1other000/".to_string(),
            ..ready
        };
        assert!(!wrong.is_ready("BV1hXWP6dEVL"));
    }

    #[test]
    fn site_titles_are_not_video_titles() {
        assert!(is_site_title(""));
        assert!(is_site_title("哔哩哔哩 (゜-゜)つロ 干杯~-bilibili"));
        assert!(is_site_title("哔哩哔哩_bilibili"));
        assert!(is_site_title("抖音-记录美好生活"));
        assert!(!is_site_title("【英雄联盟】S16 决赛 GEN vs BLG"));
        assert!(!is_site_title("【英雄联盟】S16 决赛_哔哩哔哩_bilibili"));
    }

    #[test]
    fn canonical_urls_are_stable_per_platform() {
        assert_eq!(
            canonical_video_url("BV1hXWP6dEVL", Platform::Bilibili).as_deref(),
            Some("https://www.bilibili.com/video/BV1hXWP6dEVL")
        );
        assert_eq!(
            canonical_video_url("730123456789", Platform::Douyin).as_deref(),
            Some("https://www.douyin.com/video/730123456789")
        );
        assert_eq!(canonical_video_url("bad id", Platform::Bilibili), None);
    }
}