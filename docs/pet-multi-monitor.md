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

## 8. 测试与改动文件

- 单测 `tests/monitor-selection.test.mjs`（6 条）：指纹匹配（完整一致 / 同名不同分辨率 / 索引顺序变化 /
  换接口同几何 / 拔屏 `none`）、锁角锚点（副屏在左时 x 为负）、跨屏裁剪、DPI 换算（100% vs 150%）、
  下拉选项（只有一块屏时禁用）、偏好解析（`last`→null、`primary`→主屏指纹、Bongo 跟随小狗）。
- 改动：
  - `src-tauri/src/lib.rs`：`list_monitors` / `set_monitor_preferences` 命令、显示器指纹
    （`name|WxH@x,y`，四层匹配）、`apply_stage_geometry` 用目标屏工作区与 **目标屏 scale_factor**、
    `lock_island_corner` 按目标屏锁角、`maltese-monitor-missing` 事件、30s 热插拔轮询；
  - `src-tauri/src/desktop_extras.rs`：Bongo / 陪玩狗 / 跟随宠按所选屏工作区落位（Bongo 默认跟随小狗所在屏）；
  - `src/monitorSelection.ts`（纯函数）+ `tests/monitor-selection.test.mjs`；
  - `src/ScreenPlacementCard.tsx` / `.css`（两处设置共用，只有一块屏时禁用）、
    `src/App.tsx`（设置项 `islandScreen`/`bongoScreen` + 下发偏好 + 缺屏气泡）、
    `src/SettingsWindow.tsx`（卡片挂载）、i18n 文案。