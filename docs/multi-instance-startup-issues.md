# 启动失败与多实例问题诊断

> 记录时间：2026-11-16
> 范围：Windows 实机、`src-tauri` 调试构建（`target/debug/maltese-assistant.exe`）与 `pnpm tauri dev`。
> 目标：解释“桌宠不出现 / 页面空白 / 同机出现两个实例”的成因，给出可拆分实施的重构方案。

## 1. 现象

本轮实机测试中反复出现以下组合：

| # | 现象 | 观测方式 |
| --- | --- | --- |
| 1 | 启动后进程存在、CPU 有占用，但桌面看不到桌宠 | `EnumWindows` 能找到主窗口，`IsWindowVisible=False`，rect 停在 `(104,104) 1920×1059` 等默认级联位置 |
| 2 | 日志反复出现 `failed to size and position island window: runtime error: failed to receive message from webview` | 调试构建 stderr |
| 3 | 页面显示 `localhost` 连接错误或整片空白；设置、气泡、聊天等窗口也加载不出来 | 强制显示主窗口后截图 |
| 4 | 同一个 exe 换独立 `WEBVIEW2_USER_DATA_FOLDER` 后，13 个 Tauri 窗口全部能加载正确页面，桌宠正常显示 | 对照实验 |
| 5 | 用户机器上已安装的 `E:\Maltese2\maltese-assistant.exe`（0.2.3）一直能正常显示 | 用户桌面实拍 |
| 6 | 测试开始前，用户桌面已有两个旧测试进程同时存在 | `Get-Process` 观测 |
| 7 | 剪贴板历史偶发 `failed to store clipboard history item: ... 拒绝访问。 (os error 5)` | stderr |
| 8 | DSH API 固定监听 `127.0.0.1:3218`；第二个实例会抢同一端口，失败只打印一行 | stderr |

**重要限定**：本轮失败进程是 agent 沙箱启动的调试构建，默认 WebView2 profile 的写权限/占用状态与用户双击安装版不同。不能据此断言“用户双击也必然失败”；但它把启动链路上的**结构性弱点**暴露得很清楚，且第 4 条对照实验说明代码本身能跑，问题集中在实例/profile/启动时序。

## 2. 当前启动链路

```text
双击 / tauri dev
  ↓
Tauri Builder
  ├─ register_uri_scheme_protocol (maltese.localhost)
  ├─ tauri-plugin-single-instance
  │    └─ 第二实例回调：show_island(app)
  ├─ setup()
  │    ├─ build_tray / sync_startup_path
  │    ├─ clipboard_history::init
  │    ├─ desktop_icons::restore_desktop_on_startup
  │    ├─ 快捷键 / video / dsh_api::init(127.0.0.1:3218)
  │    ├─ QQ / 微信 / 通知诊断
  │    ├─ apply_stage_geometry(main, default, false)   ← 失败只 eprintln
  │    └─ start_cursor_passthrough_loop
  ↓
13 个窗口（全部 visible:false）各自创建 WebView2，加载 index.html?window=...
  ↓
main 窗口前端执行 syncNativeInteraction(...).finally(showReadyIsland)
  ↓
showReadyIsland：等 2 帧 rAF / 字体 / GIF decode（各有超时）
  ↓
invoke("show_ready_island") → Rust show_island
  ↓
show_island：apply_stage_geometry(读 inner_size/current_monitor/primary_monitor)
  ├─ 成功 → window.show() → set_always_on_top → set_focus
  └─ 失败（旧代码 `?`）→ 直接 return，window.show() 永远不执行
```

关键代码位置（当前工作树，2026-11-17 修复后行号已变动，以第 8 节为准）：

