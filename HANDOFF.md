# Handoff

更新时间：2026-11-04 20:15（Asia/Shanghai）

## 当前分支与提交

- `dsh`：本轮 v1.1.5 修复提交（含 `dsh-plugin/` 与本文档）。
- `main`：同一 v1.1.5 修复（不含 `dsh-plugin/`）。
- 两个分支均已推送到 `origin`，并打 annotated tag `v1.1.5`。
- 上一版 tag：`v1.1.4`。

## 本轮完成（v1.1.5）

### 1. 修复右侧贴边时弹窗/气泡跑到屏幕外

- 现象：v1.1.4 中小狗复位到右下 / 右上后，展开面板仍只向右生长，
  窗口大部分落在屏幕外，看起来像“点了没反应”。
- 修复：`apply_stage_geometry` 用 `expanded_panel_side` 根据左右剩余空间选边；
  右侧不够就向左展开，窗口 x 同步左移，小狗屏幕位置不变。
- hover 气泡同样处理：`set_island_overlay` 复用选边逻辑；向左时 CSS
  把小狗钉在窗口右边（`island--overlay-left`），气泡向左长，小狗不左移。
- 回归测试：`expanded_panel_flips_away_from_screen_edges`
  （左缘 / 右缘 / 两侧都不够 / 负坐标副屏）。

### 2. 修复气泡文字颜色不生效

- 主窗口浮层之前没有设置 `--pet-bubble-text`，只有独立气泡窗口读取
  localStorage，导致设置颜色后 hover 气泡仍是默认色。
- 现在主窗口根节点直接下发 `--pet-bubble-text`；独立气泡窗口增加
  `storage` 监听，改色后已打开的气泡也会即时刷新。
- 独立设置窗口改色仍通过 `maltese-settings-updated` 同步回主窗口。

### 3. 复用 LineDogPet 设置：小狗不透明度

- 新增 `petOpacity`（30%–100%，默认 100），只作用于小狗图片，
  不影响气泡 / 面板；主设置页与独立设置窗口均可调。
- 旧配置没有该字段时自动使用默认值。

## 版本与产物

- 版本 `1.1.5`（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）。
- `release/v1.1.5/maltese-assistant.exe`（24,258,560 bytes）
  + `WebView2Loader.dll`（160,320）。
- `release/maltese-assistant-v1.1.5-win64.zip`（11,862,371 bytes，zip 根目录含 exe + dll）。
- 发布说明 `docs/releases/v1.1.5.md`。

## 验证

- `cargo test --target x86_64-pc-windows-msvc --lib`：66 passed / 0 failed / 9 ignored。
- `tsc --noEmit` 通过；Vite 生产构建通过。
- 实机确认：右下角展开面板向左生长，窗口右边缘不超出 2560 宽屏幕。

## 已知问题 / 下一步

- `tests/i18n.tsx` 与当前 UI 仍有历史偏差（媒体状态需要 `sessions`、布局入口已不是
  `.dot-button--layout`、启动不再有 `.island__open-button`），本轮未纳入提交。
- LineDogPet 的其他设置尚未全量复用：跟随模式 / 鼠标指针皮肤 / 脚印 / 特效 /
  AI Key / 多宠物 / Bongo 模式 / 深色模式等需要按优先级逐项移植。
- DSH 插件是 Host-only companion，仅在 `dsh` 分支；切回 `main` 后 `dsh-plugin/`
  会从工作区消失，已安装插件会失效。保持在 `dsh` 分支或重新安装。