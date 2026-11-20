# 冷启动/运行卡死抓栈与定位手册（P0-2）

> 现象：冷启动间歇性 `Responding=False`、无岛屿窗口；已加 `[startup]` 分步时间戳与 8s watchdog。
> 本手册用于**卡死发生时**抓主线程栈，定位是建窗、WebView 初始化还是后续命令处理。

## 1. 先看时间戳（30 秒内判断停点）

应用 stderr 若重定向到了文件（如 `E:\Maltese\work\cold-N.log`），直接看最后几行：

```powershell
Get-Content E:\Maltese\work\cold-1.log -Tail 30
```

- 停在 `[startup] step=setup:island_ready` → 卡在 setup 之后、前端首帧之前（WebView 初始化/主线程）；
- 有 `[startup] step=frontend_ready` 但仍 `Responding=False` → 卡在首帧之后（命令处理/渲染路径）；
- 出现 `STARTUP_WATCHDOG no frontend ready in 8s` → 8s 内首帧未握手，watchdog 已触发强制 show。

确认进程状态：

```powershell
Get-Process | Where-Object { $_.ProcessName -like "*maltese*" } |
  Select-Object Id, Responding, CPU, StartTime, WorkingSet
```

## 2. 抓主线程栈（用户已批准 procdump）

本机当前**未安装 procdump**（`where procdump` 无结果）。安装方式（二选一）：

```powershell
# 方式 A：winget（需要联网管理员权限）
winget install --id Microsoft.Sysinternals.Procdump -e

# 方式 B：手工下载 Sysinternals 套件后解压，得到 procdump64.exe
# https://download.sysinternals.com/files/Procdump.zip
```

抓到卡死进程后（`<pid>` 用上面 Get-Process 的 Id，**必须在 Responding=False 时抓**）：

```powershell
New-Item -ItemType Directory -Force E:\Maltese\work\hang | Out-Null
& "C:\path\to\procdump64.exe" -ma -accepteula <pid> E:\Maltese\work\hang\maltese-hang.dmp
```

- `-ma` = full dump（含线程栈），单文件约 300–600MB；
- dump 生成后进程会继续运行（procdump 默认不杀进程），可按需重启应用；
- 分析：Visual Studio「打开转储文件」→ 调试 → 全部线程；
  WinDbg 命令：`~* kv` 看所有线程栈，`!analyze -v` 看阻塞点；
  重点看**主线程**（TID = 进程主线程）栈顶是否在 `WebView2` / `CreateWindowEx` / 互斥锁等待。

## 3. procdump 不可用时的替代

1. 进程快照：
   ```powershell
   tasklist /v /fi "imagename eq maltese-assistant.exe"
   Get-Process maltese-assistant | Select-Object Id,CPU,Responding,Threads
   ```
   `Threads` 数量与 CPU 累计值可区分「死锁（CPU 不再增长）」与「死循环（CPU 持续上涨）」；
2. 心跳日志（已内置，见 `cbf790a` + 诊断补强）：
   - `[startup] heartbeat frontend_ready+1s/3s/10s`：首帧后 10s 内每秒级心跳；
   - `[startup] first_interaction_after_ready +Nms`：首帧后第一次 `set_island_interaction`；
   - 若心跳缺失但 `frontend_ready` 已出现 → 卡在首帧后的命令处理/渲染；
3. ETW（可选，不需安装）：`wpr -start GeneralProfile -filemode` → 复现 → `wpr -stop E:\Maltese\work\hang\hang.etl`。

## 4. 已知停点（2026-11-20 实测，v2.0.4 exe）

| 轮次 | 结果 | 停点 |
| --- | --- | --- |
| R1/R3/R4 | 正常 | `frontend_ready +641~701ms` |
| R5 | 卡死 | `setup:island_ready +426ms` 后无首帧，watchdog 8s 触发也救不回 |
| R2 | 卡死 | `frontend_ready +662ms` 已出现，说明卡在**首帧之后** |

对应结论：冷启动卡死至少有两条路径（首帧前 WebView 初始化 / 首帧后命令处理），抓栈时两条都要覆盖。