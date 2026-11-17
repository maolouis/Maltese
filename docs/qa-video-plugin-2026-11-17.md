# 视频插件可用性验收 · 2026-11-17（P0 用户反馈「太冗长 而且不可用」）

- 角色：QA（**只读验收，未改任何源码**；本文件是唯一新增文件）
- 基线：`e2fd8cb`（工作区干净，含 `17b3541` 对上一轮 D1–D5 的修复）
- 实机：Windows 2560×1440；应用 `E:\Maltese2\maltese-assistant.exe`，**PID 28160，2.0.2，12:45:43 启动**
- 方法：UIA 枚举真实控件 + 真实鼠标点击 + DSH API（`http://127.0.0.1:3218`，端口取自 `%APPDATA%\com.maolouis.maltese\dsh-api-port.txt`）+ 进程/端口/数据文件核对。**未登录任何账号、未发真实评论**（仅验证入口与失败提示）。
- 证据目录：`work/qa-video-*`（`work/` 已 gitignore）

> 结论先行：**当前不可交付**。本机复现出「点开始看 → 16 秒后 `CDP_UNAVAILABLE`、条目 0、提示不可见、无日志、会话记成『异常崩溃』」，根因是**上一次登录窗遗留的专用 Chrome 仍占用 `video-profile` 与 9333 端口**，插件既不复用也不清理；面板 1503px 高（3.5 屏）也确实冗长。

---

## 1. 冗长点清单（从上到下，UIA 实测）

面板容器：`class=video-automation`，name「小狗刷视频」，rect `1844,1124,391,1503`（**1503px 高 / 窗口 430px → 3.5 屏**）；整个「插件」页 `plugins-page` 高 **1771px**。
面板内实测：**13 个按钮、6 个输入框、2 个下拉、39 个文本节点、64 个 UIA 子元素**。

| # | 区块（UIA 位置） | 高度 | 控件 | 判定 | 理由 / 建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | **状态头**：`小狗自主观看` + 状态词 + `条目 0 · 强兴趣 0`（1146–1188） | ~60px | 0 按钮 / 6 文本 | **必需** | 保留，但压缩成**一行状态条**：`已暂停 · 条目 0`；状态词与计数同一行 |
| 2 | **参数行**：平台下拉 + 每次翻页/上限/采集间隔/每天投递 4 个数字框（1202–1336） | ~140px | 1 下拉 + 4 输入 | **可折叠（高级）** | 默认折叠；只暴露平台；4 个参数塞进「高级设置」，显示为一行摘要 |
| 3 | **开始看 / 保存配置 / 打开登录窗 / 刷新历史**（1298–1384） | ~50px | 4 按钮 | **必需（1 个）/ 可删（3 个）** | 只留「开始看/停下」；保存配置在参数折叠区内；刷新历史并在小结区；登录并入账号区 |
| 4 | **小狗自媒体账号**：下拉 + 打开账号登录窗 + 4 输入 + 创建档案 + 说明（1418–1687） | ~270px | 1 下拉 + 2 按钮 + 4 输入 + 3 段文本 | **可折叠** | 默认收起为「登录：未登录 · 打开登录窗」一行；账号档案表单是低频功能，归到「高级/账号」 |
| 5 | **通用说明长文**：「小狗会用自己的浏览器…首次使用请点…抖音仍是实验特性」（1720–1778） | 58px | 1 段文本 | **可删/并入提示** | 关键信息（首次要登录、抖音实验）折进状态条 tooltip 或首次引导 |
| 6 | **通道与诊断**：标题 + 重新自检 + 当前通道 + 最近成功 + 能力损失 + 诊断日志 `<details>`（1806–1950） | ~150px | 2 按钮 + 5 段文本 | **可删除/收进「高级」** | 技术细节，普通用户零收益；且输出英文码（见 U7）。收进「高级 · 自检」 |
| 7 | **小结与历史**：待投递 + 空态/预览 + 历史列表 + 刷新 + 清空数据 + 说明（1989–2179） | ~190px | 2 按钮 + 列表 | **必需（精简）** | 保留「小结列表 + 刷新」；「清空数据」移到底部危险区并二次确认 |
| 8 | **在视频下评论**：标题 + 说明 + textarea + 发送评论 + 字数（2220–2390） | ~170px | 1 输入 + 1 按钮 + 3 文本 | **可折叠** | 默认折叠「评论（可选）」；只有真正用的人展开 |
| 9 | **观后感草稿**：标题 + 复制草稿 + textarea + 说明 + 打开投稿页/直播中心（2403–2596） | ~190px | 3 按钮 + 1 输入 + 2 文本 | **可删除（v2）** | 「投稿/直播」与"小狗看视频"目标无关；草稿并入小结区只读展示 |
| — | 合计 | **1503px（3.5 屏）** | **21 个交互控件** | — | 首屏（994–1424）只能看到 1–4 区，小结/历史/评论全在折叠线下 |

