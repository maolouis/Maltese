# Maltese 桌面助手实施计划

## 目标

在 Windows 上交付一个像 LineDogPet 一样直接摆在桌面的线条小狗助手，保留原有待办、音乐、消息、剪贴板和翻译能力，补充状态动画、自动发现入口、视频自动观看与本机 DSH API。

## 已确认的可复用能力

- `fly-island`：待办、媒体会话控制、剪贴板历史、QQ/微信提醒、更新检测、翻译窗口、开机自启和窗口定位逻辑。
- `PC2005-cloud/dsh-pet`：桌面宠物独立模式、动作素材、状态分层、拖拽/点击互动和桌宠控制面板。
- `c1overzz/dsh-bili-scroll` 与 `LockyBee/dsh-douyin-agent`：本机有窗口浏览器、人工登录、观看时段/上限、自动换片和本机 API 的组织方式。
- `LineDogPet`：线条小狗 GIF 资源、桌宠状态和交互素材。
- `Folia`：通过 Windows Media Session 控制音乐播放器的思路，直接复用 `fly-island` 已实现的媒体控制层。
- `dsh-pet`：将外部事件归一为语义状态，再映射到动画；桌宠状态与业务逻辑分离。

## 交付分层

### 第一阶段：可运行 MVP

- 建立 `E:\Maltese` 独立 Tauri 工程。
- 线条小狗状态皮肤：空闲、听歌、工作、需要关注，以及摸头、喂食、抱起、挥手、趴下、吓一跳、庆祝等 LineDogPet 互动动作。
- 支持点击摸头、双击庆祝、右键抱起；快捷面板提供动作按钮，动作结束后自动回到系统状态动画。
- 复用待办、音乐、剪贴板、消息、翻译、窗口定位、开机自启。
- 新增 Maltese 快捷面板：豆包、网易有道、Clash/Watt、计算器、PowerToys、常用脚本、Geek。
- 添加本地应用启动命令和快捷键冲突提示。

### 第二阶段：本机集成增强

- 豆包余额：支持配置本地/远端余额接口，保留手动刷新和脱离接口的降级状态。
- 网易有道：支持应用 ID/密钥配置，优先走有道 API；无密钥时保留本地配置提示。
- 常用脚本目录扫描与快捷启动。
- 版本更新检测与安装路径探测。

### 第三阶段：体验与发布

- 全屏检测和工作时自动缩边。
- 全局唤醒快捷键的注册、冲突检测与可视化配置。
- 首次运行向导、资源导入、安装包和桌面快捷方式。

## 验证

- `pnpm build`
- `pnpm tauri build --no-bundle`
- Windows 实机检查透明窗口、托盘、开机自启、拖动定位、媒体控制和快捷入口。

## 当前进度（2026-11-03）

- [x] 第一阶段工程复制与 Tauri 配置改名。
- [x] LineDogPet 状态素材接入，增加摸头、双击庆祝、右键抱起和快捷动作栏。
- [x] 快捷面板与豆包余额接口配置入口。
- [x] 本地计算器、Clash、Watt、PowerToys、Geek、常用脚本启动命令。
- [x] 扫描 `C:\Users\Administrator\Desktop\常用脚本` 下的 `.bat/.cmd/.ps1/.py/.lnk` 并支持直接启动。
- [x] 有道智云 v3 文本翻译签名与 Windows 凭据保存。
- [x] 全局 Maltese 唤醒快捷键与冲突检测，默认 Ctrl+Alt+M，可在快捷面板直接录入。
- [x] 收起态改为 LineDogPet 式桌宠本体，展开态改为文字标签导航。
- [x] 主窗口改为不透明小桌宠窗口，右键小狗打开配置、快捷入口、睡觉和托盘菜单。
- [x] 自动扫描桌面、开始菜单、常见安装目录和脚本目录；豆包只有找到本地桌面端时才显示。
- [x] 增加 B 站/抖音自动翻页状态机、观看上限和手动开始/暂停。
- [x] 提供本机 DSH API：`http://127.0.0.1:3218`。
- [x] 表情包素材扩充：从 LineDogPet 小白角色复制 64 个变体 GIF，按状态分目录（`public/assets/pets/<state>/`），`src/petAssets.ts` 提供随机选取；切换状态时避免连续重复；修复 eating 状态 404。为避免 GIF 从第 0 帧重播造成频闪，已取消空闲定时轮换，仅按状态切换。
- [x] 全屏检测与工作避让：新增 `is_foreground_fullscreen`（Rust/Win32：前台窗口铺满显示器判定，排除自身与桌面壳层）与 `show_island_no_focus`；前端 `useFullscreenAvoid` 每 2.5 秒轮询，全屏时按设置缩到屏幕边缘或暂时隐藏，退出全屏自动恢复；设置页可选"缩到边缘/暂时隐藏/不处理"。
- [x] 首次运行向导：`src/OnboardingPanel.tsx` 五步引导（欢迎、快捷键录入含冲突提示、开机自启、豆包/有道集成、完成），`maltese-onboarding-done` 标记，可跳过。
- [x] NSIS 安装包配置：bundle targets 改为 nsis，简体中文界面，版本号统一为 1.0.0；新增 `pnpm build:installer`/`pnpm build:exe`、`scripts/build-windows.mjs`（支持 --dry-run）与 `build-installer.bat` 一键打包脚本（纯 ASCII + CRLF，逻辑全部在 Node 侧，避免 cmd 编码/换行坑）；发布说明 `docs/releases/v1.0.0.md`。

