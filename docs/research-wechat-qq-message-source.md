# 微信 / QQ 消息来源预研：OCR 的边界与「只提醒」落地

> 日期：2026-11-17 · 环境：Windows 11 25H2（26200）、微信 4.1.15.56、QQ 9.9.19.35184（`E:\QQ\QQ.exe`）、Maltese 2.0.2
> 代码行号基于提交 `5fe7969`；`App.tsx` 仍有并行改动，引用以函数/常量名为准。
> 结论：**首选「只提醒、不显示文字」（G），删除 OCR；次选「Windows 通知监听」（A，仅当微信 toast 实测成立）；B/C/D/E/F 不做。本机当前没有能稳定拿到微信正文、且明显优于 OCR 的免费方案。**

## 0. 先纠正两个前提

1. **QQ 不走 OCR**：QQ 消息来自 `UserNotificationListener` 读 Windows 通知中心（`src-tauri/src/qq_notifications.rs:38-42,481-511`），不截图、不碰窗口。用户说的「微信 QQ OCR」实际只有微信是 OCR。
2. **OCR 不需要前台，而是不能最小化**：`PrintWindow` 能抓被遮挡窗口，但 `IsIconic` 时直接返回 `None`（`wechat_ocr.rs:40-42`）。后台常驻的微信通常正是最小化状态。

## 1. 现状评估：OCR 为什么鸡肋

### 1.1 三条硬证据

**E1 最小化即失效，覆盖大多数使用时段。**
`wechat_ocr.rs:40-42` 在 `IsIconic` 时返回 `None`；调用方把任何 `None` 统一解释成「窗口已最小化」（`wechat_reminders.rs:269-276`）。本机 2026-11-17 实测：微信主窗口（HWND 985568，类名 `Qt51514QWindowIcon`）`Visible=True, Iconic=True`，即用户日常就是最小化挂着。结论：只要不把微信恢复成窗口，正文永远不会出现。

**E2 读到的不是「新消息」，而是「会话列表第一条」。**
OCR 行按 Y 排序后取第一行当发送人、其后 1~2 行当正文（`wechat_ocr.rs:152-166`）。置顶会话、系统提示、甚至界面文字都会被当成「新消息」；这与「哪条真的来了消息」无关。项目文档已自承此点（`docs/wechat-reminder-compatibility.md:28`），而触发源 `HSHELL_FLASH` 本身只表示「任务栏请求关注」，不含会话、发送人或条数（同文档 :37；`wechat_reminder_source.rs:24,197-203`）。

**E3 画面与裁剪都脆弱，失败还会被误报。**
- 截整窗后按窗口宽高比例裁 `5%~44%` 宽、`7%~97%` 高（`wechat_ocr.rs:82-88`）；但微信会话列表是固定像素宽（约 250~350px），窗口越宽，裁剪越会侵入右侧聊天区，可能把聊天正文拼进「摘要」。
- 过滤阈值是绝对像素：`bounds.X < crop_width*0.14`、`bounds.Y < 12`（:147）；行距阈值又是裁剪高度的 8%（:158）。DPI 缩放、窗口尺寸、微信版本/皮肤一变就漂移。
- `PrintWindow` 只检查调用返回值、不检查位图是否空白（:73-80）。GPU 合成窗口返回黑帧时（需实测），OCR 得到 0 行 → `None` → 又显示「窗口已最小化」，错误原因误导研发和用户。
- 每次识别都新建 `OcrEngine`（:117），并依赖「用户配置语言」（`TryCreateFromUserProfileLanguages`）。系统没装中文 OCR 包或首选语言不是中文时，中文识别为空，同样静默降级。纯数字/时间行被丢弃（:143）、`compact_cjk` 启发式去空格（:199-214）也会让混合中英文内容变形。

### 1.2 附带的隐私与文案问题

