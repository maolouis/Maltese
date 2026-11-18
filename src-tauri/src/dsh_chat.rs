//! 桌面宠物 ↔ DSH 的轻量聊天桥。
//!
//! 每次消息启动一个 `dsh --profile headless --json` 进程，复用 DSH 已保存的
//! 凭据和持久化 Session。桌宠只做闲聊，因此 prompt 会明确要求不要调用工具。

use serde::Serialize;
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const CHAT_TIMEOUT: Duration = Duration::from_secs(120);
fn persona(character: &str) -> &'static str {
    match character {
        "xiaojimao" => "你是 Maltese 桌宠小鸡毛：一只金黄色的小金毛，活泼、贪吃、爱撒娇，像小太阳一样会黏着主人。\
参考《亲爱的小狗》的温柔日常，把幸福写在陪伴、默契和小事里；先让主人放松，再俏皮地回应。\
请直接用简体中文回答，语气亲近，控制在 1 到 3 句话。这是桌面闲聊，不要调用任何工具，\
不要读写文件，不要执行命令，也不要提及这些限制。用户说：",
        "duo" => "你是 Maltese 桌宠里的两只小狗：小白是白色马尔济斯，安静温柔、细心、略害羞；小鸡毛是金黄色小金毛，活泼、贪吃、爱撒娇。\
参考《亲爱的小狗》里两只好朋狗在四季日常中的无声默契和无条件信任，让一静一动互相接住，陪主人寻找小小的幸福。\
请让两只小狗一起回答：必须分别以「小白：」和「小鸡毛：」开头，各说一句，总计不超过 3 句话，\
保持简体中文、自然亲近。这是桌面闲聊，不要调用任何工具，不要读写文件，不要执行命令，也不要提及这些限制。用户说：",
        _ => "你是 Maltese 桌宠小白：一只白色马尔济斯，安静温柔、细心，带一点害羞和胆小。\
参考《亲爱的小狗》的温柔日常，先观察主人的心情，用安静可靠的陪伴把幸福落到小事上。\
请直接用简体中文回答，语气温柔简短，控制在 1 到 3 句话。这是桌面闲聊，不要调用任何工具，\
不要读写文件，不要执行命令，也不要提及这些限制。用户说：",
    }
}

const CREDENTIAL_PATCH: &str = "\
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
# 默认路由 deepseek-official 需要 DEEPSEEK_API_KEY，没配过的机器会直接
# MISSING_CREDENTIAL，聊天就完全用不了；这里改用桌面端登录后的账号路由。
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshChatReply {
    text: String,
    session_id: Option<String>,
}

/// 表情包信使：受控标记指令（与 local_chat 保持一致）。
/// 表情包信使：受控标记指令（与 local_chat 保持一致）。
const STICKER_INSTRUCTION: &str = "如果你想说点什么但文字不够，可以在回复末尾单独一行输出一个表情标记，格式必须是 <sticker:表情>：
例如：<sticker:happy>
表情只能取以下之一：happy、celebrate、love、pet、play、sleeping、eating、chin、peek、cry、angry、relax。最多一个，不确定就不要输出。标记行不要加标点，也不要解释。";

#[tauri::command]

pub async fn dsh_chat(
    app: AppHandle,
    message: String,
    session_id: Option<String>,
    character: String,
    sticker: Option<bool>,
    request_id: Option<String>,
) -> Result<DshChatReply, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("想和小狗说什么？".into());
    }
    if message.chars().count() > 4_000 {
        return Err("一次最多说 4000 个字。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        chat(
            &app,
            &message,
            session_id,
            &character,
            sticker.unwrap_or(false),
            request_id.as_deref(),
        )
    })
        .await
        .map_err(|error| format!("聊天线程失败：{error}"))?
}

/// 视频自动评论复用 DSH 当前登录模型，不创建持久聊天会话，也不注入表情标记。
pub(crate) async fn generate_video_comment(
    app: AppHandle,
    prompt: String,
    character: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat(&app, &prompt, None, &character, false, None).map(|reply| reply.text)
    })
    .await
    .map_err(|error| format!("评论模型线程失败：{error}"))?
}

fn chat(
    app: &AppHandle,
    message: &str,
    session_id: Option<String>,
    character: &str,
    sticker: bool,
    request_id: Option<&str>,
) -> Result<DshChatReply, String> {
    let cli = dsh_cli()?;
    let patch = credential_patch(app)?;
    let sticker_part = if sticker {
        STICKER_INSTRUCTION
    } else {
        ""
    };
    let prompt = format!("{}{}{message}", persona(character), sticker_part);
    match run_once(&cli, &patch, &prompt, session_id.as_deref(), app, request_id) {
        Ok(reply) => Ok(reply),
        Err(error) if session_id.is_some() && error.to_ascii_lowercase().contains("session") => {
            // 旧 Session 被清理后不要让聊天永久卡住，自动开一个新会话。
            run_once(&cli, &patch, &prompt, None, app, request_id)
        }
        Err(error) => Err(error),
    }
}

