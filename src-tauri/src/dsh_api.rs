//! Maltese 本机 HTTP API。
//!
//! 只监听回环地址；写接口需要令牌，并校验 Host / Origin / CORS / 体积。
//! 令牌优先取 `MALTESE_DSH_API_TOKEN`，其次复用应用数据目录里的
//! `dsh-api-token.txt`，不存在时生成并保存。

use crate::video::{
    config::VideoConfigPatch,
    extract::{normalize_facts, RawFacts},
    model::{ClearScope, DeliveryOutcome, Platform, StopReason},
    profile::ProfilePatch,
    session,
    VideoError,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicU16, Ordering},
        OnceLock,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 3218;
/// 3218 被占用时往后顺延尝试的端口数量（最多 3218..=3237）。
const PORT_FALLBACK_ATTEMPTS: u16 = 20;
const MAX_BODY_BYTES: usize = 256 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const TOKEN_FILE: &str = "dsh-api-token.txt";
/// 实际监听端口写在这里，外部调用方（插件 / 扩展）读文件而不是硬编码 3218。
const PORT_FILE: &str = "dsh-api-port.txt";
const TOKEN_HEADER: &str = "x-maltese-token";
const API_VERSION: &str = "1";

static APP: OnceLock<AppHandle> = OnceLock::new();
static TOKEN: OnceLock<String> = OnceLock::new();
/// 0 表示还没 bind 成功（或绑定失败），此时退回首选端口。
static ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let _ = TOKEN.set(load_or_create_token(app));
    // 清掉上一次运行留下的端口文件，避免调用方连到已经死掉的端口。
    if let Ok(directory) = Result::<std::path::PathBuf, String>::Ok(crate::paths::data_root()) {
        let _ = fs::remove_file(directory.join(PORT_FILE));
    }
    let preferred = preferred_port();
    let app_handle = app.clone();
    thread::spawn(move || {
        let (listener, port) = match bind_with_fallback(preferred) {
            Ok(bound) => bound,
            Err(error) => {
                eprintln!(
                    "Maltese DSH API could not bind any port starting at 127.0.0.1:{preferred}: {error}"
                );
                return;
            }
        };
        ACTUAL_PORT.store(port, Ordering::SeqCst);
        if port != preferred {
            eprintln!(
                "Maltese DSH API port {preferred} was unavailable; falling back to 127.0.0.1:{port}"
            );
        }
        // 把实际端口写进应用数据目录，调用方以文件为准。
        match Ok::<std::path::PathBuf, String>(crate::paths::data_root()) {
            Ok(directory) => {
                if let Err(error) = fs::create_dir_all(&directory)
                    .and_then(|_| fs::write(directory.join(PORT_FILE), format!("{port}\n")))
                {
                    eprintln!("failed to write the DSH API port file: {error}");
                }
            }
            Err(error) => eprintln!("failed to resolve the app data directory: {error}"),
        }
        eprintln!("Maltese DSH API listening on http://127.0.0.1:{port}");
        for stream in listener.incoming().flatten() {
            thread::spawn(|| handle_connection(stream));
        }
    });
}

/// 依次尝试首选端口和后面的若干端口，返回真正绑定成功的 listener 与端口。
fn bind_with_fallback(preferred: u16) -> Result<(TcpListener, u16), String> {
    let mut last_error = String::new();
    for offset in 0..PORT_FALLBACK_ATTEMPTS {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(error) => {
                last_error = format!("127.0.0.1:{port}: {error}");
            }
        }
    }
    Err(last_error)
}

fn preferred_port() -> u16 {
    std::env::var("MALTESE_DSH_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// 请求校验用的实际端口：bind 成功后以真实端口为准，否则退回首选端口。
/// 旧代码每个请求都重新读环境变量，端口回退时 Host 校验会和实际端口不一致。
fn active_port() -> u16 {
    let actual = ACTUAL_PORT.load(Ordering::SeqCst);
    if actual != 0 {
        actual
    } else {
        preferred_port()
    }
}

fn generate_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut output = String::new();
    for salt in 0..4u64 {
        let state = RandomState::new();
        let mut hasher = state.build_hasher();
        hasher.write_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos() as u64)
                .unwrap_or_default(),
        );
        hasher.write_u64(std::process::id() as u64);
        hasher.write_u64(salt);
        output.push_str(&format!("{:016x}", hasher.finish()));
    }
    output
}

