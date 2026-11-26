# 视频插件专用浏览器 profile 的存放位置（P1：迁出 C 盘）

状态：已实现（2026-11-26）。涉及代码：`src-tauri/src/video/browser.rs`、`session.rs`、`paths.rs`、`lib.rs`。

## 1. 位置

| 用途 | 新位置（默认） | 旧位置（只读回退 / 迁移来源） |
| --- | --- | --- |
| 默认 profile（未绑定账号） | `<data_root()>\video-browsers\default` | `%LOCALAPPDATA%\Maltese\video-profile` |
| 小狗账号 profile | `<data_root()>\video-browsers\accounts\<accountId>` | `%LOCALAPPDATA%\Maltese\video-accounts\<accountId>` |
| 专用浏览器实例标记 | `<data_root()>\video-browsers\video-browser.json` | `%LOCALAPPDATA%\Maltese\video-browser.json` |

`data_root()` 仍是 `paths.rs` 的解析结果（`MALTESE_DATA_DIR` > `%APPDATA%\com.maolouis.maltese\data-dir.txt` >
exe 同目录 `data\`），本机即 `E:\Maltese2\data`，所以实际路径是
`E:\Maltese2\data\video-browsers\...`。

## 2. 为什么搬

`%LOCALAPPDATA%\Maltese` 之前放的是三套 Chromium profile，实测 1.91 GB
（`video-accounts` 913.5 MiB + `video-profile` 678.9 MiB + `video-profile.bak-20261120` 363.2 MiB），
全在系统盘；业务数据早已统一到 `data_root()`，profile 是最后一个漏网的。

## 3. 启动迁移（`browser::profile_root()`，`lib.rs::run()` 最早阶段调用）

1. 新根 `<data_root()>\video-browsers` 建目录 + 写探测文件；不可写 → 记
   `VIDEO_PROFILE_ROOT root=… ok=false fallback=%LOCALAPPDATA%\Maltese reason=new_root_not_writable`，
   直接用旧位置（只读回退），不再尝试迁移。
2. 旧 `video-profile` / `video-accounts\<id>` 有数据、新位置还没有 → 复制（`copy_tree`）后
   **校验文件数 + 总字节数与源一致**（`tree_stats`）。
3. 校验通过 → 旧目录**改名**为 `<名字>.migrated-<unix秒>`，保留 7 天由用户自行清理
   （代码不做任何自动删除）；改名失败只记 `VIDEO_PROFILE_LEGACY_RENAME_FAILED`，原目录保持可用。
4. 任一步失败 → 删除本次半成品（新位置的空壳），记
   `VIDEO_PROFILE_MIGRATION_FAILED reason=… root=… fallback=… ok=false`，
   **回退旧位置继续启动**（不阻断启动，登录态不丢），下次启动会重试。
5. 成功日志：`VIDEO_PROFILE_ROOT root=… migrated_from=… ok=true items=…`，
   另有 `VIDEO_PROFILE_LEGACY_KEPT path=… note=keep_7_days_manual_cleanup`。
   两类日志都写进 `%APPDATA%\com.maolouis.maltese\paths.log`（与 `DATA_ROOT_READY` 同一个文件）。

### 历史账号记录

`<data_root>\video\accounts.json` 里的 `profileDir` 是绝对路径（旧版本写的是
`C:\Users\…\AppData\Local\Maltese\video-accounts\dog-…`）。运行时不改 Store，而是在使用处
`browser::resolve_profile(recorded)` 重映射：

- `<legacy>\video-profile`（含 `.migrated-*`）→ `<new>\default`
- `<legacy>\video-accounts\<id>`（含 `.migrated-*`）→ `<new>\accounts\<id>`
- 其它路径原样返回（大小写 / 分隔符不敏感）

## 4. 清理（手动，需用户确认）

迁移成功、确认「打开登录窗不需要重新扫码 + 一次采集能开始」之后，旧位置只剩
`*.migrated-*` 目录，可人工确认删除。删除前先打印绝对路径与体积，见
[docs/dev-environment-rules.md](dev-environment-rules.md) 的「清理要可见」。

## 5. 验证命令

```powershell
# 迁移日志
Get-Content "$env:APPDATA\com.maolouis.maltese\paths.log" -Tail 20
# 新位置
Get-ChildItem "$env:LOCALAPPDATA\..\..\Maltese2\data\video-browsers"   # 或直接看 <data_root>\video-browsers
# 登录态（Cookies 库里的站点）
python -c "import sqlite3;print(sqlite3.connect(r'<data_root>\video-browsers\accounts\<id>\Default\Network\Cookies').execute(\"select count(*) from cookies where host_key like '%bilibili%'\").fetchone())"
```

单元测试：`cargo test --lib video::browser`（覆盖路径重映射、复制校验、迁移后旧目录改名）。