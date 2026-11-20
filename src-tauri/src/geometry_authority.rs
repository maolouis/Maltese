//! 几何写入单一真值（P1 Step 1，行为不变）。
//!
//! 所有会改窗口矩形的入口都从这里记一条 `GEOM_BEGIN/GEOM_WRITE`：
//! `source` 标记来源，`epoch` 单调递增，`before/after` 是物理矩形。
//! 环境变量 `MALTESE_GEOM_AUTHORITY=0` 可整体关闭（feature flag）。
//!
//! 目标（后续 Step 2+）：所有 set_position/set_size 只能经本模块，状态机收敛后禁止
//! 任何路径绕过；本 Step 只做记录，不改行为。

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

static EPOCH: AtomicU64 = AtomicU64::new(0);

fn enabled() -> bool {
    !matches!(std::env::var("MALTESE_GEOM_AUTHORITY").as_deref(), Ok("0"))
}

/// 一次几何写入开始：分配 epoch。返回 0 表示记录被关闭。
pub fn begin(source: &str) -> u64 {
    if !enabled() {
        return 0;
    }
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("GEOM_BEGIN source={source} epoch={epoch}");
    epoch
}

/// 一次几何写入落定。
pub fn commit(source: &str, epoch: u64, before: Option<Rect>, after: Option<Rect>) {
    if epoch == 0 {
        return;
    }
    eprintln!("GEOM_WRITE source={source} epoch={epoch} before={before:?} after={after:?}");
}

/// 一步式记录（begin + commit）。
pub fn record(source: &str, before: Option<Rect>, after: Option<Rect>) {
    let epoch = begin(source);
    commit(source, epoch, before, after);
}

pub fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

pub fn window_rect(window: &tauri::WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_monotonic_and_rect_converts() {
        let first = begin("unit-test");
        let second = begin("unit-test");
        if first != 0 {
            assert!(second > first, "epoch 必须单调递增");
        }
        let value = rect(-259, 859, 259, 221);
        assert_eq!((value.x, value.y), (-259, 859));
    }
}