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
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

const PLUGINS_DIRECTORY: &str = "plugins";
const MANIFEST_FILE: &str = "plugin.json";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const BUILTIN_VIDEO_ID: &str = "video-automation";
const BUILTIN_RELATIONSHIP_ID: &str = "relationship";
const PLUGIN_WINDOW_LABEL: &str = "plugin";

/// 当前插件窗口正在显示哪个插件。窗口只有一个，靠这个状态切换内容。
static ACTIVE_PLUGIN: Mutex<Option<String>> = Mutex::new(None);

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
    /// 插件自己的页面（相对插件目录的 html 文件名）。留空就只提供命令动作。
    #[serde(default)]
    pub ui: String,
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
    /// 随安装包分发的预置插件：只读，不能卸载。
    pub locked: bool,
    pub path: Option<String>,
    /// 插件自带页面文件的绝对路径；内置插件由宿主界面渲染，这里为空。
    pub ui: Option<String>,
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

/// 随安装包分发的预置插件（`<安装目录>\resources\plugins`），存在就一起扫。
fn preset_plugins_root(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join(PLUGINS_DIRECTORY);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// 清单里声明的 ui 页面：必须留在插件目录内，避免指到系统目录。
fn resolve_ui_file(directory: &Path, ui: &str) -> Option<String> {
    let name = ui.trim();
    if name.is_empty() || name.contains("..") || name.contains(':') {
        return None;
    }
    let candidate = directory.join(name);
    if candidate.is_file() {
        Some(candidate.to_string_lossy().to_string())
    } else {
        None
    }
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
    let mut plugins = Vec::new();
    for (id, name, description) in [
        (
            BUILTIN_VIDEO_ID,
            "自动刷视频",
            "在 B 站 / 抖音推荐流里按设定间隔自动翻页；由宿主内置，和第三方插件共用插件中心。",
        ),
        (
            BUILTIN_RELATIONSHIP_ID,
            "关系",
            "用配对码和另一个人配对，选好关系（情侣 / 朋友 / 兄弟）之后就能互聊；消息在你俩之间加解密，宿主只做转发。",
        ),
    ] {
        plugins.push(PluginInfo {
            id: id.to_string(),
            name: name.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            description: description.to_string(),
            author: "Maltese".to_string(),
            homepage: "https://github.com/maolouis/Maltese".to_string(),
            builtin: true,
            locked: true,
            path: None,
            ui: None,
            actions: Vec::new(),
        });
    }
    plugins
}

fn plugin_info_from(manifest: PluginManifest, path: &Path, locked: bool) -> PluginInfo {
    PluginInfo {
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
        locked,
        ui: resolve_ui_file(path, &manifest.ui),
        path: Some(path.to_string_lossy().to_string()),
        actions: manifest.actions,
    }
}

#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<PluginList, String> {
    let root = plugins_root(&app)?;
    let mut plugins = builtin_plugins();
    let mut errors = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 预置插件先扫（安装包自带、只读），用户目录后扫：同 id 时用户目录覆盖预置版本。
    let mut directories: Vec<(PathBuf, bool)> = Vec::new();
    if let Some(preset) = preset_plugins_root(&app) {
        directories.push((preset, true));
    }
    directories.push((root.clone(), false));

    for (directory, locked) in directories {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                errors.push(format!("无法读取插件目录 {}：{error}", directory.display()));
                continue;
            }
        };
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
                    let info = plugin_info_from(manifest, &path, locked);
                    if let Some(existing) = plugins
                        .iter_mut()
                        .find(|plugin| plugin.id == info.id && !plugin.builtin)
                    {
                        *existing = info;
                    } else {
                        plugins.push(info);
                    }
                }
                Err(error) => errors.push(format!("{}：{error}", path.display())),
            }
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
    Ok(plugin_info_from(installed, &target, false))
}

#[tauri::command]
pub fn remove_plugin(app: AppHandle, id: String) -> Result<(), String> {
    if id == BUILTIN_VIDEO_ID || id == BUILTIN_RELATIONSHIP_ID {
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

/// 把某个插件放到独立的插件窗口里显示。内置插件由宿主页面渲染，
/// 第三方插件则加载它自己目录里的 html（清单里的 ui 字段）。
#[tauri::command]
pub fn open_plugin_window(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("插件 id 无效。".to_string());
    }
    let plugins = list_plugins(app.clone())?.plugins;
    let plugin = plugins
        .into_iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| "插件不存在。".to_string())?;

    let window = app
        .get_webview_window(PLUGIN_WINDOW_LABEL)
        .ok_or_else(|| "插件窗口未注册".to_string())?;

    if let Ok(mut active) = ACTIVE_PLUGIN.lock() {
        *active = Some(id.clone());
    }

    let title = format!("Maltese · {}", plugin.name);
    let _ = window.set_title(&title);
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.emit(
        "maltese-plugin-open",
        serde_json::json!({
            "id": plugin.id,
            "name": plugin.name,
            "builtin": plugin.builtin,
            "ui": plugin.ui,
        }),
    );
    Ok(())
}

/// 插件窗口打开时问一次「我现在该显示哪个插件」，避免错过 emit。
#[tauri::command]
pub fn get_active_plugin() -> Option<String> {
    ACTIVE_PLUGIN.lock().ok().and_then(|id| id.clone())
}

fn find_installed_plugin(app: &AppHandle, id: &str) -> Result<(PathBuf, PluginManifest), String> {
    if !valid_plugin_id(id) {
        return Err("插件 id 无效。".to_string());
    }
    let mut candidates = vec![plugins_root(app)?.join(id)];
    if let Some(preset) = preset_plugins_root(app) {
        candidates.push(preset.join(id));
    }
    for path in candidates {
        if !path.is_dir() {
            continue;
        }
        let manifest = read_manifest(&path.join(MANIFEST_FILE))?;
        if manifest.id != id {
            return Err("插件目录名与 plugin.json 的 id 不一致。".to_string());
        }
        return Ok((path, manifest));
    }
    Err("插件不存在。".to_string())
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