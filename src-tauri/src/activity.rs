// 读取当前前台进程，判断用户正在做什么（写代码 / 写文档 / 开会 / 看视频……）。
// 纯本地：只读窗口标题与进程可执行文件名，不截屏、不联网。
use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveActivity {
    /// 活动类型：code / document / meeting / chat / browser / design / game / video / music / other
    pub kind: String,
    /// 进程可执行文件名（小写）
    pub process: String,
    /// 窗口标题（用于判断是否真的在写东西）
    pub title: String,
}

fn classify(process: &str, title: &str) -> &'static str {
    let p = process.to_ascii_lowercase();
    let t = title.to_lowercase();
    let is = |names: &[&str]| names.iter().any(|name| p == *name);

    if is(&[
        "cloudmusic.exe",
        "qqmusic.exe",
        "spotify.exe",
        "kugou.exe",
        "kuwo.exe",
        "foobar2000.exe",
    ]) {
        return "music";
    }
    if is(&[
        "code.exe",
        "cursor.exe",
        "trae.exe",
        "windsurf.exe",
        "zed.exe",
        "idea64.exe",
        "pycharm64.exe",
        "webstorm64.exe",
        "clion64.exe",
        "rider64.exe",
        "goland64.exe",
        "studio64.exe",
        "devenv.exe",
        "sublime_text.exe",
        "notepad++.exe",
        "vim.exe",
        "nvim.exe",
        "emacs.exe",
        "windowsterminal.exe",
        "wt.exe",
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "mintty.exe",
        "git-bash.exe",
        "hbuilderx.exe",
    ]) {
        return "code";
    }
    if is(&[
        "winword.exe",
        "excel.exe",
        "powerpnt.exe",
        "outlook.exe",
        "onenote.exe",
        "wps.exe",
        "et.exe",
        "wpp.exe",
        "notion.exe",
        "obsidian.exe",
        "typora.exe",
        "acrobat.exe",
        "acrord32.exe",
        "foxitreader.exe",
        "sumatrapdf.exe",
        "scrivener.exe",
    ]) {
        return "document";
    }
    if is(&[
        "wemeetapp.exe",
        "teams.exe",
        "ms-teams.exe",
        "zoom.exe",
        "dingtalk.exe",
        "feishu.exe",
        "lark.exe",
    ]) {
        return "meeting";
    }
    if is(&["wechat.exe", "weixin.exe", "qq.exe", "telegram.exe", "discord.exe"]) {
        return "chat";
    }
    if is(&[
        "photoshop.exe",
        "illustrator.exe",
        "figma.exe",
        "coreldrw.exe",
        "inkscape.exe",
        "blender.exe",
        "afterfx.exe",
        "premiere pro.exe",
    ]) {
        return "design";
    }
    if is(&[
        "steam.exe",
        "league of legends.exe",
        "genshinimpact.exe",
        "yuanshen.exe",
        "cs2.exe",
        "valorant.exe",
        "epicgameslauncher.exe",
    ]) {
        return "game";
    }
    if is(&[
        "potplayermini64.exe",
        "potplayermini.exe",
        "vlc.exe",
        "mpc-hc64.exe",
        "哔哩哔哩.exe",
        "iqiyi.exe",
        "youku.exe",
    ]) || t.contains("bilibili") || t.contains("哔哩哔哩") {
        return "video";
    }
    if is(&[
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "360se.exe",
        "360chrome.exe",
        "qqbrowser.exe",
        "sogouexplorer.exe",
        "arc.exe",
    ]) {
        return "browser";
    }
    "other"
}

fn foreground_window() -> HWND {
    unsafe { GetForegroundWindow() }
}

fn window_title(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 512];
        let length = GetWindowTextW(window, &mut buffer);
        String::from_utf16_lossy(&buffer[..length as usize])
    }
}

fn window_process(window: HWND) -> String {
    unsafe {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return String::new();
        };
        let mut buffer = [0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        if result.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        path.rsplit(|c| c == '\\' || c == '/').next().unwrap_or_default().to_string()
    }
}

#[tauri::command]
pub fn get_active_activity() -> Result<ActiveActivity, String> {
    let window = foreground_window();
    if window.is_invalid() {
        return Err("没有前台窗口".into());
    }
    let process = window_process(window);
    if process.is_empty() {
        return Err("无法读取前台进程".into());
    }
    let title = window_title(window);
    let kind = classify(&process, &title);
    Ok(ActiveActivity {
        kind: kind.to_string(),
        process,
        title,
    })
}