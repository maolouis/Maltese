# Handoff

更新时间：2026-11-04 17:27（Asia/Shanghai）

## 当前分支与提交

- `main`：`44c7446 feat: 看视频独立页、可调复位位置与待办添加按钮`
- `dsh`：`3d04f7c feat: 打包 Maltese 为 DSH 插件`（从 main 拉出，额外提交 `dsh-plugin/`）
- 两个分支均已推送到 `origin`。
- 本轮没有打 tag；上一版 tag 仍是 `v1.1.2`。

## 本轮完成

### 1. 「看视频」从快捷面板移到聊天旁边

- `src/App.tsx` 新增 `"video"` 页面和 `VideoPage`，复用 `VideoAutomationPanel`。
- 悬停气泡快捷链接：待办 / 音乐 / 剪贴板 / 聊天 / **看视频** / 消息 / 快捷。
- 顶部导航「聊天」右侧新增「看视频」。
- 「快捷入口」页里的看视频分区已删除，只保留快捷方式、常用脚本和显示/隐藏快捷键。
- 悬停链接改为 4 列，7 个入口排成 4+3。

### 2. 复位位置可调

- 设置里的「固定到屏幕角落」改为「复位位置」：底部居中 / 左上 / 右上 / 左下 / 右下。
- 选择四角后立即调用 Rust `lock_island_corner`；「复位」按钮也会回到该位置；选底部居中则调用 `reset_island_position`。
- `src-tauri/src/lib.rs` 的 `lock_island_corner` 在落位后发出 `island-position-changed`，前端写入 localStorage，避免下次启动被旧拖拽位置覆盖。
- `src/SettingsWindow.tsx` 也补了同一组复位位置选项。
- 首次加载时若设置为默认「底部居中」，不会清除用户之前拖拽的位置；选中四角时会在启动后重新落位。

### 3. 待办手动添加修复

- `TodoNotebook` 的添加表单现在只在「今天」页显示，避免 review/archive 页出现禁用输入框。
- 表单新增明确的「添加」按钮（`todo-form__add`），不再只依赖 Enter 或不可点击的 Plus 图标。
- 已用浏览器 mock 实测：输入「测试添加待办」后点击添加，列表出现新任务，输入框清空，localStorage 同步更新。

### 4. DSH 插件

- `dsh` 分支新增 `dsh-plugin/`：
  - `package.json`（`dsh.bundle.patch`）
  - `cordis.patch.yml`（`id: maltese-dsh`，默认 `autoLaunch: true`）
  - `index.js`（Host 半侧，注册 `maltese_pet` 工具，自动/手动启动原生 exe）
  - `locale/zh.json`、`locale/en.json`、`icon.png`、`README.md`
- 插件已通过 `plugin_manager install_bundle` 安装到当前桌面 profile，`application: applied`，`include:maltese-dsh` 为 active。
- 实测 `maltese_pet` 已出现在 Agent 工具列表。
- 插件不内嵌 exe；会按 `executablePath` → `MALTESE_EXE` → `release/<version>/maltese-assistant.exe` → 常见安装目录查找。

## 验证结果

- `pnpm build`：tsc + vite 构建成功。pnpm 包装器仍因 `ERR_PNPM_IGNORED_BUILDS`（esbuild）返回非 0，但 `✓ built` 正常。
- `cargo test --target x86_64-pc-windows-msvc --lib`：64 passed，0 failed，9 ignored。
- 已生成并启动 `release/v1.1.3/maltese-assistant.exe`（24,262,656 bytes），配套 `WebView2Loader.dll`。
- 当前桌面进程运行的是 v1.1.3。
- `dsh-plugin/index.js` 通过 `node --check` 和动态 import 检查。
- DSH 插件安装后桌宠仍只有一个进程（单实例生效）。

## 已知问题 / 下一步

- `tests/i18n.tsx` 与当前 UI 有历史偏差（媒体状态需要 `sessions`、布局入口已不是 `.dot-button--layout`、启动不再有 `.island__open-button`），本轮没有把它纳入提交；需要单独更新测试夹具。
- v1.1.3 只有本地 exe，没有打 tag、没有 GitHub Release、没有上传安装包。
- 四角复位以窗口左上角为基准；展开态面板比收起态宽时，右/下角的视觉锚点可能和期望有偏差，建议实机拖拽 + 展开验收后再微调 Rust 几何。
- DSH 插件目前是 Host-only companion：负责拉起原生桌宠和提供工具，不在 DSH 网页里渲染宠物。若要做网页内宠物，需要再加 Client 半侧（`shell.overlay` + 资源内联）。
- 插件安装目前是本地目录链接；如果切回 `main` 分支，`dsh-plugin/` 会从工作区消失，已安装插件会失效。保持在 `dsh` 分支或重新安装。