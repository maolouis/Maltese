<div align="center">
  <img src="public/assets/pets/linedog-logo.png" alt="Maltese logo" width="96" height="96">

  <h1>Maltese 线条小狗桌面助手</h1>

  <p>一只住在 Windows 桌面上的线条小狗：陪聊、管待办、记剪贴板、控制音乐、提醒 QQ/微信消息，还能帮你刷 B 站和抖音。</p>

  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-1.3.6-orange">
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
    <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB">
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  </p>
</div>

## 这是什么

Maltese 是一个基于 **Tauri 2 + React 19 + Rust** 的 Windows 桌面宠物助手。它用一条线条小狗常驻桌面，把待办、剪贴板、音乐、消息提醒、翻译、常用工具和 AI 聊天集中到一个轻量面板里。

所有感知与消息预览都在本机完成；不内嵌第三方登录页，不把聊天内容、剪贴板或微信 OCR 图片上传到服务器。

## 功能一览

### 桌宠与快捷操作

- **线条小狗**：小白、小鸡毛两套形象共 495 张 GIF（另有 90 张两只同框的共享素材），按设置好的顺序轮播；主狗、陪玩狗和跟随狗都会动。单击摸头、双击庆祝、右键打开聊天、按住左键直接拖动。
- **三个形象**：设置里可切「小白」「小鸡毛」「小白和小鸡毛」。前两者各播自己的素材，并按「每 3 张插 1 张」混播双狗同框图；选「小白和小鸡毛」时只播同框素材。素材说明见 [`docs/pet-characters.md`](docs/pet-characters.md)。
- **顶部标签方向键切换**：面板展开后，用 ↑ ↓ ← → 就能在 待办 / 音乐 / 剪贴板 / 快捷入口 / 聊天 / 插件 之间翻页；光标在输入框里时不拦截。
- **Bongo 模式**：小狗趴在键盘上，按下的键会切到对应“爪子落点”的帧。默认位置可选 **底部居中 / 左下 / 右下 / 顶部居中**，开机后自动出现，不用先关再开。
- **Ctrl + 悬停气泡**：按住 Ctrl 再把鼠标停在小狗上会弹出云朵面板，可直接摸头、挠下巴、抱抱、转圈、陪玩、躲猫猫、追球、喂食、睡觉，以及打开 **待办、音乐、剪贴板、聊天、消息、快捷入口**。
- **表情轮播设置**：设置窗口里可按缩略图查看 GIF 播放顺序，添加自己的 GIF、删除或上下调整顺序；支持「全选现有表情」把当前形象某状态的全部 GIF 补回列表；还可多选/全选状态，让待机时轮播多个表情，并显示每张素材的实际路径。配置按形象分开保存。
- **小狗大小**：收起 / 展开缩放范围 **0.5–1.8 倍**，前端与原生窗口布局同步。
- **让小狗睡觉**：在悬停面板底部，一键缩到屏幕边缘。
- **任务栏托盘菜单**：右键任务栏小图标可选择 **显示小狗 / 配置桌宠 / 隐藏到托盘 / 退出 Maltese**。
- **桌宠右键**：直接打开聊天页；配置和隐藏统一收进托盘菜单，避免多层菜单误触。
- **睡眠缩边高度**：设置中可在 **24–140 px** 之间调整睡觉时露出的屏幕高度。
- **趴下睡觉的 GIF**：多久没动静自动趴下、缩到屏幕边缘、手动点「让小狗睡觉」都用这一张。默认跟随当前形象（小白睡着就是小白，小鸡毛就是小鸡毛），也可以在设置里换成自己的 GIF（≤ 8 MB），随时「恢复默认」。
- **全屏避让**：检测到游戏或视频全屏时自动缩边，退出后恢复；睡眠 / 全屏 / 手动缩边使用独立原因栈，不会互相抢状态。
- **显示 / 隐藏桌宠**：只保留一个全局快捷键，默认 `Ctrl+Alt+Shift+M`；按一次隐藏，再按一次显示，在设置页「互动」里可自行录入；支持开机自启。自启项每次启动都会校验，升级或换安装目录后会自动指向当前程序，不会再去拉旧路径。剪贴板不再单独占用快捷键。
- **桌面图标开关**：设置页「其他」里可一键隐藏 / 恢复桌面图标（当前桌面图标为隐藏状态时也能直接点回来）。
- **自动更新（OTA）**：启动后自动检查新版本并每 4 小时复查；发现更新时收起态弹气泡、展开态显示更新条，点击即可下载签名安装包、安装并重启。设置页保留手动检查入口。

