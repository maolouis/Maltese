# 聊天 vs 主动聊天：为什么「主动能说、我说话却思考不出来」诊断

> 记录时间：2026-11-17
> 角色：产品分析（只读代码 + 本机只读旁证；不改代码、不改版本号）
> 适用范围：Windows 实机、Maltese 2.0.2、聊天后端 = 本地模型（本机 Strata，`127.0.0.1:8080`）
> 一句话先回答：**不是「应用把用户对话排到了主动消息后面」这种队列问题**；两条链路打的是同一台**单槽位**模型服务，用户对话慢/答不出来主要是三件事叠加——**思考预算把 `max_tokens` 吃光（流式路径没有空正文重试）**、**每条用户消息前面先跑一次技能决策生成**、**单槽位上的并发/引擎重启/冷启动把请求拖长甚至取消**；应用侧既没有队列，也没有「用户对话优先」机制。

---

## 1. 用户视角结论（先回答「是不是队列顺序卡住」）

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 是不是队列顺序卡住？ | **不是主因，只能算部分相关。** 应用侧没有排队逻辑：主动和聊天各自直接调 `local_chat_stream`，谁先发谁先占模型；只有模型服务是单槽位（`Slots occupied --/1`），后到的请求只能等。 | [App.tsx:7175](../src/App.tsx)、[PetChat.tsx:262](../src/PetChat.tsx)、[local_chat.rs:243](../src-tauri/src/local_chat.rs)、[local_chat.rs:375](../src-tauri/src/local_chat.rs) |
| 那为什么「主动能说、对话不行」？ | 因为**两条链路成功的门槛不一样**：主动链路关思考、只要 128 token，且模型失败会退到本地兜底台词，所以**永远说得出话**；对话链路开思考（若用户开了档位）时上限只有 `maxTokens`（默认 256），思考把预算吃光就没有正文，而**流式路径不会像非流式那样关思考重试**，最后只有思考、没有回答或直接报错。 | [App.tsx:7184](../src/App.tsx)（128/关思考/兜底 [App.tsx:7256](../src/App.tsx)）、[PetChat.tsx:362](../src/PetChat.tsx)、[localChat.ts:20](../src/localChat.ts)、[local_chat.rs:326](../src-tauri/src/local_chat.rs)、[local_chat.rs:209](../src-tauri/src/local_chat.rs) |
| 那「能主动说话」是不是说明模型好着？ | **不能。** 主动聊天在模型失败、返回空、或调不通时都会用模板台词兜底（`pickFallback`），用户看到的「主动说话」可能是兜底句，不代表模型当时可用。 | [App.tsx:7256](../src/App.tsx)、[proactiveChat.ts:434](../src/proactiveChat.ts) |
| 聊天侧失败为什么像「一直在思考」？ | 前端只有 `busy` + 每秒加一的「小狗正在思考…（Ns）」，**没有排队提示、没有取消、没有阶段性文案**；命令最长等 180s。思考内容还在、正文没来时，界面看起来就是「他思考不出来」。 | [PetChat.tsx:737](../src/PetChat.tsx)、[PetChat.tsx:755](../src/PetChat.tsx)、[local_chat.rs:30](../src-tauri/src/local_chat.rs) |

---

## 2. 两条链路对照表

