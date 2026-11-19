# 对话任务进度识别与 Token 自动统计预研

> 日期：2026-11-19 · 结论：**Token 可以做到精确统计**（本机有 `usage` 与 `count_tokens` 两条精确路径）；**任务进度可行，推荐「技能驱动状态机为主 + 模型推断兜底」的混合方案**，先做技能覆盖的任务（todo/search/settings/video/daily/agent/chat）。

## A. 自动计算 Token

### A1. 本机精确口径（已实测，2026-11-19）

| 端点/字段 | 实测结果 | 结论 |
| --- | --- | --- |
| `POST /tokenize` | **404** | 不支持 |
| `POST /v1/tokenize` | **404** | 不支持 |
| `POST /v1/messages/count_tokens` | 200；`{"input_tokens":13}`（"你好"）；同一 4 轮 system+user+assistant+user 为 `{"input_tokens":39}` | **精确 prompt token 计数可用** |
| `/v1/chat/completions` 非流式 `usage` | `{"prompt_tokens":13,"completion_tokens":2,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0}}`；4 轮消息请求 `prompt_tokens=39` | **精确，且与 count_tokens 完全一致** |
| 流式 `usage` | 不加 `stream_options`，最后一个 chunk 仍带 `"usage":{...}` 与 `"timings":{prompt_n,...}`；加 `stream_options.include_usage=true` 也正常 | **流式无需额外请求即可拿 usage**；客户端提前断开则可能拿不到 |
| Tokenizer 文件 | `F:\Strata\packs\qwen36-ud-q4_k_xl\tokenizer\{tokenizer.json 554B, vocab.json 5.7MB, merges.txt 3.6MB}`；tokenizer.json 是 Strata 自定义描述（`model:"gpt2", pre:"qwen35"`），不是 HuggingFace 完整 tokenizer | 可用 BPE 库离线算，但需复刻预切分/特殊 token；**不推荐重写，优先 count_tokens** |
| 性能 | `count_tokens` 272 字/85 token：首次 395ms，后续 **7–12ms**；4000 字/1053 token：首次 393ms，后续 **9–11ms** | 每请求调用一次可接受；不要每个 delta 调 |

### A2. 现有统计现状（读代码确认）

- `local_chat.rs` / `local_chat_stream`：只取 `choices[0].message.content` / `delta.content`，**没有解析 `usage`**；`dsh_chat.rs` 的 `parse_events` 只认 `text/final/session`，**没有 usage**（DSH 是否在事件里给 token 需实测）。
- `agent_hub.rs`：日志有 `agentId/kind/streamId/promptPreview/promptLength`、`durationMs/firstLineMs`、`ok/exitCode/error`，**没有 token 字段**；`AgentUsageSummary` 只有 runs/failures/平均时长/首字/日志路径。
- `AgentConsole.tsx`：已经有「Token（估算）」卡片，但值显示 `—`（占位未接）；`usageTokens` 文案已存在。日志目录在 `%APPDATA%\com.maolouis.maltese\agent-hub\logs\agent-YYYY-MM-DD.jsonl`（当前无运行记录）。

### A3. 推荐方案

**精确优先，估算兜底，并在 UI 标注来源。**