### 快捷面板

- **插件中心**：B 站 / 抖音自动翻页作为内置插件，与第三方插件放在同一页；第三方插件只需一个含 `plugin.json` 的文件夹，可安装、停用、卸载和运行动作。卡片保持简洁，完整使用说明在悬停浮窗里查看。开发说明见 [`docs/plugins.md`](docs/plugins.md)。
- **快捷面板热键**：整个快捷入口面板共用一个系统级热键，按一次直接打开快捷方式面板，而不是逐个应用设置；点击热键按钮录制，右键清除。
- **快捷方式按用户生成**：默认只读取桌面，或只扫描你在快捷面板/设置里指定的一个目录；不再遍历开始菜单和 Program Files。自定义快捷方式保存在本机 `localStorage`，不会写进代码或分发。
- **商店应用也能搜到**：除桌面 / 开始菜单的 `.lnk`、`.exe` 外，还会读取 Windows 登记的应用清单（`Get-StartApps`），ChatGPT 这类只有执行别名、没有快捷方式的 Microsoft Store 应用现在能搜索、添加并启动。
- **快捷方式卡片**：只有拿到真实程序图标时才显示图标，不再用“哔 / 抖 / 链”这类单字大图标占位置；商店应用暂不显示图标。
- **点击反馈与启动速度**：快捷方式直接走 Windows ShellExecute（和资源管理器双击同一条路径），不再经过 `cmd.exe /C start`，少一次控制台进程启动、不闪黑框；点击后卡片立刻显示「正在启动…」和转圈，成功后提示里给出从点击到系统接受启动的耗时（毫秒）。
- **可调复位位置**：设置里可选底部居中 / 左上 / 右上 / 左下 / 右下，点「复位」回到设定位置。
- **豆包 / 网易云音乐 / 有道词典**：一键启动本机已安装的客户端。
- **计算器 / PowerToys / Geek Uninstaller / Clash / Watt**：常用系统与网络工具入口。
- **软件更新检测**：扫描已安装软件版本，提示可更新项。

### 待办、剪贴板与音乐

- **待办笔记本**：今日任务、每日笔记、历史归档与复盘，支持拖拽排序、Markdown 保存；未完成的待办每天原样保留，不会自动清掉。
- **剪贴板历史**：文本与图片记录，搜索、收藏、备注；从悬停气泡或快捷入口打开。
- **音乐**：读取 Windows 媒体会话，识别网易云 / QQ 音乐 / Spotify / 浏览器播放，显示歌名、歌手、专辑、封面与歌词，支持播放、暂停、切歌、音量、随机和循环。

### 消息提醒

- **QQ**：读取 Windows 通知；当 Toast 文本不完整时，遍历全部通知 binding 兜底拼接正文。
- **微信**：读取微信窗口左侧会话列表，显示最新会话的 **发送人 + 消息摘要**。
  - 使用 Windows 本机 OCR，只裁剪会话列表区域，图片只在内存中处理，不落盘、不上传。
  - **需要保持微信窗口非最小化**；最小化时 Windows 无法渲染窗口内容，会显示“正文不可用”的说明。
  - 可在微信来源右侧的 OCR 按钮或设置中关闭。
- **QQ 邮箱**：岛内阅读邮件正文并返回列表。

### 桌宠聊天（DSH / 本地模型）

- 展开面板切到 **聊天**，通过本机 DSH CLI 的 `headless` profile 对话；聊天会跟随当前形象，让小白、小鸡毛或两只小狗一起回应。
- **本地模型**：点击聊天右上角的模型设置，可切换到 Ollama / LM Studio / llama.cpp 等 OpenAI 兼容接口，填写服务地址和模型名即可；内容只在本机流转。
- 支持多轮会话、Enter 发送、Shift+Enter 换行、清空对话；聊天记录只保存在本机 `localStorage`。
- 自动探测 DSH CLI；也可用 `MALTESE_DSH_CLI` 指定 `dsh.cmd` 路径。
- headless 默认用桌面端登录的账号路由（`deepseek-account` + `deepseek-flash`），不需要另外配 `DEEPSEEK_API_KEY`；之前直接报 `MISSING_CREDENTIAL` 的情况已修掉。
- 选择「小白和小鸡毛」时，回复会分别以「小白：」「小鸡毛：」开头，让两只小狗各说一句；选择单只形象时使用对应性格。
- 实现与排错见 [docs/pet-chat.md](docs/pet-chat.md)。