- 截图是**整窗**进内存后再裁剪（`wechat_ocr.rs:51-104`），虽不落盘、不上传，但处理范围覆盖整个微信窗口。
- 正文会进面板卡片（`src/WeChatReminders.tsx:180-186`）和云朵气泡（`src/App.tsx:7397-7402`）；收起岛已用通用文案兜底（`src/messagePreview.ts:15-19`），但面板/气泡仍会露出发送人与摘要，投屏/录屏时可见。
- 设置页写着「全部在本地完成，不截图、不联网」（`src/App.tsx:2849`），与微信来源实际截图 OCR 的行为相邻矛盾，需要改文案。

### 1.3 性能与延迟（标注：推测，需实测）

事件线程里同步执行「整窗 `PrintWindow` → 像素拷贝 → 新建 OCR 引擎 → `RecognizeAsync().get()`」（`wechat_ocr.rs:51-123`），单次可能几十到数百毫秒；没有引擎缓存、没有空白帧检测、没有最小间隔节流。会话轮询本身是 50ms 一次（`wechat_reminders.rs:370`），OCR 只在 `Attention` 且需要内容时触发（:259-265）。CPU 尖峰需要用第 5 节的采样方法量化，不能只凭代码断言。

### 1.4 本机实测（2026-11-17，只读）

| 检查 | 结果 | 判定 |
| --- | --- | --- |
| 微信版本/窗口 | 4.1.15.56；主窗口当前最小化 | 已核实 |
| 通知中心数据库快照（复制 `wpndatabase.db` 只读查询） | 共 23 条；QQ 3 条，全部是「新邮件来自 GitHub」的 QQ 邮箱通知（`launch=ntqq-notification://…openEmail`），无 QQ 聊天；除 `WeixinShare` 分享扩展外**没有微信 handler，也没有微信 toast 记录** | 已核实（仅当前快照，不能外推「永远没有」） |
| 通知访问状态 | `wechat_notification_probe --watch-seconds 0` 与 `qq_notification_probe --watch-seconds 0` 均返回 `access=2`（Denied）；`HKCU\…\CapabilityAccessManager\ConsentStore\userNotificationListener` 却是 `Allow`。用计划任务以 LIMITED 完整性复跑仍为 Denied | 已核实状态；原因未证实（推测：无 manifest capability 的未打包进程在当前系统上被拒） |
| 与旧文档的冲突 | `docs/qq-notification-compatibility.md:97` 记录 2026-10-18 `access=allowed` 并读到真实 QQ 通知 | 需复测：系统升级或权限状态可能已变化 |

> 这意味着：**QQ 通知来源本机当前也可能不可用**（面板会停在「需要授权」）；「微信 QQ 消息鸡肋」可能同时包含「QQ 根本没有文字」这一层，不能只怪 OCR。

## 2. 候选方案对比

