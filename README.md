<div align="center">
  <img src="assets/pets/linedog-logo.png" alt="Maltese logo" width="96" height="96">

  <h1>Maltese</h1>
  <p><sub>线条小狗桌面助手</sub></p>

  <p>一只住在 Windows 桌面上的线条小狗：陪聊、管待办、记剪贴板、控制音乐、提醒 QQ/微信消息，还能帮你刷 B 站和抖音。</p>

  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-2.0.6-orange">
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
    <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB">
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  </p>
</div>

## 这是什么

Maltese 是一个基于 **Tauri 2 + React 19 + Rust** 的 Windows 桌面宠物助手。它用一条线条小狗常驻桌面，把待办、剪贴板、音乐、消息提醒、翻译、常用工具和 AI 聊天集中到一个轻量面板里。

所有感知与消息预览都在本机完成；不内嵌第三方登录页，不把聊天内容、剪贴板或通知文本上传到服务器。消息提醒只保留「有新消息」信号，不读取也不显示聊天正文。

## 📖 使用手册

> 第一次用：先看 **安装与升级** 和 **运行发布版**；哪里不对：直接跳到 **常见问题与排障**。
> 每条都写了「什么时候该看它」，不用从头读。

- **安装与升级** → [docs/releases/v2.0.4.md](docs/releases/v2.0.4.md)：想装、想升级、要分安装包 / 便携版 / 插件，或要核对 SHA-256 时看；下载后被 SmartScreen 拦住也看这里。
- **聊天 / 记忆 / 自我状态** → [docs/pet-chat.md](docs/pet-chat.md)、[docs/pet-vitals-usage.md](docs/pet-vitals-usage.md)：聊天没反应、想换本地模型、想关掉表情轮播或「体力 / 情绪 / 亲密 / 专注」时看。
- **视频插件（小狗刷视频）** → [docs/video-plugin-usage.md](docs/video-plugin-usage.md)：第一次用刷视频、要登录、想看小结、评论没发出去时看。
- **小红书采集与图文草稿** → [docs/video-plugin-xiaohongshu.md](docs/video-plugin-xiaohongshu.md)：想只读采集小红书、让小狗写图文草稿、确认「能不能自动发布」时看；可行性结论在 [docs/research-xiaohongshu.md](docs/research-xiaohongshu.md)。
- **多屏 / 窗口几何** → [docs/pet-multi-monitor.md](docs/pet-multi-monitor.md)：小狗跑到副屏、切屏后位置不对、窗口大小 / 任务栏挡住它时看。
- **两只小狗的联动** → [docs/pet-linkage-usage.md](docs/pet-linkage-usage.md)：**当前已下线**（feature flag 关闭，设置里看不到入口）；想知道它原本怎么用、为什么关、什么时候回来时看。
- **Agent 控制台** → [docs/agent-hub.md](docs/agent-hub.md)：想把本机 Codex / Claude 等 agent 接进桌宠、看任务列表和 Token 卡片时看。
- **数据目录与迁移** → [docs/data-directory-plan.md](docs/data-directory-plan.md)：想知道数据存在哪、怎么换到别的盘（`data-dir.txt`）、重装后数据还在不在时看。
- **常见问题与排障** → [docs/diagnostics/startup-hang-playbook.md](docs/diagnostics/startup-hang-playbook.md)（冷启动卡死 / 双击没反应）、[docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md)（快捷键不生效）：出问题先按这两份自查。
- **待办进度** → [docs/TODO.md](docs/TODO.md)：想知道某个问题修到哪一步、哪些还没做时看。

## 正在研发

> 完整清单、影响与文档入口见 [docs/TODO.md](docs/TODO.md)。

- **窗口几何单一真值收敛（进行中）**：双击小狗向左上角闪动、首开 5px 残差、切页签抖动与窗口边缘拖拽缩放均已修复落地；底层多状态向单一 `DogSlot` 状态机的终态收敛持续推进中。
- **小红书评论自动提交（已修复待线上复验）**：已修复发送按钮类名正则、「发 送」空格文案及快捷键清空判定，待安静窗口线上实测确认。
- **B 站自动评论受账号限制**：站点返回「账号未转正（-107）」，面板会给出原因，本机不会绕过风控。
- **混合 DPI 多屏实机验证**：跨缩放比恢复物理尺寸已补齐，待 100% + 150% 物理双屏环境实测。
- **实例联动暂时下线**：`PET_LINK_ENABLED=false`（设置里隐藏入口），架构稳定后再重新开放。