## 本轮修复（2026-11-04）

- [x] 频闪：睡眠缩边改用原因栈（睡眠/全屏/手动），避免全屏避让与睡眠缩边互相 `tuck/reveal`；全屏/悬停/唤醒不再来回拉窗口。移除空闲 GIF 定时轮换，租约式 overlay 复用同一面板，减少原生窗口 resize。
- [x] 缩边睡觉露出高度可调：设置 → 布局新增 `tuckedVisibleHeight`（24–140 px），RN 与 Rust 均 clamp，原生几何立即生效。
- [x] 消息正文：QQ 通知在 `ToastGeneric` 不完整时遍历全部 binding 兜底；微信可选用本机 Windows OCR 读取可见会话列表首条预览（默认开启、可关闭、只在内存处理、不落盘/不上传），最小化时明确显示正文不可用。
- [x] 白色面板按钮：待办、音乐、系统/窗口操作、QQ/微信/邮箱来源和消息操作统一为可见的浅灰底+深色字，移除透明幽灵按钮。
- [x] 桌宠聊天：新增「聊天」页和 `dsh_chat` 命令，走 DSH headless profile + 本机已保存凭据，保留 `session-id` 连续对话；支持 Enter 发送、Shift+Enter 换行、清空会话和本地消息历史。
- [x] 刷视频：保留 B 站/抖音自动翻页，新增前台目标校验（浏览器进程 + 页面标题）；不在目标页时只等待，不抢焦点、不向其他应用发送 PageDown；抖音使用下方向键，B 站使用 PageDown。

## 本轮验证

- 前端 `tsc && vite build` 通过（Linux 校验目录独立安装依赖）。
- `cargo check --target x86_64-pc-windows-msvc` 在 mini crate 验证通过；完整 crate 需 Windows。
- **构建脚本修复（2026-11-03）**：`detectPackageManager` 优先 pnpm → corepack pnpm → npm；npm 兜底时自动清理 pnpm 格式的 node_modules 避免 npm 11 兼容性问题。
- **项目整理（2026-11-03）**：删除 `README.en.md`、`README.zh-CN.md`、`pnpm-workspace.yaml`（fly-island 遗留）；重写 `README.md`、`AGENTS.md`、`DESIGN.md` 为 Maltese 实际内容。
- 实机待办：双击 `build-installer.bat` 构建；完成后检查 `release\Maltese-assistant.exe` 与 NSIS 安装包是否正常。

## exe 交叉编译与“网页无法加载”修复（2026-11-03 下午）

