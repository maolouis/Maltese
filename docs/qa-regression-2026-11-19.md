# 现状回归验证 · 2026-11-19（设置窗口 / Bongo 重点）

- 角色：QA（**只读**：EnumWindows/UIA 枚举、LevelDB 只读解析、DSH API 只读、日志与磁盘 json；**未重启 exe、未改代码/设置**）
- 仓库：`8a9df49`（工作区另有白底素材/文档等未提交改动，与本次验证无关）
- 实装：`E:\Maltese2\maltese-assistant.exe` **2.0.3**，29,917,696 B，构建 **15:30:56**（验证期间未变）
- 应用实例：15:34:14 启动（pid 3308，dev 脚本以 stderr 重定向到 `work/sleep-evidence3.log`）；**15:36:28 被研发重启为 pid 31684**（无 stderr 重定向）。本报告快照时间 **15:34:29 / 15:34:59 / 15:37:10 / 15:37:56 / 15:39:07**。
- 屏幕：DISPLAY1 `-1920..0`（1920×1080，work 高 1032，副屏）；DISPLAY2 `0..2560`（2560×1440，work 高 1392，主屏）。
- 当前设置（LevelDB 只读，写入时间 15:34:11）：`bongoEnabled=true`、`petCount=1`、`petLinkage=false`、
  `islandScreen="\\.\DISPLAY1|1920x1080@-1920,0"`、`bongoScreen="follow"`、`fullscreenHideBongo=false`。

---

## 1. 逐项结论

