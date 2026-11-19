//! 数据目录解析（P1：把业务数据从 C 盘挪到可配置目录）。
//!
//! 解析顺序：`MALTESE_DATA_DIR` 环境变量 > `%APPDATA%\com.maolouis.maltese\data-dir.txt`
//! 内容 > 默认策略（exe 所在盘非 C 盘 → `<盘符>:\MalteseData`，否则沿用
//! `%APPDATA%\com.maolouis.maltese`）。
//!
//! 兼容：旧目录有数据、且没有 `data-dir.txt` 时继续使用旧目录（首次升级不强制迁移）。
//! 失败降级：新根目录不可创建 → 回退旧目录并打印警告，绝不阻断启动。

use std::{
    fs,
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const APP_DIR_NAME: &str = "com.maolouis.maltese";
pub const DATA_DIR_NAME: &str = "MalteseData";
pub const BOOTSTRAP_FILE: &str = "data-dir.txt";
const MIGRATION_SKIP: [&str; 3] = ["instance.lock", "show-request", "local-model.log"];

fn roaming_base() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// 旧版数据目录（Tauri `app_data_dir` 的等价路径）。
pub fn legacy_root() -> PathBuf {
    match roaming_base() {
        Some(base) => base.join(APP_DIR_NAME),
        None => std::env::temp_dir().join(APP_DIR_NAME),
    }
}

/// 引导文件：固定留在 C 盘（几十字节），内容指向真实数据根。
pub fn bootstrap_path() -> PathBuf {
    legacy_root().join(BOOTSTRAP_FILE)
}

/// 默认根：exe 在非 C 盘 → `<盘符>:\MalteseData`；否则沿用旧目录。
pub fn default_root(exe: &Path, legacy: &Path) -> PathBuf {
    let drive = exe
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_string()),
            _ => None,
        });
    match drive {
        Some(drive) if !drive.eq_ignore_ascii_case("C:") && !drive.is_empty() => {
            PathBuf::from(format!("{drive}\\{DATA_DIR_NAME}"))
        }
        _ => legacy.to_path_buf(),
    }
}

/// 纯解析函数（便于单测）：按优先级组装根目录，不创建目录。
pub fn resolve_root(
    env_override: Option<&str>,
    bootstrap_content: Option<&str>,
    exe: &Path,
    legacy: &Path,
) -> PathBuf {
    if let Some(value) = env_override.map(str::trim).filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }
    if let Some(value) = bootstrap_content.map(str::trim).filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }
    default_root(exe, legacy)
}

fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| std::env::temp_dir().join("maltese-assistant.exe"))
}

fn read_bootstrap() -> Option<String> {
    fs::read_to_string(bootstrap_path()).ok()
}

/// 业务数据根（进程内缓存）。创建失败时回退旧目录并打印警告。
pub fn data_root() -> PathBuf {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let legacy = legacy_root();
            let env_override = std::env::var("MALTESE_DATA_DIR").ok();
            let bootstrap = read_bootstrap();
            let root = resolve_root(
                env_override.as_deref(),
                bootstrap.as_deref(),
                &current_exe(),
                &legacy,
            );
            if root != legacy && fs::create_dir_all(&root).is_err() {
                eprintln!(
                    "[paths] 数据目录不可用，已回退到旧目录：{}",
                    legacy.display()
                );
                let _ = fs::create_dir_all(&legacy);
                return legacy;
            }
            let _ = fs::create_dir_all(&root);
            if root != legacy && read_bootstrap().is_none() {
                let _ = write_bootstrap(&root);
            }
            root
        })
        .clone()
}

/// WebView2 profile 目录（第 2 步启用；本批只定义）。
pub fn webview_profile_dir() -> PathBuf {
    data_root().join("WebView2")
}

/// 原子写引导文件：临时文件 + rename。
pub fn write_bootstrap(root: &Path) -> io::Result<()> {
    let path = bootstrap_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, format!("{}\n", root.display()))?;
    if fs::rename(&tmp, &path).is_err() {
        fs::copy(&tmp, &path)?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        if MIGRATION_SKIP.iter().any(|skip| skip == &name_str) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if entry.file_type()?.is_dir() {
            let (sub_files, sub_bytes) = copy_tree(&from, &to)?;
            files += sub_files;
            bytes += sub_bytes;
        } else {
            let size = fs::copy(&from, &to)?;
            files += 1;
            bytes += size;
        }
    }
    Ok((files, bytes))
}

fn tree_stats(dir: &Path) -> io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name_str = entry.file_name().to_string_lossy().to_string();
        if MIGRATION_SKIP.iter().any(|skip| skip == &name_str) {
            continue;
        }
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

