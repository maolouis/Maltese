# 外部平台 Token 用量监测（研究）

> **状态：已评估，暂不实现（2026-11-20）**
>
> **已核实可得性**：
> - **Codex / Claude Code**：本地日志/会话文件可精确读到 input/output token（可精确记录）。
> - **豆包**：只能拿到「额度百分比」，无逐次 token 数，无法精确统计。
> - **ChatGPT / Claude 网页**：需要登录态，且需 CDP 注入才能读取（不稳定、易被风控）。
>
> **决定**：当前 Token 统计**只覆盖本地模型调用**（local 后端；dsh 走同一套记录但不含外部平台），
> 外部平台（Codex/Claude Code/豆包等）的记录**留待未来**，不混入本地 token 总数。
>
> **未来落地建议**：
> - 新增 usage_external.rs + external-YYYY-MM-DD.jsonl（与 usage-*.jsonl 分开存）；
> - UI 用**独立卡片**展示外部平台消耗，**不与本地 token 混算**；
> - 豆包只能记录额度百分比并标注 precision=quota，不能当 token 数。

# 外部平台 Token/额度监测预研（豆包 / ChatGPT / Claude）

> 日期：2026-11-20 · 标注：**已核实**（本机文件/进程/页面实测）、**推测**、**需实测**。
> 结论：**“外部平台 token 数”基本拿不到；“额度/用量百分比”可以拿**。推荐分两类：① 我们自己发起的调用 → 精确 usage；② 豆包/ChatGPT/Claude 消费端 → 只抓额度百分比/剩余次数，标注 `quota`，不冒充 token。**不读对话内容、不做 MitM 代理。**

## 1. 各平台可得性

### 1.1 豆包（Doubao）

| 来源 | 结论 | 依据 |
| --- | --- | --- |
| 桌面版本地日志/DB | **拿不到 token/usage** | 本机 `E:\Doubao\app\Doubao.exe` 在跑（18 进程，窗口“部署 - 豆包”）；数据在 `%LOCALAPPDATA%\Doubao\User Data`（Chromium 结构：Local Storage/IndexedDB/Session Storage 等），`%APPDATA%\Doubao` 只有 `public_config.json`；按文件名检索 **未发现 usage/quota/token 日志或 SQLite**。`Default/BudgetDatabase` 是 Chromium 站点预算库，不是 AI 配额。**不读 Local Storage/IndexedDB 内容**（隐私） |
| 网页版额度页 | **可拿额度，不是 token** | `GET https://www.doubao.com/account/limit` 未登录 200 但需登录；页面展示“我的额度”（图片生成次数等）。官方/经验资料称高级功能（图片/视频/工作/深入研究）共享额度池，面板主要显示**已用百分比**而非固定次数；入口：网页/桌面左下角设置 →“订阅与额度管理”，App →“设置 → 豆包订阅” |
| 桌面窗口 OCR | **可拿额度百分比/次数（需实测）** | 豆包桌面是 Chromium 应用；用现有 `PrintWindow` + Windows OCR 截取额度面板文字即可，成本 S；脆弱但无需登录我们的浏览器；只截额度区域，不读对话 |
| 火山方舟 API | **仅我们自己调用 Ark 时精确** | `POST https://ark.cn-beijing.volcengineapi.com/?Action=GetInferenceUsage&Version=2024-01-01`，AccessKey 鉴权，返回 token/请求数；**不能查豆包消费端账号** |

### 1.2 ChatGPT（OpenAI）

| 来源 | 结论 | 依据 |
| --- | --- | --- |
| ChatGPT 桌面版本地 | 消费版**无本地 token 记录**；本机实际是 **OpenAI Codex** 桌面应用（进程 `ChatGPT`，路径 `OpenAI.Codex`） | `%LOCALAPPDATA%\OpenAI` 只有 Codex runtime；`%APPDATA%\OpenAI` 不存在 |
| OpenAI Codex 本地日志 | **能拿精确 token** | `~/.codex/sessions/**/rollout-*.jsonl` 中有 `type:"token_usage_record"`，实测字段：`usage.input_tokens=92060`、`cached_input_tokens=6656`、`output_tokens=437`、`reasoning_output_tokens=146`、`total_tokens=92497`；另有 `thread_token_usage` 累计。**只覆盖 Codex，不代表 ChatGPT 网页对话** |
| ChatGPT 网页用量页 | **可拿额度窗口（需实测选择器）** | `GET https://chatgpt.com/settings/usage` 未登录 200（需登录）；页面按 5 小时/周等窗口显示额度。`backend-api/wham/usage` 需 **Codex OAuth access token + account id**，不是普通网页 Cookie，属非官方接口（ai-quota 2026-10 实测），不建议依赖 |
| 官方 API | 仅组织 Admin Key | `GET https://api.openai.com/v1/organization/usage/completions`，需 `sk-admin-...` 组织管理员 Key；不能查 ChatGPT 订阅用量 |

