//! CDP 协议：HTTP 发现 + WebSocket 请求/响应。
//!
//! 直接连接页面 target（`/json/list` 给出的 `webSocketDebuggerUrl`），
//! 不依赖 flatten sessionId；请求串行化，事件消息在同一条连接上被忽略。

use super::model::{FailureReason, Platform};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream,
};

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub const EVALUATE_TIMEOUT: Duration = Duration::from_secs(3);
pub const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(8);
pub const KEY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTarget {
    pub id: String,
    pub url: String,
    pub title: String,
    pub ws_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpProbe {
    pub browser: String,
    pub major: u32,
    pub port: u16,
}

/// 从 `Chrome/131.0.6778.86` 或 `Edg/131.0` 里取主版本。
pub fn parse_major(browser: &str, marker: &str) -> Option<u32> {
    let lower = browser.to_lowercase();
    let position = lower.find(&marker.to_lowercase())?;
    let rest = &browser[position + marker.len()..];
    let digits = rest
        .trim_start_matches(|character: char| !character.is_ascii_digit())
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

pub fn browser_major(browser: &str) -> Option<u32> {
    if browser.to_lowercase().contains("chrome/") {
        parse_major(browser, "Chrome/")
    } else if browser.to_lowercase().contains("edg/") {
        parse_major(browser, "Edg/")
    } else {
        None
    }
}

fn http_client() -> Result<reqwest::Client, FailureReason> {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| FailureReason::NoResponse)
}

pub async fn probe(port: u16) -> Result<CdpProbe, FailureReason> {
    let client = http_client()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|_| FailureReason::NoResponse)?;
    let value: Value = response.json().await.map_err(|_| FailureReason::NoResponse)?;
    let browser = value
        .get("Browser")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let major = browser_major(&browser).ok_or(FailureReason::NoResponse)?;
    Ok(CdpProbe {
        browser,
        major,
        port,
    })
}

pub async fn list_pages(port: u16) -> Result<Vec<PageTarget>, FailureReason> {
    let client = http_client()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|_| FailureReason::NoResponse)?;
    let value: Value = response.json().await.map_err(|_| FailureReason::NoResponse)?;
    let Some(items) = value.as_array() else {
        return Err(FailureReason::ParserMismatch);
    };
    let pages = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("page"))
        .filter_map(|item| {
            Some(PageTarget {
                id: item.get("id")?.as_str()?.to_string(),
                url: item.get("url")?.as_str().unwrap_or_default().to_string(),
                title: item.get("title")?.as_str().unwrap_or_default().to_string(),
                ws_url: item.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
            })
        })
        .collect();
    Ok(pages)
}

/// 四级优先级：平台域非空标题 → 平台域 → about:blank → 任意页面。
pub fn pick_page(pages: &[PageTarget], platform: Platform) -> Option<PageTarget> {
    pages
        .iter()
        .find(|page| page.url.contains("/video/"))
        .or_else(|| {
            pages
                .iter()
                .find(|page| platform.matches_url(&page.url) && !page.title.trim().is_empty())
        })
        .or_else(|| pages.iter().find(|page| platform.matches_url(&page.url)))
        .or_else(|| pages.iter().find(|page| page.url.starts_with("about:blank")))
        .or_else(|| pages.first())
        .cloned()
}

/// 通过 HTTP 打开一个新页面（`background` 由调用方决定是否置前）。
pub async fn open_page(port: u16, platform: Platform, background: bool) -> Result<(), FailureReason> {
    let client = http_client()?;
    let _ = background;
    let url = format!("http://127.0.0.1:{port}/json/new?{}", platform.feed_url());
    let response = client
        .put(url)
        .send()
        .await
        .map_err(|_| FailureReason::NavigationFailed)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(FailureReason::NavigationFailed)
    }
}


