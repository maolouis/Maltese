# 开发环境与依赖保护规则

> 立规背景：2026-11-20 本机 pnpm 与 `node_modules` 一起消失，导致构建/测试/发版中断。
> 复盘见 [docs/incidents/2026-11-20-deps-vanish.md](incidents/2026-11-20-deps-vanish.md)。
> 本文件是**强制规则**，对所有 agent、脚本、人工操作一律生效；与 `AGENTS.md` 的
> 「环境与依赖保护」一节互为引用。

## 0. 适用范围

- 本机所有 Maltese 相关工作树：`E:\Maltese`、`E:\Maltese-clean`、`E:\Maltese-verify`、`E:\Maltese2`、
  `E:\MalteseWork`、`E:\MalteseData`，以及任何以后从它们复制/建 junction 的目录。
- 所有本仓库脚本（`scripts/*.mjs`、`scripts/*.ps1`）、`package.json` 的 scripts、CI/发版流程。
- 所有 agent（含 lead、子 agent、一次性发版 agent）与人工操作。

## 1. 绝对禁止（红线）

任何脚本或 agent **不得**删除、清空、移动、改名或"重置"下列对象：

| 对象 | 说明 |
| --- | --- |
| `E:\Maltese\node_modules` 及其内容 | 含 junction 指向它的其它工作树（见第 2 条） |
| `pnpm-lock.yaml`（任何工作树） | 依赖树唯一真值；改它等于改依赖版本 |
| `package-lock.json` / `node_modules\.package-lock.json` 的**覆盖性重写** | 只允许由 npm 自己生成，不允许手工编辑 |
| `%APPDATA%\npm`（`C:\Users\Administrator\AppData\Roaming\npm`） | npm 全局前缀，含 claude/codex 等 CLI 与 shim |
| `%LOCALAPPDATA%\pnpm`（`C:\Users\Administrator\AppData\Local\pnpm`） | pnpm home（全局 bin / 配置 / store 入口） |
| `%LOCALAPPDATA%\node\corepack` | corepack 与 pnpm 本体缓存，删了就得联网重装 |
| `E:\.pnpm-store` | pnpm 内容寻址 store（当前 7140 项），删了要全量重下 |

- **确需重建**（例如依赖树彻底损坏）时：必须由**用户在会话里明确批准**，并且由 lead 记下批准原文；
  未获批准一律不动。
- 被禁止的等价操作包括但不限于：`Remove-Item -Recurse node_modules`、`rmSync(..., {recursive:true})`、
  `rimraf node_modules`、`rm -rf node_modules`、`npm ci` 之外的"清缓存"脚本、
  `pnpm store prune`、`cargo clean`、`npm cache clean --force`、直接删全局前缀目录、
  把 home 目录 `Move-Item` 到别处再"重建"。

## 2. junction / 工作树规则

- `E:\Maltese-clean\node_modules` 是 **junction → `E:\Maltese\node_modules`**。
  对 junction **递归删除会穿透到目标**，因此：**禁止对任何 `node_modules` 路径执行递归删除**，
  包括"只删 `-clean` 那边"。
- 清理或重建工作树时，只允许删 junction 本身：`cmd /c rmdir "E:\Maltese-clean\node_modules"`
  （不带 `/s`），且必须在报告里写明这是 junction。
- 新建工作树要复用依赖时，用 junction（`New-Item -ItemType Junction`）而不是复制；复制一份
  `node_modules` 既浪费空间，又会让"空目录"现象在多个位置同时出现、难以判断真身。

## 3. 构建/发版脚本的清理边界

- 脚本**只允许**清理本项目自己的构建产物：
  - `dist/`
  - `release/`（含 `release/vX.Y.Z/`）
  - `dist-plugins/`
  - `src-tauri/target/`，且优先只清 `src-tauri/target/release/bundle/`
  - 临时目录：`.tmp-build/`、`.tmp-test/`、`.tmp-video/`、`.tmp-bin/`
