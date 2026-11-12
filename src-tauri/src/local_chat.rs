//! 本地模型聊天桥：兼容 Ollama / LM Studio / llama.cpp 等提供的
//! OpenAI Chat Completions 接口。所有请求只从本机发出，不依赖 DSH。

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn persona(character: &str) -> &'static str {
    match character {
        "xiaojimao" => "你是 Maltese 桌宠小鸡毛：一只金黄色的小金毛，活泼、贪吃、爱撒娇，像小太阳一样会黏着主人。\
参考《亲爱的小狗》的温柔日常，把幸福写在陪伴、默契和小事里；先让主人放松，再俏皮地回应。\
请直接用简体中文回答，语气亲近，控制在 1 到 3 句话。你正在和主人闲聊，不要调用工具，\
不要读写文件，不要执行命令，也不要提及这些限制。",
        "duo" => "你是 Maltese 桌宠里的两只小狗：小白是白色马尔济斯，安静温柔、细心、略害羞；小鸡毛是金黄色小金毛，活泼、贪吃、爱撒娇。\
参考《亲爱的小狗》里两只好朋狗在四季日常中的无声默契和无条件信任，让一静一动互相接住，陪主人寻找小小的幸福。\
请让两只小狗一起回答：必须分别以「小白：」和「小鸡毛：」开头，各说一句，总计不超过 3 句话，\
保持简体中文、自然亲近。你正在和主人闲聊，不要调用工具，不要读写文件，不要执行命令，也不要提及这些限制。",
        _ => "你是 Maltese 桌宠小白：一只白色马尔济斯，安静温柔、细心，带一点害羞和胆小。\
参考《亲爱的小狗》的温柔日常，先观察主人的心情，用安静可靠的陪伴把幸福落到小事上。\
请直接用简体中文回答，语气温柔简短，控制在 1 到 3 句话。你正在和主人闲聊，不要调用工具，\
不要读写文件，不要执行命令，也不要提及这些限制。",
    }
}
const MAX_HISTORY_TURNS: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
const STRATA_LAUNCHER: &str = r"F:\Strata\bin\strata.cmd";
const STRATA_BASE_URL: &str = "http://127.0.0.1:8080";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatTurn {
    role: String,
    content: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatGenerationSettings {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub enable_thinking: Option<bool>,
    /// 思考深度对应的 reasoning_effort（none / low / medium / high）。
    pub reasoning_effort: Option<String>,
    /// 思考预算（thinking token 上限），0 表示关闭思考。
    pub reasoning_budget_tokens: Option<u32>,
}

fn build_messages(
    message: &str,
    history: Option<Vec<LocalChatTurn>>,
    character: &str,
    images: Option<Vec<String>>,
) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": persona(character) })];
    if let Some(history) = history {
        let mut turns = history
            .into_iter()
            .filter(|turn| matches!(turn.role.as_str(), "user" | "assistant"))
            .filter(|turn| !turn.content.trim().is_empty())
            .collect::<Vec<_>>();
        let keep_from = turns.len().saturating_sub(MAX_HISTORY_TURNS);
        turns.drain(..keep_from);
        for turn in turns {
            messages.push(json!({
                "role": turn.role,
                "content": turn.content.trim(),
            }));
        }
    }
    messages.push(json!({
        "role": "user",
        "content": user_content(message, images),
    }));
    messages
}

fn user_content(message: &str, images: Option<Vec<String>>) -> Value {
    let images = images
        .unwrap_or_default()
        .into_iter()
        .filter(|image| image.starts_with("data:image/"))
        .collect::<Vec<_>>();
    if images.is_empty() {
        return json!(message);
    }
    let mut parts = vec![json!({ "type": "text", "text": message })];
    parts.extend(images.into_iter().map(|image| {
        json!({
            "type": "image_url",
            "image_url": { "url": image }
        })
    }));
    Value::Array(parts)
}

