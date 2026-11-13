# 发布形式与打包卫生（Distribution）

本文说明 Maltese 的分发形态、打包约束，以及「资源外置」重构的具体步骤。
分支：`refactor/external-resources`；版本线从 **v0.1.0** 重新开始迭代。

## 1. 目标

| 目标 | 做法 |
| --- | --- |
| 不被杀软误判 | 干净源码构建、标准 NSIS、无加壳/混淆/注入、自启动最小化且可解释 |
| 纯资源更新不换 PE | JS/CSS/字体/素材装到安装目录 `resources/`，只有 Rust 核心改动才换 exe |
| 首启行为正常 | 不往 Temp 丢 exe、不静默拉起、不做动态代码注入 |
| 信誉可积累 | 发布地址 / 发布者名称 / 版本号保持稳定，不频繁换下载源 |

## 2. 当前约束（已落实）

- **不加壳、不混淆、不用 UPX**：`Cargo.toml` / `package.json` / `tauri.conf.json` 均无相关配置，
  `scripts/verify-packaging.mjs` 会拦截；
- **标准 NSIS**：`tauri build --bundles nsis`，`installMode` 保持 `currentUser`，不做自定义二进制安装器、
  不下载外部载荷；
- **不往 Temp 丢 exe**：源码中没有任何「临时目录写入可执行文件再拉起」的路径；
- **不做注入**：无 `WriteProcessMemory` / `CreateRemoteThread` / `CreateProcessW + CREATE_SUSPENDED`、
  无 `LoadLibrary` 用户路径加载、无反射执行；
- **自启动最小化**：只写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，且仅当用户在设置里开启；
  启动时只做「已登记路径是否指向当前 exe」的修正，不会自己新增自启项；
- **WebView2Loader 静态链接**：不额外落盘 DLL。

以上每条都会在发布前由 `node scripts/verify-packaging.mjs` 检查（失败退出码 1）。

## 3. 资源外置（分三步，逐步验证）

当前状态：`public/assets` 46.7 MB 仍随前端产物打进 exe（`tauri.conf.json` 的 `frontendDist: ../dist`）。
40 多 MB 的 GIF 是安装包体积的主体，也是「每次改素材都换 PE」的根因。

### 第 1 步：素材移出前端产物（已完成）

已落地（分支 `refactor/external-resources`）：

