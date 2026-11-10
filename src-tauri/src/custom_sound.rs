// 自定义音效：把用户选择的音频存到应用数据目录，返回绝对路径给前端播放。
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_SOUND_BYTES: usize = 2 * 1024 * 1024;
static FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSound {
    pub name: String,
    pub path: String,
}

fn sounds_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("sounds"))
        .map_err(|error| error.to_string())
}

fn extension_of(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "wav" | "mp3" | "ogg" | "m4a"))
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
pub fn add_custom_sound(
    app: AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<CustomSound, String> {
    if bytes.is_empty() {
        return Err("音效文件为空。".to_string());
    }
    if bytes.len() > MAX_SOUND_BYTES {
        return Err("音效不能超过 2 MB。".to_string());
    }
    let extension = extension_of(&name).ok_or("只支持 wav / mp3 / ogg / m4a。")?;

    let directory = sounds_root(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let counter = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let id = format!("sound-{stamp}-{counter}");
    let path = directory.join(format!("{id}.{extension}"));
    let temporary = directory.join(format!("{id}.part"));

    fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }

    Ok(CustomSound {
        name: name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string(),
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn remove_custom_sound(app: AppHandle, path: String) -> Result<(), String> {
    let root = sounds_root(&app)?;
    let candidate = PathBuf::from(&path);
    if !path_inside(&root, &candidate) {
        return Err("只能删除 Maltese 音效目录里的文件。".to_string());
    }
    if candidate.exists() {
        fs::remove_file(&candidate).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extension_of;

    #[test]
    fn accepts_only_supported_audio() {
        assert_eq!(extension_of("chirp.wav").as_deref(), Some("wav"));
        assert_eq!(extension_of(r"C:\a\b.MP3").as_deref(), Some("mp3"));
        assert_eq!(extension_of("x.exe"), None);
        assert_eq!(extension_of("noext"), None);
    }
}