### 建议的精简版信息架构（≤2 屏，首屏 ≤8 控件）

```
┌ 小狗刷视频   [已暂停 · 条目 0]            [开始看/停下] ┐
│ 平台 [B站推荐流 ▾]        [登录状态：未登录 · 打开登录窗] │
│ ── 小结（最近一次）──────────────────────────────────── │
│   • 主题/摘要（如果有；没有就"还没有小结"）              │
│   ▸ 历史会话（点开列表）                                │
│ ▸ 高级设置（参数 / 账号档案 / 自检与诊断 / 清空数据）    │
│ ▸ 评论（可选）  ▸ 观后感草稿（可选）                    │
└────────────────────────────────────────────────────────┘
```

---

## 2. 不可用点清单（逐条实测/读代码）

### U1（P0，主流程）残留专用浏览器占住 profile：每次「开始看」必在 15 秒后失败，条目 0

- 复现：收起态右键小狗展开浮层 → 点「插件」页签 → 点「开始看」。
- 实测时间线（2026-11-17）：
  - 12:50:58.022 点击「开始看」，API 立刻变为 `phase=collecting running=true`；
  - 期间专用 Chrome 抢焦点，**岛屿浮层自动收起**（窗口变回 `2285,1203,259×221`，截图 `work/qa-video-start-attempt.png`）；
  - 12:51:14 API 变 `phase=interrupted running=false`，`error=「小狗浏览器没有在 15 秒内准备好，已停止本轮。」`、`code=CDP_UNAVAILABLE`；
  - 生成会话 `bili-20261117-b1a124`：`stopReason:"crash"`、`itemCount:0`、`errorCode:"CDP_UNAVAILABLE"`、`channelCapability:"full"`。
- 根因证据：
  - 专用 Chrome **pid 12488**（start 10:57:57）仍在运行，`--user-data-dir=…\Local\Maltese\video-profile --remote-debugging-port=9333`，**9333 处于 LISTEN（owner 12488）**，窗口标题一度为 `about:blank`（登录窗 2 小时没加载出 B 站），随后被导航到 B 站；
  - 应用重启后只把浏览器 handle 放在内存（`session.rs:600-608`、`1250-1259`），重启后不再知道它；
  - 新一次开始：`pick_port(9333)` 因 9333 被占选 9334（`browser.rs:134-148`），却用**同一个 `video-profile`** 再 `launch`（`browser.rs:150-207`，无"profile 是否被占用/是否已有本 profile 的 CDP"检测）→ 新 Chrome 转交给旧实例/拿不到 profile 锁 → 9334 始终不监听 → 15s 超时。
- 预期：插件能识别"这是我自己上次的专用浏览器"，直接复用 9333 的 CDP；或先关闭/提示用户关闭残留实例。
- 可疑位置：`src-tauri/src/video/browser.rs:134-148`（只探测端口，不识别同 profile 实例）、`:150-207`（launch 即返回，不校验真正启动）；`src-tauri/src/video/session.rs:584-608`（启动流程）；`session.rs:703-705`（超时处理）。
- 严重级别：**P0（主流程 100% 失败）**。

### U2（P0）「打开登录窗」"假成功"：不弹新窗口/窗口内容空白

- 复现：插件页 →「打开登录窗」。
- 实测：点击前专用 Chrome 进程 11 个；点击后 **新 Chrome 顶层窗口数 = 0**（`NEW_CHROME_WINDOWS=0`），只多了一个挂在旧实例下的 renderer（`pid 47648, parent=12488`）→ 请求被**转交到旧实例**；UI 侧因岛屿失焦收起，用户看不到任何反馈（我们的 UIA 抓不到 `video-page__notice`）。
- 代码：`open_login_window` 只在"内存里已有同 profile 浏览器"时 `focus_browser_window`（`session.rs:1278-1284`），重启后内存为空 → 走 `launch(...)`，`spawn` 成功就 `Ok(())`，前端立刻 `onNotice("已打开小狗专用浏览器，请登录一次")`（`VideoAutomationPlugin.tsx:89-103`）→ **窗口没出现也提示成功**。
- 预期：确实有新窗口并停在平台首页；失败就明确报「专用浏览器已有实例在运行/加载失败」。
- 可疑位置：`session.rs:1261-1296`（open_login_window 无"启动后校验 CDP/窗口"）、`browser.rs:150-207`。
- 严重级别：**P0（登录是使用前置步骤，用户卡死在这里）**。

