# Dify 与 LangChain 接入小狗的评估

> 日期：2026-11-19 · 数据来自 GitHub API / 官方文档（star、release 均为 **2026-11-19** 查询）
> 结论：**部分适合，但不建议接进小狗主链路**。Dify 是重平台（Docker/WSL2 + 约 10 个容器），与「本地单槽位 12GB 模型 + 桌面常驻」冲突；LangChain/LangGraph 是库，接 Tauri/Rust 需要 Python 或 Node 侧车，且大部分能力我们已有。**推荐先做「不引入框架的原生 function-calling + 技能路由」；Dify 只作为可选旁挂，LiteLLM 只在需要多模型网关时再上。**

## 1. 小狗现状：我们已经有什么

| 能力 | 现状（代码/运行态） |
| --- | --- |
| 聊天后端 | 两条：`local_chat.rs`（OpenAI 兼容 `/v1/chat/completions`，baseUrl 用户配置；本机 Strata 为 `http://127.0.0.1:8080`，可调起 `F:\Strata\bin\strata.cmd`）与 `dsh_chat.rs`（DSH CLI，持久 session，120s 超时）；默认后端是 **DSH**（`localChat.ts`） |
| 模型 | Strata 跑 `qwen3.6-35b-a3b-ud-q4_k_xl`（文本+视觉输入，输出文本），进程参数 `--parallel 1`；2026-11-19 查询 `/v1/status`：`concurrency.serving=1`、RTX 4070 **11,319 / 12,282 MiB**、prompt 4.23ms/token、生成 23.3 tok/s、上下文 8192、`image_generation=false` |
| 聊天体验 | `PetChat.tsx` 双后端 + 流式；`chatGuard.ts` 做了首字 15/25s、排队 240s、空闲 45s、总 300s、单槽位「排队中」提示、`maltese-chat-in-progress` 防主动聊天插话；思考档 4 级；模板拒绝自动降级 |
| 技能/工具 | `petSkills.ts` **16 个**本机技能（待办、日记、音乐、打开应用/网址、剪贴板、时间、web_search 等）；`PetChat` 先用 128 token/20s 的「是否动手」判断，再执行技能，**不是原生 tool calling** |
| 主动聊天 | `proactiveChat.ts`：0–100 主动程度，换算冷却/每小时上限/稳定时长/免打扰；48 条历史；有人聊天 60s 内让路 |
| 其他能力 | 视频插件（B 站/抖音浏览、兴趣打分、摘要、评论）、待办/日记、剪贴板历史、媒体控制、有道翻译（+DeepSeek 兜底）、QQ/微信提醒、OCR、Bongo/多实例联动、宠物自我状态 |
| 运行时 | Tauri 2 + Rust + React；**没有 Python 运行时**；DSH CLI 是外部 Node 程序；`dsh_api.rs` 只是本机扩展 API（视频/宠物），不是 LLM 编排服务 |
| 缺口 | 没有向量库/embedding/RAG、没有多步规划、没有原生 function calling、没有多模型网关 |

结论：我们缺的是「更强的工具调用与检索」，不是「另一个聊天平台」。

## 2. Dify：LLMOps 平台，不是库

