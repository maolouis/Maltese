//! 浏览器实例管理：发现、启动、端口与退出检测。
//!
//! 小狗使用独立 `--user-data-dir` 的有窗口浏览器；除首次登录外不调用任何
//! 前景化 API，也不使用无界面模式。

use super::model::{now_seconds, Platform};
use super::{VideoError, VideoResult};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::OnceLock,
    time::{Duration, Instant},
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
/// 新 profile 根：`<data_root()>/video-browsers`（默认 `default`，账号 `accounts/<id>`）。
pub const PROFILE_ROOT_NAME: &str = "video-browsers";
/// 旧位置 `%LOCALAPPDATA%\Maltese`：迁移失败或新位置不可写时作为只读回退。
pub const LEGACY_APP_DIR_NAME: &str = "Maltese";
const LEGACY_DEFAULT_NAME: &str = "video-profile";
const LEGACY_ACCOUNTS_NAME: &str = "video-accounts";
/// 迁移成功后的旧目录改名后缀（保留 7 天，由用户确认后自行清理，不自动删除）。
const MIGRATED_SUFFIX_PREFIX: &str = ".migrated-";
pub const DEFAULT_PORT: u16 = 9333;
pub const MIN_MAJOR_VERSION: u32 = 120;
/// 启动后最多等多久让 CDP 端口开始监听（QA U1：以前 launch 成功就算成功）。
pub const CDP_READY_TIMEOUT: Duration = Duration::from_secs(8);
/// 「打开登录窗」最多等多久出现可见浏览器窗口（验收：5 秒内）。
pub const LOGIN_WINDOW_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHandle {
    pub pid: u32,
    pub port: u16,
    pub profile_dir: String,
    pub started_at: u64,
    pub executable: String,
}

/// 专用浏览器的「上次实例」标记：应用重启后靠它认出上次留下的专用浏览器。
///
/// 只写 pid / port / profile，不含任何账号信息；读取时还会校验 pid 存活、
/// 进程确实是 Chrome/Edge、CDP 端口可连接，任一不满足就当作残留清掉。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMarker {
    pub pid: u32,
    pub port: u16,
    pub profile_dir: String,
    pub started_at: u64,
}

/// 复用决策（纯函数，便于单测）：内存里的实例优先，其次是上次留下的同 profile 实例。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserReuse {
    /// 内存里的子进程还活着且 CDP 可用：直接用。
    Owned,
    /// 上次运行留下的实例还活着：接管它的端口继续用，不再开新进程。
    External,
    /// 没有可复用实例：清理残留后重新启动。
    Fresh,
}

pub fn reuse_decision(
    owned_alive_and_ready: bool,
    marker_matches_profile: bool,
    marker_pid_alive: bool,
    marker_cdp_ready: bool,
) -> BrowserReuse {
    if owned_alive_and_ready {
        return BrowserReuse::Owned;
    }
    if marker_matches_profile && marker_pid_alive && marker_cdp_ready {
        return BrowserReuse::External;
    }
    BrowserReuse::Fresh
}

pub fn marker_path() -> PathBuf {
    // 实例标记跟着 profile 根走：新位置 <data_root()>/video-browsers/video-browser.json。
    profile_root().join("video-browser.json")
}