| 维度 | 主动聊天（能说话的那条） | 用户对话（思考不出来那条） |
| --- | --- | --- |
| 入口 | 30s tick + 手动「立即试一句」 | 聊天页发送（岛内展开页 / 固定标签页窗口） |
| 代码 | [App.tsx:7025](../src/App.tsx)～[App.tsx:7295](../src/App.tsx) | [PetChat.tsx:399](../src/PetChat.tsx)～[PetChat.tsx:533](../src/PetChat.tsx) |
| 后端选择 | `config.backend === "local" && config.model` 才走本地，否则 DSH | 同左（`chatConfig.backend`） |
| 模型 | Strata `qwen3.6-35b-a3b-ud-q4_k_xl`（本机 8080） | 同一个 |
| 思考 | **强制关**：`enableThinking:false`、`reasoningEffort:"none"`、budget `0` | **跟随设置**：默认「关」，用户可开 浅/标准/深 |
| max_tokens | **128**（注释：只要一句短话，给多反而慢） | **`chatConfig.maxTokens`，默认 256**（可 32–2048） |
| 温度 | 0.85（重复重试时 1.0） | `chatConfig.temperature`，默认 0.7 |
| 历史 | 空数组 | 最近 16 条 |
| 是否流式 | 是（`local_chat_stream`），首字 ≥6 字先弹气泡 | 是（默认 `stream:true`）；关流式时退回非流式 `local_chat` |
| 每次消息的模型请求数 | 1 次；台词重复时最多 +2 次重试 | **至少 2 次**：先技能决策（128 token/关思考），再正式回复；命中技能再 +1 次总结 = 最多 3 次 |
| 并发/槽位 | 占用唯一槽位一次生成 | 两次串行生成各占一次；若另一窗口/主动请求在跑，还要等或被打断 |
| 超时 | 连接 25s / 请求 180s | 同左 |
| 离线拉起 | 主动 tick 会调 `ensure_local_model`（10 分钟缓存），最长等约 120–240s（launch 120s + 轮询 120s） | 只在技能决策报「连接不到」时调 `ensure`；**正式回复不调** |
| 失败重试 | 模型失败 → 模板台词，用户无感 | 流式空正文**不重试**直接报错；非流式会关思考、预算抬到 ≥512 重试一次 |
| 首字时机 | 一次 prefill + 128 token 解码；本机文档实测约 0.3–1.6s | 技能决策先整段生成完（0.5–数秒）→ 再正式回复；若开思考，还要等思考预算花完 |
| 谁先占资源 | 先到先占；**没有优先级** | 同左；开聊前已在途的主动请求会继续占槽位 |
| 用户可感知失败 | 几乎没有（兜底） | 只有转圈秒数；最终错误或空正文 |

> 参数来源：[App.tsx:7184-7193](../src/App.tsx)、[PetChat.tsx:353-370](../src/PetChat.tsx)、[localChat.ts:20-25](../src/localChat.ts)、[localChat.ts:46-60](../src/localChat.ts)、[local_chat.rs:102-138](../src-tauri/src/local_chat.rs)、[local_chat.rs:29-30](../src-tauri/src/local_chat.rs)。

---

## 3. 候选根因排序（含文件:行号证据）

### 3.1 排序总表