- **禁止**清理：`node_modules`、锁文件、`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、
  `%LOCALAPPDATA%\node\corepack`、`E:\.pnpm-store`、`src-tauri/target` 之外的全局缓存。
- **`scripts/build-windows.mjs` 的 npm 回退分支必须改掉**（当前 84–89 行会
  `rmSync(node_modules)` 后 `npm install`）：正确行为是**报错退出**并提示"pnpm 不可用，请先恢复 pnpm
  或由用户批准改用 npm"，绝不能静默删除依赖。改动需单独提 PR/提交并由用户确认。
- 任何清理动作都必须：
  1. 先计算并打印**绝对路径 + 体积（文件数/MB）**；
  2. 等待确认（交互式脚本）或在 CI 里显式 `--yes`；
  3. 日志写进 `.tmp-build/clean-<timestamp>.log`，便于事后追溯"谁删了什么"。
- 禁止在 `package.json` 或脚本里新增"万能清理"命令（`clean:all`、`reset`、`nuke` 之类），
  这类命令一旦被 agent 当作尝试修复手段，就会重演本次事故。

## 4. 环境自检（每次发版 / 每天第一次构建）

```powershell
node -v                                        # 期望 v26.x
pnpm -v                                        # 期望 12.x；不存在说明 shim 又丢了（见第 6 节）
Test-Path E:\Maltese\node_modules\typescript   # 必须 True
Test-Path E:\Maltese\pnpm-lock.yaml            # 必须 True
```

- 发版前必须过 [docs/release-checklist.md](release-checklist.md) 的「环境自检」项。
- 检查失败时**不得**自动修复（尤其不得触发 npm 回退删除依赖），按第 5 节上报。

## 5. 依赖缺失时的处理流程（agent 行为约定）

1. **先报告**：发现 `pnpm` 不存在、`node_modules` 为空/缺 `typescript`、Node 版本异常时，
   立刻把现象（命令 + 输出 + 时间戳）报告给 lead，**不要**先动手"修"。
2. **安装可以，删除不行**：允许执行 `pnpm install` / `npm install` 这类**增量安装**；
   禁止删除、清空、重建 `node_modules`、锁文件、全局目录。
3. 需要重装 Node、换包管理器、换依赖布局（npm↔pnpm）这类**破坏性变更**，必须**用户明确批准**。
4. 报告里必须包含：`node -v`、`pnpm -v`、`where pnpm`、`Test-Path node_modules\typescript`
   四项实测结果，以及 `%APPDATA%\npm` / `%LOCALAPPDATA%\pnpm` 的目录时间戳（用于判断是否被清过）。
5. 事故现场**先取证再修复**：在重装任何东西之前保存 `%TEMP%`、`.dsh/sessions`、`Get-Process`
   快照，并尽量导出 `fsutil usn readjournal E:`（USN 能给出精确的删除记录）。

## 6. pnpm 消失时的标准恢复动作（不联网）

pnpm 由 **corepack** 供给，本体在 `%LOCALAPPDATA%\node\corepack\v1\pnpm\12.16.1\`。
Node 26 的 MSI 不再自带 corepack，重装 Node 后 shim 会消失，用下面的方式补回来：

```powershell
# 1) 确认缓存可用（只输出 12.16.1）
& 'E:\node.js\node.exe' "$env:LOCALAPPDATA\node\corepack\v1\pnpm\12.16.1\bin\pnpm.mjs" -v

# 2) 在 PATH 里的 Node 目录生成 pnpm.cmd
@'
@echo off
"E:\node.js\node.exe" "%LOCALAPPDATA%\node\corepack\v1\pnpm\12.16.1\bin\pnpm.mjs" %*
'@ | Set-Content -Encoding ascii "E:\node.js\pnpm.cmd"

# 3) 复核
pnpm -v
```

store 已在 `E:\.pnpm-store\v11`（`pnpm store path` 会解析到这里），所以
`pnpm install --frozen-lockfile`（可加 `--offline`）能最大程度复用缓存。

## 7. 违规处理

- 任何提交/脚本被 review 到违反第 1–3 条，**直接拒绝合并**，并在提交说明里标注
  「违反 docs/dev-environment-rules.md 第 N 条」。
- 造成依赖丢失的脚本必须回滚或加护栏后才允许继续发版。
- 本规则的修改同样需要用户确认（与 `AGENTS.md` 同级约束）。