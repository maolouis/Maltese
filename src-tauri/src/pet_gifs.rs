use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_GIF_BYTES: usize = 8 * 1024 * 1024;
static FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
static TRASH_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPetGif {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// 「删除 -> 撤销 / 恢复最近删除」用的磁盘副本信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedPetGif {
    /// 副本在 pet-gifs-trash/ 里的绝对路径。
    pub trash_path: String,
    /// 副本文件名（排障用）。
    pub name: String,
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok::<std::path::PathBuf, String>(crate::paths::data_root().join("pet-gifs"))
}

/// 删除前的磁盘副本目录：自定义 GIF 先复制到这里，撤销时再复制回去。
fn trash_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok::<std::path::PathBuf, String>(crate::paths::data_root().join("pet-gifs-trash"))
}

fn validate_state(state: &str) -> Result<(), String> {
    if state.is_empty()
        || state.len() > 32
        || !state
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("无效的表情名称。".into());
    }
    Ok(())
}

fn is_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

fn display_name(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let name = if name.is_empty() { "custom.gif" } else { name };
    name.chars().take(120).collect()
}

fn path_inside(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    path.starts_with(root)
}

/// 同 [`path_inside`]，但目标文件可以还不存在（恢复时原文件已经被删掉了）：
/// 先把最近存在的祖先目录规范化，再把剩下的相对部分拼回去再比较。
fn path_inside_allow_missing(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let mut probe = path.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    while !probe.exists() {
        let Some(name) = probe.file_name().map(|name| name.to_os_string()) else {
            return false;
        };
        suffix.push(name);
        if !probe.pop() {
            return false;
        }
    }
    let Ok(mut resolved) = probe.canonicalize() else {
        return false;
    };
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    resolved.starts_with(root)
}

fn gif_path_in_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path_inside(root, path) {
        return Err("只能操作 Maltese 表情目录里的 GIF。".into());
    }
    if !has_gif_extension(path) {
        return Err("只能操作 GIF 文件。".into());
    }
    Ok(path.to_path_buf())
}

fn has_gif_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gif"))
}

