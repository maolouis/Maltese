# QA 实机验收报告 · 2026-11-17（表情方格墙 / 插件点击说明 / 视频插件文档）

- 测试角色：QA（只读验收，**未改任何产品代码**；本文件是唯一新增文件）
- 被测基线：`22f079e`（工作区干净；包含待测四个提交 `eab2133`、`ba0910a`、`bf36a49`、`bb73d3d`）
- 实机环境：Windows，2560×1440 主屏（工作区 0,0,2560,1440）+ 1920×1080 副屏；安装目录 `E:\Maltese2`；版本 **2.0.2（未改版本号）**
- 验收时间：2026-11-17 11:30–11:50
- 证据目录：`work/qa-*`（`work/` 已 gitignore；截图/日志见文末清单）

> 环境说明（影响证据判读）：本机测试期间**另有操作者在同一台机器上人工操作**（设置窗口被最小化/隐藏、表情轮播列表内容在两次只读快照之间从 30 格变成 28 格且首格由 `举重.gif` 变成 `写.gif`，而本轮脚本从未向设置窗口发送鼠标/键盘输入）。因此**拖拽排序与右键删除没有由本轮做交互验证**，只做代码级核对；文中所有"交互"结论均来自本轮脚本自身的 UIA/真实鼠标事件，并注明了证据。

---

## 1. 构建方式与产物

### 1.1 构建方式（绕过本机 esbuild 临时文件拦截，按 `docs/handoff-2026-11-14.md` 第 5 节）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node_modules\.bin\tsc.cmd` | exit 0 |
| 前端打包（不压缩） | `node_modules\.bin\vite.cmd build --target esnext --minify false` | exit 0（1897 modules，5.35s） |
| 逐文件压缩 | `...\.pnpm\@esbuild+win32-x64@0.28.1\node_modules\@esbuild\win32-x64\esbuild.exe <file> --minify --outfile=dist\assets\__min_<name>` 后覆盖 | exit 0 |
| 桌面壳 + 安装包 | `node_modules\.bin\tauri.cmd build --ci --config src-tauri/tauri.release.conf.json --bundles nsis` | exit 0（release 编译 1m03s，nsis 打包成功，含 updater `.sig`） |

压缩前后（`dist\assets`，压缩输出按要求写在 `dist\assets` 内）：

| 文件 | 压缩前 | 压缩后 |
| --- | --- | --- |
| `index-Bl6Z_bAp.js` | 2,269,267 B | 1,145,637 B |
| `index-vWkRuT3w.css` | 283,103 B | 214,722 B |

### 1.2 产物与实装

| 项 | 值 |
| --- | --- |
| 构建时间 | 2026-11-17 11:32:59 |
| `src-tauri\target\release\maltese-assistant.exe` | 28,518,400 B，SHA-256 `FE5DC5DF4CD28273159F81625D191AE855B8B00FCE8C6F7A9118C58949D32075` |
| `bundle\nsis\Maltese_2.0.2_x64-setup.exe` | 51,662,126 B，SHA-256 `0D93B3B1F948FE51EA60012DF20BC8050090A2A267099F40763EB1FFA27ADB84`（同名 `.sig` 已生成） |
| 实装位置 | `E:\Maltese2\maltese-assistant.exe`（哈希与上表一致，FileVersion 2.0.2） |
| 旧 exe 备份 | `E:\Maltese2\maltese-assistant.2.0.2.bak.exe`（28,468,736 B，SHA-256 `071F5CEA258A088C00BB4988592DA7082149CC72ABCF0E09F7940FD9FF4FCEA6`，构建于 10:46:22） |
| 资源目录 | `E:\Maltese2\resources\assets\pets` 保持原样（1,181 个文件，未删除/未覆盖） |
| 运行实例 | 旧实例 pid 60820 已停止（`CloseMainWindow` 未退出，`Stop-Process` 后替换）；新实例 pid 47196，11:33:29 启动，进程路径 `E:\Maltese2\maltese-assistant.exe` |

**结论：实机构建成功，并以新 exe 实装运行。** 运行中的 UI 出现旧构建没有的内容（`pet-gif-tile` 方格、`plugin-help-window` 浮层、"查看说明"按钮、拖拽/右键提示文案），可证明运行的是本次构建。

---

## 2. 三项功能逐条结论

### 2.1 `eab2133` 表情轮播：方格墙 / 拖拽排序 / 右键删除