- **定位**：可视化 Agent/工作流/RAG/知识库平台，可发布为 Web App 或 API（[仓库](https://github.com/langgenius/dify)：**161,463 stars**，最新 [v1.20.0 2026-11-18](https://github.com/langgenius/dify/releases/tag/1.20.0)，pushed 2026-11-19，活跃）。
- **部署**：官方 Docker Compose，最低 **2 核 / 4 GiB**；Windows 需要 **Docker Desktop + WSL2**；默认带 PostgreSQL、Weaviate 等，compose 实际包含 api/worker/beat/web/postgres/redis/sandbox/plugin-daemon/agent-backend/ssrf-proxy/nginx 等约 10 个服务（[部署文档](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose.md)、[docker-compose.yaml](https://github.com/langgenius/dify/blob/main/docker/docker-compose.yaml)）。
- **纯本机无 Docker？不行**：官方「源码启动」仍要求先用 Docker Compose 起 PostgreSQL/Redis/Weaviate/sandbox/plugin-daemon（[local-source-code](https://github.com/langgenius/dify-docs/blob/1a808c3456cd99e594ba2c29723f08410173a3d4/en/self-host/advanced-deployments/local-source-code.mdx)；社区 issue [#13003](https://github.com/langgenius/dify/issues/13003) 同样确认）。
- **API 能力**：`POST /v1/chat-messages`（SSE 流式，Chatflow 带节点事件）、`POST /v1/workflows/run`（Workflow 独立执行）、知识库检索/数据集 API；API Key 只能放后端（[Get Started](https://docs.dify.ai/en/api-reference/guides/get-started.md)、[Chatflow API](https://docs.dify.ai/en/api-reference/guides/chatflow.md)、[Workflow API](https://docs.dify.ai/en/api-reference/guides/workflow.md)）。
- **与小狗的适配**：Dify 可以把 Strata 当 OpenAI 兼容模型供应商，但 Dify 自己还要占 CPU/RAM、跑 Postgres/Redis/Weaviate；RAG 还要 embedding 模型，12GB 显存已被 35B 模型占满，必然和聊天抢单槽位。它适合「独立机器上的工作流/RAG 服务」，不适合塞进桌面宠物进程。
- **许可**：**修改版 Apache 2.0**——多租户运营需商业授权；使用其前端时不得移除 LOGO/版权（[LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE)）。自用单机没问题，但发行/商用要评估。

## 3. LangChain / LangGraph：库，不是平台

- **定位**：LangChain 是 LLM 应用/Agent 开发库（Python + JS/TS，[仓库](https://github.com/langchain-ai/langchain)：**149,860 stars**，[langchain-core 1.8.3 2026-11-18](https://github.com/langchain-ai/langchain/releases/tag/langchain-core%3D%3D1.8.3)，MIT）；LangGraph 是可持久化状态图/多步 Agent 运行时（**45,137 stars**，[1.2.22 2026-11-14](https://github.com/langchain-ai/langgraph/releases/tag/1.2.22)，MIT）。
- **接入成本**：小狗是 Rust + WebView，无 Python；要用 LangChain 必须加 **Python 侧车**（打包解释器+依赖，PyInstaller/Tauri sidecar，几十到上百 MB）或 **Node 侧车**（把 LangChain JS 作为子进程，Node 运行时打包/复用 DSH Node）。还要处理进程生命周期、IPC、超时/取消、崩溃重启、杀软误报——成本 **M/L**。
- **能带来的增量**：原生 tool calling、多步 Agent、RAG/向量库、记忆、回调与追踪。对照现状：工具路由、session、流式、超时/排队、主动消息我们已有；真正新增的是 **RAG** 与 **复杂多步编排**，而桌宠闲聊并不需要。LangGraph 的 checkpoint/状态图对「长期陪伴」有理论价值，但会把单槽位延迟放大。
- **结论**：接 LangChain = 为了 10% 的新能力引入 100% 的新运行时，不划算；若以后做「本地资料库问答/深度研究」，优先用 LangChain JS 跑**离线任务**，不要放在聊天主链路。

## 4. 高 star 同类项目横向对比

| 项目 | Stars | 最新 Release | 许可 | 定位/用途 |
| --- | --- | --- | --- | --- |
| **n8n** | 211,188 | [2.48.5 2026-11-18](https://github.com/n8n-io/n8n/releases/tag/n8n%402.48.5) | Sustainable Use（非 OSI，限制商用分发） | 工作流自动化，400+ 集成；Node/TS 自托管 |
| **Dify** | 161,463 | 1.20.0 2026-11-18 | 修改版 Apache 2.0 | LLMOps/工作流/RAG 平台 |
| **Open WebUI** | 159,057 | [0.13.4 2026-11-17](https://github.com/open-webui/open-webui/releases/tag/v0.13.4) | 自定义 BSD + 品牌条款 | 自托管 LLM 聊天 UI，不是库 |
| **LangChain** | 149,860 | core 1.8.3 2026-11-18 | MIT | Python/JS LLM 应用库 |
| **LiteLLM** | 63,514 | [v1.110.1 2026-11-19](https://github.com/BerriAI/litellm/releases/tag/v1.110.1) | MIT（enterprise 目录单独） | OpenAI 兼容模型网关/路由/计费 |
| **AutoGen** | 61,933 | [python-v0.7.5 2025-09-30](https://github.com/microsoft/autogen/releases/tag/python-v0.7.5) | CC-BY-4.0（非典型代码许可） | 微软多 Agent 框架；发布节奏已明显放缓 |
| **CrewAI** | 61,089 | [1.15.43 2026-11-19](https://github.com/crewAIInc/crewAI/releases/tag/1.15.43) | MIT | 角色化多 Agent 编排（Python） |
| **Flowise** | 55,575 | [3.1.4 2026-07-29](https://github.com/FlowiseAI/Flowise/releases/tag/flowise%403.1.4) | Apache 2.0 + 企业目录 | 可视化 Agent 构建器；**仓库已归档**（pushed 2026-08） |
| **LangGraph** | 45,137 | [1.2.22 2026-11-14](https://github.com/langchain-ai/langgraph/releases/tag/1.2.22) | MIT | 有状态多步 Agent 图运行时 |
| **Haystack** | 27,047 | [v3.5.0 2026-11-10](https://github.com/deepset-ai/haystack/releases/tag/v3.5.0) | Apache-2.0 | Python RAG/Agent 管道框架 |

## 5. 「适合小狗接入」评分

| 项目 | 接入成本 | 需常驻服务 | 与单模型 12GB 契合 | 对现有架构侵入 | 维护成本 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| Dify | 高（Docker/WSL2 + DB/Redis/向量库） | 是（约 10 容器） | 低（抢 CPU/内存/embedding 显存） | 高（重复会话/编排） | 高（迁移/升级/备份） | 不建议进主链路；可旁挂 |
| LangChain | 中高（Python/Node 侧车） | 侧车进程 | 中（库本身不抢 GPU，但多步调用会排队） | 中（替换工具/上下文层） | 中高 | 仅离线任务评估 |
| LangGraph | 高（额外运行时+状态存储） | 是（checkpoint） | 低（多步放大单槽位） | 高 | 高 | 不适合桌宠闲聊 |
| LiteLLM | 低中（单进程代理） | 是（可选） | 中（无状态路由） | 低（OpenAI 兼容层） | 中 | 多模型/云兜底时再上 |
| n8n | 高（Node 服务+DB） | 是 | 低 | 高 | 高 | 不适合桌面端内置 |
| Flowise | 中（Node 服务） | 是 | 中 | 高 | 高 | 不选（已归档） |
| Open WebUI | 高（整套 UI/服务） | 是 | 低 | 高 | 高 | 不选（是产品不是库） |

## 6. 推荐路径（按必要性）

1. **不引入 Dify/LangChain，先把原生能力补齐（首选，S/M，必要性高）**：在 `local_chat.rs` 的 `/v1/chat/completions` 上做 function-calling（或继续强化 `petSkills` 的 JSON 路由），把 16 个技能暴露成工具；复用现有 `chatGuard` 超时/排队、`PetChat` 流式、`proactiveChat`。这是对「小狗更聪明」收益最大、风险最小的路径。
2. **LiteLLM 网关（可选，S/M，必要性低）**：只有当你需要同时接 Strata、DeepSeek 云、其他本地模型，并统一 OpenAI 格式/降级/成本统计时才加；Strata 本身已 OpenAI 兼容，单模型场景是多余一跳。
3. **Dify 旁挂（可选，L，必要性低）**：给高级用户单独部署在**另一台机器/独立 Docker 环境**，小狗通过 HTTP 调它的 Chatflow/Workflow 做 RAG 或可视化工作流；不要打包进安装包，不要让 Dify 与 Strata 抢同一张 12GB 卡。要求：显式开关、独立进程、失败自动回退到本地聊天。

## 7. 风险

- **资源**：Dify 官方最低 4GiB，实际 10 容器 + Postgres/Redis/Weaviate 会吃数 GB 内存；本机 GPU 已 12GB 满载，embedding/多模型会直接触发卸载/排队。
- **延迟**：任何框架的 planning/tool/RAG 都是额外 LLM 轮次，单槽位下会把「首字」从秒级推到几十秒；现有 `chatGuard` 的 15/25s 首字、240s 排队会被打爆。
- **隐私**：本地 Dify 数据在 Postgres/Weaviate；Dify Cloud/LangChain 集成默认可能外发 prompt；API Key 不能进前端（Dify 官方明确要求后端调用）。
- **许可**：Dify 修改版 Apache（多租户/LOGO）；n8n Sustainable Use 限制分发；Open WebUI 品牌条款；AutoGen 是 CC-BY-4.0；Flowise 已归档；LiteLLM/Haystack 较宽松。
- **维护**：Docker/WSL2 更新、数据库迁移、容器备份；Python 侧车打包/签名/杀软误报；都会让「桌面小工具」变成运维项目。
- **架构**：小狗的核心价值是本地、轻量、随时可用；引入常驻平台会破坏离线可用性与安装包体积。

## 8. 来源

- GitHub API（2026-11-19）：[dify](https://api.github.com/repos/langgenius/dify)、[langchain](https://api.github.com/repos/langchain-ai/langchain)、[langgraph](https://api.github.com/repos/langchain-ai/langgraph)、[litellm](https://api.github.com/repos/BerriAI/litellm)、[n8n](https://api.github.com/repos/n8n-io/n8n)、[open-webui](https://api.github.com/repos/open-webui/open-webui)、[autogen](https://api.github.com/repos/microsoft/autogen)、[crewAI](https://api.github.com/repos/crewAIInc/crewAI)、[flowise](https://api.github.com/repos/FlowiseAI/Flowise)、[haystack](https://api.github.com/repos/deepset-ai/haystack)
- Dify：[Docker Compose 部署](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose.md)、[部署总览](https://docs.dify.ai/en/self-host/deploy/overview.md)、[API 入门](https://docs.dify.ai/en/api-reference/guides/get-started.md)、[LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE)
- 许可：[n8n](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)、[Open WebUI](https://github.com/open-webui/open-webui/blob/main/LICENSE)、[LiteLLM](https://github.com/BerriAI/litellm/blob/main/LICENSE)、[Flowise](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md)、[AutoGen](https://github.com/microsoft/autogen/blob/main/LICENSE)
- 本地代码：`src-tauri/src/local_chat.rs`、`dsh_chat.rs`、`src/chatGuard.ts`、`src/PetChat.tsx`、`src/petSkills.ts`、`src/proactiveChat.ts`、`src/plugins/video/*`；运行态 `GET http://127.0.0.1:8080/v1/status`