# 小狗刷视频（自主观看与小结回传）

这个插件的定位是：**小狗用自己的浏览器实例替你看推荐流**，按兴趣整理成小结，再通过聊天消息和云朵气泡回传给你。它不是「帮你翻页」的工具，也不会代你评论、关注、投稿或开播。

## 边界

- 只读页面事实：标题、作者、时长、进度、播放/可见状态、标签、点赞/收藏/投币状态、评论区停留时长。
- 不读取 Cookie、账号凭据、请求头；不截图、不上传、不抓包、不逆向平台接口。
- 不修改 UA、不使用 headless、不持久注入脚本。
- 遇到验证码 / 风控 / 登录页：停下来或等待你登录，不尝试绕过。
- 自动点赞 / 收藏默认关闭，本期只交付护栏骨架，不提供关注、评论、发布动作。

## 代码结构

| 模块 | 职责 |
| --- | --- |
| `src-tauri/src/video/rules.rs` | 平台白名单、配置区间、翻页键与 `next_action` 决策 |
| `video/extract.rs` | 页面事实归一化、指纹、URL 脱敏、非内容页过滤 |
| `video/adapter.rs` | B 站 / 抖音适配器与页面分类 |
| `video/interest.rs` | 14 类信号权重、通道可信度、65/40 阈值、负向与挂机否决 |
| `video/profile.rs` | 正/负标签、作者偏好与来源会话 |
| `video/digest.rs` | 聚类、≤5 条、每条 ≤40 字、整体 ≤300 字、模型/模板回退 |
| `video/delivery.rs` | 7 天指纹去重、24 小时同簇去重、日限、待投递队列 |
| `video/store.rs` | 会话/索引/画像/投递/日志落盘与保留期 |
| `video/browser.rs` | Chrome/Edge 发现、独立 profile、调试端口与退出检测 |
| `video/cdp.rs` | `/json/version`、`/json/list`、WebSocket 请求与重连 |
| `video/channel.rs` | CDP → 扩展 → UIA → SMTC → 窗口标题 的降级链 |
| `video/session.rs` | 会话状态机、采集 tick、翻页调度、整理与入队 |
| `video/guard.rs` | 自动互动护栏（默认关闭、日限、间隔、审计） |
| `video/external.rs` | 官方页面白名单（投稿 / 直播中心） |
| `src/videoDelivery.ts` | 投递时机纯逻辑（主动程度 / 免打扰 / 空闲 / 全屏 / 日限） |
| `src/useVideoDelivery.ts` | 写聊天、弹气泡、回写投递结果 |

## 启动与通道

1. 校验 provider / 配置，失败不产生任何副作用。
2. 启动独立 profile 的有窗口 Chrome/Edge（`--remote-debugging-port`，禁用 headless）。
3. CDP 探活并打开推荐流；不可用时按 15 秒预算逐级降级。
4. 每 `sampleIntervalSeconds` 采集一次，每 `pageIntervalSeconds` 翻页一次。
5. 到达时长/条目上限后整理；`Interrupted` / `Blocked` / 用户停止不产出小结。

通道能力：

| 通道 | 可信度 | 能力 | 损失 |
| --- | --- | --- | --- |
| CDP / 扩展 | 1.0 | full | 无损 |
| UIA | 0.5 | enhanced | 只有标题与部分文本，无法判断完成度与互动 |
| SMTC | 0.6 | basic | 有标题/进度/时长，无作者标签与互动 |
| 窗口标题 | 0.3 | basic | 只能读标题，不作兴趣结论 |

## 数据与保留期

根目录：`%APPDATA%\<应用标识>\video\`

| 路径 | 内容 | 保留 |
| --- | --- | --- |
| `sessions/<YYYY-MM>/<sessionId>.json` | 会话、条目、信号、判定、整理 | 30 天 |
| `index.json` | 会话索引 | 随会话 |
| `profile.json` | 画像 | 常驻 |
| `deliveries.jsonl` | 投递记录（只保留指纹与时间） | 90 天 |
| `pending.json` | 待投递队列（≤5） | 30 天 |
| `logs/video-<YYYYMMDD>.jsonl` | 脱敏诊断 | 7 天 |

浏览器登录态在 `%LOCALAPPDATA%\Maltese\video-profile`，**不会自动删除**；清空数据默认保留，勾选后才清空并需要重新登录。

## 诊断

- 面板「重新自检」调用 `video_probe_channels`，展示当前通道、能力等级、失败原因与损失文案。
- `GET http://127.0.0.1:3218/api/video/diagnostics?limit=20` 返回最近脱敏日志。
- 常见错误码：`BROWSER_UNAVAILABLE`、`PORT_BUSY`、`LOGIN_REQUIRED`、`RISK_CONTROL`、`URL_NOT_ALLOWED`、`SESSION_RUNNING`、`INVALID_CONFIG`。

## 已知限制

- 抖音推荐流为虚拟列表，抽取标记为 experimental。
- UIA 与浏览器扩展通道只保留接口与能力占位，本期未发布扩展。
- 自动点赞/收藏的选择器随适配器迭代；默认关闭。
- 专用浏览器最小化会被 Chromium 节流；建议窗口置后但不要最小化。