| # | 项目 | 结论 | 证据 / 原因 |
| --- | --- | --- | --- |
| 1 | 启动：主岛可见 | **通过** | EnumWindows：`class='Tauri Window' title='Maltese 线条小狗桌面助手' vis=True rect=-1090,803,259,221`（15:37:10）；进程 `Responding=True`；UIA 能枚举到 `Button '待办：深度学习课本' class='maltese-pet maltese-pet--large' rect=-1090,803,260,221` |
| 2 | 启动：位置符合设置 | **通过** | 主岛在 DISPLAY1（x=-1090 为负，副屏）；与 `islandScreen` 指纹所在屏一致；15:37:56 快照变为 `-1090,544,727,480`（被用户/测试展开，仍在同一屏） |
| 3 | 窗口：设置窗口能开 | **未判定（只读无法确认点击开窗；存在风险）** | 4 次 EnumWindows 均**没有** `title='Maltese · 桌宠设置'` 的 Tauri 窗口；但 15:34 实例 stderr 有 `settings window ready in 12.1492ms (created: true, already visible: false)` 与 `188.9µs (created: true...)` → `open_settings_window` 在该实例**曾成功创建并显示**。当前实例无窗口只说明"未打开"。需授权后点一次并抓 stderr/`Chrome_WidgetWin_0` 是否为 0×0（见 §3 P1-1） |
| 4 | 窗口：插件窗口 | **未验证** | 只读模式下不打开插件；无该窗口现有实例 |
| 5 | 窗口：固定标签页（📌，任务栏无灰框） | **未验证** | 只读；当前无 pinned 窗口（15:34 实例的窗口列表里也没有） |
| 6 | 窗口：气泡（展开态提示行 / 收起态云朵） | **未验证（有日志旁证）** | 15:34 实例 stderr 出现 `overlay open (cloud): anchor=(-259,796) -> rect=(-567,617) 567.0x400.0`、`overlay closed: restored rect Some((-259,796))` → 云朵几何路径可用；未实测 UI |
| 7 | Bongo：开关打开后出现 | **失败** | 设置 `bongoEnabled=true`、`bongoScreen=follow`、主岛在 DISPLAY1；**4 次 EnumWindows（含隐藏窗口）均无 Bongo 窗口**（无 `Tauri Window`、无 280×228 尺寸、无 `title=''` 的额外 Tauri window；只有主岛 + `tray_icon_app`/IME/16×16 辅助窗口）。UIA 同样只枚举到主岛。**复现：启动后 40s+ 仍无 Bongo** |
| 8 | Bongo：位置跟随 / 重启后仍在正确屏幕 | **未验证（无窗口可验）** | 同 #7；15:34 实例 stderr 有 `[monitor] extras sync bongo monitor=\\.\DISPLAY1|1920x1080@-1920,0 rect=(-1896,804,280,228) prefer=follow` —— 该实例在某个时刻确实创建/显示过 Bongo（说明"曾经能用"），但**启动自动路径在本次快照内没有产出窗口** |
| 9 | 陪玩狗 | **不适用** | `petCount=1`，按设计不创建 companion-* |
| 10 | 多屏：切副屏/切回、拔屏降级、右键/悬停不跨屏 | **未验证（只读）** | 仅确认当前在副屏（负 x）；无交互。15:34 实例 stderr 有 `OVERLAY_MONITOR_CLAMP` / `OVERLAY_SLOT_CORRECT dx=727` 记录，说明展开页曾发生跨屏夹取（需实测判定是否符合预期） |
| 11 | 聊天：发消息出回复 / 状态栏 / 表情包 / 停止 | **未验证（只读未发送）** | 未发消息；旁证：`maltese-pet-vitals` 存在（energy 16.01 / mood 20.09 / bond 67.10 / focus 0.0039，today count 有 chat 5 次）→ 状态栏有数据源 |
| 12 | 视频：开始→采真实视频→停止→小结非空 | **未验证全量（未授权实机）** | 只读 DSH API 当前 `phase=idle`、`channel=windowTitle/basic`（未启动浏览器）、`pendingCount=1`（**已有 1 份待投递小结**）、`commentDryRun=true`；磁盘 `sessions/2026-11` 有 11/19 10:12 会话。历史条目 `canonicalUrl` 仍是 `https://www.bilibili.com/`（首页）问题延续，待实机全量确认 |
| 13 | 视频：历史 0 条给原因 | **未验证** | 只读；`video\logs\` 仅有 `video-20261117.jsonl`（4 条错误），本次未产生新日志 |
| 14 | Agent：控制台页签 / 列表 / 聚焦 | **未验证（只读）** | 未操作；静态：`%APPDATA%\com.maolouis.maltese\agent-hub\config.json` 存在（2,711 B，15:28:33）→ 有配置数据 |
| 15 | 健康：tsc / cargo check / node --test | **部分通过** | `tsc --noEmit` = **exit 0**；`node --test tests/*.test.mjs` = **250 pass / 0 fail**；`cargo check` **未执行**（研发占用构建/安装目录，等授权） |

---

## 2. 重点：Bongo 失败证据（原文）

**设置（只读）**：`bongoEnabled=true`，`bongoScreen="follow"`，`petCount=1`，`islandScreen="\\.\DISPLAY1|1920x1080@-1920,0"`。

**EnumWindows（含隐藏窗口，按 pid 过滤）**：

```
15:34:29 pid=3308: 只有
  hwnd=0x400AC2 vis=True  rect=-259,796,259,221 title='Maltese 线条小狗桌面助手' class='Tauri Window'
  hwnd=0x38192A vis=False rect=104,104,1920,1023 class='tray_icon_app'
  hwnd=0x881AAC vis=False class='FocuSDWeChatReminderSource'
  hwnd=0xC51900/0x2C0D84 vis=True rect=0,0,16,16（16×16 辅助窗口）
15:34:59 / 15:37:10 / 15:37:56 / 15:39:07  pid=31684: 同样只有主岛窗口
  hwnd=0x5C01DE vis=True rect=-1090,803,259,221（后变为 -1090,544,727,480）
```

→ 没有第二个 `Tauri Window`（Bongo 正常应为 `Tauri Window`、约 280×228、`title=''`、`vis=True`）。

**UIA**：主窗口 `Descendants` 只包含 WebView2/主岛树（`stage` → `island--collapsed` → `Button '待办：…'`），
没有任何 `bongo-pet` 窗口元素；CDP `/json/list`（15:36 前实例）只有 1 个 `tauri.localhost` 页面（主窗）。

**旁证（15:34 实例 stderr，dev 脚本重定向文件）**：
```
[monitor] extras sync bongo monitor=\\.\DISPLAY1|1920x1080@-1920,0 rect=(-1896,804,280,228) prefer=follow
...
settings window ready in 12.1492ms (created: true, already visible: false)
```
→ 同一构建（15:30:56）在 15:34 实例里，Bongo 与设置窗口**至少成功出现过一次**（由用户/测试动作触发）；因此"显示不了"更像**启动自动同步路径失效或创建被静默吞掉**，而不是永远创建不出来。

---

## 3. 研发修复清单（按优先级）

**P0-1（Bongo 启动不显示）**
- 复现：`bongoEnabled=true`、`bongoScreen=follow`，主岛在副屏；正常启动，40s+ 后 EnumWindows 无 Bongo 窗口。
- 断点候选（按可疑度）：
  1. 前端 `App.tsx:6031-6058` `invoke("sync_desktop_extras", …)` 失败被 **`.catch(() => undefined)` 静默吞掉** → Bongo 不会创建也无提示；
  2. 启动时 Rust `setup` 的 1s/3s/6s `sync_extras_now`（`lib.rs:5675` 附近）在 `LAST_CONFIG` 为 `None`（重启后内存态）时用什么配置？若用默认（bongo=false）→ 不创建，必须等前端 invoke；
  3. `desktop_extras::sync_bongo` / `window_factory::ensure_if_known`（`desktop_extras.rs`、`window_factory.rs:255-265`）创建失败只 `eprintln!`；当前实例 stderr 未重定向，看不到；
  4. `6d2423d` 屏解析/重同步改动可能引入回归（Bongo 跟随实际屏的三级解析）。
- 建议：启动后用 `-RedirectStandardError work/boot.log` 跑一次，查 `[monitor] extras sync bongo` 是否出现、是否有 `failed to create window bongo-pet`；前端 invoke 失败加 `console.error` + 重试；Rust 启动同步给显式 fallback（读持久化设置或报错）。

**P1-1（设置窗口"显示不了"待复测）**
- 现象：当前快照无设置窗口 HWND；但 stderr 证明 `open_settings_window` 可以成功（12ms created）。
- 需授权后实测：点一次「设置」→ 看窗口是否出现；失败时抓 stderr 与子窗口 `Chrome_WidgetWin_0` 是否 0×0。
- 已知风险：`window_factory.rs:241-247` 注释明确：**主线程同步创建 WebView2 会 HWND 存在但不可见/0×0，表现为"窗口打不开"**。请确认新增的窗口创建调用是否在主线程（应走 async 命令 / `spawn_blocking`）。

**P1-2（前端静默失败）**
- `sync_desktop_extras`、`open_settings_window`、`set_monitor_preferences` 等 invoke 失败都 `.catch(() => undefined)`；至少对窗口类命令记录错误并提示用户。

**P2（视频延续项）**
- DSH API 显示 `pendingCount=1` 但 `itemCount=0`；历史 `canonicalUrl` 仍为首页。等实机全量时按 `docs/regression-checklist.md` §6 重验，并继续跟踪 17959cd 之后是否回归。

---

## 4. 环境说明

- 验证期间研发在活动：15:34:14 实例 → 15:36:28 重启（pid 31684），15:37:56 / 15:39:07 主岛又被交互（展开 727×430）；**QA 没有重启 exe、没有改任何设置**。
- 当前实例 stderr 未重定向，无法看到 `[monitor]`/`window_factory` 日志；这是 Bongo 断点无法进一步收口的直接原因（需研发按 §3 加日志后再跑一轮）。
- 本次未做完整实机（点设置/开 Bongo/聊天/视频），按 lead 要求等授权后再跑全量；`docs/regression-checklist.md` 已给出可执行步骤。
- 健康检查：`tsc` exit 0、`node --test` 250/250；`cargo check` 未跑（研发占用构建）。

## 5. 结论

- **Bongo：失败（P0）** —— 设置在开、屏幕设置正确，启动后无 Bongo 窗口（窗口级证据充分）。
- **设置窗口：未判定（P1）** —— 只读无法证明"打不开"；同构建日志证明曾成功打开，需要一次实机点击 + stderr 证据收口。
- 其余项目未验证（未授权实机 / 只读限制），健康项除 `cargo check` 外通过。
- 交付：**当前不可交付**；先修 P0-1（Bongo），并按 §3 复测设置窗口。清单与报告已落盘，授权后按 `docs/regression-checklist.md` 跑全量并回填。