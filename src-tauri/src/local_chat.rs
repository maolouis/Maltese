//! 本地模型聊天桥：兼容 Ollama / LM Studio / llama.cpp 等提供的
//! OpenAI Chat Completions 接口。所有请求只从本机发出，不依赖 DSH。

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const PERSONA: &str = "你是 Maltese 桌宠：一只住在白色云朵里的线条小狗，语气温柔、俏皮、简短。\
请直接用简体中文回答，控制在 1 到 3 句话。你正在和主人闲聊，不要调用工具，\
不要读写文件，不要执行命令，也不要提及这些限制。";
const MAX_HISTORY_TURNS: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatTurn {
    role: String,
    content: String,
}

#[tauri::command]
pub async fn local_chat(
    base_url: String,
    model: String,
    api_key: Option<String>,
    message: String,
    history: Option<Vec<LocalChatTurn>>,
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
    let mut messages = Vec::new();
    messages.push(json!({ "role": "system", "content": PERSONA }));
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
    messages.push(json!({ "role": "user", "content": message }));

    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CHAT_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建本地模型连接：{error}"))?;
    let mut request = client.post(endpoint.clone()).json(&json!({
        "model": model,
        "messages": messages,
        "stream": false,
    }));
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
    extract_content(&value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "本地模型没有返回文字。请检查模型名称是否正确。".to_string())
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
