# 最小化漂移 / 面板闪烁（2026-11-17 修复）

> 复现：对桌宠窗口用**任何**方式最小化（任务栏右键菜单 / 任务栏按钮 / Alt+Tab / 标题栏 −），
> 还原后小狗位置回不到原处，且对话面板会闪一下。
> 本轮修复：Rust 侧几何冻结 + 最小化前矩形缓存/复位；前端失焦收起加「最小化判别」。

## 1. 根因

1. **最小化期间拿到的是哨兵几何**：Windows 把最小化窗口挪到 `(-32000, -32000)`、尺寸变成 `160×28`。
   - `apply_stage_geometry` 会读 `outer_position()`/`outer_size()` 再 `set_position`/`set_size`；
     最小化时写位置/尺寸等于改写系统的「还原位置」→ 还原后位置变了。
   - `ensure_island_on_screen` 用 `current_monitor()` + 工作区相交判定；哨兵坐标不落在任何工作区里，
     会把 `custom_position` 清成 `None`，再按默认锚点重排 → 位置整体回到默认点。
   - `WindowEvent::Moved(-32000,-32000)` 会进 `record_dragged_position`（虽然要求 `is_dragging`，
     但拖拽收尾与最小化撞车时仍可能写脏）。
2. **最小化触发失焦 → 前端当「用户点了别处」**：`onFocusChanged(false)` 里 `mode === "expanded"`
   就 `collapseIsland()`，面板被收起（视觉上闪一下），随后又重发一次 collapsed 几何。

## 2. 修法

### Rust（`src-tauri/src/lib.rs`）

- 新增 `island_geometry_frozen(window)`：`is_minimized()` 或坐标 ≤ -30000 或 `ISLAND_MINIMIZED` 标记 → 冻结。
- `apply_stage_geometry` / `ensure_island_on_screen` 第一行就 `if island_geometry_frozen { return }`。
- `LAST_SETTLED_ISLAND_RECT`：每次几何落定（含动画结束）记录真实矩形；
  `note_island_minimized()` 把它冻结到 `PRE_MINIMIZE_ISLAND_RECT`（重复事件不覆盖）。
- `restore_island_rect_after_unminimize()`：还原时按 `PRE_MINIMIZE_ISLAND_RECT` 逐像素 `set_size` + `set_position`。
- `sync_minimize_geometry(window)` 挂在 `WindowEvent::Resized` / `Focused` 上；
  `Moved` 回调丢掉哨兵坐标；位移动画线程在最小化时立即 break。
- `show_island` 先 `unminimize()` + 复位，再谈几何。

### 前端（`src/islandMinimizeGuard.ts` + `App.tsx`）

- 失焦后等 `MINIMIZE_BLUR_SETTLE_MS = 160ms`，再 `getCurrentWindow().isMinimized()`；
  真的最小化 → **不收起**（面板不闪），否则照旧 `collapseIsland()`。
- 判据集中在纯函数 `shouldCollapseOnBlur({ focused, mode, minimized, settleMs })`，有单测。

## 3. 验证

- 单测：`node --test tests/island-minimize-drift.test.mjs`（哨兵坐标、矩形合理性、失焦收起判据、Rust 源码闸口）。
- Rust 单测：`minimized_sentinel_positions_are_never_real_geometry`、
  `sane_rect_rejects_sentinel_and_zero_sized_windows`（`cargo test --lib`）。
- 实机采样（`work/drift-now.ps1`，80ms `GetWindowRect`）：见 `work/drift-now-before.log` / `work/drift-now-after.log`。
  - 修复前：最小化期间 `during=-32000,-32000,160,28`；展开面板最小化还原后**退回收起几何**（面板被收起 = 闪烁）。
  - 修复后：同样出现哨兵帧（被忽略），三条路径 `SAMERECT=True`，且展开面板还原后仍是展开矩形。

## 4. 已知边界

- 任务栏右键菜单（`SC_MINIMIZE`）与 `ShowWindow(SW_MINIMIZE)` 在本机实测等价；
  「标题栏 −」在不带标题栏的桌宠窗口上不存在，本轮用前三条路径覆盖。
- 采样脚本会在最小化瞬间看到 `-32000` 帧，这是**正常**的（我们只保证它不被当成几何）。