pub fn read_marker() -> Option<BrowserMarker> {
    let raw = std::fs::read_to_string(marker_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_marker(handle: &BrowserHandle) {
    let marker = BrowserMarker {
        pid: handle.pid,
        port: handle.port,
        profile_dir: handle.profile_dir.clone(),
        started_at: handle.started_at,
    };
    if let Ok(raw) = serde_json::to_string(&marker) {
        let _ = std::fs::write(marker_path(), raw);
    }
}

pub fn clear_marker() {
    let _ = std::fs::remove_file(marker_path());
}

/// profile 路径比较：Windows 不区分大小写、分隔符可能混用，先统一再比。
pub fn same_profile(left: &str, right: &Path) -> bool {
    normalize_profile(left) == normalize_profile(&right.to_string_lossy())
}

fn normalize_profile(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// 端口上是否已经能连上 CDP（TCP 能连即认为调试接口在监听）。
pub fn cdp_ready(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// 等 CDP 端口起来；返回 false 表示这次启动实际没成功（必须关掉进程再报错）。
pub fn wait_for_cdp(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if cdp_ready(port) {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 异步版本：给 `#[tauri::command]` / 异步会话用，等待期间不阻塞线程（UI 主线程不会假死）。
pub async fn wait_for_cdp_async(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if cdp_ready(port) {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// pid 还活着、且进程镜像确实是 Chrome / Edge（防止 pid 被系统复用后误杀/误判）。
pub fn pid_alive_browser(pid: u32) -> bool {
    let Some(name) = process_image_name(pid) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    name.ends_with("chrome.exe") || name.ends_with("msedge.exe")
}

/// 上次留下的同 profile 实例：标记匹配 + pid 存活 + CDP 可连接才复用。
///
/// 标记缺失时（旧版本启动的残留实例、或标记被删）退回「命令行匹配」：
/// 找 `--user-data-dir=<profile>` 且带 `--remote-debugging-port=` 的浏览器进程。
pub fn find_reusable(profile: &Path) -> Option<BrowserHandle> {
    if let Some(marker) = read_marker() {
        if same_profile(&marker.profile_dir, profile)
            && reuse_decision(false, true, pid_alive_browser(marker.pid), cdp_ready(marker.port))
                == BrowserReuse::External
        {
            return Some(BrowserHandle {
                pid: marker.pid,
                port: marker.port,
                profile_dir: marker.profile_dir,
                started_at: marker.started_at,
                executable: String::new(),
            });
        }
        if !pid_alive_browser(marker.pid) {
            clear_marker();
        }
    }
   find_profile_browser(profile)
}

/// 命令行扫描：同 profile 且带调试端口的浏览器主进程（兼容旧版本留下的残留实例）。
pub fn find_profile_browser(profile: &Path) -> Option<BrowserHandle> {
    let mut best: Option<BrowserHandle> = None;
    for candidate in query_profile_browsers(profile) {
        let Some(port) = candidate.port else {
            continue;
        };
        if !cdp_ready(port) {
            continue;
        }
        let handle = BrowserHandle {
            pid: candidate.pid,
            port,
            profile_dir: profile.to_string_lossy().into_owned(),
            started_at: now_seconds(),
            executable: candidate.executable.unwrap_or_default(),
        };
        // 优先挑已经能连上 CDP 的；多个就取第一个。
        best = Some(handle);
        break;
    }
    best
}

struct ProfileBrowser {
    pid: u32,
    port: Option<u16>,
    executable: Option<String>,
}

const BROWSER_QUERY_SCRIPT: &str = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";

/// 用 PowerShell CIM 查一次浏览器进程命令行（只在没有实例标记时调用，约 0.3–1s）。
fn query_profile_browsers(profile: &Path) -> Vec<ProfileBrowser> {
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", BROWSER_QUERY_SCRIPT])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let items: Vec<&serde_json::Value> = match &parsed {
        serde_json::Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let wanted = normalize_profile(&profile.to_string_lossy());
    let mut browsers = Vec::new();
    for item in items {
        let command_line = item
            .get("CommandLine")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if command_line.is_empty() {
            continue;
        }
        let normalized = normalize_profile(command_line);
        if !normalized.contains(&wanted) {
            continue;
        }
        let Some(pid) = item.get("ProcessId").and_then(|value| value.as_u64()) else {
            continue;
        };
        // 只认浏览器主进程：只有它带 --remote-debugging-port。
        let port = command_line
            .split_whitespace()
            .find_map(|part| part.strip_prefix("--remote-debugging-port="))
            .and_then(|value| value.trim_matches('"').parse::<u16>().ok());
        if port.is_none() {
            continue;
        }
        browsers.push(ProfileBrowser {
            pid: pid as u32,
            port,
            executable: item
                .get("ExecutablePath")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        });
    }
    browsers
}

/// 关掉同 profile 的所有残留实例（优先用标记，标记缺失时用命令行匹配）。
/// 返回关掉的实例数；只杀「确实是浏览器且带调试端口」的进程树。
pub fn close_profile_instance(profile: &Path) -> usize {
    let mut closed = 0;
    if let Some(marker) = read_marker() {
        if same_profile(&marker.profile_dir, profile) {
            if pid_alive_browser(marker.pid) {
                terminate_process_tree(marker.pid);
                closed = 1;
            }
            clear_marker();
        }
    }
    for candidate in query_profile_browsers(profile) {
        if !pid_alive_browser(candidate.pid) {
            continue;
        }
        terminate_process_tree(candidate.pid);
        closed += 1;
    }
    clear_marker();
    closed
}

/// 关闭专用浏览器进程树（Chrome 会派生子进程，必须 /T）。
pub fn terminate_process_tree(pid: u32) {
    let _ = Command::new("taskkill.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

/// 某个进程拥有的可见顶层窗口数：用来确认「打开登录窗」真的出现了窗口。
pub fn visible_window_count_for_pid(pid: u32) -> usize {
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{HWND, LPARAM},
            UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible},
        },
    };

    struct Search {
        pid: u32,
        count: usize,
    }

    unsafe extern "system" fn callback(window: HWND, context: LPARAM) -> BOOL {
        let search = &mut *(context.0 as *mut Search);
        if !IsWindowVisible(window).as_bool() {
            return true.into();
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == search.pid {
            search.count += 1;
        }
        true.into()
    }

    let mut search = Search { pid, count: 0 };
    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM((&mut search as *mut Search) as isize));
    }
    search.count
}

pub fn wait_for_visible_window(pid: u32, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if visible_window_count_for_pid(pid) > 0 {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 异步版本：登录窗等待用，不阻塞命令线程。
pub async fn wait_for_visible_window_async(pid: u32, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if visible_window_count_for_pid(pid) > 0 {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// 在已运行的专用浏览器里新开一个标签页（登录窗复用时用）。
pub fn open_target(port: u16, url: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let encoded = url
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('?', "%3F")
        .replace('&', "%26");
    let request = format!(
        "PUT /json/new?{encoded} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 201")
}

#[cfg(windows)]
fn process_image_name(pid: u32) -> Option<String> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        Some(String::from_utf16_lossy(&path[..length as usize]))
    }
}

#[cfg(not(windows))]
fn process_image_name(_pid: u32) -> Option<String> {
    None
}

#[derive(Debug)]
pub struct BrowserProcess {
    pub handle: BrowserHandle,
    child: Child,
}

/// 当前专用浏览器的归属：本次启动（能拿到子进程句柄）还是接管上次留下的实例。
pub enum BrowserInstance {
    Owned(BrowserProcess),
    External(BrowserHandle),
}

impl BrowserInstance {
    pub fn handle(&self) -> &BrowserHandle {
        match self {
            BrowserInstance::Owned(process) => &process.handle,
            BrowserInstance::External(handle) => handle,
        }
    }

    pub fn is_alive(&mut self) -> bool {
        match self {
            BrowserInstance::Owned(process) => matches!(process.child.try_wait(), Ok(None)),
            BrowserInstance::External(handle) => pid_alive_browser(handle.pid),
        }
    }

    pub fn close(&mut self) {
        match self {
            BrowserInstance::Owned(process) => process.close(),
            BrowserInstance::External(handle) => terminate_process_tree(handle.pid),
        }
        clear_marker();
    }
}

impl BrowserProcess {
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn close(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn working_set_mb(&self) -> Option<u64> {
        working_set_mb(self.handle.pid)
    }

    pub fn occupancy(&self) -> &'static str {
        occupancy_level(self.working_set_mb().unwrap_or(0))
    }
}

pub fn occupancy_level(working_set_mb: u64) -> &'static str {
    if working_set_mb < 400 {
        "low"
    } else if working_set_mb <= 900 {
        "mid"
    } else {
        "high"
    }
}

/// 旧 profile 位置：`%LOCALAPPDATA%\Maltese`（只读回退 + 迁移来源）。
pub fn legacy_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(LEGACY_APP_DIR_NAME)
}

fn sanitize_account_id(account_id: &str) -> String {
    let safe = account_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_')
        .take(64)
        .collect::<String>();
    if safe.is_empty() {
        "default".to_string()
    } else {
        safe
    }
}

/// profile 根（进程内缓存）：`<data_root()>/video-browsers`。
///
/// 启动首次调用时完成一次性迁移：新位置不存在 + 旧 `%LOCALAPPDATA%\Maltese` 有数据
/// → 复制（校验文件数 + 总大小）→ 成功后旧目录改名 `<名字>.migrated-<时间戳>`（保留 7 天）。
/// 新位置不可写或迁移失败 → 回退旧位置（只读回退），绝不阻断启动、绝不丢登录态。
pub fn profile_root() -> PathBuf {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE.get_or_init(resolve_profile_root).clone()
}

fn resolve_profile_root() -> PathBuf {
    let legacy = legacy_root();
    let new_root = crate::paths::data_root().join(PROFILE_ROOT_NAME);
    // 单元测试不碰真实用户目录；迁移逻辑由 copy_verified / remap 的纯函数单测覆盖。
    if cfg!(test) {
        return new_root;
    }
    if !writable_dir(&new_root) {
        profile_log(&format!(
            "VIDEO_PROFILE_ROOT root={} ok=false fallback={} reason=new_root_not_writable",
            new_root.display(),
            legacy.display()
        ));
        return legacy;
    }
    match migrate_profiles(&new_root, &legacy) {
        Ok(migration) => {
            let from = migration
                .migrated_from
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "-".to_string());
            profile_log(&format!(
                "VIDEO_PROFILE_ROOT root={} migrated_from={} ok=true items={}",
                new_root.display(),
                from,
                migration.migrated_items.join(",")
            ));
            for kept in &migration.kept_legacy {
                profile_log(&format!(
                    "VIDEO_PROFILE_LEGACY_KEPT path={} note=keep_7_days_manual_cleanup",
                    kept.display()
                ));
            }
            new_root
        }
        Err(reason) => {
            profile_log(&format!(
                "VIDEO_PROFILE_MIGRATION_FAILED reason={} root={} fallback={} ok=false",
                reason,
                new_root.display(),
                legacy.display()
            ));
            // 回退旧位置：新位置即使存在也不要用（空 profile = 登录态丢失）。
            legacy
        }
    }
}

/// 账号 profile 根：`<profile_root()>/accounts`。
pub fn accounts_root() -> PathBuf {
    profile_root().join("accounts")
}

/// 默认（未绑定账号）profile：`<data_root()>/video-browsers/default`。
pub fn profile_dir() -> PathBuf {
    profile_root().join("default")
}

/// 每个小狗账号拥有独立 profile，避免和主人的登录态混用。
pub fn account_profile_dir(account_id: &str) -> PathBuf {
    accounts_root().join(sanitize_account_id(account_id))
}

/// 把历史记录（`accounts.json` 的 `profileDir`）里的 path 映射到当前 profile 根。
///
/// 旧路径自动重映射：`<legacy>\video-profile` → `<new>\default`、
/// `<legacy>\video-accounts\<id>` → `<new>\accounts\<id>`；不认识的路径原样返回。
pub fn resolve_profile(recorded: &str) -> PathBuf {
    let recorded = recorded.trim();
    if recorded.is_empty() {
        return profile_dir();
    }
    remap_legacy_profile(Path::new(recorded), &legacy_root(), &profile_root())
}

/// 纯函数（便于单测）：旧根下的 profile 路径重映射到新根，其它路径原样返回。
fn remap_legacy_profile(recorded: &Path, legacy_root: &Path, new_root: &Path) -> PathBuf {
    let Some(relative) = strip_prefix_ci(recorded, legacy_root) else {
        return recorded.to_path_buf();
    };
    let mut components = relative.components();
    let Some(first) = components.next() else {
        return recorded.to_path_buf();
    };
    let first = first.as_os_str().to_string_lossy().to_ascii_lowercase();
    let rest: PathBuf = components.collect();
    let is_default = first == LEGACY_DEFAULT_NAME
        || first.starts_with(&format!("{LEGACY_DEFAULT_NAME}{MIGRATED_SUFFIX_PREFIX}"));
    let is_account = first == LEGACY_ACCOUNTS_NAME
        || first.starts_with(&format!("{LEGACY_ACCOUNTS_NAME}{MIGRATED_SUFFIX_PREFIX}"));
    if is_default {
        return if rest.as_os_str().is_empty() {
            new_root.join("default")
        } else {
            new_root.join("default").join(rest)
        };
    }
    if is_account {
        return if rest.as_os_str().is_empty() {
            new_root.join("accounts")
        } else {
            new_root.join("accounts").join(rest)
        };
    }
    recorded.to_path_buf()
}

/// 大小写 / 分隔符不敏感的前缀剥离（Windows 语义）。
fn strip_prefix_ci(path: &Path, base: &Path) -> Option<PathBuf> {
    let path_components: Vec<_> = path.components().collect();
    let base_components: Vec<_> = base.components().collect();
    if base_components.is_empty() || base_components.len() > path_components.len() {
        return None;
    }
    for (path_part, base_part) in path_components.iter().zip(base_components.iter()) {
        let left = path_part.as_os_str().to_string_lossy();
        let right = base_part.as_os_str().to_string_lossy();
        if !left.eq_ignore_ascii_case(&right) {
            return None;
        }
    }
    Some(path_components[base_components.len()..].iter().collect())
}

fn profile_log(message: &str) {
    crate::paths::startup_log(message);
}

fn dir_has_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            let (sub_files, sub_bytes) = copy_tree(&from, &to)?;
            files += sub_files;
            bytes += sub_bytes;
        } else {
            bytes += std::fs::copy(&from, &to)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

fn tree_stats(dir: &Path) -> std::io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let (sub_files, sub_bytes) = tree_stats(&entry.path())?;
            files += sub_files;
            bytes += sub_bytes;
        } else {
            files += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((files, bytes))
}

/// 复制 + 校验（文件数与总大小必须与源一致）；校验失败删掉半成品并报错。
fn copy_verified(src: &Path, dst: &Path) -> Result<(u64, u64), String> {
    let copied = copy_tree(src, dst).map_err(|error| format!("copy:{error}"))?;
    let actual = tree_stats(dst).map_err(|error| format!("stats:{error}"))?;
    let expected = tree_stats(src).map_err(|error| format!("source_stats:{error}"))?;
    if copied != expected || actual != expected {
        let _ = std::fs::remove_dir_all(dst);
        return Err(format!(
            "verify expected={} files/{} bytes actual={} files/{} bytes",
            expected.0, expected.1, actual.0, actual.1
        ));
    }
    Ok(actual)
}

#[derive(Debug, Default)]
struct ProfileMigration {
    migrated_from: Option<PathBuf>,
    migrated_items: Vec<String>,
    kept_legacy: Vec<PathBuf>,
}

/// 启动迁移：旧位置有数据、新位置还没有 → 复制校验 → 旧目录改名保留。
///
/// 任何一步失败都返回 Err（调用方回退旧位置），旧目录始终保持可用。
fn migrate_profiles(new_root: &Path, legacy: &Path) -> Result<ProfileMigration, String> {
    let mut report = ProfileMigration::default();
    let mut copied: Vec<PathBuf> = Vec::new();
    // 本次复制出来的目标目录（失败时回滚，避免半成品挡住下次迁移）。
    let mut created_targets: Vec<PathBuf> = Vec::new();
    let legacy_default = legacy.join(LEGACY_DEFAULT_NAME);
    let new_default = new_root.join("default");
    if dir_has_entries(&legacy_default) && !dir_has_entries(&new_default) {
        match copy_verified(&legacy_default, &new_default) {
            Ok(_) => {
                created_targets.push(new_default.clone());
                copied.push(legacy_default.clone());
                report.migrated_items.push("video-profile".to_string());
            }
            Err(reason) => {
                for target in &created_targets {
                    let _ = std::fs::remove_dir_all(target);
                }
                return Err(format!("default:{reason}"));
            }
        }
    }
    let legacy_accounts = legacy.join(LEGACY_ACCOUNTS_NAME);
    let new_accounts = new_root.join("accounts");
    let mut account_names: Vec<String> = std::fs::read_dir(&legacy_accounts)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                // 已迁移保留的旧目录（`<id>.migrated-<stamp>`）不是账号，跳过，
                // 否则每次启动都会把它们当新账号再复制一遍。
                .filter(|name| !name.contains(MIGRATED_SUFFIX_PREFIX))
                .collect()
        })
        .unwrap_or_default();
    account_names.sort();
    let mut copied_accounts = 0usize;
    for name in &account_names {
        let from = legacy_accounts.join(name);
        let to = new_accounts.join(name);
        if !dir_has_entries(&from) || dir_has_entries(&to) {
            continue;
        }
        match copy_verified(&from, &to) {
            Ok(_) => {
                created_targets.push(to);
                copied.push(from);
                copied_accounts += 1;
            }
            Err(reason) => {
                for target in &created_targets {
                    let _ = std::fs::remove_dir_all(target);
                }
                return Err(format!("account:{name}:{reason}"));
            }
        }
    }
    if copied_accounts > 0 {
        report.migrated_items.push(format!("video-accounts x{copied_accounts}"));
    }
    if copied.is_empty() {
        return Ok(report);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    report.migrated_from = Some(legacy.to_path_buf());
    // 复制已校验成功 → 旧目录只改名（绝不删除），失败也只是保留原名继续可用。
    for source in &copied {
        let target = source.with_file_name(format!(
            "{}{MIGRATED_SUFFIX_PREFIX}{stamp}",
            source
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "profile".to_string())
        ));
        match std::fs::rename(source, &target) {
            Ok(()) => report.kept_legacy.push(target),
            Err(error) => {
                profile_log(&format!(
                    "VIDEO_PROFILE_LEGACY_RENAME_FAILED path={} reason={error} note=keep_original",
                    source.display()
                ));
                report.kept_legacy.push(source.clone());
            }
        }
    }
    // 账号都搬走后，空壳的旧 video-accounts 目录也改名（有残留就不动）。
    if !account_names.is_empty() && !dir_has_entries(&legacy_accounts) {
        let target = legacy_accounts.with_file_name(format!(
            "{LEGACY_ACCOUNTS_NAME}{MIGRATED_SUFFIX_PREFIX}{stamp}"
        ));
        if std::fs::rename(&legacy_accounts, &target).is_ok() {
            report.kept_legacy.push(target);
        }
    }
    Ok(report)
}

pub fn candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = std::env::var_os("MALTESE_TEST_BROWSER_PATH") {
        candidates.push(PathBuf::from(value));
    }
    for root in [
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        let root = PathBuf::from(root);
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Programs/Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
    }
    candidates
}

pub fn find_browser() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| path.is_file())
}