- `src-tauri/src/lib.rs:2951` `show_island`
- `src-tauri/src/lib.rs:3037` `apply_stage_geometry`
- `src-tauri/src/lib.rs:1202` `show_ready_island`
- `src-tauri/src/lib.rs:3994` single-instance 插件
- `src-tauri/src/lib.rs:4019` `setup`
- `src-tauri/tauri.conf.json` 13 个窗口，`main` 为 `visible:false / transparent / skipTaskbar / alwaysOnTop / 640×540`
- `src/App.tsx:528` `waitForFirstPaint`
- `src/App.tsx:554` `waitForPetGif`
- `src/App.tsx:6476` `showReadyIsland`
- `src/App.tsx:8874` `syncNativeInteraction(...).finally(showReadyIsland)`
- `src-tauri/src/dsh_api.rs:27` `DEFAULT_PORT = 3218`，bind 失败仅 eprintln
- `src-tauri/Cargo.toml:45` `tauri-plugin-single-instance = "2"`

## 3. 根因分层

> 2026-11-17：下列根因中可修的部分已按 P0 / P1 处理（C、D、E 的端口与剪贴板、F、A 的实例身份），
> 实施细节与未做项见第 8 节；本节保留诊断时的原始描述。

### A. 实例身份不唯一：single-instance 只挡“同一个 identifier”

`tauri-plugin-single-instance` 的互斥键由应用 identifier 派生。当前 `tauri.conf.json` 是 `com.maolouis.maltese`，`setup` 之前还有一段：

```rust
if let Some(identifier) = notification_diagnostics::verification_identifier() {
    context.config_mut().identifier = identifier;
}
```

也就是说，某些验证/诊断环境变量可以把 identifier 改掉；不同构建（例如安装版、调试版、验证包）如果 identifier 不一致，single-instance 不会把它们视为同一应用，结果是**两个进程都启动、都建 tray、都抢同一份用户数据**。第 6 条“两个旧进程并存”与此吻合。

即使 identifier 相同，single-instance 的回调也只做 `show_island(app)`：

- 没有把第二实例的命令行参数转交给首实例；
- 没有确认首实例窗口是否已经 ready；
- 没有告诉第二实例“你已经该退出了”；
- 第二实例仍在启动早期，如果首实例的 webview 尚未握手，`show_island` 里的几何调用会失败，第二实例又可能继续初始化托盘/快捷键/端口。

### B. WebView2 profile 所有权没有显式建模

默认 profile 在 `%LOCALAPPDATA%\com.maolouis.maltese\EBWebView`。当前代码没有：

- 启动时检查 profile 是否已被其它进程占用；
- 使用 per-instance 锁文件 / named mutex；
- 在 profile 不可写时给出可见错误，而不是继续用坏状态启动；
- 对 dev / 测试 / 安装版分配不同 profile 目录。

于是出现：

- 一个进程持有 profile，另一个进程的 WebView2 握手失败，页面停在 `localhost` 错误或空白；
- 强制结束进程后，`msedgewebview2.exe` 子进程/LevelDB LOCK 可能残留，下一次启动继续失败；
- agent 沙箱下默认 profile 写权限受限时，表现与“用户配置被清空”非常像：页面进入首启向导、设置是默认值，但真实 profile 其实没被删。

### C. 窗口显示被绑在“webview 同步 IPC 成功”上

`apply_stage_geometry` 里这些调用都依赖 WebView2 消息循环：

- `window.inner_size()`
- `window.scale_factor()`
- `window.current_monitor()`
- `window.primary_monitor()`
- `window.set_size()` / `set_position()`

WebView2 未完成握手时，它们返回 `failed to receive message from webview`。旧代码用 `?` 把错误冒泡到 `show_island`，`window.show()` 永远不会执行——窗口保持 `visible:false`，但进程、托盘、日志都在，用户看到的就是“启动了但没有狗”。

本轮已提交的 `038067a` 把几何失败降级为日志、继续 `window.show()`，解决了“几何失败直接阻断 show”的这一层；但**没有解决 WebView2 本身握手失败**，后者仍会让页面空白。

### D. 13 个窗口在启动时同时创建、同时加载

`tauri.conf.json` 配了 13 个窗口（main / translation / bubble / settings / companion-1..4 / bongo-pet / cursor-pet / plugin / billiards / pinned），全部 `visible:false`，但**创建即加载**。冷启动时：

