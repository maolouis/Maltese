# 可指定小狗 / Bongo 所在的显示器（多屏放置）

> 2026-11-17 · **状态：已实现**（本机双屏实机验证：`DISPLAY2 2560×1440 @100%` 主屏 +
> `DISPLAY1 1920×1080 @100%` 左侧副屏；证据见 §7）。
> 用户操作：设置 →「小狗的状态」下方的「所在屏幕」卡 → 选「小狗屏幕 / Bongo 屏幕」，**改完即时生效**，不用重启。

## 0. 用户怎么用（30 秒）

1. 打开设置（岛内设置页「感知与陪伴」区，或独立设置窗口「桌宠形态」卡）；
2. 找到「所在屏幕」：`小狗屏幕` 选「副屏 1 · 1920×1080 @100%」，`Bongo 屏幕` 默认「跟随小狗」；
3. 小狗会立刻出现在那块屏的默认锚点（底部居中），锁角 / 拖到任意位置都在这块屏内部生效；
4. 只有一块屏时两个下拉是灰的并显示「只有一块屏幕」；
5. 副屏被拔掉/关闭 → 自动回主屏并弹一句「副屏已断开，已回到主屏」；插回来自动回到副屏（偏好会保留）。
6. 「固定在桌面的标签页」（📌）跟随同一块屏：切屏/拔屏一起移动；固定页**不进任务栏**（没有灰框），
   关闭方式见 §8（窗口内「×」/「取消固定」，或在主岛面板重新点 📌）。

## 1. 需求

- 新增两个设置项：「小狗所在屏幕」「Bongo 所在屏幕」，取值 `主屏 / 副屏（第 N 块扩展屏）/ 跟随上次位置`。
- 选中副屏后，主岛与 Bongo 的**默认落位锚点**改为该屏工作区（左/右/双屏交界处按该屏计算），
  锁角 / 贴边 / 自定义位置仍在该屏内部生效。
- 多屏 DPI 不同（100% vs 150%）时，切屏后窗口尺寸/字号不得错位；跨屏拖动后要重新采集该屏 scale。
- 副屏被拔掉/关闭 → 自动回主屏 + UI 提示「副屏已断开，已回到主屏」；只有一块屏时设置项显示「只有一块屏幕」不可选。
- 显示器热插拔要重新应用。
- 默认「主屏」，**单屏用户行为完全不变**。

## 2. 显示器指纹（稳定映射，不用索引当唯一键）

索引在热插拔/改分辨率后会变，所以持久化的是指纹：

```ts
export type MonitorFingerprint = {
  name: string;      // Tauri Monitor::name()（如 \\.\DISPLAY1），同机通常稳定
  width: number;     // 物理像素
  height: number;
  x: number;         // 物理坐标（多屏拼合）
  y: number;
  scale: number;     // scale_factor
};

/** 匹配优先级：名字相同且尺寸相同 > 名字相同（分辨率变了）> 尺寸+位置相同（换口但同型号）> 找不到（视为断开） */
export function matchMonitor(target: MonitorFingerprint, available: MonitorFingerprint[]): {
  monitor: MonitorFingerprint | null;
  matchedBy: "exact" | "name" | "geometry" | "none";
};
```

- 存 `name + 尺寸 + 位置 + scale`（换分辨率也能认回来，改名后靠几何兜底）。
- `matchedBy === "none"` → 视为「副屏已断开」，回主屏并提示。

## 3. 锚点与工作区（按目标屏计算）

- 现有 `apply_stage_geometry` 用 **窗口自己的** `scale_factor` 与 `current_monitor()`；
  跨屏后会拿错屏的 scale/工作区，出现尺寸偏大/偏小、锁角落到别屏。改为：

```ts
/** 目标屏 → 该屏工作区（物理像素），并且用该屏自己的 scale 换算逻辑尺寸。 */
export function targetWorkArea(monitor: MonitorFingerprint, logicalWidth: number, logicalHeight: number): {
  x: number; y: number; width: number; height: number;
};
/** 锁角：在该屏工作区的对应角（右下 = 该屏的右下角），边距仍为 marginY。 */
export function cornerRect(monitor, logicalWidth, logicalHeight, corner: "tl" | "tr" | "bl" | "br", marginY: number);
```

- 裁剪（`clampToWorkArea`）只在**目标屏**内做，不跨屏夹到主屏。
- 展开面板的「往右长 / 往左翻」判定也用目标屏的 `work_left/work_right`。
- DPI：窗口 `set_size` 用 `LogicalSize` + **目标屏 scale**；`set_position` 用物理坐标。
  跨屏拖动结束后监听 `ScaleFactorChanged` 重新读该屏 scale 再套一次几何。