| # | 检查点 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1.1 | 长条列表改为**方格墙** | **通过** | UIA：容器 `ControlType.List` class `pet-gif-settings__grid`（rect `1038,899,469,461`），子项 30 个 `ControlType.ListItem` class `pet-gif-tile`；X 唯一值 4 个（1040/1154/1269/1383，列距 114–115），Y 唯一值 8 行（901/1032/…/1818，行距 131，格 107×124）→ 4 列×8 行方格；22 格因容器 `max-height:460px` 滚动区外（`off=True`），可见 8 格 |
| 1.2 | 上下移箭头已移除 | **通过** | UIA 全树检索 `上移/下移/moveUp/moveDown` = **0** 个 |
| 1.3 | 拖拽提示文案/顺序号 | **通过** | 文本：`拖动方格调整播放顺序；右键点击方格删除。`；格子 aria/name：`第 1 张 · 举重.gif` … `第 30 张 · 鞠躬_2.gif` |
| 1.4 | 悬停/聚焦小删除按钮 | **通过（存在性）** | 每个格子内 1 个 `ControlType.Button` class `pet-gif-tile__delete`，name `删除 · <文件名>`，30 格 = 30 个；`CSS` 规则 `opacity:0; pointer-events:none` → hover/focus-within 时 `opacity:1; pointer-events:auto`（`src/PetGifRotationSettings.css:360-385`）。**悬停后可见的像素变化未做交互验证** |
| 1.5 | 拖拽排序（HTML5 draggable + 持久化链） | **未交互验证（代码级通过）** | 代码：`draggable` + `onDragStart/onDragOver/onDrop/onDragEnd`（`src/PetGifRotationSettings.tsx:334-359`）→ `reorder(from,to)`（`:121-129`）→ `saveItems`（`:103-105`）→ `savePetGifRotationConfig` 写 `localStorage["maltese-pet-gif-rotation:<character>"]` 并派发事件（`src/petGifRotation.ts:161-171`）；拖动中 `is-dragging`（opacity .45）/落点 `is-drop-target`（描边 + 左侧插入线）类名齐全（`src/PetGifRotationSettings.css:291-313`） |
| 1.6 | 右键格删除（无二次确认） | **未交互验证（代码级通过）** | 代码：格 `onContextMenu` → `remove(item)`（`src/PetGifRotationSettings.tsx:360-363`）；`remove` 只对自定义项 `invoke("remove_pet_gif")`，随后从配置删条目并 toast `已删除 N 张 GIF`（`:131-143`，i18n `t.petGifs.deleted`） |
| 1.7 | 仅内置项时不会误删文件 | **通过（代码级）** | `remove` 里 `if (item.custom && item.path && isTauri())` 才调用 `remove_pet_gif`；当前列表 30 项均为内置素材（名称与 `resources\assets\pets` 对齐），右键只会改 localStorage 列表 |

**未交互验证原因**：本机 `待机` 列表是用户自定义顺序（首格为 `举重.gif`，并非素材清单默认序），"恢复默认顺序"无法还原；而任务要求不得改动 localStorage 用户数据，故不做真实拖拽/右键（会在 localStorage 留下不可逆改动）。测试期间列表内容又被另一操作者改为 28 格，进一步说明不宜由本轮写入用户配置。

### 2.2 `ba0910a` 插件页说明：点击展开 + 浮层避开操作区

交互全部用真实鼠标事件完成（非仅 UIA Invoke，因为该页展开态**失焦会自动收起**，详见 §5 环境说明）。

| # | 检查点 | 结论 | 证据（同一轮脚本 `work/qa-feature2.log`，11:43:23） |
| --- | --- | --- | --- |
| 2.1 | 仅悬停**不再**弹说明 | **通过** | 光标移到卡片主体（卡片 `关系`，rect `1833,1334,411,57`，指针 `1893,1352`）停留 900ms：`plugin-help-window` 数量 **0** |
| 2.2 | 点击卡片主体弹出说明 | **通过** | 同一位置左键点击：浮层 1 个，`ControlType.Window`，name `关系 说明`，class `plugin-help-window plugin-help-window--above`，rect `1833,1006,320,256` |
| 2.3 | 浮层不遮挡「打开/安装/删除」等操作按钮 | **通过** | 卡片按钮：`查看说明` `2028,1350,25,25`、`打开` `2064,1347,51,31`、`停用` `2121,1347,51,31`、`卸载` `2178,1347,51,31`；与浮层 `1833,1006,320,256` 的**相交面积全部 = 0**；与卡片本身相交面积 = 0（浮层在卡片**上方**，浮层下沿 1262 < 卡片上沿 1334）；浮层完全落在应用窗口内（`DIALOG_INSIDE_WINDOW=True`） |
| 2.4 | 再点一次同一卡片收起 | **通过** | 再次左键点击卡片主体 → 浮层数量 **0** |
| 2.5 | 「?」按钮展开 + Esc 收起 | **通过** | 点 `查看说明`（rect `2028,1350`）→ 浮层 1 个；按 `Esc` → 浮层 0 个，**且岛屿仍是展开态**（窗口仍为 727×430，未触发 App 的全局 Esc 收起，说明浮层在 capture 阶段 `stopPropagation` 生效） |
| 2.6 | 点浮层外部收起 | **通过** | 重新点开（浮层 1）→ 点面板内浮层/卡片之外空白处（`2262,1154`）→ 浮层 0 |
| 2.7 | 键盘 Enter/Space 展开、滚动/缩放收起 | **未交互验证（代码级通过）** | `handleCardKeyDown`（`src/PluginsPanel.tsx:297-308`）、`handlePointerDown/handleKeyDown/handleScroll/handleResize`（`:160-194`） |
| 2.8 | 浮层内容（名称/版本/描述/作者/安全提示） | **通过（存在性）** | 浮层内 UIA 有 `plugin-help-window__head`（`1833…`）、关闭按钮 `收起说明`（`2113,1020,24,24`）、`plugin-help-window__meta` 等；无空白/错位（rect 均落在浮层 320×256 内） |