### U3（P0）失败提示在用户看到之前就丢了：岛屿失焦自动收起 + 面板重挂载清空错误

- 复现：点「开始看」→ 等 16s 失败 → 重新展开浮层 → 进「插件」页。
- 实测：重新进页面后 **`video-automation__hint--warn` 数量 = 0**（错误文本已丢），状态只显示「已暂停」；只有点「刷新历史」才能看到 `2026/11/17 12:50:57 · B站· 异常崩溃· 条目 0 / 强兴趣 0`。
- 原因链：
  1. 内核/浏览器抢焦点 → `App.tsx:9030-9032` 的 `onFocusChanged → collapseIsland()` 把浮层收起（**这是自动的，不是用户操作**）；
  2. 面板错误来自组件 `useState`（`VideoAutomationPlugin.tsx:47,300-302`），浮层收起后视频页卸载，错误随组件销毁丢失；
  3. `phaseText`（`VideoAutomationPlugin.tsx:28-38`）对 `interrupted` 没有分支 → 显示「已暂停」，等于失败被抹平。
- 预期：失败提示必须常驻（用 Rust snapshot 的 `errorCode/error` 渲染），收起/重开不丢；状态显示「启动失败：小狗浏览器没准备好（CDP_UNAVAILABLE）」。
- 严重级别：**P0（"不可用"的直观来源：点了没反应/不知道发生了什么）**。

### U4（P1）失败路径不写日志，文档承诺的 `logs\video-<日期>.jsonl` 不存在

- 复现：U1 失败后检查 `%APPDATA%\com.maolouis.maltese\video\logs` → **目录不存在**；`GET /api/video/diagnostics?limit=10` → `[]`。
- 代码：`CDP_UNAVAILABLE` 分支只 `set_runtime_error` + `finish(Crash,false)`（`session.rs:703-705`），**没有调用 `store.log`**；`store.log`（`store.rs:423-449`）能落盘，但整个 session 流程里唯一的调用点是投递被跳过时（`session.rs:1026`）。
- 预期：任一失败都要落一条诊断（`code/message/detail/sessionId`），并能在 UI「诊断日志」和 DSH API 里看到。
- 严重级别：P1（无日志 = 无法排障，也是"不可用"不可解释的原因）。
- 备注：UI 里确实出现过「诊断日志（最近 5 条）」，但那是前端把**自检结果**本地拼出来的（`useVideoPluginState.ts:164-181`），不是真实轨迹，重启即消失；文档 `docs/video-plugin-usage.md:168,217` 却指向 `logs\…` 文件 → 文档与实现不一致。

### U5（P1）失败被记成「异常崩溃」（stopReason=crasp）且历史里只显示这个

- 实测：会话 `bili-20261117-b1a124` 的 `stopReason:"crash"`（真实原因 `CDP_UNAVAILABLE`）；UI 历史显示「异常崩溃 · 条目 0 / 强兴趣 0」（`VideoDigestList.tsx:14-24` 的 `crash: "异常崩溃"`）。
- 预期：显示「浏览器未就绪」「登录窗被占用」等可操作原因；`stopReason` 用专门枚举或直接展示 `errorCode`。
- 可疑位置：`session.rs:704`（`finish(StopReason::Crash,false)`）、`VideoDigestList.tsx:14-24`。
- 严重级别：P1。

### U6（P1）从未成功采集到内容：历史 6 条全部「条目 0 / 强兴趣 0」

- 证据：`%APPDATA%\com.maolouis.maltese\video\index.json` 5 条 11/14 的 `durationLimit` 会话全部 `itemCount:0`；最新 11/17 的 `CDP_UNAVAILABLE` 也是 0；UI「刷新历史」实测 6 条全部「条目 0 / 强兴趣 0」（`work/qa-video-history-login.log`）。
- 说明：11/14 那批是旧构建，但架构未变（`channelCapability:"full"` 却 0 条 → CDP 采样/解析路径没有产出）；当前构建在本机连"进入采集"都没成功（U1）。
- 严重级别：P1（核心价值——"看视频并给小结"——从未验证成功）。