- 交付方式：沙箱内用 llvm-mingw 20261020（clang 23）+ `--target x86_64-pc-windows-gnu` 交叉编译，产出 `release/maltese-assistant.exe`（PE32+ GUI，静态链接，无 Linux 运行时依赖），`WebView2Loader.dll` 需与 exe 同目录。
- 交叉编译要点：llvm-mingw 用 compiler-rt 替代 libgcc → 需自建空的 `libgcc.a`、用 `libunwind.a` 冒充 `libgcc_eh.a`，并通过 linker 包装脚本注入 `-L`。
- **Bug 修复**：exe 启动显示“网页无法加载”。根因是 `src-tauri/Cargo.toml` 缺少 Tauri 标准 `[features]` 段的 `custom-protocol` feature；`tauri build` 会自动带上它，但裸 `cargo build --release` 不会，导致 `generate_context!` 不嵌入前端资源、转而连接 devUrl（localhost:1420）。已在 Cargo.toml 补上 `custom-protocol = ["tauri/custom-protocol"]` 并带该 feature 重编。
- 验证方法：对比二进制内嵌资源字符串——修复前 `pets/` 引用 0 处，修复后 75 处（13 个根 GIF + 64 个变体），入口 JS/CSS 与字体哈希名均存在（旧可用 msvc 版为 13 处）。

- 前端 `tsc && vite build` 通过（在 Linux 校验目录中安装独立依赖执行，未污染项目 node_modules）。
- 新增 Win32 API 调用（GetForegroundWindow / MonitorFromWindow / GetMonitorInfoW 等）在独立 mini crate 中以 `cargo check --target x86_64-pc-windows-msvc` 验证通过；本沙箱无法编译 aws-lc-sys（无 MSVC），整 crate 检查需在 Windows 实机执行。
- 实机待办：运行 `build-installer.bat`（或 `pnpm build:installer`）产出 NSIS 安装包，验证安装/卸载、桌面快捷方式、全屏避让与向导首启。

## 历史进度（2026-11-02）

- 第一、二阶段条目全部完成（已并入上方当前进度），仅剩全屏缩边、首次运行向导与安装包打包，已于 2026-11-03 完成。
- 当日验证：`pnpm build` 通过；`pnpm tauri build --no-bundle` 通过，产物为 `src-tauri/target/release/maltese-assistant.exe`；release 程序启动检查正常。


## 桌宠化改造（2026-11-03 第三轮）

- [x] 折叠态完全透明：去掉深色药丸底与阴影，桌面只显示小狗本体（112px，居中，无亚克力）。
- [x] hover 侧浮互动面板 + 云朵消息气泡：新增独立透明气泡窗口（label `bubble`，focusable:false 不抢焦点），hover 浮出互动面板（摸头/喂食/抱抱/挥手 + 待办/播放状态 + 面板入口），收到 QQ/微信/邮件消息或切歌时浮出云朵文字框（6 秒自动收起），左右侧自动避让屏幕边缘。
- [x] 内嵌服务窗口（Folia 逻辑）：新增 `netease-music`（music.163.com）与 `doubao`（doubao.com/chat/）窗口，WebView2 登录态持久化；快捷面板加"网易云音乐""豆包"卡片；首次运行向导加"登录账号"步骤；播放时进入 Windows 媒体会话，现有控制层可直接控制。
- [x] 显示不全修复：`.assistant-panel` 增加 `height:100%; overflow-y:auto`（520px 页面高度内容超出现在可滚动）；设置页/剪贴板/消息页确认自带滚动。
- [x] 视觉验证：用真实构建 CSS 生成静态 mock 页截图核对（桌宠透明态、气泡两形态、快捷面板、设置页）。
- [x] exe 交叉编译交付：`release/maltese-assistant.exe` 43MB（custom-protocol 已嵌入全部 75 处素材引用）。

## 实机验证清单

- 双击 `release\maltese-assistant.exe`（与 WebView2Loader.dll 同目录）：桌面只显示透明小狗。
- hover 小狗 → 右侧浮出互动面板；鼠标移入面板不消失；移开后收起。
- 收到 QQ/微信消息或切换歌曲 → 侧边浮出云朵气泡，6 秒自动消失。
- 快捷面板点"网易云音乐"→ 打开网页版登录窗口；登录后播放歌单 → 小狗切换听歌状态，音乐页可控制。
- 快捷面板点"豆包"→ 打开豆包聊天窗口（登录态保留）。
- 设置页"全屏时小狗"三个选项完整可见可点。

## 第四轮修复（2026-11-03 晚）

