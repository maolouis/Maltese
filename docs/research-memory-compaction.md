# 上下文用尽后的记忆 compacting 方案

> 日期：2026-11-19 · 结论：**做「短期原文 + 事实卡 + 当日摘要」三层，事实卡与摘要作为 Rust 侧 system 注入；默认注入 ≤70 token，摘要按需替换旧原文，不做向量 RAG（本机没有文本 embedding 端点）。**

## 1. 问题定义（读代码确认）

- **模型窗口**：Strata `qwen3.6-35b-a3b-ud-q4_k_xl`，`/v1/status` 显示 `n_ctx=8192`；2026-11-19 实测 prompt 处理 **1.7–4.2ms/token**（多次采样波动），RTX 4070 已用约 11.3GB/12.2GB。
- **当前 history 裁法**：本地分支每次请求只带 `history.slice(-16)`（`PetChat.tsx`），`local_chat.rs` 再按 `MAX_HISTORY_TURNS=16` 截断；DSH 分支不传 history，只传 `sessionId`，上下文由 CLI 维护。聊天记录本身在 `petChatStorage.ts` 保留 `MAX_MESSAGES=60` 条原文，**没有 token 计数、没有摘要、没有事实记忆**。
- **后果**：超过 16 轮，旧轮次被静默丢弃，模型不会知道之前聊过什么；若单轮消息很长（粘贴大段文本/图片），16 轮也可能撑爆 8192。超出窗口时后端是截断还是报错**尚未实测**，但前端没有保护。
- **DSH 后端不同**：`dsh_chat` 把 `sessionId` 交给 DSH CLI，上下文由 DSH 内部维护（是否有 compact 不由本应用控制）；本方案要兼顾两条后端，不能假设 DSH 会保留全部历史。
- **现有上下文注入**：`petContext.ts` 把自我状态/近期互动压成 ≤120 字符（`CHAT_CONTEXT_MAX_CHARS`），放进 history 的 system 消息；但 `local_chat.rs` 的 `build_messages` 只保留 `user/assistant`，**前端 system 会被丢掉**——记忆不能只靠前端 history 注入，必须走 Rust 参数。

## 2. 方案对比

| 方案 | 原理 | 成本 | 实现位置 | 对首字延迟影响 |
| --- | --- | --- | --- | --- |
| **滑动窗口 + 固定 system** | 只保留最近 N 轮；固定 persona/状态 | 最低 | `PetChat` 截断 + `local_chat` 上限 | 无额外 token；但超窗信息永久丢失 |
| **递归摘要** | 超阈值把旧轮次压成 ≤200 字摘要，下一次摘要可再摘要 | 中：摘要调用一次模型 | 新 `memory` 模块 + Rust 注入 | 摘要替换旧原文，净 token 通常下降；摘要生成本身异步，不挡首字 |
| **事实抽取（KV）** | 从对话抽「名字/喜好/正在做/待办」存结构化卡，不存原文 | 中：抽取调用一次模型 | 新 `memory` 模块 + localStorage/应用数据 | 注入 top5 事实，约 40–70 token（+0.1–0.3s） |
| **向量 RAG** | 原文切块 embedding，按相似度检索 | 高：需 embedding 模型/服务 + 向量库 | 独立服务/表 | 检索快，但注入片段 token 不可控；本机无 embedding |
| **分层记忆（推荐）** | 短期原文 + 当日摘要 + 长期事实卡 | 中 | 前端存储 + Rust 注入 | 默认 ≤70 token；摘要替换旧原文 |

**RAG 可行性（已核实）**：`GET http://127.0.0.1:8080/v1/embeddings` 返回 **404**；`serve/server.py` 里只有视觉图片的 “embeddings”（`GENI`），不是文本 embedding API；模型架构 output 只有 text。要在本机做 RAG 得另起一个 embedding 模型/服务（CPU 或 GPU）并加向量库，12GB 显存已被 35B 模型占满，**首版不可行**。

## 3. 推荐方案与 MVP

### 3.1 三层结构

| 层 | 内容 | 存储 | 保留 | 注入 |
| --- | --- | --- | --- | --- |
| 短期 | 最近 **8–12 轮**原文 | 现有 `focusd-island-pet-chat-messages`（60 条） | 12 轮内 | 全部/最近 8 轮 |
| 中期 | **当日摘要**（≤200 字/天，保留最近 3 天） | 新 key `maltese-chat-memory-v1` 的 `daily[]` | 3 天 | 只注入最新 1 天，压成 1–2 句 |
| 长期 | **事实卡**（≤20 条，每条 key/value/置信度/时间） | 同 `maltese-chat-memory-v1` 的 `facts[]` | 长期，可清 | 按最近/相关取 **top5** |

### 3.2 触发与阈值

- 估算 token：`cjk 字符数 ×1 + 其他字符 /4 + 每轮 4`；**超过 6000**（8192 减去 persona、输出与安全余量）或轮次 >12 → 触发 compact。
- Compact：保留最近 **8 轮原文**，把更早的 4–8 轮交给摘要模型（提示词「≤200 字，保留人物/偏好/正在做的事/约定」）；摘要成功才删除对应旧原文，失败则保留 16 轮滑动窗口。
- 摘要重算：**按天一次**（00:05 或当天首轮聊天），或累计新增 ≥8 轮；同一摘要最多 3 天。
- 事实抽取：每 **6 个用户轮次**或聊天空闲 60s 后异步跑；输入最近 8 轮，输出最多 3 条 JSON 事实（`{"facts":[{"key":"name","value":"小林","confidence":0.9}]}`）；按 key 去重/覆盖，最多 20 条。
- 失败降级：摘要/抽取超时（8s）或模型错误 → 不写 memory、退回 16 轮滑动窗口，聊天照常发送；错误只在设置页显示，不阻塞。

