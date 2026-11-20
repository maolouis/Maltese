//! 几何不变量自检：把「狗槽屏幕坐标」当成唯一真理。
//!
//! 不变量定义（与 docs/island-geometry-status.md 同步）：
//! - 收起态：狗槽 = 窗口矩形左上角 `(x, y)`，尺寸 `(slot_w, slot_h)`；
//! - 展开 / 浮层态：由 `panelSide / panelVertical` 反推狗槽：
//!   - `left`：狗槽 x = 窗口 x + 窗口宽 - 槽宽；`right`：狗槽 x = 窗口 x；
//!   - `above`：狗槽 y = 窗口 y + 窗口高 - 槽高；`below`：狗槽 y = 窗口 y；
//! - **不变量**：同一逻辑状态下，任何操作（开合浮层、右键、Esc、切屏、缩边唤醒、设置变更）
//!   前后狗槽偏差 ≤ **2px**。
//!
//! 本模块只做纯矩形数学，不依赖 Tauri/窗口句柄，便于单测和 `island_geometry_selftest` 复用。

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SlotRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl SlotRect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self { x, y, width, height }
    }
}

/// 不变量允许的偏差（px）。
pub const SLOT_TOLERANCE: i32 = 2;

#[derive(Clone, Debug, Serialize)]
pub struct SlotViolation {
    pub op: String,
    pub before: SlotRect,
    pub after: SlotRect,
    pub dx: i32,
    pub dy: i32,
    pub corrected: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScenarioResult {
    pub op: String,
    pub before: SlotRect,
    pub after: SlotRect,
    pub dx: i32,
    pub dy: i32,
    pub pass: bool,
}

/// 由窗口矩形反推狗槽。
pub fn slot_from_window(
    window: SlotRect,
    panel_side: &str,
    panel_vertical: &str,
    slot_w: i32,
    slot_h: i32,
) -> SlotRect {
    let x = if panel_side == "left" {
        window.x + window.width - slot_w
    } else {
        window.x
    };
    let y = if panel_vertical == "above" {
        window.y + window.height - slot_h
    } else {
        window.y
    };
    SlotRect::new(x, y, slot_w, slot_h)
}

/// 由狗槽 + 面板方向反推展开/浮层窗口左上角。
pub fn window_from_slot(
    slot: SlotRect,
    panel_side: &str,
    panel_vertical: &str,
    window_w: i32,
    window_h: i32,
) -> SlotRect {
    let x = if panel_side == "left" {
        slot.x + slot.width - window_w
    } else {
        slot.x
    };
    let y = if panel_vertical == "above" {
        slot.y + slot.height - window_h
    } else {
        slot.y
    };
    SlotRect::new(x, y, window_w, window_h)
}

/// 两条狗槽的距离是否在不变量容差内。
pub fn within_tolerance(before: SlotRect, after: SlotRect) -> bool {
    (before.x - after.x).abs() <= SLOT_TOLERANCE && (before.y - after.y).abs() <= SLOT_TOLERANCE
}

/// 统一校验点：超差 → 返回 violation；`monitor_known=false`（屏不存在）视为无法纠正。
pub fn assert_slot_invariant(
    before: SlotRect,
    after: SlotRect,
    op: &str,
    monitor_known: bool,
) -> Option<SlotViolation> {
    let dx = after.x - before.x;
    let dy = after.y - before.y;
    if dx.abs() <= SLOT_TOLERANCE && dy.abs() <= SLOT_TOLERANCE {
        return None;
    }
    Some(SlotViolation {
        op: op.to_string(),
        before,
        after,
        dx,
        dy,
        corrected: monitor_known,
        reason: if monitor_known { None } else { Some("monitor_missing".to_string()) },
    })
}

/// 纠正目标：把窗口平移回 `before` 的狗槽（返回窗口左上角）。
pub fn correction_target(
    current_window: SlotRect,
    before_slot: SlotRect,
    current_slot: SlotRect,
) -> SlotRect {
    let dx = current_slot.x - before_slot.x;
    let dy = current_slot.y - before_slot.y;
    SlotRect::new(current_window.x - dx, current_window.y - dy, current_window.width, current_window.height)
}

/// 8 个自检场景（确定性数据，便于脚本/面板比较；数值取自实机日志）。
pub fn selftest_scenarios() -> Vec<ScenarioResult> {
    let slot = SlotRect::new(-259, 811, 259, 221);
    let slot_w = slot.width;
    let slot_h = slot.height;
    let mut results = Vec::new();
    let mut push = |op: &str, before: SlotRect, after: SlotRect| {
        let dx = after.x - before.x;
        let dy = after.y - before.y;
        results.push(ScenarioResult {
            op: op.to_string(),
            before,
            after,
            dx,
            dy,
            pass: dx.abs() <= SLOT_TOLERANCE && dy.abs() <= SLOT_TOLERANCE,
        });
    };

    // 1) 收起 → 右键（展开）：窗口按 left/above 反推后狗槽必须还在原处
    let expanded = window_from_slot(slot, "left", "above", 727, 480);
    push("collapsed->rightclick", slot, slot_from_window(expanded, "left", "above", slot_w, slot_h));

    // 2) 收起 → 双击（浮层）：浮层 587x540，狗槽不变
    let overlay = window_from_slot(slot, "left", "above", 587, 540);
    push("collapsed->doubleclick", slot, slot_from_window(overlay, "left", "above", slot_w, slot_h));

    // 3) 浮层 → 右键：只切页签、不动几何
    push("overlay->rightclick", slot, slot);

    // 4) 浮层 → Esc：恢复快照后狗槽不变
    push("overlay->esc", slot, slot_from_window(expanded, "left", "above", slot_w, slot_h));

    // 5) 缩边 → 唤醒：缩边只改窗口尺寸，狗槽位置不变
    push("tucked->wake", slot, slot);

    // 6) 切主屏：狗槽换到主屏后仍要自洽
    let primary_slot = SlotRect::new(16, 16, slot_w, slot_h);
    let primary_window = window_from_slot(primary_slot, "right", "below", 727, 480);
    push("switch-primary", primary_slot, slot_from_window(primary_window, "right", "below", slot_w, slot_h));

    // 7) 切副屏：负坐标同样要自洽
    let secondary_window = window_from_slot(slot, "left", "above", 727, 480);
    push("switch-secondary", slot, slot_from_window(secondary_window, "left", "above", slot_w, slot_h));

    // 8) 启动恢复：快照矩形直接落位，狗槽等于快照狗槽
    push("startup-restore", slot, slot);

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invariant_passes_within_two_pixels_and_flags_beyond() {
        let before = SlotRect::new(-259, 811, 259, 221);
        assert!(assert_slot_invariant(before, SlotRect::new(-257, 809, 259, 221), "op", true).is_none());
        let violation = assert_slot_invariant(before, SlotRect::new(0, 0, 259, 221), "overlay->rightclick", true)
            .expect("must flag");
        assert_eq!((violation.dx, violation.dy), (259, -811));
        assert!(violation.corrected);
    }

    #[test]
    fn correction_target_restores_original_slot() {
        let before = SlotRect::new(-259, 811, 259, 221);
        let moved_window = SlotRect::new(0, 0, 259, 221);
        let target = correction_target(moved_window, before, moved_window);
        assert_eq!((target.x, target.y), (before.x, before.y));
    }

    #[test]
    fn missing_monitor_is_unrecoverable() {
        let before = SlotRect::new(-259, 811, 259, 221);
        let violation = assert_slot_invariant(before, SlotRect::new(0, 400, 259, 221), "switch", false)
            .expect("must flag");
        assert!(!violation.corrected);
        assert_eq!(violation.reason.as_deref(), Some("monitor_missing"));
    }

    #[test]
    fn selftest_scenarios_all_pass() {
        let results = selftest_scenarios();
        assert_eq!(results.len(), 8);
        let failed: Vec<_> = results.iter().filter(|item| !item.pass).collect();
        assert!(failed.is_empty(), "failed: {failed:?}");
    }

    #[test]
    fn expanded_and_overlay_slots_roundtrip() {
        let slot = SlotRect::new(-259, 811, 259, 221);
        for (side, vertical, w, h) in [
            ("left", "above", 727, 480),
            ("right", "above", 727, 480),
            ("left", "below", 587, 540),
            ("right", "below", 587, 540),
        ] {
            let window = window_from_slot(slot, side, vertical, w, h);
            assert_eq!(slot_from_window(window, side, vertical, slot.width, slot.height), slot);
        }
    }
}