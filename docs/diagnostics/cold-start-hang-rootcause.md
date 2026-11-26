# 冷启动间歇卡死：根因定位报告

> 排查对象：`E:\Maltese2\maltese-assistant.exe`（v2.0.x，SHA-256 `65325EDB…DE393AB`，与
> `src-tauri/target/release/maltese-assistant.exe` 逐字节相同，符号可用）。
> 现象：冷启动停在 `[startup] step=setup:island_ready +~400ms` 之后、前端首帧之前，
> `Responding=False`、CPU ≈0.2–0.3s、51–52 线程。
> 排查日期：2026-11-20 23:33–23:41。**本轮未修改任何 `src-tauri/**` 代码**（只新增本报告与 `tools/` 下的诊断脚本）。

---

## 1. 结论（TL;DR）

| 层级 | 结论 | 置信度 |
| --- | --- | --- |
| **卡在哪一类** | 主线程（UI 线程）**永久阻塞在 Rust 标准库同步原语的 futex 等待上**（`WaitOnAddress` / `ZwWaitForAlertByThreadId`），即被一把已被占用的 `std::sync::Mutex`（或同等 `Once`/`Condvar`）挡住 | **确定**（有 minidump 栈证据） |
| 卡死的性质 | 是**死锁级永久等待**，不是慢 IO、不是死循环、不是 WebView2 初始化失败 | **确定**（CPU 14s 只涨 0.06s，线程全部 parked；watchdog 的 `window.show()` 永不返回） |
| 具体是哪一把锁 | 最可能是**窗口状态/几何缓存那组 `std::sync::Mutex`**（`WINDOW_STATE`、`LAST_SETTLED_ISLAND_RECT`、`PRE_MINIMIZE_ISLAND_RECT`、`PINNED_LAST_SET`）在主线程事件回调与后台线程之间的锁序冲突或主线程自锁；次可能是 `OnceLock::get_or_init` 首次初始化竞争（`tauri::async_runtime` 等） | **最可能**（回归到具体实例需下一轮加日志，见 §5/§6） |
| 与 `island_ready` 的关系 | `island_ready` 是 `setup` 里**最后一条**打点；此后主线程只剩"`spawn_startup_watchdog` + 返回 + Ready 派发 + 进消息循环"。卡死点正好落在 **setup 最后一次几何调用引发的窗口事件（`Resized`/`Focused`/`Moved`）开始派发的瞬间** | **确定**（时间窗一致） |

---

## 2. 复现数据

### 2.1 本轮复现（2026-11-20 23:33–23:35，脚本 `tools/cold-hang-repro.ps1`）

每轮：杀进程 → 等 4s → `Start-Process` 冷启动（stderr 重定向）→ 每秒采样 14 次 `Responding/CPU/线程数`
→ 若 `Responding=False` 则 procdump 抓全量 dump（抓完再杀）。

| 轮次 | 结果 | Responding | CPU(累计) | 线程数 | 备注 |
| --- | --- | --- | --- | --- | --- |
| R1 | 正常 | True 全程 | 0.23→0.75 | 62→59 | 有 `frontend_ready` |
| **R2** | **卡死** | **False（t=1s 起）** | **0.27→0.33** | **54→51** | **已抓 dump** |
| R3 | 正常 | True 全程 | 0.30→0.97 | 62→59 | 有 `frontend_ready` |
| R4 | 进程 ~1–2s 内消失 | 消失前 True | 0.22 | 54 | stderr 停在 `setup:island_ready +468ms` 后两条 `STARTUP_SKIP_RECALC`，**无 panic 输出**；WER 无记录。疑似被外部终止，未定论 |
| R5 | 立即退出 | — | — | — | stderr：`another Maltese instance is already using E:\Maltese2\data` → **当时有外部实例在跑**（非本脚本启动），本轮作废 |
| R6 | 正常 | True 全程 | 0.33→0.69 | 62→59 | 有 `frontend_ready` |

> R4/R5 被外部干扰（R5 明确证明有另一个实例在启动），不计入复现率。

### 2.2 历史样本（2026-11-20 20:51–20:52，`work/verify-cold5b.log`，同一 exe）