/// 回收站副本文件名：时间戳 + 计数器 + 原文件名，避免同名覆盖。
fn trash_file_name(stamp: i64, name: &str, counter: u64) -> String {
    format!("{stamp}-{counter}-{}", display_name(name))
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub fn add_pet_gif(
    app: AppHandle,
    state: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<CustomPetGif, String> {
    validate_state(&state)?;
    if bytes.len() > MAX_GIF_BYTES {
        return Err("GIF 不能超过 8 MB。".into());
    }
    if !is_gif(&bytes) {
        return Err("文件不是有效的 GIF。".into());
    }

    let directory = plugins_root(&app)?.join(&state);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let counter = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let id = format!("gif-{stamp}-{counter}");
    let path = directory.join(format!("{id}.gif"));
    let temporary = directory.join(format!("{id}.part"));

    fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }

    Ok(CustomPetGif {
        id,
        name: display_name(&name),
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn remove_pet_gif(app: AppHandle, path: String) -> Result<(), String> {
    let root = plugins_root(&app)?;
    let candidate = gif_path_in_root(&root, &PathBuf::from(&path))?;
    if candidate.exists() {
        fs::remove_file(&candidate).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 删除自定义 GIF 之前先复制一份到 pet-gifs-trash/（撤销/恢复最近删除用）。
/// 只复制、不删除原文件；原文件仍由 [`remove_pet_gif`] 删除。
#[tauri::command]
pub fn park_pet_gif(app: AppHandle, path: String) -> Result<ParkedPetGif, String> {
    let root = plugins_root(&app)?;
    let candidate = gif_path_in_root(&root, &PathBuf::from(&path))?;
    if !candidate.exists() {
        return Err("GIF 文件不存在。".into());
    }
    let trash = trash_root(&app)?;
    fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
    let counter = TRASH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = trash_file_name(
        unix_millis(),
        &candidate
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        counter,
    );
    let target = trash.join(&name);
    fs::copy(&candidate, &target).map_err(|error| error.to_string())?;
    Ok(ParkedPetGif {
        trash_path: target.to_string_lossy().into_owned(),
        name,
    })
}

/// 把回收站里的副本复制回原路径（原文件在删除时已经被删掉）。
/// 目标已经存在时拒绝覆盖，交给用户决定。
#[tauri::command]
pub fn restore_pet_gif(
    app: AppHandle,
    trash_path: String,
    target_path: String,
) -> Result<(), String> {
    let trash = trash_root(&app)?;
    let source = PathBuf::from(&trash_path);
    if !path_inside(&trash, &source) || !has_gif_extension(&source) {
        return Err("只能从 Maltese 表情回收站恢复 GIF。".into());
    }
    if !source.exists() {
        return Err("回收站里的 GIF 副本不存在。".into());
    }
    let root = plugins_root(&app)?;
    let target = PathBuf::from(&target_path);
    if !path_inside_allow_missing(&root, &target) || !has_gif_extension(&target) {
        return Err("只能恢复到 Maltese 表情目录。".into());
    }
    if target.exists() {
        return Err("原位置已经有同名文件，未覆盖。".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&source, &target).map_err(|error| error.to_string())?;
    Ok(())
}

/// 回收站条目被挤出去（超过 10 条）时清理它的磁盘副本。
#[tauri::command]
pub fn discard_trashed_pet_gif(app: AppHandle, trash_path: String) -> Result<(), String> {
    let trash = trash_root(&app)?;
    let candidate = PathBuf::from(&trash_path);
    if !path_inside(&trash, &candidate) {
        return Err("只能清理 Maltese 表情回收站里的文件。".into());
    }
    if candidate.exists() {
        fs::remove_file(&candidate).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        display_name, has_gif_extension, is_gif, path_inside_allow_missing, trash_file_name,
        validate_state,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn accepts_only_gif_headers() {
        assert!(is_gif(b"GIF89a rest"));
        assert!(is_gif(b"GIF87a rest"));
        assert!(!is_gif(b"PNG"));
        assert!(!is_gif(b""));
    }

    #[test]
    fn validates_state_names() {
        assert!(validate_state("idle").is_ok());
        assert!(validate_state("happy-2").is_ok());
        assert!(validate_state("../idle").is_err());
        assert!(validate_state("").is_err());
    }

    #[test]
    fn strips_directories_from_display_name() {
        assert_eq!(display_name(r"C:\pets\wave.gif"), "wave.gif");
        assert_eq!(display_name(""), "custom.gif");
    }

    #[test]
    fn trash_file_name_keeps_extension_and_avoids_collisions() {
        assert_eq!(
            trash_file_name(1_700_000_000_000, r"C:\pets\wave.gif", 0),
            "1700000000000-0-wave.gif"
        );
        assert_ne!(
            trash_file_name(1_700_000_000_000, "wave.gif", 0),
            trash_file_name(1_700_000_000_000, "wave.gif", 1)
        );
    }

    #[test]
    fn only_gif_extension_is_allowed() {
        assert!(has_gif_extension(PathBuf::from("a.gif").as_path()));
        assert!(has_gif_extension(PathBuf::from("a.GIF").as_path()));
        assert!(!has_gif_extension(PathBuf::from("a.png").as_path()));
        assert!(!has_gif_extension(PathBuf::from("a").as_path()));
    }

    #[test]
    fn allow_missing_paths_still_rejects_outside_targets() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!("maltese-pet-gifs-test-{stamp}-{counter}"));
        let root = base.join("pet-gifs");
        fs::create_dir_all(root.join("idle")).expect("create temp root");
        let inside = root.join("idle").join("restored.gif");
        let outside = base.join("elsewhere").join("restored.gif");
        assert!(path_inside_allow_missing(&root, &inside));
        assert!(!path_inside_allow_missing(&root, &outside));
        let _ = fs::remove_dir_all(&base);
    }
}