//! 实例互斥：以「应用数据目录」（WebView2 profile 所在目录）为键的跨进程文件锁。
//!
//! `tauri-plugin-single-instance` 只按应用 identifier 去重，仍有两个漏洞：
//!
//! 1. identifier 会在验证构建里被 `FOCUSD_VERIFY_NOTIFICATIONS` 改写，此时插件
//!    不认为两个进程是同一个应用；
//! 2. 插件回调只做 show，不会取消最小化 / 把窗口带回前台。
//!
//! 这里在 Tauri Builder 之前先对 `<app_data_dir>/instance.lock` 做一次
//! `File::try_lock`（Windows 下是 LockFileEx）：
//!
//! * 同一个数据目录只允许一个实例；不同 identifier（验证构建）目录不同，互不阻塞；
//! * 锁随文件句柄释放，进程被任务管理器结束 / 崩溃时内核自动回收，不会留下
//!   stale lock（这正是 named mutex 想解决的问题，但不用额外开 Win32 feature）；
//! * 第二实例写一个 `show-request` 文件后直接退出，首实例的监听线程看到文件就把
//!   桌宠带到前台，实现跨进程的「唤起已存在实例」。
//!
//! `instance.lock` 里同时写入 PID / exe / 数据目录 / identifier，仅用于排障，
//! 互斥的正确性只依赖文件锁本身。

use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::{File, TryLockError},
    io::Write,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const SHOW_REQUEST_FILE: &str = "show-request";
const INSTANCE_LOCK_FILE: &str = "instance.lock";
const SHOW_REQUEST_POLL_INTERVAL: Duration = Duration::from_millis(400);

/// 锁文件句柄必须活到进程结束：进程退出（含崩溃）时 OS 释放文件锁。
static LOCK_FILE: std::sync::OnceLock<File> = std::sync::OnceLock::new();

pub enum InstanceGuard {
    /// 首实例，持锁运行。
    Primary,
    /// 已有实例在跑，调用方应请求唤起后立即退出。
    Secondary,
}

/// 应用数据目录：与 Tauri 的 `app_data_dir` 一致（`%APPDATA%\<identifier>`）。
/// 解析失败时返回 `None`，调用方退回到只依赖 single-instance 插件。
pub fn resolve_data_dir(identifier: &str) -> Option<PathBuf> {
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(PathBuf::from(trimmed).join(identifier));
            }
        }
    }
    None
}

/// 尝试拿实例锁。拿不到（`WouldBlock`）说明另一个实例正持有同一个数据目录。
pub fn acquire(data_dir: &Path, identifier: &str) -> Result<InstanceGuard, String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("failed to create {}: {error}", data_dir.display()))?;
    let lock_path = data_dir.join(INSTANCE_LOCK_FILE);
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("failed to open {}: {error}", lock_path.display()))?;

    match file.try_lock() {
        Ok(()) => {
            write_instance_info(data_dir, identifier, &file);
            let _ = LOCK_FILE.set(file);
            Ok(InstanceGuard::Primary)
        }
        Err(TryLockError::WouldBlock) => Ok(InstanceGuard::Secondary),
        Err(TryLockError::Error(error)) => Err(format!(
            "failed to lock {}: {error}",
            lock_path.display()
        )),
    }
}

/// 第二实例：请求首实例把桌宠带到前台。写失败也返回 false，调用方照常退出。
pub fn request_show(data_dir: &Path) -> bool {
    if fs::create_dir_all(data_dir).is_err() {
        return false;
    }
    let payload = format!(
        "pid={}\nrequestedAt={}\n",
        std::process::id(),
        unix_millis()
    );
    fs::write(data_dir.join(SHOW_REQUEST_FILE), payload).is_ok()
}

/// 首实例：把排障信息写进锁文件（不改变锁状态）。
fn write_instance_info(data_dir: &Path, identifier: &str, file: &File) {
    let exe = env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let payload = format!(
        "pid={}\nexe={}\nidentifier={}\ndataDir={}\nmatchedDataDirHash={}\nlockedAt={}\n",
        std::process::id(),
        exe,
        identifier,
        data_dir.display(),
        data_dir_hash(data_dir),
        unix_millis()
    );
    let mut handle = file;
    let _ = handle.set_len(0);
    let _ = handle.write_all(payload.as_bytes());
    let _ = handle.flush();
}

/// 首实例正常退出时把锁文件内容清空（锁本身随进程结束释放；崩溃时残留旧内容
/// 不影响下一次启动，因为锁状态由文件锁而不是文件内容决定）。
pub fn clear_instance_info() {
    if let Some(file) = LOCK_FILE.get() {
        // 必须用持锁的同一个句柄写：Windows 文件锁会拒绝其它句柄写被锁区域。
        let mut handle = file;
        let _ = handle.set_len(0);
        let _ = handle.flush();
    }
}

/// 首实例：监听 `show-request` 文件，收到后把已存在的桌宠带到前台。
pub fn spawn_show_request_watcher(app: AppHandle, data_dir: PathBuf) {
    let spawned = thread::Builder::new()
        .name("instance-show-request".into())
        .spawn(move || loop {
            thread::sleep(SHOW_REQUEST_POLL_INTERVAL);
            let request = data_dir.join(SHOW_REQUEST_FILE);
            if !request.exists() {
                continue;
            }
            let _ = fs::remove_file(&request);
            eprintln!("second instance requested to show the island");
            if let Err(error) = crate::show_island(&app) {
                eprintln!("failed to bring the island to front: {error}");
            }
            if let Some(window) = app.get_webview_window(crate::WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
    if spawned.is_err() {
        eprintln!("failed to spawn instance show-request watcher");
    }
}

/// 数据目录哈希，只有排障 / 测试用到。
fn data_dir_hash(data_dir: &Path) -> String {
    let normalized = data_dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_hash_is_stable_across_separators_and_case() {
        let a = data_dir_hash(Path::new(
            r"C:\Users\Someone\AppData\Roaming\com.maolouis.maltese",
        ));
        let b = data_dir_hash(Path::new(
            r"c:/users/someone/appdata/roaming/com.maolouis.maltese",
        ));
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn different_data_dirs_get_different_hashes() {
        let a = data_dir_hash(Path::new(
            r"C:\Users\A\AppData\Roaming\com.maolouis.maltese",
        ));
        let b = data_dir_hash(Path::new(
            r"C:\Users\A\AppData\Roaming\com.maolouis.maltese-dev",
        ));
        assert_ne!(a, b);
    }
}