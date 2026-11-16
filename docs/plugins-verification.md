# 插件验收记录（2026-11-16）

本轮目标：验证当前安装的 3 个插件（台球 / 刷视频 / 关系），补齐验收标准缺的能力，**只做本地提交，未升版本号、未 push、未发 Release**。

## 1. 当前安装的插件

插件根目录：`%APPDATA%\com.maolouis.maltese\plugins`

| 插件 | 版本 | `ui` | 说明 |
| --- | --- | --- | --- |
| `billiards` 桌面图标台球 | 2.0.0 | host | 覆盖桌面的独立窗口，把真实图标当球 |
| `relationship` 关系 | 0.2.5 | host | 配对码 + 加密中继聊天（本轮加了状态/心情） |
| `video-automation` 刷视频 | — | host | 小狗自己刷推荐流、判兴趣、出小结（本轮加了评论） |

预置分发包在 `E:\Maltese2\plugins\*.zip`（billiards / relationship / video-automation / hello-world），
应用本身不预置插件，需要手动安装。

## 2. 台球插件验收（对照参考项目）

参考：<https://github.com/liuxiaogang-com/desktop-icon-billiards>（MIT，GitHub@liuxiaogang-com）

| 参考项目能力 | 本插件 | 状态 |
| --- | --- | --- |
| 桌面图标当球、真实滚动 | 批量 `LVM_SETITEMPOSITION` 搬真实图标 | ✅ |
| 开局摆三角球阵 | 按图标数摆三角 | ✅ |
| 六个球洞 + 入袋 | 四角 + 两中袋，进洞即入袋 | ✅ |
| 拉杆蓄力、松手击球 | 按住左键拉杆，力度条 | ✅ |
| 计时 / 进球 / 剩余 | 顶部状态条 | ✅ |
| 重开 / 退出恢复桌面 | `R` 重开、`Esc` 退出、退出即恢复 | ✅ |
| 异常退出兜底恢复 | 备份文件 + 启动时 `restore_desktop_on_startup` | ✅ |
| 开局闸门（避免误搬图标） | `GAME_ACTIVE` 原子位，未开局不动图标（issue #1 修复） | ✅ |
| 瞄准辅助线（含反弹预估） | 只有直线虚线 + 力度条 | ⚠️ 缺反弹/碰撞圈预估 |
| 辅助线开关 | 无 | ⚠️ 缺 |
| 球数 15–45 归一（不足复制） | 上限 45，不足不补球 | ⚠️ 缺 |
| 清台成绩卡（段位/用时/平均） | 只显示比分 | ⚠️ 缺 |
| 全球排名 | 无 | ➖ 不打算做 |

结论：**核心玩法与桌面安全已达到参考项目的功能范围**，差距在「瞄准辅助线增强 / 球数归一 / 成绩卡」这类体验项，
列在下方待办。

## 3. 刷视频插件验收

验收标准：自己打开视频 → 自己拿到视频内容 → 提炼用户感兴趣的内容 → 支持在视频下评论。

| 标准 | 实现 | 验证 |
| --- | --- | --- |
| 自己打开视频 | `video_start_session` 启动专用浏览器（CDP 驱动），自动导航到推荐流/视频页 | 前轮已做 CDP 实机验证 7/7 |
| 自己拿到视频内容 | `video/extract.rs` 采标题/时长/UP/播放量等 `PageFacts`，`session` 合并为 `ContentItem` | 纯逻辑测试通过 |
| 提炼用户感兴趣的内容 | `video/interest.rs` + `profile.rs` 打分，`digest.rs` 生成小结，聊天/气泡回传 | 21 项前端测试 + 后端逻辑测试通过 |
| **在视频下评论** | **本轮新增**：`video/comment.rs` + `video_post_comment` 命令 + 插件面板评论框 | 见下 |

### 本轮新增：在视频下评论

- 后端 `src-tauri/src/video/comment.rs`：
  - `build_comment_script(text)`：找可见评论输入框（textarea / contenteditable，优先评论区），
    原生 setter 写值 + 派发 `input`/`change`，再点「发送/发布/评论」按钮；
  - 文本 1–200 字，转义引号、反斜杠、`<`/`>`、U+2028/U+2029，避免脚本注入；
  - 失败返回原因码：`no-input`（找不到输入框）/ `no-button`（找不到发送按钮）。