- 13 个 WebView2 实例并发初始化；
- 每个都加载 `index.html?window=...`，前端 bundle 各自执行；
- 主窗口的首帧、GIF decode、`syncNativeInteraction` 被其它窗口争抢 CPU/IO；
- 任何一个窗口加载失败，都会在日志里留下噪音，排障时很难区分“主窗口失败”还是“某个隐藏窗口失败”。

这不是桌宠不显示的直接原因，但会显著放大冷启动时间和握手失败概率。

### E. 共享资源没有单一所有者

| 资源 | 现状 | 多实例后果 |
| --- | --- | --- |
| WebView2 profile | 固定 `EBWebView` | 第二实例握手失败、页面空白 |
| DSH API | 固定 `127.0.0.1:3218`；bind 失败只 eprintln | 第二实例的 API 静默不可用；调用方不知道连到哪个实例 |
| `clipboard-history.json` | `%APPDATA%\com.maolouis.maltese\clipboard-history.json` | 并发写同一文件；曾出现 `os error 5` |
| 托盘 / 全局快捷键 | 每个实例都注册 | 重复图标、热键冲突、互相抢焦点 |
| 自启项 | `sync_startup_path` 每个实例都写 | 后启动的实例可能覆盖前一个路径 |
| 桌宠位置/窗口状态 | 每个实例都读同一 localStorage | 两个实例互相把对方位置改掉 |

### F. 前端 show 链没有重试

`showReadyIsland` 先把 `didShowInitialWindow.current = true`，再 `await` 首帧和 GIF；如果 `invoke("show_ready_island")` 抛错，它只 `console.error`，**不会重试**，而且标记已经置位，后续 effect 也不会再触发 show。

这意味着只要第一次 `show_ready_island` 失败（webview 未握手、几何失败、窗口被销毁等），本次进程就永久没有桌宠，除非用户重启。

## 4. 重构方案

建议按 P0 → P3 分四步，避免一次性大改。

> **实施状态（2026-11-17）**：P0 三条、P1 四条已实现，详见第 8 节；P2/P3 未做。
> 下面保留原始方案描述，作为设计依据。

### P0：让“显示”不再依赖几何 IPC（本轮已做一半）

- `show_island` 中几何失败只记录，继续 `window.show()`（已提交 `038067a`）。
- `showReadyIsland` 失败后增加有限重试（例如 3 次，间隔 500ms / 1s / 2s），成功后清标记；仍失败则上报诊断事件。
- `show_island` 成功后用 `window.is_visible()` 校验；不可见则重试一次 `show()` + `set_always_on_top(true)`。
- 在 `show` 之前不要 await 任何可能永久挂起的 Promise；现有 `waitForFirstPaint` / `waitForPetGif` 已有超时，保留。

### P1：实例身份与 profile 所有权

1. **统一 identifier**：`notification_diagnostics::verification_identifier()` 只允许在显式的验证构建中启用，且必须在 single-instance 初始化之前决定；生产构建禁止运行时改写。
2. **named mutex 以“数据目录”为键**，而不是只按 identifier：
   - `Local\Maltese-<sha1(data_dir)>`；
   - 首实例持锁；第二实例发现锁已存在，发送 `show` 命令后退出。
3. **profile 锁文件**：启动时在 profile 目录写 `instance.lock`（PID + exe path + start time）；发现锁存在且 PID 存活 → 走 single-instance handoff；PID 已死 → 清理 stale lock。
4. **profile 不可写/被占用时给出可见错误**：弹一个原生 MessageBox 或错误窗口，说明“另一个 Maltese 正在使用数据目录 / 请关闭旧进程”，不要静默进入首启向导。
5. **dev / 安装版 / 测试版分目录**：
   - 安装版：`%LOCALAPPDATA%\com.maolouis.maltese\EBWebView`
   - dev：`%LOCALAPPDATA%\com.maolouis.maltese-dev\EBWebView`
   - 测试：显式 `MALTESE_PROFILE_DIR`
   这样 `pnpm tauri dev` 永远不会碰用户真实配置。

