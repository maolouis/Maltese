# Agent 控制台设计（余额/任务进度/工作分配 + 对话控制）

> 2026-11-19 · 版本 2.0.2（不改版本号）
> 目标：主面板新增「Agent」页签，把「模型用量 / 正在跑的任务 / 谁在干什么」集中可见，并允许在聊天里用自然语言查询与控制。
> 现状依据：`local_chat.rs` 无任何统计；`dsh_api.rs` 只有视频 HTTP 接口；视频状态有 `video_get_snapshot` + `video-session-updated` 事件；待办在 localStorage；`scripts/team-progress.mjs` 读 `.arts/team-progress.json` 属开发期数据，不随应用分发。

---

## 1. 信息架构

**位置：主面板新页签「Agent」**（`IslandPage` 增加 `"agent"`，导航顺序放在「聊天」「看视频」之后；`PAGE_LABELS` 增加「Agent 控制台」）。
理由：监控是「随手看一眼」的高频动作，双击小狗→点页签即可；插件窗口（`plugin`）需要「快捷入口→插件→打开」三步，适合后续放详细日志/配置，不适合首屏。

首屏固定三段（纵向卡片，窄面板下每卡 ≤3 行摘要 + 一个「详情」）：

| 段 | 标题 | 内容 | 备注 |
| --- | --- | --- | --- |
| ① | 模型用量 | 今日请求数、估算 token、平均首字、平均总时长、失败数；按来源（聊天/主动/技能决策/翻译）拆一行 | 本地模型无付费，不显示"余额"，标题写「用量（本地模型不计费）」；DSH 后端只显示请求数/平均时长 |
| ② | 任务进度 | 视频采集（进度条 + 已用时/上限 + 预计剩余 + 已采集条数）、日报投递（待投递 N 条）、进行中的待办（标题 + 已计时） | 视频用现有 snapshot，足够算进度与 ETA |
| ③ | 工作分配 | 每个「agent」一行：名称、状态（运行/排队/空闲/失败）、在跑什么、队列长度、最近错误（≤1 行） | 首版 agent 列表固定 5 项：主狗聊天、主动聊天、视频采集、日报投递、翻译 |

底部一行小字：`数据来源：本机统计 · 最近更新 HH:mm:ss`；右上角手动刷新按钮（3s 防抖）。

---

## 2. 数据来源（逐项现状 + 缺口）

| 指标 | 现在能拿到吗 | 来源 | 需要新增 |
| --- | --- | --- | --- |
| 本机模型请求数/首字耗时/总时长/失败 | ❌ | `local_chat.rs` 只有 `eprintln`，无计数 | **埋点**：`local_chat` / `local_chat_stream` 记录 `{at, source, model, firstTokenMs, totalMs, ok}`，内存 + 落盘 `agent-usage.json`（按天滚动 7 天）；**新增命令 `get_agent_usage()`** |
| token 用量 | ❌（服务端可能不回 usage） | 流式响应未解析 `usage` | 首版按**输出字符数**估算（中文 ≈1 字/1 token，标注「估算」）；后续解析 SSE 末帧 `usage` |
| DSH 请求数/耗时/失败 | ❌ | `dsh_chat.rs` 无统计 | 同样埋点，`source:"chat"`；token 拿不到，显示「—」 |
| 模型在线/加载/槽位 | ⚠️ 部分 | 本机 Strata：`GET /health`（model/loaded）、`GET /slots`（占用） | **新增命令 `local_model_status(base_url)`**（2s 超时；非本机地址只查 `/health`，`/slots` 不可用则显示「未知」） |
| 视频采集进度/条数/待投递 | ✅ | `video_get_snapshot`（`phase/steps/max_minutes/started_at/item_count/pending_count`）+ `video-session-updated` 事件 | 无需新命令；ETA = `max_minutes - 已用分钟`，进度 = 已用/上限 |
| 视频日报/投递队列 | ✅ | `VideoSnapshot.pending_count` + `video_take_pending_digest` | 读取用 snapshot；生成动作见 §3 |
| 待办进行中 | ✅ | localStorage `focusd-island-todos` / `focusd-island-active-todo` | 前端直接读，无需命令 |
| 翻译调用次数 | ❌ | `translation.rs` 无统计 | 并入同一 usage 埋点，`source:"translate"`（P1） |
| 剪贴板条数 | ✅ | `clipboard_history::get_clipboard_history` | 仅作详情，不进首屏 |
| 插件运行状态 | ❌ | `list_plugins` 只给清单 | P2：新增 `plugin_status` |
| `team-progress.json` | — | `.arts/team-progress.json` 是开发流程数据，安装包里没有 | **不适用**，首屏不读 |