- [x] 去除残留玻璃背景：折叠态补 `backdrop-filter: none`，并隐藏 `.island__glass` 玻璃层（之前只清了 background/box-shadow，磨砂模糊仍在）。
- [x] 右键菜单改为侧边气泡菜单（mode: "menu"），不再覆盖小狗；菜单不随鼠标移开自动消失，点选后关闭。
- [x] 音乐页重做：专辑封面（SMTC 缩略图）、歌名/歌手/专辑、进度条（可拖动 seek）、随机播放、上一首/播放/下一首、循环（none/track/list）、音量滑块、"歌单"按钮（打开网易云窗口）、歌词区（网易云公开 API 搜索+歌词，按播放进度高亮并自动滚动）。新增 Rust `lyrics::fetch_lyrics`（reqwest 需 `query` feature）；音乐页高度 320→440。
- [x] 快捷方式显示不全修复：取消"隐藏 other 分类 + 每分类只留一个"的过滤，改为显示全部自动发现快捷方式（最多 24 个），.lnk 标注"桌面快捷方式"。
- [x] 交付：`release/v2/maltese-assistant.exe`（旧文件被运行中的进程锁定，故放 v2 子目录）。

## 第五轮（2026-11-03 深夜）

- [x] 快捷面板精简：移除"线条小狗正在值班"标题与"和小狗玩一会儿"互动按钮，只保留快捷方式（应用卡片 + 自动发现的桌面/开始菜单快捷方式 + 自定义快捷方式 + 常用脚本 + 全局唤醒键）；互动按钮改到 hover 侧浮气泡里。
- [x] 自定义快捷方式：面板右上"＋ 新增快捷方式"填名称与路径（exe / .bat / .cmd / .lnk 均可），通过新增 Rust 命令 `get_shortcut_icon`（SHGetFileInfoW → GetDIBits → PNG data URL）显示真实图标，可单个删除，存 localStorage `maltese-custom-shortcuts`。
- [x] 所有浮层统一云朵造型：hover 互动面板、消息云朵、右键菜单共用 `.pet-cloud`（白色圆角 + 顶部棉团 + 指向小狗的尾泡）。
- [x] 音乐媒体：明确为直接读取本机 SMTC 媒体会话（网易云 / QQ 音乐 / Spotify / 浏览器均可，无需登录），面板显示专辑名与封面；未检测到播放器时给出提示；"歌单"按钮仅作为可选的网易云窗口入口。
- [x] 剪贴板：新增内容时浮出云朵气泡并直接显示剪贴板内容摘要（图片显示"剪贴板 · 图片"）。
- [x] 桌宠设置补齐：动画流畅度（流畅/均衡/普通/省电，控制待机图轮换节奏）、点击 Q 弹反馈、云朵气泡开关、气泡停留时长、剪贴板气泡开关、固定到屏幕角落（左上/右上/左下/右下，Rust `lock_island_corner`）。
- [x] 去掉小狗黑晕：收起态覆盖 `filter: none`（原先图片 drop-shadow 造成的黑色光晕）。
- [x] 微信提醒：放宽微信安装位置识别（HKCU/HKLM/WOW6432Node 注册表 + Program Files 常见路径，兼容 WeChat.exe / Weixin.exe），修复注册表只查 HKCU 导致监听器启动失败、提醒不显示的问题。
- [x] 素材：两个 MP4 重新转 GIF（12fps / 300×300 / 透明背景 / 去水印 / 地面线裁到身下），睡眠版 `rest.gif` 用于收起态待机，挥手版 `hover-wave.gif` 用于鼠标悬停。
- [x] 交付：`release/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第六轮（2026-11-04）

- [x] 收起态只显示睡眠动画：折叠时 petState 固定为 idle（`rest.gif`），图片 112px 完整居中、不再被 150px 旧规则裁切到窗口顶部；听歌/工作时不再替换收起形象。新增"收起动画上下翻转显示"开关（默认关）。
- [x] 微信 / QQ 消息提醒默认开启：升级后首次启动写入一次 enabled=true（微信 shell-hook 监听 + QQ Windows 通知监听），并重新触发一次 QQ 通知访问授权。
- [x] 移除网易云 / 豆包登录：删除 `netease-music`、`doubao` 内嵌网页窗口与 `open_service_window` 命令、向导登录步骤；改为 `launch_tool` 启动本机已安装的客户端。
- [x] 音乐优先本机网易云：SMTC 会话选择改为 ①网易云正在播放 ②系统当前播放 ③任意播放 ④暂停中的网易云；面板显示"来源：网易云音乐"，未上报信息时提示开启"任务栏媒体控制"。
- [x] 云朵气泡在收起态一定会弹出：隐藏/缩边时先 `show_island_no_focus` 把小狗露出来再定位气泡；气泡窗口按形态动态调整（hover 320×500、cloud 300×224、menu 240×232）。
- [x] 互动按钮竖排并扩充：摸头 / 挠下巴 / 抱抱 / 转圈 / 陪玩 / 躲猫猫 / 追球 / 喂食 / 睡觉 / 挥手，从上到下排列（新增 chin/spin/play/hide/chase 素材）。
- [x] LineDogPet 设置对齐：动画帧率、点击 Q 弹、气泡开关/时长/文字颜色、音效、整点叫声、鼠标交互、固定角落、自启、快捷键、全屏躲角、剪贴板感知、时间感知、夜间陪伴、偷偷观察你、听歌互动；另加感知与陪伴分组。
- [x] 快捷键唤醒 + 收起：全局热键触发 `maltese-hotkey-toggle` 事件，隐藏时叫出并展开，可见时在收起/展开之间切换。
- [x] 仅收起时悬停挥手：`petHovered && mode === "collapsed"` 才显示 `hover-wave.gif`。
- [x] 进程感知情感互动：新增 `activity::get_active_activity`（前台窗口 + 进程名，纯本地），每 30 秒检测一次写代码/写文档/开会/聊天/浏览/设计/视频/游戏，切换时用云朵气泡说一句对应台词（4 分钟冷却），听歌时用当前歌名互动。
- [x] 交付：`release/v3/maltese-assistant.exe` + `WebView2Loader.dll`（release 根目录 exe 正在运行被占用）。

## 第七轮（2026-11-04 晚）

- [x] 收起=睡觉、展开闲置=轮播：折叠态固定 `rest.gif` 趴睡不再轮换；展开态 idle 按动画流畅度轮播；彻底移除挥手动作（按钮、悬停换图、wave 素材）。
- [x] 网易云识别补强：SMTC 优先网易云；新增 `netease.rs` 从 cloudmusic.exe 窗口标题解析「歌名 - 歌手」，无 SMTC 或浏览器占着暂停会话时自动回退；新增 `media_press_key`（媒体键）与 `netease_focus`（切到客户端选歌单）命令；修正音乐面板右上角文字按钮溢出（`.music-icon-button--text`）。
- [x] 独立设置窗口：新增 `settings` 窗口（560×780，浅色卡片式），支持显示/气泡/互动/感知/伙伴五组设置，改动即写回 localStorage 并广播 `maltese-settings-updated`，主窗口热更新；入口在岛内「设置」、快捷面板与右键菜单。
- [x] 桌宠伙伴子系统（`companion.rs` + `CompanionWindows.tsx`）：
  - 多只小狗：`pet-extra-1…8` 透明置顶窗口，围绕主小狗浮动；
  - Bongo 键盘模式：620×250 键盘窗口 + WH_KEYBOARD_LL 全局键盘钩子，按键高亮；
  - 鼠标指针皮肤：`cursor-pet` 窗口跟随光标（28ms 轮询）；
  - 桌面脚印：全屏透明穿透窗口，按光标轨迹绘制渐隐爪印；
  - 随机闲逛：`roam_island_step` 每 32 秒挪动一小步（带回弹动画）。
- [x] 交付：`release/v4/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第八轮（2026-11-04 深夜）