| 轮次 | Responding | CPU | 线程 | 最后一条 `[startup]` |
| --- | --- | --- | --- | --- |
| cold5b-1 | False | 0.22 | 52 | `setup:island_ready +417ms`（之后仅 `STARTUP_WATCHDOG`） |
| cold5b-2 | False | 0.19 | 51 | `+426ms`（同上） |
| cold5b-3 | **True** | 0.83 | 60 | `frontend_ready +671ms`、`first_interaction +711ms`、心跳 +1/+3/+10s 全有 |
| cold5b-4 | False | 0.20 | 52 | `+403ms` |
| cold5b-5 | False | 0.20 | 51 | `+393ms` |

### 2.3 复现率汇总

| 数据源 | 有效轮数 | 卡死 | 卡死率 |
| --- | --- | --- | --- |
| 历史 cold5b | 5 | 4 | 80% |
| 本轮 | 4（排除 R4/R5） | 1 | 25% |
| **合计** | **9** | **5** | **≈56%** |

与用户"5 次冷启动 4 次卡死"的量级一致；本轮卡死率偏低，可能因为采样间隔里机器状态更凉/更热（见 §3.4 的线程数差异）。

### 2.4 卡死时的确定性指纹（两批样本共 5 次，全部相同）

1. stderr 停在 `[startup] step=setup:island_ready +39x~67x ms`，之后**只有** `STARTUP_WATCHDOG no frontend ready in 8s…`；
2. **永远没有** `[startup] step=watchdog_done`——说明 8s 时 watchdog 线程卡在 `window.show()` 内部（第一句就阻塞），从未走到 `show_island`；
3. **永远没有** `frontend reported first paint ready`；
4. `Responding=False` 且 CPU 只在几秒里涨零点几秒。

---

## 3. 取证与证据

### 3.1 抓包元数据

| 项 | 值 |
| --- | --- |
| dump 路径 | `E:\Maltese\work\hang\hang-r2-233428.dmp`（`work/` 已被 gitignore） |
| 大小 / 时间 | **144,489,453 字节（137.8 MB）** / 2026-11-20 23:34:29 |
| 工具 | `E:\tools\procdump\procdump64.exe` v12.02，`-ma -accepteula`，0.3s 写完 |
| 进程快照 | 51 线程 / 56 模块 / 518 个内存段 |
| 符号 | `src-tauri/target/release/maltese_assistant.pdb`（与 exe 同时间戳 20:36:33，PE TimeDateStamp `0x6b003ed1` 一致） |

> 本机没有 `cdb.exe` / WinDbg / VS，所以自建了 minidump + PDB 解析器（见 §8）来做等价的
> "线程 CONTEXT + 模块表 + 栈扫描 + 公有符号/S_PUB32 + PE `.pdata` 函数边界 + 系统 DLL 导出表"分析。

### 3.2 主线程栈（决定性证据）

主线程 = **tid 16040**（判定依据见 §3.3）：

```
--- tid=16040 susp=0 rip=ntdll.dll!ZwWaitForAlertByThreadId+0x14 rsp=0xbe35f723a8  <== UI THREAD
    [rsp+0x0000] ntdll.dll!RtlWaitOnAddress+0x213
    [rsp+0x0070] KERNELBASE.dll!WaitOnAddress+0x38
    [rsp+0x00b0] maltese-assistant.exe  rva=0x110dee4     ← libstd 的 futex 等待实现
    [rsp+0x0110] maltese-assistant.exe  rva=0x4f65ea      ← 调用 Mutex::lock / get_or_init 的代码
```

读法：系统调用 `ZwWaitForAlertByThreadId` ← `RtlWaitOnAddress` ← `KERNELBASE!WaitOnAddress`
是 Windows 上 **Rust `std`（以及 `parking_lot`）futex 原语**的固定调用链；调用它的 `0x110dee4`
位于 libstd 的 futex 等待函数内，再往上的 `0x4f65ea` 才是业务/框架侧发起 `lock()` 的地方。

即：**主线程不是"在读文件/在等 COM/WinRT"，而是在等一把 Rust 互斥量。**

### 3.3 主线程身份为何可信（排除"测到的其实是隐藏窗口线程"）

卡死时 `Get-Process … | Select Responding` 用 `MainWindowHandle` 判定。卡死样本里这个句柄是：

