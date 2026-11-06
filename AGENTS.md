# AGENTS.md

本文件面向在该仓库中工作的 AI 编程助手，说明项目背景、常用命令与代码边界。在动手前请先阅读本文件。

## 项目概览

Maltese 是一个 Windows 桌面宠物助手（Tauri 2 + React 19），以线条小狗桌宠形态
常驻桌面，集成了待办、剪贴板、音乐控制（读取本机媒体会话）、QQ/微信/邮箱通知、有道翻译、
Clash/Watt、PowerToys 和常用脚本等功能。

项目从 E:\fly-island 复制改造，素材来自 E:\LineDogPet\LineDogPetv2.8.3。

## 技术栈

- 前端：React 19、TypeScript、Vite 7
- 桌面壳：Tauri 2（Rust）
- 图标：lucide-react
- 包管理：pnpm
- 实机构建：Windows（Linux 沙箱可做前端和 mini crate 的 cargo check，但不能链接和打包）

## 目录结构

```
.
├── src/                      # React 前端
│   ├── App.tsx               # 核心 UI（汪汪状态、交互、快捷面板、设置）
│   ├── App.css               # 主要样式
│   ├── IslandShell.tsx → App.tsx  # 悬浮壳组件
│   ├── OnboardingPanel.tsx   # 首次运行向导
│   ├── petAssets.ts          # GIF 素材清单与随机选取
│   ├── petCharacters.ts      # 小白/小鸡毛/双狗形象、动作映射与回退链
│   ├── petCharacterAssets.generated.ts # 由 scripts/build-pet-manifest.mjs 生成
│   ├── tuckGif.ts            # 缩边/睡觉 GIF 的存储与读取
│   ├── TuckGifControl.tsx    # 设置里的缩边动画选择控件
│   ├── TranslationWindow.tsx # 翻译独立窗口
│   ├── UpdatePanel.tsx       # 软件更新面板
│   ├── Messages.tsx          # 消息面板
│   ├── QQMail.tsx / QQNotifications.tsx / WeChatReminders.tsx
│   ├── MediaWaveform.tsx     # 音乐波形
│   ├── useIslandAutomation.ts # 全屏避让 / 待办流转
│   ├── i18n/                 # 中英文国际化
│   └── ...
├── src-tauri/                # Tauri / Rust
│   ├── src/lib.rs            # 原生命令、窗口定位、托盘、注册表自启
│   ├── src/main.rs           # Tauri 入口
│   ├── src/clipboard_history.rs
│   ├── src/media_control.rs  # Windows 媒体会话
│   ├── src/qq_notifications.rs / qq_mail.rs / wechat_reminders.rs
│   ├── src/translation.rs    # 有道智云 v3
│   ├── src/dsh_api.rs        # DSH 本机 API
│   └── src/video_automation.rs  # B 站/抖音自动翻页
├── public/assets/pets/       # 线条小狗 GIF 素材（chars/ 下分 xiaobai、xiaojimao、shared）
├── scripts/
│   ├── build-windows.mjs     # 一键打包脚本（Node 侧逻辑）
│   ├── build-pet-manifest.mjs # 扫描角色素材，生成 petCharacterAssets.generated.ts
│   ├── recover-chat-history.mjs # 把 Codex 会话日志还原成 Markdown
│   ├── release*.mjs          # 发布流水线
│   ├── focusd-agent-*        # AI Agent 状态钩子脚本
│   └── ...
└── docs/                     # 开发文档与发布说明（chat-history/ 存还原的旧对话）
```

素材与形象约定：

- `public/assets/pets/chars/xiaobai|xiaojimao|shared/<动作>/*.gif`，`shared` 是两只同框的共享池，不是角色。
- 新增或替换素材后跑 `node scripts/build-pet-manifest.mjs`，清单是生成文件，不要手改。
- 界面状态到动作目录的映射、动作回退链在 `src/petCharacters.ts`；抱起/转圈/追逐固定用 shared 里的招牌图。

## 常用命令

```bash
pnpm install                # 安装依赖
pnpm tauri dev              # 开发模式
pnpm build                  # 仅前端构建 (tsc + vite)
pnpm tauri build --no-bundle  # 编译 exe
pnpm tauri build --bundles nsis  # 编译 NSIS 安装包
node scripts/build-windows.mjs   # 一键打包（优先 pnpm，兜底 npm）
```

构建需在 Windows 实机执行（目标平台）。Linux 沙箱可以做 `pnpm build`（需先独立安装依赖）和 mini crate 的 `cargo check --target x86_64-pc-windows-msvc`。

## 代码边界

- 前端改动：新增组件放 `src/` 下独立文件，样式添加到对应位置。`App.tsx` 已超过 6300 行，在新文件里添加新功能避免进一步膨胀。
- Rust 改动：所有命令注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 块。模块分拆在独立文件（`mod` imports at top）。新增 Win32 API 调用时需要确认 `windows` crate features 是否覆盖。
- 构建验证：改完前端跑 `pnpm build`；改完 Rust 至少在我这里跑 `cargo check --target x86_64-pc-windows-msvc`（mini crate 也行），实机再跑完整构建。

## 风格约定

- 沿用项目现有命名与组件结构，品牌色为浅绿 / 浅橙色。
- 用户使用简体中文交流，UI 文案走 i18n（zh-CN / en），新增字符串要在 locales 和 types 里同步。
- 提交前验证 tsc 和 cargo check 通过。