## 4. 降级与热插拔

- 副屏断开：`matchedBy === "none"` → 用主屏锚点重排，并通过 `island-position-changed`/设置页横幅提示
  「副屏已断开，已回到主屏」（一次性提示，不反复弹）。
- 只有一块屏：设置项禁用 + 文案「只有一块屏幕」。
- 热插拔：Tauri 2 暂无跨平台 `on_monitor_change`，用 30s 轮询 `available_monitors()` 指纹集合对比
  （集合变化才重算，不新增高频定时器）；Rust 侧窗口位置异常（哨兵/工作区外）已有 `ensure_island_on_screen` 兜底。
- 与最小化漂移修复协同：所有几何入口先过 `island_geometry_frozen`，切屏重算同样受保护。

## 5. UI

- 独立设置窗口「桌宠形态」卡片 + 岛内「外观/位置」区各加一块下拉：
  小狗屏幕 / Bongo 屏幕（Bongo 默认「跟随小狗」），每项标注 `2560×1440 @100%` 这样的分辨率与缩放。
- 改动即时生效：写设置 → 前端 `set_island_layout`/`sync_desktop_extras` → Rust 重新算几何，无需重启。

## 6. 测试计划（落地时）

- 纯函数单测：
  - 指纹匹配：同名不同分辨率（`matchedBy="name"`）、索引变化（名字不变仍命中）、屏被拔（`"none"`）、换口同几何（`"geometry"`）；
  - 按目标屏算锚点/锁角/裁剪：副屏在左（x 为负）时左下角坐标正确、不会夹到主屏；
  - DPI 换算：100% ↔ 150% 下逻辑尺寸 → 物理尺寸与工作区裁剪一致。
- 实机（本机双屏：`DISPLAY2 2560×1440 @100%` 主屏、`DISPLAY1 1920×1080` 左侧副屏）：
  - 选副屏 → `GetWindowRect` 期望：左下角锁角约 `-1920+16, 1080-…`（在 DISPLAY1 工作区内）；
  - 拔掉副屏（或改「仅主屏」投影模式）→ 回主屏并提示；
  - 单屏用户：默认主屏时矩形与改动前逐像素一致。

## 7. 实机验证（2026-11-17，本轮已做）

**设置界面（`work/multimon.log`）**：设置窗口里有「所在屏幕」卡，两个下拉
`COMBO name='小狗屏幕'` / `COMBO name='Bongo 屏幕'` 均可操作；卡片下方列出各屏
`副屏 1 · 1920×1080 @100%`。

**选副屏 → 选主屏（`work/multimon.log`，期望 vs 实际）**

| 操作 | 窗口 | 实测矩形 | 期望 | 结论 |
| --- | --- | --- | --- | --- |
| 选「副屏 1」 | 主岛 | `-1090,859,259,221` | 副屏底部居中 = `-1920+(1920-259)/2 = -1090`，`1080-221=859` | ✅ 完全一致（负 x 区域） |
| 选「副屏 1」 | Bongo | `-1896,852,280,228` | 副屏左下（跟随小狗） | ✅ 在副屏内 |
| 切回「主屏」 | 主岛 | `1150,1219,259,221` | `(2560-259)/2=1150`、`1440-221=1219` | ✅ 回到主屏 |
| 切回「主屏」 | Bongo | `24,1212,280,228` | 主屏左下（边距 24） | ✅ |

**模拟拔屏 → 插回（`work/multimon-sample.log` / `work/multimon-unplug2.log`，用 `DisplaySwitch.exe /external` 让副屏从枚举里消失）**

| 阶段 | 主岛矩形（450ms 采样） | 结论 |
| --- | --- | --- |
| 拔屏前（已选副屏） | `-1090,870,259,221` | 副屏底部居中 |
| 拔屏后 **450ms** | `1150,1171,259,221` → 稳定 `1150,1230` | ✅ 立刻回主屏底部居中（`(2560-259)/2=1150`），不是 `-32000`、不留在屏外 |
| 插回后（`/extend`） | `-275,795,259,221` | ✅ 自动回到副屏（负 x）；位置是「上次位置夹进副屏工作区」，可能贴边，拖一下即可 |

