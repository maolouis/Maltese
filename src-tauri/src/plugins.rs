// 可安装插件。
//
// 插件是用户目录中的一个文件夹，必须包含 plugin.json。宿主不把插件代码
// 加载进 WebView，而是只根据清单启动插件声明的命令；因此第三方插件可以
// 用任何语言编写，也不需要重新编译 Maltese。插件以当前用户权限运行，
// 安装前应确认来源可信。
//
// 内置的“自动刷视频”也出现在同一个插件列表里，只是它的界面由宿主提供。

use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const PLUGINS_DIRECTORY: &str = "plugins";
const MANIFEST_FILE: &str = "plugin.json";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const BUILTIN_VIDEO_ID: &str = "video-automation";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAction {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub actions: Vec<PluginAction>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub homepage: String,
    pub builtin: bool,
    pub path: Option<String>,
    pub actions: Vec<PluginAction>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    pub directory: String,
    pub plugins: Vec<PluginInfo>,
    pub errors: Vec<String>,
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join(PLUGINS_DIRECTORY);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建插件目录：{error}"))?;
    Ok(dir)
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && !id.starts_with('.')
        && !id.contains("..")
}

fn read_manifest(path: &Path) -> Result<PluginManifest, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    let manifest: PluginManifest = serde_json::from_str(&content)
        .map_err(|error| format!("plugin.json 格式错误：{error}"))?;
    if !valid_plugin_id(&manifest.id) {
        return Err("插件 id 只能包含字母、数字、点、下划线和短横线。".to_string());
    }
    if manifest.name.trim().is_empty() {
        return Err("插件缺少 name。".to_string());
    }
    for action in &manifest.actions {
        if action.id.trim().is_empty() || action.label.trim().is_empty() {
            return Err("插件动作缺少 id 或 label。".to_string());
        }
        if action.command.trim().is_empty() {
            return Err(format!("插件动作 {} 缺少 command。", action.id));
        }
    }
    Ok(manifest)
}

fn builtin_plugins() -> Vec<PluginInfo> {
    vec![PluginInfo {
        id: BUILTIN_VIDEO_ID.to_string(),
        name: "自动刷视频".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        description: "在 B 站 / 抖音推荐流里按设定间隔自动翻页；由宿主内置，和第三方插件共用插件中心。".to_string(),
        author: "Maltese".to_string(),
        homepage: "https://github.com/maolouis/Maltese".to_string(),
        builtin: true,
        path: None,
        actions: Vec::new(),
    }]
}

