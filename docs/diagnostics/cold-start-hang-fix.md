# 冷启动间歇卡死：修复与 20 轮验证

> 修复日期：2026-11-26。前序根因报告见 [cold-start-hang-rootcause.md](cold-start-hang-rootcause.md)，
> 本文件记录「探针 → 治本 → 验收」的完整证据链。
> 验收结论：**20/20 冷启动 `Responding=True`，每轮都有 `frontend_ready` 与 +1s/+3s/+10s 心跳。**

---

## 1. 探针（`src-tauri/src/mutex_trace.rs`）

dump（`work/hang/hang-r2-233428.dmp`）只能证明「主线程停在 Rust `std::sync::Mutex` 的 futex」，
PDB 只有公有符号，栈上看不到锁名。为此新增一个**只加日志、不改语义**的薄壳：

```
MUTEX_TRACE lock=<锁名> thread=<系统 tid> phase=before|after|skip [contended=.. holder=.. waited_ms=..]
```

- 覆盖锁：`WINDOW_STATE`、`LAST_SETTLED_ISLAND_RECT`、`PRE_MINIMIZE_ISLAND_RECT`、
  `LAST_PERSISTED_RECT`、`PINNED_LAST_SET`、`PINNED_MANUAL_POSITION`、`USER_ISLAND_SIZE`；
- 每把锁用原子量登记「当前持有者 tid」，阻塞方一条日志就能说出 `holder`；
- 默认**只在真要阻塞时打**（`try_lock` 失败 → 再 `lock()`），无争用时零噪音；
  `MALTESE_MUTEX_TRACE=all` 全量、`MALTESE_MUTEX_TRACE=0` 关闭；单次持锁 >50ms 也记一条
  （`slow=true`，用于抓「持锁调窗口 API」）；
- 8s watchdog 与 3s 超时路径会调用 `log_lock_probe()`：对每把锁 `try_lock` 一次并打印
  `free` / `HELD_BY_<tid>`（见 `lib.rs` 的 `spawn_startup_watchdog`）。

### 1.1 探针实测结论（诚实说明）

为了拿到「到底哪把锁、被谁持有」，用**原始逻辑 + 探针**单独编了一版（不改业务代码），
在本机跑了 14 轮冷启动：

| 批次 | 环境 | 轮数 | 结果 | MUTEX_TRACE 争用日志 |
| --- | --- | --- | --- | --- |
| probe2 | 独立 WebView2 profile + 工作区 data | 8 | 8/8 `Responding=True` + `frontend_ready` + 心跳 | **0 条** |
| probe3 | 用户 profile 拷贝 + 用户 data 小文件 | 6 | 6/6 同上 | **0 条** |

也就是说：**在当前这台机器上，按本报告描述的冷启动路径，几何锁一次都没有发生争用**，
卡死（恢复后的 20 轮）同样没有复现。探针因此没有抓到现场样本；结论必须写在证据能支撑的范围内：

- **确定**：dump 证明主线程死于 Rust `std` 互斥量 futex（历史事实，仍是唯一现场证据）；
- **确定**：代码审计发现的形态确实存在（修复前）——`on_window_event` 在 Win32 消息派发栈里
  取状态锁，并在同一栈上调用 `set_size/set_position`（tao 会同步再派发一次 `WM_*` 形成重入）；
  同时 1s/3s/6s 的 extras 重同步线程会在启动几何窗口里对额外窗口做 `set_*/show`；
- **未复现**：具体是哪一把锁、哪个线程持锁，本轮没有抓到样本（14 轮 0 争用）。
  继续追的话需要用户实机（含真实 localStorage/Bongo 配置）在 `MALTESE_MUTEX_TRACE=1`
  下复现一次卡死，日志里 `phase=before contended=true holder=<tid>` 会直接给出答案。

### 1.2 环境坑（后续 agent 必读）

agent 会话里直接跑 GUI 有两个坑，否则观测全是假的（本轮踩过）：