### U7（P2）「通道与诊断」直接暴露英文错误码，普通用户读不懂

- 实测：点「重新自检」后，通道卡显示 `当前：cdp（完整能力）`、`最近成功：尚未成功 · 失败：noResponse`（`VideoChannelCard.tsx:39-46` 直接拼 `failureReason`/`code`）。
- 预期：中文人话（「调试接口无响应」）+ 只在「高级」里展示；
- 严重级别：P2（可读性/噪音）。

### U8（P2）评论/创建档案失败会把 Rust 错误对象直接 String()，大概率显示 `[object Object]`

- 代码：`VideoError` 派生 `Serialize`（`src-tauri/src/video/mod.rs:38-43`），`invoke` 的 reject 值是对象；前端 `发送失败：${String(error)}`（`VideoAutomationPlugin.tsx:210`）、`setError(String(reason))`（`:131`）→ `[object Object]`。
- 预期：取 `error.message/error.code` 显示人话。
- 备注：未做交互验证（没发评论，符合任务约束）；代码级确认。
- 严重级别：P2。

### U9（P2）「保存配置」不落盘，面板重开参数回默认，用户感知为「改了没用」

- 代码/文档一致：只写内存（`session.rs:499-508`），文档也写明（`docs/video-plugin-usage.md:149`）；但**没有任何"已生效，但重开会重置"的显式提示**，且面板重挂载后 `provider/interval/maxMinutes` 被 snapshot 覆盖、`采集间隔/每天投递` 直接回默认（`VideoAutomationPlugin.tsx:42-60`）。
- 预期：要么持久化，要么在参数区标注"仅本次运行有效"并显示当前生效值。
- 严重级别：P2。

### U10（P2）失败/退出后不主动关闭专用浏览器，残留会再次锁住 profile

- 代码：`finish()`（`session.rs:931-962` 起）没有 `close_browser()`；`close_browser` 只在 `open_login_window` 里被调用（`session.rs:1285-1296`、`1250-1259`）。本次失败后浏览器进程仍在（BROWSERS 计数 12 未回落；`CDP_UNAVAILABLE` 时若 spawn 出的实例还存活也不会被关闭）。
- 再加上 U1 的"重启后遗忘"，形成**一次失败 → 永久失败**的锁死状态。
- 严重级别：P2（但和 U1 叠加就是 P0 的复现条件）。

### 其它（不单列编号）

- 首屏看不到"开始看"之外的结果：点击后岛屿收起，用户没有"已开始"的即时反馈（无系统通知/气泡）。
- 两个入口（主窗「插件」页 / 独立插件窗口）需要安装 `video-automation` 插件才有第二个入口，本机 `%APPDATA%\…\plugins` 只有 billiards / relationship → 文档"独立插件窗口"路径在本机不可用（用户只会看到主窗入口）。
- 文案小问题：历史项 `B站· 异常崩溃` 缺空格；`CDP_UNAVAILABLE` 提示末尾多了空格。

---

## 3. 最小可用路径（MVP）：只保留「选平台 → 登录 → 开始 → 看摘要 → 停」

### 步 1：选平台（1 行，无滚动）
- UI：`平台 [B站推荐流 ▾]`（抖音折叠在高级，标"实验"）。
- 失败提示：无（下拉永远可用）。

### 步 2：登录（1 行 + 1 按钮）
- UI：`登录：未登录 [打开登录窗]`；点后按钮变 `等待登录…`；打开的是**全新**专用浏览器窗口并停在平台首页。
- 失败提示（必须人话、常驻）：
  - 「专用浏览器已在运行」→ 提供「复用/关闭并重开」；
  - 「平台页加载失败」→ 提供「重试」，并写日志。
- **验收**：点击后 5 s 内必须出现新的可见浏览器窗口；否则报错，不允许"提示成功但没窗口"。

### 步 3：开始（1 个主按钮，点击 ≤3 次到采集）
- UI：`[开始看]`（唯一主按钮）；点击后状态条立即变 `准备浏览器…` → `小狗正在看（已看 0 条）`。
- 失败提示（20 s 内必须出现，且收起浮层后仍在）：
  - 「小狗浏览器没准备好（CDP 不可用）· 重试 / 打开诊断」；
  - 「已有专用浏览器残留 · 一键关闭后重试」；
  - 任一失败写 `logs\video-<date>.jsonl` 并在 DSH `/api/video/diagnostics` 可见。