### 3.3 注入顺序与预算

顺序：`persona（含表情包指令）→ 事实卡 top5 → 最新摘要（只取首 1–2 句，≤40 token）→ 最近 8 轮原文 → 当前用户消息`。

- **默认预算**：事实卡 top5 + 摘要 1 句 ≈ **60–70 token**；按实测 1.7–4.2ms/token ≈ **0.1–0.3s**，满足「首字 +≤300ms」。
- **上限 300 token** 只用于「深度记忆」模式（多注入事实/摘要）：300 token ≈ **0.5–1.3s**，会超过 300ms 目标，默认关闭并在设置里标明代价。
- 摘要替换旧原文是**净减少** token；不要“摘要 + 全部旧原文”同时注入。
- **实现位置**：`local_chat.rs` 的 `build_messages` 增加 `memory_context: Option<&str>`，拼在 system（persona 之后）；前端传 `memoryContext` 参数。不要放进 `history` 的 system 消息（会被过滤）。DSH 分支把 memory 拼进 prompt（每次或仅新会话），并注意 DSH session 自身也会累积上下文，避免重复注入。
- 摘要/事实卡注入失败（超长/编码错误）→ 跳过，不影响聊天。

## 4. 与现有功能的耦合

- **主动消息**：`proactiveChat.ts` 已有 `maltese-proactive-history`（48 条/7 天）和当场 `recentEvents` 去重；记忆只注入 **top3 事实（≤40 token）**，不注入摘要，避免和它自己的历史重复。主动聊天已有 30s tick 与免打扰，不加模型调用。
- **自我状态**：`petContext.ts` 当前 ≤120 字符，按中文约 1 token/字 ≈ **80–120 token**（不是 60）；记忆默认 70 token，两者同时注入约 150–190 token（按 1.7–4.2ms/token ≈ **0.3–0.8s**），会吃掉首字预算。建议同时注入时：vitals 压到 ≤60 token + 事实 top3 ≤40 token；或只在触发 compact 的轮次注入摘要，平时只注入事实。状态注入目前走 history system 会被本地后端丢掉，建议和 memory 一起改为 Rust 参数（顺手修这个既有问题）。
- **技能决策**：`PetChat` 用 128 token/20s 的独立判断；**不要注入记忆**，否则会改变工具选择并增加一次 prefill；技能调用前保持无记忆。
- **单槽位**：摘要/事实抽取是额外生成，必须**空闲调度**（聊天 busy 或 30s 内有消息时跳过），不能和用户消息抢槽位；失败立即放弃，不排队。

## 5. 验收判据

| 场景 | 判据 |
| --- | --- |
| 20 轮对话 | 能答出用户 3 个事实（名字/喜好/正在做的事）；把其中一条放在第 2 轮，20 轮后仍能回忆 |
| 首字延迟 | 默认记忆注入（≤70 token）相对无记忆 +≤300ms；300-token 深度模式另测（预计 +0.5–1.3s，需产品确认） |
| 摘要可回溯 | 触发 compact 后问旧话题，答案来自摘要且不胡说；摘要 ≤200 字 |
| 失败降级 | 摘要模型超时/报错时，聊天仍可发送；回到 16 轮滑动窗口，不丢当前轮 |
| 清空入口 | 设置里「清空聊天记忆」一键删 facts/daily（不影响聊天原文），二次确认 |
| 预算 | 注入 token 估算器记录每次实际注入量；默认 ≤70，深度模式 ≤300 |

## 6. 隐私

- 记忆存 **WebView2 的 localStorage** `maltese-chat-memory-v1`（与聊天记录同目录），只存**派生摘要/事实**，不存被压缩的原文；原聊天记录仍受 `MAX_MESSAGES=60` 管理。
- 摘要/事实抽取的输入是最近几轮对话，只发给当前聊天后端（本地 Strata 或 DSH）；不外发、不上传第三方。DSH 后端自身的 session 存储按其策略，不在本方案控制内。
- 清空：删除 `maltese-chat-memory-v1`；可选同时清空聊天记录；提供导出/查看（仅本地）便于用户审计。
- 敏感信息：验证码、密码、身份证等不写入事实卡；抽取提示词要求「不记录敏感信息」，并在前端过滤明显敏感 key。

## 7. 代码/事实来源

- `src/PetChat.tsx`（`history.slice(-16)`、`systemContext` 注入、DSH 不传 history）、`src/petChatStorage.ts`（`MAX_MESSAGES=60`）、`src-tauri/src/local_chat.rs`（`MAX_HISTORY_TURNS=16`、`build_messages` 过滤 system）、`src-tauri/src/dsh_chat.rs`（session 由 CLI 维护）
- `src/chatGuard.ts`（首字/排队/空闲/总超时）、`src/petContext.ts`（`CHAT_CONTEXT_MAX_CHARS=120`）、`src/proactiveChat.ts`（48 条/7 天）
- 运行态：`GET http://127.0.0.1:8080/v1/status`（`n_ctx=8192`、prompt 速率、显存）；`GET /v1/embeddings` → 404；`serve/server.py` 仅视觉 embedding