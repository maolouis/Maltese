# 架构与前端分离

## 1. 分层

```
src/main.tsx           入口：按 ?window= 选择根组件（12 个窗口共用一份产物）
├─ src/App.tsx         岛体装配：窗口几何、状态桥、页面切换（正在拆分，见 §4）
├─ src/uiControls.tsx  设置面板通用控件（滑块 / 取色 / 开关 / 外观 / 数字 / 语言）
├─ 页面容器           PetChat / TodoNotebook / MusicPlayerPanel / ClipboardHistoryPanel /
│                     PluginsPanel / VideoPage / AssistantPanel / SettingsWindow
├─ 能力模块           proactiveChat / petSkills / localChat / updaterController / shortcutPath /
│                     petAssetBase / petCharacters / petAssets / petGifRotation
└─ 独立窗口           TranslationWindow / PetBubble / CompanionPet / CursorPet / BongoPet /
                      Billiards / PinnedPanel / PinnedTodo / PinnedMusic
```

Rust 侧一文件一能力域：`lib.rs`（壳与命令注册）、`desktop_icons`、`desktop_extras`、`local_chat`、
`dsh_api`、`qq_mail`、`qq_notifications`、`wechat_ocr`、`media_control`、`translation`、
`video_automation`、`web_protocol`（前端产物外置）等。

## 2. 前端外置（`web_protocol.rs`）

`http://maltese.localhost/...` 由 Rust 从 `<resourceDir>/web` 读取：

- 只读、只允许 `web/` 内、路径规范化后必须仍在目录内（目录穿越保护）；
- 未知路径回 `index.html`（SPA 兜底）；MIME 覆盖 html/js/css/字体/gif/webp；
- 用 `src-tauri/tauri.external-web.conf.json` overlay 启用：

  ```powershell
  pnpm build
  node_modules\.bin\tauri.cmd build --config src-tauri\tauri.external-web.conf.json --bundles nsis
  ```

  该 overlay 同时把 `dist` 装到 `resources/web`、把 12 个窗口 URL 换成 `http://maltese.localhost/...`、
  把内嵌产物收缩成「资源缺失」提示页。

默认构建（不带 overlay）仍然内嵌前端，行为与之前一致；外置模式需要实机验证 IPC 注入与 CSP 后
才能切为默认（验证清单见 `docs/distribution.md`）。

## 3. 守护脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/verify-architecture.mjs` | 单文件行数预算（App.tsx 只降不升）、模块预算 900 行、反向依赖检查 |
| `scripts/verify-parity.mjs` | 17 项功能锚点检查，防止重构把功能改没 |
| `scripts/verify-build.mjs` | 素材完整性、清单一致性、版本一致 |
| `scripts/verify-packaging.mjs` | 打包卫生（无加壳/注入、NSIS、自启动范围、资源外置） |
| `scripts/verify-release-artifacts.ps1` | 产物签名状态、Defender 扫描、SHA-256 |

建议发布前顺序跑：`verify-architecture` → `verify-parity` → `verify-build` → `verify-packaging` → 构建 → `verify-release-artifacts`。

## 4. App.tsx 拆分路线（当前 9161 行）

已完成：

- `uiControls.tsx`：6 个通用控件（190 行），App.tsx 从 9347 → 9161。

接下来按「依赖最少 → 最多」顺序拆（每步都跑 `verify-architecture` / `verify-parity`）：

| 步骤 | 目标模块 | 需要先下沉的共享内容 |
| --- | --- | --- |
| 1 | `VideoPage` + `VideoAutomationPanel` | `VideoAutomationSnapshot` / `DEFAULT_VIDEO_AUTOMATION` → `videoAutomationTypes.ts` |
| 2 | `ClipboardHistoryPanel` | `ClipboardHistoryItem/Snapshot/Image/Settings` → `clipboardTypes.ts` |
| 3 | `TodoNotebook` + `ArchiveBrowser` | 待办存储键与 `normalizeTodo` 等纯函数 → `todoStore.ts` |
| 4 | `MusicPlayerPanel` + 歌词 | `parseLrc` / `useLyrics` → `musicLyrics.ts` |
| 5 | `AssistantPanel`（含快捷方式辅助函数） | `shortcutPathKey`、`load*Shortcuts`、`playPetChirp` → `shortcutStore.ts` / `petSound.ts` |
| 6 | `LayoutEditor` | 设置项类型与默认值 → `settingsTypes.ts` |

> 说明：`PinnedPanel.tsx` 目前仍 `import { AssistantPanel } from "./App"`。这是已知债务，
> `verify-architecture.mjs` 会打印警告但不判失败；完成第 5 步后这个依赖自然消失，届时删掉
> `KNOWN_APP_DEPENDENCIES` 条目。

## 5. 与旧版本（v1.3.42）的功能对照

`verify-parity.mjs` 用锚点覆盖 17 项能力：桌宠动画、GIF 轮播设置、主动聊天（含角度去重）、
主动程度量化、聊天与思考面板、待办与归档、剪贴板、音乐与歌词、视频自动翻页、快捷入口与路径校验、
插件与台球、固定标签到桌面、翻译、消息（QQ/微信/邮箱）、更新链路、前端外置协议、打包卫生检查。

拆分只移动代码位置、不改行为：同类改动要求 `tsc` + `verify-parity` 同时通过才算完成。