- [x] 修复「收起一直睡觉、无法切换」：收起态只在 `petState === "idle"` 时使用睡眠图；摸头/喂食/庆祝等动作照常切换。
- [x] 修复气泡不显示：气泡窗口改为 340×520 且 `resizable: true`（原先 280×200 + 不可调整，竖排面板被裁掉）；`show_pet_bubble` 先 show 再 emit，并把最后一次内容缓存到 `BUBBLE_PAYLOAD`，气泡窗口启动时用 `get_pet_bubble_payload` 补取；悬停时即使缩边也先恢复再弹气泡。
- [x] 音乐面板去伪存真：删除「歌单」按钮与歌词错误提示；歌词面板只在系统媒体会话提供播放进度时出现；没有进度时隐藏进度条、随机/循环/音量控件（`.music-player--core`）；专辑封面仅在拿到缩略图时显示。
- [x] 新增设置「歌词实时显示在气泡上」(`lyricsBubble`，默认开)：有播放进度且歌词可用时，每换一句在云朵气泡里显示；设置窗口可关闭。
- [x] 交付：`release/v5/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第九轮（2026-11-04 深夜）

- [x] 修复「一直睡觉、不轮播」：删除收起态强制 `rest.gif` 与 petState 的 collapsed 覆盖；闲置时在 `IDLE_ROTATION`（9 张待机 + 睡觉 + 4 张放松）里按动画流畅度轮播，睡觉只占其中一帧；听歌 / 工作时优先显示对应状态。
- [x] 活动 → GIF：新增 `ACTIVITY_MOODS`（写代码=working、写文档/看视频=relax、开会=attention、聊天=happy、浏览=peek、设计=spin、游戏=chase），检测到活动时除云朵文字外，小狗切换对应动作 9 秒；新增 LineDogPet `peek` 素材（8 张）。
- [x] 交付：`release/v6/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第十轮（2026-11-04）