- 降级提示（中文）：`TOAST_FOUND 6858ms: '副屏已断开，已回到主屏'`（另一轮 24.4s 找到——都在 30s 热插拔轮询窗口内）；
  同一时刻 Rust stderr：`[monitor] preferred monitor missing (\\.\DISPLAY1|1920x1080@-1920,0), falling back to primary`。
- 降级后**保留偏好**：插回副屏会自动回去（上表最后一行），不需要重选。
- 只提示一次：同一块屏断开着期间不反复弹（`MONITOR_MISSING_NOTIFIED` 记住上次提示的 key）。
- 兜底重试：云朵气泡会占用 overlay 快照把几何挡掉，所以降级路径在 8s 内重试 10 次（幂等），保证一定落回主屏工作区。

## 8. 固定标签页（📌 pinned）的多屏行为

「固定在桌面的标签页」和主岛共用**同一份**「小狗屏幕」偏好，不再永远待在主屏：

1. **跟随屏幕**：`pin_page_to_desktop` 每次显示前都会调 `place_pinned_window`：
   目标屏 = `ISLAND_MONITOR_PREF` 指纹匹配到的显示器，匹配不到回主屏；
   默认落在**目标屏工作区右下角、留 24px 边距**（pinned 窗口 420×560 逻辑尺寸）。
2. **DPI**：先把窗口物理尺寸按「当前屏 scale」还原成逻辑尺寸，再乘**目标屏自己的 `scale_factor`** 设回物理尺寸——
   150% 副屏上不会变成半个窗口或溢出屏幕。
3. **切屏立即跟随**：`set_monitor_preferences`（设置里改「小狗屏幕」）会同时重排主岛、Bongo 和 pinned；
   pinned **正在显示就立刻移动，隐藏中只更新位置**（再点 📌 时直接出现在新屏）。
4. **拔屏 / 插回**：走同一条 `maltese-monitor-missing` 降级链路（主岛几何降级时同步 `place_pinned_window`，
   并在 8s 重试里重复摆位）；副屏消失 → pinned 回主屏，插回 → 一起回副屏。
5. **位置记忆**：用户拖动过 pinned 后记录物理坐标（`PINNED_MANUAL_POSITION`；程序自己的 `set_position`
   用 `PINNED_AUTO_POSITIONING` 标记，不会被当成拖动）。换屏时把这个坐标**夹进目标屏工作区**（`clamp_to_work_area`），
   尽量保留相对位置、绝不甩到屏幕外；没拖动过则用目标屏右下角默认位。
6. **UI**：设置页「所在屏幕」卡底部一行说明「固定在桌面的标签页会跟随「小狗屏幕」；换屏或拔屏时一起移动。」
7. **不进任务栏（2026-11-18 修 P1 灰框）**：pinned 是无边框透明悬浮窗口，如果被当成普通窗口，
   任务栏会渲染成一个没有标题/图标的灰块。修法是创建时 `skipTaskbar: true`（Windows 上等价于
   `WS_EX_TOOLWINDOW`，同时从 Alt+Tab 列表移除），并对已存在的窗口在每次固定时再显式
   `SetWindowLongPtrW(GWL_EXSTYLE, … | WS_EX_TOOLWINDOW & !WS_EX_APPWINDOW)` 做双保险。
   **怎么关掉固定窗口**：固定窗口右上角「×（关闭这个窗口）」或左上角「取消固定」按钮；
   也可以在主岛面板再点一次 📌 重新固定别的标签页。
   托盘图标、主岛、Bongo 都不受影响（它们本来就是隐藏/悬浮窗口）。

纯函数（`src/monitorSelection.ts`，均有单测）：`resolvePinnedWorkArea`（跟随偏好 / 拔屏回主屏）、
`pinnedDefaultPosition`（右下角 24px）、`clampPinnedPosition`（换屏夹取）、`pinnedPhysicalSize`（目标屏 DPI）。

### 8.1 实机验证（2026-11-18，本机双屏）

| 步骤 | 实测 | 结论 |
| --- | --- | --- |
| 小狗屏幕=主屏 → 点 📌 | pinned `2116,856,420,560` | ✅ 主屏右下角：`2560-420-24=2116`、`1440-560-24=856` |
| 设置里切到副屏（**不重新点 📌**） | pinned `-444,496,420,560` | ✅ 立即跟到副屏：`-1920+1920-420-24=-444`、`1080-560-24=496` |
| `DisplaySwitch /external`（副屏消失） | pinned `2116,856,420,560` | ✅ 回主屏右下角，不越界、不留 `-32000` |
| `DisplaySwitch /extend`（插回副屏） | pinned `-444,496,420,560` | ✅ 自动回副屏 |
| 点「关闭这个窗口」 | pinned `hidden` | ✅ 取消固定正常 |
| 任务栏样式位（`GWL_EXSTYLE`） | `0x40118 → 0x198`，`WS_EX_TOOLWINDOW=true` / `WS_EX_APPWINDOW=false` | ✅ 不再出现在任务栏 / Alt+Tab |
| 主岛 / Bongo / 托盘 | 不受影响（主岛切屏正常、托盘图标仍在） | ✅ |