| 排序 | 候选根因 | 证据（文件:行） | 状态 |
| --- | --- | --- | --- |
| **1** | **思考预算 > max_tokens，正文被吃光；流式路径无空正文重试** | [localChat.ts:20-25](../src/localChat.ts)（标准 512 / 深 1536）、[localChat.ts:53](../src/localChat.ts)（默认 256）、[PetChat.tsx:362-369](../src/PetChat.tsx)（回复用 `maxTokens`）、[local_chat.rs:326-328](../src-tauri/src/local_chat.rs)（流式空正文直接 Err）、[local_chat.rs:209-239](../src-tauri/src/local_chat.rs)（非流式才有重试） | 读代码确认缺陷；用户实际档位需实机确认 |
| **2** | **每条消息先跑一次技能决策生成（默认开启），把首字推后一个完整生成周期** | [PetChat.tsx:137-143](../src/PetChat.tsx)（`agentEnabled` 默认 true）、[PetChat.tsx:445-465](../src/PetChat.tsx)（决策 128 token）、[PetChat.tsx:469-499](../src/PetChat.tsx)（命中技能再 400 token 总结） | 读代码确认 |
| **3** | **单槽位并发：新请求会等/被打断；应用无优先级、无排队提示** | 外部事实（monitor `Slots occupied --/1`）；应用无锁/无优先级：[App.tsx:7175](../src/App.tsx) 与 [PetChat.tsx:262](../src/PetChat.tsx) 各自直连；真实并发入口：固定标签页聊天与岛内聊天各一个 `PetChat` 实例（[PinnedPanel.tsx:104](../src/PinnedPanel.tsx)），`busy` 互不共享；开聊前已启动的主动请求：tick 只在开始判定 `collapsed`（[App.tsx:7071](../src/App.tsx)），模型调用后才复查（[App.tsx:7265](../src/App.tsx)） | 读代码 + 本机日志旁证；用户现场需复现 |
| **4** | **引擎冷启动/重启/预热把「思考」拖成几十秒到几分钟** | [local_chat.rs:375-404](../src-tauri/src/local_chat.rs)（health 只给 4s，拉起最多 40×3s）、[local_chat.rs:406-493](../src-tauri/src/local_chat.rs)（`--restart`、最长 60×2s 等 ready）；本机日志出现 `warmed up in 173.4 s`、多次 `engine started`（见 §6.3） | 读代码 + 本机旁证；尚不能证明是桌宠触发重启 |
| **5** | **前端没有取消/超时分级/排队状态，失败被后续流程掩盖** | [PetChat.tsx:399-533](../src/PetChat.tsx)（无 abort）、[PetChat.tsx:466-468](../src/PetChat.tsx)（决策失败静默吞掉）、[PetChat.tsx:527-530](../src/PetChat.tsx)（失败时不清思考、不留重试入口）、[local_chat.rs:30](../src-tauri/src/local_chat.rs)（180s 超时） | 读代码确认 |
| — | 前端 interrupt / 去重吞回复 | 聊天链路没有 interrupt/去重代码；`local-chat-stream` 事件按 `requestId` 过滤，两条链路不会串台（[PetChat.tsx:341](../src/PetChat.tsx)、[App.tsx:7156](../src/App.tsx)） | 读代码排除 |
| — | `ensure_local_model` 卡住每条消息 | 正式回复不调用 ensure；决策只在「连接不到」时调用一次（[PetChat.tsx:283-310](../src/PetChat.tsx)），所以不是每条都卡 | 读代码排除（但见 #4） |

### 3.2 根因 1 展开：思考吃光预算的完整链路

1. 用户在聊天设置选「标准 / 深」→ `thinkingDepth` 不再为 `off`（[LocalChatSettings.tsx:237-258](../src/LocalChatSettings.tsx)）。
2. 发送时 `streamLocalReply` 组装参数：`maxTokens = chatConfig.maxTokens`（默认 256），`enableThinking = depth !== "off"`，`reasoningBudgetTokens = thinkingBudget(depth)`（标准 512、深 1536）（[PetChat.tsx:353-370](../src/PetChat.tsx)、[localChat.ts:20-25](../src/localChat.ts)）。
3. Rust 原样转发：`max_tokens`、`enable_thinking`、`reasoning_budget_tokens`（[local_chat.rs:108-118](../src-tauri/src/local_chat.rs)）。**这里没有任何「预算必须小于 max_tokens」的校正。**
4. 服务端把输出预算按总量算：思考先花掉预算，正文还没开始就 `finish_reason=length` → 流里只有 `reasoning`，`content` 为空（历史实测见 [v1.3.29.md](releases/v1.3.29.md)：开思考 + 120 token → 只有 thinking）。
5. `local_chat_stream` 结束时 `full_text` 为空 → 直接返回错误（[local_chat.rs:326-328](../src-tauri/src/local_chat.rs)）。**非流式 `local_chat` 有「关思考 + 预算抬到 ≥512 重试」的兜底（[local_chat.rs:209-239](../src-tauri/src/local_chat.rs)），流式没有。**
6. 前端把错误显示出来，但思考内容还留在界面上（[PetChat.tsx:527-530](../src/PetChat.tsx)），用户看到的就是「想了半天，答不出来」。

> 产品含义：默认 `maxTokens=256` 与「标准 512 / 深 1536」的预算天生不匹配；只要用户点开思考，就可能必现「只有思考、没有正文」。

### 3.3 根因 2 展开：技能决策偷走首字