### B 站 / 抖音自动翻页

- 点击 **开始刷视频** 后，用默认浏览器打开 B 站或抖音；人工登录后保持视频页在前台。
- 首次约 **6 秒** 后翻一次，之后按设置的间隔翻页；达到观看上限自动停止。
- 启动时捕获**同一个浏览器窗口**，即使抖音切到单个视频后标题不再包含“抖音”，也能继续翻页。
- 只有目标浏览器窗口在前台时才发送按键；切到其他窗口自动等待，**不抢焦点、不向其他应用发送 PageDown / 方向键**。
- 若一直等待，界面会显示当前前台窗口标题和进程名，点一下浏览器里的视频页即可。
- 支持 Chrome、Edge、Firefox、Brave、Vivaldi、Opera，以及 360、QQ、搜狗、猎豹、2345、Maxthon、UC 等常见 Windows 浏览器；也兼容抖音 / 哔哩哔哩桌面客户端。
- 需要本机已安装浏览器并手动登录；本项目不保存账号密码，也不绕过平台风控。

## 快速开始

### 环境要求

- Windows 10 / 11 x64
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 通常已自带）
- 从源码构建需要 Node.js 20+、pnpm、Rust stable 和 Visual Studio C++ Build Tools

### 运行发布版

1. 发布包只有一个 `maltese-assistant.exe`：WebView2Loader 已静态链接，不需要额外 DLL。
2. 双击 `maltese-assistant.exe`。
3. 小狗出现在桌面后：
   - 鼠标悬停：打开互动与快捷入口；
   - 单击：摸头；双击：庆祝；右键小狗：打开聊天；
   - 右键任务栏托盘图标：配置、隐藏或退出。

发布产物默认在 `release/<版本>/`。仓库不提交历史构建产物，避免仓库体积过大。

### 第一次运行：SmartScreen 提示怎么办

下载后双击如果出现 **「Windows 已保护你的电脑 / Microsoft Defender SmartScreen 阻止了无法识别的应用启动」**，发行者显示「发布者未知」，这不是病毒告警，而是因为发布包**没有代码签名证书**：每台机器第一次运行未签名的新文件，SmartScreen 都会拦一次。

**最省事的方式是用脚本安装**——PowerShell 下载不会写入「来自其他计算机」标记，也就不会触发 SmartScreen：

```powershell
irm https://raw.githubusercontent.com/maolouis/Maltese/main/scripts/install-latest.ps1 | iex
```