```
title='com.maolouis.maltese-siw'  class='com.maolouis.maltese-sic'  uiThread=16040
```

这不是岛屿窗口（健康时是 `Maltese 线条小狗桌面助手` / `Tauri Window`），而是
**`tauri-plugin-single-instance` 的隐藏窗口**：插件源码
`tauri-plugin-single-instance-2.4.2/src/platform_impl/windows.rs:56,65` —— 在插件的
`.setup()` 钩子里、用 `format!("{id}-sic")` / `{id}-siw` 创建，**就在主线程**。
所以 `Responding=False` 反映的正是主线程；且与 dump 里 tid=16040 的栈互相印证。

（卡死时岛屿窗口尚未 `show`，故不是"主窗口"；这也解释了为什么句子标题会变成 identifier。）

### 3.4 全进程线程状态（证明"死锁"而非"忙/慢"）

RIP 分布（51 线程，`stacks-r2-all.txt` 统计）：

| 线程数 | 停在 |
| --- | --- |
| **32** | `ntdll!ZwWaitForAlertByThreadId`（futex / `WaitOnAddress` 等待） |
| 6 | `ntdll!ZwWaitForWorkViaWorkerFactory`（线程池空闲） |
| 5 | `win32u!NtUserGetMessage`（消息循环） |
| 4 | `ntdll!ZwWaitForSingleObject` |
| 1 / 1 / 1 | `NtUserMsgWaitForMultipleObjectsEx` / `ZwRemoveIoCompletionEx` / `ZwWaitForMultipleObjects` |

- 14 秒采样内 CPU 只从 **0.27s → 0.33s**（+0.06s）：没有自旋、没有重试循环。
- 线程数从 54 **降到** 51（正常轮 62→59）：说明部分线程在退出，剩下的都停住了。
- 卡死时 `msedgewebview2.exe`（本应用 profile）**有 7 个**子进程（正常轮 7–8 个）→
  **WebView2 运行时与浏览器进程已正常拉起**，卡点不在 WebView2 初始化。
- 正常轮的 `frontend_ready +671ms` 说明健康路径下 `island_ready(+393ms) → 首帧(+671ms)` 这个
  ~280ms 空窗能安全通过；卡死样本的 `island_ready` 反而偏晚（+677ms），空窗里就停住了。

### 3.5 已排除的候选（逐条有证据）

| 候选 | 排除理由 |
| --- | --- |
| WebView2 初始化 / 用户数据目录锁 | 卡死时 7 个 `msedgewebview2` 子进程在位；且 wry 的 webview 在 `setup` 之前就建好（`setup:island_window` 能打印说明 `main_window()` 已 Ok） |
| 前端资源协议阻塞（`web_protocol::respond` 的同步 `std::fs::read`） | 安装目录 `E:\Maltese2\resources` 下**没有 `web/`**，`tauri.conf.json` 是 `frontendDist: ../dist`（内嵌资源）→ 运行时不走 `maltese.localhost`，该 handler 不被调用 |
| 数据迁移 / `paths::ensure_data_root` 的 IO | `DATA_ROOT_READY root=E:\Maltese2\data` 在 **+0ms** 就打印完了，远早于卡点 |
| `dsh_api` bind 3218 | 卡死日志里同样有 `Maltese DSH API listening on http://127.0.0.1:3218`，说明已 bind 成功 |
| 跨进程实例锁 `instance_lock` | 卡死轮都正常进入 `setup`；抢锁失败的路径会直接打印 `another Maltese instance … exiting` 并返回（本轮 R5 就是这种） |
| 托盘 / 全局快捷键注册 | 这些都在 `setup:begin` **之前**（lib.rs:6616-6660），而 `setup:begin` 只有 +330~609ms |
| 慢磁盘 / 慢 IO / CPU 抢占 | CPU 14s 只涨 0.06s，全部线程 parked；若是 IO 会在 8s 内自己走完 |

---

## 4. 根因结论

### 4.1 确定的部分

1. **主线程在 `setup` 返回后被永久阻塞**，阻塞点是一把 **Rust `std` 同步原语**（`WaitOnAddress`
   实现的 `Mutex`/`Once`/`Condvar`）。这不是 Tauri/WebView2 的等待，也不是系统 IO。