1. **本地后端**：解析非流式 `usage`；流式解析最后一个 chunk 的 `usage`（建议同时传 `stream_options:{include_usage:true}` 兼容其他 OpenAI 实现）；记录 `prompt/completion/total/cached`，精度标 `exact`。
2. **需要请求前预算/纯 prompt 计数**：调用 `POST /v1/messages/count_tokens`（与 usage 同源，实测一致），精度 `exact`；只在大请求/UI 预算显示时调用，避免每轮多一跳。
3. **DSH 后端**：先检查其 NDJSON 是否有 usage；没有则用**启发式估算** `CJK/1.6 + 其他/4`，标 `estimated`，并在 UI 显示“估算”，不承诺 ≤2%。
4. **Agent Hub / 外部 CLI**：解析 stdout 中可能的 JSON usage；没有就记录 `promptLength`（已有）与 `outputChars`，用启发式，标 `estimated`。
5. **落盘结构**：`%APPDATA%\com.maolouis.maltese\usage\usage-YYYY-MM-DD.jsonl`，一行一条：
```json
{"at":1795076000000,"source":"chat|proactive|decision|video-comment|agent|memory","backend":"local|dsh","model":"qwen3.6...","requestId":"...","taskId":"...","promptTokens":13,"completionTokens":2,"cachedTokens":0,"totalTokens":15,"precision":"exact|estimated","durationMs":844}
```
按天文件 + `usage_summary` 命令（今日/按来源/按 backend 聚合）；`AgentConsole` 的 Token 卡片显示今日总量 + 精确/估算占比；`usage_clear` 清空。
6. **性能**：usage 路径零额外请求；count_tokens 约 10ms/千 token；流式不重复计费/不额外生成；统计只写一行日志，不阻塞聊天。

## B. 识别对话任务运行到哪了

### B1. 任务定义与状态模型

任务类型（有限集）：`chat`（闲聊）、`search`（查信息）、`settings`（改设置/换口味）、`todo`（待办）、`video`（刷视频/查进度）、`daily`（生成日报）、`agent`（跑 Agent/流水线）、`other`。

阶段：`requested → planning → executing → waiting_confirm → delivering → done / failed / cancelled / stalled`（`stalled` 为超时无更新）。

```ts
type Task = {
  id: string; kind: TaskKind; stage: Stage;
  title: string; startedAt: number; updatedAt: number;
  progress?: { current: number; total: number };
  tokens?: { prompt: number; completion: number; precision: "exact" | "estimated" };
  error?: string;
};
```

超时/放弃：search 120s、agent 300s（现有 `RUN_TIMEOUT`）、video 按 `maxMinutes`、daily 10min；超过 2× 预期无更新标 `stalled`；用户停止/新任务接管时置 `cancelled`；任务列表保留最近 20 条。

### B2. 三种方案对比

| 方案 | 原理 | 成本 | 延迟 | 风险 |
| --- | --- | --- | --- | --- |
| **技能驱动状态机** | `petSkills` 命中即建任务，`runSkill` 返回值推进阶段；video/agent 用现有 snapshot/step 事件 | 低；改动集中在映射表 | 零额外模型调用 | 未命中技能的任务只能标 `chat/other` |
| **对话内模型推断** | 每轮让模型输出 `{task,stage,confidence}` | 中：额外一次生成（约 100 token） | 单槽位下 +0.3–1s；异步可避开首字 | 幻觉、误分类；需置信度门限 |
| **混合（推荐）** | 技能/事件优先；未命中再关键词规则；仍不确定才异步模型推断，confidence<0.6 标 `unknown` | 中低 | 正常任务零额外调用 | 推断只做兜底，不覆盖确定性状态 |

**推断实现**：在最终回复后异步跑（聊天 busy/30s 内不跑），输入最近 2 轮，输出最多 100 token JSON；失败/超时直接丢弃，不影响聊天。不要在主回复前推断。

### B3. 技能 → 任务/阶段映射

| 技能/事件 | 任务 | 阶段推进 |
| --- | --- | --- |
| `todo_add/list/done/start/pause` | todo | 调用即 `executing`，成功 `done`，失败 `failed` |
| `web_search` | search | `planning`（发起）→ `executing`（搜索中）→ `done/failed`；120s 超时 |
| `pet_settings`、`open_app/open_url`、`media_control` | settings | `executing`→`done`（快任务） |
| `video_start_session` + `video_get_snapshot` | video | `requested`→`executing`（采集）→`delivering`→`done`；progress 用 itemCount/steps |
| 新命令 `daily_video_generate` | daily | `planning`（选题）→`executing`（生成）→`waiting_confirm`→`delivering`→`done` |
| `agent_run/agent_pipeline` | agent | `requested`→`executing`（step i/n，用 `agent-pipeline-step`）→`done/failed`；300s 超时 |
| 普通聊天 | chat | 发送即 `executing`，回复 `done`；失败 `failed` |

