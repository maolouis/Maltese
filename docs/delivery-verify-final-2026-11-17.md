# 交付验证（最终轮）· 2026-11-17

> 验证对象（HEAD = `63baaa8`，分支 `refactor/external-resources`）：
> - `810b93f` GIF 拖拽（容器级指针拖拽 + 落点重算 + 写回校验 + 全选去重）
> - `849d653` 置顶（📌 固定标签页：`PINNED_PAGE` + `get_pinned_page`，unminimize→show→always_on_top→focus）
>   · `551a456` 该问题的定位与修复文档
> - `04bba26` 多实例联动 MVP（`BroadcastChannel` 总线、情绪传染、Bongo 呼应、开关默认开）
> - `63baaa8` 微信/QQ 只提醒（删 OCR、Rust 源头剥离正文、预览默认关、旧键清理）
>
> 版本仍 **2.0.2**；本轮**未 push、未升版本号、未打 tag**。验证方式：三条硬命令 + 源码/配置静态核对 +
> 运行中实例只读实测（B 站/窗口/UIA/**不含鼠标移动**）。所有写入都只发生在本报告文件。

---

## 0. 结论：**可发布（带发布前必做清单）**

代码/测试/仓库卫生门槛全部通过，四项修复的代码路径都能对上，其中「置顶」拿到了运行时的客观证据
（`WS_EX_TOPMOST` 实测量到 + 固定窗落到正确页面）。剩余的不是「返工项」，而是**发布流水线必做**的
几件事：升版本号、重建产物、跑发布前扫描、以及 30 秒人工冒烟（GIF 真拖一次 / 固定窗最小化再点 /
消息页确认无正文）。

**不判返工**的理由：`tsc` / `cargo check` / `node --test 112` 全绿；版本号未动；未 push；工作区干净；
`beforeBuildCommand` 已还原成 `pnpm build`；`additionalBrowserArgs`（临时调试端口）已从发布配置移除；
没有任何 `*.bak-settings` 残留；四项修复都有真实提交 + 单测（`pet-link-bus` 12 条、
`message-privacy` 5 条、`gif-rotation-order` 11 条含新增 3 条）。

**必须完成才能发**：§5 清单（版本号 4 处 + `docs/releases/vX.Y.Z.md`、重建安装包/便携包、
`verify-release-artifacts.ps1`、30 秒人工冒烟、push 后确认 `origin/main` 前进）。

---

## 1. 三条硬验证（原始关键行）

### 1.1 `node node_modules\typescript\bin\tsc --noEmit`

```text
(无输出)
TSC_EXIT=0
```

### 1.2 `cd src-tauri; cargo check`

```text
warning: associated items `memory`, `root`, and `memory_only` are never used
   --> src\video\store.rs:127:12
warning: constant `LAZY_WINDOW_LABELS` is never used
   --> src\window_factory.rs:220:7
warning: `maltese-assistant` (lib) generated 69 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.10s
warning: the following packages contain code that will be rejected by a future version of Rust:
    imap-proto v0.10.2
CARGO_EXIT=0
```

69 条 warning 与上一轮（视频插件轮）**完全同数** → 本轮 5 个提交没有引入新 warning。

### 1.3 `node --test tests/*.test.mjs`

```text
…
✔ 错误码有中文文案 (0.1442ms)
ℹ tests 112
ℹ suites 0
ℹ pass 112
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 543.9264
TEST_EXIT=0
```

预期 112，实测 **112 / 112 / 0 fail**。分文件（`^test(` 直接计数，三个 helper 驱动的文件计入总分）：

| 文件 | 条数 | 文件 | 条数 |
| --- | --- | --- | --- |
| gif-rotation-order | 11（本轮 +3） | pet-link-bus | 12（本轮新增） |
| message-privacy | 5（本轮新增） | video-panel-logic | 14 |
| pet-gif-removal | 12 | video-delivery | 9 |
| release-signing | 8 | video-types | 7 |
| i18n | 6 | updater-controller | 6 |
| island-automation / message-preview | 4 / 4 | qq-notification-timing / release-manifest | 3 / 3 |
| billiards-metrics / pet-interactions / relationship-pairing | helper 循环（计入 112） | video-digest-format | 5 |

---

## 2. 版本与仓库卫生

### 2.1 版本仍 2.0.2（四处）

| 位置 | 值 |
| --- | --- |
| `package.json` | `"version": "2.0.2"` |
| `src-tauri/tauri.conf.json` | `"version": "2.0.2"` |
| `src-tauri/Cargo.toml` | `version = "2.0.2"` |
| `README.md` 徽章 | `version-2.0.2-orange` |

`git show --name-only` 四个修复提交都**没有**改版本号（`63baaa8` 改了 README 隐私段，但没动徽章）。

### 2.2 未推送与 push 状态

```text
git rev-list --count origin/main..HEAD   → 48
origin/main                              → 3d01ef5（2026-11-14 13:36:54）
.git/refs/remotes/origin/main mtime      → 2026-11-14 13:37:08（11-17 没有更新）
git tag --points-at HEAD                 → （空）；最新 tag v2.0.2 → 1c23ea1（11-14）
当前分支 refactor/external-resources 无 upstream
```

→ **未 push、未打 tag、未发 Release**；48 个提交全部只在本地（本轮 5 个 + 之前 43 个）。

### 2.3 工作区与遗留物

```text
git status --porcelain=v1 → (clean)（验证开始与结束各查一次）
*.bak-settings            → 工作区 0 个、git 跟踪 0 个
src-tauri/tauri.conf.json → "beforeDevCommand": "pnpm dev" / "beforeBuildCommand": "pnpm build"
                            （无 additionalBrowserArgs；git log -S 显示 beforeBuildCommand 自 v1.1.0 起未被提交改动，
                             本轮的「置空」只存在于临时工作副本，已还原）
work/ 下的 devfix-tauri.conf.json 等调试副本 → /work/ 已 gitignore，不入库
tauri.release.conf.json   → 被 gitignore（发布时注入的空 beforeBuildCommand 覆盖文件，符合既有流程）
```

运行时佐证「调试端口确实没进发布配置」：本机 `Get-NetTCPConnection -State Listen` 里 **没有 9222**
（只有 DSH API 3218），与 `tauri.conf.json` 已删 `additionalBrowserArgs` 一致。

### 2.4 运行中的产物：**已包含本轮 5 个提交**

```text
E:\Maltese2\maltese-assistant.exe   28,569,600 B   构建 14:13:36   FileVersion 2.0.2
dist\assets\index-CT6RVIvk.js      998,477 B       构建 14:12:44
进程 PID 19240                                      启动 14:13:45
最新源码 mtime：src\QQNotifications.css 14:12:25 < dist 14:12:44 < exe 14:13:36
```

即：**dist 晚于全部前端源码、exe 晚于 dist**，运行实例可用作本轮四项的实机抽查对象
（上一轮「dist 落后源码」的问题这次没有复现）。产物内字节级检索命中本轮新文案：
`实例联动`(246344)、`主狗被摸头`(246364)、`我也要！`(246514)、`顺序没能写进配置`(237072)、
`不读取消息内容`(230769)、`显示消息预览`(246625)、`只提醒有新通知，不显示发送人和内容`(230827)、
`📌 已固定在桌面`(982464)、`取消固定`(982622)、`全选现有表情`(237214)。

---

## 3. 四项逐条核验

### 3.1 GIF 拖拽（`810b93f`）：🟡 静态 + 单测通过，localStorage 实测缺（见「怎么补」）

**代码路径（逐环节复核，全部对得上）**

| 环节 | 实现 | 文件:行 |
| --- | --- | --- |
| 容器级 pointerdown | `onPointerDown` 挂在网格容器（不是每个 figure） | `PetGifRotationSettings.tsx:428-447`、`:608` |
| 命中测试 | 先 `measureTiles()` 量全部格子，再 `petGifIndexAtPoint(rects, {x,y})`；按在间隙/网格外返回 null 直接不拖 | `utils/gifRotationOrder.ts:59-70` |
| 指针捕获 | `event.currentTarget.setPointerCapture(pointerId)`（捕获在容器上，被拖节点销毁也不断） | `:446` |
| 松手重算 | `finishPointerDrag` 里**重新** `measureTiles()`，再用 `petGifDropTargetIndex` 算落点（滚动/重排后坐标仍准） | `:502-512` |
| 排序写回 | `applyReorder` → `movePetGifItem(items, from, to)` → `saveItems` → `savePetGifRotationConfig`（`localStorage.setItem("maltese-pet-gif-rotation:<角色>")` + 派发更新事件让主窗同步） | `:244-256`、`petGifRotation.ts:161-171` |
| 写回校验 | 写完读回 localStorage，逐项比较归一化键；不一致/抛错就 `setError(reorderFailed)`（中文：「顺序没能写进配置，请重试…」），**不再静默失败** | `:249-262` |
| 全选去重 | `selectedKeys`/`missingItems` 一律用 `petGifItemKey()`（`builtinAssetRelative` 归一 `/assets/pets/...` 与 `chars/...`）；`selectAll` 只在 `missingItems` 非空时 `[...items, ...missingItems]`；`saveItems` 再 `dedupePetGifItems`（保留首次出现）→ **历史重复项在下次写回时被清掉** | `:100-124`、`:225-241`、`petAssetBase.builtinAssetRelative` |
| 触屏 | 网格容器 `touch-action: none` | `PetGifRotationSettings.css:111,129` |

**单测**：`tests/gif-rotation-order.test.mjs` 共 11 条，本轮新增 3 条正好覆盖新路径——
「容器级命中：按在格子里得到下标，按在间隙/网格外返回 null」「松手时用重新测量后的矩形算落点：
滚动前后同一坐标落到不同格子」「容器命中 + 落点 + 排序串起来：从第 1 格拖到第 4 格」。

**未实测的部分（原因）**：没有拿到「拖动后 localStorage 顺序变化」的独立证据——
① 本机已无 CDP（`tauri.conf.json` 已移除 `--remote-debugging-port=9222`，端口扫描无监听），
无法注入 pointer；② WebView2 的 leveldb `.ldb` 数据块是 snappy 压缩，只读字节扫描只能看到碎片，
读不出完整 JSON；③ 浮层当前是收起态，打开设置页需要真实双击，本轮不移动用户鼠标。
**已有的间接证据**：dev-fix 在 `810b93f` 提交信息里记录了 CDP 真实指针验证（修复前 `pointerdown hit:null`、
`.is-dragging=0`、无 `storage.set`；修复后 `dragging=1 / dropTarget=1`，松手后 DOM 序号与
localStorage 顺序同步变成 `normal2, 吹心心, 写`，与 `movePetGifItem(items,0,2)` 一致）——**引用，未由我复核**。

**30 秒人工补测**：设置 → 布局 → 表情轮播，把第 1 张拖到第 3 张 → 刷新面板确认顺序还在；
再点「全选现有表情」两次，确认数量不翻倍（当前 29 张量级，不应变成几百）。

### 3.2 置顶 / 固定标签页（`849d653` + `551a456`）：✅ 实机通过（topmost 实测到）

**实机实测（用 UIA `InvokePattern` 触发 📌，不移动鼠标）**：

```text
14:18:19.227  UIA Invoke「固定当前标签到桌面」（浮层当时在「待办」页，rect 1817,934,2544,1424 727×490）
14:18:19.362  +135ms：出现新 Tauri 窗口 title=[固定在桌面的标签页]
              hwnd=0x2608D2  visible=False  topmost=True  rect=286,286,706,846  (420×560)
14:18:33.382  hwnd=0x2608D2  visible=True   topmost=True  rect=286,286,706,846
              WebView2 子链：WRY_WEBVIEW 420x560 / Chrome_WidgetWin_1 420x560 / RenderWidgetHost 420x560
              UIA：descendants=42，text=「📌 已固定在桌面」
                   buttons=取消固定 / 关闭这个窗口 / 聊天 / 待办 / 音乐 / 快捷
                   页面内容：「添加」「标记为完成」「经济学金融基础…」← **待办列表**，不是默认「聊天」
```

结论：

1. **`WS_EX_TOPMOST` 位实测已置上**（`GetWindowLongPtr(GWL_EXSTYLE) & 0x8` = true），并且窗口可见、
   子 WebView2 完整、尺寸 420×560 与 `window_factory::pinned()` 配置一致。
2. **`get_pinned_page` 修复生效**：浮层当时停在「待办」，固定窗打开后直接落「待办」，没有再退回默认
   「聊天」——这正是 849d653 要修的「事件早于新窗口 listen」问题。
3. 创建时序：+135ms 时窗口已存在但还没 `show()`，+14s 采样时已可见（懒创建 → show 是异步两步，
   符合 `pin_page_to_desktop` 里「先 ensure 再 unminimize→show→always_on_top→focus」的顺序，
   `lib.rs:1529-1531`）。
4. 该窗口在 14:20:35 采样时已变成 `visible=False`（窗口还在，未销毁）。代码里能隐藏它的只有
   `unpin_page_from_desktop`（`lib.rs:1546-1554`），而它的唯一调用方是固定窗自带的
   「取消固定 / 关闭这个窗口」两个按钮 —— 我这一轮的 unpin 调用 **没有成功**（按钮在已隐藏窗口上
   找不到），所以这次收起来自**外部点击**（用户/桌面操作），不是自动消失；当前没有留下悬挂窗口。

**「最小化后再点 📌 是否恢复」**：🟡 静态已验证、未实测——
`pin_page_to_desktop` 现在顺序是 `let _ = window.unminimize(); window.show()?; let _ = window.set_always_on_top(true); window.set_focus()?`
（`lib.rs:1529-1531`），并且先写 `PINNED_PAGE`（`:1512-1514`）。未实测原因：测试需要浮层处于展开态
才有 📌 按钮，而浮层在固定窗取焦后按设计自动收起，本轮不动鼠标无法再展开。
另：主浮层窗口本身的 `topmost=True` 也说明该构建 `always_on_top` 在运行时确实生效。

**30 秒人工补测**：📌 固定 → 在任务栏/Alt+Tab 把固定窗最小化 → 回浮层再点一次 📌 → 应恢复并仍在最上层；
点「取消固定」后窗口消失、再点 📌 能恢复。

### 3.3 多实例联动（`04bba26`）：🟡 单测覆盖完整；真实多狗未做（本机只有 1 只）

**纯函数防线（`src/petLinkBus.ts`，422 行）逐条对表**：

| 防线 | 实现 | 常量/位置 |
| --- | --- | --- |
| 概率 | `random() >= probability` 直接不发 | `PET_LINK_PROBABILITY = 0.6`，`:171` |
| 单次上限 | 每次最多 2 只，`min(labels.length, maxInstances)` | `PET_LINK_MAX_INSTANCES = 2`，`:172-174` |
| 错峰 | 延迟 0–300ms，第一只 0ms | `PET_LINK_STAGGER_MAX_MS = 300`，`:171-180` |
| 同动作冷却 | 发送端 1.5s / 接收端 1.5s | `PET_LINK_ACTION_COOLDOWN_MS = 1500`，`:162` / `:251` |
| 全局限速 | 1s 窗口内最多 4 次（不同动作也算） | `PET_LINK_RATE_WINDOW_MS/RATE_LIMIT`，`:159-160` |
| 气泡冷却 | 每实例每动作 8s | `PET_LINK_BUBBLE_COOLDOWN_MS = 8000`，`:254-261` |
| 回声抑制 | `message.source === options.self` 直接丢弃（自己发出的不响应自己） | `:241` |
| 旧消息 | `message.seq <= state.lastSeq` 丢弃 | `:242` |
| 目标过滤 | 只接受 `targets` 里包含自己 label 的消息 | `:248-249` |
| 通道 | `BroadcastChannel("maltese-pet-link")` 优先，Tauri 全局事件兜底 | `:288-336` |
| 开关默认 | 没写过设置时 `readPetLinkageEnabled()` = **true**；设置里 `petLinkage: true` | `:96-101`、`SettingsWindow.tsx:126`、`App.tsx:682` |
| 陪玩狗数量 | `readCompanionLabels` = `petCount - 1`（0–4） | `:105-121` |

**单测**：`tests/pet-link-bus.test.mjs` **12 条**，名字就是验收点——概率 0 不发 / 随机 1–2 只不超上限 /
错峰 0–300ms 且第一只不延迟 / 同动作 1.5s 冷却 / 每秒最多 4 次 / **回声抑制：自己发出的事件直接丢弃** /
旧 seq 与非目标实例都不响应 / 接收端冷却与延迟透传 / 气泡 8s 冷却但动作仍可播 / 开关关闭时一律不发 /
开启时带 source/seq/targets / 开关与数量从设置读（默认开、默认 1 只）。

**未验证（真实多狗）**：本机设置是「小狗数量（含主狗）= **1只**」（上一轮实机 UIA 读到），
`readCompanionLabels` 返回空数组 → 没有第二只狗可被传染；本轮**没有改用户设置**（改 petCount 属于用户数据）。
所以只验证到「代码 + 单测」层，真实「摸主狗 → 陪玩狗跟着动 + Bongo 敲鼓」需要人工把陪玩狗开到 2 只再看一眼。
Bongo 一侧的接线是有的：`BongoPet.tsx:121-147`（`acceptLinkMessage` + `emitBongoHit`，空格键敲鼓也走总线）。

### 3.4 微信/QQ 只提醒（`63baaa8`）：✅ 代码面完整（UIA 消息页未由我复读，附原因）

**「删干净」核对（全部实测 grep）**：

```text
src-tauri/src/wechat_ocr.rs            → 文件不存在（已删除）
grep 'wechat_ocr|read_content' src-tauri/src → 仅剩 wechat_reminders.rs 里两句「已删除 OCR」的注释；
                                             其余命中是 CoCreateInstance 的假阳性（大小写不敏感匹配 "oCr"）
lib.rs 的 mod 声明                      → 只有 mod wechat_reminder_source / wechat_reminders（无 wechat_ocr）
set_wechat_read_content 命令             → 已从 lib.rs 移除（grep 无命中）
QQNotification                          → #[derive(Clone, Debug, PartialEq)]，**没有 Serialize**（qq_notifications.rs:56-62）
对外序列化结构                           → NotificationItem { id, created_at }（只 Serialize 这两个字段，:64-70）
NotificationEvent / NotificationSnapshot → 只含 snapshot（items 为 NotificationItem），无 title/body
Rust 单测                                → serialized_notification_items_contain_no_message_text（构造 title="private-sender" 断言 JSON 不含正文）
                                          diagnostic_reports_never_include_chat_content
前端 readContent 引用                    → 无（只剩 messagePrivacy.ts 里 LEGACY 键常量与清理函数、以及 App.tsx/SettingsWindow 的调用）
云朵气泡/收起岛预览                       → 只拼「来源 + 通用文案」：t.messages.newNotification / newReminder（App.tsx:1501-1513）
设置开关                                → 「显示消息预览」默认关（SettingsWindow.tsx:127/625-628、App.tsx:683）；注释明确「打开也只显示通用提示」
旧键清理                                → focusd-island-wechat-read-content 在启动（App.tsx:712）与设置加载（SettingsWindow.tsx:132）各删一次
                                          + 单测 5 条（旧值 true 也按关闭处理、旧键不存在不做事、存储抛错静默、默认关、写入异常不抛）
```

**UI 渲染**：`WeChatReminders.tsx:176-189` 只显示「微信有新消息 · 时间」+ 隐私说明；
`QQNotifications.tsx:216-224` 顶部「共 N 条通知（不读取消息内容）」，条目只有「QQ 通知 + 时间 + 只提醒有新通知，不显示发送人和内容」。
`dist` 里也确认含这些文案（见 §2.4），旧文案 `ScanText / readContent / 读取消息内容` 均检索为 -1。

**未实测的部分（原因）**：本轮没有复读「消息页」的 UIA——浮层当前是收起态，进消息页要点右下角铃铛
（或先双击展开浮层），本轮不移动用户鼠标，所以没做。已有的同类证据：dev-fix 在 `63baaa8` 提交信息里记录了
实机 UIA 结果「只见 QQ 通知/微信提醒/暂无通知 等通用文案，无发送人/正文，也没有『读取消息内容』开关」，
并留了截图 `%TEMP%\messages-panel.png`（14:11:59）——**引用，未由我复核**。

**范围边界（不是缺陷，供发布说明写清）**：QQ **邮件**（`qq_mail`）的云朵预览仍带「发件人 + 主题」
（App.tsx:1514），本次隐私改造只覆盖微信/QQ 即时消息；如果产品口径是「所有消息都不显示文字」，那要另开一轮。

---

## 4. 其它观察（不阻断发布）

1. **固定窗取焦后浮层会收起**——这是既有设计（`App.tsx` 的 `onFocusChanged → collapseIsland()`），
   不是本轮回归。测试中观察到收起后浮层一度进入贴边态（`2285,1278,2544,1499`，下沿超出屏幕 59px），
   约 2 分钟后回到 `2285,1203`。未归因（可能是既有「失焦贴边/缩边」行为），建议人工复测时顺手看一眼
   固定窗与浮层贴边的交互；上一轮的 B2 指标（开合 0px 漂移）本轮未复测。
2. `release\` 里现在仍是 **11-14 的 v2.0.2 产物**（安装包 / 便携 zip / SHA256SUMS / latest.json / 4 个插件 zip），
   发布前必须整体重建，否则用户下载到的还是旧版本。
3. 48 个未推送提交里除了本轮 4 项，还包含视频插件 P0 重做、GIF 删除确认、表情方格、聊天流式输出修复、
   多实例启动 P0 修复、设置/浮层回归修复等——**发布说明要覆盖全部**（见 §6 建议要点）。

---

## 5. 发布前必做清单（按顺序）

1. **升版本号（四处同步）**：`package.json` → `src-tauri/Cargo.toml`（并让 `Cargo.lock` 跟着更新）→
   `src-tauri/tauri.conf.json` → `README.md` 徽章。建议 **`2.1.0`**（理由见 §6）。
   **不要只改 `tauri.conf.json`**——安装包版本、应用内更新版本都以它为准。
2. **重建产物**：`pnpm build` → `pnpm tauri build --no-bundle`（如需 NSIS）→ 打包便携 zip；
   更新 `release\` 的 exe / zip / 安装包 / `SHA256SUMS-vX.Y.Z.txt` / `latest.json`（含 `sig`）。
   本机跑 `vite build` 可能被安全软件拦 esbuild 临时文件，必要时用仓库内 `TEMP`/`.tmp-build` 绕开
   （`810b93f` 已把误提交的 `additionalBrowserArgs` 删掉，构建配置现在是干净的）。
3. **产物扫描**：`powershell -File scripts/verify-release-artifacts.ps1 <安装包> <便携 exe>`，
   必须「未发现威胁」；未签名要在发布说明里写明（SmartScreen 会提示）。
4. **30 秒人工冒烟（本轮唯一没拿到的实机项）**：
   - 设置 → 布局 → 表情轮播：拖第 1 张到第 3 张 → 重开面板顺序仍在；「全选现有表情」连点两次数量不翻倍；
   - 浮层 📌 固定 → 最小化固定窗 → 再点 📌 → 恢复且仍置顶；「取消固定」后窗口消失；
   - 消息页（铃铛）：条目只有「QQ 通知 + 时间」「微信有新消息 · 时间」，没有任何发送人/正文；
     设置里「显示消息预览」默认关；
   - （可选）设置里把小狗数量改成 2 只 → 摸主狗看陪玩狗是否跟着动一下。
5. **push 后核对**：`git push` → `git rev-parse --short origin/main` 应等于新 HEAD；打 tag `vX.Y.Z`；
   GitHub Release 附件齐全且 `latest.json` 指向新版本；**旧 Release / tag 不删不改**。

---

## 6. 建议的版本与发布说明要点（供 lead 用，本报告不改版本）

**建议版本：`v2.1.0`**（minor）。

理由：这一轮不是纯修 bug——新增了「多实例联动 MVP」「固定标签页置顶」两个用户可见能力，
并且有**行为变更**（删除微信 OCR、消息预览默认关、旧键清理），按语义化版本应走 minor；
如果只按「修 bug」发 `v2.0.3`，用户升级后会发现「消息不显示内容了」却没有任何版本提示。

**`docs/releases/v2.1.0.md` 建议结构（五段）**：

1. **新增**：多实例联动 MVP（L1 主狗动作传染陪玩狗 / L2 Bongo 敲鼓呼应，设置里「实例联动」默认开，
   概率 60%、单次最多 2 只、同动作 1.5s 冷却、每秒最多 4 次）；📌 固定当前标签页到桌面（置顶窗口，
   支持聊天/待办/音乐/快捷，首次固定直接落到你当前所在的标签）。
2. **修复**：表情轮播拖拽「拖不动」（改为容器级指针捕获 + 松手重新测量落点 + 写回校验）；
   「全选现有表情」重复追加（键归一化后只补缺，历史重复项自动清理）；固定标签页点了没反应/页面回落
   默认聊天（`PINNED_PAGE` + `get_pinned_page`、unminimize→show→置顶→聚焦）。
3. **隐私变更（重点提示）**：微信/QQ 改为**只提醒、不显示文字**——删除 OCR 链路，通知的发送人/正文
   只留在 Rust 内部用于判新旧，**不序列化、不写日志、不进 localStorage**；旧设置项
   「读取消息内容」不再生效并会被清理；新增「显示消息预览」开关，**默认关**，打开也只显示
   「来源 + 有新消息」。（QQ 邮件预览行为未变。）
4. **体验**：视频插件面板精简（首屏 6 个控件、开始看在第一行、高级设置折叠、失败原因常驻中文提示）；
   聊天回复改流式；GIF 删除需二次确认并支持撤销；表情轮播改方格展示。
5. **已知问题 / 校验**：拖拽排序与消息面板建议升级后各自点一次确认；产物 SHA-256 与 `latest.json`
   见附件；未做代码签名，SmartScreen 可能提示「未知发布者」。

**建议 tag/Release 附带**：`SHA256SUMS-v2.1.0.txt`、安装包 `.sig`、`latest.json`、便携 zip、
四个插件 zip（billiards / video-automation / relationship / hello-world），与 `docs/releases/v2.1.0.md` 一致。

---

## 7. 回滚与提交

| 提交 | 内容 | 回滚 |
| --- | --- | --- |
| `810b93f` | GIF 拖拽容器化 + 去重 + 移除调试端口参数 | `git revert 810b93f` |
| `849d653` | 置顶修复（`PINNED_PAGE`/`get_pinned_page`/unminimize+置顶） | `git revert 849d653`（同提交还含聊天头像打包，回滚会一并撤） |
| `551a456` | 文档 | 无需回滚 |
| `04bba26` | 多实例联动 MVP | `git revert 04bba26`（开关默认开会随之消失） |
| `63baaa8` | 隐私只提醒 + 删 OCR | `git revert 63baaa8`（旧 OCR 链路会回来；不建议在发布后再回滚） |

本轮验证没有产生任何源码改动；报告单独提交。

---

_报告生成：2026-11-17 14:22（+0800），delivery-verify。只读验证：未改用户设置、未移动鼠标、
未登录任何账号、未发评论；未 push、未改版本号。_