2. 因为主线程不再泵消息：
   - Win32 认为进程 "Not Responding"；
   - 任何后台线程调 `window.show()/set_*`（tao 内部要对窗口状态加锁）都会跟着卡住——
     这正是 `STARTUP_WATCHDOG` 之后**没有** `watchdog_done` 的原因，也是"强制 show 无效"的机制；
   - WebView2 的导航/首帧回调全在消息循环里，于是 **前端永远到不了 `frontend_ready`**。
3. 因此"卡在 island_ready 之后、首帧之前"只是**表现**：`island_ready` 是 `setup` 的最后一条打点，
   主线程此后进入 Ready 派发/消息循环，卡死就发生在那里。

### 4.2 最可能的具体位置

时间窗与代码结构都指向**启动期几何链路收尾 → 窗口事件回调开始派发**这一段：

- `setup` 里最后一次几何调用是 `restore_island_rect_on_startup` + `apply_stage_geometry`
  （lib.rs:6664-6668），它们会 `set_position/set_size/show`，**排队**出一批窗口事件；
- `setup` 返回后主线程立刻处理这批事件，进入 `on_window_event`（lib.rs:6560-6614）：
  `Resized | Focused` → `sync_minimize_geometry`（lib.rs:6594-6598）→
  `remember_settled_island_rect` → `LAST_SETTLED_ISLAND_RECT.lock()`（lib.rs:1462）；
  `Moved` → `record_dragged_position` + `persist_island_snapshot`（lib.rs:6601-6610）；
  `pinned` 分支 → `PINNED_LAST_SET.lock()` / `PINNED_MANUAL_POSITION.lock()`（lib.rs:6576-6585）；
- 同一批状态还被后台线程访问：`apply_stage_geometry`（lib.rs:5220+/5479，命令线程与 setup 都会调）、
  `start_island_drag` 线程末尾的 `window_state().lock()`（lib.rs:1819）、
  `desktop_extras` 的 1s/3s/6s 重同步线程（lib.rs:6629-6638，会 `set_size/set_position/show`，
  `desktop_extras.rs:192-243`）以及 `OVERLAY_*`/`PET_SLOT_*`/`USER_ISLAND_SIZE` 等缓存锁。

**锁序冲突（ABBA）形态**：
```
主线程：  事件回调里 lock(状态锁)            ← 卡住（dump 证据）
后台线程：lock(同一状态锁) → 调 window.set_*() → 等主线程泵消息
```
或**主线程自锁**形态：
```
主线程： lock(状态锁) → 调 window.set_*() → tao 同步回调 on_window_event → 再次 lock(同一把锁) → 卡住
```
两者都会产生完全一样的 dump 指纹（主线程在 futex 上），也与"间歇性"吻合——它取决于
"几何调用产生的窗口事件"与"1s 定时器/拖拽/命令线程"是否在同一个几十毫秒窗口里相撞。

### 4.3 尚未定论的部分（诚实说明）

**具体锁实例还差一步。** 原因三条：

1. release 构建的 PDB **只有公有符号**（36,063 个 S_PUB32，无 S_GPROC32/DWARF，`.pdata` 里 78,413
   个函数只有 28,532 个带名字）；关键返回地址 `rva=0x4f65ea` 落在**无公有符号的片段**里，
   无法直接映射成函数名；
2. dump 里主线程的 futex 地址 `0x22d8805c3a0`（堆上，说明锁对象在 `Arc<Mutex<…>>` 或结构体里）
   **在其余 50 个线程的栈/寄存器里都找不到引用**——这既可能是"自锁"，也可能是"持锁线程的引用已
   不在被 dump 的栈范围内"；
3. tao/tauri 自身也有 `WindowState` 锁；主线程持锁时后台线程任何窗口 API 都会卡住，这层干扰无法
   仅凭 dump 区分。

→ 需要下一轮**只加日志**的探针（§6），即可在 1 个卡死样本内定到具体锁与持锁线程。

---

## 5. 候选阻塞点排序 + 验证方法

> 排序依据：dump 证据（Rust futex）+ 卡死时间窗 + 代码里"主线程与后台线程共享同一把锁"的分布。

