# 数据目录迁移方案（C 盘 → 可配置目录）

> 状态：**默认根已改为安装目录 data/**（2026-11-20 决策；第 1 步 paths.rs 收口 + 迁移；WebView2 profile 迁移留第 2 步）。盘点时间 2026-11-19，实测自本机
> `C:\Users\Administrator\AppData\{Roaming,Local}\com.maolouis.maltese`。

## 1. 现状盘点（实测体积）

### 1.1 Roaming：`%APPDATA%\com.maolouis.maltese`（合计约 **3.0 MB**）

| 路径 | 体积 | 来源（代码） |
|---|---|---|
| `instance.lock` | ~0 | `instance_lock.rs`（`app_data_dir` 拼 `instance.lock`，启动前跨进程锁） |
| `dsh-api-port.txt` | ~0 | `dsh_api.rs`（`PORT_FILE` 常量，`app_data_dir`） |
| `dsh-api-token.txt` | ~0 | `dsh_api.rs` |
| `local-model.log` | ~0 | 本地模型日志 |
| `probe.txt` | ~0 | 诊断探针 |
| `pet-gifs/` | 0.5 MB | `pet_gifs.rs`（两处 `app_data_dir` + `pet-gifs-trash`） |
| `pet-gif-rotation.before-restore.*.json` | ~0 | `pet_gifs.rs` / `lib.rs`（轮转备份） |
| `billiards-backup.json` | ~0 | `desktop_icons.rs`（`backup_path()` 手写路径，**未走 `app_data_dir`**） |
| `video/`（sessions/logs/daily/accounts/trash/pending） | 0.4 MB | `video/session.rs:437`（`StoreHandle` 根目录） |
| `agent-hub/`（config/logs） | ~0 | `agent_hub.rs:284`（`CONFIG_DIR = "agent-hub"`） |
| `clipboard-images/` | 0.3 MB | `clipboard_history.rs:226` |
| `clipboard-history.json` | 0.1 MB | `clipboard_history.rs`（同目录） |
| `plugins/` | ~0 | `plugins.rs:94` |
| `dsh-chat/` | ~0 | `dsh_chat.rs:182` |
| `local-storage.before-restore.20261117-123720/` | 1.6 MB | 历史恢复备份（一次性遗留，非运行时必需） |
| 代理状态脚本/hooks（`read_agent_status`/`clear_agent_status`/`install_agent_status_hooks`） | ~0 | `lib.rs:3428/3451/3508`（三处 `app_data_dir`） |

### 1.2 Local：`%LOCALAPPDATA%\com.maolouis.maltese`（合计约 **128.9 MB**，增长最快）

| 路径 | 体积 | 说明 |
|---|---|---|
| `EBWebView/` | **128.9 MB** | WebView2 用户数据目录（profile） |
| └ `Default/` | 56.8 MB | localStorage、IndexedDB、缓存（前端所有 localStorage/IDB 都在这） |
| └ `component_crx_cache/` | 21.4 MB | 组件缓存 |
| └ `WidevineCdm/` | 21.9 MB | DRM 组件 |
| └ `Subresource Filter/` | 12.3 MB | 广告过滤规则 |
| └ `GrShaderCache/` | 9.5 MB | GPU 着色器缓存 |
| └ `Speech Recognition/` | 2.6 MB | 语音 |
| └ 其它（hyphen-data、SmartScreen、Crashpad、PKI 等） | ~4 MB | |

**结论**：真正占空间的是 WebView2 profile（≈129 MB 且随使用增长，可能到几百 MB）；Roaming 里业务数据只有约 3 MB，但包含视频历史/日志/账号等需要迁移的用户数据。

### 1.3 硬编码 / 非 `app_data_dir` 的路径

- `desktop_icons.rs::backup_path()`：手写 `base.join("maltese").join("billiards-backup.json")`（`base` 来自环境变量推导，需统一）。
- `agent_hub.rs`：`CONFIG_DIR = "agent-hub"` 常量，根目录由 `app_data_dir` 提供（可复用 data_root）。
- `instance_lock.rs`：锁文件以「应用数据目录」为键；**迁移目录会改变锁键**，需保证新目录也参与锁并清理旧锁。
- `pet_gifs.rs`：`pet-gifs`、`pet-gifs-trash` 两个子目录。
- `WEBVIEW2_USER_DATA_FOLDER`：**当前代码未设置**（只在 `notification_diagnostics.rs:69` 读取并显示），说明 WebView2 profile 现在固定跟随 Tauri 默认（`%LOCALAPPDATA%\<id>\EBWebView`）。

### 1.4 WebView2 profile 是否可迁移

- WebView2 支持环境变量 `WEBVIEW2_USER_DATA_FOLDER`：在**创建 WebView2 环境之前**设置，profile 就落在指定目录。
- Tauri 2（wry）在 `Builder::run()` → 窗口创建时初始化 WebView2，因此必须在 **`main()` 里、`run()` 之前** `std::env::set_var(...)`（`setup` 里已晚）。
- localStorage / IndexedDB 都属于 profile，迁移 profile 即迁移前端数据；**运行中不能复制**（文件被占用），必须在应用完全退出后迁移，或下次启动时迁移。

---

## 2. 方案设计

### 2.1 统一入口 `paths.rs`

新增 `src-tauri/src/paths.rs`：

```rust
pub fn data_root() -> PathBuf      // 业务数据根（替代全部 app_data_dir 直调）
pub fn webview_profile_dir() -> PathBuf  // WebView2 profile 根（迁移后指向 data_root/WebView2）
pub fn resolve_root(exe: &Path, legacy: Option<&Path>, bootstrap: Option<&Path>, os: OsDefault) -> PathBuf
```

- 解析顺序（启动最早阶段，不依赖 Tauri app handle）：
  1. 环境变量 `MALTESE_DATA_DIR`（测试/高级用户覆盖）；
  2. 引导文件 `%APPDATA%\com.maolouis.maltese\data-dir.txt`（**只在 C 盘保留这个几十字节的小文件**，指向真实根目录）；
  3. 默认策略：exe 所在盘不是 C: → `<exe 盘符>:\MalteseData`；否则 `%APPDATA%\com.maolouis.maltese`；
  4. 旧目录检测：若 `data-dir.txt` 不存在且旧目录已有业务数据 → **继续用旧目录**（升级不强制迁移）。
- 全部 Rust 侧路径改为 `paths::data_root().join(...)`，禁止再散落 `app_data_dir()`（巡检用 `grep -rn "app_data_dir(" src-tauri/src` 应只剩 `paths.rs` 与诊断上报）。

### 2.2 设置项与 UI

- 设置页新增「数据目录」：显示当前路径、可选目录（目录选择器）、「迁移到新目录」按钮。
- 默认值按 2.1 规则；切换后提示「需要重启生效（WebView2 profile 下次启动迁移）」。
- 隐私/安全：只写路径字符串，无敏感数据。

### 2.3 迁移流程（复制 → 校验 → 保留旧目录 7 天）

1. 目标目录可写检查：创建 `.write-test` 并删除；不可写 → 回退原目录 + 中文提示（不迁移）。
2. 复制业务数据（Roaming 内容：video/agent-hub/pet-gifs/clipboard/plugins/dsh-chat 等），**跳过运行中的锁与日志**（`instance.lock`、`*.log` 可重建）。
3. 校验：逐文件比较 `size` + `mtime`，并统计文件数；不一致 → 删除目标半成品、回退。
4. 写 `data-dir.txt`（原子写：先 `.tmp` 再 rename）。
5. 旧目录保留 7 天（写 `migrated-to.txt` + 提示「旧数据已备份在 …，7 天后可手动删除」）；提供「立即删除旧数据」入口（可选）。
6. WebView2 profile：迁移标记写入 `data-dir.txt` 后，**下一次启动**时若 `data_root/WebView2` 不存在且旧 profile 存在 → 复制旧 profile（应用未启动、无占用）→ 校验 → 设置 `WEBVIEW2_USER_DATA_FOLDER`；失败则回退旧 profile 并提示。
7. 回滚：任何一步失败 → 恢复 `data-dir.txt` 为旧值、保留旧目录原样、日志 `DATA_MIGRATE_FAILED step=…` + 面板提示。

### 2.4 失败/降级策略

- 目标盘不可写：不写 `data-dir.txt`，保持原目录，提示「目标目录不可写，已继续使用原目录」。
- 复制中途失败/校验失败：清理目标目录（仅我们创建的文件），保持旧目录。
- WebView2 profile 迁移失败：回退旧 profile（C 盘），业务数据仍可留在新盘；下次启动再试。
- 权限不足/目标盘离线：启动时解析失败 → 直接回退 `%APPDATA%`，保证应用可用（fail-open 到旧目录，绝不阻断启动）。

### 2.5 兼容性

- 首次升级：`data-dir.txt` 不存在 + 旧目录有数据 → 使用旧目录（不迁移、不提示打扰）。
- `MALTESE_DATA_DIR` 只对开发和测试生效（文档标注）。
- 便携版（exe 在非 C 盘）：首次启动自动建议 `<盘符>:\MalteseData`，用户可改成别的。

---

## 3. 影响文件清单（预估）

| 文件 | 改动 | 复杂度 |
|---|---|---|
| `src-tauri/src/paths.rs`（新增） | 根目录解析、引导文件、`data_root()`/`webview_profile_dir()` | 中 |
| `src-tauri/src/main.rs` | `run()` 前 `set_var("WEBVIEW2_USER_DATA_FOLDER", …)` + 迁移前置步骤 | 中 |
| `src-tauri/src/lib.rs` | 3 处 `app_data_dir`（agent status 脚本）改为 `paths::data_root()` | 低 |
| `src-tauri/src/instance_lock.rs` | 锁路径改用 `data_root()`；迁移后旧锁清理 | 低 |
| `src-tauri/src/dsh_api.rs` | 2 处（port/token）改用 `data_root()` | 低 |
| `src-tauri/src/agent_hub.rs` | `CONFIG_DIR` 根改 `data_root()` | 低 |
| `src-tauri/src/clipboard_history.rs` | 1 处 + `clipboard-images` | 低 |
| `src-tauri/src/custom_sound.rs` | 1 处 | 低 |
| `src-tauri/src/dsh_chat.rs` | 1 处（`dsh-chat/`） | 低 |
| `src-tauri/src/pet_gifs.rs` | 2 处 + trash 目录 | 低 |
| `src-tauri/src/plugins.rs` | 1 处（`plugins/`） | 低 |
| `src-tauri/src/desktop_icons.rs` | `backup_path()` 改 `data_root()` | 低 |
| `src-tauri/src/video/session.rs` | StoreHandle 根目录改 `data_root()/video` | 低 |
| `src-tauri/src/notification_diagnostics.rs` | 诊断字段增加 `dataRoot`/`profileDir`（只读） | 低 |
| 前端设置页 | 「数据目录」显示/选择/迁移按钮 + 重启提示 | 中 |
| 迁移命令（新 `data_migration.rs`） | 复制/校验/回滚/旧目录保留 7 天 | 高 |
| `docs/` | 使用说明、迁移 FAQ、隐私说明 | 低 |
| 单测（`paths`/`data_migration`） | 路径解析、目标不可写降级、复制校验回滚 | 中 |

**`app_data_dir()` 调用点合计 14 处 / 11 个文件**（另加 `desktop_icons.rs` 手写路径），与预估 15–25 个调用点吻合。

---

## 4. 实施顺序（建议）

1. `paths.rs` + 单测（路径解析、旧目录兼容、fail-open）；
2. 把 14 处 `app_data_dir` 替换为 `data_root()`（纯机械改动，先保证行为不变）；
3. `main.rs` 设置 `WEBVIEW2_USER_DATA_FOLDER`（先在测试机验证 profile 迁移路径生效）；
4. 迁移命令 + 回滚 + 7 天保留 + 面板提示；
5. 前端设置页入口 + 重启提示；
6. 文档 + 迁移实测（Roaming 3 MB 与 profile 129 MB 各一次）。

## 5. 风险

- WebView2 profile 迁移必须在应用退出时进行，否则文件占用复制失败；需明确的「重启后迁移」流程。
- 数据目录切换后 `instance.lock` 键变化，若旧实例仍在运行可能短暂双开；迁移前需检测旧锁/进程。
- 用户把目录设到可移动盘/网络盘：磁盘离线时启动需 fail-open 回退，避免应用打不开。
- Roaming 里 `local-storage.before-restore.*` 是历史备份（1.6 MB），迁移时可选择跳过并提示。

---

## 6. 第 1 步实现记录（2026-11-19）

- src-tauri/src/paths.rs：
esolve_root（环境变量 > data-dir.txt > 默认策略）、data_root()（OnceLock 缓存、创建失败回退旧目录）、webview_profile_dir()（第 2 步启用）、migrate_if_needed()（复制→文件数/大小校验→原子写引导文件→旧目录改名 .migrated-<ts>；失败清理回退）。
- 14 处 pp_data_dir() + desktop_icons.rs 手写路径已全部收口到 paths::data_root()（grep -rn app_data_dir( src-tauri/src 已只剩注释）。
- 设置页新增「数据目录」只读展示 + 「打开目录」（data_directory_info / open_data_directory 命令）。
- 实机：启动后业务数据落到 E:\MalteseData（80 个文件），%APPDATA%\com.maolouis.maltese\data-dir.txt 内容 E:\MalteseData，旧目录改名为 com.maolouis.maltese.migrated-1795076175，新旧目录仅保留 data-dir.txt。
- 单测：paths::tests（优先级/默认策略/兼容旧目录/迁移校验与回滚/引导文件），cargo check 0。

---

## 7. 默认根调整：运行版安装目录 data/（2026-11-20）

- 默认根从「非 C 盘 <盘符>:\MalteseData」改为 **<exe 所在目录>\data**（如 E:\Maltese2\data），
  便携、换机布局一致；
- 优先级不变：MALTESE_DATA_DIR > %APPDATA%\com.maolouis.maltese\data-dir.txt > 新默认；
- 首次启动迁移：新默认目录为空且旧位置（<exe 盘符>:\MalteseData 或 %APPDATA%\com.maolouis.maltese）有数据
  → 复制 → 文件数/总大小校验 → 原子写 data-dir.txt → 旧目录改名 .migrated-<时间戳>；失败回退旧位置并记
  MIGRATION_FAILED step=copy|verify|bootstrap|create，不阻断启动；
- 只读安装（如 Program Files）不可写 → 回退 %LOCALAPPDATA%\com.maolouis.maltese\data，日志
  DATA_ROOT_FALLBACK reason=readonly；
- 单测：默认解析（exe 目录/data）、只读回退、迁移复制校验与回滚、data-dir.txt 优先级、上一版默认路径。
