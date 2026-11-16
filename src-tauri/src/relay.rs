// 关系插件的消息中继。
//
// 桌宠自己没有后端，两个人的机器之间需要一个能穿 NAT 的通道：这里用
// ntfy 的 HTTP pub/sub（默认 https://ntfy.sh）。宿主只负责收发原始密文，
// 配对码派生密钥、加解密都在前端完成，宿主不碰明文。

use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

const DEFAULT_BASE: &str = "https://ntfy.sh";
const TIMEOUT_SECONDS: u64 = 12;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const INTERNET_SETTINGS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayMessage {
    pub id: String,
    pub time: i64,
    pub body: String,
}

/// 读取注册表中的系统代理（与更新器 `get_updater_proxy` 同一口径）。
fn registry_proxy_server() -> Option<String> {
    let output = Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", INTERNET_SETTINGS_KEY, "/v", "ProxyEnable"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let enabled = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains("ProxyEnable"))?
        .split_whitespace()
        .last()?
        .trim()
        .to_string();
    if enabled != "0x1" {
        return None;
    }
    let server = Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", INTERNET_SETTINGS_KEY, "/v", "ProxyServer"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&server.stdout)
        .lines()
        .find(|line| line.contains("ProxyServer"))?
        .split_whitespace()
        .last()
        .map(str::to_string)
}

fn normalize_proxy(raw: &str) -> String {
    let entries: Vec<&str> = raw.split(';').map(str::trim).filter(|entry| !entry.is_empty()).collect();
    let server = ["https=", "http="]
        .iter()
        .find_map(|prefix| entries.iter().find_map(|entry| entry.strip_prefix(prefix)))
        .unwrap_or_else(|| entries.first().copied().unwrap_or(""));
    if server.contains("://") {
        server.to_string()
    } else {
        format!("http://{server}")
    }
}

/// 显式环境变量优先，其次 Windows 系统代理；都没有就直连。
fn resolve_proxy() -> Option<reqwest::Proxy> {
    let raw = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(registry_proxy_server)?;
    reqwest::Proxy::all(normalize_proxy(&raw)).ok()
}

fn http_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .user_agent("Maltese-Relay/1");
    if let Some(proxy) = resolve_proxy() {
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("无法创建网络请求：{error}"))
}

fn normalize_base(base: &str) -> Result<String, String> {
    let trimmed = base.trim();
    let value = if trimmed.is_empty() { DEFAULT_BASE } else { trimmed };
    if !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err("中继地址必须以 http:// 或 https:// 开头。".to_string());
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn normalize_topic(topic: &str) -> Result<String, String> {
    let trimmed = topic.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("频道名不合法。".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("频道名只能包含字母、数字、短横线和下划线。".to_string());
    }
    Ok(trimmed.to_string())
}

/// 往频道里发一条消息（内容已是前端加密后的密文）。
#[tauri::command]
pub async fn relay_publish(base: String, topic: String, body: String) -> Result<(), String> {
    let base = normalize_base(&base)?;
    let topic = normalize_topic(&topic)?;
    let url = format!("{base}/{topic}");
    let response = http_client()?
        .post(&url)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("发送失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("中继返回 HTTP {}", response.status().as_u16()));
    }
    Ok(())
}

/// 拉取频道里的消息。`since` 用 all 或上一次最后一条的时间戳。
#[tauri::command]
pub async fn relay_fetch(
    base: String,
    topic: String,
    since: String,
) -> Result<Vec<RelayMessage>, String> {
    let base = normalize_base(&base)?;
    let topic = normalize_topic(&topic)?;
    let since = since.trim();
    let since = if since.is_empty() { "all" } else { since };
    let url = format!("{base}/{topic}/json?poll=1&since={since}");
    let response = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("拉取失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("中继返回 HTTP {}", response.status().as_u16()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取返回失败：{error}"))?;

    let mut messages = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("event").and_then(|item| item.as_str()) != Some("message") {
            continue;
        }
        let body = value
            .get("message")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string();
        if body.is_empty() {
            continue;
        }
        messages.push(RelayMessage {
            id: value
                .get("id")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string(),
            time: value.get("time").and_then(|item| item.as_i64()).unwrap_or(0),
            body,
        });
    }
    Ok(messages)
}