/// 从文件版本信息读主版本；读取失败返回 None（不阻塞启动）。
pub fn browser_major_version(path: &Path) -> Option<u32> {
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductMajorPart"
    );
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// 端口占用时换备用端口，最多重试 5 次。
pub fn pick_port(preferred: u16) -> VideoResult<u16> {
    for offset in 0..=5u16 {
        let candidate = preferred.saturating_add(offset);
        if candidate == 0 {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }
    Err(VideoError::new(
        "PORT_BUSY",
        "本机调试端口被占用，无法启动小狗浏览器。",
    ))
}

pub fn launch(
    platform: Platform,
    port: u16,
    profile: &Path,
    login_window: bool,
) -> VideoResult<BrowserProcess> {
    let executable = find_browser().ok_or_else(|| {
        VideoError::new(
            "BROWSER_UNAVAILABLE",
            "没有找到 Chrome 或 Edge（需要 120 及以上版本）。",
        )
    })?;
    if let Some(major) = browser_major_version(&executable) {
        if major < MIN_MAJOR_VERSION {
            return Err(VideoError::with_detail(
                "BROWSER_UNAVAILABLE",
                "浏览器版本过低，需要 Chrome/Edge 120 及以上。",
                format!("检测到主版本 {major}"),
            ));
        }
    }
    if profile.as_os_str().is_empty() {
        return Err(VideoError::new("START_FAILED", "登录 profile 目录无效。"));
    }
    std::fs::create_dir_all(profile).map_err(|error| {
        VideoError::with_detail("START_FAILED", "无法创建登录 profile 目录。", error.to_string())
    })?;

    let mut command = Command::new(&executable);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--remote-allow-origins=http://127.0.0.1:{port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(if login_window {
            platform.feed_url()
        } else {
            "about:blank"
        });
    if login_window {
        command.arg("--new-window");
    }
    let child = command.spawn().map_err(|error| {
        VideoError::with_detail("START_FAILED", "无法启动小狗浏览器。", error.to_string())
    })?;

    Ok(BrowserProcess {
        handle: BrowserHandle {
            pid: child.id(),
            port,
            profile_dir: profile.to_string_lossy().to_string(),
            started_at: now_seconds(),
            executable: executable.to_string_lossy().to_string(),
        },
        child,
    })
}

