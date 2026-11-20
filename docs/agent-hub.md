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
   - `.cmd/.bat` 优先解析成真实入口直接 spawn：npm 包里的 `node <script.js>` 或包内原生 `.exe`
     （codex 是 node shim，Claude Code 是包内 `claude.exe`），**不经过 cmd.exe**；
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
| codex 报 `failed to initialize in-process app-server client: 拒绝访问 (os error 5)` | codex 自己的 app-server 在受限环境/临时目录 ACL/杀软下起不来（os error 5）。先在终端手动跑 `codex exec --skip-git-repo-check "hi"` 确认；能跑再看日志里的 launcher 与 stderr；受限沙箱里可先用 claude 跑流水线 |
| 300 秒超时 | 日志里 `AGENT_TIMEOUT`；网络/登录问题最常见。可在 CLI 里先手动跑一次确认 |
| 提示「包含 shell 元字符」 | 该 agent 解析成了 `.cmd` 兜底路径；把 command 换成真正的 `.exe`/`.ps1`，或去掉 prompt 里的 `& | % !` 等字符 |
| 配置解析失败 | 修好 `config.json` 的 JSON 语法，或删掉它重启（会重新生成默认配置） |
| 豆包不可用 | 见 §3「豆包」：没有官方 CLI，需要自备包装脚本 |

## 9. 本轮边界 / 未做

- 不做 DAG、条件分支、并行步骤、重试策略；流水线就是顺序执行。
- [ ] 外部平台（Codex/Claude Code/豆包）token 用量监测：已评估，暂不实现；见
      [research-external-token-usage.md](research-external-token-usage.md)（本地 token 统计只含
      local/dsh，不与外部平台混算）。
- 不做模型用量埋点（`local_chat` / `dsh_chat` 的统计仍是后续 P1），控制台里标「待接入」。
- 不做聊天触发流水线（缺确认卡片，见 §6 第 6 条）。
- 不做 agent 配置的 UI 编辑器：直接改 `config.json` + 刷新。
- 不做流式增量「打字机」渲染：stdout 按行拼接到 `<pre>`，最后用完整输出替换。

## 11. P0：主线程阻塞排查（2026-11-19）

用户报「实例卡死（Responding=False、CPU 0.97s）」后对 agent-hub 做的只读排查 + 加固：

**结论：agent-hub 不阻塞 Tauri 主线程。** 依据：

1. **7 个命令全部是 `async fn`**。Tauri 只会把异步命令放到 async runtime；同步命令才会在 main thread 执行。
   - `agent_run` / `agent_pipeline` / `agent_pipeline_run` 从一开始就是 async；
   - 本轮把 `get_agent_registry` / `agent_hub_status` / `agent_hub_usage` / `agent_cancel` 从同步命令改成 async，并把 IO/等待放进 `spawn_blocking`。
2. **阻塞调用全部在 blocking 线程**：`run_one_blocking`（`thread::sleep` 轮询 `try_wait`、`taskkill` 的 `status()`、2s `recv_timeout`）只在 `spawn_blocking` 里执行；`agent_cancel` 的 `taskkill` 也在 `spawn_blocking`；日志读写、PATH 扫描都在 blocking 线程。
3. **锁清单与顺序**（全为 `std::sync::Mutex`，`MutexGuard` 都不跨 `.await`，也不在持锁时做 IO）：
   - `RUNNING`（谁在跑）、`QUEUE`（排队数）、`RECENT_ERRORS`（最近错误）、`PROBE_CACHE`（探测缓存）。
   - 旧代码里 `build_registry` 会同时持有 `RUNNING + QUEUE` 去扫 PATH；本轮改为**先拷快照、立刻释放锁**再探测，避免「主线程拿锁 + 探测慢 IO」把 `agent_run` 的清理线程顶住。
   - 没有交叉锁等待：`RUNNING → RECENT_ERRORS` 是一致的单向顺序；`PROBE_CACHE` 只在拷贝/插入时短暂持有，解析可执行文件时已释放。