- `agentEnabled` 默认开启（`localStorage.maltese-agent-mode !== "off"`），发送纯文字消息时先走技能决策（[PetChat.tsx:445-465](../src/PetChat.tsx)）。
- 决策本身是一次完整生成：128 token、temperature 0.1、关思考；返回后若没解析到技能调用，结果**直接丢弃**（[PetChat.tsx:498](../src/PetChat.tsx)），然后才发正式回复。
- 命中技能时还要再生成一次 400 token 的总结（[PetChat.tsx:475-479](../src/PetChat.tsx)），即一次用户消息最多 3 次串行生成。
- 单槽位下这 2～3 次是严格串行：用户看到的「首字」要等前一次生成结束。历史文档实测决策请求约 528ms、主动长提示约 1.64s（[v1.3.31.md](releases/v1.3.31.md)），但这是空闲机器；有排队/冷缓存时会成倍放大。

### 3.4 根因 3 展开：单槽位不是「排队」，更像「抢占/取消」

- 应用侧没有队列：主动与聊天各自 `invoke("local_chat_stream")`，由模型服务自己调度。
- 本机只读探测（§6.3）：`GET /slots` 返回 `[]`（当前无任务），`GET /health` 返回 `loaded:false`，`GET /settings` 返回 `max_tokens 256 / reasoning_budget 0 / effort none`。
- 引擎日志出现连续两次「生成 1 个 token 后 `(cancel)`」再跟一次完整 `(stop)` 的记录，说明**后到的请求会打断在途生成**（或客户端断流），而不是老老实实排队。若用户对话恰好撞上在途的主动/另一次生成，就可能出现「一直在思考、最后没结果」。
- 真实重叠入口有两个：①固定标签页里的聊天窗口（可与岛内聊天同时发送，`busy` 各自独立）；②开聊前已经在跑的主动请求（主动 tick 只检查一次 `collapsed`，之后继续跑）。

---

## 4. 产品侧建议（按投入产出排序）

| 优先级 | 改法 | 用户可感知效果 | 投入 | 落点 |
| --- | --- | --- | --- | --- |
| **P0** | **对话优先/让路**：用户发消息前后设一个全局「对话进行中」标志（Tauri event 或 localStorage+storage 事件），主动 tick 看到标志就跳过，对话结束 60s 内也不主动开口 | 主动消息不再抢槽位、不再打断聊天；「我说话时他更专心」 | 低（前端 1 个标志 + 1 个判断） | [App.tsx:7069-7071](../src/App.tsx)、[PetChat.tsx:436](../src/PetChat.tsx) |
| **P0** | **思考预算与 token 上限联动**：请求时把 `max_tokens` 至少抬到 `reasoningBudget + 256`（或按档位给 512/1024/2048），并在设置里提示「开思考会自动增加长度上限」 | 开思考不再「只有思考没有回答」 | 低（参数映射 + 文案） | [PetChat.tsx:353-370](../src/PetChat.tsx)、[localChat.ts:20-25](../src/localChat.ts) |
| **P0** | **流式空正文兜底**：流结束时若正文为空但收到过 reasoning，自动用「关思考 + 预算 ≥512」重发一次（与非流式对齐） | 即使服务端不听话也一定给出正文，不再白等 | 低-中（后端一次重试） | [local_chat.rs:296-331](../src-tauri/src/local_chat.rs) |
| **P1** | **先回复、后动手**：把技能决策从「发送前置」改成「并行/后置」——先出聊天正文，需要动手的再补一条提示；或决策限 96 token 且不阻塞回复 | 首字从「决策完才出现」改回接近 1s | 中 | [PetChat.tsx:445-499](../src/PetChat.tsx) |
| **P1** | **忙碌/排队可见**：发送时若模型忙（本地维护「正在生成」标志，或读服务端状态），2s 内显示「小狗在忙着看视频/思考，稍等一下」，而不是干等秒数 | 用户知道不是卡死，可选择稍后再发 | 低 | [PetChat.tsx:737-758](../src/PetChat.tsx) |
| **P2** | **停止生成/取消**：给「思考中」加停止按钮，Rust 侧 abort 并释放槽位；取消后不写消息 | 用户能自救，不用等 180s | 中高（需要请求句柄管理） | [PetChat.tsx:399](../src/PetChat.tsx)、[local_chat.rs:243](../src-tauri/src/local_chat.rs) |
| **P2** | **冷启动提示**：引擎重启/预热期间显示「模型正在加载（约 N 秒）」，与「思考中」区分开 | 不会把加载误当思考 | 低-中 | [local_chat.rs:406-493](../src-tauri/src/local_chat.rs)、[PetChat.tsx:737](../src/PetChat.tsx) |
| **P2** | **可观测性**：请求日志带 `requestId`、来源（proactive / decision / reply）、thinking、maxTokens、finish_reason；排查不再靠猜 | 下次同类问题 5 分钟定位 | 低 | [local_chat.rs:243](../src-tauri/src/local_chat.rs)、[App.tsx:7175](../src/App.tsx) |