#[cfg(windows)]
fn working_set_mb(pid: u32) -> Option<u64> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let ok = K32GetProcessMemoryInfo(
            process,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        let _ = CloseHandle(process);
        if ok.as_bool() {
            Some(counters.WorkingSetSize as u64 / 1024 / 1024)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn working_set_mb(_pid: u32) -> Option<u64> {
    None
}

pub fn wait_for_process_exit(process: &mut BrowserProcess, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if !process.is_alive() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// 仅用于「打开登录窗」这一显式路径；其他流程不得调用前景化 API。
#[cfg(windows)]
pub fn focus_browser_window(platform: Platform) -> bool {
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
                SetForegroundWindow,
            },
        },
    };

    struct Search {
        platform: Platform,
        found: Option<HWND>,
    }

    unsafe extern "system" fn callback(window: HWND, context: LPARAM) -> BOOL {
        let search = &mut *(context.0 as *mut Search);
        if !IsWindowVisible(window).as_bool() {
            return true.into();
        }
        let mut title = [0u16; 512];
        let length = GetWindowTextW(window, &mut title) as usize;
        let title = String::from_utf16_lossy(&title[..length.min(title.len())]);
        if !super::rules::title_matches(&title, search.platform) {
            return true.into();
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == 0 {
            return true.into();
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return true.into();
        };
        let mut path = [0u16; 32768];
        let mut path_length = path.len() as u32;
        let readable = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !readable {
            return true.into();
        }
        let executable = std::path::Path::new(&String::from_utf16_lossy(
            &path[..path_length as usize],
        ))
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
        if super::rules::is_browser_process(&executable, search.platform) {
            search.found = Some(window);
            return false.into();
        }
        true.into()
    }

    let mut search = Search {
        platform,
        found: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(callback),
            LPARAM((&mut search as *mut Search) as isize),
        );
    }
    match search.found {
        Some(window) => unsafe { SetForegroundWindow(window).as_bool() },
        None => false,
    }
}

