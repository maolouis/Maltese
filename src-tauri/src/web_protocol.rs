//! 前端产物外置：自定义协议从 `<资源目录>/web/` 读取 index.html / JS / CSS / 字体。
//!
//! 目标：纯前端或素材更新时只替换安装目录里的文件，不换 PE。
//!
//! 用法（`tauri.external-web.conf.json` overlay）：
//! * 窗口 URL 写成 `http://maltese.localhost/index.html?window=...`；
//! * `frontendDist` 指向一个极小的占位目录（只保留「资源缺失」提示页）；
//! * `bundle.resources` 把 `dist` 装到 `<resourceDir>/web`。
//!
//! 安全：只读、只允许 `web/` 目录内、路径规范化后必须仍在该目录内；不做任何写操作。
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

const SCHEME: &str = "maltese";

/// 协议名：Windows 上表现为 `http://maltese.localhost/...`。
pub fn scheme() -> &'static str {
    SCHEME
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn web_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().resource_dir().ok()?;
    let root = dir.join("web");
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

/// 处理一次请求：把 URL 路径映射到 `web/` 下的文件。
pub fn respond(
    app: &tauri::AppHandle,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some(root) = web_root(app) else {
        return fallback(
            StatusCode::SERVICE_UNAVAILABLE,
            "前端资源缺失：请重新安装，或确认 <安装目录>/resources/web 存在。",
        );
    };

    // 去掉查询串与开头的斜杠
    let raw_path = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode(raw_path);
    let relative = if decoded.is_empty() {
        "index.html".to_string()
    } else {
        decoded
    };

    let candidate = root.join(relative.replace('\\', "/"));
    let normalized = normalize(&candidate);
    // 目录穿越保护
    if !normalized.starts_with(&root) {
        return fallback(StatusCode::FORBIDDEN, "forbidden");
    }

    let file = if normalized.is_file() {
        normalized
    } else {
        // SPA 兜底：未知路径回 index.html，让前端路由自己处理
        let index = root.join("index.html");
        if index.is_file() {
            index
        } else {
            return fallback(StatusCode::NOT_FOUND, "index.html 不存在");
        }
    };

    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_for(&file))
            .header(header::CACHE_CONTROL, "no-cache")
            .body(bytes)
            .unwrap_or_else(|_| fallback(StatusCode::INTERNAL_SERVER_ERROR, "read failed")),
        Err(_) => fallback(StatusCode::NOT_FOUND, "not found"),
    }
}

fn fallback(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Maltese</title>\
         <body style=\"font:14px system-ui;padding:24px;color:#334155\">{message}</body>"
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body.into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(value) = hex.and_then(|text| u8::from_str_radix(text, 16).ok()) {
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

/// 规范化路径（不要求文件存在）：消掉 `.` / `..`，用于穿越校验。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}