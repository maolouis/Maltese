# 桌宠窗口几何 · 修复状态（2026-11-19 只读整理）

> 本文件是**状态汇总**，不改代码。所有数据来自本机双屏实机（主屏 `DISPLAY2 2560×1440 @100%`、
> 左侧副屏 `DISPLAY1 1920×1080 @100%`，副屏 x 范围 `-1920..0`）。证据日志都在 `work/`（不进版本库）。

## 1. 已修复并验证

| # | 问题 | 根因 | 修法 | 证据 | commit |
| --- | --- | --- | --- | --- | --- |
| 1 | 最小化后位置漂移 / 面板闪烁 | Windows 最小化把窗口挪到 `-32000` 哨兵坐标、尺寸变 0，几何入口把它当真实位置写回；失焦收起误判最小化 | `island_geometry_frozen` + `PRE_MINIMIZE_ISLAND_RECT` 缓存、还原时逐像素 `set_size`+`set_position`、前端失焦收起加最小化判别 | `work/drift-now-before.log` / `drift-now-after.log`（80ms 采样，修复后三条路径 `SAMERECT=True`，展开面板还原后仍为展开矩形） | `a02a09b` |
| 2 | 唤醒过渡帧里的 8px 位移 | 位移动画中间帧被当成用户拖拽，写进持久化位置 | 拖拽落点只在动画结束/非过渡帧采信（`POSITION_ANIMATING` + delta 判据） | `tests/island-minimize-drift.test.mjs` + `work/drift-now-after.log` 无 8px 跳变 | `bb73d3d` |
| 3 | 多屏放置 / DPI 错位 | 只用当前屏 `current_monitor()` 与主屏坐标，副屏（负 x）与 150% 缩放下错位 | 显示器指纹 `name\|WxH@x,y` 四层匹配；按目标屏 `work_area` + 目标屏 `scale_factor` 摆位；30s 热插拔轮询 | `docs/pet-multi-monitor.md` §7：选副屏主岛 `-1090,859`（`-1920+(1920-259)/2`）、切回主屏 `1150,1219` | `5ae7f00` |
| 4 | 固定页（📌）不跟随小狗屏 + 任务栏灰框 | 固定页只在 `current_monitor`/`0,0` 时摆位；无 `skipTaskbar`，透明无边框窗口带 `WS_EX_APPWINDOW` 被任务栏画成灰块 | `place_pinned_window` 用与主岛同一份 `islandScreen` 偏好（目标屏右下角 24px、目标屏 DPI、位置记忆夹取）；`skipTaskbar` + `SetWindowLongPtr(GWL_EXSTYLE)` 打 `WS_EX_TOOLWINDOW`、去 `WS_EX_APPWINDOW` | `work/pinned-verify.log`、`work/pinned-unplug.log`：主屏 `2116,856` → 切副屏 `-444,496` → 拔屏 `2116,856` → 插回 `-444,496`；`GWL_EXSTYLE 0x40118 → 0x198`（TOOLWINDOW=true / APPWINDOW=false） | `2b478e2` |
| 5 | 右键/点开面板时窗口往右跳进主屏 | 展开锚点用前端旧 `islandPositionRef` / Rust `previous_state.custom_position`（浮层开合、回位、闲逛后不更新）；`panel_side` 判定后无跨屏兜底 | 狗槽不变量：展开落定后算 `dx/dy`，>1px 就平移回原位（`OVERLAY_SLOT_CORRECT`）；再按狗槽所在显示器夹窗口（`OVERLAY_MONITOR_CLAMP`）；`expanded_panel_side` 用目标屏左右边界 + 8px 边距，右侧放不下翻左侧 | `work/slot-invariant.log`、`work/rc3-boot.log`：副屏居中 `-1020,351→-1020,92`；靠右 `-442,569→-910,310`（panel_side 翻 left）；靠左 `-1898,587→-1898,328`；靠下 `-1157,726→-1157,467`；12 次右键 `RC_GEOM` 全 `dx=0 dy=0`、收起位置零漂移、全部 `right ≤ 0` | `70c0620`（锚点来源 `d8366a4`） |
| 6 | Esc 关闭浮层后窗口停在浮层尺寸 | Esc 只调 `collapseIsland()`（本来就已收起），没走浮层收尾，`OVERLAY_SNAPSHOT` 没恢复 | Esc 先判断浮层存在 → 走 `hidePetOverlay()`（与点击外部同一条路径 → `set_island_overlay(None)` → 快照恢复） | `work/esc-overlay2.log`：`-579,504,587,540` → Esc 200ms 后 `-251,823,259,221`，连续 3 次、700ms 仍稳定 | `7061079` |
| 7 | 重启后 Bongo 回主屏 | 屏幕偏好只在内存、启动瞬间为 `None`；「跟随小狗」解析成小狗屏**偏好**（跟随上次位置时为 `null`）→ 回主屏，而小狗靠持久化**位置**在副屏 | 三级解析（Bongo 偏好 → 小狗屏偏好 → **小狗窗口实际所在显示器指纹**）+ 主岛几何落定后立即重排 extras + 启动 1s/3s/6s 幂等重试 + `work_area` 兜底改主屏真实工作区 | `work/bongo-restart2.log` / `bongo-restart3.log`：两次完整退出重启，island `-1090,811/859`、bongo `-1896,804/852`（均在副屏）；日志 `[monitor] extras sync bongo monitor=\\.\DISPLAY1… prefer=…` | `6d2423d` |
| 8 | 任务栏浮出时挡住气泡/浮层/固定页 | `monitor.work_area()` 在任务栏「自动隐藏」时不排除任务栏，浮出即遮挡 | `SHAppBarMessage(ABM_GETTASKBARPOS)` + 副屏 `Shell_SecondaryTrayWnd` 枚举 → safe rect（按贴边削一条带 + 8px，<2px 细边不算）；摆位后统一 clamp；`start_taskbar_watch` 每 500ms 只在越界时上移、收起后不回落 | `work/taskbar-final3.log`：固定页 `-444,448,-24,1008` 与任务栏交集 `0×0`；自动隐藏浮出后 700ms 内上移到 `-444,464,-24,1024`（距 8px），收起保持不回弹 | `70c0620` |