| 方案 | 原理 | 能拿到什么 | 登录/授权 | 稳定性 | 合规与隐私 | 成本 | 对当前架构改动面 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Windows 通知监听**（`UserNotificationListener`） | WinRT 读通知中心里其他 App 的 toast | 真实文本；取决于 App 的 toast 模板（标题、正文、时间） | 需「允许应用访问你的通知」；打包应用还要 `uap3:userNotificationListener` 能力 | 中：App 不发 toast 就没有；未打包进程的 `NotificationChanged` 事件会 `0x80070490`，只能轮询（QQ 已按 1s 轮询：`qq_notifications.rs:381`） | 低-中：只读通知，仍需用户授权；通知含隐私 | 微信 S~M；QQ 已实现 | 中：复用 QQ 管线，新增来源过滤/解析/回退 |
| **B. UI Automation 事件** | 订阅文本变化事件（官方 ID 是 `UIA_Text_TextChangedEventId` 20015 / `UIA_TextEdit_TextChangedEventId` 20032，任务里的 `UIA_TextEditTextChangedEventId` 不是实际常量） | 真实文本（仅当控件提供 Text/TextEdit Provider） | 无需额外授权，同权限级别可读 | 低：微信 4.x Qt 自绘，UIA 树近乎空（本项目 4.1.9.35 探针只有 3 个外壳控件、0 文本/列表项，`docs/wechat-reminder-compatibility.md:93`；第三方项目亦独立复现）；QQ 的 Electron 无障碍树还需额外条件 | 低-中：被动读取不注入，但涉及无障碍权限与窗口存在 | M~L | 大：事件订阅、跨进程生命周期、窗口恢复 |
| **C. 读本地数据库** | 解密微信/QQ SQLite（SQLCipher），密钥从进程内存/版本适配获取 | 全量正文、历史 | 需密钥提取、版本适配 | 低：小版本升级就可能失效 | **高**：违反服务条款、账号与合规风险；等同逆向 | L | 大：独立采集器、存储与清理 |
| **D. 协议 Hook / DLL 注入** | 注入进程、读内存、改协议 | 最全 | 无（也不需要） | 低 | **明确不做**：杀软告警、封号、违反 ToS 与法规 | — | — |
| **E. 官方开放平台/机器人** | 企业微信 API、QQ 机器人 v2、Webhook | 仅「机器人/企业应用」会话，不是用户个人微信/QQ 私聊 | 注册、审核、HTTPS 回调（QQ Bot 还需公网 443） | 高（官方） | 合规友好 | L | 大：等于另做一个产品 |
| **F. 改进 OCR** | 限定会话区、多帧投票、未读角标/前台触发 | 真实文本（仍仅非最小化窗口） | 无 | 低-中：置顶会话误报、DPI/版本漂移仍在；最小化仍无解 | 中：仍截图 | M | 中：裁剪与投票、状态机 |
| **G. 只提醒、不显示文字** | 复用 `HSHELL_FLASH`（微信）与通知到达（QQ）；可选读窗口标题里的未读数 | 仅「有新消息」+ 来源、时间、数量（若可读） | 微信无需授权；QQ 需通知访问或同样改用 shell hook | 高（事件级） | 最好：不截图、不读正文 | S | 小：以删代码/删 UI 为主 |

补充事实（已核实/第三方）：