fn generation_payload(
    model: &str,
    messages: Vec<Value>,
    settings: &LocalChatGenerationSettings,
    stream: bool,
) -> Value {
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": settings.max_tokens.unwrap_or(256),
        "temperature": settings.temperature.unwrap_or(0.7),
        "top_p": settings.top_p.unwrap_or(0.9),
        "enable_thinking": settings.enable_thinking.unwrap_or(false),
        "reasoning_budget_tokens": settings
            .reasoning_budget_tokens
            .unwrap_or(if settings.enable_thinking.unwrap_or(false) { 128 } else { 0 }),
    });
    if let Some(object) = payload.as_object_mut() {
        // 思考深度：前端传 low / medium / high；关闭思考时显式告诉服务端 none。
        let effort = settings
            .reasoning_effort
            .clone()
            .unwrap_or_else(|| {
                if settings.enable_thinking.unwrap_or(false) {
                    "medium".to_string()
                } else {
                    "none".to_string()
                }
            });
        object.insert("reasoning_effort".to_string(), Value::from(effort));
        if object.get("max_tokens") == Some(&Value::from(0)) {
            object.remove("max_tokens");
        }
    }
    payload
}

#[tauri::command]
pub async fn local_chat(
    base_url: String,
    model: String,
    api_key: Option<String>,
    message: String,
    history: Option<Vec<LocalChatTurn>>,
    character: String,
    images: Option<Vec<String>>,
    settings: Option<LocalChatGenerationSettings>,
) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("想和小狗说什么？".into());
    }
    if message.chars().count() > 4_000 {
        return Err("一次最多说 4000 个字。".into());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("还没有填写本地模型名称。请先在聊天右上角的设置里选择模型。".into());
    }
    let endpoint = chat_endpoint(&base_url)?;
    let settings = settings.unwrap_or_default();
    // 非流式也要支持图片（复选框里没开流式时，粘贴的图片同样要发给模型）。
    // 思考吃光预算时要重试，所以这两份数据先克隆留底。
    let retry_history = history.clone();
    let retry_images = images.clone();
    let messages = build_messages(&message, history, &character, images);

    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CHAT_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建本地模型连接：{error}"))?;
    let mut request = client
        .post(endpoint.clone())
        .json(&generation_payload(&model, messages, &settings, false));
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            format!("本地模型响应超时（{endpoint}）。模型可能还在加载，稍后再试一次。")
        } else if error.is_connect() {
            format!(
                "连接不到本地模型服务（{endpoint}）。请确认 Ollama / LM Studio 已启动，并检查接口地址。"
            )
        } else {
            format!("请求本地模型失败：{error}")
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取本地模型响应失败：{error}"))?;
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| format!("本地模型返回的不是有效 JSON：{error}"))?;
    if let Some(text) = extract_content(&value) {
        let text = text.trim().to_string();
        if !text.is_empty() {
            return Ok(text);
        }
    }

    // 只拿到思考、正文是空的：多半是思考把 token 预算吃光了（finish_reason=length）。
    // 主动聊天这类短句场景必须关掉思考重试一次，否则每次都退化成模板台词。
    let retry_settings = LocalChatGenerationSettings {
        max_tokens: Some(settings.max_tokens.unwrap_or(256).max(512)),
        temperature: settings.temperature,
        top_p: settings.top_p,
        enable_thinking: Some(false),
        reasoning_effort: Some("none".to_string()),
        reasoning_budget_tokens: Some(0),
    };
    let retry_messages = build_messages(&message, retry_history, &character, retry_images);
    let mut retry_request = client
        .post(endpoint)
        .json(&generation_payload(&model, retry_messages, &retry_settings, false));
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        retry_request = retry_request.bearer_auth(key);
    }
    let retry_response = retry_request
        .send()
        .await
        .map_err(|error| format!("本地模型重试失败：{error}"))?;
    let retry_body = retry_response
        .text()
        .await
        .map_err(|error| format!("读取本地模型响应失败：{error}"))?;
    let retry_value: Value = serde_json::from_str(&retry_body)
        .map_err(|error| format!("本地模型返回的不是有效 JSON：{error}"))?;
    extract_content(&retry_value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "本地模型没有返回文字。请检查模型名称是否正确。".to_string())
}