#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<PluginList, String> {
    let root = plugins_root(&app)?;
    let mut plugins = builtin_plugins();
    let mut errors = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let entries = fs::read_dir(&root).map_err(|error| format!("无法读取插件目录：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join(MANIFEST_FILE);
        if !manifest_path.is_file() {
            continue;
        }
        match read_manifest(&manifest_path) {
            Ok(manifest) => {
                if !seen.insert(manifest.id.clone()) {
                    errors.push(format!("插件 id 重复，已跳过：{}", manifest.id));
                    continue;
                }
                plugins.push(PluginInfo {
                    id: manifest.id,
                    name: manifest.name,
                    version: if manifest.version.trim().is_empty() {
                        "0.0.0".to_string()
                    } else {
                        manifest.version
                    },
                    description: manifest.description,
                    author: manifest.author,
                    homepage: manifest.homepage,
                    builtin: false,
                    path: Some(path.to_string_lossy().to_string()),
                    actions: manifest.actions,
                });
            }
            Err(error) => errors.push(format!("{}：{error}", path.display())),
        }
    }

    plugins.sort_by(|left, right| {
        right
            .builtin
            .cmp(&left.builtin)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(PluginList {
        directory: root.to_string_lossy().to_string(),
        plugins,
        errors,
    })
}

fn copy_plugin_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("无法创建插件目录：{error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("无法读取插件目录：{error}"))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let file_name = entry.file_name();
        let destination = target.join(&file_name);
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取插件文件：{error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_plugin_directory(&entry_path, &destination)?;
        } else if file_type.is_file() {
            fs::copy(&entry_path, &destination)
                .map_err(|error| format!("复制插件文件失败：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn install_plugin(app: AppHandle, source: String) -> Result<PluginInfo, String> {
    let source = PathBuf::from(source.trim());
    if !source.is_dir() {
        return Err("请选择插件文件夹（文件夹根目录需要包含 plugin.json；zip 请先解压）。".to_string());
    }
    let source = source
        .canonicalize()
        .map_err(|error| format!("无法读取插件文件夹：{error}"))?;
    let manifest = read_manifest(&source.join(MANIFEST_FILE))?;
    let root = plugins_root(&app)?;
    let target = root.join(&manifest.id);
    if target.exists() {
        return Err(format!("插件 {} 已经安装。", manifest.id));
    }
    copy_plugin_directory(&source, &target)?;
    // 复制完成后再读一次，确保复制结果可用。
    let installed = read_manifest(&target.join(MANIFEST_FILE))?;
    Ok(PluginInfo {
        id: installed.id,
        name: installed.name,
        version: if installed.version.trim().is_empty() {
            "0.0.0".to_string()
        } else {
            installed.version
        },
        description: installed.description,
        author: installed.author,
        homepage: installed.homepage,
        builtin: false,
        path: Some(target.to_string_lossy().to_string()),
        actions: installed.actions,
    })
}

#[tauri::command]
pub fn remove_plugin(app: AppHandle, id: String) -> Result<(), String> {
    if id == BUILTIN_VIDEO_ID {
        return Err("内置插件不能删除。".to_string());
    }
    if !valid_plugin_id(&id) {
        return Err("插件 id 无效。".to_string());
    }
    let root = plugins_root(&app)?
        .canonicalize()
        .map_err(|error| format!("无法读取插件目录：{error}"))?;
    let target = root.join(&id);
    if !target.exists() {
        return Err("插件不存在。".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("无法读取插件目录：{error}"))?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("拒绝删除插件目录之外的路径。".to_string());
    }
    fs::remove_dir_all(&canonical).map_err(|error| format!("删除插件失败：{error}"))
}

#[tauri::command]
pub fn open_plugins_directory(app: AppHandle) -> Result<(), String> {
    let root = plugins_root(&app)?;
    Command::new("explorer.exe")
        .arg(root)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开插件目录：{error}"))
}

fn find_installed_plugin(app: &AppHandle, id: &str) -> Result<(PathBuf, PluginManifest), String> {
    if !valid_plugin_id(id) {
        return Err("插件 id 无效。".to_string());
    }
    let root = plugins_root(app)?;
    let path = root.join(id);
    if !path.is_dir() {
        return Err("插件不存在。".to_string());
    }
    let manifest = read_manifest(&path.join(MANIFEST_FILE))?;
    if manifest.id != id {
        return Err("插件目录名与 plugin.json 的 id 不一致。".to_string());
    }
    Ok((path, manifest))
}

#[tauri::command]
pub fn run_plugin_action(app: AppHandle, id: String, action_id: String) -> Result<(), String> {
    let (directory, manifest) = find_installed_plugin(&app, &id)?;
    let action = manifest
        .actions
        .into_iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| "插件动作不存在。".to_string())?;
    let directory_text = directory.to_string_lossy().to_string();
    let command = action
        .command
        .replace("${pluginDir}", &directory_text)
        .replace("${plugin_dir}", &directory_text);
    let args: Vec<String> = action
        .args
        .iter()
        .map(|arg| {
            arg.replace("${pluginDir}", &directory_text)
                .replace("${plugin_dir}", &directory_text)
        })
        .collect();

    Command::new(command)
        .args(args)
        .current_dir(&directory)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动插件失败：{error}"))
}