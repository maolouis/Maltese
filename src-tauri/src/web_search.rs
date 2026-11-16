// 小狗的「联网查资料」技能。
//
// 没有接任何付费搜索 API：直接抓公开的搜索结果页（DuckDuckGo HTML 版，失败退回 Bing），
// 只取标题 / 链接 / 摘要交给模型整理成回答。解析用字符串处理，不引入新的依赖。

use serde::Serialize;
use std::time::Duration;

const MAX_RESULTS: usize = 6;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// 去标签 + 解码实体 + 收敛空白。
fn clean(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max_chars).collect::<String>())
}

fn attr(segment: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let start = segment.find(&marker)? + marker.len();
    let rest = &segment[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 从一个 <a> 标签片段里取链接文字（> 之后到 </a>）。
fn link_text(segment: &str) -> String {
    let Some(start) = segment.find('>') else {
        return String::new();
    };
    let rest = &segment[start + 1..];
    let end = rest.find("</a>").unwrap_or(rest.len());
    clean(&rest[..end])
}

fn parse_duckduckgo(html: &str) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let mut cursor = 0;
    while let Some(found) = html[cursor..].find("result__a") {
        let start = cursor + found;
        let end = (start + 4000).min(html.len());
        let segment = &html[start..end];
        let mut url = attr(segment, "href").unwrap_or_default();
        let title = link_text(segment);
        if title.is_empty() {
            cursor = end;
            continue;
        }
        // DuckDuckGo 的外链是跳转地址，把 uddg 里的真实地址解出来。
        if let Some(position) = url.find("uddg=") {
            let encoded = &url[position + 5..];
            let encoded = encoded.split('&').next().unwrap_or(encoded);
            url = percent_decode(encoded);
        }
        if url.starts_with("//") {
            url = format!("https:{url}");
        }
        // 跳过广告跳转位，只留真正的搜索结果。
        if url.is_empty() || url.contains("y.js?") || url.contains("ad_provider") {
            cursor = end;
            continue;
        }
        let snippet = segment
            .find("result__snippet")
            .map(|at| link_text(&segment[at..]))
            .unwrap_or_default();
        hits.push(WebSearchHit {
            title: truncate(&title, 120),
            url,
            snippet: truncate(&snippet, 240),
        });
        if hits.len() >= MAX_RESULTS {
            break;
        }
        cursor = end;
    }
    hits
}

fn parse_bing(html: &str) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    for block in html.split("<li class=\"b_algo\"").skip(1) {
        let segment = &block[..block.len().min(6000)];
        let Some(h2) = segment.find("<h2") else { continue };
        let anchor = &segment[h2..];
        let url = attr(anchor, "href").unwrap_or_default();
        let title = link_text(anchor);
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = segment
            .find("<p")
            .map(|at| {
                let part = &segment[at..];
                let inner = part.find('>').map(|start| &part[start + 1..]).unwrap_or(part);
                let end = inner.find("</p>").unwrap_or(inner.len());
                clean(&inner[..end])
            })
            .unwrap_or_default();
        hits.push(WebSearchHit {
            title: truncate(&title, 120),
            url,
            snippet: truncate(&snippet, 240),
        });
        if hits.len() >= MAX_RESULTS {
            break;
        }
    }
    hits
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|error| format!("搜索请求失败：{error}"))?;
    response
        .text()
        .await
        .map_err(|error| format!("读取搜索结果失败：{error}"))
}

#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<WebSearchHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("没有搜索关键词。".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;

    let encoded = percent_encode(&query);
    let ddg = format!("https://html.duckduckgo.com/html/?q={encoded}");
    match fetch(&client, &ddg).await {
        Ok(html) => {
            let hits = parse_duckduckgo(&html);
            if !hits.is_empty() {
                return Ok(hits);
            }
        }
        Err(error) => eprintln!("[web_search] DuckDuckGo 失败：{error}"),
    }

    let bing = format!("https://www.bing.com/search?q={encoded}&setlang=zh-Hans");
    let html = fetch(&client, &bing).await?;
    Ok(parse_bing(&html))
}