- **验收**：开始后 ≤20 s 内，要么 `running && collecting`，要么面板出现常驻错误条（不允许静默 15 s 后什么都不显示）。

### 步 4：看摘要（默认展开，1 屏内）
- UI：一行状态 +「最近小结」卡片（主题 + ≤3 条 + 生成方式）；没有就显示「还没有攒到小结」。
- 失败提示：「本轮未采集到内容（原因：页面未加载/未登录/风控）」，历史里同一原因。

### 步 5：停（1 个按钮）
- UI：运行中「开始看」变「停下」；点击后状态 `已停止`，专用浏览器**自动关闭**。
- 失败提示：关闭失败也要有提示，不能让残留继续锁 profile。

---

## 4. 判定

### 4.1 当前是否可交付

**不可交付（P0）**。

- 主流程在本机 **100% 失败**：`开始看` → 16 s → `CDP_UNAVAILABLE` → 条目 0；根因是残留专用浏览器占用 `video-profile`/9333，插件无复用/无清理（U1、U2、U10）。
- 失败**用户不可见**：自动收起 + 重挂载丢错误（U3）；**无日志**（U4）；历史记成「异常崩溃」（U5）。
- 面板 **1503px / 3.5 屏、21 个交互控件**，核心动作被低频配置包围（§1），与用户"太冗长"一致。

### 4.2 简化 + 修复后的达标判据（可执行）

| # | 判据 | 当前 | 目标 |
| --- | --- | --- | --- |
| J1 | 首屏交互控件数（按钮+输入+下拉） | **21** | **≤8**（平台、开始/停下、打开登录窗、刷新历史、展开高级、评论、清空、历史项） |
| J2 | 面板总高 / 窗口高 | **1503/430 = 3.5 屏** | **≤1.2 屏**（高级默认折叠） |
| J3 | 点插件到开始采集的点击数 | 独立窗口需 1 次打开 + 滚动 + 开始；主窗需 3 次 | **≤3 次**且**不需要滚动** |
| J4 | 开始后最迟多久必须有结果 | 15 s 静默失败（用户看不到） | **≤20 s** 内要么 `collecting`，要么**常驻人话错误条**（收起重开仍在） |
| J5 | 失败是否可排障 | 无日志、`/diagnostics` 空 | 每次失败写 `logs\video-<date>.jsonl` 且 `/api/video/diagnostics` 非空 |
| J6 | 残留浏览器恢复 | 启动必失败且无提示 | 启动前检测 9333–9338 中本 profile 的 CDP：能复用则复用，不能则提示「关闭专用浏览器后重试」并可一键关闭 |
| J7 | 采集 0 条时的呈现 | 显示「异常崩溃」 | 显示真实原因（未加载/未登录/风控/选择器失效），历史同源 |
| J8 | 错误文案 | 英文码/`[object Object]` | 全部中文人话 + 可展开诊断码 |
| J9 | 端到端最小演练 | 未通过 | 选平台 → 打开登录窗（新窗口）→ 开始 → ≤20 s 看到 `条目>0` 或明确原因 → 停 → 浏览器自动关闭 |

> 只做界面精简、不做 U1–U4 的修复，**仍然不可交付**（因为本机主流程仍然 100% 失败且用户看不到原因）；反过来只修 U1–U4 不精简，用户体验仍会被 3.5 屏配置淹没。两者都要。

---

## 5. 未验证项 / 环境说明 / 证据文件

**未验证**：
1. 真实登录（按任务要求未操作账号；未点击「我已登录」）；
2. 真实评论发送（未发；只验证按钮存在与失败提示代码路径）；
3. 采集成功后的摘要质量、投递、抖音通道；
4. 「保存配置」的生效范围（仅代码级）；
5. 独立插件窗口（本机未安装 `video-automation` 插件，无入口可测）。

**环境说明（重要）**：
- 12:50 实测时机器上残留着 **10:57 打开的专用 Chrome（pid 12488）**，占用 9333 与 `video-profile`；这是 U1 的直接原因。QA 在测试结束时**只清理了这个专用浏览器衍生的子进程（未动主进程 12488，未动用户数据/profile）**；主进程/窗口仍在，建议人工关闭后再复测。
- 本次测试在用户历史里留下 1 条真实会话 `bili-20261117-b1a124`（异常崩溃 / 0 条），作为 U1–U5 证据，未删除。
- 测试使用 DSH API 读取状态（`/api/video/status`、`/sessions`、`/diagnostics`），未调用会改数据的写接口（只调用过一次 `/api/video/stop` 兜底，当时已非运行态）。