### 1.3 Claude

| 来源 | 结论 | 依据 |
| --- | --- | --- |
| Claude Desktop 本地 | **拿不到 usage** | `%LOCALAPPDATA%\Claude` 仅有 `claude_desktop_config.json`（实测内容 `{"deploymentMode":"3p"}`）和空 `logs`；无 token/usage 记录 |
| Claude Code 本地（若使用 CLI） | **能拿精确 token** | `~/.claude/**/*.jsonl` 的 assistant 消息含 `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`；只覆盖 Claude Code，不是 Claude Desktop |
| Claude 网页用量页 | **可拿额度（需实测 Cloudflare/选择器）** | `https://claude.ai/settings/usage`（官方文档：Pro/Max/Ultra 在 Settings > Usage 看 allowance/credits）；本机未登录请求返回 403（Cloudflare），需真实浏览器/CDP，**需实测** |
| 官方 API | 仅组织 Admin Key | `GET https://api.anthropic.com/v1/organizations/usage_report/messages`（legacy）或新 Usage/Cost Analytics；需 admin key，不能查个人订阅 |

## 2. 通用手段对比

| 手段 | 原理 | 成本 | 可靠性 | 隐私/风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A. UI 截图/OCR** | 截额度面板，OCR 读“已用 42% / 剩余 3 次” | **S** | 低（布局/DPI/换版即坏） | 只截额度区域可接受；勿截对话 | 豆包桌面首选兜底 |
| **B. CDP 读网页用量页** | 专用浏览器登录后 `Runtime.evaluate` 读 DOM；不调私有 API | **M** | 高（页面变则改选择器） | 需账号登录；只读额度文本；不存页面 HTML | 豆包/ChatGPT/Claude Web 首选 |
| **C. 读本地日志/DB** | 解析 JSONL/SQLite | **M** | 中（版本变化）；Codex/Claude Code 很准 | 只读 token 字段、不读正文；DB 可能加密 | **Codex/Claude Code 精确**；豆包/Claude Desktop 没有 |
| **D. 反向代理/系统代理抓包** | MitM 解密 HTTPS 读 API 响应 | **L** | 技术上可全量 | **高**：证书、隐私、TOS；对话内容外泄 | **不建议** |
| **E. 只统计自己发起的调用** | 本地模型/DSH/agent-hub 的 usage | **S** | 高 | 无外部读取 | 现有 `usage.rs` 已覆盖，覆盖不全 |

## 3. 推荐方案（分两类统计）

### 3.1 自己的调用 → 精确 token

沿用现有 `src-tauri/src/usage.rs`（`UsageRecord`、按天 JSONL、`usage_summary`）；本地 OpenAI 兼容 `usage` 为 `exact`；DSH/agent-hub 有 usage 则 exact，无则 `estimated`。**Codex/Claude Code 是“本机日志里的精确值”，单独标 `source=external:codex` / `external:claude-code`、`precision=exact`，不计入“我们发起”的 token 总量，避免重复。**

### 3.2 消费端平台 → 只记录额度（不是 token）

新增 `usage_external.rs`（或扩展现有 usage 模块），记录结构：

```json
{"at":1795200000,"provider":"doubao|chatgpt|claude","kind":"quota","metric":"percent|count","value":42,"window":"5h|day|week|month","resetAt":1795203600,"observedAt":1795200000,"source":"cdp|ocr|local-log","precision":"quota","page":"https://..."}
```

- 存储：`%APPDATA%\com.maolouis.maltese\usage\external-YYYY-MM-DD.jsonl`，与 token 文件分开；UI 单独“外部平台额度”卡片，**不要加到 token 总数**。
- 命令：`usage_external_probe(provider)`（CDP/OCR）、`usage_external_snapshot()`、`usage_external_clear()`；设置页选择要监测的平台与刷新频率（手动/每小时）。
- **豆包**：优先桌面窗口 OCR（S，无需二次登录）；网页版额度页用 CDP（M，需登录）。
- **ChatGPT**：只读 `chatgpt.com/settings/usage` DOM（M）；**不要**依赖 `wham/usage` 非官方 token 接口。
- **Claude**：只读 `claude.ai/settings/usage` DOM（M）；Cloudflare 可能需真实浏览器，**需实测**。
- **Codex / Claude Code**：读本地 JSONL 的 token 字段（S，只取 usage，不读 message 文本）。
- 隐私边界：**只读取额度文字/usage 字段**，不读对话、不存页面 HTML、不存账号 cookie、不上传；`clear` 可删外部记录。