### B4. 展示与刷新

- `AgentConsole.tsx` 已有「任务进度」卡片（目前只展示视频采集）和「工作分配」卡片；扩展为**任务列表**：类型、阶段、进度条、耗时、token、错误；按 `updatedAt` 排序，最多 5 条。
- 数据来源：Rust 内存状态 + JSONL 落盘；前端 1s 轮询 `agent_task_state`（或事件推送），只更新变化的行，避免整页重渲染；保留“运行/等待确认/失败”颜色。
- 「工作分配」卡片显示每个 Agent/模块当前绑定的任务 id；任务结束后保留最近一次结果。

### B5. 验收判据

| 场景 | 判据 |
| --- | --- |
| 5 个真实任务 | 换口味、生成日报、查视频进度、加待办、跑 agent，任务类型+阶段均正确（技能覆盖路径 100%） |
| Token 精确性 | 本地有 usage 的请求，记录值 vs 响应 usage 误差 **0%**（目标 ≤2%）；流式请求也能记录；DSH/估算路径明确标 `estimated` |
| 请求前预算 | `count_tokens` 值与同请求 usage 一致（实测 13/13、39/39）；warm 延迟 ≤20ms/千 token |
| UI | 任务/Token 卡片 1s 刷新不卡顿；无任务时显示空态；清空记忆/统计有入口 |
| 断言 | 任务超时/失败有明确 stage；推断置信度低标 `unknown`，不伪造阶段 |

### B6. 待实测 / 需实机

- DSH NDJSON 是否带 usage（需跑一次真实 DSH 对话抓事件）；Agent CLI 输出是否含 usage。
- 模型推断在 5 类真实任务上的准确率（需人工标注 20 条）；单槽位异步推断对首字的影响。
- `count_tokens` 对工具调用/图片消息的计数（当前只验证纯文本）；UI 1s 刷新在长任务列表下的开销。

## 3. 推荐 MVP 与文件清单

**Token（先做，S/M）**：local usage 解析 + usage.jsonl + `usage_summary` + AgentConsole Token 卡片；DSH 估算标注；count_tokens 仅用于预算显示。
**任务进度（S/M）**：技能状态机覆盖 todo/search/settings/video/agent/chat；AgentConsole 任务卡；模型推断后置。

| 文件 | 改动 |
| --- | --- |
| 新增 `src-tauri/src/usage.rs` | Usage 记录、按天 JSONL、聚合/清空命令 |
| `src-tauri/src/local_chat.rs`、`dsh_chat.rs` | 解析 `usage`（流式 final chunk）；DSH 无 usage 时估算 |
| `src-tauri/src/agent_hub.rs` | 日志加 token/outputChars；`AgentUsageSummary` 加 token 字段 |
| 新增 `src-tauri/src/task_progress.rs` | Task 状态机、技能映射、超时、查询命令 |
| `src-tauri/src/lib.rs` | 注册命令/初始化 |
| `src/AgentConsole.tsx`、`src/agentHub.ts`（如有） | Token 卡片、任务列表、1s 刷新 |
| `src/petSkills.ts`、`src/PetChat.tsx`、视频调用点 | 技能开始/成功/失败时更新任务 |
| `src/i18n`、`docs/agent-console-design.md` | 文案与设计说明 |

## 4. 事实来源

- 实测：`POST /tokenize` 404、`/v1/tokenize` 404；`/v1/messages/count_tokens` 200（13/39）；`/v1/chat/completions` usage（13/2/15、39/1/40）；流式 final chunk usage + timings；`count_tokens` 272 字→85 token（7–12ms warm）、4000 字→1053 token（9–11ms warm，首次约 395ms）。
- 代码：`src-tauri/src/local_chat.rs`、`dsh_chat.rs`、`agent_hub.rs`、`src/AgentConsole.tsx`、`src/petSkills.ts`、`src/PetChat.tsx`；`F:\Strata\packs\...\tokenizer` 文件；`GET /v1/status` 的 `n_ctx=8192`。