**一次性聚合命令（推荐）**：`get_agent_console_snapshot()` → `{usage, model, video, translate, clipboard}`，减少首屏 5–6 次 IPC。前端只补 todo（localStorage）即可渲染。埋点与命令建议放新文件 `src-tauri/src/agent_console.rs`，在 `lib.rs` 的 `generate_handler!` 注册。

**给 `local_chat_stream` / `local_chat` / `dsh_chat` 增加可选参数 `source`**（`"chat"|"proactive"|"decision"|"preview"|"translate"`），由调用方传入；不传按 `unknown` 统计。改动点：`App.tsx`（主动聊天传 `proactive`）、`PetChat.tsx`（决策传 `decision`、回复传 `chat`）。

---

## 3. 对话控制（意图 → 动作映射）

复用现有技能链路：`petSkills.ts` 的 `SkillAction` 白名单 + `SKILLS` 说明 + `runSkill` 执行；`PetChat.tsx` 已有「决策 JSON → 执行 → 总结」流程，只扩展白名单与确认环节。

| 意图 | 用户说法示例 | action | args | 类型 | 确认 | 失败提示 |
| --- | --- | --- | --- | --- | --- | --- |
| 查余额/用量 | 「余额还剩多少」「今天用了多少 token」 | `agent_usage` | `{range:"today"}` | 只读 | 否 | 「读取用量失败：本地统计还没生成，先聊几句再试」 |
| 查任务 | 「现在有几个任务在跑」「视频进度到哪了」 | `agent_tasks` | `{kind?:"all"}` | 只读 | 否 | 「查询任务失败：视频服务未启动」 |
| 查工作分配 | 「谁在干活」「队列里排了几个」 | `agent_agents` | `{}` | 只读 | 否 | 「读取 agent 状态失败」 |
| 打开控制台 | 「打开 Agent 控制台」 | `agent_open_console` | `{}` | UI 导航 | 否 | 「面板正在展开，稍后再试」 |
| 暂停刷视频 | 「暂停刷视频」「别刷了」 | `agent_pause_video` | `{}` | **改状态** | **是** | 「当前没有进行中的采集」 |
| 恢复/开始刷视频 | 「继续刷视频」「刷 20 分钟 B 站」 | `agent_resume_video` | `{platform?:"bilibili", maxMinutes?:5..240}` | **改状态** | **是** | 「参数不合法：时长需 5–240 分钟」 |
| 生成今天日报 | 「把今天日报生成一下」 | `agent_generate_digest` | `{}` | **改状态** | **是** | 「今天没有采集到可汇总的内容」 |
| 拒绝类（示例） | 「删掉所有记录」「发评论」「发布视频」 | —（不进白名单） | — | 拒绝 | — | 「这件事我不能替你做，只能帮你看进度/暂停/生成日报」 |

**只读 vs 改状态**：`agent_usage/agent_tasks/agent_agents` 直接执行；`agent_open_console` 只切页；`agent_pause_video/agent_resume_video/agent_generate_digest` 必须二次确认。确认实现：模型输出只到"待确认"，`PetChat` 渲染一张确认卡（「要暂停视频采集吗？[确认] [取消]」），60s 未点自动取消；**模型不能自己确认**，用户在卡片上点或明确回复"确认"才执行。

**权限边界（硬约束）**：`parseSkillCall` 只接受 `SKILLS` 白名单里的 action；`runSkill` 遇到未知 action 返回「这个操作不在允许范围内」；参数白名单校验（duration 5–240、platform ∈ {bilibili,douyin}、URL 不出现、不含 shell/文件路径）；任何发布/删除/发送消息的意图一律拒绝并给出替代建议。

---

## 4. 安全边界

- 对话只走技能白名单，**不得**让模型直接执行任意命令、读文件、开任意 URL、调任意 Tauri command。
- 会改状态的动作（暂停/恢复/生成日报）必须二次确认；默认拒绝，用户显式确认才生效。
- 涉及发布/删除/发送消息/清空数据（`video_clear_data`）**永不**从聊天触发，只提示去插件面板手动操作。
- 审计留痕：每次对话控制在 `localStorage["maltese-agent-console-log"]` 追加 `{at, action, argsHash, ok, message}`（最近 100 条，不含聊天正文/密钥/API Key），控制台底部「最近操作」可查；只读查询也记录。
- 不在日志里写模型完整回复或用户原话，只写 action 与结果。

---

## 5. 交互细节

