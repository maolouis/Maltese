use crate::video_automation::{
    get_video_automation_state, set_video_automation_config, start_video_automation,
    stop_video_automation, VideoAutomationConfig,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::OnceLock,
    thread,
};
use tauri::{AppHandle, Emitter};

const DEFAULT_PORT: u16 = 3218;
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let port = std::env::var("MALTESE_DSH_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Maltese DSH API could not bind 127.0.0.1:{port}: {error}");
                return;
            }
        };
        eprintln!("Maltese DSH API listening on http://127.0.0.1:{port}");
        for stream in listener.incoming().flatten() {
            thread::spawn(|| handle_connection(stream));
        }
    });
}

fn handle_connection(mut stream: TcpStream) {
    let mut buffer = vec![0u8; 65_536];
    let size = match stream.read(&mut buffer) {
        Ok(size) => size,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buffer[..size]);
    let (head, body) = request.split_once("\r\n\r\n").unwrap_or((request.as_ref(), ""));
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let response = route(method, path, body.as_bytes());
    let _ = stream.write_all(response.as_bytes());
}

fn route(method: &str, path: &str, body: &[u8]) -> String {
    let result = match (method, path) {
        ("GET", "/api/capabilities") => Ok(json!({
            "name": "maltese",
            "apiVersion": "1",
            "baseUrl": "http://127.0.0.1:3218",
            "endpoints": [
                "GET /api/status",
                "GET /api/video/status",
                "POST /api/video/config",
                "POST /api/video/start",
                "POST /api/video/stop",
                "POST /api/pet/action"
            ]
        })),
        ("GET", "/api/status") => {
            let video = get_video_automation_state().unwrap_or_else(|_| crate::video_automation::VideoAutomationState::default());
            Ok(json!({
                "name": "Maltese",
                "ready": true,
                "pet": { "eventBridge": true },
                "video": video
            }))
        }
        ("GET", "/api/video/status") => get_video_automation_state()
            .map(|state| serde_json::to_value(state).unwrap_or_else(|_| json!({})))
            .map_err(|error| error.to_string()),
        ("POST", "/api/video/config") => serde_json::from_slice::<VideoAutomationConfig>(body)
            .map_err(|error| error.to_string())
            .and_then(|config| set_video_automation_config(config))
            .and_then(|state| serde_json::to_value(state).map_err(|error| error.to_string())),
        ("POST", "/api/video/start") => {
            let payload = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| json!({}));
            let provider = payload.get("provider").and_then(Value::as_str).unwrap_or("bilibili").to_string();
            start_video_automation(provider)
                .and_then(|state| serde_json::to_value(state).map_err(|error| error.to_string()))
        }
        ("POST", "/api/video/stop") => stop_video_automation()
            .and_then(|state| serde_json::to_value(state).map_err(|error| error.to_string())),
        ("POST", "/api/pet/action") => {
            let payload = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| json!({}));
            let action = payload.get("action").and_then(Value::as_str).unwrap_or("pet");
            let valid = ["pet", "eating", "pickup", "wave", "scared", "sleeping", "celebrate"];
            if !valid.contains(&action) {
                Err("unknown pet action".to_string())
            } else if let Some(app) = APP.get() {
                app.emit("maltese-pet-action", json!({ "action": action }))
                    .map(|_| json!({ "accepted": true, "action": action }))
                    .map_err(|error| error.to_string())
            } else {
                Err("Maltese app is not ready".to_string())
            }
        }
        _ => Err("not found".to_string()),
    };
    match result {
        Ok(value) => http_response("200 OK", value),
        Err(error) if error == "not found" => http_response_with_text("404 Not Found", error),
        Err(error) => http_response_with_text("400 Bad Request", error),
    }
}

fn http_response(status: &str, value: Value) -> String {
    http_response_with_text(status, value.to_string())
}

fn http_response_with_text(status: &str, body: impl Into<String>) -> String {
    let body = body.into();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}