4. **管道**：`stdout`/`stderr` 在 spawn 后立刻各起一个读取线程逐行消费（`BufReader::read_line` + 事件推送），再 `try_wait` 轮询；不会出现「父进程不读 pipe、子进程写满 64KB 卡住」。
5. **启动路径**：应用启动 / 托盘 / 岛初始页（`todo`）都不会调用 agent-hub；只有打开「Agent」页签或聊天触发 `agent_registry`/`agent_status` 才访问本模块。因此「开机即卡死」不可能由本模块引起。
6. `codex` 在本机受限会话里的 `failed to initialize in-process app-server client: 拒绝访问 (os error 5)` 是子进程自身启动失败（1.2s 内返回并写 `end` 日志），**不是卡死**；claude 可正常跑。

如果之后再出现卡死，可按「文件:行」核对：本模块已无同步命令、无持锁 IO、无 `block_on`、无未消费管道。

## 12. 验证记录（2026-11-19，本机）

| 项 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 error |
| `cargo check --target x86_64-pc-windows-msvc` | 通过（Finished，本模块无 warning/error） |
| `node --test tests/*.test.mjs` | 250/250 通过（在提交树 worktree 里跑；主工作区 4 个失败来自并行的宠物素材重构 WIP，与本模块无关） |
| `cargo test --lib agent_hub::tests` | 9 passed（参数/模板/安全校验/shim 解析/日志路径/默认配置） |
| 实机探测 | codex ✓、claude ✓、豆包 ✗（PATH 与 `%APPDATA%\npm` 都没有 `doubao`）、dsh 默认禁用 |
| 实机单跑 claude | `ok=true exit=0 duration=2539ms firstLine=1954ms output="OK"`；日志 `agent-2026-11-19.jsonl` 有 start/end 两行，只含 prompt 前 80 字与长度 |
| 实机 codex | 在本机受限会话里报 `failed to initialize in-process app-server client: 拒绝访问 (os error 5)`（同为 os error 5 的临时目录/ACL 限制）；终端手动 `codex exec` 可正常输出，属于环境限制，不是适配器逻辑 |
| 实机流水线 | claude 两步流水线通过（第 2 步成功拿到第 1 步输出并复述 + `PIPELINE_OK`），证明串行与 `{{prev}}` 注入可用；`review` 流水线在本机因 codex 起不来会在第 1 步停下并显示中文原因 |
| `vite build` | 通过（dist 产物包含 AgentConsole） |

复现实机测试：

```powershell
# 单 agent（claude）
cargo test --lib agent_hub::tests::real_agent_run -- --ignored --nocapture
# 两步流水线（claude → claude，最稳）
cargo test --lib agent_hub::tests::real_pipeline_claude_twice -- --ignored --nocapture
# 两步流水线（codex → claude，需要 codex 能在当前会话里起 app-server）
cargo test --lib agent_hub::tests::real_pipeline_codex_then_claude -- --ignored --nocapture
```
## 13. 桌面 Agent 监控（2026-11-19 方向变更：监控桌面端而不是 CLI）

用户明确目标是「**agent 要监控桌面端而不是 CLI**」。因此控制台主视图改为「桌面 Agent 状态」，
`agent_hub.rs` 的 CLI 适配器保留但降级为「高级：命令行 Agent」折叠区。

### 13.1 探测实现（Rust `src-tauri/src/desktop_agents.rs`）