1. `E:\Maltese2\data` 不可写（os error 5）→ 必须 `MALTESE_DATA_DIR=<工作区目录>`；
2. **默认 WebView2 profile（`%LOCALAPPDATA%\com.maolouis.maltese\EBWebView`）在本会话被占用**，
   表现为 `failed to create webview: HRESULT(0x800700AA) 请求的资源在使用中` +
   `错误: 拒绝访问。`，此时窗口建不出来、`frontend_ready` 永远不到，任何「卡死」观测都无效。
   解决：显式传 `WEBVIEW2_USER_DATA_FOLDER=<本会话可写的 profile 目录>`（脚本已内置）。
3. `island_rect_store::snapshot_path()` 目前硬编码 `E:\MalteseData`，agent 会话同样写不了，
   日志里的 `snapshot save failed: write tmp: 拒绝访问` 是环境问题，**不是**本次改动引入的。

---

## 2. 治本改动清单

### 2.1 新增 `src-tauri/src/mutex_trace.rs`

| 位置 | 内容 |
| --- | --- |
| :27 | 锁编号常量（`WINDOW_STATE` … `USER_ISLAND_SIZE`，共 7 把） |
| :88 | `holder()`：当前持有者 tid（0=空闲） |
| :138 | `lock()`：阻塞加锁（只有争用/慢锁才打日志），成功即登记持有者 |
| :203 / :208 | `lock_opt()` / `read()`：给探针版/旧写法用的阻塞包装 |
| :213 | `try_lock()`：非阻塞加锁，拿不到返回 `None` 并记 `phase=skip would_block=true holder=..` |

### 2.2 `src-tauri/src/lib.rs`

| 位置 | 改动 |
| --- | --- |
| :148-183 | 几何缓存锁统一 try_lock 读写函数：`settled_island_rect` / `store_settled_island_rect` / `take_pre_minimize_island_rect` / `store_pre_minimize_island_rect_if_empty`（拿不到锁就跳过，缓存语义等价） |
| :214 | `spawn_startup_watchdog`：**改 `run_on_main_thread` 异步投递 + 3s 超时**；超时打 `MUTEX_TRACE lock=PROBE` 锁探针，watchdog 自己不再阻塞在 `window.show()` |
| :268 / :281 | `probe_lock()` / `log_lock_probe()`：只读锁探针（`free` / `HELD_BY_<tid>`） |
| :312 | `spawn_startup_extras_resync`：extras 的 1s/3s/6s 重同步**等 `frontend_ready` 之后**再跑（+1.5s 起，+1/+2/+3s 三拍） |
| :1316 | `store_user_island_size`：`USER_ISLAND_SIZE` 改 try_lock |
| :1661 | `restore_island_rect_after_unminimize`：`set_size/set_position` 明确在任何缓存锁 guard drop **之后** |
| :1705-1721 | 窗口事件脏标记：`GEO_DIRTY_MINIMIZE/DRAG/RESIZE/PINNED` + `mark_island_geometry_dirty`（事件回调里只 `fetch_or` + 唤醒，不取锁、不调窗口 API） |
| :1729-1789 | `ensure_island_geometry_worker` / `dispatch_island_geometry`：专用 `island-geometry` 线程串行消费脏位，再经 `run_on_main_thread` 投递到主线程执行（不在 WndProc 重入栈上干活） |
| :1791 / :1822 | `record_user_island_size` / `handle_pinned_window_moved`：原来在主线程事件回调里的逻辑搬到投递闭包，锁全部 try_read/try_lock |
| :1852-1864 | `LAST_PERSISTED_RECT` 改 try_lock（`last_persisted_rect_is` / `store_last_persisted_rect`） |
| :1885 | `persist_island_snapshot`：状态锁改 `try_read_window_state()`（拿不到就跳过本次落盘） |
| :3882-3909 | `PINNED_LAST_SET` / `PINNED_MANUAL_POSITION` 改 try_lock 读写函数 |
| :5727-5749 | `mutate_window_state` / `read_window_state` 统一走探针；新增 `try_read_window_state` / `try_mutate_window_state`（非阻塞，拿不到就跳过） |
| :6336 | `record_dragged_position`：`OVERLAY_SNAPSHOT` 与状态锁都改非阻塞（主线程绝不被拖拽记录阻塞） |
| :7216 | `on_window_event`：主窗口/pinned 分支**只置脏标记**；`is_minimized`/`set_*`/`persist`/`USER_ISLAND_SIZE` 全部移出事件回调 |

