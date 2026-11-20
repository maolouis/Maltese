# 事故复盘：本机 pnpm 与 node_modules 一起消失（2026-11-20）

- 状态：**已定位到机制与可达路径，单一「谁删的」未能 100% 确证**（材料见第 3 节「置信度」）
- 调查人：环境监察 agent（只读取证 + 规则落地；未执行任何删除）
- 关联规则：[docs/dev-environment-rules.md](../dev-environment-rules.md)
- 影响面：所有需要 `pnpm` / `node_modules` 的构建、`tsc`、测试、发版流程（第 6 节）

## 1. 结论先行

1. **`pnpm` 不是被谁删掉的，而是随 Node.js 的 MSI 大版本升级一起丢的启动链。**
   本机 pnpm 一直是 **Corepack 供给的**（`%LOCALAPPDATA%\node\corepack\lastKnownGood.json`
   记录 `pnpm 12.16.1`），真正的 `pnpm` 启动器是 Node 安装目录里的 corepack shim。
   2026-11-20 16:24:37 有人用 winget 重装 Node.js LTS（26.13.1，装到 `E:\node.js\`），
   MSI 走的是 **major upgrade**（`RemoveExistingProducts` 16:25:36→16:25:52）并重写了 PATH，
   升完之后 `E:\node.js\` 里已经没有 `corepack.cmd` / `pnpm.cmd`，于是 `pnpm` 命令消失。
   **反证**：`%APPDATA%\npm` 目录最后修改时间仍是 **7/22 12:02:56**，`%APPDATA%\npm\node_modules`
   仍是 **7/21 14:32:16** 且只有 `@anthropic-ai` / `@openai` —— 说明 pnpm **从来不是**
   `npm i -g pnpm` 装在 npm 全局前缀里的，也不是今天从那里被删的。
2. **`node_modules` 是「目录还在、内容被清空后又重建」，不是「从未安装」。**
   - `E:\Maltese\node_modules` 的 `CreationTime` 仍是 **2026-11-02 20:17:29**（目录对象没被重建）；
   - 现在里面的内容是 **16:26:59–16:27:14** 由 **npm** 重新装出来的
     （有 `node_modules\.package-lock.json`，**没有** `.modules.yaml`，仓库根多了未跟踪的 `package-lock.json`）。
   - 16:27 之前它确实是空的（lead 观察到 0 个子目录）。
3. **仓库里确实存在一条「pnpm 不可用 → 自动 `rmSync(node_modules)`」的地雷。**
   `scripts/build-windows.mjs:84-89`：当探测不到 pnpm（回退到 npm）且存在 `pnpm-lock.yaml` 时，
   脚本会**静默**执行 `rmSync(ROOT/node_modules, {recursive:true, force:true})` 再 `npm install`。
   这是整个仓库唯一会删除 `node_modules` 的代码。本次事故后 pnpm 恰好不可用，这条路径**从"永远不会触发"
   变成"一跑就触发"**。
4. **没有任何证据支持"有人手工删"**：PowerShell 交互历史文件 `ConsoleHost_history.txt` 最后写入
   2026-11-13 17:34（此后没有键入过命令）；`E:\$RECYCLE.BIN` 里 11-20 当天没有相关条目；
   Defender 近 3 天无检测记录；`E:` 盘剩余 57.6 GB，不是空间不足导致安装失败。
5. **好消息：依赖数据没丢。** pnpm store `E:\.pnpm-store\v11` 完整（7140 项，
   `files/` 最后写入 11-11 17:28，`index.db` 11-11 17:29），`pnpm-lock.yaml` 也没被改过
   （mtime 11-11 17:29，SHA-256 `9759C682…E357FCF`）。而且**corepack 缓存里的 pnpm 12.16.1 现在就能跑**（已验证 `pnpm -v`）。

## 2. 事实清单（全部可复现）

调查时间窗：2026-11-20 16:27–16:40。以下命令都是只读的。

### 2.1 依赖目录状态

| 对象 | 观测值 | 判读 |
| --- | --- | --- |
| `E:\Maltese\node_modules` | 目录 `CreationTime=2026-11-02 20:17:29`；内容 47 个顶层项、7705 个文件、124.9 MB，全部 mtime `16:26:59` / `16:27:13` | 目录没被重建，**内容被清空后重装** |
| `node_modules\.package-lock.json` | 43236 bytes，`16:27:14` | 当前是 **npm** 安装 |
| `node_modules\.modules.yaml` | 不存在 | 当前树**不是** pnpm 链接出来的 |
| `E:\Maltese\package-lock.json` | 新建 `16:27:13`，74 KB，`git status` 未跟踪 | npm 回退的副产物，pnpm 项目不该入库 |
| `E:\Maltese\pnpm-lock.yaml` | `c=11-11 17:28:23 w=11-11 17:29:22`，SHA-256 `9759C682…E357FCF` | 锁定文件**没被删、没被改** |
| `E:\Maltese-clean\node_modules` | `Get-Item` → `LinkType=Junction`，`Target=E:\Maltese\node_modules`（`fsutil reparsepoint query` 确认 `0xa0000003` Mount Point） | **不是独立目录**，两个"空"是同一个目录 |
| `E:\Maltese-verify\node_modules` | 不存在 | 该工作树从来没建过依赖（或建过 junction 后被移除） |

`E:\Maltese\src-tauri\target\release\maltese-assistant.exe` 的 mtime 是 **15:51**，`dist/` 是 **15:50:44**
→ **15:51 时 node + pnpm + node_modules 都还是好的**，故障发生在这之后。

### 2.2 包管理器现状

```
E:\node.js\node.exe -v   -> v26.13.1
E:\node.js\npm.cmd -v    -> 11.20.0
where.exe pnpm           -> 找不到（退出码 1）
where.exe corepack       -> 找不到
E:\node.js\              -> 只有 node.exe / npm* / npx* / nodevars.bat / install_tools.bat / node_modules\npm
                            （没有 corepack.cmd，没有 pnpm.cmd）