fn load_or_create_token(app: &AppHandle) -> String {
    if let Ok(value) = std::env::var("MALTESE_DSH_API_TOKEN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(directory) = Result::<std::path::PathBuf, String>::Ok(crate::paths::data_root()) {
        let path = directory.join(TOKEN_FILE);
        if let Ok(existing) = fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let token = generate_token();
        let _ = fs::create_dir_all(&directory);
        let _ = fs::write(&path, &token);
        token
    } else {
        generate_token()
    }
}

fn token() -> Option<&'static str> {
    TOKEN.get().map(String::as_str)
}

#[derive(Clone, Debug)]
struct ApiResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl ApiResponse {
    fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: vec![(
                "Content-Type".to_string(),
                "application/json; charset=utf-8".to_string(),
            )],
            body: body.into(),
        }
    }

    fn json(status: u16, value: Value) -> Self {
        Self::text(status, value.to_string())
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    fn error(status: u16, code: &str, message: &str) -> Self {
        Self::json(
            status,
            json!({ "error": { "code": code, "message": message, "detail": null } }),
        )
    }
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "200 OK",
        204 => "204 No Content",
        400 => "400 Bad Request",
        401 => "401 Unauthorized",
        403 => "403 Forbidden",
        404 => "404 Not Found",
        405 => "405 Method Not Allowed",
        413 => "413 Payload Too Large",
        503 => "503 Service Unavailable",
        _ => "500 Internal Server Error",
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |accumulator, (a, b)| accumulator | (a ^ b))
        == 0
}

fn header<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    headers.get(name).map(String::as_str)
}

fn preset_token(headers: &HashMap<String, String>) -> Option<String> {
    if let Some(value) = header(headers, TOKEN_HEADER) {
        return Some(value.trim().to_string());
    }
    header(headers, "authorization").and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(|token| token.trim().to_string())
    })
}

fn allowed_origins() -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:1420".to_string(),
        "http://127.0.0.1:1420".to_string(),
    ];
    if let Ok(extension) = std::env::var("MALTESE_EXTENSION_ORIGIN") {
        let trimmed = extension.trim();
        if !trimmed.is_empty() {
            origins.push(trimmed.to_string());
        }
    }
    origins
}

fn origin_allowed(origin: &str) -> bool {
    allowed_origins().iter().any(|allowed| allowed == origin)
}

fn requires_token(method: &str, path: &str) -> bool {
    if method == "POST" || method == "DELETE" {
        return true;
    }
    path == "/api/video/pending" || path.starts_with("/api/video/sessions/")
}

fn split_query(path: &str) -> (&str, HashMap<String, String>) {
    let Some((path, query)) = path.split_once('?') else {
        return (path, HashMap::new());
    };
    let mut values = HashMap::new();
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            values.insert(key.to_string(), value.to_string());
        }
    }
    (path, values)
}

fn limit_from(query: &HashMap<String, String>, default: u32) -> u32 {
    query
        .get("limit")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(1, 200)
}

fn engine() -> Option<std::sync::Arc<session::SessionEngine>> {
    APP.get().map(|app| session::engine(app))
}

fn video_error(error: VideoError) -> ApiResponse {
    ApiResponse::json(400, json!({ "error": error }))
}

fn handle_request(
    method: &str,
    raw_path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    port: u16,
    expected_token: &str,
) -> ApiResponse {
    let origin = header(headers, "origin");
    let mut response = match handle_request_inner(
        method,
        raw_path,
        headers,
        body,
        port,
        expected_token,
    ) {
        Ok(response) => response,
        Err(response) => response,
    };

    response = response.with_header("Vary", "Origin");
    if let Some(origin) = origin {
        if origin_allowed(origin) {
            response = response
                .with_header("Access-Control-Allow-Origin", origin)
                .with_header("Access-Control-Allow-Headers", "content-type, x-maltese-token, authorization")
                .with_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        }
    }
    response
}

