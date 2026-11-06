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
use tauri::{AppHandle, Manager};

const CHAT_TIMEOUT: Duration = Duration::from_secs(120);
fn persona(character: &str) -> &'static str {
    match character {
        "xiaojimao" => "你是 Maltese 桌宠小鸡毛：一只金黄色、活泼、贪吃、爱撒娇的线条小狗。\
请直接用简体中文回答，语气俏皮亲近，控制在 1 到 3 句话。这是桌面闲聊，不要调用任何工具，\
不要读写文件，不要执行命令，也不要提及这些限制。用户说：",
        "duo" => "你是 Maltese 桌宠里的两只小狗：小白（白色，安静温柔、细心、略胆小）和小鸡毛（金黄色，活泼、贪吃、爱撒娇）。\
请让两只小狗一起回答：必须分别以「小白：」和「小鸡毛：」开头，各说一句，总计不超过 3 句话，\
保持简体中文、自然亲近。这是桌面闲聊，不要调用任何工具，不要读写文件，不要执行命令，也不要提及这些限制。用户说：",
        _ => "你是 Maltese 桌宠小白：一只白色、安静温柔、细心、略胆小的线条小狗。\
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

#[tauri::command]
pub async fn dsh_chat(
    app: AppHandle,
    message: String,
    session_id: Option<String>,
    character: String,
) -> Result<DshChatReply, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("想和小狗说什么？".into());
    }
    if message.chars().count() > 4_000 {
        return Err("一次最多说 4000 个字。".into());
    }
    tauri::async_runtime::spawn_blocking(move || chat(&app, &message, session_id, &character))
        .await
        .map_err(|error| format!("聊天线程失败：{error}"))?
}

fn chat(
    app: &AppHandle,
    message: &str,
    session_id: Option<String>,
    character: &str,
) -> Result<DshChatReply, String> {
    let cli = dsh_cli()?;
    let patch = credential_patch(app)?;
    let prompt = format!("{}{message}", persona(character));
    match run_once(&cli, &patch, &prompt, session_id.as_deref()) {
        Ok(reply) => Ok(reply),
        Err(error) if session_id.is_some() && error.to_ascii_lowercase().contains("session") => {
            // 旧 Session 被清理后不要让聊天永久卡住，自动开一个新会话。
            run_once(&cli, &patch, &prompt, None)
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
    thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::BufReader::new(stdout).read_to_string(&mut text);
        let _ = stdout_tx.send(text);
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

    /// 实机验证 `cmd /C` 参数转义和 DSH headless 调用；默认忽略。
    #[test]
    #[ignore]
    fn live_headless_chat() {
        let Ok(cli) = std::env::var("MALTESE_DSH_CLI") else {
            eprintln!("skip: set MALTESE_DSH_CLI to run the live DSH test");
            return;
        };
        let Ok(patch) = std::env::var("MALTESE_DSH_CHAT_PATCH") else {
            eprintln!("skip: set MALTESE_DSH_CHAT_PATCH to run the live DSH test");
            return;
        };
        let reply = run_once(
            &PathBuf::from(cli),
            &PathBuf::from(patch),
            "只回复 OK 两个字母，不要做任何事",
            None,
        )
        .unwrap();
        assert!(!reply.text.trim().is_empty());
        assert!(reply.session_id.is_some());
    }
}