> 不建议的改法：单纯「把超时调长」或「多加重试」——会把「思考不出来」变成「等更久才报错」，不解决预算吃光和抢占。

---

## 5. 验收口径（怎样算修好）

### 5.1 硬指标（实机、单显示器 100%、本机 Strata）

| 场景 | 指标 | 判定 |
| --- | --- | --- |
| 思考=关、普通闲聊（≤40 字） | 发送 → 首个正文字 ≤2s（p95 ≤3s）；含技能决策在内 ≤3s | 必过 |
| 思考=浅 / 标准 | 首字 ≤4s / ≤8s；或先出现「模型在推理，可切到关/浅」的明确进度 | 必过 |
| 思考=深 | 首字 ≤15s 或明确显示思考进度；**不允许思考结束后没有正文** | 必过 |
| 任意思考档位 | 最终要么有正文，要么有可读错误 + 一键重试；不得出现「只有思考、正文空白」 | 必过 |
| 主动消息与对话并发 | 对话进行中（含发送后 60s）不得有主动请求发出；对话期间日志里无 proactive 请求 | 必过（证明「对话优先」） |
| 两条消息并发（岛内 + 固定标签页） | 后一条要么正常排队并在 2s 内显示「排队中」，要么明确失败；**不得静默取消前一条** | 必过 |
| 冷启动/引擎重启后首条消息 | 显示「模型加载中」而非只显示思考秒数；加载完成后正常出字 | 必过 |
| 每条消息的生成次数 | 无技能调用时 ≤2 次（决策+回复）；命中技能 ≤3 次且要有「正在执行」提示 | 建议达标 |
| 取消（若实现） | 点停止后 1s 内释放，槽位可被下一条使用，不写半截消息 | 加分项 |

### 5.2 验收证据清单

1. 前端 console：每次发送记录 `sendAt / decisionDoneAt / firstDeltaAt / doneAt / error`。
2. Rust：`local_chat_stream` 打印 `requestId / 来源 / maxTokens / thinking / 结束原因 / 正文字数`。
3. Strata：`F:\Strata\Strata\launch\ud-q4_k_xl-8k.engine.log` 中的 `session 0: prompt … generated … (stop|length|cancel)`。
4. `strata monitor --url http://127.0.0.1:8080` 或 `GET /slots` 的占用情况。
5. 判定示例：若日志出现 `(length)` 且 generated ≈ max_tokens 且无正文 → 根因 1；若 chat 请求开始前有 proactive 请求 → 根因 3；若请求被 `(cancel)` → 抢占确认。

---

## 6. 读代码确认 vs 需实机复现

### 6.1 已由代码确认（不改代码即可断言）