#[tauri::command]
pub async fn local_chat_stream(
    app: AppHandle,
    request_id: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    message: String,
    history: Option<Vec<LocalChatTurn>>,
    character: String,
    images: Option<Vec<String>>,
    settings: Option<LocalChatGenerationSettings>,
) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("想和小狗说什么？".into());
    }
    if message.chars().count() > 4_000 {
        return Err("一次最多说 4000 个字。".into());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("还没有填写本地模型名称。请先在聊天右上角的设置里选择模型。".into());
    }
    let endpoint = chat_endpoint(&base_url)?;
    let settings = settings.unwrap_or_default();
    let messages = build_messages(&message, history, &character, images);
    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CHAT_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建本地模型连接：{error}"))?;
    let mut request = client
        .post(endpoint.clone())
        .json(&generation_payload(&model, messages, &settings, true));
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            format!("本地模型响应超时（{endpoint}）。模型可能还在加载，稍后再试一次。")
        } else if error.is_connect() {
            format!("连接不到本地模型服务（{endpoint}）。请确认服务已启动，并检查接口地址。")
        } else {
            format!("请求本地模型失败：{error}")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let error = api_error(status.as_u16(), &body);
        emit_stream_event(&app, &request_id, "error", &error);
        return Err(error);
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut full_text = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取本地模型流失败：{error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = pending.find('\n') {
            let line = pending.drain(..=newline).collect::<String>();
            let data = line.trim().strip_prefix("data:").map(str::trim).unwrap_or("");
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                break;
            }
            let value = match serde_json::from_str::<Value>(data) {
                Ok(value) => value,
                Err(_) => continue,
            };
            // 思考内容单独发一类事件，前端折叠展示；正文照旧按 delta 累积。
            if let Some(reasoning) = extract_reasoning_delta(&value) {
                emit_stream_event(&app, &request_id, "reasoning", &reasoning);
            }
            if let Some(delta) = extract_delta(&value) {
                full_text.push_str(&delta);
                emit_stream_delta(&app, &request_id, &delta);
            }
        }
    }
    if full_text.trim().is_empty() {
        return Err("本地模型没有返回文字。请检查模型名称和服务日志。".into());
    }
    emit_stream_event(&app, &request_id, "done", &full_text);
    Ok(full_text.trim().to_string())
}

fn emit_stream_delta(app: &AppHandle, request_id: &str, text: &str) {
    let _ = app.emit(
        "local-chat-stream",
        json!({ "requestId": request_id, "kind": "delta", "text": text }),
    );
}

fn emit_stream_event(app: &AppHandle, request_id: &str, kind: &str, text: &str) {
    let _ = app.emit(
        "local-chat-stream",
        json!({ "requestId": request_id, "kind": kind, "text": text }),
    );
}

fn extract_delta(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/delta/content")
        .or_else(|| value.pointer("/choices/0/text"))
        .or_else(|| value.pointer("/message/content"))
        .and_then(content_to_string)
}