| # | 候选阻塞点 | 可能性 | 代码位置 | 验证方法（只加日志/只读） |
| --- | --- | --- | --- | --- |
| **A** | `WINDOW_STATE: OnceLock<Mutex<IslandWindowState>>` 上的锁序冲突/自锁 | **高** | lib.rs:121、5196-5209（`window_state()/read_window_state()/mutate_window_state`），调用点 lib.rs:394/440/651/744/1671/1731/1777/1819/1859/1974/3036/3048/3075/5342/5810 | 在每个 `lock()` 前后打 `[lock] window_state enter/exit tid={:?} at {line}`；并加 `on_window_event` 入口打点。卡死时"有 enter 无 exit"的 tid 即持锁者；若 tid 与主线程相同 → 自锁 |
| **B** | `LAST_SETTLED_ISLAND_RECT` / `PRE_MINIMIZE_ISLAND_RECT` / `PINNED_LAST_SET` / `PINNED_MANUAL_POSITION` 在 `on_window_event` 里被主线程锁、同时被几何线程锁 | **中高** | lib.rs:134-135、1462/1475/1503、3383/3496/3503、6576-6585 | 同上，逐个锁加 enter/exit 打点；或用 `try_lock` 探针（下条） |
| **C** | 主线程在持锁状态下调用 `window.set_position/set_size/show`，tao 同步回调再次进入 `on_window_event` → 同线程重入同一把 `Mutex` | **中高** | lib.rs:1500-1501、1799、1849、6665、6668 | 给 `on_window_event` 加 `thread_local!` 递归深度计数（只计数不改逻辑）；卡死时同 tid 深度 ≥2 即确诊 |
| **D** | `OnceLock::get_or_init` 首次初始化竞争（`tauri::async_runtime` / `paths::data_root` / `TRAY_HANDLE` 等）。`Once` 也走同一个 futex | **中** | PDB 符号：`0x10e710`（async_runtime）、`0x10dff0`（paths::data_root）、`0x10e810`（TRAY_HANDLE）；使用点 lib.rs:6622/6631/6671 | 在 `spawn_startup_watchdog` 前后、各 `init()` 前后打 `[once] xxx enter/exit`；watchdog 线程在 8s 时 `try` 探测这些 `OnceLock` 是否 still-uninitialized |
| **E** | `desktop_extras`（`LAST_CONFIG` + `sync_extras_now` 的 `set_size/set_position/show`）与主线程交互 | **中低** | desktop_extras.rs:33/160/164/192-243；调用点 lib.rs:6629-6638 | 在 `last_config()` 前后、`sync_extras_now` 首尾打点。**注意**：卡死样本里 `[monitor] extras sync` 从未打印，但这**不能当证据**——前端没 ready 时 `LAST_CONFIG` 本来就是 `None`，健康轮打印是因为前端已把配置推上来 |
| **F** | `OVERLAY_REQUEST_LOCK`（`Mutex<()>`，lib.rs:1919）等请求级串行锁与浮层流程 | **低** | lib.rs:1919 及 `OVERLAY_SNAPSHOT/PLANNED_OVERLAY`（1201/2067/2103/2386/2409/2472） | 启动期这些路径不该被触发（前端未 ready），若探针显示被锁 → 说明有后台预取/恢复逻辑在跑 |
| **G** | `PET_SLOT_MEASURE(S)` / `USER_ISLAND_SIZE` / `BUBBLE_PAYLOAD` 等纯缓存锁 | **低** | lib.rs:1126-1144、1225-1228、5254-5259、2651/2996 | 同 A 的打点方式 |

**推荐的统一探针（下一轮实现，纯日志）**

在 `setup` 末尾（`island_ready` 之后）起一个**独立线程**，每 500ms 记录一次
"主线程是否还活着"（向主线程 `postMessage` 一个自定义窗口消息并等回执，或
`run_on_main_thread` 投递一个自增计数器），并 `try_lock` 上面 A/B/D 的每一把锁：

```
[t] main_thread_alive=true/false
[t] try_lock WINDOW_STATE => Ok/WouldBlock
[t] try_lock LAST_SETTLED_ISLAND_RECT => Ok/WouldBlock   (Ok 示例：说明没被占)
```