## 功能一览

### 桌宠与快捷操作

- **线条小狗**：素材库里的 GIF 全部可在「表情轮播」里选（分组与张数以设置页「表情轮播」顶部数字为准，或跑 `node scripts/build-pet-manifest.mjs` 生成清单）；其中双狗同框素材**只在「小白和小鸡毛」形象下可选**。素材库按内容 sha256 去重（同一张图只保留一份、内容没少）；白底素材做过透明化修复（工作区改动，等验收后再写结论）。设置页「表情轮播」只显示数字口径（总数/分组/本表情可选），详细说明见 [`docs/pet-characters.md`](docs/pet-characters.md)；主狗、陪玩狗和跟随狗都会动。单击切换下一张表情、双击打开互动气泡、右键打开聊天、按住左键直接拖动。
- **互动场景**：手动摸头会触发单角色轻跳，陪玩、追球、庆祝和模型主动聊天会触发双狗、分身或道具互动；场景有独立生命周期，进入面板、缩边或睡觉时会清理。宠物说话气泡只显示正文，系统通知保留来源标题，情绪由现有 GIF 和互动场景表达。实现细节见 [`docs/pet-interactions.md`](docs/pet-interactions.md)。
- **三个形象**：设置里可切「小白」「小鸡毛」「小白和小鸡毛」。前两者各播自己的素材，并按「每 3 张插 1 张」混播双狗同框图；选「小白和小鸡毛」时只播同框素材。素材说明见 [`docs/pet-characters.md`](docs/pet-characters.md)。
- **小狗的自我状态**：体力 / 情绪 / 亲密 / 专注 4 个隐藏数值随互动与时间变化，**只影响待机时轮播哪张表情**——权重表覆盖全部 25 个可轮播表情（累了更容易趴下睡/休息、开心更容易蹦、亲密更容易黏人、专注更像在陪你做事、情绪低更常求摸摸/探头，哭脸只有极低情绪的小概率），默认开启、可一键关闭；体力采用宽松策略（初始 85、下限 30、半衰期 18h、陪玩同样温和回体力、在线睡觉持续回血、≥65 即「很有精神」），日常轻度互动即可稳定维持高体力。数值与最近互动类型（不含聊天正文）也会作为上下文交给聊天/主动消息，聊天表情包兜底也用同一张权重表。说明见 [`docs/pet-vitals-usage.md`](docs/pet-vitals-usage.md) 与 [`docs/pet-characters.md`](docs/pet-characters.md)。
- **可指定小狗 / Bongo 在副屏**：设置 →「所在屏幕」里给小狗和 Bongo 分别选主屏 / 副屏 N / 跟随上次位置；锚点、锁角、贴边都按所选屏的工作区算，DPI 用那块屏自己的缩放，改完即时生效。副屏被拔掉会自动回主屏并提示「副屏已断开，已回到主屏」，插回来自动回去。说明见 [`docs/pet-multi-monitor.md`](docs/pet-multi-monitor.md)。
  **「固定在桌面的标签页」（📌）跟随同一块屏**：设置里切屏、拔屏/插回都会一起移动（隐藏中只更新下次显示的位置）；固定页不进任务栏（没有灰框），关掉方式见 [`docs/pet-multi-monitor.md`](docs/pet-multi-monitor.md) §8。
