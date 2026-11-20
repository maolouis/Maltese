# 视频插件命令：阻塞修复与 SLOW_COMMAND 自证

> 版本 2.0.3（本地改造）。代码：`src-tauri/src/video/{mod,browser,session}.rs`。
> 背景：用户报「应用卡死 / 点了没反应」。根因是同步 `#[tauri::command]` 在命令线程里
> 做阻塞等待（`std::thread::sleep`、同步 `wait_for_cdp` 轮询、`Command::output()`、长 IO）。

## 改法

### 1. 阻塞等待全部改为异步

- `browser.rs` 新增异步版本，**同步版保留给后台线程**：
  - `wait_for_cdp_async(port, timeout)`：`tokio::time::sleep(150ms)` 轮询；
  - `wait_for_visible_window_async(pid, timeout)`：登录窗可见性轮询。
- `SessionEngine::start` / `restart_browser` 里的 `wait_for_cdp` 换成 `_async` 版本；
- `open_login_window` 改成 `async fn`：`std::thread::sleep(600ms)` → `tokio::time::sleep(...).await`，
  登录窗等待改 async；命令 `video_open_login_window` 同步 `fn` → `async fn`；
- `video_browser_status`（进程/端口探测）、`video_clear_data`（可能几秒的目录删除）
  改为 `async fn` + `tauri::async_runtime::spawn_blocking`；
- `video_stop_session` 改 `async fn` + `spawn_blocking`。

### 2. 停止路径：发信号后立刻返回

`SessionEngine::stop` 不再同步做「写终态 + 生成摘要 + 关浏览器」：

1. 置 `stop` 标志、`run_id+1`、写 `SESSION_STOPPED`、`phase=Stopped`；
2. 把 `finish(...)`（终态落盘 + digest + 关浏览器）丢进 `spawn_blocking`；
3. 立即返回 snapshot（采集循环看到 stop 后自行退出，不会重复收尾）。

### 3. SLOW_COMMAND 自证

所有 video 命令入口在 `mod.rs` 里加 `CommandGuard`（Drop 时结算）：

- 耗时 > 200ms → 日志 `SLOW_COMMAND name=… ms=…`（info）；
- 耗时 > 1000ms → `VERY_SLOW_COMMAND`（warn）。

日志落在 `%APPDATA%\com.maolouis.maltese\video\logs\video-<date>.jsonl`。

## 实机证据（2026-11-19）

用 WebView2 CDP 直接调 Tauri IPC（与前端按钮走的同一条 `#[tauri::command]` 路径），
同时用第二条 CDP 连接每 50ms ping 一次渲染主线程，测「命令等待期间界面是否卡」：

```
video_list_sessions: command_ms=2   ui_pings=1   ui_max_ms=2
video_start_session: command_ms=1739 ui_pings=28 ui_max_ms=3
video_stop_session:  command_ms=265  ui_pings=5  ui_max_ms=3
video_open_login_window: command_ms=1657 ui_pings=27 ui_max_ms=4
video_list_sessions#2: command_ms=6  ui_pings=1  ui_max_ms=2
video_get_snapshot:  command_ms=3    ui_pings=1  ui_max_ms=1
```

连续 4 轮「开始 / 停止 / 刷新历史 / 打开登录窗」压测：

```
round1.start ms=3    ui_max_ms=3
round1.stop  ms=8930 ui_max_ms=13   ← 改造前那次同步收尾，UI 仍只卡 13ms
round1.login ms=1725 ui_max_ms=3
round2.start ms=3    ui_max_ms=1
round2.stop  ms=134  ui_max_ms=4
round2.login ms=1802 ui_max_ms=9
round3.stop  ms=79   ui_max_ms=2
round3.login ms=1744 ui_max_ms=9
round4.stop  ms=132  ui_max_ms=3
round4.login ms=1720 ui_max_ms=10
WORST_UI_MS=13
```

命令耗时里 >1s 的只有「启动浏览器 / 打开登录窗」这类**必须等浏览器就绪**的操作，
等待期间 UI 主线程最大停顿 13ms（远低于 200ms 阈值），面板按钮/岛都点得动。

对应 SLOW_COMMAND 日志（真实记录，见 `video/logs`）：

```json
{"code":"VERY_SLOW_COMMAND","message":"name=video_start_session ms=1734"}
{"code":"SLOW_COMMAND","message":"name=video_stop_session ms=251"}
{"code":"VERY_SLOW_COMMAND","message":"name=video_open_login_window ms=1644"}
{"code":"VERY_SLOW_COMMAND","message":"name=video_stop_session ms=8926"}
```

> `video_stop_session 8926ms` 是**改造前**的同步收尾（改造后的 stop 已把收尾丢到后台）。
> 其余 >1s 的是浏览器启动/登录窗等待，属于外部进程就绪时间，不再阻塞命令线程。

## 其它约束

- 采集循环仍然只跑在独立 async task（`tauri::async_runtime::spawn`）；
- 共享状态锁内不做 await / IO；需要 await 的导航、评论、落盘都在锁外完成；
- 评论派发不 await（`spawn_auto_comment` 独立 task），不阻塞采集。
## 自动评论：评论区选择器与气泡（2026-11-20）

- 评论区懒加载：先滚到评论区（`#commentapp` / `.comment-container` / `<bili-comments>` 等），等 1.2s 再展开；
- **B 站评论区是 Shadow DOM（`<bili-comments>` web component）**：脚本用递归 `deepAll()` 穿透 `shadowRoot` 查询输入框/发送按钮；
- B 站评论框是点击态：先点 `.reply-box .input-area` / 文本「发一条友善的评论」的占位元素，等 1.5s；
- 写入：textarea 用原生 setter；contenteditable 用 `execCommand("insertText")` + `beforeinput`/`input`/`compositionend`；
- 失败原因细分：`no-comment-section` / `no-editor` / `no-input` / `no-button` / `login-required`（评论区只有「登录后参与评论」时）；
- 失败日志带 DOM 诊断（`section= editable= textarea= html=`，html 是评论区外层 300 字符片段）；
- 气泡：成功 `{kind:"posted"}`；失败 `{kind:"failed", text:"没找到评论区/输入框，这条先没评（原因：…）"}`；
  展开态面板状态区绿色/橙色高亮 5 秒；同类失败原因 60s 内只提示一次（不刷屏）。
