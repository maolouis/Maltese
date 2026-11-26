# 设置窗口「打不开」定位与加固（2026-11-26）

## 现象

用户反馈：点顶部「设置」不再弹出独立设置窗口（上一版 5/5 正常）。
`work/v2b-boot.log`（11-26 14:19 真实会话）里连续 15 次打开都是：

```
SETTINGS_WINDOW_SHOW attempt=1 visible=false rect=None
SETTINGS_WINDOW_SHOW attempt=2 visible=false rect=None
SETTINGS_WINDOW_SHOW attempt=3 visible=false rect=None
SETTINGS_WINDOW_SHOW failed after retries (visible=false)
settings window ready in 364ms (created: true, already visible: false)
```

注意 `elapsed≈364ms` 正好等于 3×120ms 的 sleep，说明 `show()/is_visible()/outer_position()`
全都瞬间返回——这不是「窗口建好了但没显示」，而是 **窗口句柄根本没有原生实现**。

## 机制（tauri-runtime-wry 2.11.4 源码）

1. `Context::create_window`（`lib.rs:300-363`）把 `Message::CreateWindow` **投递**给主线程后
   立刻返回一个 `DetachedWindow`；tauri 的 `WindowManager::attach_window` 随即把窗口登记进
   管理器（`tauri/src/manager/window.rs:83-126`）。
2. 主线程真正执行创建：`Message::CreateWindow => match handler(event_loop)`（`lib.rs:4077-4084`）。
   失败只走 `log::error!("{e}")`，**不会通知调用方**；管理器里那个「壳」永久留着。
3. 之后任何 `is_visible()/outer_position()/outer_size()/show()` 都是按 window_id 查运行时
   map，查不到就把 sender 丢掉 → `Error::FailedToReceiveMessage` 立即返回。
   `is_visible().unwrap_or(false)` → `false`，`outer_position().ok().zip(...)` → `None`。
   这正是日志里 `visible=false rect=None` 的来源。

本项目没有安装 `log` logger，所以 wry 的原始错误一直被丢弃。本次在 `lib.rs` 里加了
最小 stderr logger（默认 warn），在另一次真实启动里抓到了同类失败原文：

```
[ERROR] tauri_runtime_wry: failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA), message: "请求的资源在使用中。" })
```

`0x800700AA = ERROR_BUSY`：WebView2 用户数据目录被占用/不可用，环境创建失败。
（该次启动同时出现 `DATA_ROOT_FALLBACK reason=readonly`，是 agent 会话环境造成的，
不是用户机器上的常态。）

## 复现结论（重要）

用**干净会话**（隔离 `MALTESE_DATA_DIR` + `WEBVIEW2_USER_DATA_FOLDER`）分别跑：

| 构建 | 结果 | 日志 |
| --- | --- | --- |
| 旧 build（`E:\Maltese2\maltese-assistant.exe`，11-20 23:34，用户报告「回归」的那版） | 5/5 OK，`SETTINGS_WINDOW_SHOW visible=true rect=(992,290,576,819)` | `work/ui-settings5-old.log` |
| 新 build（含本加固） | 5/5 OK，`SETTINGS_OPEN materialized attempt=1` + `SETTINGS_WINDOW_SHOW visible=true` | `work/ui-settings5-new.log` |

所以在干净会话里**旧代码也不复现**，不能判定是某个提交引入的代码回归；v2b 的 15 连败更可能
是会话内 WebView2 环境/用户数据目录状态（例如被其它实例/残留进程占用）导致建窗失败，
而旧代码把这种失败**静默当成成功**。

## 本次改动（只做可验证的加固，不假装修了无法复现的回归）

1. **失败可见**：`open_settings_window` 在 `ensure()` 之后先等窗口物化（最多 40×25ms），
   拿不到 `outer_position/outer_size` 就返回中文 Err；`visible=false` 也返回 Err。
   以前无论成败都 `Ok(())`，前端只能以为成功。
2. **wry 原文**：`StderrLogger` + `init_logging()`（`MALTESE_LOG=off|info|debug`，默认 warn）。
   `[ERROR] tauri_runtime_wry: failed to create webview: ...` 这类行现在会进 stderr。
3. **日志字段**：`SETTINGS_OPEN requested source=<入口>`、`SETTINGS_OPEN materialized attempt/rect`、
   `SETTINGS_WINDOW_SHOW attempt/visible/rect/source`、`SETTINGS_OPEN failed stage=...`、
   `SETTINGS_OPEN ok elapsed/rect`。入口来源由前端传入：
   `island-header` / `island-layout` / `assistant-panel` / `pet-bubble` / `tray`。
4. **前端错误边界**：顶部「设置」入口 `try/catch` + `console.error` + 岛内中文错误条
   `.island-settings-error`（6s 自动消失），同时退回岛内「布局编辑」页，不再静默无反应。

## 仍未确定

- v2b 会话里具体是谁占用了 WebView2 用户数据目录（日志里没有进程证据）。若再复现，
  现在 stderr 会直接给出 wry 原文（ERROR_BUSY / 其它 HRESULT），按它清理占用进程即可。