| 状态 | 规格 |
| --- | --- |
| 加载 | 首屏先出骨架（≤300ms 出现），数据 ≤3s 填充；不阻塞面板其它页签 |
| 空状态 | ①「今天还没有模型调用」②「当前没有进行中的任务」③「没有运行中的 agent」；各带一行引导（如「去聊天问一句试试」） |
| 失败态 | 卡片级红色错误条 + 中文原因 + 「重试」；保留上次数据并标注「数据可能过期 HH:mm」；单卡失败不影响其它卡 |
| 刷新 | 事件优先：`video-session-updated`（已有）、未来 `agent-usage-updated`；轮询只在该页签可见时 **3s** 一次，隐藏/切走后停止；手动刷新 3s 防抖 |
| 数字格式 | token：`<1万` 直出，`≥1万` 用 `12.3k`；百分比整数 + `%`；时长 `<60s` → `42s`，`<60min` → `3分12秒`，否则 `1小时5分`；时刻 `HH:mm`；首字 `420ms` / `1.2s`；平均保留 1 位小数 |
| 颜色 | 运行=品牌浅绿、排队/警告=浅橙、失败=红；数字用等宽字体，避免刷新跳动 |
| 对话入口 | 页签顶部一行提示「也可以直接问我：现在有几个任务在跑 / 暂停刷视频 / 生成今天日报」，点击可跳到聊天页 |

---

## 6. 验收判据

1. **首屏 3s 出数据**：冷启动后打开 Agent 页签，三卡均有数据或明确空状态（骨架 ≤300ms 出现）。
2. **进度实时**：视频采集中进度条/已采集条数在 3s 内反映变化；暂停后 3s 内显示「已暂停」，ETA 变为「—」。
3. **对话识别**（至少 3 条）：
   - 「现在有几个任务在跑」→ 返回任务数 + 名称，不弹确认；
   - 「暂停刷视频」→ 弹确认卡 → 点确认后 ≤2s 视频停止，控制台状态同步为已暂停；点取消则不执行；
   - 「删掉所有记录」→ 不执行任何删除，明确回复可支持的操作范围。
4. **失败可读**：本地统计缺失、视频服务未启动、模型离线三种情况均显示中文原因 + 重试入口。
5. **不新增常驻开销**：页签不可见时无轮询；空闲 5 分钟 CPU 增幅 <0.5%；聚合命令本机耗时 <50ms；`agent-usage.json` 按天滚动，不超过 7 天。
6. **留痕**：每条对话控制在「最近操作」可见（action/结果/时间），不含聊天正文。
7. **不回归**：其它页签、聊天、视频插件行为不变；关闭视频插件后控制台显示「未启用」而不是报错。

---

## 7. MVP 范围

**P0（本轮做）**
1. 主面板「Agent」页签 + 首屏 ①用量 ②任务进度 ③工作分配（只读）。
2. Rust：`agent_console.rs` 埋点（本机/DSh 请求数、首字、总时长、失败）+ `get_agent_usage` + `local_model_status` + `get_agent_console_snapshot`；`local_chat_stream`/`local_chat`/`dsh_chat` 增加 `source` 参数。
3. 对话：`agent_usage`、`agent_tasks`、`agent_open_console` 三条只读 + `agent_pause_video` 一条带确认；白名单与拒绝话术。
4. 审计日志 + 空/加载/失败态。

**P1（后续）**：`agent_resume_video`、`agent_generate_digest`、翻译计数、7 日趋势小图、插件状态、固定到桌面（`PinnedPanel` 增加 agent 页）。

**不做**：真实余额/计费、跨进程/多实例统计、任意命令执行、模型自动确认改状态动作、云端上报。

---

## 8. 研发改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/agent_console.rs`（新） | 埋点存储（`agent-usage.json`，按天 7 天）、`get_agent_usage`、`local_model_status`、`get_agent_console_snapshot` |
| `src-tauri/src/local_chat.rs` / `dsh_chat.rs` / `translation.rs` | 记录请求（source、首字、总时长、ok）；`source` 参数 |
| `src-tauri/src/lib.rs` | `mod agent_console;` + `generate_handler!` 注册 3 个命令 |
| `src/AgentConsole.tsx` + `.css`（新） | 三卡 + 刷新 + 空/加载/失败态 + 最近操作 |
| `src/App.tsx` | `IslandPage` 加 `"agent"`、导航页签、`PAGE_LABELS`、渲染组件；主动聊天传 `source:"proactive"` |
| `src/PetChat.tsx` | 传 `source:"chat"/"decision"`；确认卡片 + `pendingSkill` 状态；确认/取消/超时 |
| `src/petSkills.ts` | `SkillAction` 与 `SKILLS` 增加 5 个 action；`runSkill` 分支（含参数校验）；`needsConfirm` 元数据 |
| `src/i18n/{types.ts,locales/zh-CN.ts,locales/en.ts}` | 页签名、卡片标题、确认话术、错误文案、拒绝话术 |

**不改**：不新增 Rust 常驻线程（埋点只在请求路径上累加）；不改视频/待办现有存储格式；不改版本号、不 push。