/// 某个 CDP 端口是否活着（用于单实例化）。
pub async fn port_alive(port: u16) -> bool {
    let Ok(client) = http_client() else {
        return false;
    };
    match client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

/// 让指定端口的浏览器自己关掉（Browser.close）。返回是否发出成功。
pub async fn shutdown_browser(port: u16) -> bool {
    match CdpSession::connect(port, Platform::Bilibili).await {
        Ok(mut session) => session.request("Browser.close", json!({}), Duration::from_secs(2)).await.is_ok(),
        Err(_) => false,
    }
}

pub struct CdpSession {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: u64,
    port: u16,
    platform: Platform,
    page_id: String,
}

impl CdpSession {
    pub async fn connect(port: u16, platform: Platform) -> Result<Self, FailureReason> {
        let pages = list_pages(port).await?;
        let mut page = pick_page(&pages, platform);
        let needs_new_page = page
            .as_ref()
            .map(|page| {
                let url = page.url.trim();
                url.is_empty()
                    || url.starts_with("about:")
                    || url.starts_with("edge:")
                    || url.starts_with("chrome:")
                    || url.contains("newtab")
            })
            .unwrap_or(true);
        if needs_new_page {
            // WebUI 新标签页（edge://newtab 等）会让 Runtime.evaluate 挂起，
            // 必须新建普通页面再连接。
            let _ = open_page(port, platform, true).await;
            tokio::time::sleep(Duration::from_millis(800)).await;
            let refreshed = list_pages(port).await?;
            page = pick_page(&refreshed, platform);
        }
        let page = page.ok_or(FailureReason::NoResponse)?;
        let (socket, _) = connect_async(&page.ws_url)
            .await
            .map_err(|_| FailureReason::NoResponse)?;
        let mut session = Self {
            socket,
            next_id: 1,
            port,
            platform,
            page_id: page.id,
        };
        // 选中页面后置前，并把 URL 记到 page_id 对应的 target，避免两个实例各看一个 tab。
        let _ = session
            .request("Page.bringToFront", json!({}), Duration::from_secs(2))
            .await;
        Ok(session)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn page_id(&self) -> &str {
        &self.page_id
    }

    /// 读取页面文本（评论回读校验用）。
    pub async fn evaluate_text(&mut self, expression: &str) -> Result<String, String> {
        self.evaluate(expression, EVALUATE_TIMEOUT)
            .await
            .map_err(|error| format!("{error:?}"))
            .map(|value| value.as_str().map(str::to_string).unwrap_or_default())
    }

    /// 当前页的 location.href（导航后校验用）。
    pub async fn current_url(&mut self) -> String {
        self.evaluate("location.href", EVALUATE_TIMEOUT)
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, FailureReason> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let payload = json!({ "id": id, "method": method, "params": params }).to_string();

        let socket = &mut self.socket;
        let result = tokio::time::timeout(timeout, async move {
            socket
                .send(Message::Text(payload.into()))
                .await
                .map_err(|_| FailureReason::NoResponse)?;
            loop {
                let message = socket
                    .next()
                    .await
                    .ok_or(FailureReason::NoResponse)?
                    .map_err(|_| FailureReason::NoResponse)?;
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| FailureReason::ParserMismatch)?;
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if value.get("error").is_some() {
                    return Err(FailureReason::ParserMismatch);
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await;

        match result {
            Ok(inner) => inner,
            Err(_) => Err(FailureReason::ChannelTimeout),
        }
    }

    pub async fn evaluate(&mut self, expression: &str, timeout: Duration) -> Result<Value, FailureReason> {
        let result = self
            .request(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "awaitPromise": true,
                    "returnByValue": true
                }),
                timeout,
            )
            .await?;
        Ok(result
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn navigate(&mut self, url: &str) -> Result<(), FailureReason> {
        let _ = self
            .request("Page.navigate", json!({ "url": url }), NAVIGATE_TIMEOUT)
            .await?;
        Ok(())
    }

    /// 回退路径：把按键发给专用浏览器页面，而不是系统全局。
    pub async fn dispatch_key(&mut self, key: &str) -> Result<(), FailureReason> {
        let (code, key_code) = if key == "ArrowDown" {
            ("ArrowDown", 40)
        } else {
            ("PageDown", 34)
        };
        for event_type in ["keyDown", "keyUp"] {
            let _ = self
                .request(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": event_type,
                        "key": code,
                        "code": code,
                        "windowsVirtualKeyCode": key_code,
                        "nativeVirtualKeyCode": key_code
                    }),
                    KEY_TIMEOUT,
                )
                .await?;
        }
        Ok(())
    }

    /// 用 CDP Input 派发可信点击（合成 el.click() 在 B 站评论发送上会失效）。
    pub async fn click_at(&mut self, x: f64, y: f64) -> Result<(), FailureReason> {
        for event_type in ["mousePressed", "mouseReleased"] {
            let _ = self
                .request(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": event_type,
                        "x": x,
                        "y": y,
                        "button": "left",
                        "clickCount": 1
                    }),
                    KEY_TIMEOUT,
                )
                .await?;
        }
        Ok(())
    }

    /// 用 CDP Input 插入文本（可信事件，小红书 contenteditable 用）。
    pub async fn insert_text(&mut self, text: &str) -> Result<(), FailureReason> {
        let _ = self
            .request(
                "Input.insertText",
                json!({ "text": text }),
                KEY_TIMEOUT,
            )
            .await?;
        Ok(())
    }

    /// 用 CDP Input 派发可信 Ctrl+Enter（B 站评论快捷键）。
    pub async fn press_ctrl_enter(&mut self) -> Result<(), FailureReason> {
        for event_type in ["keyDown", "keyUp"] {
            let _ = self
                .request(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": event_type,
                        "key": "Enter",
                        "code": "Enter",
                        "windowsVirtualKeyCode": 13,
                        "nativeVirtualKeyCode": 13,
                        "modifiers": 2
                    }),
                    KEY_TIMEOUT,
                )
                .await?;
        }
        Ok(())
    }

    pub async fn reconnect(&mut self) -> Result<(), FailureReason> {
        let replacement = CdpSession::connect(self.port, self.platform).await?;
        *self = replacement;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(url: &str, title: &str) -> PageTarget {
        PageTarget {
            id: "id".to_string(),
            url: url.to_string(),
            title: title.to_string(),
            ws_url: "ws://127.0.0.1/devtools/page/id".to_string(),
        }
    }

    #[test]
    fn parses_chrome_and_edge_major_versions() {
        assert_eq!(parse_major("Chrome/131.0.6778.86", "Chrome/"), Some(131));
        assert_eq!(parse_major("Edg/120.0.2210.91", "Edg/"), Some(120));
        assert_eq!(browser_major("HeadlessChrome/99.0"), Some(99));
        assert_eq!(browser_major("Firefox/120"), None);
    }

    #[test]
    fn rejects_browser_below_120_only_by_value() {
        assert!(browser_major("Chrome/119.0").unwrap_or(0) < 120);
        assert!(browser_major("Chrome/120.0").unwrap_or(0) >= 120);
    }

    #[test]
    fn picks_platform_page_before_blank() {
        let pages = vec![
            page("about:blank", ""),
            page("https://www.bilibili.com/video/BV1", "视频"),
            page("https://www.douyin.com/", "抖音"),
        ];
        let picked = pick_page(&pages, Platform::Bilibili).expect("page");
        assert_eq!(picked.url, "https://www.bilibili.com/video/BV1");

        let pages = vec![page("about:blank", ""), page("https://www.douyin.com/", "抖音")];
        let picked = pick_page(&pages, Platform::Douyin).expect("page");
        assert_eq!(picked.url, "https://www.douyin.com/");
    }

    #[test]
    fn falls_back_to_first_page() {
        let pages = vec![page("https://example.com", "x")];
        assert!(pick_page(&pages, Platform::Bilibili).is_some());
        assert!(pick_page(&[], Platform::Bilibili).is_none());
    }
}
#[cfg(test)]
mod integration {
    use super::*;
    use std::time::Instant;

