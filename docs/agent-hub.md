# Agent Hub：多 Agent 适配器与控制台

> 2026-11-19 · 版本 2.0.3（不改版本号）
> 目标：把电脑上的 codex、claude、豆包等 agent **串起来**——统一探测、统一运行、串行流水线、在桌宠里看状态。
> 背景结论见 [research-dify-langchain.md](research-dify-langchain.md)：不接 Dify/LangChain，走原生 CLI + 轻量编排；控制台设计见 [agent-console-design.md](agent-console-design.md)。

---

## 1. 为什么是「CLI 适配器」而不是框架

| 方案 | 代价 | 结论 |
| --- | --- | --- |
| Dify（Docker/WSL2 + 约 10 容器） | 与本机 12GB 单槽位模型抢资源、运维成本高 | 不内置，最多旁挂 |
| LangChain / LangGraph | 需要 Python/Node 侧车、打包与杀软问题 | 不做 |
| **本机 CLI 适配器（本方案）** | 只要用户已装 codex/claude/豆包 CLI；Rust 只做 spawn + 流式读 | ✅ MVP |

本模块 = 一层薄适配器：**统一 `AgentSpec` + 探测 + 流式输出 + 并发/超时/取消 + 日志 + 串行流水线**。
不实现 DAG、记忆、RAG，也不替代现有聊天链路。

## 2. 代码结构

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/agent_hub.rs`（新） | Agent 配置加载/探测、子进程运行、流式事件、并发槽位、取消、日志、流水线、单测 |
| `src-tauri/src/lib.rs` | 只加 `mod agent_hub;` 与 7 个命令注册 |
| `src/AgentConsole.tsx` / `.css`（新） | 控制台三段（用量/任务进度/工作分配）+ 多 Agent 运行区 |
| `src/App.tsx` | 只做最小挂载：`IslandPage` 加 `"agent"`、顶部页签、渲染 `<AgentConsole />` |
| `src/assistantSupport.ts` | `PAGE_LABELS` 增加「Agent 控制台」（固定到桌面用） |
| `src/i18n/{types,locales/zh-CN,locales/en}.ts` | `island.agentConsole` + 完整 `agentHub` 文案 |
| `src/petSkills.ts` | 2 个只读技能 `agent_registry` / `agent_status` |

### 数据流

```
AgentConsole.tsx  --invoke--> agent_hub.rs --spawn--> codex / claude / doubao ...
      ^                          |
      |   agent-stream (每行)     |--stdout lines--> 事件
      |   agent-stderr            |--stderr lines--> 事件
      +--------------------------+