- 主动链路：128 token、强制关思考、空/失败走模板兜底；tick 只在开始检查 `collapsed`，模型返回后才复查。（[App.tsx:7069-7071](../src/App.tsx)、[App.tsx:7184-7193](../src/App.tsx)、[App.tsx:7256-7258](../src/App.tsx)、[App.tsx:7264-7265](../src/App.tsx)）
- 对话链路：先技能决策（默认开、128 token、结果丢弃），再正式回复；回复参数里思考预算可大于 `max_tokens`；流式空正文不重试，非流式重试。（[PetChat.tsx:137-143](../src/PetChat.tsx)、[PetChat.tsx:445-499](../src/PetChat.tsx)、[PetChat.tsx:353-370](../src/PetChat.tsx)、[local_chat.rs:326-328](../src-tauri/src/local_chat.rs)、[local_chat.rs:209-239](../src-tauri/src/local_chat.rs)）
- 应用侧无队列、无全局对话标志、无取消；两条 `PetChat` 实例（岛内 / 固定标签页）互不共享 `busy`。（[PetChat.tsx:399-403](../src/PetChat.tsx)、[PinnedPanel.tsx:104](../src/PinnedPanel.tsx)）
- 事件不会串台：`local-chat-stream` 按 `requestId` 过滤。（[PetChat.tsx:341](../src/PetChat.tsx)、[App.tsx:7156](../src/App.tsx)）
- 超时：连接 25s、请求 180s；ensure 最多 40×3s，launch 最多 60×2s 且带 `--restart`。（[local_chat.rs:29-30](../src-tauri/src/local_chat.rs)、[local_chat.rs:397-403](../src-tauri/src/local_chat.rs)、[local_chat.rs:458-469](../src-tauri/src/local_chat.rs)）

### 6.2 需实机复现（代码无法单独证明）

| # | 待验证 | 方法 | 需要的日志 |
| --- | --- | --- | --- |
| V1 | 用户实际配置：后端是否 local、思考档位、流式开关、`maxTokens` | 聊天右上角「模型设置」逐项截图；或 DevTools `localStorage.getItem('maltese-local-chat-settings')`。**本机只读扫过 profile，未找到该 key 的明文，不能据此断言是默认值（值在 LevelDB 里可能被压缩）** | 配置截图 / key 值 |
| V2 | 「思考开 + maxTokens 256」是否必现无正文 | 同一句话跑 3 组：思考关 / 标准 / 深（maxTokens 256、流式开）；再跑「标准 + 流式关」对照。预期：流式开且思考开 → 无正文/报错；流式关 → 正常（非流式有重试） | 前端错误文案 + engine log `(length)` |
| V3 | 主动与对话是否真的在单槽位上互相打断 | 等主动气泡刚出现时立刻发聊天消息；重复 5 次，记录两次请求时间差 | engine log 是否出现 `(cancel)`；`/slots` 采样 |
| V4 | 两条聊天入口并发 | 把「聊天」固定到桌面（固定标签页），主岛收起，两边同时发送 | engine log 是否 cancel / 排队 |
| V5 | 冷启动/重启后的首条消息 | 重启 Strata 引擎后立刻发消息；记录首字时间与 `warmup` 秒数 | engine log `warmed up in …`；前端首字时间 |
| V6 | ensure/restart 是否被桌宠反复触发 | 观察 `engine started` 的时间点与聊天/主动行为是否对应；本机日志 11:21 / 11:36 / 11:52 各有一次 `engine started` | 需要 Rust 侧给 `ensure_local_model` 加一行日志才能定论（当前无日志） |

### 6.3 本机只读旁证（不是用户现场，仅用于缩小范围）

- `GET http://127.0.0.1:8080/health` → `{"status":"ok","max_context":8192,"model":"qwen3.6-35b-a3b-ud-q4_k_xl","loaded":false,...}`：服务在跑，当前未加载/空闲。
- `GET /settings` → `defaults: max_tokens 256, reasoning_budget_tokens 0, reasoning_effort none`：与 `strata_launch` 写入的低延迟默认一致（[local_chat.rs:473-491](../src-tauri/src/local_chat.rs)）；注意**每次请求会覆盖这些默认值**。
- `GET /slots` → `[]`：当前无任务；单槽位容量来自 `strata monitor` 的 `Slots occupied --/1`。
- `F:\Strata\Strata\launch\ud-q4_k_xl-8k.engine.log` 关键片段（只读）：
  - `2026-11-17 09:57:41 engine started …` → `warmed up in 173.4 s`；随后一次请求 `prompt 721 tokens … 16271 ms` 才出首字（prefill 16.3s），另一次 `7487 ms`。
  - `2026-11-17 11:52:05 engine started …` → `warmed up in 3.5 s`；随后 `prompt 734 tokens … 1 generated in 10 ms (cancel)`、`prompt 729 tokens … 1 generated in 0 ms (cancel)`、`prompt 721 tokens … 24 generated in 525 ms (stop)`。
  - 解释：同一台机器上首字时间可以从 1.5s 波动到 16s+（缓存/预热/重启），且单槽位下新请求会打断在途生成（`cancel`）。**这两点与「聊天侧不如主动侧稳」的体感一致，但具体是哪条请求被取消，需要 V3/V4 配合前端日志确认。**