    fn test_port() -> Option<u16> {
        std::env::var("MALTESE_TEST_CDP_PORT")
            .ok()?
            .parse()
            .ok()
    }

    #[tokio::test]
    #[ignore = "需要真实 CDP 调试浏览器（MALTESE_TEST_CDP_PORT）"]
    async fn probe_lists_pages_and_evaluates() {
        let Some(port) = test_port() else {
            return;
        };
        let probe = probe(port).await.expect("probe");
        assert!(probe.major >= 120, "浏览器版本应 >=120：{}", probe.browser);

        let pages = list_pages(port).await.expect("pages");
        assert!(!pages.is_empty(), "应至少有一个页面 target");

        let mut session = CdpSession::connect(port, Platform::Bilibili)
            .await
            .expect("connect");
        let value = session
            .evaluate("1 + 1", EVALUATE_TIMEOUT)
            .await
            .expect("evaluate");
        assert_eq!(value.as_f64(), Some(2.0));
    }

    #[tokio::test]
    #[ignore = "需要真实 CDP 调试浏览器（MALTESE_TEST_CDP_PORT）"]
    async fn navigates_and_reads_title() {
        let Some(port) = test_port() else {
            return;
        };
        let mut session = CdpSession::connect(port, Platform::Bilibili)
            .await
            .expect("connect");
        session
            .navigate("data:text/html,<title>Maltese CDP</title><h1>ok</h1>")
            .await
            .expect("navigate");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let value = session
            .evaluate("document.title", EVALUATE_TIMEOUT)
            .await
            .expect("title");
        assert_eq!(value.as_str(), Some("Maltese CDP"));
    }

    #[tokio::test]
    #[ignore = "需要真实 CDP 调试浏览器（MALTESE_TEST_CDP_PORT）"]
    async fn scroll_script_can_run_without_focus() {
        let Some(port) = test_port() else {
            return;
        };
        let mut session = CdpSession::connect(port, Platform::Bilibili)
            .await
            .expect("connect");
        session
            .navigate("data:text/html,<title>scroll</title><div style='height:4000px'>x</div>")
            .await
            .expect("navigate");
        let value = session
            .evaluate("window.scrollBy(0, 300); window.scrollY", EVALUATE_TIMEOUT)
            .await
            .expect("scroll");
        assert_eq!(value.as_f64(), Some(300.0));
    }

    #[tokio::test]
    #[ignore = "需要真实 CDP 调试浏览器（MALTESE_TEST_CDP_PORT）"]
    async fn reconnects_after_socket_close() {
        let Some(port) = test_port() else {
            return;
        };
        let mut session = CdpSession::connect(port, Platform::Bilibili)
            .await
            .expect("connect");
        let _ = session.socket.close(None).await;
        let started = Instant::now();
        session.reconnect().await.expect("reconnect");
        assert!(started.elapsed() < Duration::from_secs(10));
        let value = session
            .evaluate("1 + 1", EVALUATE_TIMEOUT)
            .await
            .expect("evaluate after reconnect");
        assert_eq!(value.as_f64(), Some(2.0));
    }

    #[tokio::test]
    #[ignore = "需要真实 CDP 调试浏览器（MALTESE_TEST_CDP_PORT）"]
    async fn blackhole_probe_fails_within_timeout() {
        let started = Instant::now();
        let result = probe(9).await;
        assert!(result.is_err(), "黑洞端口应返回错误");
        assert!(started.elapsed() < Duration::from_secs(8));
    }
}