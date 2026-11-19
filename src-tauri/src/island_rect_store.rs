//! 「最后落定矩形」快照：退出/几何落定时写盘，启动时先按它恢复窗口。
//!
//! 背景（P0 第三次复现「启动初始位置没按设置的来」）：设置解析链路（custom_position /
//! islandScreen 偏好 / lockCorner）在启动顺序里任何一环没就绪，窗口就会先落在默认锚点，
//! 甚至停在那里。这里改成确定性做法：每次几何落定都把**最终物理矩形**写盘，
//! 启动时先按这份矩形恢复，不再依赖设置解析。
//!
//! 文件默认 `E:\MalteseData\island-rect.json`（写不了就退到 `%APPDATA%\com.maolouis.maltese`），
//! 原子写（临时文件 + rename），读失败/损坏一律当“没有快照”。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IslandRectSnapshot {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// "collapsed" / "expanded"
    pub mode: String,
    /// 显示器完整指纹：`name|WxH@x,y`（与 list_monitors 一致）。
    pub monitor: String,
    pub scale: f64,
    pub updated_at: u64,
}

/// 快照文件路径：优先固定目录，不可写再退到 APPDATA。
pub fn snapshot_path() -> PathBuf {
    let fixed = PathBuf::from(r"E:\MalteseData");
    if std::fs::create_dir_all(&fixed).is_ok() {
        return fixed.join("island-rect.json");
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.maolouis.maltese").join("island-rect.json")
}

/// 原子写：先写 `path.tmp`，再 rename 覆盖。失败返回 Err（调用方只记日志）。
pub fn save(path: &Path, snapshot: &IslandRectSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    }
    let text = serde_json::to_string_pretty(snapshot).map_err(|error| format!("serialize: {error}"))?;
    let mut tmp = path.to_path_buf();
    tmp.set_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|error| format!("write tmp: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("rename: {error}"))?;
    Ok(())
}

/// 读快照：文件不存在 / JSON 损坏 / 字段不合理 → None（不 panic、不阻断启动）。
pub fn load(path: &Path) -> Option<IslandRectSnapshot> {
    let text = std::fs::read_to_string(path).ok()?;
    let snapshot: IslandRectSnapshot = serde_json::from_str(&text).ok()?;
    if snapshot.width < 32 || snapshot.height < 32 {
        return None;
    }
    if snapshot.x <= -30_000 || snapshot.y <= -30_000 {
        return None;
    }
    Some(snapshot)
}

/// 把旧矩形夹进给定工作区（拔屏/换屏后保证落在可见区域）。
pub fn clamp_to_work_area(
    rect: (i32, i32, u32, u32),
    work: (i32, i32, u32, u32),
) -> (i32, i32) {
    let (x, y, width, height) = rect;
    let (left, top, work_w, work_h) = work;
    let max_x = left + work_w as i32 - width as i32;
    let max_y = top + work_h as i32 - height as i32;
    (
        x.clamp(left, max_x.max(left)),
        y.clamp(top, max_y.max(top)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("island-rect-test-{name}-{}.json", std::process::id()));
        path
    }

    fn sample() -> IslandRectSnapshot {
        IslandRectSnapshot {
            x: -259,
            y: 859,
            width: 259,
            height: 221,
            mode: "collapsed".into(),
            monitor: "\\\\.\\DISPLAY1|1920x1080@-1920,0".into(),
            scale: 1.0,
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn snapshot_roundtrip_is_atomic_and_lossless() {
        let path = temp_path("roundtrip");
        let snapshot = sample();
        save(&path, &snapshot).expect("save");
        assert_eq!(load(&path), Some(snapshot));
        // 临时文件不应残留
        let mut tmp = path.clone();
        tmp.set_extension("json.tmp");
        assert!(!tmp.exists());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_or_missing_snapshot_falls_back_silently() {
        let path = temp_path("corrupt");
        assert_eq!(load(&path), None);
        std::fs::write(&path, b"{not json").expect("write");
        assert_eq!(load(&path), None);
        // 尺寸/哨兵坐标不合理也当没有
        std::fs::write(
            &path,
            br#"{"x":-32000,"y":-32000,"width":259,"height":221,"mode":"collapsed","monitor":"m","scale":1,"updatedAt":1}"#,
        )
        .expect("write");
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rect_is_clamped_into_work_area_after_monitor_disappears() {
        // 原矩形在左侧副屏（负坐标），副屏被拔后夹进主屏工作区
        let rect = (-259, 859, 259, 221);
        let work = (0, 0, 2560, 1440);
        assert_eq!(clamp_to_work_area(rect, work), (0, 859));
        // 已经在该屏内则原样保留
        assert_eq!(clamp_to_work_area((-800, 300, 259, 221), (-1920, 0, 1920, 1080)), (-800, 300));
        // 越过右下边界被拉回
        assert_eq!(clamp_to_work_area((9999, 9999, 259, 221), work), (2560 - 259, 1440 - 221));
    }
}