#[cfg(not(windows))]
pub fn focus_browser_window(_platform: Platform) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occupancy_levels_are_split_at_expected_boundaries() {
        assert_eq!(occupancy_level(399), "low");
        assert_eq!(occupancy_level(400), "mid");
        assert_eq!(occupancy_level(900), "mid");
        assert_eq!(occupancy_level(901), "high");
    }

    #[test]
    fn candidate_paths_include_chrome_and_edge() {
        let paths = candidate_paths();
        assert!(paths.iter().any(|path| path.ends_with("chrome.exe")));
        assert!(paths.iter().any(|path| path.ends_with("msedge.exe")));
    }

    #[test]
    fn profile_dir_is_under_video_browsers_root() {
        let dir = profile_dir();
        assert!(dir.ends_with("video-browsers/default"), "got {}", dir.display());
    }

    #[test]
    fn account_profiles_are_separate_and_sanitized() {
        let first = account_profile_dir("dog-a");
        let second = account_profile_dir("dog/b");
        assert!(first.ends_with("video-browsers/accounts/dog-a"), "got {}", first.display());
        assert!(second.ends_with("video-browsers/accounts/dogb"), "got {}", second.display());
        assert_ne!(first, second);
    }

    #[test]
    fn legacy_profile_paths_are_remapped_to_new_root() {
        let legacy = PathBuf::from(r"C:\Users\A\AppData\Local\Maltese");
        let new_root = PathBuf::from(r"E:\Maltese2\data\video-browsers");
        // 旧默认 profile → default
        assert_eq!(
            remap_legacy_profile(
                Path::new(r"C:\Users\A\AppData\Local\Maltese\video-profile"),
                &legacy,
                &new_root
            ),
            new_root.join("default")
        );
        // 旧账号 profile → accounts/<id>；大小写不敏感
        assert_eq!(
            remap_legacy_profile(
                Path::new(r"c:\users\a\appdata\local\maltese\video-accounts\dog-1794880825-1"),
                &legacy,
                &new_root
            ),
            new_root.join("accounts").join("dog-1794880825-1")
        );
        // 已经改名保留的旧目录同样重映射
        assert_eq!(
            remap_legacy_profile(
                Path::new(r"C:\Users\A\AppData\Local\Maltese\video-profile.migrated-1794880825"),
                &legacy,
                &new_root
            ),
            new_root.join("default")
        );
        // 新位置路径 / 不认识的路径原样返回
        assert_eq!(
            remap_legacy_profile(&new_root.join("default"), &legacy, &new_root),
            new_root.join("default")
        );
        assert_eq!(
            remap_legacy_profile(Path::new(r"F:\custom\profile"), &legacy, &new_root),
            PathBuf::from(r"F:\custom\profile")
        );
    }

    #[test]
    fn copy_verified_roundtrips_and_stats_match() {
        let base = std::env::temp_dir().join(format!(
            "maltese-profile-copy-test-{}-{}",
            std::process::id(),
            now_seconds()
        ));
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("Default")).unwrap();
        std::fs::write(src.join("Default").join("Cookies"), b"cookie").unwrap();
        let stats = copy_verified(&src, &dst).expect("copy");
        assert_eq!(stats, (1, 6));
        assert!(dst.join("Default").join("Cookies").is_file());
        // 源没变、目标是独立副本
        assert_eq!(tree_stats(&src).unwrap(), (1, 6));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_profiles_copies_then_renames_legacy() {
        let base = std::env::temp_dir().join(format!(
            "maltese-profile-migrate-test-{}-{}",
            std::process::id(),
            now_seconds()
        ));
        let legacy = base.join("LocalMaltese");
        let new_root = base.join("video-browsers");
        std::fs::create_dir_all(legacy.join("video-profile").join("Default")).unwrap();
        std::fs::write(legacy.join("video-profile").join("Default").join("Cookies"), b"abc").unwrap();
        std::fs::create_dir_all(legacy.join("video-accounts").join("dog-1")).unwrap();
        std::fs::write(legacy.join("video-accounts").join("dog-1").join("Cookies"), b"abcd").unwrap();
        let report = migrate_profiles(&new_root, &legacy).expect("migrate");
        assert_eq!(report.migrated_items.len(), 2);
        assert!(new_root.join("default").join("Default").join("Cookies").is_file());
        assert!(new_root.join("accounts").join("dog-1").join("Cookies").is_file());
        // 旧目录改名保留（不删除）
        assert!(!legacy.join("video-profile").exists());
        assert!(!legacy.join("video-accounts").exists());
        let renamed: Vec<String> = std::fs::read_dir(&legacy)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(renamed.iter().any(|name| name.starts_with("video-profile.migrated-")), "{renamed:?}");
        assert!(renamed.iter().any(|name| name.starts_with("video-accounts.migrated-")), "{renamed:?}");
        // 再跑一次：新位置已有数据 → 不重复复制、不报错
        let again = migrate_profiles(&new_root, &legacy).expect("second migrate");
        assert!(again.migrated_items.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pick_port_returns_available_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let picked = pick_port(port).expect("port");
        assert!(picked >= port);
    }

    #[test]
    fn launch_without_browser_returns_stable_code() {
        std::env::set_var("MALTESE_TEST_BROWSER_PATH", "Z:\\definitely-missing\\chrome.exe");
        let result = launch(Platform::Bilibili, 9333, &profile_dir(), false);
        std::env::remove_var("MALTESE_TEST_BROWSER_PATH");
        let error = result.expect_err("missing browser");
        assert_eq!(error.code, "BROWSER_UNAVAILABLE");
    }

    #[test]
    fn reuse_decision_prefers_owned_then_external_then_fresh() {
        assert_eq!(reuse_decision(true, true, true, true), BrowserReuse::Owned);
        assert_eq!(reuse_decision(true, false, false, false), BrowserReuse::Owned);
        assert_eq!(reuse_decision(false, true, true, true), BrowserReuse::External);
        // 标记匹配但进程已死 / CDP 不通：都不能复用，必须清理后重开。
        assert_eq!(reuse_decision(false, true, false, true), BrowserReuse::Fresh);
        assert_eq!(reuse_decision(false, true, true, false), BrowserReuse::Fresh);
        assert_eq!(reuse_decision(false, false, true, true), BrowserReuse::Fresh);
    }

    #[test]
    fn same_profile_ignores_case_and_separators() {
        let profile = PathBuf::from(r"C:\Users\A\AppData\Local\Maltese\video-profile");
        assert!(same_profile(
            r"c:/users/a/appdata/local/maltese/video-profile/",
            &profile
        ));
        assert!(!same_profile(
            r"C:\Users\A\AppData\Local\Maltese\video-accounts\dog-1",
            &profile
        ));
    }

    #[test]
    fn cdp_ready_is_false_for_closed_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        assert!(!cdp_ready(port));
        assert!(!cdp_ready(0));
    }
}