```

## 3. 配置（不硬编码）

首次调用 `get_agent_registry` 时自动生成：

```
%APPDATA%\com.maolouis.maltese\agent-hub\config.json
```

结构（节选，实际以生成文件为准）：

```json
{
  "agents": [
    {
      "id": "codex",
      "displayName": "Codex",
      "kind": "codex",
      "command": "codex.cmd",
      "args": ["exec", "--skip-git-repo-check", "{{prompt}}"],
      "cwd": null,
      "env": {},
      "enabled": true
    },
    {
      "id": "claude",
      "displayName": "Claude Code",
      "kind": "claude",
      "command": "claude.cmd",
      "args": ["-p", "--output-format", "text", "{{prompt}}"],
      "cwd": null,
      "env": {},
      "enabled": true
    },
    {
      "id": "doubao",
      "displayName": "豆包",
      "kind": "doubao",
      "command": "doubao",
      "args": ["{{prompt}}"],
      "cwd": null,
      "env": {},
      "enabled": true
    }
  ],
  "pipelines": [
    {
      "id": "review",
      "title": "需求 → 方案 → 审阅",
      "description": "codex 先给实现方案，claude 再挑毛病；两步都只输出文字，不改文件。",
      "steps": [
        {
          "agentId": "codex",
          "promptTemplate": "请阅读下面的需求，给出可落地的代码修改方案（文件、函数、关键片段）。只输出方案，不要直接修改文件。\n\n需求：{{input}}"
        },
        {
          "agentId": "claude",
          "promptTemplate": "请审阅下面的实现方案，指出风险、遗漏和更好的做法，给出结论。\n\n方案：\n{{prev}}"
        }
      ]
    },
    {
      "id": "idea",
      "title": "点子 → 落地建议",
      "description": "豆包先发散点子，codex 再把点子拆成实施步骤。",
      "steps": [
        { "agentId": "doubao", "promptTemplate": "围绕下面的主题给 3 个具体、可执行的点子…\n\n{{input}}" },
        { "agentId": "codex", "promptTemplate": "把下面的点子整理成可落地的实施建议…\n\n{{prev}}" }
      ]
    }
  ]
}
```

### 如何新增一个 agent

1. 先确认它支持**非交互**（一次性 prompt、stdout 输出）。一般规律：
   - codex → `codex exec "<prompt>"`（或 stdin）
   - claude → `claude -p "<prompt>"`
2. 编辑 `config.json`，加一条：

```json
{
  "id": "my-agent",
  "displayName": "我的 Agent",
  "kind": "custom",
  "command": "my-agent.cmd",
  "args": ["--once", "{{prompt}}"],
  "cwd": "E:\\work\\project",
  "env": { "MY_AGENT_MODE": "batch" },
  "enabled": true,
  "note": "自用包装脚本"
}
```

3. `{{prompt}}` 可放在任意参数位置；**完全没有**这个占位符时，prompt 会追加到最后一个参数。
4. 回到控制台点「刷新」（会清探测缓存）。新增的 agent 会出现在「工作分配」里。
5. 如果只是想让它在流水线里出现，把 `id` 写进某个 `pipelines[].steps[].agentId` 即可。

### 豆包

豆包**没有官方桌面命令行**。默认配置会显示「未安装」，原因写在卡片上。两个可选做法：

- 自备包装脚本（`.cmd` / `.ps1`），内部调用豆包的开放 API 或你已有的自动化工具，然后把它配成 `command`；
- 直接把 `enabled` 改成 `false`，避免控制台出现未安装提示。

`idea` 流水线第一步依赖豆包，豆包不可用时点运行会得到中文原因（第 1 步失败：…未安装或不可用），不会崩。

## 4. 运行模型

| 约束 | 实现 |
| --- | --- |
| 并发 | 全局 2 个、单 agent 1 个（`tokio::sync::Semaphore`）；等待中的数量在 `agent_hub_status().queue` 与控制台「队列 N」可见 |
| 超时 | 单次 300s；超时 `taskkill /PID <pid> /T /F` 杀进程树，日志写 `AGENT_TIMEOUT`，返回中文原因 |
| 取消 | `agent_cancel(streamId)` 置取消标记 + 杀进程树；返回是否真的杀到进程 |
| 流式 | stdout 每行一个 `agent-stream {streamId, agentId, line}`；stderr 每行 `agent-stderr`；控制台按 streamId 累积（最多 400 行） |
| 输入上限 | prompt ≤ 8000 字；流水线 ≤ 6 步 |
| 工作目录 | `cwd` 为 null 时沿用应用当前目录；配置了不存在目录会直接拒绝并给原因 |

### 命令与事件

| 命令 | 说明 |
| --- | --- |
| `get_agent_registry(refresh?)` | agent 可用性/状态、流水线配置、配置与日志路径 |
| `agent_hub_status()` | 正在跑、排队、最近 10 条错误 |
| `agent_hub_usage()` | 当天 jsonl 聚合：运行数/失败数/平均首行/平均耗时 |
| `agent_run(agentId, prompt, streamId?)` | 跑单个 agent，返回完整输出 + 错误 |
| `agent_cancel(streamId)` | 取消 |
| `agent_pipeline(steps, input, runId?, pipelineId?)` | 按传入 steps 串行执行 |
| `agent_pipeline_run(pipelineId, input, runId?)` | 按配置里的流水线执行 |

事件：`agent-stream`、`agent-stderr`、`agent-pipeline-step`。

流水线串行规则：第 1 步用 `{{input}}`；之后每步同时可用 `{{prev}}`（上一步 stdout）与 `{{input}}`（原始输入）。
任一步失败立即停止，返回 `PipelineResult { ok:false, error:"第 N 步（名字）失败：原因", steps:[已完成步骤…] }`——**已完成步骤的输出不会丢**。

## 5. 日志

```
%APPDATA%\com.maolouis.maltese\agent-hub\logs\agent-YYYY-MM-DD.jsonl
```

每行一个 JSON：`start` / `end` / `pipeline-step`。`end` 包含 `ok`、`exitCode`、`durationMs`、`firstLineMs`、
`timedOut`、`cancelled`、`error`、`stderrPreview`。

**不记录 prompt 全文**：只记 `promptPreview`（前 80 字，换行替换成空格）与 `promptLength`（字符数）。
日志按天滚动，不做自动清理（可手动删旧文件）；`agent_hub_usage` 只读当天文件。

## 6. 安全边界（硬约束）

1. **子进程以当前用户权限运行**。Agent 能做什么，取决于该 CLI 自己的权限模型（例如 codex 的 sandbox、claude 的权限提示）。
2. **可执行文件白名单来自配置**：只运行 `config.json` 里 `agents[].command` 指定的程序；裸名字只在 PATH 与 `%APPDATA%\npm` 里查找。
3. **禁止 shell 解释器**：`cmd.exe`、`powershell.exe`、`wscript`、`mshta`、`rundll32`、`reg`、`schtasks` 等不能作为 agent 的 `command`。
4. **禁止 shell 元字符注入**：
   - `command` 里出现 `& | < > ^ % ! " ' ; \` $` 或换行，直接拒绝；
   - `.cmd/.bat` 优先解析成 `node <script.js>` 直接 spawn（npm 全局安装的 codex/claude 都是这种 shim），**不经过 cmd.exe**；
   - 解析不出来才退回 `cmd.exe /C`，此时 prompt/参数里出现任何元字符都会被拒绝执行并给出中文原因（是拒绝，不做转义）。
   - `.exe` / `.ps1` 走 `Command::new` / `powershell -File` 的参数数组，prompt 不经过命令字符串拼接。