- [x] 设置窗口打不开：右键菜单/按钮调用 `open_settings_window`；窗口被关闭后原实现会销毁 WebView 导致再也拿不到。现在关闭时 `prevent_close + hide`，命令在窗口缺失时用 `WebviewWindowBuilder` 重建；前端命令失败还会回退到岛内设置页。
- [x] 设置不能下滑：App.css 的全局 `overflow:hidden` 影响到了设置窗口；改为 `.settings-window{height:100vh;overflow-y:auto;scrollbar-gutter:stable}`，内容区自己滚动。
- [x] 收起状态自查：`PET_GIF_VARIANTS.idle` 之前被改成了只有 `rest.gif`，导致轮播列表几乎全是睡觉图。恢复为 9 张待机图，轮播共 15 帧（9 待机 + 1 睡觉 + 5 放松），按流畅度 12/25/40 秒切换；已确认 15 个文件全部存在、无重复。
- [x] 交付：`release/v7/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第十一轮（2026-11-05）

- [x] 气泡改为主窗口内浮层：新增 `set_island_overlay`，hover 面板 / 云朵消息 / 右键菜单直接渲染在主窗口里，窗口临时放大（hover 320×470、cloud 300×210、menu 210×230），收起时恢复原尺寸；旧的独立气泡窗口不再显示，彻底避免空白页/白块/事件丢失。
- [x] 剪贴板图片气泡：图片条目会在云朵里直接显示缩略图；文本照旧显示摘要。
- [x] 尺寸设置修复：原生窗口尺寸同步的 effect 之前只依赖 `marginY`，现在同时依赖 `collapsedScale` / `expandedScale`，设置窗口拖尺寸立即生效。
- [x] 移除不稳定的伙伴子系统（多只小狗 / Bongo / 指针皮肤 / 脚印）：动态创建的透明窗口会留下白块并拖死主线程，代码与设置项一并移除；保留稳定的「随机闲逛」。
- [x] 新增交付自检脚本 `scripts/verify-build.mjs`（`npm run verify`）：类型检查 + 前端构建 + 97 个桌宠素材完整性 + dist 产物 + 三处版本号一致性。
- [x] 交付：`release/v8/maltese-assistant.exe` + `WebView2Loader.dll`（自检全部通过）。

## 第十二轮（2026-11-04）

- [x] 灰色底彻底修复：`SettingsWindow.css` 里 `html, body, #root { background: #f4f5f8 !important }` 是全局样式表，会同时作用于主窗口，把透明背景刷成浅灰（截图里小狗周围那块灰）。现在背景/字体/颜色只挂在 `.settings-window` 容器上，主窗口恢复全透明。
- [x] 交接前自检：`npm run verify` 通过（类型检查、前端构建、97 个素材、dist、版本号），再交叉编译 exe。
- [x] 交付：`release/v9/maltese-assistant.exe` + `WebView2Loader.dll`。

## 第十三轮（2026-11-04）