- `SessionEngine::post_comment`：复用当前会话的 CDP 端口（`RuntimeState.cdp_port`），
  未开局直接返回 `comment-not-ready`，连不上返回 `comment-cdp`。
- 命令 `video_post_comment(text)`，注册在 `lib.rs`。
- 前端 `VideoAutomationPlugin.tsx` 增加「在视频下评论」卡片：textarea（200 字上限）+「发送评论」+
  状态提示；**只有用户点发送才执行**，插件不会自动评论、不代点赞/关注。

验证：`build_comment_script` 用 `rustc --test` 跑 **8/8 通过**（空、超长、边界长度、引号/反斜杠、
行分隔符、尖括号、脚本含输入框与发送按钮、首尾空白裁剪）。真实发评论需要登录态视频页，未在本机执行。

## 4. 关系插件验收

验收标准：能配对，并能读到对方的工作状态和情绪。

| 标准 | 实现 | 验证 |
| --- | --- | --- |
| 配对 | 配对码 → 频道名派生 + 双方 `hello` 握手（原有） | 见下 |
| 加密聊天 | 配对码派生密钥，中继只见密文（原有） | 见下 |
| **读对方工作状态** | **本轮新增**：`presence` 消息带 `work`（前台窗口 → 「在写代码（App.tsx）」这类描述），每 30 秒上报 | 见下 |
| **读对方情绪** | **本轮新增**：5 档心情（开心/平静/有点累/有点烦/想人陪），点选即同步 | 见下 |
| 对方状态展示 | 「对方 现在：<工作状态> · 心情：xx · N 分钟前」卡片 | 待实机看界面 |

### 本轮新增内容

- `RelationshipPlugin.tsx`：`PairState` 增加 `myEmotion/myWork/peerEmotion/peerWork/peerStatusAt`；
  `shareStatus()` 用 `get_active_activity` 读前台窗口生成工作状态，随 `presence` 消息发出；
  配对后每 30 秒自动上报；收到 `presence` 更新对方卡片。
- 新增 「我现在的心情」5 个按钮 + 「对方 现在」状态卡（工作状态 / 心情 / 更新时间）。
- `RelationshipPlugin.css`：状态卡与心情按钮样式（悬停变色 + 上浮）。

### 验证结果

纯逻辑（Node 直接跑 `pairing.ts`）：

```
配对码: P47KW9 | 长度: 6
频道名: maltese-rel-803f90c0c0995f234dce255e
密文长度: 149
解密结果: {"t":"presence","work":"在写代码（App.tsx）","emotion":"tired","sid":"x1"}
工作状态保留: true
情绪保留: true
错误密钥解不开: true
```

中继实连（ntfy.sh）：

```
发布 → id VkKWIJQjaUkh
拉取 → {"id":"VkKWIJQjaUkh", "event":"message", "topic":"maltese-rel-verify-63752", ...}
```

结论：**配对、加密、中继、工作状态与情绪的载荷全部验证通过**；两端同时在线的界面联调需要第二台机器/第二个昵称手测。

## 5. 本轮同时处理的环境问题

- 工作区里有一批未提交的「宠物互动」半成品（`petInteractions.ts` 相关 import 未使用 +
  `IslandShell` 缺 `petInteraction` 入参），导致 `tsc` 失败、前端无法构建。
  本轮最小处置：`IslandShell` 调用处传 `petInteraction={null}`、清掉未使用导入，**该功能暂不启用**，
  留待后续单独实现（不删 `IslandShell` 里已写好的渲染分支）。

## 6. 验证汇总

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ 通过（修复半成品导致的失败后） |
| `node --test tests/*.test.mjs` | ✅ 55/55 |
| `rustc --test comment.rs`（评论脚本纯逻辑） | ✅ 8/8 |
| `cargo check` | ✅ 通过 |
| 关系插件纯逻辑（配对/加解密/presence） | ✅ 通过 |
| ntfy 中继实连 | ✅ 发布/拉取成功 |

## 7. 待办（按优先级）

1. 台球：瞄准辅助线开关 + 反弹/碰撞圈预估；球数不足 15 时补球；清台成绩卡。
2. 刷视频：真实登录态页面上实测一次评论（B 站 / 抖音选择器可能需按页面结构调整）。
3. 关系：两台机器同时在线跑一次完整配对 → 状态/心情互见 → 断开流程。
4. 宠物互动半成品：决定「补完」还是「移除」。
5. 以上都通过后再谈发布（升版本号 + push + Release 需用户确认）。