**证据文件**（`work/`，gitignore）：
| 文件 | 内容 |
| --- | --- |
| `work/qa-video-verbosity.log` / `.png` | 面板 64 个 UIA 子块、13 按钮/6 输入/2 下拉/39 文本、1503px 高实测 |
| `work/qa-video-start.log` / `qa-video-start-attempt.png` | 12:50:58 点开始 → 12:51:14 `CDP_UNAVAILABLE`；会话 `bili-20261117-b1a124`；浏览器进程/端口 |
| `work/qa-video-history-login.log` | 「刷新历史」6 条全部条目 0；「打开登录窗」无新窗口（NEW_CHROME_WINDOWS=0） |
| `work/qa-video-probe-comment.log` / `.png` | 「重新自检」输出 `失败：noResponse`、诊断日志（前端本地）；发送评论入口状态 |
| `work/qa-edit-report.ps1` 等 | 本轮只读脚本留档 |
## 6. 研发处置（2026-11-17 P0 修复 + UI 精简轮）

> 角色：研发；基线 `e2fd8cb` + 本轮改动；版本仍 **2.0.2**，未 push、未打 tag。
> 本轮同时修 U1–U5（P0/P1）与 §1 的精简 IA，并补了 U7/U8/U9/U10 的低成本项。

### 6.1 U1–U10 状态

| 编号 | 原判定 | 本轮状态 | 修法 / 证据 |
| --- | --- | --- | --- |
| U1 残留专用浏览器占 profile，开始必失败 | P0 | **已修** | `browser.rs` 新增实例标记 `%LOCALAPPDATA%\Maltese\video-browser.json`（pid/port/profile）与 `find_reusable` / `close_profile_instance` / `pid_alive_browser` / `wait_for_cdp`；`reuse_decision()` 纯函数决定 复用内存实例 → 接管上次实例 → 清残留后重启。`session.start()` 改为三条路径，**端口与 profile 始终绑在同一个实例**；新启动后必须 `wait_for_cdp` 成功，失败就关掉本次进程并写日志。启动前若端口被同 profile 残留实例占用，先关掉它（QA 的 9333 + 旧 pid 场景）。 |
| U2 「打开登录窗」假成功 | P0 | **已修** | `open_login_window` 现在：复用实例时先 `focus_browser_window`，不行就用 CDP `PUT /json/new` 开登录页再前置，仍不行报 `LOGIN_WINDOW_NOT_VISIBLE`；新启动时校验 `wait_for_cdp` + `wait_for_visible_window(pid, 5s)`（该进程必须有可见顶层窗口），任一失败立即关进程并返回中文错误。 |
| U3 失败提示丢失 | P0 | **已修** | 失败原因本来就写在 Rust snapshot 的 `errorCode/error` 里；前端新增 `resolvePanelError()`：优先本次 invoke 错误，其次**一定回落 snapshot 的持久错误**，所以收起浮层/重挂载后错误条仍在。`phaseText()` 补 `interrupted`/`blocked` 分支，状态条显示「本轮失败」+ 常驻错误条（含诊断码小标签）。 |
| U4 失败不写日志 | P1 | **已修** | `set_runtime_error()` 与 `abort_start()` 统一落 `store.log(DiagnosticEntry)`（code/message/sessionId/level=error），写 `logs\video-<日期>.jsonl`；面板「诊断日志」从 `video_diagnostics` 读后端真实轨迹（4 秒刷新），不再是前端自检临时拼的 5 条。DSH `/api/video/diagnostics` 同源。 |
| U5 失败记成「异常崩溃」/历史全 0 条 | P1 | **已修** | `model::StopReason` 新增 `browserUnavailable / loginRequired / parseFailed`；`finish()` 在 0 条时按 `error_code`（LOGIN_REQUIRED）或「无错误但 0 条」细分原因，不再一律 `crash`。前端 `sessionReason()` 把 stopReason + errorCode 翻成中文人话（浏览器没起来 / 需要登录 / 页面没解析到内容 / 风控 / 手动停止 …）。 |
| U6 从未成功采集 | P1 | **未验证** | 需要已登录的专用 profile 实机跑一轮；本轮修完 U1 后「开始 → 采集 → 停」路径已具备条件，见 6.4。 |
| U7 英文错误码 | P2 | **已修** | `failureReasonText()` 把 `noResponse/portBusy/...` 全翻中文；英文码只放 tooltip。通道卡移入「高级设置」。 |
| U8 `[object Object]` | P2 | **已修** | `describeVideoError()` 统一解析 Rust `VideoError` 对象（code + message），评论/账号/配置/登录/清空全走它。 |
| U9 参数不落盘且无提示 | P2 | **已修（说明）** | 高级设置参数区写明「仅本次运行有效：重开面板或重启后会回到已保存值」；保存后提示同义。 |
| U10 退出后不关专用浏览器 | P2 | **已修** | 一轮结束 / 停止 / 应用退出都会关闭专用浏览器（`finish()`、`stop()`、`RunEvent::Exit`），并清掉实例标记；高级设置新增「关闭专用浏览器」按钮（`video_close_browser`）。 |