%APPDATA%\npm            -> LastWriteTime 2026-07-22 12:02:56，只有 claude* / codex* 六个文件
%APPDATA%\npm\node_modules -> LastWriteTime 2026-07-21 14:32:16，只有 @anthropic-ai、@openai
%LOCALAPPDATA%\pnpm      -> 存在但空（0 项），LastWriteTime 2026-11-18 19:53
%LOCALAPPDATA%\node\corepack\lastKnownGood.json -> {"pnpm":"12.16.1+sha512.091d1dee…"}
%LOCALAPPDATA%\node\corepack\v1\pnpm\12.16.1\   -> 完整包（bin/pnpm.mjs、pnpm-native.exe…，11-03 11:32）
E:\.pnpm-store\v11       -> files/ (11-11 17:28:23)、projects/ (11-04 17:22:38)、index.db (11-11 17:29:22)，7140 项
```

**可运行性实测**（只跑 `-v`，不装东西）：

```
node E:\...\corepack\v1\pnpm\12.16.1\bin\pnpm.mjs -v  -> 12.16.1
node ... pnpm.mjs store path                          -> E:\.pnpm-store\v11
```

→ pnpm 本体和 store 都还在，**只是没有入口（shim）了**；store 路径也能正确解析到 E: 盘那份完整 store。

### 2.3 Node.js 重装（事件主角）

winget 日志 `%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir\`：

- `WinGet-2026-11-20-16-24-37.197.log`：
  `Command line Args: winget.exe install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`
- `OpenJS.NodeJS.LTS.26.13.1-26-11-20-16-25-09.log`：
  - `INSTALLDIR = E:\node.js\`，新 ProductCode `{6178C0C7-…}`，版本 26.13.1；
  - `UPGRADINGPRODUCTCODE = {7989E57E-…}`（旧的 Node.js 产品）；
  - `16:25:36 Action start: RemoveExistingProducts` → `16:25:52 Action ended … Return value 1`（先卸旧产品）；
  - `16:25:40` / `16:25:54` 两轮 `RemoveEnvironmentStrings` + `WriteEnvironmentStrings`（**改写 PATH**）；
  - `16:26:05 Product: Node.js -- Installation completed successfully`。

注册表：`HKLM\SOFTWARE\Node.js InstallPath = E:\node.js\`；卸载项 `{7989E57E-…} | Node.js | 26.13.1`。
事件日志 `Application/MsiInstaller`：16:25:09 开始事务、16:26:05 安装成功（状态 0），**没有**独立的产品卸载事件。

→ 这与「pnpm 入口随 Node 安装目录一起换掉」完全吻合：Node 新版本（26.x）MSI 不再随包提供 corepack，
旧安装目录里 `corepack.cmd`（MSI 组件）被 `RemoveExistingProducts` 带走，`pnpm` 的 shim 链断掉。
而 corepack 的**缓存**在 `%LOCALAPPDATA%\node\corepack`（不归 MSI 管）所以活了下来 —— 正好解释了"pnpm 不见了但缓存还在"。

### 2.4 时间线（2026-11-20）

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 11:26–16:05 | 当天连续提交，构建/测试链正常 | `git log --since=2026-11-20` |
| 15:50:44 | `dist/` 更新（前端构建成功） | `dist` mtime |
| 15:51 | `src-tauri/target/release/maltese-assistant.exe` 生成（cargo+前端全通过） | exe mtime |
| 16:05、16:15、16:25:21 | 仍有提交（纯代码/文档，不依赖 node） | `git log` |
| ~16:0x–16:24 | node_modules 被清空（`0 个子目录`）**—— 与 pnpm 不可用同一窗口** | lead 观察 + 16:27 之后才出现 npm 安装痕迹 |
| 16:24:37 | winget 开始安装 Node.js LTS 26.13.1 | `WinGet-2026-11-20-16-24-37.197.log` |
| 16:25:36–16:25:52 | MSI `RemoveExistingProducts` 卸旧 Node 产品（带走 corepack/pnpm shim） | MSI 日志 |
| 16:25:40 / 16:25:54 | PATH 被 MSI 重写（`RemoveEnvironmentStrings`+`WriteEnvironmentStrings`） | MSI 日志 |
| 16:25:58 | `E:\node.js` 写入完成（node v26.13.1） | 目录 mtime |
| **16:26:59–16:27:14** | **`node_modules` 被 npm 重新填充**（47 项/7705 文件/124.9 MB） | `.package-lock.json` @16:27:14 |
| 16:27:13 | 仓库根生成未跟踪的 `package-lock.json` | 文件 mtime + `git status` |
| 16:27:28 | `.tmp-build/focusd-manifest-test-*` 新目录（agent 钩子仍在跑） | `.tmp-build` mtime |

## 3. 可能原因排序（含置信度与证据边界）

| # | 假设 | 置信度 | 支持证据 | 反证/边界 |
| --- | --- | --- | --- | --- |
| H1 | **pnpm 随 Node.js MSI 大版本升级丢失**（corepack shim 在旧安装目录里，被 `RemoveExistingProducts` 移除；新 Node 26 不再提供 corepack） | **高**（机制与时序都对得上） | corepack `lastKnownGood.json`=pnpm 12.16.1；`%APPDATA%\npm` 停在 7/22 说明从未 npm 全局安装；MSI 日志 major upgrade + PATH 重写；16:26 后 `where pnpm`/`where corepack` 均失败 | 没能取到"旧 node 目录里确实存在过 `pnpm.cmd`"的直接快照（文件已随安装目录更新） |
| H2 | **`node_modules` 内容被删除后由 npm 重建**（结论已确证"删除"而非"从未安装"） | **高**（对"删过"这一点） | 目录 `CreationTime` 未变 + 内容 mtime 全部 16:26:59 + 缺 `.modules.yaml` + 出现 `.package-lock.json` | 只能确证"被清空过"，确证不了执行清空动作的进程 |
| H3 | **删除由 `scripts/build-windows.mjs` 的 npm 回退分支完成**（本仓库唯一显式删 `node_modules` 的代码） | **中**（可达路径成立，但本次是否真跑了脚本无留存证据） | 代码见 2.5；pnpm 消失后该分支必然触发；npm 安装痕迹与之吻合 | `release/Maltese-assistant.exe` 不存在（脚本第 2 步产物缺失），说明脚本**没有成功跑完**；也未找到该脚本今日的 stdout 日志 |
| H4 | **`pnpm install` 被中途打断**（pnpm 在链接前会移除/重建 `node_modules`，进程在 Node 被替换时被杀 → 留下空目录） | **中低** | 空目录 + 无 `.modules.yaml` + store 里没有今日写入（说明这次 pnpm 安装没走完） | 无法证明当时确实在跑 `pnpm install` |
| H5 | **有人手工删**（agent 或人执行 `Remove-Item -Recurse node_modules`） | **低** | — | PowerShell 交互历史停在 11-13；回收站无 11-20 条目；其余 agent 会话（`.dsh/sessions`，zstd 压缩）未发现可疑命令 |
| H6 | **杀软/磁盘故障/空间不足** | **低** | — | Defender 近 3 天无检测；`E:` 剩 57.6 GB；System 日志近 8h 无磁盘错误 |

### 2.5 仓库内的破坏性代码（本次要害）

`scripts/build-windows.mjs`（84–89 行）：

```js
const usingNpm = pmInvoke.startsWith("npm");
const pnpmLock = join(ROOT, "pnpm-lock.yaml");
if (usingNpm && existsSync(pnpmLock)) {
  console.log("[cleanup] pnpm node_modules are not usable by npm — removing before npm install...");
  rmSync(join(ROOT, "node_modules"), { recursive: true, force: true });
}
```

`detectPackageManager()`（61–74 行）会依次试 `pnpm` → `corepack pnpm` → `npm`。
Node 26 把 corepack 拿掉、pnpm shim 也随旧安装目录消失之后，**这个探测必然落到 `npm`**，
于是"跑一次发版脚本"就会静默删掉整棵 `node_modules`。**这不是假设，是代码事实。**

全仓 grep 结论：除上面这一处，`scripts/`、`tests/`、`package.json` 的 scripts 里**没有**
`Remove-Item node_modules`、`rimraf`、`pnpm store prune`、`cargo clean` 之类命令；
其余 `Remove-Item` 只删临时标记文件（`scripts/focusd-agent-status.ps1`）和单个 zip
（`scripts/pack-plugins.ps1`）。`docs/` 里也没有"清依赖"的流程要求。

## 4. 为什么 `E:\Maltese-clean`、`E:\Maltese-verify` 也"空"

- `E:\Maltese-clean\node_modules` 是 **junction → `E:\Maltese\node_modules`**（建 junction 时间 11-17 16:14）。
  所以"两个目录都空"其实是**同一个目录空**。
- 警告：junction 意味着**对 `E:\Maltese-clean\node_modules` 的任何递归删除都会穿透到 `E:\Maltese\node_modules`**。
  以后清理工作树时只能删 junction 本身（`Remove-Item` 不带 `-Recurse`，或 `cmd /c rmdir`）。
- `E:\Maltese-verify` 本来就没装依赖（无 `node_modules`）。

## 5. 恢复步骤（按优先级；本次已验证到第 2 步）

### 5.1 最快恢复 pnpm（不联网、不装包）

pnpm 12.16.1 还在 corepack 缓存里，直接给 Node 安装目录补一个 shim 即可：

```powershell
# 1) 验证缓存里的 pnpm 可用（本次已实测：输出 12.16.1）
& 'E:\node.js\node.exe' "$env:LOCALAPPDATA\node\corepack\v1\pnpm\12.16.1\bin\pnpm.mjs" -v

