# 回归验证清单（每次研发结束必过）

> 用途：研发改完后按本清单跑一遍，任一项「失败」不得交付。  
> 方式：优先真实操作 + UIA/EnumWindows 取证；无法实机时注明「未验证」并说明原因。  
> 记录：每项写 `通过/失败/未验证` + 证据（控件名/矩形/日志/命令输出）。  
> 工具：`work/qa-win32-windows.ps1`（EnumWindows 全量含隐藏）、UIA（`UIAutomationClient`）、DSH API（`%APPDATA%\com.maolouis.maltese\dsh-api-port.txt`）、磁盘 `video\sessions`、stderr 日志。

## 1. 启动

- [ ] **主岛可见**：启动后 10s 内，EnumWindows 能看到 `class='Tauri Window'` 且 `title='Maltese 线条小狗桌面助手'`、`vis=True`、矩形尺寸 ≈ 259×221（1.6×），UIA 能读到宠物按钮（name 以「待办：/剩余N个待办」开头）。
  判定：有窗口 + 有宠物按钮 + 进程 `Responding=True`。
- [ ] **位置符合设置**：读 `focusd-island-settings` 的 `islandScreen`；若为 `\\.\DISPLAYn|WxH@x,y`，主岛矩形应落在那块屏工作区内（副屏 x 可为负），与 `focusd-island-position` 一致（±2px）。
- [ ] **无卡死**：启动 10s 内点托盘/右键狗一次（或发一次 invoke）有响应；stderr 无 `panicked` / `failed to receive message from webview`。
  判定：UI 可交互 + 无 panic。

## 2. 窗口

- [ ] **设置窗口能开**：点岛屿「设置/布局编辑」或托盘「配置桌宠」→ EnumWindows 出现 `title='Maltese · 桌宠设置'`、`vis=True`；再点一次仍在前台（不叠加第二个）；点 X 关闭后再开仍能显示（关闭=隐藏，不销毁）。
  判定：每次都能看到窗口（不是只有 HWND/0×0）。
- [ ] **插件窗口**：插件中心点「打开」（billiards / video-automation）→ 出现对应独立窗口；关闭后再开正常。
- [ ] **固定标签页（📌）**：固定「聊天/待办」→ 出现 `title='固定在桌面的标签页'`；任务栏无灰框/无重复图标（`skipTaskbar` 生效）；取消固定后窗口消失。
- [ ] **展开态提示行**：展开浮层 → 顶部/底部提示行可见（UIA 文本非空），位置不越界。
- [ ] **收起态云朵**：消息/主动气泡 → 云朵窗口（≈567×400）出现，尾巴指向小狗，关闭后主岛矩形回到 R0（±2px）。

## 3. Bongo / 陪玩狗

- [ ] **开关打开后出现**：设置 `bongoEnabled=true`（或 `petCount≥2`）→ 重启应用 → 10s 内 EnumWindows 出现 `class='Tauri Window'`、`title=''`、尺寸≈280×228（Bongo）或 200×180（companion-*）的窗口，且 `vis=True`。
- [ ] **位置跟随屏幕设置**：`bongoScreen=follow` 时，Bongo 矩形应与主岛同屏（或按单独偏好）；副屏时 x 为负；矩形完整落在工作区内。
- [ ] **重启后仍在正确屏幕**：完整退出进程再启动，重复上一条；不应回主屏。
- [ ] **开关关闭后消失**：关闭 Bongo/降低 petCount → 对应窗口 `vis=False` 或销毁，不残留。

## 4. 多屏

- [ ] **切副屏/切回**：设置「小狗屏幕」切副屏 → 主岛矩形 x<0 且落在副屏工作区；切回主屏 → x≥0；两次记录矩形。
- [ ] **拔屏降级**：在副屏运行时禁用/拔出副屏（或改分辨率）→ 主岛/Bongo 自动回主屏并显示「副屏已断开」提示，不留在屏外。
- [ ] **右键/悬停不跨屏**：副屏右键开聊天/悬停开面板 → 展开矩形仍与收起矩形同屏（不跳到主屏，锚定边差 ≤2px）。
- [ ] **重启记忆**：切屏后重启 → 屏幕选择与窗口位置保持（读 `islandScreen/bongoScreen` + 实测矩形）。

## 5. 聊天

- [ ] **发一条出回复**：发「你好」→ 30s 内出现 assistant 正文；若失败，记录错误码/原因（超时/未加载/接口错），不得静默。
- [ ] **状态栏显示**：聊天顶部状态条（体力/情绪/亲密/专注）有数据时渲染；关闭 vitals 或清空数据时不渲染。
- [ ] **表情包独立消息**：模型返回表情包时，表情包应为独立消息（不是拼进正文）。
- [ ] **停止生成可停**：发长问题 → busy 时点「停止」→ 1s 内 busy 消失，出现「已停止生成。」，不再追加正文。

## 6. 视频插件

- [ ] **开始看 → 采到 ≥1 条真实视频**：点「开始看」→ 60–90s 后看 DSH API `/api/video/status`：`phase=collecting`、`running=true`；`items[].canonicalUrl` 必须是 `https://www.bilibili.com/video/BV…`（或抖音对应视频页），**首页/推荐流页不算**。
- [ ] **停止**：点「停下」→ `running=false`、`phase=interrupted`，浏览器关闭。
- [ ] **停止后小结/历史非空**：`/api/video/pending` 或磁盘 `video\sessions\2026-*\*.json` 的 `digest/items` 非空；`index.json` 有该会话记录。
- [ ] **历史 0 条给原因**：若本轮 0 条，面板/历史必须显示原因（未登录/页面未加载/选择器失效/风控），并落 `video\logs\video-<date>.jsonl`。
- [ ] **评论入口**：评论框 + 「发送评论」存在；未开始时给出「先开始看」类提示（**不真发**）。

## 7. Agent（控制台）

- [ ] **控制台页签能打开**：岛屿/设置中的 Agent 控制台页签可点开，无白屏/报错。
- [ ] **桌面 Agent 列表有内容**：列表至少显示 1 个可用 Agent（读 `%APPDATA%\com.maolouis.maltese\agent-hub\config.json` 对照）。
- [ ] **「聚焦」可用**：点「聚焦」→ 目标窗口被前置/聚焦（或明确错误提示），不卡死。

## 8. 健康检查

- [ ] `node_modules\.bin\tsc.cmd --noEmit` → **exit 0**。
- [ ] `cargo check`（src-tauri，目标机）→ **exit 0**（仅既有 warning）。
- [ ] `node --test tests/*.test.mjs` → **0 fail**（记录 pass/fail 数）。

## 9. 记录模板

```
构建: <exe 路径/时间/版本>   启动时间: <hh:mm:ss>   实例 PID: <pid>
1 启动: 通过/失败/未验证 —— 证据:
2 窗口: ...
3 Bongo/陪玩狗: ...
4 多屏: ...
5 聊天: ...
6 视频: ...
7 Agent: ...
8 健康: tsc=  cargo=  node --test=
结论: 可交付 / 不可交付（阻塞项:）
```