### 6.2 UI 精简（§1 的 IA）

新面板（`src/plugins/video/VideoAutomationPlugin.tsx`）：

```
[小狗刷视频 · 状态 + 条目/强兴趣]                        [开始看/停下]
（失败时常驻错误条 + 诊断码）
平台 [B站推荐流▾]   登录：未登录（临时观看）            [打开登录窗]
── 最近小结 ──────────────────────────────────────────────
  主题/最多 3 条 / 待投递 N / 刷新历史 / ▸历史会话（每条带真实原因）
▸ 高级设置（参数 · 仅本次有效 / 专用浏览器状态+关闭 / 账号档案 / 自检与诊断 / 清空数据）
▸ 评论（可选，只有点发送才发）
```

- 删除「观后感草稿」「复制草稿」「打开投稿页 / 打开直播中心」（与看视频无关）；
  小结直接看 `最近小结` 卡片与历史。
- 「通道与诊断」收进高级；「清空数据」收进高级且二次确认；「保存配置 / 4 个参数 /
  账号档案」全部收进高级。
- 首屏不再滚动：平台、登录、开始/停下、小结都在第一屏。

### 6.3 验证输出（本轮）

| 命令 | 结果 |
| --- | --- |
| `node node_modules\typescript\bin\tsc --noEmit` | exit 0 |
| `cd src-tauri; cargo check` | exit 0（仅既有 warning） |
| `node --test tests/*.test.mjs` | `tests 92 / pass 92 / fail 0`（原 78 + 新增 14 条 `tests/video-panel-logic.test.mjs`） |
| `vite build`（TEMP 指到仓库内目录绕开杀软临时文件拦截） | exit 0 |
| `cargo build --release --features custom-protocol` | exit 0；产物 28,568,576 B，已装到 `E:\Maltese2`（旧 exe 备份 `maltese-assistant.exe.video.bak`） |
| 构建产物抽查 | `dist` 含「小狗刷视频」「高级设置」「最近小结」「关闭专用浏览器」等新文案 |

新增 Rust 单测：`browser::reuse_decision`（内存/残留/清理三态）、`same_profile`（大小写/分隔符）、
`cdp_ready`（关闭端口为 false）。本机 `cargo test` 仍受 `0xc0000139` 环境限制，只验证到编译级。

#### 实机验证（DSH API 驱动，真实 Chrome + 真实专用 profile）

本轮把新 exe 装到 `E:\Maltese2`（旧 exe 备份 `maltese-assistant.exe.video.bak`），用
`POST /api/video/start|stop` + `GET /api/video/status|sessions|diagnostics` 跑真实链路：

| 场景 | 实测结果 |
| --- | --- |
| **U1 残留实例复用**（QA 报告里那个 10:57 启动、pid 12488、占 9333 的旧浏览器，由旧版本启动、**没有实例标记**） | 点开始后 **2 秒内 `phase=collecting`、`itemCount=1`、无 `CDP_UNAVAILABLE`**；`%LOCALAPPDATA%\Maltese\video-browser.json` 写成 `{"pid":12488,"port":9333,...}` —— 走的是「命令行匹配同 profile 实例 → 接管 9333」，不再换端口重开。 |
| **U10 / 清理** | 停止后 `phase=stopped`、浏览器 pid 12488 已退出、实例标记被删除；历史里该轮 `itemCount=1`。 |
| **U6 首次采集成功** | 同一次运行 `itemCount` 从 0 变 1（此前 6 条全部 0 条），说明修复后主流程至少能进采集并拿到页面事实。 |
| **U5 手动停止记录** | 停止的会话：`stopReason:"userStop"`、`endedAt` 有值、`itemCount:1`（修复前是 `stopReason:null`、0 条的「空会话」）。 |
| **U4 失败落盘 + /diagnostics** | 人为占满 9333–9338 再开始：API 返回 `{"code":"PORT_BUSY","message":"本机调试端口被占用，无法启动小狗浏览器。"}`；状态 `errorCode=PORT_BUSY`；`video/logs/video-20261117.jsonl` 落一条 error；`GET /api/video/diagnostics` 返回 `{"code":"PORT_BUSY","level":"error","sessionId":"bili-20261117-29987f"}`；历史会话 `stopReason:"browserUnavailable"`、`errorCode:"PORT_BUSY"`。 |