fn handle_request_inner(
    method: &str,
    raw_path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    port: u16,
    expected_token: &str,
) -> Result<ApiResponse, ApiResponse> {
    let (path, query) = split_query(raw_path);

    let host = header(headers, "host").unwrap_or_default();
    let valid_host = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
    if !valid_host {
        return Err(ApiResponse::error(403, "HOST_REJECTED", "请求 Host 不受信任。"));
    }

    let origin = header(headers, "origin");
    let cross_site = header(headers, "sec-fetch-site") == Some("cross-site");
    if let Some(origin) = origin {
        if !origin_allowed(origin) {
            return Err(ApiResponse::error(403, "ORIGIN_REJECTED", "请求来源不在白名单。"));
        }
        if cross_site && !origin_allowed(origin) {
            return Err(ApiResponse::error(403, "ORIGIN_REJECTED", "跨站请求被拒绝。"));
        }
    } else if cross_site {
        return Err(ApiResponse::error(403, "ORIGIN_REJECTED", "跨站请求必须带白名单来源。"));
    }

    if method == "OPTIONS" {
        return Ok(ApiResponse::empty(204).with_header("Allow", "GET, POST, DELETE, OPTIONS"));
    }

    if body.len() > MAX_BODY_BYTES {
        return Err(ApiResponse::error(413, "PAYLOAD_TOO_LARGE", "请求体超过 256 KB。"));
    }

    if requires_token(method, path) {
        let Some(provided) = preset_token(headers) else {
            return Err(ApiResponse::error(401, "UNAUTHORIZED", "缺少本机令牌。"));
        };
        if !constant_time_eq(&provided, expected_token) {
            return Err(ApiResponse::error(401, "UNAUTHORIZED", "本机令牌无效。"));
        }
    }

    let value = match (method, path) {
        ("GET", "/api/capabilities") => json!({
            "name": "maltese",
            "apiVersion": API_VERSION,
            "baseUrl": format!("http://127.0.0.1:{port}"),
            "authRequired": true,
            "endpoints": [
                "GET /api/status",
                "GET /api/video/status",
                "GET /api/video/sessions",
                "GET /api/video/sessions/{id}",
                "GET /api/video/diagnostics",
                "GET /api/video/pending",
                "POST /api/video/config",
                "POST /api/video/start",
                "POST /api/video/stop",
                "POST /api/video/facts",
                "POST /api/video/self-check",
                "POST /api/video/profile",
                "POST /api/video/delivery",
                "DELETE /api/video/data",
                "POST /api/pet/action"
            ],
            "features": ["video-automation", "interest-scoring", "digest-delivery", "token-auth"]
        }),
        ("GET", "/api/status") => {
            let snapshot = engine().map(|engine| engine.snapshot());
            json!({
                "name": "Maltese",
                "ready": true,
                "pet": { "eventBridge": true },
                "video": snapshot
            })
        }
        ("GET", "/api/video/status") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.snapshot()).unwrap_or_else(|_| json!({}))
        }
        ("GET", "/api/video/sessions") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.list_sessions(limit_from(&query, 20)))
                .unwrap_or_else(|_| json!([]))
        }
        ("GET", "/api/video/diagnostics") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.diagnostics(limit_from(&query, 20)))
                .unwrap_or_else(|_| json!([]))
        }
        ("GET", "/api/video/pending") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.pending()).unwrap_or_else(|_| Value::Null)
        }
        ("POST", "/api/video/config") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let patch: VideoConfigPatch = serde_json::from_slice(body).map_err(|error| {
                ApiResponse::error(400, "INVALID_CONFIG", &error.to_string())
            })?;
            let config = engine.update_config(&patch).map_err(video_error)?;
            serde_json::to_value(config).unwrap_or_else(|_| json!({}))
        }
        ("POST", "/api/video/start") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let payload: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let provider = payload
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("bilibili")
                .to_string();
            let platform = Platform::parse(&provider).ok_or_else(|| {
                ApiResponse::error(400, "INVALID_PROVIDER", "只支持 bilibili 或 douyin。")
            })?;
            let patch = payload
                .get("config")
                .and_then(|value| serde_json::from_value::<VideoConfigPatch>(value.clone()).ok());
            let app = APP.get().cloned().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let account_id = payload
                .get("accountId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let snapshot = tauri::async_runtime::block_on(engine.start(app, platform, patch, account_id))
                .map_err(video_error)?;
            serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}))
        }
        ("POST", "/api/video/stop") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let payload: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let reason = payload
                .get("reason")
                .and_then(|value| serde_json::from_value::<StopReason>(value.clone()).ok());
            let app = APP.get().cloned().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.stop(&app, reason)).unwrap_or_else(|_| json!({}))
        }
        ("POST", "/api/video/facts") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let payload: Value = serde_json::from_slice(body).map_err(|error| {
                ApiResponse::error(400, "INVALID_PAYLOAD", &error.to_string())
            })?;
            let channel = payload
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let confidence = match channel {
                "extension" => 1.0,
                "uia" => 0.5,
                _ => {
                    return Err(ApiResponse::error(
                        400,
                        "INVALID_CHANNEL",
                        "只接受 extension 或 uia。",
                    ))
                }
            };
            let provider = payload
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or("bilibili");
            let platform = Platform::parse(provider).ok_or_else(|| {
                ApiResponse::error(400, "INVALID_PROVIDER", "只支持 bilibili 或 douyin。")
            })?;
            let facts_value = payload.get("facts").cloned().unwrap_or(Value::Null);
            let raw: RawFacts = serde_json::from_value(facts_value).map_err(|error| {
                ApiResponse::error(400, "INVALID_PAYLOAD", &error.to_string())
            })?;
            let (facts, unknown) = normalize_facts(raw, platform, confidence)
                .map(|facts| (facts, 0usize))
                .map_err(|issue| ApiResponse::error(400, "INVALID_PAYLOAD", &issue.to_string()))?;
            let accepted = engine.ingest_facts(&facts);
            json!({ "accepted": accepted, "merged": unknown })
        }
        ("POST", "/api/video/self-check") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            serde_json::to_value(engine.probe_channels()).unwrap_or_else(|_| json!([]))
        }
        ("POST", "/api/video/profile") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let patch: ProfilePatch = serde_json::from_slice(body).map_err(|error| {
                ApiResponse::error(400, "INVALID_PROFILE", &error.to_string())
            })?;
            let mut profile = engine.profile();
            crate::video::profile::apply_patch(&mut profile, &patch)
                .map_err(|message| ApiResponse::error(400, "INVALID_PROFILE", &message))?;
            engine.save_profile(&profile);
            serde_json::to_value(profile).unwrap_or_else(|_| json!({}))
        }
        ("POST", "/api/video/delivery") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let payload: Value = serde_json::from_slice(body).map_err(|error| {
                ApiResponse::error(400, "INVALID_PAYLOAD", &error.to_string())
            })?;
            let session_id = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let outcome: DeliveryOutcome = payload
                .get("outcome")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| ApiResponse::error(400, "INVALID_PAYLOAD", &error.to_string()))?
                .unwrap_or_default();
            let app = APP.get().cloned().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let record = engine
                .mark_delivery(&app, &session_id, outcome)
                .map_err(video_error)?;
            serde_json::to_value(record).unwrap_or_else(|_| json!({}))
        }
        ("DELETE", "/api/video/data") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let payload: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let scope: ClearScope = payload
                .get("scope")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| ApiResponse::error(400, "INVALID_SCOPE", &error.to_string()))?
                .unwrap_or(ClearScope::All);
            let include_profile = payload
                .get("includeBrowserProfile")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let report = engine.clear_data(scope, include_profile).map_err(video_error)?;
            serde_json::to_value(report).unwrap_or_else(|_| json!({}))
        }
        ("POST", "/api/pet/action") => {
            let payload: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let action = payload.get("action").and_then(Value::as_str).unwrap_or("pet");
            let valid = ["pet", "eating", "pickup", "wave", "scared", "sleeping", "celebrate"];
            if !valid.contains(&action) {
                return Err(ApiResponse::error(400, "INVALID_ACTION", "未知的桌宠动作。"));
            }
            let app = APP.get().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            use tauri::Emitter;
            app.emit("maltese-pet-action", json!({ "action": action }))
                .map_err(|error| ApiResponse::error(500, "EMIT_FAILED", &error.to_string()))?;
            json!({ "accepted": true, "action": action })
        }
        (method, path) if method == "GET" && path.starts_with("/api/video/sessions/") => {
            let engine = engine().ok_or_else(|| {
                ApiResponse::error(503, "APP_NOT_READY", "Maltese 尚未就绪。")
            })?;
            let session_id = path.trim_start_matches("/api/video/sessions/");
            if session_id.is_empty() {
                return Err(ApiResponse::error(404, "NOT_FOUND", "缺少会话 ID。"));
            }
            let session = engine.get_session(session_id).map_err(video_error)?;
            serde_json::to_value(session).unwrap_or_else(|_| json!({}))
        }
        _ => {
            return Err(ApiResponse::error(404, "NOT_FOUND", "没有这个接口。"));
        }
    };

    Ok(ApiResponse::json(200, value))
}