### P2：启动状态机与窗口懒加载

把“创建 → 加载 → ready → 几何 → show”做成显式状态机：

```text
AppStarted
  → InstanceLockAcquired
  → WebViewCreated(main only)
  → WebViewReady(DOMContentLoaded / 前端 ready IPC, timeout 5s)
  → GeometryApplied(retry 0/200/500ms, 最多 3 次)
  → Visible
  → SecondaryWindowsLazy
```

具体：

- **只创建 main 窗口**；settings / bubble / plugin / billiards / companion 等按需 `WebviewWindowBuilder` 懒创建，或至少在 main `Visible` 后再创建。
- 前端在 `DOMContentLoaded` 后立即 `invoke("frontend_ready")`，不等待 `syncNativeInteraction`；Rust 收到 ready 后再做几何 + show。
- `apply_stage_geometry` 拆成“纯计算”和“应用”两段：纯计算只依赖传入的 monitor 快照，不调用 webview IPC；应用失败可重试。
- 增加 watchdog：启动后 8s 内没有 `Visible`，强制 `show()` + 默认几何，并写诊断日志。
- `main` 窗口的 `visible:false` 保留，但增加 `--force-show` / 安全模式：跳过几何、直接显示在屏幕中央，用于排障。

### P3：共享资源单一所有者 + 可观测性

- DSH API：bind 失败时不要只 eprintln；把实际端口写入 `dsh-api-port` 文件，或让第二实例直接复用首实例端口；调用方读文件而不是硬编码 3218。
- 剪贴板历史：单实例写，或加文件锁 + 原子替换（写 temp → rename）；失败重试 3 次并降级到内存。
- 托盘/快捷键/自启：只在首实例注册；第二实例不初始化这些模块。
- 增加 `startup.log`（滚动）记录：pid、exe path、identifier、profile path、single-instance 结果、webview ready 时间、几何重试次数、show 结果。
- 设置页增加“诊断”入口：显示当前实例 PID/profile/端口/窗口可见性，支持一键复制日志。

## 5. 验收标准

重构后至少跑完以下用例：

1. **冷启动 20 次**：桌宠 20/20 在 8s 内可见；允许有几何微调，但不允许永久 `visible:false`。
2. **双开**：先启动实例 A，再启动实例 B；B 必须在 2s 内退出，A 的桌宠被带到前台；任务管理器只剩一个 Maltese 进程。
3. **不同 identifier 的双构建**：人为把调试包 identifier 改成 `com.maolouis.maltese.dev`，与安装版同时启动；两者应使用不同 profile，不互抢；若产品上不允许，应在文档/构建脚本中明确禁止。
4. **profile 被占用**：用工具锁住 `EBWebView` 目录，启动应显示可读错误，而不是进入首启向导。
5. **devUrl 未启动**：`pnpm tauri dev` 在 vite 未起时，应显示“前端未启动”的错误窗口，而不是空白。
6. **端口占用**：先占用 3218，再启动；DSH API 应报告实际端口或明确失败，不能静默。
7. **强制结束恢复**：任务管理器结束进程后立即重启，不应被 stale lock / 子进程阻塞。
8. **13 窗口懒加载**：启动时只创建 main；打开设置/插件/台球时才创建对应窗口，冷启动时间应明显下降。

## 6. 2026-11-16 实机验证记录

本轮在 Windows 实机用**独立 WebView2 profile**（`WEBVIEW2_USER_DATA_FOLDER`）+ CDP 验证，不写默认 profile：