## 2. 单测覆盖

- `tests/island-minimize-drift.test.mjs`（5）：最小化哨兵、矩形合理性、失焦收起判据、Rust 源码闸口。
- `tests/monitor-selection.test.mjs`（11）：指纹匹配四层、副屏负坐标锚点、跨屏裁剪、目标屏 DPI、
  下拉选项、偏好解析、pinned 目标屏/右下角/夹取/DPI、Bongo 跟随解析。
- `tests/taskbar-safe.test.mjs`（9）：四边任务栏判定、自动隐藏细边、负坐标副屏、多任务栏、夹取、极小屏。
- Rust tests：`pinned_anchor_*`、`pinned_clamp_*`、`taskbar_edge_*`、`bubble_safe_rect_*`、
  `clamp_rect_*`、`expanded_panel_side_*`、`extras_target_*`（本机 `cargo test` 二进制因 DLL 入口问题跑不起，
  只保证 `cargo check --tests` 通过；等价逻辑在 TS 单测里执行）。

## 3. 未验证项

| 项 | 说明 |
| --- | --- |
| 顶部 / 左侧任务栏 | 本机 Windows 11 build 26200 已移除「任务栏位置」设置，改 `StuckRects3` 不会真的移动任务栏；四边判定只在单测覆盖，实机只验证了底部任务栏 + 自动隐藏。 |
| 真实物理拔线 | 用 `DisplaySwitch.exe /external`、`/extend` 模拟显示器消失/插回，没有拔 HDMI/DP 线。 |
| 混合 DPI | 本机两块屏都是 100%；150% 副屏的尺寸/字号换算只有单测（`toPhysical` / `pinnedPhysicalSize`）。 |
| 「小狗屏幕 = 跟随上次位置」偏好 | 该分支（偏好为 `null` 时按小狗实际所在屏解析）只有单测；实机下拉在 UIA 里选不中（见 §4），没能切到该值重启验证。 |
| 独立气泡窗口（视频摘要 `show_pet_bubble`） | 同一条 clamp 函数，但实机没触发过该路径，只有单测。 |

## 4. 已知遗留

| 项 | 现状 |
| --- | --- |
| 重启后 ~1s 内 Bongo 先在主屏、再纠正到副屏 | 已确认接受：启动瞬间显示器枚举/前端偏好未就绪，1s/3s/6s 重试会纠正；未做「等偏好就绪再创建」。 |
| 设置里的「小狗屏幕 / Bongo 屏幕」下拉 UIA 选不中 | 不是被遮挡：WebView2 把 `<option>` 暴露成 `ListItem`，但**不支持 `SelectionItemPattern`**（`GetCurrentPattern` 报 Unsupported Pattern）；鼠标点击 + 方向键/Enter 正常。自动化脚本已改用点击+键盘兜底。 |
| 右键展开的根因收敛 | `70c0620` 用「狗槽不变量 + 事后校正 + 跨屏 clamp」止血；正常场景 `OVERLAY_SLOT_CORRECT`/`OVERLAY_MONITOR_CLAMP` 都是 0 次触发，若线上仍出现，按 `RC_GEOM` 的 `anchor/monitor/panel_side/dx/dy` 定位分支。 |
| 气泡窗口与主岛共用「小狗屏幕」偏好 | 已实现；但独立气泡窗口（不是主岛内浮层）只在视频摘要路径出现，未实机验证。 |