- 只读枚举：`EnumWindows` → 跳过不可见、`WS_EX_TOOLWINDOW` 工具窗口、有 owner 的弹窗、空标题、
  本进程窗口；`GetWindowThreadProcessId` 拿 PID，`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
  `QueryFullProcessImageNameW` 拿进程名。
- 标题用 `GetWindowTextLengthW` + `GetWindowTextW`，上限 200 字符、原始长度超过 4096 直接跳过；
  顶层窗口最多检查 800 个。
- 匹配规则：进程名（去 `.exe`、大小写不敏感）**或** 窗口标题包含配置片段（给壳应用兜底）。
  标题匹配带**词边界**校验（避免 `Qwen` 命中 `monitor-qwen36.ps1 - Notepad` 这类误报）。
- 输出每个 agent：`running / processCount / pids / windowTitle / matchedProcess / isForeground /
  foregroundSeconds / lastActiveAgoSeconds`；另外返回当前前台窗口 `foreground`。
- 活跃时间：进程内静态表记录「上次前台时间 / 本次前台起点」，不落盘；重启后重新计。

### 13.2 白名单配置

`%APPDATA%\com.maolouis.maltese\agent-hub\config.json` 增加 `desktopAgents[]`；**空数组/缺字段时用内置默认表**
（Claude / ChatGPT / Cursor / 豆包 / 通义 / Copilot / Codex）。自定义示例：

```json
{
  "desktopAgents": [
    {
      "id": "claude-desktop",
      "displayName": "Claude",
      "processNames": ["claude", "claude-desktop"],
      "windowTitlePatterns": ["Claude"]
    },
    {
      "id": "my-assistant",
      "displayName": "我的助手",
      "processNames": ["my-assistant.exe"],
      "windowTitlePatterns": ["我的助手"]
    }
  ]
}
```

改完点控制台「刷新」（会强制重新枚举，3s 缓存被绕过）。

### 13.3 聚焦行为（只聚焦，不注入）

`desktop_agent_focus(id)`：找到该 agent 的可见顶层窗口 → 最小化则 `ShowWindow(SW_RESTORE)` →
`SetForegroundWindow`；被前台锁拒绝时依次尝试 `BringWindowToTop` 再 `SetForegroundWindow`、
`AttachThreadInput`（临时把自己的输入队列挂到当前前台线程再抢前台）、
最后 `SwitchToThisWindow`（托盘/启动器兼容入口），然后以 `GetForegroundWindow` 校验。
**没有 sleep 轮询、没有模拟按键/鼠标、没有 UI 点击**；找不到窗口立即返回中文「未启动」，
聚焦失败返回「系统拒绝把「X」切到前台（可能被前台锁定）」。
未运行的应用在卡片上显示「未启动」，点聚焦只提示原因。

### 13.4 性能与 P0（不阻塞 UI）

- 命令全部是 `async fn` + `spawn_blocking`，不在 Tauri main thread 枚举窗口；
- 结果缓存 3s：`desktop_agents_status(refresh=false)` 命中缓存直接返回（带 `cached:true`）；
- 每次枚举返回 `enumerationMs`，控制台卡片右上角直接显示；
- 命令入口用 `Instant` 计时，>200ms 写 `SLOW_COMMAND` 到 `agent-hub/logs/agent-<date>.jsonl`
  （同时覆盖 CLI 命令：`agent_run`、`agent_pipeline`、`agent_pipeline_run`、`get_agent_registry` 等）；
- `SetForegroundWindow` 也在 `spawn_blocking`，失败立即返回中文原因。

### 13.5 控制台与对话

- ③ 工作分配：**桌面 Agent**（运行状态/窗口标题/前台时长/最近活跃/PID 数 + 聚焦按钮）+
  **内部模块**（聊天、主动聊天、视频采集、日报投递、翻译）。
- 「高级：命令行 Agent」默认收起，里面是原来的 CLI 卡片与流水线，不影响桌面监控首屏。
- 只读技能新增 `desktop_agents_status`（「现在开了哪些 AI 应用」「我在用哪个」）；
  `agent_status` 改为汇总「命令行 agent + 桌面 AI 应用」。

### 13.6 为什么不输入注入

桌面 AI 应用的输入框属于用户私有交互面：自动点击/输入会带来误发消息、破坏上下文、
绕过应用自身权限提示等风险，也无法保证跨应用稳定。需求只要求「状态监控 + 聚焦」，
所以本模块只做只读枚举与 `SetForegroundWindow`，后续也不计划加入键鼠注入。

### 13.7 实机记录（2026-11-19，本机）

- 枚举结果（`cargo test --lib desktop_agents::tests::real_list_and_focus -- --ignored --nocapture`）：
  ChatGPT 运行中（PID 26912，窗口「ChatGPT」）、豆包运行中（`Doubao.exe`，PID 41616，窗口「部署 - 豆包」），
  Claude / Cursor / Copilot / Codex 未启动。单次枚举 **2–3ms**；连续刷新 10 次每次 **0–1ms**
  （`refresh 1..10: 1/0/0/1/1/1/1/0/1/0 ms`）。
- 误报修复：最初 `通义` 的白名单标题片段 `Qwen` 命中了记事本窗口 `monitor-qwen36.ps1 - Notepad`；
  改为词边界匹配后不再误报（另有单测 `title_matching_respects_word_boundaries`）。
- 聚焦：后台测试进程不是前台进程，`SetForegroundWindow` 被 Windows 前台锁拒绝并返回中文原因
  （符合「失败立即返回原因」的设计）；真实使用中点卡片上的「聚焦」时本应用是前台进程，
  走同一条 `ShowWindow/SetForegroundWindow/AttachThreadInput/SwitchToThisWindow` 链路。
  这一条需要人工在 UI 上点一次确认（见「未验证」）。
- 应用启动限制：本 DSH 会话对 `%APPDATA%` 没有写权限（`os error 5`），
  启动 release 包会在 `Failed to setup app: 拒绝访问` 退出，因此**无法在本会话里点 UI**；
  枚举/聚焦代码用 `cargo test` 直接验证（不依赖 Tauri AppHandle）。正常用户会话不受影响。
- `SLOW_COMMAND`：命令入口耗时 >200ms 才写日志，格式
  `{"event":"SLOW_COMMAND","command":"desktop_agents_status","durationMs":123}`；
  正常枚举 2–3ms 不会触发，缓存命中路径更不会触发。

## 14. 对话任务进度状态机（MVP，2026-11-19）

实现依据：[research-task-progress-tokens.md](research-task-progress-tokens.md)（B 节）。新增
`src-tauri/src/task_progress.rs`，控制台「任务进度」卡改为任务列表。

### 14.1 状态机

- 类型：`chat / search / settings / todo / video / daily / agent / other`
- 阶段：`requested → planning → executing → waiting_confirm → delivering → done / failed / cancelled / stalled`
- 只允许合法前进（`valid_transition`）；终态只能经 `task_end` 落地；同一阶段可用 `task_advance`
  更新进度/详情。
- 超时：超过预期时长 **2×** 无更新 → `stalled`。默认 search 120s、agent 300s、daily 600s、
  video 按 `maxMinutes×60`（由快照带入）、settings/todo 60s、其它 120s。
- 内存表保留最近 20 条（优先淘汰终态）；按天落盘
  `<agent-hub>/logs/tasks-YYYY-MM-DD.jsonl`（`begin/advance/end/stalled` 各一行，含 tasksId/kind/stage/
  title/source/progress/detail/error/startedAt/updatedAt/expectedSecs）。

### 14.2 上报点（确定性优先，零额外模型调用）

| 来源 | 上报方式 |
| --- | --- |
| 视频 | `task_list_snapshot` 内部读 `video_get_snapshot`：running → video 任务 executing（digesting→delivering、awaitingLogin→waiting_confirm），progress=`itemCount / 预计条数`（预计条数 = `maxMinutes×4`，按每条 15s）；停止/结束 → done（有采集）或 cancelled；blocked → failed |
| Agent 单跑 | `agent_run` 在 spawn 前 `begin(agent,"运行 <name>")` → executing，结束后按结果 done/failed/cancelled，detail 带时长/首行 |
| Agent 流水线 | `agent_pipeline` 开始时建任务，每步 `advance(progress i/n, detail "第 i 步 · agent")`，结束 done/failed（`agent-pipeline-step` 事件照旧推给前端折叠面板） |
| 技能快任务 | 前端 `runSkill` 包装：todo→todo、web_search→search、pet_settings/open_app/open_url/media_control/music_play→settings；begin→executing→done/failed，失败不影响技能本身 |
| 兜底推断 | `task_infer`（≤100 token JSON）：只在 PetChat「未命中技能」的回复后异步调用（30s 节流、页面隐藏不跑）；confidence<0.6/非法类型返回 None；命中则建一条 `source:"inferred"` 任务并立即 done，detail 记「推断阶段 x · 置信度 y」，**不覆盖**技能/视频/agent 状态 |

### 14.3 命令与前端

| 命令 | 说明 |
| --- | --- |
| `task_begin(kind,title,id?,expectedSecs?)` | 建任务（requested） |
| `task_advance(id,stage,progressCurrent?,progressTotal?,detail?)` | 推进阶段/进度 |
| `task_end(id,stage,error?,detail?)` | 结束到终态 |
| `task_list_snapshot(limit?)` | 任务列表（含视频同步、stalled 清理），返回 `tasks/revision/now/activeCount` |
| `task_infer(text,reply?)` | 兜底推断（低置信度返回 null） |

前端 `src/taskProgressView.ts` 提供纯逻辑：`taskProgressPercent / formatTaskElapsed / diffTaskRows /
taskRowChanged`；`AgentConsole` 每 **1s** 拉 `task_list_snapshot`，只把 diff 里新增/变化的行写入
`Record<id, Task>`（未变化行保持原对象，`memo` 的任务行不重渲染），行内自己每秒 tick 耗时；
空态显示「当前没有进行中的任务」；阶段颜色：执行中绿、等待确认橙、失败/停滞红、完成灰。

### 14.4 单测与验证

- Rust：`stage_transitions_are_validated`（合法/非法流转）、`timeout_marks_task_stalled`、
  `jsonl_log_rotates_by_day`、`snapshot_is_sorted_and_limited`、`video_snapshot_drives_video_task`、
  `heartbeat_does_not_write_but_still_stalls`、`real_video_heartbeat_60s`（忽略测试，实机 60s）、
  `infer_parser_rejects_low_confidence_and_bad_kind`。
- Node：`tests/task-progress-view.test.mjs`（diff 只返回变化行、进度百分比、耗时格式、推断 30s 节流）。
- 实机：`cargo test --lib agent_hub::tests::real_three_tasks -- --ignored --nocapture` 跑
  「视频开始/停止（快照映射）+ 加待办 + claude 真跑一次」，打印控制台任务列表与 tasks jsonl。
  本 DSH 会话无法启动 GUI（%APPDATA% 无写权限，os error 5），UI 上的列表/1s 刷新需人工点验。

### 14.5 日志降噪与视频进度口径（2026-11-20）

**1）advance 写盘前 diff（心跳不落盘）**

- `advance()` 与视频 `sync_video` 在写 jsonl 前比较「写前快照」：只有
  **stage 变化**、**progress.current 变化**、**detail 变化**时才写一行；纯心跳（同一秒快照、条数不变）
  **不写盘**。内存里的 `updatedAt` 每个心跳仍会更新，`stalled` 判定不受影响。
- `task_end` 也只在 stage 真正变化时写 `end`，重复 end 不刷日志。
- 单测：`heartbeat_does_not_write_but_still_stalls`（5 次心跳行数不变 → 条数+1 写一行 →
  回拨 updatedAt 后 stalled 仍触发并补一行）。

**2）视频进度条口径**

- 之前 `total = max(steps, itemCount)`，采到第 13 条时 `total=13/current=13` → 进度条永远 100%。
- 现在 `total = maxMinutes × 60 / 15`（每条按 15s 估算）：30 分钟 ≈ **120 条**；实际条数超过估计时
  UI 百分比按 100% 截断，但 detail 里仍显示真实条数。
- detail 文案：`已采集 12 条 / 预计约 120 条 · 30 分钟上限`（有待投递时追加「待投递 N」）。
- 单测：`video_snapshot_drives_video_task` 断言 `current=7,total=120`，不再是 100%。

**3）实机 60s 证据**

`cargo test --lib task_progress::tests::real_video_heartbeat_60s -- --ignored --nocapture`
（每秒一次视频快照心跳，第 20/40 秒各 +5 条，第 60 秒停止）：

| 秒 | 落盘行数 | current/total |
| --- | --- | --- |
| t=1 | 2（begin + 首次 advance） | 0/120 |
| t=2..19 | 2（心跳不写） | 0/120 |
| t=20 | 3（条数 +5） | 5/120 |
| t=21..39 | 3 | 5/120 |
| t=40 | 4（条数 +10） | 10/120 |
| t=41..60 | 4 | 10/120 |
| 停止后 | 5（end/done） | 10/120 |

旧实现同场景约 **62 行**（60 次心跳每行 advance），修复后 **5 行**；jsonl 只保留
begin / 0→5 / 5→10 / 结束四条阶段变化。