- [x] 气泡变成白色细条：浮层渲染与窗口尺寸存在竞态——展开时面板先出现、窗口还没放大；收起时窗口先缩回、面板还没移除，结果被裁成一条白色竖条（截图里还露出溢出的「待办/音乐/快捷」）。现在展开先 `set_island_overlay` 放大窗口再渲染面板，收起先移除面板、下一帧再缩窗口，并加了 generation guard 防止快速进出时旧回调覆盖。
- [x] 浮层窗口尺寸改用 `Size::Logical`（与 apply_stage_geometry 一致），避免高 DPI 下窗口比 CSS 预期小。
- [x] 浮层面板固定宽度（hover 260 / cloud 250 / menu 190），窗口异常时也不会压缩成细条。
- [x] 交付：`release/v10/maltese-assistant.exe` + `WebView2Loader.dll`（`npm run verify` 通过）。

## 第十四~十八轮（2026-11-04～05，云朵窗口重构）

- [x] 浮层坐标系重构（v11–v12）：收起态 `.island--collapsed` 改为 100% 窗口宽高、`transform:none`，小狗槽位固定在窗口左下（`--pet-slot-w/h`），浮层用 `left: calc(var(--pet-slot-w)+8px)` 的窗口坐标定位。修复：浮层一出现就被自动关掉（effect 依赖里含 `overlay`）、`show_island_no_focus` 把刚放大的窗口缩回、`apply_stage_geometry` 与浮层抢窗口尺寸。
- [x] 展开态改为云朵面板窗口（v11 起）：不再使用灵动岛式大窗口；Rust `stage_dimensions` 展开尺寸 = 小狗槽 + 8 + 460 × max(槽高, 520)，面板只朝小狗右侧/上方生长，空间不足就压缩面板尺寸（内容在面板内滚动），窗口位置绝不 clamp——这是“上下跳动/瞬移”的根因。
- [x] 睡眠与缩边（v13–v17）：新增 `get_system_idle_seconds`（GetLastInputInfo），系统闲置达到 `sleepAfterSeconds`（默认 150s，设置页可调 30–900）才睡；鼠标悬停/点击/拖拽立刻唤醒并保持 30 秒不睡。缩边只在睡着时发生，按到上/下工作区边缘的距离自动选方向：往下缩露头顶，往上缩自动翻转 GIF 露头（“上下翻转”设置已删）。露头高度 80px；趴睡 GIF 下移量归零，位置整体上移。
- [x] 主题（v14–v17）：强制 `appearanceMode:"classic"`，彻底停用灵动岛液体玻璃；展开面板为纯白云朵卡片，音乐/待办/消息/剪贴板/快捷面板全部浅色化（深色文字 + 浅灰子卡片），去掉所有 `backdrop-filter`。快捷入口改成 3 列大卡片（40px 白底软件图标 + 名称）。
- [x] 收起按钮：改成带“收起”文字 + 下箭头的浅灰 pill；旁边是“隐藏到托盘”，之前是全透明热区容易误点导致窗口“消失”。另加 `ensure_island_on_screen` 保险：几何应用后窗口若完全跑出工作区，自动清位置、回默认锚点并显示。
- [x] 浮层交互：`.island-overlay` 容器 `pointer-events:none`，只有面板本身接收鼠标事件——鼠标离开小狗后浮层会正常消失。
- [x] 注意（踩坑记录）：`set_island_overlay` 读 `OVERLAY_SNAPSHOT` 必须先释放锁再调用 `apply_stage_geometry`（其内部会再锁，持锁会死锁）；打开浮层前要先把窗口“落定”并取消位移动画，否则动画中间位置会被当成锚点，关闭后小狗瞬移。
- [x] 交付：`release/v11` ~ `release/v17`（每版均 `npm run verify` 通过，exe 内嵌对应 `index-*.js`）。

## 交接状态（截至 v17）

- 当前版本：`release/v17/maltese-assistant.exe` + `WebView2Loader.dll`（同一目录运行）。
- 构建：`npm run verify` 自检 → 复制 `dist` → `cargo build --release --features custom-protocol --target x86_64-pc-windows-gnu`（Linux 沙箱交叉编译，详见 `docs/BUILD.md`）。
- 待确认：QQ 消息读取依赖 Windows 通知访问权限 + QQ 自身系统通知；微信靠任务栏闪烁。若仍收不到，需要用户提供 QQ/微信版本、系统通知权限状态与消息面板里的状态文字。
- 可调项：睡觉露头高度（`TUCKED_VISIBLE_DOG_HEIGHT`，当前 80）、缩边睡眠触发时间（设置页滑杆）、面板宽高（`EXPANDED_PANEL_WIDTH/HEIGHT`）。