### 2.3 修法对应报告 §5

| 报告建议 | 落点 |
| --- | --- |
| 禁止持锁调窗口 API | 2.2 :1661、:1885、:6336、审计见 §4；`mutate_window_state` 闭包内禁止窗口 API（写在注释里） |
| 缓存锁 try_lock | 2.2 :148-183、:1316、:1852、:3882 |
| `on_window_event` 只置脏标记 | 2.2 :7216（+ :1705-1789 几何线程） |
| extras 重同步延后到 `frontend_ready` | 2.2 :312 |
| watchdog `run_on_main_thread` + 超时 | 2.2 :214 |

---

## 3. 20 轮冷启动验收

命令（环境：`MALTESE_DATA_DIR` 指到工作区、`WEBVIEW2_USER_DATA_FOLDER` 指到本会话可写的
profile、`MALTESE_MUTEX_TRACE=1`；脚本已内置这三项）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\Maltese\docs\diagnostics\tools\cold-hang-repro.ps1 `
  -Exe E:\Maltese\work\probe\maltese-verify.exe `
  -DataDir E:\Maltese\work\data-verify20 `
  -ProfileDir E:\Maltese\.tmp-build\wv-verify20 `
  -Tag cold-verify20 -Rounds 20 -SampleSeconds 15
```

> `docs/diagnostics/tools/cold-hang-repro.ps1` 本轮重写为「参数化 20 轮验收」版本
> （原 2026-11-20 的线程状态 dump 版本见 git 历史 `9697d28`）；`work/probe/cold-rounds.ps1`
> 是同一逻辑的开发期副本（`work/` 不提交）。

产物：`work/cold-verify20/rounds.log` + 每轮 `rNN.err.log`（`work/` 已 gitignore）。
exe 由 `node node_modules\@tauri-apps\cli\tauri.js build --no-bundle`（`--features custom-protocol`
由 CLI 带上）产出，与 `src-tauri/target/release/maltese-assistant.exe` 同源。

| 轮次 | Responding | CPU(s) | 线程 | frontend_ready | +1s/+3s/+10s 心跳 | watchdog | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | True | 0.52 | 60 | ✓ | ✓ | 未触发 | PASS |
| R2 | True | 0.62 | 60 | ✓ | ✓ | 未触发 | PASS |
| R3 | True | 0.41 | 60 | ✓ | ✓ | 未触发 | PASS |
| R4 | True | 0.44 | 60 | ✓ | ✓ | 未触发 | PASS |
| R5 | True | 0.53 | 60 | ✓ | ✓ | 未触发 | PASS |
| R6 | True | 0.67 | 60 | ✓ | ✓ | 未触发 | PASS |
| R7 | True | 0.58 | 60 | ✓ | ✓ | 未触发 | PASS |
| R8 | True | 0.38 | 60 | ✓ | ✓ | 未触发 | PASS |
| R9 | True | 0.44 | 60 | ✓ | ✓ | 未触发 | PASS |
| R10 | True | 0.53 | 60 | ✓ | ✓ | 未触发 | PASS |
| R11 | True | 0.45 | 60 | ✓ | ✓ | 未触发 | PASS |
| R12 | True | 0.61 | 60 | ✓ | ✓ | 未触发 | PASS |
| R13 | True | 0.53 | 60 | ✓ | ✓ | 未触发 | PASS |
| R14 | True | 0.66 | 60 | ✓ | ✓ | 未触发 | PASS |
| R15 | True | 0.52 | 60 | ✓ | ✓ | 未触发 | PASS |
| R16 | True | 0.50 | 60 | ✓ | ✓ | 未触发 | PASS |
| R17 | True | 0.47 | 60 | ✓ | ✓ | 未触发 | PASS |
| R18 | True | 0.67 | 60 | ✓ | ✓ | 未触发 | PASS |
| R19 | True | 0.52 | 60 | ✓ | ✓ | 未触发 | PASS |
| R20 | True | 0.47 | 60 | ✓ | ✓ | 未触发 | PASS |

**汇总：20/20 PASS；`MUTEX_TRACE` 争用/慢锁日志 0 条；`STARTUP_WATCHDOG` 0 次。**

### 3.1 几何回归冒烟（额外验证，因为事件路径整个搬走了）

`docs/diagnostics/tools/cold-start-geom-smoke.ps1` 与 `cold-start-drag-smoke.ps1`
（同一 exe / 隔离 profile；开发期副本在 `work/probe/`，`work/` 不提交）：

| 用例 | 结果 |
| --- | --- |
| 最小化 → 还原 | 矩形 `1204,872,619,520` → 完全相同，漂移 `0,0`，全程 `Responding=True` |
| 拖拽小狗（收起态） | 窗口 `1204,872` → `1258,827`（位移 55/45px），`Responding=True`；`island-rect.json` 未变化是因为快照路径硬编码 `E:\MalteseData`（agent 会话不可写，见 §1.2） |
| `STARTUP_SKIP_RECALC` | 每轮 1–5 条（启动恢复 3s 窗口内不重算，语义不变） |

---

## 4. 审计：持锁窗口 API

- 全仓扫描 `lock()` 与随后的窗口 API 调用（`window.set_* / show / hide / emit / outer_* /
  inner_* / is_* / *_monitor`）：命中的 10 处全部是「guard 在同一语句结束时 drop、之后才调 API」，
  没有 guard 跨窗口调用的写法；
- `mutate_window_state(|state| …)` 共 16 个闭包，全部只改字段、不调任何窗口 API
  （已在函数注释里写成纪律：闭包内禁止窗口 API）；
- 唯一「持锁期间调窗口 API」的遗留是 `OVERLAY_REQUEST_LOCK`（浮层请求串行化锁，
  不是窗口状态锁，也不会被主线程事件路径获取）。它持有期间调 `set_window_rect_atomic`，
  语义上要求串行化，本次未改；风险见 §5。

---

## 5. 剩余风险

1. **具体锁实例仍未实测确认**：14 轮探针 0 争用，无法在本地拿到「哪把锁、谁持有」的现场。
   需要用户实机 `MALTESE_MUTEX_TRACE=1` 下复现一次卡死（日志会直接给出 `lock=… holder=…`）。
2. **tao/tauri 内部锁**：若真实卡点不在本项目这 7 把锁上（而在 tao `WindowState` 或
   `tauri::async_runtime` 的 `OnceLock` 上），本次改动只能消除「我们的锁 + 重入窗口 API」这条
   死锁路径；不过 `on_window_event` 不再重入调窗口 API、watchdog 不再被主线程拖死，
   即便再发生也会留下 `MUTEX_TRACE phase=probe` + 超时日志，可定位。
3. **语义降级**：缓存锁 try_lock 拿不到时会跳过本次记忆（`LAST_SETTLED_*` / `PRE_MINIMIZE_*` /
   `PINNED_*` / `LAST_PERSISTED` / `USER_ISLAND_SIZE`）。正常路径下争用窗口极短，
   表现为「偶尔少记一次位置/尺寸」，下一次窗口事件会补上；最坏情况是极小概率的最小化还原
   少一次逐像素复位。
4. **事件合并**：`island-geometry` 线程按脏位合并事件（Moved 只保留最后一次坐标），
   拖拽/最小化行为与旧实现等价；但极端连续事件下快照落盘次数会少一些。
5. **`OVERLAY_REQUEST_LOCK`** 仍在持锁期间调窗口 API（浮层 plan/set 串行化需要）。
   它不在启动路径上，但若将来有后台线程在持锁时被主线程反向等待，仍有理论死锁面。
6. **监控路径改动未覆盖 UI 交互验证**：本轮只做了启动 20 轮 + 最小化/还原 + 拖拽冒烟，
   浮层/展开面板/设置窗口等交互没有逐项回归（它们走 `apply_stage_geometry` 的原逻辑，
   只是事件入口改成投递）。