5. **不接受前端传来的可执行路径**：前端只能传 `agentId`，路径由 Rust 从配置文件解析。
6. **不改状态的动作才进聊天技能**：本轮只开放两个只读技能；「跑流水线」目前只在控制台点按钮（带输入校验），
   不开放给聊天模型自动触发——`PetChat.tsx` 的「二次确认卡片」尚未实现（该文件正在另一轮重构中），
   等确认卡片落地后再加 `agent_pipeline_run`，避免模型绕过用户直接跑 agent。

## 7. 控制台 UI

- 页签：主面板顶部「Agent」（`IslandPage = "agent"`），导航顺序在「聊天 / 看视频」之后。
- ① **模型用量**：今日 agent 运行数、失败数、平均首行、平均耗时来自 `agent_hub_usage`；Token/模型请求数
  显示「—」并标「待接入」（本机模型不计费，模型侧埋点不在本轮范围）。
- ② **任务进度**：`video_get_snapshot` 的 `running/startedAt/maxMinutes/itemCount/pendingCount` 折算进度条；
  待办读 localStorage（`focusd-island-todos` + `focusd-island-active-todo`）。
- ③ **工作分配**：每个 agent 一张卡片：状态（运行/排队/空闲/未安装/已禁用）、在跑什么、队列长度、最近错误；
  卡片内「运行」展开输入框、「取消」只在运行中可点。未安装的 agent 点运行会显示不可用原因（不崩）。
- **多 Agent 运行**：选流水线 → 填输入 → 运行；每步一个折叠面板，实时流式输出；失败显示中文原因，已完成的步骤仍可查看。
- 轮询：组件只在页签可见时挂载，3s 一次；切走即停，无后台常驻开销。

## 8. 故障排查

| 现象 | 排查 |
| --- | --- |
| 控制台显示「未安装」 | 在终端确认 `codex --version` / `claude --version` 能跑；检查 PATH 是否包含 npm 目录（`%APPDATA%\npm`）；改好配置后点「刷新」 |
| 运行后没有输出 | 该 CLI 是否支持非交互模式？试 `codex exec "hi"` / `claude -p "hi"`；看日志 `agent-<date>.jsonl` 的 `launch`/`error` |
| 一直排队 | 全局已有 2 个在跑；等前一个结束，或取消 |
| 300 秒超时 | 日志里 `AGENT_TIMEOUT`；网络/登录问题最常见。可在 CLI 里先手动跑一次确认 |
| 提示「包含 shell 元字符」 | 该 agent 解析成了 `.cmd` 兜底路径；把 command 换成真正的 `.exe`/`.ps1`，或去掉 prompt 里的 `& | % !` 等字符 |
| 配置解析失败 | 修好 `config.json` 的 JSON 语法，或删掉它重启（会重新生成默认配置） |
| 豆包不可用 | 见 §3「豆包」：没有官方 CLI，需要自备包装脚本 |

## 9. 本轮边界 / 未做

- 不做 DAG、条件分支、并行步骤、重试策略；流水线就是顺序执行。
- 不做模型用量埋点（`local_chat` / `dsh_chat` 的统计仍是后续 P1），控制台里标「待接入」。
- 不做聊天触发流水线（缺确认卡片，见 §6 第 6 条）。
- 不做 agent 配置的 UI 编辑器：直接改 `config.json` + 刷新。
- 不做流式增量「打字机」渲染：stdout 按行拼接到 `<pre>`，最后用完整输出替换。