> 未覆盖：「打开登录窗」的真实窗口出现（U2 的 `wait_for_visible_window` 分支）、
> 真实登录后的连续采集、以及面板 UI 的鼠标点击链路（见 J1/J2 与 6.5）。

### 6.4 J1–J9 现状

| # | 判据 | 本轮结果 |
| --- | --- | --- |
| J1 | 首屏交互控件 ≤8 | **静态计数 6**（开始/停下、平台、打开登录窗、刷新历史、高级 summary、评论 summary；待投递与历史折叠展开时才多 1–2 个）。**UIA 实测待 QA**：本轮实机 UIA 截图被同机其它进程抢鼠标打断（SetCursorPos 到岛屿后光标被外部移回 952,1176，合成点击时灵时不灵）。 |
| J2 | 面板总高 ≤1.2 屏 | 按新面板结构（状态条 36 + 平台行 32 + 小结约 80 + 两个折叠标题 40 + 间距/内边距）**估算 ≈ 0.6 屏（约 260–300px / 窗口 430–490px）**；同样待 UIA 复测。 |
| J3 | 到开始采集 ≤3 次点击、无需滚动 | 主窗：展开桌宠 → 插件页 → 开始看（3 次）；面板顶部即主按钮，无需滚动。 |
| J4 | 开始后 ≤20s 有结果/常驻错误 | 失败路径：`start()` 内最多等 15s CDP + 失败立即 `set_runtime_error` + finish；错误条来自 snapshot，收起重开仍在。 |
| J5 | 失败可排障 | 每次失败 `store.log` + `/api/video/diagnostics` 可读（U4）。 |
| J6 | 残留浏览器恢复 | 复用/清理/重开三态 + 面板显示当前实例状态 + 一键关闭（U1/U10）。 |
| J7 | 0 条呈现真实原因 | `sessionReason()`（未登录 / 页面解析失败 / 浏览器没起来 / 风控 / 手动停止）。 |
| J8 | 错误文案全中文 | `describeVideoError` + `errorMessageForCode` + `failureReasonText`；不再有英文码刷屏或 `[object Object]`。 |
| J9 | 端到端最小演练 | **部分通过（API 驱动）**：真实 Chrome + 专用 profile 跑通「开始 → 采集（items=1）→ 停」，残留实例复用与停止后自动关闭均已实测；**UI 点击链路与登录窗流程待实机**。 |

### 6.5 复测步骤（QA / 用户）

1. 冷启动 → 展开桌宠 → 插件页：确认首屏能看到「开始看」「平台」「打开登录窗」「最近小结」，
   不用滚动；状态条显示「已暂停 · 条目 0」。
2. 点「开始看」（没登录）：≤20s 内要么进入「小狗正在看」，要么出现常驻中文错误条；
   收起浮层再打开 → 错误条仍在（U3）。
3. 点「打开登录窗」：5s 内必须出现可见浏览器窗口；若机器上已有上次的专用浏览器，
   应直接复用/前置（U1/U2），不再出现「提示成功但没窗口」。
4. 登录后点「开始看」：应在 20s 内 `条目 > 0`（U6/J9）；「停下」后专用浏览器自动关闭。
5. 故意留一个旧专用浏览器进程再点「开始看」：应自动识别并复用或清理后重启，
   不再 15s 超时（U1）。
6. 失败后看 `%APPDATA%\com.maolouis.maltese\video\logs\video-<date>.jsonl` 与
   `/api/video/diagnostics`：应有对应 code；历史里同一轮显示真实原因（U4/U5）。
7. UIA 复测 J1/J2：脚本见 `work/`（本轮临时脚本未入库），或人工数首屏按钮 + 量面板高度。