1. `public/assets/pets`（43.1 MB / 593 个 GIF）移到仓库根 `assets/pets`，不再被 Vite 复制进 `dist`；
2. `src-tauri/tauri.conf.json`：

   ```json
   "bundle": {
     "resources": {
       "../assets/pets": "assets/pets"
     }
   }
   ```

   安装后位于 `<安装目录>\resources\assets\pets\`；
3. 新增原生命令 `get_pet_asset_base`，返回 `<resource_dir>/assets/pets`（不存在时返回空串）；
4. 新增 `src/petAssetBase.ts`：`initPetAssetBase()` 在 `main.tsx` 渲染前 await 一次，
   `petAssetUrl("/assets/pets/...")` 用 `convertFileSrc` 换成真实文件 URL（中文文件名会先 decode）；
5. 解析点收敛在三个地方：`petCharacters.ts` 的 `characterFramesForState` / `characterAllFrames`、
   `petAssets.ts` 的 `resolvePetGif`、以及 3 处 `rest.gif` 字面量。生成清单文件本身没改；
6. `pnpm dev` 由 `vite.config.ts` 里的只读中间件继续提供 `/assets/pets/*`（含目录穿越校验），
   开发时不需要把 43 MB 复制回 `public`。

实测体积变化：

| 产物 | 外置前 | 外置后 |
| --- | --- | --- |
| `dist`（打进 exe 的部分） | 49.5 MB | **6.4 MB** |
| exe | 31.0 MB | **24.8 MB** |
| NSIS 安装包 | 29.6 MB | 29.1 MB（素材改为随 `resources/` 安装） |

换 GIF / 换字体主题只需要替换安装目录里的 `resources/assets/pets`，**PE 不变**。

**验证状态**：`tsc --noEmit`、`vite build`、`cargo check`、`pnpm tauri build` 均通过，安装包已生成；
但本次会话里无法完成「安装 + 启动 + 看图是否正常显示」的实机验证（安装器静默安装与 GUI 启动在当前环境下会挂起），
所以「素材是否真的从 resources 加载」需要下次实机确认：启动后看小狗 GIF 是否正常、以及
`<安装目录>\resources\assets\pets` 是否存在。
### 第 2 步：JS/CSS/字体外置（可选，收益中等）

Tauri 默认把 `frontendDist` 整个嵌进可执行文件。要真正外置，需要：

1. Rust 侧注册自定义协议（例如 `maltese`），从 `<resourceDir>/web/` 读文件并补 MIME 类型，
   同时做路径穿越校验（规范化后必须仍在 `web/` 内）；
2. `frontendDist` 指向一个极小的占位目录（只保留「资源缺失」提示页），
   把真正的前端产物作为 `bundle.resources` 一起安装；
3. 所有窗口 URL 改为 `http://maltese.localhost/index.html?window=...`，
   并确认 IPC 注入、`capabilities` 与 CSP 都按新来源放行。

风险：这种改法一旦自定义协议或 IPC 注入有问题，会直接白屏。**必须实机验证**
（启动 → 岛体渲染 → 悬停展开 → 聊天一次 → 托盘隐藏/恢复）后再合入。

### 第 3 步：更新通道与资源分离

- 前端/素材更新：只发新的资源包（zip + 校验和），更新器覆盖 `resources/`，不换 exe；
- Rust 核心更新：照旧发新 exe + 安装器，走 minisign 校验（已有链路：`prepare-release-config.mjs` +
  `make-latest-json.mjs` + `latest.json`）。

## 4. 启发式风险清单（对照当前代码）

| 行为 | 风险 | 现状 | 建议 |
| --- | --- | --- | --- |
| 未签名 NSIS 安装器 | 高（SmartScreen 未知发布者） | 存在 | 注册主体 + OV 证书，流水线固定签名与时间戳 |
| 44 MB 内嵌素材的 exe | 中（体积异常、每次更新都换 PE） | 存在 | 按第 3 节第 1 步外置 |
| 子进程调用 `reg.exe` | 低（合法但会被启发式计数） | 存在 | 改用 registry API（`RegSetValueExW`）替代子进程 |
| 全局热键 / 键盘注入（`keybd_event`） | 中（远控类特征） | 存在（视频自动翻页、技能） | 仅在用户触发时执行，文档标注用途 |
| 桌面图标搬动（台球） | 中（跨进程消息） | 存在 | 仅在用户点击进入游戏时执行，退出即恢复 |
| 自启动 | 中 | 用户可选 | 保持默认关闭，设置里写明写入位置 |
| 资源目录写入（自定义 GIF/音效） | 低 | 存在 | 保持只在用户操作时写，路径固定 |

## 5. 误报处理

1. 把样本（安装器或 exe）+ 检测名 + 系统版本提交到 Microsoft Security Intelligence 门户；
2. 同时在 Release 说明里写清「未签名 + 文件哈希 + 开源仓库」，方便用户自查；
3. 自用机器可用自签名证书装进「受信任的根证书/发布者」，但**对外分发无效**，也不能绕过 SAC；
4. 不要换启动 API、改打包格式、加壳改名、拆 DLL —— 只会触发更高优先级告警。

## 6. 相关脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/verify-packaging.mjs` | 打包卫生检查（版本一致性、无加壳、NSIS、无注入、自启动范围、资源体积） |
| `scripts/verify-release-artifacts.ps1` | 产物检查（签名状态、Defender 扫描、SHA-256） |
| `scripts/prepare-release-config.mjs` / `make-latest-json.mjs` | 更新器公钥注入与清单生成 |
## 7. 推送/拉取排障（DNS 被污染时）

本机曾出现 `github.com` 解析到 `57.155.223.240`（非 GitHub 地址），导致 `git push` 超时。
不改 hosts 的做法：

```powershell
git -c http.curloptResolve=github.com:443:20.205.243.166 push <remote> HEAD:main
```

API 侧同理：`curl --resolve api.github.com:443:20.205.243.168 …`。
`20.200.245.247`、`140.82.112.3`、`4.237.22.38` 也可作为备用地址。
## 8. 自定义安装目录（本机示例：`E:\Maltese2`）

默认安装目录是 `%LOCALAPPDATA%\Maltese`。想换盘可以整个目录搬走，再把这几处指过去：

| 位置 | 键 / 文件 | 改成 |
| --- | --- | --- |
| 卸载项 | `HKCU\...\Uninstall\Maltese` 的 `InstallLocation` / `DisplayIcon` / `UninstallString` | 新目录 |
| 自启动 | `HKCU\...\CurrentVersion\Run` 的 `Maltese Desktop Assistant` | 新 exe 路径 |
| 开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Maltese.lnk` | 新 exe 路径 |
| 桌面快捷方式 | `%USERPROFILE%\Desktop\Maltese.lnk` | 新 exe 路径 |

注意两点：

1. **`resources\` 必须一起搬**：素材外置后 GIF 在 `<安装目录>\resources\assets\pets`，只搬 exe 会看不到小狗；
2. **升级**：`InstallLocation` 更新后，NSIS 升级安装会沿用注册表里的旧路径；内置更新器写的是同一份注册表，
   因此后续 OTA 会继续装在自定义目录里。
## 9. 数据备份与 identifier 迁移

应用数据（设置、待办、聊天、剪贴板、形象配置）存在 WebView2 的 localStorage 里，
路径跟着 `identifier` 走：

```
%LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage\leveldb
```

改 `identifier` 前务必先备份，再迁移：

```powershell
# 1. 停进程、备份
Stop-Process -Name maltese-assistant -Force
robocopy "$env:LOCALAPPDATA\com.maltese.desktop-assistant\EBWebView\Default\Local Storage" `
         "E:\Maltese-backup\<时间戳>\Local Storage" /E

# 2. 用新 identifier 启动一次（建目录），停掉

# 3. 覆盖迁移
robocopy "E:\Maltese-backup\<时间戳>\Local Storage" `
         "$env:LOCALAPPDATA\com.maolouis.maltese\EBWebView\Default\Local Storage" /E

# 4. 再启动验证；LevelDB 的 .ldb 段文件哈希一致即说明数据完整搬过去了
```

本机已按这个流程把 `com.maltese.desktop-assistant` → `com.maolouis.maltese` 迁完，
4 个 `.ldb` 文件 SHA-256 完全一致；旧目录保留作二次备份。