## 5. 几何不变量自检（2026-11-20）

### 5.1 不变量定义（唯一真理：狗槽屏幕坐标）

- **收起态**：狗槽 = 窗口矩形左上角 `(x, y)` + 尺寸 `(slot_w, slot_h)`；
- **展开 / 浮层态**：由 `panelSide / panelVertical` 反推狗槽：
  - `left`：狗槽 x = 窗口 x + 窗口宽 - 槽宽；`right`：狗槽 x = 窗口 x；
  - `above`：狗槽 y = 窗口 y + 窗口高 - 槽高；`below`：狗槽 y = 窗口 y；
- **不变量**：同一逻辑状态下，任何操作（开合浮层、右键、Esc、切屏、缩边唤醒、设置变更、启动恢复）
  前后狗槽偏差 **≤ 2px**。

### 5.2 校验点与兜底（Rust）

| 位置 | 行为 |
| --- | --- |
| `correct_expanded_slot_after` | 展开后按不变量校验；超差 → `OVERLAY_SLOT_CORRECT` 平移回原槽，再校验一次，超差记 `SLOT_INVARIANT_VIOLATION op=… dx=… dy=… corrected=…` |
| 同上（锚点越界） | `slot_before` 不在任何显示器内 → `RECALC_GUARD reason=anchor_offscreen`，回退 `LAST_SETTLED_ISLAND_RECT` |
| 同上（角落风险） | 目标贴屏幕左上角（距 (0,0) <50px）且偏差 >2px → `OVERLAY_CORNER_GUARD` |
| `apply_stage_geometry` / 槽位纠正 | 目标 `(0,0)` 一律拒绝：`RECALC_GUARD reason=zero-position` |
| `set_island_interaction` | 进展开流程时若浮层仍开：`RC_GEOM_AFTER_OVERLAY before=… after=… anchor=… overlay_active=true` |
| `set_island_overlay` / `plan_island_overlay` / `show_island` / `lock_island_corner` / 拖拽收尾 / 启动恢复 | 由上述统一入口覆盖；启动恢复日志 `STARTUP_RESTORE …`（见 §13 于 `docs/pet-multi-monitor.md`） |

本次同时修复（P0「双击浮层后右键 → 小狗到左上角」）：
右键时若浮层已开，前端只切页签、不再调用 `onOpenPage` 的几何路径；`openIslandPage` 也加了同样的守卫。
根因：`clearPetOverlayForPage()` 只清 React 浮层、不关原生 `OVERLAY_SNAPSHOT`，随后
`apply_stage_geometry` 被 `OVERLAY_SNAPSHOT.is_some()` 短路、窗口停在浮层尺寸，展开后的界面把小狗画在左上角。

### 5.3 自检命令（结构化 JSON）

应用内调用：

```ts
await invoke("island_geometry_selftest");
// { tolerance: 2, total: 8, passed: 8, scenarios: [{ op, before, after, dx, dy, pass }, …] }
```

8 个场景：`collapsed->rightclick`、`collapsed->doubleclick`、`overlay->rightclick`、`overlay->esc`、
`tucked->wake`、`switch-primary`、`switch-secondary`、`startup-restore`。

### 5.4 回归脚本

```bash
node scripts/geometry-invariant.mjs   # 跑 cargo test --lib geometry_invariant；失败退出码非 0
```

本机 Rust 测试二进制若因 DLL 入口无法加载，脚本会提示改用应用内 `island_geometry_selftest` 取同一套 JSON。
单测位置：`src-tauri/src/geometry_invariant.rs`（不变量通过/纠正/无法纠正三分支 + 8 场景 + 四方向反推回环）。
» 日志格式：`SLOT_INVARIANT_VIOLATION op=<op> dx=<dx> dy=<dy> corrected=<bool> before=(x,y) after=(x,y)`。
### 5.5 设置页入口（2026-11-20）

设置页「诊断」区块 → 按钮「**几何自检**」：
- 岛内设置页（`LayoutEditor`，多屏放置卡片下方）与独立设置窗口（`SettingsWindow`）都有；
- 点击 `invoke("island_geometry_selftest")`，表格展示 8 场景 × 通过/失败 × dx,dy，失败项标红，并显示总通过数；
- 「复制 JSON」一键复制结果；有失败项时提示「请把这段发给我」。
- 组件：`src/GeometrySelfCheck.tsx`；i18n：`geometrySelfCheck`（zh-CN / en）。

