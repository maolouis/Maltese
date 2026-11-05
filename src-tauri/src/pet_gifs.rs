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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPetGif {
    pub id: String,
    pub name: String,
    pub path: String,
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("pet-gifs"))
        .map_err(|error| error.to_string())
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
    let candidate = PathBuf::from(&path);
    if !path_inside(&root, &candidate) {
        return Err("只能删除 Maltese 表情目录里的 GIF。".into());
    }
    if candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("gif"))
    {
        return Err("只能删除 GIF 文件。".into());
    }
    if candidate.exists() {
        fs::remove_file(&candidate).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{display_name, is_gif, validate_state};

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
}