- **顶部标签方向键切换**：面板展开后，用 ↑ ↓ ← → 就能在 待办 / 音乐 / 剪贴板 / 快捷入口 / 聊天 / 插件 之间翻页；光标在输入框里时不拦截。
- **Bongo 模式**：小狗趴在键盘上，按下的键会切到对应“爪子落点”的帧。默认位置可选 **底部居中 / 左下 / 右下 / 顶部居中**，开机后自动出现，不用先关再开。
- **云朵气泡**：消息、待办开始、剪贴板提示都用云朵气泡显示；Tauri 下改为独立预热的透明 `bubble` 窗口承载悬停面板与云朵气泡（高度按内容自动伸缩，靠右放不下时自动翻到左侧并翻转尾巴），主窗口不再为了弹气泡而放大/挪动，从根源消除双击时小狗向左上角重影闪动；实现细节见 [`docs/pet-overlay-geometry.md`](docs/pet-overlay-geometry.md)。
- **自动切换表情 / 行为气泡开关**：设置 →「动画切换频率」（高频 5 秒 / 中频 10 秒 / 低频 20 秒）已接入待机轮播，单击手动切表情后不再锁死自动切换；「感知与陪伴」（或独立设置窗口「陪伴与感知」）里可以关掉自动轮播，也可以关掉前台程序、时间、音乐、剪贴板、整点的行为气泡。
- **Strata 监控脚本配色**：F:\Strata\bin\monitor-qwen36.ps1 现在显式带主题（默认 dark）并打开控制台 ANSI，-Theme light / -Theme terminal 可切换，不再是一屏无色的 TUI。
- **模型主动聊天**：可让本机聊天后端观察前台程序 / 音乐 / 闲置时间，主动说一句关心，**弹出云朵聊天气泡**并写进聊天记录（默认关闭）。提示词参考《亲爱的小狗》的设定，让白色马尔济斯小白保持安静细心，让金黄色小鸡毛保持活泼亲近，两只一起时保留一静一动的默契。支持两种模式：**定时**（每隔 5–240 分钟说一次）和**跟随状态**（前台程序类型、播放状态、是否离开电脑发生变化且稳定 3 分钟后才说，最短间隔做冷却，同一个情境只说一次）。只在挂机（收起态）时说，面板展开或正在聊天时自动跳过；模型未配置或调用失败时用按形象准备的本地兜底台词，保证气泡照常出现。
- **自定义音效**：「开启音效」下可选本机 wav / mp3 / ogg / m4a（≤ 2 MB）替换内置叫声，支持试听和恢复默认。
- **双击互动气泡**：双击小狗弹出云朵面板，可直接摸头、挠下巴、抱抱、转圈、陪玩、躲猫猫、追球、喂食、睡觉、生气、委屈、比心、兜风、泡澡、装扮，以及打开 **待办、音乐、剪贴板、聊天、消息、快捷入口**。
- **表情轮播设置**：设置窗口（或岛内展开浮层 →「设置」页签）里只有「表情轮播」方格网格：按缩略图查看播放顺序，**按住方格拖动即可排序**（鼠标、触摸屏、手写笔都支持；向下拖插入线在目标格右侧、向上拖在左侧，松手即写回配置），右键或悬停时右上角的按钮删除，也可以添加自己的 GIF、「全选现有表情」把当前形象某状态的全部 GIF 补回列表、或一键恢复默认顺序；配置按形象分开保存；这一栏可以收起（默认收起，展开状态会记住，按钮文案带张数）。待机轮播范围默认仍包含全部表情、合并规则不变，只是设置页不再显示「轮播范围」面板。
- **小狗大小**：收起大小缩放范围 **0.5–3.0 倍**（展开面板 **0.5–1.8 倍**），前端、随从宠与原生窗口布局同步。
- **聊天面板**：聊天面板采用统一展开高度，右键小狗直接打开并自动聚焦输入框（支持中文输入法合成期保护与仅发图片，本地模型自动绕过系统代理直连环回端口）；支持直接 `Ctrl+V` 粘贴图片（最多 4 张，自动压缩），并用 KaTeX 渲染行内/块级公式与代码块（`$...$`、`$$...$$`、`\(...\)`、`\[...\]`）。
- **动手模式**：聊天里说「帮我记个待办」这类话，小狗会调用本机技能真的去做（记/看待办、打开应用与网址、控制音乐、读写剪贴板、看时间），执行结果在气泡下方显示；技能面板可开关内置技能、添加自定义技能，并登记 / 导出 MCP 服务器配置。
- **让小狗睡觉**：在悬停面板底部，一键缩到屏幕边缘。
- **任务栏托盘菜单**：右键任务栏小图标可选择 **显示小狗 / 配置桌宠 / 隐藏到托盘 / 退出 Maltese**。
- **桌宠右键**：直接打开聊天页；配置和隐藏统一收进托盘菜单，避免多层菜单误触。
- **睡眠缩边高度**：设置中可在 **24–140 px** 之间调整睡觉时露出的屏幕高度。
- **趴下睡觉的 GIF**：多久没动静自动趴下、缩到屏幕边缘、手动点「让小狗睡觉」都用这一张。默认跟随当前形象（小白睡着就是小白，小鸡毛就是小鸡毛），也可以在设置里换成自己的 GIF（≤ 8 MB），随时「恢复默认」。
- **显示 / 隐藏桌宠**：只保留一个全局快捷键，默认 `Ctrl+Alt+Shift+M`；按一次隐藏，再按一次显示，在设置页「互动」里可自行录入；支持开机自启。自启项每次启动都会校验，升级或换安装目录后会自动指向当前程序，不会再去拉旧路径。剪贴板不再单独占用快捷键。注册被占用时会后台重试，更新后不用手动重启。
- **隐藏一起收**：用显示 / 隐藏快捷键、托盘隐藏或面板上的收起按钮隐藏桌宠时，Bongo、陪伴狗和跟随鼠标的小狗会一起消失；重新显示时按原配置一并放回来。
- **收起面板快捷键**：另一个可录制全局快捷键，默认 `Ctrl+Alt+Shift+C`，展开面板时按一下直接收回成小狗；在设置窗口「互动」里改键，被占用时会回滚提示，并会后台重试；和「显示 / 隐藏桌宠」用同一个组合键会被拦下。
- **桌面图标开关**：设置页「其他」里可一键隐藏 / 恢复桌面图标（当前桌面图标为隐藏状态时也能直接点回来）。
- **桌面图标台球**：装上 `billiards.zip` 插件后，插件页点「打开」就能和小狗开一局——把桌面图标当成台球，拉杆蓄力、松手击球、反弹辅助线、碰撞圈预估、碰撞入袋，小狗在旁边跟着白球加油。桌面图标不足 15 个时由覆盖层补虚拟球，不会重复搬动真实图标；清台后显示 S/A/B/C 段位、本局用时和最近 20 局平均用时。玩法参考开源项目 [desktop-icon-billiards](https://github.com/liuxiaogang-com/desktop-icon-billiards)（作者 GitHub@liuxiaogang-com，MIT）；只有点「开始这一局」才会搬动真实图标，退出立即恢复原位置，应用启动/退出、窗口挂载都不会碰桌面。
- **主动程度可调（0–100）**：一个滑块同时决定冷却时间、每小时上限、状态模式稳定时长与免打扰时段，设置里实时显示「大约每 X 分钟最多一次、每小时不超过 Y 次」。- **自动更新（OTA）**：启动后自动检查新版本并每 4 小时复查；发现更新时收起态弹气泡、展开态显示更新条，点击即可下载签名安装包、安装并重启。设置页保留手动检查入口。

### 快捷面板

- **插件中心**：应用默认不预置任何插件，插件中心初始为空；每个插件打成一个独立 zip（`billiards` / `video-automation` / `relationship` / `hello-world`），把 zip 或文件夹路径粘进插件中心点「安装插件」即可，支持停用、卸载和运行动作。卡片保持简洁，完整使用说明在悬停浮窗里查看。开发说明见 [`docs/plugins.md`](docs/plugins.md)。
- **快捷面板热键**：整个快捷入口面板共用一个系统级热键，按一次直接打开快捷方式面板，而不是逐个应用设置；点击热键按钮录制，右键清除。
- **搜索应用直接打开**：面板最上方就是应用搜索框，用面板热键打开后**自动聚焦、可以直接打字**（窗口聚焦时会补抢焦点），输入软件名后 **↑ / ↓** 在结果里切换、**Enter** 打开选中的软件、**Esc** 清空；鼠标悬停会同步高亮。点结果按钮仍然是把它加进快捷入口，不会误打开。
- **常用脚本可靠启动**：快捷入口中的 `.cmd` / `.bat` 用带 `/d /c call` 的 `cmd.exe` 执行，`.ps1` 用 PowerShell，`.py` 先用 `py.exe`，没有 Python Launcher 时回退 `python.exe`；所有脚本都使用脚本所在目录作为工作目录，带空格的路径也能运行。
- **快捷方式按用户生成**：默认只读取桌面，或只扫描你在快捷面板/设置里指定的一个目录；不再遍历开始菜单和 Program Files。自定义快捷方式保存在本机 `localStorage`，不会写进代码或分发。
- **商店应用也能搜到**：除桌面 / 开始菜单的 `.lnk`、`.exe` 外，还会读取 Windows 登记的应用清单（`Get-StartApps`），ChatGPT 这类只有执行别名、没有快捷方式的 Microsoft Store 应用现在能搜索、添加并启动。
- **快捷方式卡片**：只有拿到真实程序图标时才显示图标，不再用“哔 / 抖 / 链”这类单字大图标占位置；商店应用暂不显示图标。
- **点击反馈与启动速度**：普通快捷方式直接走 Windows ShellExecute（和资源管理器双击同一条路径），脚本入口使用对应解释器并复用脚本目录；点击后卡片立刻显示「正在启动…」和转圈，成功后提示里给出从点击到系统接受启动的耗时（毫秒）。
- **快捷方式拖动排序**：按住卡片左右拖动即可调整先后顺序（位移超过 8 px 才进入拖动，拖完不会误触启动）；顺序按卡片存进本机 `localStorage`（工具卡记 `tool:<id>`、快捷方式记规范化路径），下次打开保持。
- **全屏避让**：检测到游戏或视频全屏时按设置处理（缩边 / 隐藏 / 不处理），退出后恢复。Bongo 是单独一档开关「全屏时 Bongo 也收起来」，与主狗的避让方式互不影响（即使主狗选「不处理」，也可以只让 Bongo 全屏时消失）；另一个开关「全屏时连陪伴狗 / 跟随小狗一起隐藏」只影响 4 只陪伴狗和跟随鼠标的小狗。睡眠 / 全屏 / 手动缩边使用独立原因栈，不会互相抢状态。细节见 [`docs/fullscreen-avoid.md`](docs/fullscreen-avoid.md)。
- **小狗自主刷视频**：可创建小狗自己的 B 站 / 抖音账号档案，使用独立浏览器 profile 登录后看推荐流，按观看时长、回看、点赞、收藏等信号判定兴趣，整理小结和运营日志草稿。CDP 断线、浏览器关闭和页面卡死会有界重连并结束本轮，不会一直显示运行中。可在当前视频页由你手动点击发送评论；开启自动评论权限后，会读取当前聊天设置选择的 DSH 或本地模型，让模型根据视频标题、简介、作者和标签生成一条评论。自动评论默认只预演，不会发送；关闭预演后才会提交并回读验证，模型不可用时不会发送模板评论。默认不会自动关注或点赞。详见 [`docs/video-automation.md`](docs/video-automation.md)。
- **可调复位位置**：设置里可选底部居中 / 左上 / 右上 / 左下 / 右下，点「复位」回到设定位置。小狗可以往上或往下拖到屏幕边缘外（拖拽改成按光标位移移动窗口，不再受系统标题栏拖拽的上边缘限制）。
- **豆包 / 网易云音乐 / 有道词典**：一键启动本机已安装的客户端。
- **计算器 / PowerToys / Geek Uninstaller / Clash / Watt**：常用系统与网络工具入口。
- **软件更新检测**：扫描已安装软件版本，提示可更新项。

### 待办、剪贴板与音乐

- **待办笔记本**：今日任务、每日笔记、历史归档与复盘，支持拖拽排序、Markdown 保存；未完成的待办每天原样保留，不会自动清掉。
- **剪贴板历史**：文本与图片记录，搜索、收藏、备注；从悬停气泡或快捷入口打开。
- **音乐**：读取 Windows 媒体会话，识别网易云 / QQ 音乐 / Spotify / 浏览器播放，显示歌名、歌手、专辑、封面与歌词，支持播放、暂停、切歌、音量、随机和循环。音乐卡综合系统播放类型、浏览器来源和前台窗口类型判断「音乐 / 视频」：浏览器看视频时不拉歌词、不切到「听歌」表情、也不说「正在听」；浏览器里放有歌手的音乐仍正常显示歌词。

### 多只小狗的互动（实例联动）

- 打开「实例联动」后，小白和小鸡毛会**互相接话**：摸头/喂食/主狗开心时随从会接一句，
  Bongo 敲击时主狗摇尾巴回应，台词按人设分开、有先后、最近几句不重复。
- 最快体验：设置 → 实例联动 → 点 **「试一下联动」**（3 秒演示，不改你的设置）。
- **默认触发场景**：摸头 / 喂食 / 主狗开心 / Bongo 敲击（久坐、夜间、回归也会触发，但条件更特殊）；每对台词都是「小鸡毛先说、小白后应」，每场景 6 组轮换不重复。
- 完整操作说明（怎么开、怎么触发、能看到什么、常见问题）见
  [docs/pet-linkage-usage.md](docs/pet-linkage-usage.md)。

### 消息提醒

> **隐私设计：只提醒，不显示文字。** 不截屏、不做 OCR、不读取聊天内容；
> 事件、日志和本地存储里都不会出现发送人或正文，Windows 通知文本只在
> Rust 侧用于判断「是不是新通知」。详细结论见
> [docs/research-wechat-qq-message-source.md](docs/research-wechat-qq-message-source.md)。

- **QQ**：读取 Windows 通知的**条数与到达时间**；`GetAccessStatus=Denied` 时界面显示「通知权限被拒绝」并给出授权/设置入口。
- **微信**：通过任务栏闪烁（`HSHELL_FLASH`）判断「有新消息」，只显示「微信有新消息 + 时间」。
- **QQ 邮箱**：岛内阅读邮件正文并返回列表（邮件是用户主动打开的，不属于本限制）。

### 桌宠聊天（DSH / 本地模型）

- 展开面板切到 **聊天**，通过本机 DSH CLI 的 `headless` profile 对话；聊天会跟随当前形象，让小白、小鸡毛或两只小狗一起回应。
- **本地模型**：点击聊天右上角的模型设置，可切换到 Ollama / LM Studio / llama.cpp / Strata 等 OpenAI 兼容接口。接口地址与模型名**默认留空**，点预设按钮或手动填写；选 Strata 时地址是 `http://127.0.0.1:8080/v1`，设置里可以直接按 Qwen3.6 配置启动 Strata、调整输出长度、温度、Top-P、思考和流式输出。桌宠支持本地图片输入，Strata 的视觉编码器使用 CPU 模式以保留显存；内容只在本机流转。
- 支持多轮会话、Enter 发送、Shift+Enter 换行、清空对话；聊天记录只保存在本机 `localStorage`。
- **状态与可取消**：聊天分「加载中 / 排队中 / 已开始输出」三态并各有时长上限（排队 240s、输出空窗 45s、总上限 300s）；「停止生成」三个阶段都能取消，不会在后台偷偷出结果或写入半句记录。
- **表情包消息**：模型输出 `<sticker:…>` 时拆成一条独立表情包消息（约 150px，点击放大、Esc 关闭）；没有标记且体力偏低时按自我状态权重挑一个安静表情兜底。聊天头部状态栏在数值缺失时用默认值兜底显示，不会整行消失。
- **头像**：小狗每条回复左边都带当前形象的头像（小白 / 小鸡毛 / 两只一起各一张，`assets/pets/avatars/`），切形象即时跟着换。
- 自动探测 DSH CLI；也可用 `MALTESE_DSH_CLI` 指定 `dsh.cmd` 路径。
- headless 默认用桌面端登录的账号路由（`deepseek-account` + `deepseek-flash`），不需要另外配 `DEEPSEEK_API_KEY`；之前直接报 `MISSING_CREDENTIAL` 的情况已修掉。
- 选择「小白和小鸡毛」时，回复会分别以「小白：」「小鸡毛：」开头，让两只小狗各说一句；选择单只形象时使用对应性格。
- **故事化语气**：聊天会参考《亲爱的小狗》中白色马尔济斯与金毛在四季日常里的陪伴、默契和小小幸福。小白先观察再轻声回应，小鸡毛更活泼黏人，两只一起时保持一静一动的配合。
- 实现与排错见 [docs/pet-chat.md](docs/pet-chat.md)。

### B 站 / 抖音自动翻页

- 点击 **开始刷视频** 后，用默认浏览器打开 B 站或抖音；人工登录后保持视频页在前台。
- 首次约 **6 秒** 后翻一次，之后按设置的间隔翻页；达到观看上限自动停止。
- 启动时捕获**同一个浏览器窗口**，即使抖音切到单个视频后标题不再包含“抖音”，也能继续翻页。
- 只有目标浏览器窗口在前台时才发送按键；切到其他窗口自动等待，**不抢焦点、不向其他应用发送 PageDown / 方向键**。
- 若一直等待，界面会显示当前前台窗口标题和进程名，点一下浏览器里的视频页即可。
- 支持 Chrome、Edge、Firefox、Brave、Vivaldi、Opera，以及 360、QQ、搜狗、猎豹、2345、Maxthon、UC 等常见 Windows 浏览器；也兼容抖音 / 哔哩哔哩桌面客户端。
- 需要本机已安装浏览器并手动登录；本项目不保存账号密码，也不绕过平台风控。

## 桌宠形象预览

素材现在装在安装目录的 `resources/assets/pets`，下面是仓库里的几段：

| 待机 | 开心 | 睡觉 |
| --- | --- | --- |
| ![待机](assets/pets/idle.gif) | ![开心](assets/pets/happy.gif) | ![睡觉](assets/pets/rest.gif) |

| 吃饭 | 庆祝 | 被摸头 |
| --- | --- | --- |
| ![吃饭](assets/pets/eat.gif) | ![庆祝](assets/pets/celebrate.gif) | ![摸头](assets/pets/pet.gif) |

按形象分目录（`assets/pets/chars/xiaobai|xiaojimao|shared/<动作>/*.gif`），
新增或替换素材后跑 `node scripts/build-pet-manifest.mjs` 重新生成清单。
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

### 配置消息提醒（只提醒，不显示文字）

1. 打开 Maltese 的 **消息 → 微信 / QQ**，在设置里打开「实例联动」以外的两个提醒开关（默认已开）。
2. 微信：保持微信登录并在本机运行即可，不需要保持窗口不最小化——插件只看任务栏闪烁。
3. QQ 首次使用需要在「设置 → 消息提醒 → 打开权限设置」里授予 Windows 通知访问权限；
   被拒绝时界面会显示「通知权限被拒绝」。
4. 收到新消息时，卡片只显示「微信有新消息 + 时间」「QQ 通知 + 时间」，不会出现发送人/正文。
5. 设置里的「显示消息预览」默认关闭，只控制「来源 + 有新消息」这类通用提示的展示；
   本版本不读取聊天内容（OCR 已移除），即使打开也不会出现正文。

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

1. 打开插件中心里的 **小狗刷视频**（安装 `video-automation.zip` 后可用）。
2. 选择 B 站或抖音，设置翻页间隔（15–600 秒）、观看上限（1–240 分钟）、采集间隔（1–5 秒）和每天最多投递次数。
3. 首次使用点 **打开登录窗**，在小狗专用浏览器里登录一次；之后窗口不会再被提到前台。
4. 点 **开始看**。小狗用独立 profile 看推荐流，你可以继续做别的事。
5. 到时长或条目上限后，小狗会整理小结；只有你离开电脑（空闲 ≥120 秒）、不在全屏/会议/游戏里，才会通过聊天和气泡打扰你。
6. 主动程度设为 0 时不会弹气泡，小结留在「待投递」里，随时可以在面板查看。
7. 数据只在本机：不读取 Cookie、不上传；清空入口默认保留登录 profile。

抖音适配目前标记为实验特性；遇到验证码会立即停止，不会尝试绕过。

## 工程结构与重构（v0.2.0 起）

- **前端分离**：桌宠素材已移出 PE（`assets/pets` → 安装目录 `resources/assets/pets`）；
  另提供 `src-tauri/tauri.external-web.conf.json` overlay，可把 JS/CSS/字体也外置到
  `resources/web`，由 `web_protocol.rs` 通过 `http://maltese.localhost/...` 提供；
- **单模块预算**：`App.tsx` 只允许持平或缩小（当前 9161 行），其余模块 ≤900 行，由
  `node scripts/verify-architecture.mjs` 守护；设置控件已拆到 `src/uiControls.tsx`；
- **功能不减少**：`node scripts/verify-parity.mjs` 用 17 项能力锚点核对重构前后功能面；
- 分层、拆分路线、脚本清单见 [docs/architecture.md](docs/architecture.md)，
  打包与分发约束见 [docs/distribution.md](docs/distribution.md)。
## 技术栈

- 前端：React 19 + TypeScript + Vite 7，lucide-react 图标
- 桌面壳：Tauri 2（Rust）
- 原生：Win32 API（窗口定位、全屏检测、媒体会话、注册表、任务栏闪烁监听）
- 包管理：pnpm
- 字体：Fusion Pixel Font（SIL Open Font License 1.1）

## 项目结构

```text
src/                     React 前端（App.tsx 为岛/桌宠主界面）
src-tauri/src/           Rust 后端（窗口、通知、DSH、视频自动化）
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

> 数据默认存在安装目录 data\（便携布局）；安装目录只读（如 Program Files）时自动回退到 %LOCALAPPDATA%\com.maolouis.maltese\data，可用 MALTESE_DATA_DIR 覆盖。