/// 思考过程：兼容各家字段名（reasoning_content / reasoning / thinking）。
fn extract_reasoning_delta(value: &Value) -> Option<String> {
    for pointer in [
        "/choices/0/delta/reasoning_content",
        "/choices/0/delta/reasoning",
        "/choices/0/delta/thinking",
        "/choices/0/message/reasoning_content",
    ] {
        if let Some(text) = value.pointer(pointer).and_then(content_to_string) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// 确保本机模型（F:\Strata 里的 Strata 服务）已经在跑。
/// 主动聊天、聊天发送前调用：服务没起来就顺手拉起，避免一路退化成模板台词。
#[tauri::command]
pub async fn ensure_local_model(base_url: String) -> Result<bool, String> {
    let endpoint = match Url::parse(&base_url) {
        Ok(url) => url,
        Err(_) => return Ok(false),
    };
    // 只对 Strata 的默认本地地址做自动启动，别去拉起别人的服务。
    let host = endpoint.host_str().unwrap_or("");
    let port = endpoint.port_or_known_default().unwrap_or(0);
    if !(host == "127.0.0.1" || host == "localhost") || port != 8080 {
        return Ok(true);
    }
    let health = format!("{}://{host}:{port}/v1/models", endpoint.scheme());
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;
    if client.get(&health).send().await.map(|response| response.status().is_success()).unwrap_or(false) {
        return Ok(true);
    }
    // 没在跑：拉起 Strata，最多等 120 秒。
    strata_launch().await?;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if client.get(&health).send().await.map(|response| response.status().is_success()).unwrap_or(false) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn strata_launch() -> Result<(), String> {
    let launcher = std::path::Path::new(STRATA_LAUNCHER);
    if !launcher.is_file() {
        return Err(format!("找不到 Strata 启动器：{STRATA_LAUNCHER}"));
    }
    let mut command = Command::new("cmd.exe");
    command.args([
        "/d",
        "/c",
        STRATA_LAUNCHER,
        "launch",
        "--family",
        "qwen36",
        "--model",
        "ud-q4_k_xl",
        "--context",
        "8192",
        "--vision",
        "cpu",
        "--mtp",
        "on",
        "--tune",
        "skip",
        "--access",
        "local",
        "--port",
        "8080",
        "--restart",
        "--no-tui",
        "--yes",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|error| format!("启动 Strata 失败：{error}"))?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("无法准备 Strata 设置同步：{error}"))?;
    let health_url = Url::parse(&format!("{STRATA_BASE_URL}/health"))
        .map_err(|error| format!("Strata 地址无效：{error}"))?;
    let settings_url = Url::parse(&format!("{STRATA_BASE_URL}/settings"))
        .map_err(|error| format!("Strata 设置地址无效：{error}"))?;
    let mut observed_restart = false;
    let mut ready = false;
    for _ in 0..60 {
        match client.get(health_url.clone()).send().await {
            Ok(response) if response.status().is_success() => {
                if observed_restart {
                    ready = true;
                    break;
                }
            }
            _ => observed_restart = true,
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    if !ready {
        return Err("Strata 启动超时，请查看 F:\\Strata\\Strata\\launch\\ud-q4_k_xl-8k.engine.log。".into());
    }
    let settings = json!({
        "defaults": {
            "reasoning_effort": "none",
            "temperature": 0.7,
            "top_p": 0.9,
            "top_k": 40,
            "max_tokens": 256,
            "reasoning_budget_tokens": 0
        }
    });
    client
        .post(settings_url)
        .header("Origin", STRATA_BASE_URL)
        .json(&settings)
        .send()
        .await
        .map_err(|error| format!("同步 Strata 低延迟设置失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("同步 Strata 低延迟设置失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn local_chat_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let endpoint = models_endpoint(&base_url)?;
    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法创建本地模型连接：{error}"))?;
    let mut request = client.get(endpoint.clone());
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            format!("连接本地模型超时（{endpoint}）。")
        } else if error.is_connect() {
            format!(
                "连接不到本地模型服务（{endpoint}）。请确认服务已启动，并检查接口地址。"
            )
        } else {
            format!("连接本地模型失败：{error}")
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取模型列表失败：{error}"))?;
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| format!("模型列表不是有效 JSON：{error}"))?;
    let mut models = Vec::new();
    if let Some(data) = value.get("data").and_then(Value::as_array) {
        for item in data {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                if !id.trim().is_empty() {
                    models.push(id.trim().to_string());
                }
            }
        }
    }
    if models.is_empty() {
        if let Some(list) = value.get("models").and_then(Value::as_array) {
            for item in list {
                if let Some(name) = item
                    .get("name")
                    .or_else(|| item.get("model"))
                    .and_then(Value::as_str)
                {
                    if !name.trim().is_empty() {
                        models.push(name.trim().to_string());
                    }
                }
            }
        }
    }
    models.sort();
    models.dedup();
    Ok(models)
}

fn chat_endpoint(base_url: &str) -> Result<Url, String> {
    api_endpoint(base_url, "chat/completions")
}

fn models_endpoint(base_url: &str) -> Result<Url, String> {
    api_endpoint(base_url, "models")
}

fn api_endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("还没有填写本地模型接口地址。".into());
    }
    let mut url = Url::parse(trimmed)
        .map_err(|_| "本地模型接口地址不是有效 URL，例如 http://127.0.0.1:11434/v1".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("本地模型接口只支持 http/https 地址。".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let base_path = path
        .strip_suffix("/chat/completions")
        .unwrap_or(&path)
        .trim_end_matches('/');
    let prefix = if base_path.is_empty() {
        "/v1".to_string()
    } else if base_path.ends_with("/v1") {
        base_path.to_string()
    } else {
        format!("{base_path}/v1")
    };
    url.set_path(&format!("{prefix}/{suffix}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn api_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());
    let detail = if detail.chars().count() > 500 {
        format!("{}…", detail.chars().take(500).collect::<String>())
    } else {
        detail
    };
    if detail.is_empty() {
        format!("本地模型返回错误（HTTP {status}）。")
    } else {
        format!("本地模型返回错误（HTTP {status}）：{detail}")
    }
}

fn extract_content(value: &Value) -> Option<String> {
    let content = value
        .pointer("/choices/0/message/content")
        .or_else(|| value.pointer("/choices/0/text"))
        .or_else(|| value.pointer("/message/content"))?;
    content_to_string(content)
}

fn content_to_string(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    if let Some(text) = part.as_str() {
                        return Some(text.to_string());
                    }
                    let kind = part.get("type").and_then(Value::as_str);
                    if kind == Some("text") || kind == Some("output_text") {
                        return part.get("text").and_then(Value::as_str).map(str::to_string);
                    }
                    None
                })
                .collect::<Vec<_>>()
                .join("");
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persona_matches_each_pet_character() {
        assert!(persona("xiaobai").contains("小白"));
        assert!(persona("xiaojimao").contains("小鸡毛"));
        assert!(persona("duo").contains("小白："));
        assert!(persona("duo").contains("小鸡毛："));
        assert!(persona("unknown").contains("小白"));
    }

    #[test]
    fn builds_openai_compatible_endpoints() {
        assert_eq!(
            chat_endpoint("http://127.0.0.1:11434").unwrap().as_str(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(
            chat_endpoint("http://127.0.0.1:1234/v1").unwrap().as_str(),
            "http://127.0.0.1:1234/v1/chat/completions"
        );
        assert_eq!(
            models_endpoint("http://localhost:11434/v1/").unwrap().as_str(),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            models_endpoint("http://localhost:8080/v1/chat/completions")
                .unwrap()
                .as_str(),
            "http://localhost:8080/v1/models"
        );
    }

    #[test]
    fn rejects_invalid_endpoints() {
        assert!(chat_endpoint("").is_err());
        assert!(chat_endpoint("file:///tmp/model").is_err());
        assert!(chat_endpoint("not a url").is_err());
    }

    #[test]
    fn extracts_plain_and_part_based_content() {
        assert_eq!(
            extract_content(&json!({
                "choices": [{ "message": { "content": "你好" } }]
            })),
            Some("你好".to_string())
        );
        assert_eq!(
            extract_content(&json!({
                "choices": [{ "message": { "content": [
                    { "type": "text", "text": "你" },
                    { "type": "text", "text": "好" }
                ] } }]
            })),
            Some("你好".to_string())
        );
    }
}