- 顺带修了一个竞态：连续改下拉时三次 `set_monitor_preferences` 的返回顺序没有保证，旧选择晚到会覆盖偏好
  （实测 pinned 因此留在主屏）。现在前端用 generation + 串行队列，只让最后一次选择生效。
- 拔屏时如果主岛窗口被系统最小化（`DisplaySwitch` 会这样），主岛几何会冻结，但 pinned 由 30s 显示器轮询
  单独摆位（不依赖主岛几何），所以 `GetWindowRect` 里 pinned 仍能正确回主屏。

## 9. 测试与改动文件

- 单测 `tests/monitor-selection.test.mjs`（10 条）：指纹匹配（完整一致 / 同名不同分辨率 / 索引顺序变化 /
  换接口同几何 / 拔屏 `none`）、锁角锚点（副屏在左时 x 为负）、跨屏裁剪、DPI 换算（100% vs 150%）、
  下拉选项（只有一块屏时禁用）、偏好解析（`last`→null、`primary`→主屏指纹、Bongo 跟随小狗）、
  **pinned 目标屏解析 / 右下角默认位 / 换屏夹取 / 目标屏 DPI**。
- Rust 单测（`lib.rs` tests）：`pinned_anchor_sits_bottom_right_of_the_target_work_area`、
  `pinned_clamp_keeps_window_inside_after_screen_switch`。
- 改动：
  - `src-tauri/src/lib.rs`：`list_monitors` / `set_monitor_preferences` 命令、显示器指纹
    （`name|WxH@x,y`，四层匹配）、`apply_stage_geometry` 用目标屏工作区与 **目标屏 scale_factor**、
    `lock_island_corner` 按目标屏锁角、`maltese-monitor-missing` 事件、30s 热插拔轮询、
    **pinned 跟随屏幕（`place_pinned_window` / `PINNED_MANUAL_POSITION` / DPI 换算）**；
  - `src-tauri/src/desktop_extras.rs`：Bongo / 陪玩狗 / 跟随宠按所选屏工作区落位（Bongo 默认跟随小狗所在屏）；
  - `src/monitorSelection.ts`（纯函数）+ `tests/monitor-selection.test.mjs`；
  - `src/ScreenPlacementCard.tsx` / `.css`（两处设置共用，只有一块屏时禁用）、
    `src/App.tsx`（设置项 `islandScreen`/`bongoScreen` + 下发偏好 + 缺屏气泡）、
    `src/SettingsWindow.tsx`（卡片挂载）、i18n 文案。

## 11. 重启后 Bongo 跟随小狗（2026-11-19 修复）

**现象**：小狗在副屏、Bongo 设为「跟随小狗」，完整退出应用再启动后 Bongo 回到主屏。

**根因**（时序 + 解析）：
1. 屏幕偏好（`islandScreen` / `bongoScreen`）只在内存里，靠前端 `set_monitor_preferences` 恢复；
   启动瞬间前端还没跑，`extras_target_monitor_key` 拿到 `None` → 回主屏把 Bongo 放好。
2. 更关键：「跟随小狗」原来解析成**小狗屏幕偏好**；当「小狗屏幕 = 跟随上次位置」时这个偏好是
   `null`，于是 Bongo 直接回主屏——而小狗自己是靠持久化的**位置**落在副屏的。

**修法**：
- `extras_target_monitor_key`：Bongo 单独偏好 → 小狗屏幕偏好 → **小狗窗口实际所在显示器指纹**，
  三级解析（`resolve_extras_target_key` 纯函数，Rust / TS 各一份单测）。
- 主岛几何落定（`set_island_interaction`）后立刻重排一次 extras（幂等）；
- 启动后 **1s / 3s / 6s** 各重同步一次，等显示器枚举、前端恢复位置、偏好就绪；
- `work_area` 的兜底从硬编码 `1920×1080` 改为**主屏真实工作区**；
- 排障日志：`[monitor] extras sync bongo monitor=<指纹> rect=<x,y,w,h> prefer=<偏好|follow>`。
