# Handoff

更新时间：2026-11-04 18:55（Asia/Shanghai）

## 当前分支与提交

- `main`：`b75417b fix: 右下/右上复位回到屏幕中央，显示器归属按小狗槽判定`
- `dsh`：`262f687`（同一修复，另含 `dsh-plugin/` 与 handoff 文档）
- 两个分支均已推送到 `origin`。
- 本轮打了 tag：`v1.1.4`（annotated，已推送 origin）。

## 本轮完成（v1.1.4）

### 1. 修复「复位到右下/右上却回到屏幕中央」

- 现象：设置里选「右下/右上」后，小狗没有落在角落，而是回到屏幕水平居中。
- 根因：`monitor_for_island_position` 用旧整窗宽度常量（`STAGE_WINDOW_WIDTH=640`）
  计算小狗中心点，而 `custom_position` 记录的是收起态小狗槽的左上角（约 151–168px）。
  右下/右上角的槽位中心被算到显示器右缘之外，归属判定失败 → `custom_position` 被丢弃
  → 回退到默认居中位置。此前 de3edad 只修了 `lock_island_corner` 的落位计算，漏了归属判定。
- 修复：`monitor_for_island_position` 增加 `collapsed_scale` 参数，按槽位实际尺寸算中心点；
  槽位尺寸统一收敛到 `slot_width_css` / `slot_height_css`，删除旧常量。
- 回归测试：`corner_slot_centers_stay_inside_their_monitor`（1x / 2x 缩放、四角 + 屏外拒绝）。
- 验证：`cargo test --target x86_64-pc-windows-msvc --lib` 65 passed / 0 failed / 9 ignored。

### 2. 版本与发布产物

- 版本升至 `1.1.4`（package.json / tauri.conf.json / Cargo.toml 三处同步）。
- 已构建 `release/v1.1.4/maltese-assistant.exe`（24,300,544 bytes，18:46 编译，含本次修复）
  与 `WebView2Loader.dll`（160,320）。
- 已打包 `release/maltese-assistant-v1.1.4-win64.zip`（12,190,808，含 exe + dll）。
- 发布说明 `docs/releases/v1.1.4.md`。
- `v1.1.4` tag 与 main/dsh 均已推送 origin。

## 已知问题 / 下一步

- **GitHub Release 未创建**：本机无 gh CLI、无 GitHub PAT，无法调用 Releases API。
  需要用户提供 PAT（`repo` 权限）后，创建 v1.1.4 Release 并上传
  `maltese-assistant-v1.1.4-win64.zip` 与 README。
- `tests/i18n.tsx` 与当前 UI 仍有历史偏差（媒体状态需要 `sessions`、布局入口已不是
  `.dot-button--layout`、启动不再有 `.island__open-button`），本轮没有把它纳入提交。
- 展开面板仍只向右生长，右下/右上角展开时面板可能贴近或超出屏幕边缘，后续可考虑
  右侧角自动改为向左展开。
- DSH 插件是 Host-only companion，仅在 `dsh` 分支；切回 `main` 后 `dsh-plugin/` 会从
  工作区消失，已安装插件会失效。保持在 `dsh` 分支或重新安装。