### 2.3 `bf36a49` 视频插件使用文档 `docs/video-plugin-usage.md` 与真实 UI 一致性

按文档逐条对照运行中的「插件」页（tab `插件` → 页顶 `内置插件 / 自动刷视频`；窗口 727×430，内容区 1771px 可滚动）。

| # | 文档条目 | 真实 UI / 代码 | 结论 |
| --- | --- | --- | --- |
| 3.1 | 入口：主窗口「插件」页签 → 上方「自动刷视频」 | 点 tab `插件` 后 UIA 文本 `内置插件`(1844,1101) / `自动刷视频`(1888,1096)，`video-automation` 区域 name `小狗刷视频` | **一致** |
| 3.2 | 独立插件窗口需先安装；安装框/「打开插件目录」/「刷新」 | 面板存在 `安装插件`/`打开插件目录`/`刷新`；安装框 placeholder `插件文件夹或 .zip 路径（含 plugin.json）`；本机 `E:\Maltese2\plugins` 只有 4 个 zip、已安装卡片仅 `关系`/`桌面图标台球`，**没有** video-automation → 与文档"需先安装"一致 | **一致** |
| 3.3 | 平台下拉 `B站推荐流`/`抖音推荐流（实验）` | 代码 `<option value="bilibili">B站推荐流</option>`、`douyin 抖音推荐流（实验）`（`src/plugins/video/VideoAutomationPlugin.tsx:222-223`），运行中 `disabled`（:219） | **一致** |
| 3.4 | 参数与区间：翻页 15–600s、上限 1–240min、采集 1–5s、投递 1–5 次 | 代码 `min/max` 完全对应（`VideoAutomationPlugin.tsx:226-235`）；默认 45/30/2/2（:43-46）；Rust `config.rs` 同名区间 | **一致** |
| 3.5 | 按钮：开始看/停下、保存配置、打开登录窗、刷新历史 | UIA：`开始看`(2009,1298)、`保存配置`(2097,1298)、`打开登录窗`(1863,1346)、`刷新历史`(1979,1346) | **一致** |
| 3.6 | 保存配置"不落盘" | `update_config` 只写内存 `self.config`（`src-tauri/src/video/session.rs:499-508`），无文件写入 | **一致** |
| 3.7 | 小狗自媒体账号：账号下拉、打开账号登录窗、我已登录、4 个档案输入、创建档案 | UIA：`打开账号登录窗`(2079,1447)、`创建小狗账号档案`(1878,1581)；输入 name/placeholder `账号名称`（值 `小狗运营号`）、`平台昵称或账号（可选）`、`小狗人设`、`运营目标`；`我已登录` 仅在选中且状态 `awaitingLogin` 时渲染（`VideoAutomationPlugin.tsx:272-274`，本机未选中账号→按预期不显示） | **一致** |
| 3.8 | 账号状态：草稿/等待登录/已就绪，下拉显示 `draft` 等 | 数据文件 `%APPDATA%\com.maolouis.maltese\video\accounts.json`：`小狗运营号`、`status:"awaitingLogin"`、`profileDir=…\video-accounts\dog-1794880825-1`（目录存在）；状态枚举 `draft/awaitingLogin/ready`（`src-tauri/src/video/accounts.rs:11-15`） | **部分一致**（见 D3：下拉框直接显示英文原始状态码） |
| 3.9 | 通道与诊断：`重新自检` 调 `video_probe_channels` | UIA 按钮 `重新自检`(2123,1806) | **一致** |
| 3.10 | `诊断日志`（文档：展开「重新自检」得到的通道条目） | 实际是独立的 `<details><summary>诊断日志（最近 N 条）</summary>`（`src/plugins/video/VideoChannelCard.tsx:57-66`） | **不一致**（见 D2） |
| 3.11 | 小结与历史：`查看待投递小结` 有待投递才出现、`刷新`、`清空…（保留登录）` | 代码 `pendingCount > 0 && <button>查看待投递小结</button>`（`VideoDigestList.tsx:45-47`）；UIA 有 `刷新`(2155,2043)、`清空小狗的观看数据（保留登录）`(1875,2106)；全量按钮枚举（含 offscreen）中**没有** `查看待投递小结`，本机尚未攒下待投递，符合"仅 pendingCount>0 才渲染" | **一致** |
| 3.12 | 评论与草稿：发送评论（1–200 字、仅手动）、复制草稿、打开投稿页/直播中心 | UIA：评论 textarea placeholder `写一条评论（1–200 字）…`、`发送评论`(1875,2324 **disabled**，未开始观看时禁用)、`复制草稿`(2123,2398 disabled)、`打开投稿页`(1875,2560)、`打开直播中心`(1978,2560) | **一致** |
| 3.13 | 首次登录：专用 Chrome/Edge + 独立 profile，登录态留在 profile | 代码 `browser::launch`：`--user-data-dir=<profile> --remote-debugging-port=<port>`，登录窗加载平台首页、非登录窗 `about:blank`、登录窗 `--new-window`（`src-tauri/src/video/browser.rs:150-207`）；`open_login_window` 用账号 profile 或默认 `video-profile`，并 `mark_login_started` 置 `awaitingLogin`（`session.rs:1260-1295`、`accounts.rs:117`） | **一致（代码级）**；真实登录未执行 |
| 3.14 | 数据路径与保留：`%LOCALAPPDATA%\Maltese\video-profile`、`video-accounts\<id>`、`%APPDATA%\com.maolouis.maltese\video\` 下 sessions/index/profile/accounts | 四类路径在实机均存在：`…\Local\Maltese\video-profile`=True、`…\video-accounts`=True（含 `dog-1794880825-1`）、`…\Roaming\com.maolouis.maltese\video`=True（`accounts.json`/`index.json`/`profile.json`）；`logs\` 尚未生成（未跑过采集，符合预期） | **一致** |
| 3.15 | 端口 9333–9338、CDP 15 秒超时、连续 3 次无响应结束 | `pick_port` 0..=5 从 9333 起（`browser.rs:134-143`）；`PROBE_BUDGET_SECONDS=15`、`MAX_RECOVERY_PROBES=3`（`channel.rs:8-10`） | **一致** |
| 3.16 | 真实登录/采集/评论/投递 | — | **未实机验证**（按任务要求不操作账号；浏览器与采集未启动） |

### 2.4 `bb73d3d` 唤醒后 8px 位移（回归项）

| # | 检查点 | 结论 | 证据 |
| --- | --- | --- | --- |
| 4.1 | 当前位置是否仍是偏 8px 的 1211 | **通过（已回到基线）** | 新构建启动后主窗口 rect `2285,1203,259,221`（UIA + Win32 双确认）；localStorage `focusd-island-position` = `{"x":2285,"y":1203}`（LevelDB 中读取，最新值） |
| 4.2 | 零位移「按下-松手」不写位置 | **通过** | 单击小狗（光标不移动）后：窗口 rect 仍 `2285,1203,259,221`，LevelDB 最新位置仍 `{"x":2285,"y":1203}`（旧实现会在收尾 emit 一次） |
| 4.3 | 位移动画中拒绝开始拖拽 | **未交互验证（代码级通过）** | `drag_start_allowed(state, animating)` 要求 收起态 && !is_tucked && !is_dragging && !animating（`src-tauri/src/lib.rs:447-452`），`start_island_drag` 用它做闸门（`:455-470`）；收尾仅在 `position != drag_origin` 时 emit（`:533-547`） |
| 4.4 | 两个新增单测 | **未验证（环境限制）** | `wake_restores_the_lock_corner_baseline_instead_of_the_work_area_default`（`lib.rs:3949`）、`drag_start_is_rejected_until_the_geometry_has_settled`（`lib.rs:3990`）编译通过；本机 `cargo test --release --lib` 测试二进制加载即失败：`STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`（与 `docs/bugfix-2026-11-17.md` 记录一致） |

> 说明：本轮重启后位置恰为锁角基线 `2285,1203`，但旧实例停止前 localStorage 已被写成 1203（11:31:49 写入），因此**不能**把"回到 1203"单独当作 `bb73d3d` 的实机证明；该项以代码闸门 + 零位移不写位置的行为证据为准。

---

## 3. 缺陷清单

> 本轮**未发现功能性失败/阻塞缺陷**；以下为文档与低风险 UI 问题（P3 = 不阻塞交付，建议下一批文档/打磨一起修）。编号 D 表示缺陷，O 表示观察/风险。

### D1（P3，文档）视频文档故障排查表里引用的错误提示与真实 UI 文案不一致

- 复现：阅读 `docs/video-plugin-usage.md` 第四节，对照 `src/plugins/video/types.ts` 的 `errorMessageForCode`。
- 预期：文档以「现象（提示/报错）」引用 UI 原文，应与实际提示逐字一致（文档开头也承诺"以你机器上的实际表现为准"）。
- 实际：
  - `CDP_RECONNECT_FAILED`：文档 `docs/video-plugin-usage.md:250` 写「小狗浏览器连接连续失败」；实际 `src/plugins/video/types.ts:298` = 「视频页面连接多次失败，本轮已经停止。」
  - `PORT_BUSY`：文档 `:248` 写「本机调试端口被占用」；实际 `types.ts:284` = 「本机调试端口被占用，请稍后再试。」
  - `CDP_STALLED`：文档 `:252` 写「视频页面连续无响应」；实际 `types.ts:296` = 「视频页面连续无响应，本轮已经停止。」
- 可疑位置：`docs/video-plugin-usage.md:248,250,252`；对照 `src/plugins/video/types.ts:283-300`。
- 影响：用户按提示文字搜不到对应报错，排障表定位困难。**只改文档即可**。

### D2（P3，文档）「诊断日志」的操作描述与真实控件形态不符

- 复现：打开插件页 →「通道与诊断」区；对照 `docs/video-plugin-usage.md:168`。
- 预期：文档说「展开『重新自检』得到的通道条目」。
- 实际：`重新自检` 是普通按钮（触发 `video_probe_channels`）；`诊断日志（最近 N 条）` 是**独立的 `<details>` 折叠块**（`src/plugins/video/VideoChannelCard.tsx:57-66`），不是"展开重新自检"的产物。
- 可疑位置：`docs/video-plugin-usage.md:168` vs `src/plugins/video/VideoChannelCard.tsx:35,57-66`。
- 影响：照文档找不到入口/以为是点按钮展开。**只改文档**。

### D3（P3，UI/i18n）账号下拉框直接显示英文原始状态码，与文档的中文状态名不一致

- 复现：插件页 →「小狗自媒体账号」→ 展开账号下拉框（本机已有一个账号档案）。
- 预期：下拉项用中文状态（草稿 / 等待登录 / 已就绪），与同面板右侧状态文案、文档 `docs/video-plugin-usage.md:47,52` 一致。
- 实际：选项文本是 `{displayName} · {status}`，`status` 为 Rust 枚举序列化值 `draft` / `awaitingLogin` / `ready`（`src/plugins/video/VideoAutomationPlugin.tsx:263`、`src-tauri/src/video/accounts.rs:11-15`）；本机 `accounts.json` 中账号为 `awaitingLogin`，选中后下拉会显示 `小狗运营号 · awaitingLogin`。同面板右侧状态徽标却显示「等待登录/已就绪」（`:266-270`），自相矛盾。
- 可疑位置：`src/plugins/video/VideoAutomationPlugin.tsx:262-265`（选项拼接原始 status）。
- 备注：本轮为**代码级 + 数据级**证据（未展开下拉，避免改动 UI 状态；展开下拉本身无副作用，可由研发实机 1 分钟确认）。
- 影响：中文界面里出现英文状态码，且与文档"状态先是「草稿」"的表述对不上。

### D4（P3，待交互复核，拖拽排序）向下拖动时落点与「插入线」语义可能相反

- 复现（待做）：设置 → 表情轮播 → 展开 → 把第 1 格拖到第 2 格上方松手，观察顺序。
- 预期（按视觉提示）：`.is-drop-target::before` 是**目标格左侧的插入线**（`src/PetGifRotationSettings.css:300-313`），提交说明也是"插到这里"，应把被拖格插到目标格**之前**。
- 实际（代码级推断）：`onDrop` 直接把目标下标传给 `reorder(from, to)`，`reorder` 先 `splice(from,1)` 再 `splice(to,0,moved)`（`src/PetGifRotationSettings.tsx:121-129,349-358`）。向下拖（from < to）时，移除元素后目标已左移一位，再插到原下标 = **插到目标之后**；向上拖（from > to）才与插入线一致。
- 可疑位置：`src/PetGifRotationSettings.tsx:121-129`（缺少 `to > from ? to-1 : to` 的修正）。
- 级别：P3（交互语义不一致，不阻塞；需人工拖一次确认，若确认建议连同"插入线画在哪一侧"一起统一）。
- 注：本轮未做交互验证（原因见 §2.1 末段），且测试期间该列表被他人改动，无法安全复现/回滚。

### D5（P2，体验/需求，用户实机反馈）改轮播 GIF 必须打开独立的「桌宠设置」窗口，屏幕上出现两个窗口

> 用户原话（2026-11-17 实机反馈）：「轮播中的 gif 可以改就行了，不用出来两个窗口」。

- 复现：收起态右键小狗展开浮层 → 点顶部「布局编辑/设置」标签。
- 实际：
  1. 主浮层（`src/App.tsx` 的 `island__expanded`）里**没有**表情轮播编辑入口；UIA 实测主窗口 `pet-gif-settings__grid` 数量 = 0，`PetGifRotationSettings` 只在 `src/SettingsWindow.tsx:426` 挂载 → **改轮播 GIF 必然要开独立设置窗口**；
  2. 点「设置」标签走 `invoke("open_settings_window")`（`src/App.tsx:2164-2173`），弹出独立窗口（实测 `992,314,576,819`），此时桌宠岛窗口仍在屏幕右侧（`2285,1203,259,221`）→ 用户看到**两个窗口**；且新窗口抢焦点后岛屿按既有规则失焦自动收起（本次实测主窗口变为 259×221，展开态消失），观感上像"点一下弹两个窗口/闪一下"。
- 预期（按用户反馈）：轮播 GIF 能就地改即可，不要为了改 GIF 额外弹第二个窗口（或至少不要让两个窗口同时出现/来回抢焦点）。
- 可疑位置：`src/App.tsx:2164-2173`（tab 直接 `open_settings_window`，未收起浮层/未提供就地编辑）；`src/SettingsWindow.tsx:426`（轮播编辑唯一挂载点）。
- 备注：这是**产品/UX 取舍**，不是渲染缺陷；可选方向（供研发/产品定，本轮未改代码）：A) 把 `PetGifRotationSettings` 内嵌到浮层「设置」页；B) 浮层里给「编辑轮播 GIF」入口，就地复用现有设置组件；C) 保持独立窗口但打开时先收起浮层并恢复上次位置。
- 级别：P2（不阻塞已有功能，但直接命中用户高频操作路径）。
### 观察项（不编号为缺陷）

- **O1** 设置页「展开（N 张）/ 收起」按钮文案硬编码中文（`src/PetGifRotationSettings.tsx:226`），未走 i18n；属既有问题，非本批引入。
- **O2** 右键删除**无二次确认**（提交说明为有意设计，提示文案已写明"右键点击方格删除"）。风险：误触右键即掉一张轮播图，无撤销；且右键点在小删除按钮上也会删除（`src/PetGifRotationSettings.tsx:387-392`）。是否可接受由产品决定。
- **O3** 展开态岛屿**失焦即自动收起**（`src/App.tsx:8966-8994` 监听 `onFocusChanged`）。这不是本批缺陷，但会让"点击卡片看说明"在多窗口切换时表现成"浮层刚要出现就被收起"，人工验收时容易误判；建议验收时先点一下小狗再操作。

---

## 4. 回归项

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| R1 | 启动显示 | **通过** | 新 exe 11:33:29 启动；8s 内主窗口可见，UIA 树挂载到 `Document → island--collapsed → Button '剩余6个待办'`（说明小狗已渲染，不是白屏/隐藏窗口）；rect `2285,1203,259,221`，`vis=True` |
| R2 | 设置窗口能打开 | **通过** | 展开岛屿 → 点顶部 tab `布局编辑`（rect `2148,1000,42,25`）→ 设置窗口 `vis=True`，Win32 rect `992,314,576,819`；UIA 内出现 `桌宠设置` 与 `表情轮播`（`pet-gif-settings__grid`），说明懒创建窗口正常显示 |
| R3 | 多实例单开 | **通过** | 再启动 `E:\Maltese2\maltese-assistant.exe`（pid 51064），6s 内 `HasExited=True`；进程总数 = **1**（pid 47196），主窗口位置/尺寸未变 |
| R4 | 小狗位置基线 | **通过** | 收起态 rect `2285,1203,259,221`（与锁角基线 `2285,1203` 一致，0px；对比 bugfix 文档旧基线 `2285,1203`、B2 矩阵里的 `2285,1211` 已回归）；localStorage `{"x":2285,"y":1203}` 与真实窗口一致 |
| R5 | 位置持久化不被浮层/点击污染 | **通过** | 插件页多轮展开/收起、浮层开关、点小狗之后，主窗口仍回 `2285,1203,259,221`，localStorage 未变（仍是 `2285,1203`），未出现"浮层矩形被写进位置" |
| R6 | 8px 修复（`bb73d3d`） | **代码级通过 + 零位移行为通过**；动画中按拖拒绝未交互验证；单测受本机 `0xc0000139` 限制无法运行 | 见 §2.4 |

---

## 5. 未验证项与环境限制

1. **拖拽排序 / 右键删除的真实交互**：未由本轮执行（会写 localStorage；且列表已被他人改动、无安全回滚手段）。仅代码级核对。
2. **悬停/聚焦删除按钮的可见性（opacity 变化）**：未做像素级对比；只确认按钮 DOM 存在与 CSS 规则。
3. **视频插件真实登录、真实采集、评论、投递、风控/登录墙恢复**：按任务要求未操作账号、未启动专用浏览器；文档对应条目仍属"未实机验证"。
4. **插件浮层的键盘 Enter/Space 展开、滚动/缩放收起**：代码级通过，未交互。
5. **`cargo test --lib` 单测**：本机测试二进制加载失败（`STATUS_ENTRYPOINT_NOT_FOUND`），两条新单测仅"编译通过"，需在可运行完整 crate 的环境/CI 收口。
6. **并发人工操作的干扰**：测试期间同一机器有另一位操作者（设置窗口被最小化/隐藏；表情列表 30→28 格、首格变化；岛屿因失焦反复收起），所有结论均以脚本自身产生的 UIA/鼠标事件为证据；观测到的一次 `pet-gif-tile is-dragging` 类属于外部操作，未作为证据使用。
7. 安装包（`Maltese_2.0.2_x64-setup.exe`）本轮只**构建**未安装（本机 NSIS 自解压被安全策略拦的老问题）；实装走 exe 文件级覆盖。

---

## 6. 结论

- **构建**：实机构建成功（tsc / vite / esbuild 压缩 / tauri release + nsis 全部 exit 0），新 exe（SHA-256 `FE5DC5DF…D32075`）已实装到 `E:\Maltese2` 并运行；旧 exe 已备份；版本号保持 **2.0.2**。
- **功能验收**：
  - `eab2133` 表情方格墙：**通过**（UIA 4 列×8 行/30 格/30 个删除按钮/无上下移箭头）；拖拽排序与右键删除**只有代码级证据**（未交互验证）。
  - `ba0910a` 插件点击说明：**通过**（悬停不弹、点击弹出、浮层与打开/停用/卸载按钮相交面积为 0、再点/Esc/外部点击均收起）。
  - `bf36a49` 视频文档：**整体与 UI 一致**，发现 2 处文档描述偏差（D1、D2）和 1 处 UI 原始状态码问题（D3）。
  - `bb73d3d` 8px：位置回到基线 `2285,1203`，零位移点击不再写位置；代码闸门与单测编译通过（单测本机无法运行）。
- **是否可交付**：**达标，可以交付**。无阻塞缺陷（P0/P1 无）；D1–D3 为文档/文案问题、D4 待人工拖拽确认；**D5 是用户实机新反馈的 P2 体验项（改轮播 GIF 需开第二个窗口）**，属产品取舍，建议研发/产品确认方向后再改，不影响本批功能验收结论。
- **本报告改动范围**：仅新增本文件；**未改产品代码、未改版本号、未 push**。

---

## 7. 证据文件（`work/` 为 gitignore，保留在本机供复核）

| 文件 | 内容 |
| --- | --- |
| `work/qa-feature1.log` | 设置页 UIA 枚举（11:46 快照：28 格、页面滚动后坐标；30 格/4 列×8 行的数据见 §2.1 与首次快照输出） |
| `work/qa-feature2.log` | 插件页浮层全流程（悬停/点击/矩形相交/再点/Esc/外部点击） |
| `work/qa-feature3.log` | 插件页全部按钮/输入框/下拉/文本 UIA 清单（视频面板对照用） |
| `work/qa-regression.log` | 启动/设置窗口/多实例/位置基线与 localStorage 读取 |
| `work/qa-settings-expanded.png` | 设置窗口截图（576×819） |
| `work/qa-plugin-page.png`、`qa-plugin-page-scrolled2.png` | 插件页（滚动前后） |
| `work/qa-plugin-help-open.png`、`qa-plugin-help-debug.png` | 浮层打开状态截图 |
| `work/qa-video-page-top.png` | 视频面板顶部（参数/账号/按钮） |
| `work/qa-island-expanded.png`、`qa-after-plugin-tab.png` | 岛屿展开态截图 |
| `work/qa-two-windows-main.png`、`qa-two-windows-settings.png` | D5 现场：点「设置」后同时存在的桌宠岛窗口与独立设置窗口 |

---

## 8. 研发处置（2026-11-17，dev 修复轮）

> 角色：研发；范围：只改本清单涉及的代码/文档，**未改本报告 §3 的复现与判定口径、未改
> `docs/bug-acceptance-2026-11-17.md` 的验收条款**；版本仍 2.0.2，未 push、未打 tag。
> 验证命令与输出见 §8.3。

### 8.1 处置汇总

| 编号 | 级别 | 处置 | 证据（文件:行 / commit） |
| --- | --- | --- | --- |
| D1 | P3 文档 | **已修复**：排障表 3 条提示改为与 `errorMessageForCode` 逐字一致 | `docs/video-plugin-usage.md` 排障表（原 248/250/252 行）；对照 `src/plugins/video/types.ts:283-298`；commit `17b3541` |
| D2 | P3 文档 | **已修复**：「诊断日志」说明改为独立 `<details>` 折叠块，并补一行通道概览说明 | `docs/video-plugin-usage.md`「通道与诊断」表；对照 `src/plugins/video/VideoChannelCard.tsx:57-66`；commit `17b3541` |
| D3 | P3 UI/i18n | **已修复**：新增 `accountStatusLabel()`，下拉框与右侧状态徽标统一显示中文（草稿/等待登录/已就绪/已暂停），不再出现 Rust 枚举值 | `src/plugins/video/VideoAutomationPlugin.tsx:28-41,276,280`；同步 `docs/video-plugin-usage.md:47,157`；commit `17b3541` |
| D4 | P3 拖拽排序 | **已确认为真实缺陷并修复**（代码级 + 单测；未做真人拖拽，见 §8.2） | `src/utils/gifRotationOrder.ts`、`src/PetGifRotationSettings.tsx:120-126,325-334`、`src/PetGifRotationSettings.css:299-330`、`tests/gif-rotation-order.test.mjs`；commit `17b3541` |
| D5 | P2 体验 | **已按方案 A 修复**（岛内设置页就地改轮播 GIF，一个窗口）；含 1 处入口语义变化待产品确认，见 §8.4 | `src/App.tsx`（页签 2164-2177、LayoutEditor 2385-2418 与 2829-2836、`openStandaloneSettings` 7723-7742）、`src/App.css`（文末「岛内设置页」段）、`docs/pet-characters.md`；commit `17b3541` |

观察项未在本批处理：O1（`展开（N 张）/收起` 文案硬编码中文）保留原样——本批不夹带 i18n 重构；O2（右键删除无二次确认）为原设计，未改；O3（失焦自动收起）未改，D5 修好后从岛内入口不再触发该路径。

### 8.2 D4 的复现与修复说明

- **复现（代码级，与报告推断一致）**：`onDrop` 把落点下标直接传给 `reorder(from, to)`；`reorder` 先
  `splice(from,1)` 再 `splice(to,0,moved)`。向下拖（`from < to`）时移除后目标左移一位，实际插到目标
  **之后**，而 `is-drop-target::before` 的插入线永远画在目标格**左侧** → 视觉与结果相反。
- **修复方式**：语义统一为「占用落点格子的位置」——向上拖插到目标之前、向下拖插到目标之后；
  插入线跟着方向走（新增 `is-drop-target--after`，线画在目标格右侧）。下标换算抽成纯函数
  `movePetGifItem()`，便于单测。
- **验证**：新增 `tests/gif-rotation-order.test.mjs` 4 条用例（原地/越界返回同一数组、向上/向下/相邻
  拖动结果），`node --test` 58 → 62 全通过。**未做真人鼠标拖拽**：真实拖拽会写用户
  `localStorage["maltese-pet-gif-rotation:<角色>"]`，按任务约束不动用户数据；如需交互复核，
  建议在隔离 profile 下拖一次（从第 1 格拖到第 3 格，松手后应为「第 2 格、第 3 格(原第1格)…」且
  插入线在目标格右侧）。

### 8.3 验证输出

| 命令 | 结果 |
| --- | --- |
| `node node_modules\typescript\bin\tsc --noEmit` | exit 0 |
| `cd src-tauri; cargo check` | exit 0（仅既有 warning） |
| `node --test tests/*.test.mjs` | `tests 62 / pass 62 / fail 0`（原 58 + 新增 4） |
| `node_modules\.bin\vite.cmd build --target esnext --minify false` | exit 0（`index-b2bM0vrh.js` 2,271.68 kB、`index-Cb80sea5.css` 285.77 kB） |
| `node_modules\.bin\tauri.cmd build --ci --config src-tauri/tauri.release.conf.json --no-bundle` | exit 0（新 exe 实机自测，见 §8.5） |

### 8.4 D5 实现细节与待确认项

- **入口（方案 A）**：展开浮层顶部「设置」页签不再 `invoke("open_settings_window")`，改为切到岛内
  设置页（`LayoutEditor`）；该页「桌宠形态」小节之后内嵌**同一个** `PetGifRotationSettings` 组件
  （没有复制逻辑，`maltese-gif-settings-expanded` 折叠状态在两边共享）。格子 `auto-fill` 自适应列数，
  并限定岛内方格高 300px / 轮播范围预览 160px，浮层内不出现横向滚动条。
- **独立设置窗口保留**：`src/SettingsWindow.tsx:426` 的那份没动；入口改为岛内设置页右上
  「独立设置窗口」按钮、快捷入口页「设置」、托盘「配置桌宠」。从岛内/快捷入口打开时统一先收起
  浮层、再延迟 180ms 弹窗，避免两个窗口同时出现和抢焦点。
- **岛内设置页配色**：该页沿用旧深色玻璃面板的白字/控件配色，而浮层现在是白色云朵面板，原本是
  白字白底不可读（此前只在兜底路径出现，未被发现）。本次给 `.island__expanded .editor-panel`
  补了深色卡片底（`src/App.css` 文末），所有旧控件恢复可读。
- **⚠ 待产品确认（B1-01 入口语义）**：`docs/bug-acceptance-2026-11-17.md` B1-01 写的是「双击小狗 →
  顶部导航「设置」→ 出现独立窗口」。按 D5 的用户反馈，本次顶部「设置」改为**岛内设置页**，
  独立窗口入口、能力与前景行为（复用同一窗口、可重复打开）保持不变，只是从「页签直接弹窗」
  改成「页签 → 岛内设置页 → 右上『独立设置窗口』」。这是修复 D5 所需的产品取舍，**没有改验收
  文档**；若产品要求 B1-01 保持原样，可只把 `src/App.tsx:2169-2177` 的页签行为改回
  「先收起浮层再 `openStandaloneSettings()`」，其余改动不受影响。

### 8.5 实机自测（devfix identifier，未碰用户 profile）

- **构建**：`node_modules\.bin\tauri.cmd build --ci --config <临时 devfix 配置> --no-bundle`，临时把 identifier
  改成 `com.maolouis.maltese.devfix`，走全新 profile；跑完原 exe（SHA-256 `FE5DC5…D32075`）已还原并重启实例。
- **环境限制**：本机安全软件会拒绝「未安装路径上的新 exe」创建 AppData 下的 WebView2 profile
  （`Failed to setup app: 拒绝访问 (os error 5)`），所以新 exe 只能放进 `E:\Maltese2`（安装目录）才跑得起来；
  这不是产品缺陷。
- **已验证（UIA + 窗口矩形，截图在 `work/devfix*.png`）**：
  1. 展开浮层点顶部「设置」页签后：主窗口仍是同一个窗口（实测由展开态切到 `1204,1010,619,430` 的岛内设置页），
     **独立「桌宠设置」窗口不存在**（`standalone_settings_window=False`），本进程可见窗口数 **1** →
     不再出现「点一下闪出两个窗口」；
  2. 岛内设置页里能滚到「表情轮播」小节，按钮为 `展开（30 张）`；展开后 `pet-gif-settings__grid` 实测
     **6 列 / 宽 348px**，所有格子右边缘都在网格内（`TILES_OUTSIDE_GRID_RIGHT=0`）→ 浮层内无横向滚动条；
  3. 折叠按钮正常：点「收起」后格子元素数 30 → 0。
- **未完成（需人工复核，不作「通过」结论）**：
  - 拖拽排序 / 右键删除的**真实鼠标**交互：方格墙在页面下方，滚动后的合成鼠标拖动没有触发 HTML5 DnD、
    右键落点也不稳定；这两项目前只有代码级 + 单测证据（见 §8.2）。
  - 快捷入口页「设置」→「先收起浮层再开独立窗口」的整条 UI 流程：本轮脚本的合成点击先触发了悬停云朵，
    没能稳定打开快捷入口页；代码路径见 §8.4，建议人工点一次确认（预期：岛收回小狗槽后再出现设置窗口，
    不会两个大窗口同屏）。