/// 迁移旧目录 → 默认新目录（仅业务数据）。返回 Some(新根) 表示迁移成功。
///
/// 调用时机：进程启动最早阶段（Tauri Builder 之前），确保路径解析按新根走。
pub fn migrate_if_needed() -> Option<PathBuf> {
    if std::env::var("MALTESE_DATA_DIR").is_ok() {
        return None;
    }
    if read_bootstrap().is_some() {
        return None;
    }
    let legacy = legacy_root();
    if !dir_has_entries(&legacy) {
        return None;
    }
    let new_root = default_root(&current_exe(), &legacy);
    if new_root == legacy {
        return None;
    }
    if dir_has_entries(&new_root) {
        // 新根已有数据：视为已迁移，写入引导文件即可。
        let _ = write_bootstrap(&new_root);
        return Some(new_root);
    }
    let created = fs::create_dir_all(&new_root).is_ok();
    if !created {
        eprintln!("[paths] 无法创建数据目录 {}，继续使用旧目录", new_root.display());
        return None;
    }
    let copied = copy_tree(&legacy, &new_root).and_then(|_| tree_stats(&new_root));
    match copied {
        Ok((files, bytes)) if files > 0 && bytes > 0 => {
            if write_bootstrap(&new_root).is_err() {
                let _ = fs::remove_dir_all(&new_root);
                eprintln!("[paths] 写 data-dir.txt 失败，继续使用旧目录");
                return None;
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or(0);
            let backup = legacy.with_file_name(format!("{APP_DIR_NAME}.migrated-{stamp}"));
            let _ = fs::rename(&legacy, &backup);
            // 旧目录被整体改名后，引导文件也一起走了：重建一个只含 data-dir.txt 的小目录。
            let _ = fs::create_dir_all(&legacy);
            let _ = write_bootstrap(&new_root);
            eprintln!(
                "[paths] 数据已迁移到 {}（旧目录保留为 {}）",
                new_root.display(),
                backup.display()
            );
            Some(new_root)
        }
        _ => {
            let _ = fs::remove_dir_all(&new_root);
            eprintln!("[paths] 数据迁移失败，继续使用旧目录");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("maltese-paths-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_root_priorities() {
        let legacy = PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\com.maolouis.maltese");
        let exe_c = PathBuf::from("C:\\Apps\\maltese.exe");
        let exe_e = PathBuf::from("E:\\Maltese2\\maltese.exe");
        assert_eq!(
            resolve_root(None, None, &exe_c, &legacy),
            legacy,
            "C 盘 exe 应沿用旧目录"
        );
        assert_eq!(
            resolve_root(None, None, &exe_e, &legacy),
            PathBuf::from("E:\\MalteseData"),
            "非 C 盘 exe 应默认到 <盘符>:\\MalteseData"
        );
        assert_eq!(
            resolve_root(Some("F:\\Custom"), None, &exe_e, &legacy),
            PathBuf::from("F:\\Custom"),
            "环境变量优先级最高"
        );
        assert_eq!(
            resolve_root(None, Some("G:\\FromBootstrap"), &exe_e, &legacy),
            PathBuf::from("G:\\FromBootstrap"),
            "引导文件高于默认策略"
        );
        assert_eq!(
            resolve_root(Some("  "), None, &exe_e, &legacy),
            PathBuf::from("E:\\MalteseData"),
            "空白环境变量应忽略"
        );
    }

    #[test]
    fn migration_verify_and_rollback() {
        let base = temp_dir("migrate");
        let legacy = base.join("legacy");
        let target = base.join("target");
        fs::create_dir_all(legacy.join("video")).unwrap();
        fs::write(legacy.join("video\\a.json"), "hello").unwrap();
        fs::write(legacy.join("instance.lock"), "ignored").unwrap();
        let (files, bytes) = copy_tree(&legacy, &target).unwrap();
        assert_eq!(files, 1);
        assert_eq!(bytes, 5);
        assert!(target.join("video\\a.json").is_file());
        assert!(!target.join("instance.lock").exists());
        let stats = tree_stats(&target).unwrap();
        assert_eq!(stats, (1, 5));
        // 校验失败：目标缺文件 → 统计不同
        fs::remove_file(target.join("video\\a.json")).unwrap();
        assert_ne!(tree_stats(&target).unwrap(), (1, 5));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_without_bootstrap_keeps_legacy() {
        let legacy = PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\com.maolouis.maltese");
        let exe_c = PathBuf::from("C:\\Apps\\maltese.exe");
        // 旧目录有数据、无 data-dir.txt、exe 在 C 盘 → 继续用旧目录
        assert_eq!(resolve_root(None, None, &exe_c, &legacy), legacy);
    }

    #[test]
    fn write_bootstrap_roundtrip() {
        let base = temp_dir("bootstrap");
        let path = base.join("data-dir.txt");
        fs::write(&path, "E:\\MalteseData\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().trim(), "E:\\MalteseData");
        let _ = fs::remove_dir_all(&base);
    }
}