- debug exe 启动后 13 个窗口全部加载，WebView2 页面地址均为 `http://localhost:1420/...`，包括 `main / settings / bubble / translation / pinned / plugin / billiards / bongo / cursor / companion 1–4`。
- 首轮（最终清理前）设置页实际窗口 `560×780`；表情轮播墙展开后 244 个格子、8 列、31 行，行高 `50.25px`，`grid-auto-rows: max-content` 生效；页面 275 张图片全部 `naturalWidth=240`，0 张加载失败。
- 主窗口桌宠实际加载 `xiaobai/sleep/p19-7.gif`（240×240），点击后切换到另一张 sleep GIF，说明归位后的素材路径可用。
- **最终清理后复测**（`shared` 152 张 / 总 779 张）：13 个窗口全部加载；设置页轮播墙 243 张 GIF；主窗口加载 `xiaobai/sleep/p12-8.gif`（240×240，`complete=true`），截图见 `work/settings-wall-live-final.png`、`work/pet-live-final.png`。
- **注意**：`src-tauri/target/debug/assets` 是上一次构建时的素材副本，不会随 `assets/` 里的文件移动自动更新；只跑 `npm run build` 后直接启动旧 debug exe 会看到旧路径 404。实机测试前需重新 `cargo build` / `tauri build`，或把当前 `assets/` 同步到该目录。生产打包会通过 `bundle.resources` 复制当前素材。

## 7. 待确认

- `notification_diagnostics::verification_identifier()` 的环境变量来源与使用场景（哪个构建/脚本会设置）。
- 用户机器上两个旧进程分别来自哪个构建（安装版 / 旧 debug / 测试包），需要 `Get-Process` + `Path` 才能定论。

## 8. 修复实施记录（2026-11-17）

本轮按 P0 → P1 顺序落地 7 项，全部只做**本地提交**：没有 `git push`、没有打 tag、没有改版本号
（`package.json` / `tauri.conf.json` / `Cargo.toml` / README 徽章均未动）。

### 8.1 P0（显示链路）

| 条目 | 状态 | 实现 |
| --- | --- | --- |
| P0-1 显示与几何解耦 | ✅ 已修复 | `src-tauri/src/lib.rs` 的 `show_island`：几何失败只 `eprintln`，`window.show()` 必定执行；show 后校验 `is_visible()`，不可见时在后台线程按 6 × 150ms 重试 `show()` + `set_always_on_top(true)`；`set_focus` 失败不再让整个命令失败；`hide_island` 会复位 `ISLAND_SHOWN`。 |
| P0-2 前端 `showReadyIsland` 重试 | ✅ 已修复 | `src/App.tsx`：`didShowInitialWindow` 只在 `invoke("show_ready_island")` 成功**且** `getCurrentWindow().isVisible()` 为真后置位；失败按 5 × 300ms 重试；重试期间 `showReadyIslandInFlight` 防止叠加；全部失败不置位，后续 effect 仍能再次触发（不再“一次失败 = 永久没有桌宠”）。 |
| P0-3 `frontend_ready` 握手 | ✅ 已修复 | 新增命令 `frontend_ready`（Rust 记录首次就绪时间；若窗口还没显示则执行几何 + show）。前端在 App 挂载后等 `waitForFirstPaint()` + `waitForPetGif()`，再 `invoke("frontend_ready")`，**不经过** `syncNativeInteraction`；`show_ready_island` 保留为兜底，并在 `ISLAND_SHOWN` 为真时直接返回，避免二次抢焦点。 |

### 8.2 P1（实例身份、窗口、共享资源）