脚本会查最新版本、下载安装包、比对 `SHA256SUMS` 里的哈希、结束正在运行的旧实例，然后静默安装并启动。只想下载校验不安装可以加 `-CheckOnly`，想装便携版可以加 `-Portable`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-latest.ps1 -CheckOnly
```

如果仍然手动下载，按下面的方式放行：

1. 点提示框里的 **「更多信息」**，再点 **「仍要运行」**。
2. 如果文件是从浏览器下载后被标记为「来自其他计算机」，也可以先右键文件 → **属性** → 勾选最下面的 **「解除锁定」** → 确定，再双击；命令行等价写法是 `Unblock-File .\Maltese-assistant.exe`。
3. 用 zip 便携版时同理：解压后若仍被拦，对解压出来的 `Maltese-assistant.exe` 做一次「解除锁定」。

> **点了「仍要运行」却没反应？** 多半是已经有一个旧版 Maltese 在托盘里运行。它是单实例程序，新进程会把焦点交给旧实例然后自己退出，看起来就像没启动。先在托盘图标右键「退出」（或者 `Stop-Process -Name Maltese-assistant -Force`），再运行新版本；用上面的安装脚本则会自动处理。

想先确认文件没被篡改，可以核对哈希（和 Release 页 `SHA256SUMS-vX.Y.Z.txt` 对比）：

```powershell
Get-FileHash .\Maltese-assistant.exe -Algorithm SHA256
```

> 长期解决办法是给 exe 和安装包买代码签名证书（OV/EV）签名，签过之后发行者会显示你的名字，SmartScreen 也不会再对每个新版本弹「未知发布者」。自签名证书（openssl 生成的那种）不行：Windows 不信任它，只会更糟。有正式证书后本项目可以直接把签名接进发布流程。

### 从源码构建

```bash
pnpm install
pnpm dev                         # 只启动 Vite 前端预览
pnpm tauri dev                   # 完整开发模式
pnpm build                       # tsc + vite 前端构建
pnpm tauri build --no-bundle     # 编译 exe
pnpm tauri build --bundles nsis  # 编译 NSIS 安装包
```

或双击 `build-installer.bat` 一键打包。

### 配置微信正文预览

1. 打开 Maltese 的 **消息 → 微信**。
2. 保持微信主窗口打开且**不要最小化**。
3. 点击微信来源右侧的 OCR 按钮开启（默认开启）。
4. 收到新消息时，消息卡片显示“发送人 + 摘要”。

如果显示“正文不可用”，请先把微信窗口从最小化恢复；若仍失败，确认 Windows 已安装中文 OCR 语言包。

### 配置 DSH 聊天

1. 安装并登录 DeepSeek Harness，确认命令行可用。
2. 在 Maltese 的 **聊天** 页发送消息；后端会调用本机 DSH CLI。
3. 如果 CLI 不在默认位置，设置环境变量：

```powershell
$env:MALTESE_DSH_CLI = "D:\path\to\dsh.cmd"
```

4. 如需要自定义 headless 凭据 patch，可设置 `MALTESE_DSH_CHAT_PATCH`；不设置时使用应用数据目录下的自动生成文件。
5. DSH CLI 的路径、会话和限制详见 [docs/pet-chat.md](docs/pet-chat.md)。

### 使用刷视频

1. 打开 **聊天旁边的「看视频」**（悬停气泡或顶部导航均可）。
2. 选择 B 站或抖音，设置翻页间隔（15–600 秒）和观看上限（1–240 分钟）。
3. 点击开始，浏览器会自动打开目标站点。
4. 在浏览器里登录并点一下视频页，让浏览器成为前台窗口。
5. 等待约 6 秒开始自动翻页；切到其他窗口会暂停，回到目标窗口后继续。
6. 点击停止即可结束。

## 技术栈

- 前端：React 19 + TypeScript + Vite 7，lucide-react 图标
- 桌面壳：Tauri 2（Rust）
- 原生：Win32 API（窗口定位、全屏检测、媒体会话、注册表、PrintWindow + Windows OCR）
- 包管理：pnpm
- 字体：Fusion Pixel Font（SIL Open Font License 1.1）

## 项目结构

```text
src/                     React 前端（App.tsx 为岛/桌宠主界面）
src-tauri/src/           Rust 后端（窗口、通知、OCR、DSH、视频自动化）
public/assets/pets/      线条小狗 GIF 素材（chars/ 下按小白、小鸡毛、双狗分目录）
docs/                    功能说明、兼容性与发布文档
docs/chat-history/       从旧会话日志还原的对话记录
scripts/                 构建、发布与 Agent 钩子脚本（含素材清单生成与聊天记录还原）
```

## 参考与致谢

Maltese 在设计和实现过程中参考了以下开源项目。感谢作者与贡献者：

| 项目 | 作者 | 在本项目中的参考 |
| --- | --- | --- |
| [fly-island](https://github.com/flyl1u/fly-island) | [@flyl1u](https://github.com/flyl1u) | 基础工程与待办、媒体会话、剪贴板、QQ/微信提醒、更新检测、窗口定位等能力；本项目在其基础上改造，原项目为 MIT License。 |
| [LineDogPet](https://github.com/Mrjiumeng/LineDogPet) | [@Mrjiumeng](https://github.com/Mrjiumeng) | 线条小狗角色、GIF 状态素材与互动设计。美术版权归原作者所有，仅学习交流使用，禁止商用。 |
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | [@PC2005-cloud](https://github.com/PC2005-cloud) | 桌面宠物独立模式、状态分层、拖拽/点击互动与桌宠控制面板的设计思路。 |
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | [@c1overzz](https://github.com/c1overzz) | B 站自动翻页、本机有窗口浏览器与人工登录的组织方式参考。 |
| [dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) | [@LockyBee](https://github.com/LockyBee) | 抖音自动翻页与观看时段/上限的设计思路参考。 |
| [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font) | [@TakWolf](https://github.com/TakWolf) | 像素中文字体，按 SIL Open Font License 1.1 使用。 |

以上参考项目仅用于学习与设计借鉴；各项目代码、素材和字体的版权归各自作者所有，使用时请遵守对应许可证。

## License

本项目代码采用 [MIT License](LICENSE)。线条小狗美术素材不适用 MIT License，禁止商用。