卡死时"`main_thread_alive=false` + 哪把锁 `WouldBlock`"就一次性给出答案，而且**不改任何业务逻辑**
（探针拿到 `Ok` 后立即释放，不改变行为）。

---

## 6. 修法建议（本轮不改代码，仅方案）

按代价从低到高、收益从高到低排序：

1. **禁止"持锁调窗口 API"**（治本，改动小）
   全仓审计 `mutate_window_state(|s| …)` / 各 `xxx.lock()` 的作用域：**任何 `window.set_*/show/hide/emit`
   调用都必须在 guard 释放之后**。缓存类状态（`LAST_SETTLED_ISLAND_RECT` 等）尤其容易写错。
   预期：若根因是 A/B/C，卡死率 → 0。

2. **缓存锁改 `try_lock` + 跳过**（治本且低风险）
   `LAST_SETTLED_ISLAND_RECT`、`PRE_MINIMIZE_ISLAND_RECT`、`PINNED_LAST_SET`、`LAST_PERSISTED_RECT`
   都只是"记忆值/缓存"：`try_lock()` 失败就跳过本次读写，语义完全等价（下次事件会再来）。
   这样即使别的线程短时持锁，主线程也**永远不会**被它们阻塞。
   预期：把"可能永久卡死"降级为"偶尔少记一次位置"。

3. **窗口事件回调里不做事，只置脏标记**（治本，改动中等）
   `on_window_event` 只做 `AtomicBool` 置位；真正的几何计算交给单一"几何线程"串行执行，
   主线程仅执行 tao 要求的 UI API。这样彻底消除跨线程持锁调窗口 API 的可能。

4. **启动期去掉 extras 的 1s/3s/6s 重同步**（降低竞态窗口）
   改成"`frontend_ready` 之后再启动"或"首帧后延迟 1.5s 起"，并且在启动静默期（前 800ms）不调
   `set_size/set_position/show`。预期：显著降低相撞概率（若 1 不修，也能把 80% 降到很低）。

5. **watchdog 不再阻塞自己**（可观测性兜底）
   `spawn_startup_watchdog`（lib.rs:157-171）里的 `window.show()` / `show_island()` 改为
   `app.run_on_main_thread(|| …)` 异步投递，并给整个 watchdog 加超时；这样主线程即使卡死，
   watchdog 仍能打印"主线程未响应"并抓 dump/重启，而不会自己也被卡住（现在它卡住导致
   `watchdog_done` 永不出现，把现场信息也一起丢了）。

6. **主线程存活看门狗 + 自动重启**（用户体验兜底，需产品确认）
   启动完成后由后台线程每 2s 探活主线程；连续 10s 无响应则记录 dump 后 `std::process::exit`
   并由安装器/计划任务/`RunOnce` 重新拉起。桌宠类应用可接受，且能避免用户看到"假死的小狗"。

7. **（可选）把 `OnceLock` 初始化提前到单线程阶段**
   在 `run()` 最前面（`startup_mark("run:begin")` 之后、任何线程启动之前）预热
   `paths::data_root()`、`tauri::async_runtime` 等 `OnceLock`，消除 D 类竞争。

**验证修法效果的方法**：修完后跑 20 轮冷启动（每轮 12–15s，脚本可直接复用 `tools/cold-hang-repro.ps1`），
要求 `Responding=True` 20/20 且每轮都有 `frontend_ready`、`first_interaction`、+1s/+3s/+10s 心跳。

---

## 7. 本轮对业务代码的改动

**没有。** 约束遵守情况：

- `src-tauri/**` 一行未改（`git status` 里 `src-tauri/src/lib.rs` 的修改是本轮之前就存在的、属于其他工作）；
- 没有重启/覆盖 `E:\Maltese2\maltese-assistant.exe`，只为复现启动/结束该进程；
- 没有动 `work/.build-lock`、依赖、版本号，没有 push。

新增文件（唯一提交内容）：

```
docs/diagnostics/cold-start-hang-rootcause.md   ← 本报告
docs/diagnostics/tools/minidump_stacks.py       ← minidump + PDB 解析器（无 WinDbg 时的替代取证）
docs/diagnostics/tools/cold-hang-repro.ps1      ← 冷启动卡死复现 + 自动抓 dump 脚本
docs/diagnostics/tools/find_main_thread.py      ← 尝试用 CRT 启动帧定位主线程（本轮未启用，见 §8）
```