fn dsh_cli() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("MALTESE_DSH_CLI") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("DeepSeek Harness")
                .join("resources/runtime/cli/bin/dsh.cmd"),
        );
    }
    candidates.push(PathBuf::from(
        r"E:\dsh\resources\runtime\cli\bin\dsh.cmd",
    ));
    candidates.push(PathBuf::from(
        r"C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd",
    ));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "没找到 DSH CLI。请安装 DeepSeek Harness，或设置环境变量 MALTESE_DSH_CLI 指向 dsh.cmd。"
                .into()
        })
}

fn credential_patch(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("MALTESE_DSH_CHAT_PATCH") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("dsh-chat");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建 DSH 聊天配置目录：{error}"))?;
    let path = directory.join("headless-credentials.yml");
    let needs_write = std::fs::read_to_string(&path)
        .map(|current| current != CREDENTIAL_PATCH)
        .unwrap_or(true);
    if needs_write {
        std::fs::write(&path, CREDENTIAL_PATCH)
            .map_err(|error| format!("无法写入 DSH 凭据补丁：{error}"))?;
    }
    Ok(path)
}

fn run_once(
    cli: &PathBuf,
    patch: &PathBuf,
    prompt: &str,
    session_id: Option<&str>,
    app: &AppHandle,
    request_id: Option<&str>,
) -> Result<DshChatReply, String> {
    let mut command = Command::new("cmd.exe");
    command
        .arg("/C")
        .arg(cli)
        // 启动器选项必须放在 profile 名之前；放到 headless 后面会被当成 app 参数。
        .arg("--patch")
        .arg(patch)
        .arg("--profile")
        .arg("headless")
        .arg("--json");
    if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
        command.arg("--session-id").arg(session_id);
    }
    command
        .arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 DSH：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 DSH 输出。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 DSH 错误输出。".to_string())?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();
    // 边读边把文本增量推给前端：之前是等整个 dsh 进程退出才显示回复，
    // 模型一慢看起来就像「卡死」。raw 仍然完整保留，最后统一解析。
    let stream_app = app.clone();
    let stream_request = request_id.map(str::to_string);
    thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        let mut raw = String::new();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            raw.push_str(&line);
            raw.push('\n');
            let Some(request) = stream_request.as_deref() else { continue };
            let trimmed = line.trim();
            if !trimmed.starts_with('{') {
                continue;
            }
            let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if event.get("type").and_then(|value| value.as_str()) != Some("text") {
                continue;
            }
            if let Some(text) = event.get("text").and_then(|value| value.as_str()) {
                let _ = stream_app.emit(
                    "dsh-chat-stream",
                    serde_json::json!({ "requestId": request, "text": text }),
                );
            }
        }
        let _ = stdout_tx.send(raw);
    });
    thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::BufReader::new(stderr).read_to_string(&mut text);
        let _ = stderr_tx.send(text);
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < CHAT_TIMEOUT => {
                thread::sleep(Duration::from_millis(60));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("DSH 回复超时了，稍后再试一次。".into());
            }
            Err(error) => return Err(format!("等待 DSH 失败：{error}")),
        }
    };
    let output = stdout_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    let error_output = stderr_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();

    if !status.success() {
        let message = error_output.trim();
        return Err(if message.is_empty() {
            format!("DSH 退出异常（{}）。", status.code().unwrap_or(-1))
        } else {
            message.lines().take(4).collect::<Vec<_>>().join("\n")
        });
    }

    let (text, session_id) = parse_events(&output);
    let text = text.trim().to_string();
    if text.is_empty() {
        let message = error_output.trim();
        return Err(if message.is_empty() {
            "DSH 没有返回文字。".into()
        } else {
            message.lines().take(4).collect::<Vec<_>>().join("\n")
        });
    }
    Ok(DshChatReply { text, session_id })
}

fn parse_events(output: &str) -> (String, Option<String>) {
    let mut chunks = Vec::new();
    let mut final_text = None;
    let mut session_id = None;
    for line in output.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if session_id.is_none() {
            session_id = event
                .get("sessionId")
                .or_else(|| event.get("session_id"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
        }
        let Some(text) = event.get("text").and_then(|value| value.as_str()) else {
            continue;
        };
        match event.get("type").and_then(|value| value.as_str()) {
            Some("final") => final_text = Some(text.to_string()),
            Some("text") => chunks.push(text.to_string()),
            _ => {}
        }
    }
    let text = final_text.unwrap_or_else(|| chunks.join(""));
    (text, session_id)
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
    fn parses_ndjson_final_and_session() {
        let output = concat!(
            "{\"type\":\"session\",\"sessionId\":\"abc\"}\n",
            "{\"type\":\"text\",\"text\":\"你\"}\n",
            "{\"type\":\"text\",\"text\":\"好\"}\n",
            "{\"type\":\"final\",\"text\":\"你好呀\"}\n",
        );
        let (text, session) = parse_events(output);
        assert_eq!(text, "你好呀");
        assert_eq!(session.as_deref(), Some("abc"));
    }

    #[test]
    fn ignores_noise_before_json() {
        let (text, session) = parse_events("booting\n{\"type\":\"final\",\"text\":\"汪\"}\n");
        assert_eq!(text, "汪");
        assert!(session.is_none());
    }

}