# 2) 生成 shim：E:\node.js\pnpm.cmd（该目录已在 PATH 上）
@'
@echo off
"E:\node.js\node.exe" "%LOCALAPPDATA%\node\corepack\v1\pnpm\12.16.1\bin\pnpm.mjs" %*
'@ | Set-Content -Encoding ascii "E:\node.js\pnpm.cmd"

# 3) 复核
pnpm -v
```

（更"正统"的做法是 `npm i -g corepack && corepack enable pnpm`，但要联网、要重装一遍；上面不联网。）

### 5.2 恢复依赖

```powershell
cd E:\Maltese
pnpm install --frozen-lockfile        # store 已在 E:\.pnpm-store\v11，命中率最高
# 需要断网/加速时：pnpm install --frozen-lockfile --offline
```

**风险**：当前 `node_modules` 是 **npm** 装出来的（带 `package-lock.json`），和 `pnpm-lock.yaml`
不是同一棵依赖树。在 npm 树上直接跑 `pnpm install` 可能触发 pnpm 重建整个 `node_modules`
（它会删掉不认识的布局）——这是**正常且必要**的，但要在**用户批准后**做，且先确认 `pnpm-lock.yaml`
与 `package.json` 一致（`pnpm install --frozen-lockfile` 会自己校验，不一致会直接失败而不是改锁文件）。
如果暂时只用 npm 顶着：`npm ci` 或 `npm install` 都能跑构建，但 **`package-lock.json` 不要提交**，
且发版脚本会走 H3 的删除分支。

### 5.3 恢复 node 侧环境（已完成）

Node 26.13.1 + npm 11.20.0 已在 `E:\node.js\`，PATH 已含 `E:\node.js\`。

## 6. 影响面

| 受影响对象 | 表现 | 缓解 |
| --- | --- | --- |
| 所有跑 `pnpm build` / `pnpm tauri dev` 的 agent | 命令不存在，直接失败 | 按 5.1 补 shim |
| `tsc` / 测试 / `scripts/build-windows.mjs` | 依赖缺失 → 失败；若脚本回退 npm 则**先删 `node_modules`** | 规则禁止脚本删除依赖；发版前跑环境自检 |
| 发版流程（`scripts/release*.mjs`、`release-checklist.md`） | 无法产出 exe/安装包；`release/` 今日无 `Maltese-assistant.exe` | 清单加 `node -v` / `pnpm -v` / `node_modules\typescript` 存在性检查 |
| `E:\Maltese-clean` 等 junction 工作树 | 与主仓共用依赖，一处坏全坏；递归删除会穿透 | 规则禁止对 junction 做递归删除 |
| 新开 session（`.dsh`）的 agent | 无 pnpm，误以为"环境没装"→ 可能再次触发 npm 回退 | 规则要求先报告、禁止自行删除/重建 |

## 7. 未确证 / 待补证据

1. 清空 `node_modules` 的**具体进程**没有留存：DSH 会话日志是 `session.v4.jsonl.zstd`（压缩），
   无法直接取证；`ConsoleHost_history.txt` 停在 11-13；没有 `release/` 产物可反推 `build-windows.mjs` 跑过。
2. 旧 Node 安装目录里 `pnpm.cmd` 的确切位置（`E:\node.js\` 还是 `C:\Program Files\nodejs\`）
   已随 MSI 升级被覆盖，无法回滚确认。
3. `E:` 盘 USN 日志未成功导出（`fsutil usn readjournal` 在本次会话中超时/数据量过大），
   否则可以给出"哪个进程删的、精确到秒"的记录。**建议后续在排查这类事故前先导出 USN。**
4. 若要坐实 H3/H4，下次发生同类现象时立刻（在重装任何东西之前）保存：
   `%TEMP%`、`.dsh/sessions`、`Get-Process` 快照、以及 `fsutil usn readjournal E:` 的输出。

## 8. 复发防护

见 [docs/dev-environment-rules.md](../dev-environment-rules.md)（本次已落地），要点：

- 禁止任何脚本/agent 删除 `node_modules`、`pnpm-lock.yaml`、`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`；
  确需重建必须用户在会话里明确批准；
- `scripts/build-windows.mjs` 的 npm 回退**不得**再删除 `node_modules`（应改为报错退出并提示装 pnpm）；
- 清理只允许针对本项目产物（`dist/`、`release/`、`src-tauri/target/bundle`），且必须打印绝对路径+大小并确认；
- 发版前清单增加 `node -v` / `pnpm -v` / `node_modules\typescript` 存在性自检；
- agent 发现依赖缺失：**先报告 lead**，安装可以、删除不行。