临时产物（`work/` 已被 gitignore，不提交）：
`work/hang/hang-r2-233428.dmp`（137.8 MB）、`work/hang/stacks-r2*.txt`、`work/cold-hang-diag.log`、
`work/hang/cold-r*.err.log`。

---

## 8. 附录：复现与取证命令

```powershell
# 1) 复现（杀进程→等4s→启动→每秒采样14s→卡死则抓 dump）
#    2026-11-26 起该脚本改为「参数化 20 轮验收」：默认测本地 release 构建、
#    数据目录/WebView2 profile 都落在工作区（agent 会话必需），失败轮仍抓 dump。
powershell -NoProfile -ExecutionPolicy Bypass -File E:\Maltese\docs\diagnostics\tools\cold-hang-repro.ps1

# 2) 手工抓栈
& "E:\tools\procdump\procdump64.exe" -ma -accepteula <pid> E:\Maltese\work\hang\hang-<HHmmss>.dmp

# 3) 分析（无 WinDbg/cdb 时的等价手段）
python E:\Maltese\docs\diagnostics\tools\minidump_stacks.py <dmp> ^
  --exe "E:\Maltese2\maltese-assistant.exe" ^
  --pdb "E:\Maltese\src-tauri\target\release\maltese_assistant.pdb" ^
  --ui-thread <主线程tid>

# 4) 辅助：定位涉及静态数据的指针 / 跨线程引用某个地址 / 读锁字
python E:\Maltese\docs\diagnostics\tools\minidump_stacks.py <dmp> --exe <exe> --pdb <pdb> --data-scan <tid>
python E:\Maltese\docs\diagnostics\tools\minidump_stacks.py <dmp> --exe <exe> --pdb <pdb> --xref-abs <hexaddr>
python E:\Maltese\docs\diagnostics\tools\minidump_stacks.py <dmp> --exe <exe> --pdb <pdb> --peek <hexaddr>:64
```

分析器能力（无第三方依赖，纯 Python 3 + 标准库）：

- MINIDUMP 头/流目录、ThreadList（tid/栈/TEB/CONTEXT）、ModuleList、Memory64/Memory；
- x64 CONTEXT → 全 16 个 GPR（`Rip/Rsp/Rbp/Rcx/…`）；
- 栈扫描（从 `Rsp` 向上找指向模块镜像的 qword）→ 粗栈回溯；
- PDB (MSF 7.00) → DBI → S_PUB32 公有符号（36,063 条），PE `.pdata` 异常目录 → 78,413 个精确函数区间，
  两者结合给出"函数名+函数内偏移"（规避 `/OPT:ICF` 同名折叠）；
- 系统 DLL 导出表解析 → `ntdll!RtlWaitOnAddress`、`KERNELBASE!WaitOnAddress` 这类真实 API 名。

辅助脚本 `find_main_thread.py`（本轮未成功启用：CRT 启动帧所在栈顶段未被 dump 覆盖，故改用
"单实例插件隐藏窗口归属线程"来定主线程，见 §3.3）。

---

## 9. 后续（2026-11-26）：修复与 20 轮验证

修复已落地，内容与证据见 [cold-start-hang-fix.md](cold-start-hang-fix.md)：

- 新增 `src-tauri/src/mutex_trace.rs` 探针（`MUTEX_TRACE lock=<名> thread=<tid> phase=before/after`
  + 持有者 tid + `MUTEX_TRACE lock=PROBE` 只读锁探针）；
- 本报告 §6 的 1/2/3/4/5 全部实现：事件回调只置脏标记 + 专用几何线程 + `run_on_main_thread`
  投递、几何缓存锁全 `try_lock`、extras 重同步延后到 `frontend_ready`、watchdog 异步投递 + 超时；
- **验收：20/20 冷启动 `Responding=True`，每轮都有 `frontend_ready` 与 +1s/+3s/+10s 心跳**；
- 局限（诚实说明）：本地 14 轮「原始逻辑 + 探针」冷启动没有复现卡死、`MUTEX_TRACE` 零争用，
  具体锁实例仍未实测确认；实机复现时看 `phase=before contended=true holder=<tid>` 即可定案。