## 4. 结论与可行性排序

- **今天就能做（S）**：Codex 本地精确 token（`~/.codex`）、Claude Code 本地精确 token（`~/.claude`）、豆包桌面额度 OCR。
- **需要登录/CDP（M）**：豆包网页额度、ChatGPT 用量页、Claude 用量页；只拿额度百分比/次数。
- **需要 API 资质（M/L，仅自己调用）**：火山方舟 `GetInferenceUsage`、OpenAI 组织 usage、Anthropic Admin usage；不能查消费端订阅。
- **不建议**：MitM/代理抓包（隐私/TOS/证书）、读豆包/Claude/ChatGPT 对话库、绕过签名/风控、依赖非官方 `wham/usage` 作为产品能力。

## 5. 文件清单与复杂度

| 文件 | 改动 |
| --- | --- |
| 新增 `src-tauri/src/usage_external.rs` | provider 枚举、quota 记录、CDP/OCR probe、Codex/Claude Code JSONL 解析、命令 |
| `src-tauri/src/usage.rs` | external 记录类型/路径/聚合（或保持独立） |
| `src-tauri/src/lib.rs` | 注册 `usage_external_*` 命令 |
| `src/AgentConsole.tsx` | “外部平台额度”卡片：provider、百分比/次数、窗口、更新时间、来源（cdp/ocr/local-log） |
| `src-tauri/Cargo.toml` | 无需新依赖（CDP 复用现有浏览器/HTTP；OCR 复用 Windows OCR） |
| `docs/usage-monitoring.md`（可选） | 口径说明：token vs quota、隐私边界 |

复杂度：**S/M**（本地日志 S；OCR S；CDP 页面 M；官方 API 仅自己调用 M）。

## 6. 验收判据

| 场景 | 判据 |
| --- | --- |
| Codex 本地 | 读取 `token_usage_record`，与日志值一致；只显示 token，不显示对话 |
| 豆包桌面 | OCR 得到“已用 X%/剩余 X 次”；失败不误报，UI 标 `ocr/estimated` |
| 豆包/ChatGPT/Claude Web | CDP 读到额度页数值；登录过期提示重新登录；不保存页面 HTML |
| 口径 | 外部记录必须有 `kind=quota`、`precision=quota`，**不得混入 token 总量** |
| 隐私 | 无对话内容、无 cookie 落盘；一键清空 external 记录 |
| UI | 外部额度卡 1s/手动刷新不卡；显示来源与“非 token”说明 |

## 7. 来源（2026-11-20）

- 本机实测：Doubao 进程/数据目录（`E:\Doubao`、`%LOCALAPPDATA%\Doubao\User Data`，未发现 usage DB）；Claude Desktop `%LOCALAPPDATA%\Claude`（仅 config/空 logs）；Codex `~/.codex/**/rollout-*.jsonl`（`token_usage_record` 原值）；Claude Code `~/.claude/**/*.jsonl`（`message.usage`）；页面探针：`doubao.com/account/limit` 200 需登录、`chatgpt.com/settings/usage` 200 需登录、`claude.ai/settings/usage` 403。
- [火山方舟 GetInferenceUsage](https://docs.volcengine.com/docs/ark/get-inference-usage-api?lang=zh)
- [OpenAI Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)（admin key）
- [Anthropic Messages Usage Report](https://platform.claude.com/docs/en/api/http/beta/organization/usage_report/retrieve_messages)（admin key）
- [ChatGPT Usage/wham 非官方查询记录](https://github.com/kongdd/ai-quota/blob/fe7bb1d0b0b44c49cc5e04b2ea59e1aada69aa46/docs/openai-auth.md)（2026-10，仅作证据）
- 豆包额度入口：[额度页经验](https://www.php.cn/faq/2892095.html)、[工作任务额度百分比说明](http://mp.weixin.qq.com/s?__biz=MzAwNjA1OTU0NQ==&mid=2247486000&idx=1&sn=b1dd3e93812fa2cb6b2523cdd56498ca)
- Claude 用量页：[Claude Usage 文档](https://claude.com/docs/government/account/usage)、[Claude Code costs](https://code.claude.com/docs/zh-CN/costs.md)
- 本机代码：`src-tauri/src/usage.rs`、`src/AgentConsole.tsx`（当前 token 卡片）