| 条目 | 状态 | 实现 |
| --- | --- | --- |
| P1-4 窗口懒加载 | ✅ 已修复 | `src-tauri/tauri.conf.json` 只保留 `main`；新增 `src-tauri/src/window_factory.rs`，集中维护其余 12 个窗口的创建参数（与旧 config 逐项对应）并提供 `ensure()` / `ensure_if_known()`。settings / translation / plugin / billiards / pinned / bubble / companion-1..4 / bongo-pet / cursor-pet 全部改为第一次需要时用 `WebviewWindowBuilder` 创建；`capabilities/default.json` 补上 `billiards` / `pinned` 两个 label，保证懒创建出来的窗口有 IPC 权限。默认配置（1 只狗、Bongo 关闭、不跟随鼠标）启动时只创建 main 一个 WebView。 |
| P1-5 单实例加固 | ✅ 已修复 | 新增 `src-tauri/src/instance_lock.rs`：在 Tauri Builder **之前**对 `<app_data_dir>/instance.lock` 做 `File::try_lock()`（Windows 下是 `LockFileEx`），键是应用数据目录（= WebView2 profile 目录）。第二实例写 `<app_data_dir>/show-request` 后立即退出、不创建任何 WebView；首实例的监听线程（400ms 轮询）收到后调用 `show_island`（show + unminimize + focus + 置顶 + 可见性重试）。`instance.lock` 同时写入 PID / exe / identifier / dataDir 供排障；正常退出清空，崩溃残留不影响下次启动（锁随句柄释放，没有 stale lock）。single-instance 插件的回调也改为走同一条“带到前台”链路。 |
| P1-6 DSH API 端口 | ✅ 已修复 | `src-tauri/src/dsh_api.rs`：首选 3218 被占用时按 3218..=3237 顺延绑定；实际端口写入 `<app_data_dir>/dsh-api-port.txt`（启动时先删旧文件，避免调用方连到死端口）；`Host` 校验改用**实际端口** `active_port()`（旧实现每个请求重新读环境变量，回退后会把自己正常的请求判成 403）。全部端口都失败时打印明确错误并保持文件不存在。 |
| P1-7 剪贴板并发写 | ✅ 已修复 | `src-tauri/src/clipboard_history.rs` 的 `persist_locked` 改为 `write_history_atomically`：同目录写临时文件 → `rename` 原子替换，写临时文件与替换各重试 6 × 40ms，仍失败才退回直接覆盖；既避免 `os error 5`（文件被占用），也避免并发读看到半截 JSON。 |

### 8.3 未修复 / 未做（明确记录）

- **P1.1 identifier 运行时改写**：`FOCUSD_VERIFY_NOTIFICATIONS` 仍可在 `run()` 里覆盖 identifier。现在按数据目录加锁，验证构建使用自己的数据目录，与正常实例互不阻塞；要“生产构建彻底禁止”需要编译期开关（`cfg!`/feature），本轮未做。
- **P1.3 独立 profile 锁文件检测**：用 `instance.lock` 的文件锁代替“写 PID 再探测”，语义等价且没有 stale 状态；没有再单独做 PID 存活探测。
- **P2 启动状态机 / 8s watchdog / `--force-show` 安全模式**：未做。
- **P3 startup.log / 设置页诊断入口 / 第二实例完全不初始化托盘快捷键**：未做；单实例锁已经把“两个正常实例同时注册托盘/热键”的触发面收窄到异常情况。
- **实机验收**：agent 环境只能做编译级验证（`cargo check` / `tsc` / Node 单测），第 5 节的 8 条实机用例（冷启动 20 次、双开 2s 退出、profile 被占用、3218 被占用、强制结束恢复、13 窗口懒加载冷启动对比）需要在 Windows 实机回归。

### 8.4 验证结果

```text
node node_modules\typescript\bin\tsc --noEmit     → exit 0
cargo check（src-tauri）                           → exit 0（仅既有 warning）
node --test tests/*.test.mjs                      → tests 58 / pass 58 / fail 0
```

### 8.5 影响面与回滚

- 懒加载后第一次打开设置 / 翻译 / 插件 / 台球 / 固定页 / 气泡会多一次 WebView 创建耗时（之后复用），这是用冷启动时间换首屏稳定性的预期取舍。
- 双开行为变化：第二个进程现在更早退出（不再创建窗口/托盘），只留下一次 `show-request`。
- 需要回滚某一条时按文件定位：P0 集中在 `src-tauri/src/lib.rs` 的 show 链路（`show_island` / `show_ready_island` / `frontend_ready`）与 `src/App.tsx`；P1 集中在 `src-tauri/src/{window_factory,instance_lock}.rs`、`dsh_api.rs`、`clipboard_history.rs`、`tauri.conf.json`、`capabilities/default.json` 以及各窗口打开命令。`tauri.conf.json` 的窗口列表和 `window_factory.rs` 必须成对回滚，否则窗口不会被创建。