- 微软文档要求通知监听在清单里声明 User Notification Listener 能力（[notification-listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)、[uap3:Capability](https://learn.microsoft.com/en-us/windows/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-capability)）。
- 未打包进程能否用通知监听因环境而异：第三方 crate 记录「Win11 未打包进程被观察到 allowed，但 `NotificationChanged` 事件报 `0x80070490`」（[crcbl_notify](https://docs.rs/crcbl-notify/0.14.0/crcbl_notify/)）；也有开发者报告 `RequestAccessAsync` 直接返回 Denied、无弹窗（[StackOverflow](https://stackoverflow.com/questions/77884311/python-winrt-how-to-get-notification-listener-permission)）。本机 Denied 与后者一致。
- 第三方工具 `wechat-notifier` 自述微信 4.x 会向通知中心推 toast，文本结构为 `[微信, 会话名, 发送者: 正文]`，并靠此实现悬浮卡片（[README](https://github.com/PepsiColaya/wechat-notifier)）。**第三方自述，未在本机复现**：本机 4.1.15.56 通知库无微信记录，需按 5.1 复测。
- 企业微信 API 收不到个人微信发给成员的消息（官方社区答复：[链接](https://developer.work.weixin.qq.com/community/question/detail?content_id=16436645525090311710)）；QQ 机器人 v2 是「机器人账号」体系，读不到用户个人 QQ 聊天（[bot.q.qq.com](https://bot.q.qq.com/wiki/develop/api-v2/)）。因此 E 不能替代个人号消息来源。

## 3. 推荐结论

**首选：G——只提醒、不显示文字。** 本机当前证据下，微信没有可用的系统通知、UIA 读不到、数据库/注入不做，OCR 又依赖窗口非最小化；能稳定工作的只有「有新提醒」这一层。这也正是用户给出的兜底要求。

**次选：A——微信改读通知中心，仅当复测证明微信会发 toast。** 若 5.1 的 10 分钟实测出现 `[微信, 会话名, 发送者: 正文]`，可用 A 取代 OCR 的正文（成本 S~M，复用 QQ 管线）；否则不要做。QQ 已经走 A，保持，但要先解决本机 Denied/授权问题（见 5.1）。

**明确不做：B（微信 UIA 树为空）、C（解密数据库，合规/账号风险）、D（注入，禁止）、E（个人号不适用）、F（改进 OCR 仍解不了最小化与置顶误报，收益不抵成本）。**

**最短可行路径（本机）**

1. 立即：默认关闭正文、删除 OCR 调用与 UI，只保留「微信有新提醒 / QQ 有新通知」→ 当天可交付（S）。
2. 10 分钟：`wechat_notification_probe --watch-seconds 60` 期间从手机给微信发一条消息（微信最小化、设置→通知→新消息通知开启）。出现带正文的微信通知 → A 可升级；否则 A 对微信关闭。
3. 10 分钟：打开应用看 QQ 来源状态；若为「需要授权/Denied」，到 Windows 设置授权后复测；仍 Denied 则 QQ 也降级为 shell hook 只提醒（需实测 QQ 新消息是否触发 `HSHELL_FLASH`，`wechat_reminder_source.rs` 可直接复用，换成 `QQ.exe` 路径匹配）。

## 4. 「只提醒」落地规格（给研发）

### 4.1 字段：保留 vs 删除

| 保留 | 删除 |
| --- | --- |
| 来源 App（qq / wechat / qqMail）、`enabled`、`status`、`pending`、`lastAttentionAt`、`windowVisible`、到达时间、岛内通知条数（QQ，注明是「通知条数」不是未读数） | `title`、`body`、`contentError`（`wechat_reminders.rs:31-44`）；OCR 相关 `readContent`、`set_wechat_read_content`；面板卡片正文、云朵气泡正文、收起岛 QQ 的「发送人·正文」行 |
| 可选「未读数」：微信主窗口标题可能带 `(N)`（代码注释见 `wechat_reminders.rs:460-462`），用 `GetWindowTextW` 解析即可，不截图；是否在 4.1.15.56 仍成立需实测，先不承诺 | 任何把聊天文本写进事件 payload / localStorage / 日志的路径 |

原则：**预览关闭时由 Rust 在源头剥离正文**，不要只靠前端隐藏——事件、`get_*_state`、日志都不应出现正文。

### 4.2 设置与迁移

- 新增统一开关「显示消息预览」默认 **关**（建议 key `maltese-message-preview-enabled=false`）；关闭时：面板只显示来源/时间/状态，气泡文案为「微信有新提醒」「QQ 有新通知」。
- 删除微信侧 `ScanText` OCR 开关（`WeChatReminders.tsx:149,157-161`）与 `focusd-island-wechat-read-content` 的读取/写入（`WeChatReminders.tsx:74-82,125-128`）。
- 兼容：旧用户 `focusd-island-wechat-read-content=true` 一律按新默认 `false` 处理（老值不迁移、不复活 OCR）；`maltese-reminders-default-on-v2` 已把两个来源默认开启（`App.tsx:698-705`），保持不变，只去掉正文。
- QQ 通知权限拒绝/不可用时，保留现有「授权/打开系统设置」入口（`QQNotifications.tsx:189-193`），文案说明「只提醒也需要系统通知访问」。

### 4.3 改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/wechat_ocr.rs` | 整体删除（或保留为测试工具，不再被引用） |
| `src-tauri/src/lib.rs:23`、`:4335-4347` | 移除 `mod wechat_ocr`、`set_wechat_read_content` 命令注册 |
| `src-tauri/src/wechat_reminders.rs` | 删除 `read_content`/`title`/`body`/`content_error` 与 `signal()` 中的 OCR 分支（:259-293）、`content_window()`（:309-313）及相关测试；保留 `HSHELL_FLASH → pending`；可选新增标题未读数解析 |
| `src-tauri/src/qq_notifications.rs` | 新增 `preview` 开关；关闭时不把 `title/body` 发往前端（保留 `id/created_at` 与条数）；解析逻辑与去重不变 |
| `src/WeChatReminders.tsx` | 删 OCR 开关与 `wechat-message-card`（:180-186）；待关注态只显示通用文案 + 打开微信 |
| `src/QQNotifications.tsx` | 预览关闭时不渲染 `item.title/item.body`（:220-224），只显示时间与「新消息」；设置开关在面板/设置页各一处 |
| `src/Messages.tsx`、`src/messagePreview.ts`、`src/CollapsedMessageContent.tsx`、`src/App.tsx` | 统一走「预览开关」；`App.tsx:1481-1490` 的 `preview` 组装、`:7378-7410` 的云朵气泡、`:2838-2841` 的设置控件同步改；微信预览保持 `messagePreview.ts:15-19` 的通用文案 |
| `src/i18n/locales/zh-CN.ts:120-135`、`en.ts:120-135`、`i18n/types.ts` | 删除 `readContent/readContentHint/contentUnavailable`（或改为预览开关文案），新增「显示消息预览」及其隐私说明，中英同步 |
| `README.md:79-86,187-194`、`docs/wechat-reminder-compatibility.md`、`docs/qq-notification-compatibility.md`、`docs/notification-first-run-verification.md` | 删除「会话列表首条/正文预览/OCR 语言包」描述；写明只提醒、字段范围、QQ 权限前提；隐私说明改为「不截图、不读取聊天正文」 |
| `tests/message-preview.test.mjs`、`tests/qq-notification-timing.test.mjs`、Rust `wechat_reminders::tests` | 更新断言：预览关闭时不存在正文；保留到达合并、去重、前台清除等既有用例 |

### 4.4 隐私说明必须更新的三处

1. `src/App.tsx:2849` 的「不截图」与 OCR 行为矛盾：本方案后应真正成立，并补一句「不读取聊天正文」。
2. `README.md:22` 的「消息预览都在本机完成」保留，但删掉「微信 OCR 图片」相关表述。
3. 各兼容性文档：明确「只提醒」不产生、不存储、不显示聊天文本；QQ 通知文本即便在内存中解析，也不写入前端状态。

## 5. 验证办法

### 5.1 先验证来源是否成立（只读，10 分钟）

```powershell
# 1) 微信是否会发系统通知：期间用手机给微信发一条消息（保持微信最小化）
cargo run --manifest-path src-tauri/Cargo.toml --example wechat_notification_probe -- --watch-seconds 60
# 2) 微信任务栏提醒是否仍可捕获
cargo run --manifest-path src-tauri/Cargo.toml --example wechat_reminder_probe -- --watch-seconds 60
# 3) QQ 通知访问状态（应用内也看「QQ」来源状态）
cargo run --manifest-path src-tauri/Cargo.toml --example qq_notification_probe -- --watch-seconds 0
```

判读：探针 1 出现含 2 个以上文本元素的微信通知 → A 对微信成立；退出码 2 或 `access=2` → 本机维持 G。探针 2 捕获 `weChatFlashEvents>0` → 只提醒可用。探针 3 `access=denied` → QQ 只提醒需改用 shell hook 并实测。

### 5.2 功能验收（只提醒）

- 微信最小化时来消息：折叠岛出现绿点/通用预览，云朵气泡只说「微信有新提醒」，**面板无发送人、无摘要**。
- 打开消息面板：微信页只有状态与「打开微信」；QQ 页只有时间与「新通知」，无标题/正文。
- DevTools 或 Rust 侧检查：`wechat-reminder-changed` 与 `qq-notifications-changed` 的 payload 中无 `title/body`；`get_wechat_reminder_state` 无正文；日志无正文。
- 关闭「显示消息预览」后重启，设置保持关闭；旧用户升级后也不显示正文。
- 关闭微信（未登录）时显示明确错误；微信在前台时不重复提醒（`wechat_reminder_source.rs:206-209` 已实现）。

### 5.3 性能验收（OCR 移除）

```powershell
# 事件前后各采 60 秒 CPU，对比同版本旧构建（OCR 在时）与仅提醒构建
Get-Process maltese-assistant | Select-Object CPU,WorkingSet64
```

预期：来消息时不再出现 OCR 引起的 CPU 尖峰；空闲时监听线程仅每 50ms 轮询消息（`wechat_reminders.rs:370`）。用任务管理器/Process Explorer 观察 30 秒，记录峰值即可，不要求精确到毫秒。

### 5.4 回归命令

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
node --test tests/message-preview.test.mjs tests/qq-notification-timing.test.mjs
pnpm build
pnpm tauri build --no-bundle
```

## 6. 参考

- [Notification listener（微软）](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener) · [uap3:Capability](https://learn.microsoft.com/en-us/windows/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-capability) · [UIA 事件 ID](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-event-ids)
- [crcbl_notify（未打包进程 + NotificationChanged 限制）](https://docs.rs/crcbl-notify/0.14.0/crcbl_notify/) · [RequestAccessAsync 直接 Denied 的报告](https://stackoverflow.com/questions/77884311/python-winrt-how-to-get-notification-listener-permission)
- [wechat-notifier（第三方：微信 toast 结构）](https://github.com/PepsiColaya/wechat-notifier) · [企业微信不接收个人微信消息](https://developer.work.weixin.qq.com/community/question/detail?content_id=16436645525090311710) · [QQ 机器人 API v2](https://bot.q.qq.com/wiki/develop/api-v2/)
- 仓库内：[微信提醒兼容性](wechat-reminder-compatibility.md)、[QQ 通知接入](qq-notification-compatibility.md)、[首次使用消息接收验收](notification-first-run-verification.md)

## 附录：结论标记说明

- **已核实**：本机命令输出、代码行、官方文档原文可复核。
- **推测**：基于代码/系统行为的合理推断，未经测量（如 PrintWindow 黑帧、OCR 单次耗时、QQ 是否闪任务栏）。
- **需实测**：依赖用户机器/客户端版本、需一次真实消息才能判定的（微信 4.1.15.56 是否发 toast、标题未读数、QQ 通知授权恢复、A 在本机可用性）。
---

## 7. 落地记录（2026-11-17）

已按本文第 4 节执行「只提醒，不显示文字」：

- **删除 OCR 链路**：`src-tauri/src/wechat_ocr.rs` 整体删除；`lib.rs` 去掉 `mod wechat_ocr` 与
  `set_wechat_read_content` 命令注册；前端去掉 `ScanText` 按钮、`readContent` 状态与
  `focusd-island-wechat-read-content` 旧键（启动时按 false 处理并清理，见 `src/messagePrivacy.ts`）。
- **源头剥离正文**：`wechat_reminders::ReminderSnapshot` 删除 `title/body/content_error/read_content`，
  只保留 `revision/enabled/status/pending/lastAttentionAt/error`；QQ 侧新增 `NotificationItem`
  （只有 `id/createdAt`），Windows 通知的标题/正文只留在 Rust 内部用于「新通知 vs 更新」判断，
  不序列化、不进事件、不进日志。
- **保留字段**：来源 App、`enabled/status/pending`、到达时间、QQ 通知条数；
  UI 只显示「微信有新消息 / QQ 有 N 条通知 + 时间」。
- **新开关**：设置页（岛内 + 独立设置窗口）新增「显示消息预览」，默认关；说明里明确
  本版本不读取聊天内容，打开也只显示通用提示。
- **QQ 未授权**：`GetAccessStatus=Denied/Required` 时面板显示「通知权限被拒绝 / 需要通知权限」
  并提供授权、打开系统通知设置入口（已有逻辑，本轮同步文案）。
- **验证**：`tsc --noEmit`、`cargo check --all-targets`、`node --test`（新增
  `tests/message-privacy.test.mjs` 与 Rust `serialized_notification_items_contain_no_message_text`）。

仍建议后续用真实微信/QQ 消息复测一次：只应出现提醒与时间，诊断日志里不应出现任何聊天文本。