fn handle_connection(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(size) => buffer.extend_from_slice(&chunk[..size]),
            Err(_) => return,
        }
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > MAX_BODY_BYTES + 8192 {
            let response = ApiResponse::error(413, "PAYLOAD_TOO_LARGE", "请求体超过 256 KB。")
                .with_header("Vary", "Origin");
            write_response(&mut stream, &response);
            return;
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end - 4]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        let response = ApiResponse::error(413, "PAYLOAD_TOO_LARGE", "请求体超过 256 KB。")
            .with_header("Vary", "Origin");
        write_response(&mut stream, &response);
        return;
    }

    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => body.extend_from_slice(&chunk[..size]),
            Err(_) => break,
        }
    }
    body.truncate(content_length);

    let port = active_port();
    let expected = token().unwrap_or_default();
    let response = handle_request(&method, &path, &headers, &body, port, expected);
    write_response(&mut stream, &response);
}

fn write_response(stream: &mut TcpStream, response: &ApiResponse) {
    let mut text = format!(
        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        status_text(response.status),
        response.body.len()
    );
    for (name, value) in &response.headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str("\r\n");
    text.push_str(&response.body);
    let _ = stream.write_all(text.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str) -> HashMap<String, String> {
        let mut headers = HashMap::new();
        headers.insert("host".to_string(), host.to_string());
        headers
    }

    fn authorized(host: &str) -> HashMap<String, String> {
        let mut headers = headers(host);
        headers.insert(TOKEN_HEADER.to_string(), "test-token".to_string());
        headers
    }

    fn call(method: &str, path: &str, headers: &HashMap<String, String>, body: &[u8]) -> ApiResponse {
        handle_request(method, path, headers, body, 3218, "test-token")
    }

    #[test]
    fn missing_token_is_unauthorized() {
        let response = call("POST", "/api/video/start", &headers("127.0.0.1:3218"), b"{}");
        assert_eq!(response.status, 401);
    }

    #[test]
    fn wrong_token_is_unauthorized() {
        let mut headers = headers("127.0.0.1:3218");
        headers.insert(TOKEN_HEADER.to_string(), "wrong".to_string());
        let response = call("POST", "/api/video/start", &headers, b"{}");
        assert_eq!(response.status, 401);
    }

    #[test]
    fn token_length_mismatch_is_unauthorized() {
        let mut headers = headers("127.0.0.1:3218");
        headers.insert(TOKEN_HEADER.to_string(), "longer-than-test-token".to_string());
        let response = call("POST", "/api/video/start", &headers, b"{}");
        assert_eq!(response.status, 401);
    }

    #[test]
    fn bad_host_is_rejected() {
        let response = call(
            "POST",
            "/api/video/start",
            &authorized("evil.com"),
            b"{}",
        );
        assert_eq!(response.status, 403);
    }

    #[test]
    fn evil_origin_is_rejected() {
        let mut headers = authorized("127.0.0.1:3218");
        headers.insert("origin".to_string(), "http://evil.com".to_string());
        headers.insert("sec-fetch-site".to_string(), "cross-site".to_string());
        let response = call("POST", "/api/video/start", &headers, b"{}");
        assert_eq!(response.status, 403);
    }

    #[test]
    fn whitelisted_origin_is_echoed_without_wildcard() {
        let mut headers = headers("127.0.0.1:3218");
        headers.insert("origin".to_string(), "http://localhost:1420".to_string());
        let response = call("GET", "/api/video/status", &headers, b"");
        let cors = response
            .headers
            .iter()
            .find(|(name, _)| name == "Access-Control-Allow-Origin");
        assert_eq!(cors.map(|(_, value)| value.as_str()), Some("http://localhost:1420"));
        assert!(response
            .headers
            .iter()
            .all(|(_, value)| value != "*"));
        assert!(response.headers.iter().any(|(name, _)| name == "Vary"));
    }

    #[test]
    fn options_returns_204_with_allow_headers() {
        let mut headers = headers("127.0.0.1:3218");
        headers.insert("origin".to_string(), "tauri://localhost".to_string());
        let response = call("OPTIONS", "/api/video/start", &headers, b"");
        assert_eq!(response.status, 204);
        assert!(response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("Access-Control-Allow-Methods")));
    }

    #[test]
    fn oversized_body_is_rejected() {
        let body = vec![b'{'; MAX_BODY_BYTES + 1];
        let response = call("POST", "/api/video/config", &authorized("127.0.0.1:3218"), &body);
        assert_eq!(response.status, 413);
    }

    #[test]
    fn unknown_route_is_404_with_error_body() {
        let response = call("GET", "/api/nope", &headers("127.0.0.1:3218"), b"");
        assert_eq!(response.status, 404);
        let value: Value = serde_json::from_str(&response.body).expect("json");
        assert_eq!(value["error"]["code"], "NOT_FOUND");
    }

    #[test]
    fn only_readonly_endpoints_skip_token() {
        assert!(!requires_token("GET", "/api/video/status"));
        assert!(!requires_token("GET", "/api/video/sessions"));
        assert!(requires_token("GET", "/api/video/pending"));
        assert!(requires_token("GET", "/api/video/sessions/abc"));
        assert!(requires_token("POST", "/api/video/config"));
        assert!(requires_token("DELETE", "/api/video/data"));
    }

    #[test]
    fn constant_time_compare_handles_lengths() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