---

## 7. 复现与取证步骤（可直接执行）

1. **确认配置**（V1）：聊天 → 右上角模型设置 → 截图「后端 / 接口地址 / 模型名 / max_tokens / 思考档位 / 流式」。
2. **对照实验**（V2）：
   - 思考=关，发「今天好累啊」→ 记首字时间、是否出正文；
   - 思考=标准，发同一句 → 观察是否只有「思考过程」没有正文；
   - 标准档 + 关闭「流式输出」→ 观察是否恢复正文（预期恢复，因为非流式有兜底重试）。
3. **并发实验**（V3/V4）：
   - 等主动气泡出现后立刻在聊天里发消息；
   - 或把聊天固定到桌面，岛内与固定窗口同时发送；
   - 观察 `Slots occupied --/1` 与 engine log 是否出现 `cancel`。
4. **冷启动实验**（V5）：重启 Strata（或断网重启桌宠让 `ensure` 拉起），立刻发消息，记录等待秒数与日志里的 `warmed up`。
5. **采集**：前端 console 时间戳、Rust 控制台输出、engine log 尾部 100 行、`/slots` 与 `/health` 快照各 3 次。

---

## 8. 结论摘要

1. **不是「队列顺序卡住」**：应用没有排队，主动/对话只是共用一台单槽位模型。
2. 真正的差异在**成功条件**：主动 = 关思考 + 128 token + 失败兜底；对话 = 可能开思考 + 默认 256 token + 流式空正文不重试。
3. 因此「主动能说」不等于模型正常，「对话思考不出来」最可能是**思考把预算吃光（流式路径无兜底）**，其次是**技能决策抢走一个生成周期**，再次是**单槽位并发/引擎重启/冷启动**。
4. 修复顺序建议：**对话优先 + 预算联动 + 流式空正文兜底** 三件小事即可覆盖绝大多数体感；取消/排队提示/可观测性作为第二批。
---

## 9. 实施记录（2026-11-17 研发修复）

按本文 P0 建议全部落地（只前端 + `local_chat.rs`，未改模型服务）：

1. **永不卡死**：前端 `src/chatGuard.ts` 提供分级超时（关/浅 8s 首字、60s 总时长；标准 20s/60s；
   深 20s/90s），`PetChat.tsx` 用 `Promise.race` 加硬超时，超时即 `local_chat_cancel` 中止、
   复位 `busy`、清空流式思考、显示中文原因 + 「重试」按钮；`listen`/计时器/requestId 在
   `finally` 全部清理；响应结束后若已被取消则抛「已停止生成」且不写回消息。
   Rust `local_chat_stream` 另加服务端兜底（首字 12s / 总 75s）与取消登记表。
2. **思考档位出正文**：请求前 `max_tokens = max(用户值, 思考预算+256, 512)`；
   流式路径在空正文但收到过 reasoning 时，自动「关思考 + 预算 ≥512」重发一次，
   仍空则返回兜底话术（绝不空白）。
3. **串行成本**：技能决策只在含操作类关键词（开始/播放/待办/搜索…）时才跑（此前已修），
   无技能时每条消息 ≤2 次生成；决策 128 token、关思考、20s 超时。
4. **对话优先**：发送时写 `localStorage["maltese-chat-in-progress"]`（时间戳），
   主动聊天 tick 看到 60s 内有人聊天直接跳过（`shouldSkipProactiveForChat`），
   失败/结束清理标记。
5. **可见反馈**：忙碌 3s 后显示「小狗在加载模型或思考，稍等（Ns）」+「停止生成」按钮；
   失败时清空思考内容、保留「重试」。
6. 单测：`tests/chat-guard.test.mjs` 5 条（预算联动、分级超时、主动让路窗口、
   取消/空正文不写回、标记容错）。
