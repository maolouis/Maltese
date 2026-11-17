# 交付验证报告 · 2026-11-17（B1/B2 回归修复）

> 验证对象：`4be5535 fix(settings)`（B1 设置打不开）、`ab03119 fix(overlay)`（B2 浮层开关挪动小狗）、
> `176b807 docs`（实机复核结果），HEAD = `176b807`（2026-11-17 10:51:33 +0800），分支 `refactor/external-resources`。
> 验收口径：[bug-acceptance-2026-11-17.md](bug-acceptance-2026-11-17.md)；修复记录：[bugfix-2026-11-17.md](bugfix-2026-11-17.md)。
> 本报告角色：delivery-verify（交付验证）。版本仍 2.0.2，**未 push、未打 tag**。
> 只读约束：本次不抢用户鼠标、不做交互式点击，因此「必须点才能出结论」的用例只给到客观旁证 + 人工步骤，不虚判通过。

---

## 0. 交付结论

**有条件可交付**（不是「可交付」，也不到「返工」）。

已客观达成：

1. 三条硬验证全绿（`tsc` / `cargo check` / `node --test`，均 exit 0，测试 58/58/0 fail）。
2. 版本仍 **2.0.2**（四处一致），三个提交均未触碰版本文件；**未 push**（`origin/main` 仍停在 `3d01ef5`，remote-tracking ref 文件 mtime 仍是 11-14），未打 tag。
3. B1 修复在**正在运行的实机实例**上生效：设置窗口确实被懒创建出来、`IsWindowVisible=True`、WebView2 子链完整（`Chrome_WidgetWin_1` + `Chrome_RenderWidgetHostHWND`）、内尺寸 560×780、UIA 837 个节点、滑块/按钮/文案齐全；关闭只隐藏不销毁，64s 后重开 `visible=True` 且矩形与关闭前**完全一致**；全程顶层设置窗口数恒为 1。
4. B2 浮层路径（云朵气泡 567×400）在 2ms 只读采样下**没有中间帧**：右/下锚定边保持、关闭后 `R2 == R0` 精确 0px；展开页开合多次终态复位 0px、无累积漂移；缩边唤醒为纯竖直落定、回到原位 0px；`focusd-island-position` 与主窗口真实左上角始终一致，未被浮层尺寸污染。

仍阻断「无条件可交付」：

1. 验收 §4.1 要求 B1/B2 P0 交互矩阵「人跑过 + 录屏 + R0/R1/R2 数值表」，本轮受只读约束未代跑（B2 强触发场景全部未做）。
2. 运行中的产物（`E:\Maltese2\maltese-assistant.exe`，10:46 构建）内嵌的是 **9:58:29 的 dist**，早于 `4be5535`（10:43）对 `App.tsx:5775` 提示文案的修改 → 交付前必须重建前端，否则 B1-09 的文案修复不在产物里。
3. 验证窗口内捕获到 1 次 **8px 位置变化**（10:54:08，`y 1203→1211` 并被持久化），同期另一个 agent 正在本机做交互测试，**未能归因**；需 qa-regression/人工确认是拖动测试还是浮层漂移。
4. 展开页打开时存在 **16ms（≈1 帧 @60Hz）的「先放大、后挪位」中间帧**（窗口右侧一度到 3012 > 屏宽 2560）。按验收 B2-05「录屏两帧内完成」口径不判失败，但需 30fps 录屏肉眼复核。

条件清单见第 9 节。

---

## 1. 结论速览

| 验证项 | 结果 | 关键证据 |
| --- | --- | --- |
| `tsc --noEmit` | ✅ exit 0 | 无输出 |
| `cargo check` | ✅ exit 0 | 69 warning（与 10:38/10:40 两次检查同数，均为既有 warning） |
| `node --test` | ✅ exit 0 | tests 58 / pass 58 / fail 0 |
| 版本 2.0.2（4 处） | ✅ | package.json / tauri.conf.json / Cargo.toml / README 徽章 |
| 未 push / 未打 tag | ✅ | `origin/main=3d01ef5`，ref mtime 11-14 13:37；`v2.0.2` tag 指向 11-14 的 `1c23ea1` |
| 工作区卫生 | ✅ | 验证开始时 `git status` 干净 |
| B1 设置窗口能开（实机，运行实例） | 🟡 有客观旁证 | visible=True + 完整 WebView2 子链 + UIA 837 节点 + 截图 |
| B1 关闭→重开复用 | 🟡 有客观旁证 | 10:57:47 隐藏（子链保留）→ 10:58:50 同矩形可见 |
| B1 三入口/耗时/聚焦 | ⬜ 未验证 | 只读约束，需人点（见 7.1） |
| B2 浮层锚定/复位（云朵） | 🟡 部分验证 | 567×400 → 右/下边 2544/1432 保持；R2==R0，2ms 采样无中间帧 |
| B2 悬停面板/贴边 10 次/闲逛/拖拽期间/云朵 TTL | ⬜ 未验证 | 只读约束，需人点（见 7.2） |
| 展开页单帧中间态 | 🟡 已量化 | 16ms 中间帧，窗口一度越出工作区 |
| 8px 位置变化 | 🟡 待归因 | 10:54:08，已持久化；同期有其它 agent 操作 |

---

## 2. 环境与被测产物

| 项 | 值 |
| --- | --- |
| 系统 | Windows 11 Pro build 26200 |
| 显示器 | 主屏 `\\.\DISPLAY2` 2560×1440 @(0,0)；副屏 `\\.\DISPLAY1` 1920×1080 @(-1920,0)；系统 DPI 96（100%） |
| Node / TS | v24.18.0 / typescript 5.8.3 |
| Rust | rustc 1.99.1、cargo 1.99.1 |
| 源码 HEAD | `176b8077826e5ba62bd5d9f44005b0339c39453d` |
| 运行进程 | `maltese-assistant` PID 60820，启动 10:51:06，进程数 **1** |
| 运行产物 | `E:\Maltese2\maltese-assistant.exe`，28,468,736 B，构建 10:46:22，FileVersion 2.0.2 |
| 产物对应提交 | `eb1a41e`（10:45:16；内容等价于 `4be5535`+`ab03119` 的重排前提交）——与 HEAD 的差异只有 `src-tauri/src/lib.rs` 的 **3 行注释** 与文档，Rust 行为等价 |
| 产物内嵌前端 | `dist` 构建于 09:58:29，**早于** `4be5535`（10:43:40）的 `App.tsx:5775` 文案修改 |
| 旧产物备份 | `E:\Maltese2\maltese-assistant.exe.c327044.bak`（10:00:06） |

产物/前端一致性核查（实测，不是推测）：

```text
git diff --name-only eb1a41e HEAD
  docs/bugfix-2026-11-17.md
  src-tauri/src/lib.rs        ← 仅注释（3 行 +、1 行 -）
（src/ 无差异）

dist/assets/index-nDAanCGP.js（09:58:29）字节级检索：
  「右键菜单里重试」   → offset 851120（旧文案，仍在内嵌产物里）
  「请从托盘菜单」     → 未找到（4be5535 的新文案不在产物里）
```

> 结论：**运行的 exe 与 HEAD 在 Rust 侧等价，前端少一句 B1-09 文案**。发布前需 `pnpm build` + `pnpm tauri build --no-bundle` 重建；本机按任务要求**不跑** `vite build`（安全软件会拦 esbuild 临时文件）。

---

## 3. 三条硬验证（原始输出关键行）

### 3.1 `node node_modules\typescript\bin\tsc --noEmit`

```text
(无输出)
TSC_EXIT=0
```

### 3.2 `cd src-tauri; cargo check`

```text
warning: field `guard` is never read
   --> src\video\session.rs:351:5
warning: associated items `memory`, `root`, and `memory_only` are never used
   --> src\video\store.rs:127:12
warning: constant `LAZY_WINDOW_LABELS` is never used
   --> src\window_factory.rs:209:7
warning: `maltese-assistant` (lib) generated 69 warnings
    (run `cargo fix --lib -p maltese-assistant` to apply 1 suggestion)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.07s
warning: the following packages contain code that will be rejected by a future version of Rust:
    imap-proto v0.10.2
CARGO_EXIT=0
```

- 1.07s 是**增量**检查（源码自 10:46 构建后未变）；warning 数 69 与修复过程中 10:38 / 10:40 两次 `cargo check` 完全一致（`generated 69 warnings`），即**没有新增 warning**，符合验收「cargo 仅允许既有 warning」。
- 未使用 `--target x86_64-pc-windows-msvc`：本机就是 Windows host，默认 target 即 msvc，等效。

### 3.3 `node --test tests/*.test.mjs`

```text
ℹ tests 58
ℹ suites 0
ℹ pass 58
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 537.2605
TEST_EXIT=0
```

满足验收 §4.1.4「测试数 ≥58 且 0 fail」。13 个测试文件，未发现放宽断言/改阈值（三个修复提交均未触碰 `tests/`）。

---

## 4. 版本与仓库卫生

### 4.1 版本仍为 2.0.2

| 位置 | 值 |
| --- | --- |
| `package.json` | `"version": "2.0.2"` |
| `src-tauri/tauri.conf.json` | `"version": "2.0.2"` |
| `src-tauri/Cargo.toml` | `version = "2.0.2"` |
| `README.md` 徽章 | `https://img.shields.io/badge/version-2.0.2-orange` |

`4be5535` / `ab03119` / `176b807` 三个提交的 `--name-only` 里**都没有**版本文件（实测 `(none)`）。

### 4.2 工作区

验证开始时：

```text
$ git status --porcelain=v1
(clean)
```

本报告与截图是本轮新增的两个未跟踪文件，提交后即为「只剩文档」。

### 4.3 未推送提交（`git log origin/main..HEAD --oneline`，共 23 条）

```text
176b807 docs: 记录 B1/B2 修复的实机复核结果
ab03119 fix(overlay): 浮层开关不再挪动小狗（B2 回归）
4be5535 fix(settings): 修复懒创建设置窗口打不开（B1 回归）
c327044 fix(startup): 多实例启动 P0/P1 修复（显示解耦、握手、懒加载、单实例锁、端口回退、剪贴板原子写）
4166fef docs: remove completed asset-split item from startup issue list
f0aa1d9 refactor: keep shared pet GIFs duo-only
126009e docs: record real-machine verification for startup and asset split
a81b8f3 fix: keep duo GIFs in shared pool
c78fa22 refactor: split shared pet GIFs by character
038067a fix: 缩略图墙行高塌陷与桌宠窗口几何失败不显示
c087d16 feat(chat): 小白 / 小鸡毛 / 双狗各加聊天头像
56e4d07 fix(pet): 轮播范围默认全状态，并展示全部轮播 GIF
5ad2c02 feat(team): 步骤级团队进度看板（scripts/team-progress.mjs + .arts/team-progress.json + 文档）
69ab05d fix: 主动消息静默（情境一次性锁 + 依赖漏 proactiveLevel + 未来时间戳/记账顺序）与启动首帧显示不全
bebfd63 feat(pet): 微博表情包整库并入 shared 轮播池
11c3c44 feat(pet): 接入微博表情包的 6 个新动作
4a8db7c feat: 小狗新增六项技能（待办计时/日记/播放音乐/开应用/调设置/联网搜索），DSH 后端也能调用技能
71a9a6b refactor(assets): 微博表情包按动作分目录，新增 6 个动作类
9397a01 feat(assets): 补齐微博表情包第1-29弹与特辑，加情绪分类
2edfd57 feat(assets): 收录线条小狗官方微博表情包第30-33弹
635baf2 feat: complete plugin verification and pet interactions
a1f14fd fix(pet): 气泡打开时按窗口真实矩形锚定，闲逛动画不再拽动小狗
8561cac feat(plugins): 关系插件新增工作状态/心情同步；刷视频新增在视频下评论；附三插件验收记录
```

### 4.4 确认未 push

```text
HEAD                    = 176b807
origin/main             = 3d01ef5   （2026-11-14 13:36:54 docs: 新增 handoff-2026-11-14…）
.git/refs/remotes/origin/main mtime = 2026-11-14 13:37:08   ← 11-17 没有更新
git reflog show origin/main@0 = 3d01ef5 … update by push（11-14）
git tag --points-at HEAD = （空）
最新 tag = v2.0.2  → 1c23ea1（2026-11-14 13:32:23），不含本轮提交
当前分支 refactor/external-resources 无 upstream（git push 不带参数会直接报错）
```

即：**`origin/main` 未前进、未打 tag、未发 Release**，本轮 23 个提交全部只在本地。

---

## 5. 运行中实机抽查（只读）

### 5.1 顶层窗口与子窗口链（EnumWindows，PID 60820）

```text
TOP hwnd=0x20067A class=[Tauri Window] visible=True rect=2285,1211,2544,1432 size=259x221
    title=[Maltese 线条小狗桌面助手]
TOP hwnd=0x19009C class=[Tauri Window] visible=True rect=992,314,1568,1133 size=576x819
    title=[Maltese · 桌宠设置]
TOP hwnd=0x1D0F60 class=[FocuSDWeChatReminderSource] visible=False
TOP hwnd=0x3E008E class=[Tauri Window] visible=True rect=24,1212,304,1440 size=280x228 title=[]   ← bongo 窗口
TOP hwnd=0xA411D4 class=[tray_icon_app] visible=False                                              ← 托盘宿主
TOP hwnd=0xF015C class=[com.maolouis.maltese-sic] visible=True size=16x16
```

子窗口链（只列 WebView2 关键类）：

```text
PARENT [Maltese 线条小狗桌面助手] visible=True
  CHILD WRY_WEBVIEW              visible=True size=259x221
  CHILD Chrome_WidgetWin_0       visible=True size=259x221
  CHILD Chrome_WidgetWin_1       visible=True size=259x221  title=[Maltese 线条小狗桌面助手]
  CHILD Chrome_RenderWidgetHostHWND visible=True size=259x221
  CHILD Intermediate D3D Window  visible=True size=259x221

PARENT [Maltese · 桌宠设置] visible=True
  CHILD WRY_WEBVIEW              visible=True size=560x780
  CHILD Chrome_WidgetWin_0       visible=True size=560x780
  CHILD Chrome_WidgetWin_1       visible=True size=560x780
  CHILD Chrome_RenderWidgetHostHWND visible=True size=560x780
  CHILD Intermediate D3D Window  visible=True size=560x780
```

对照 [bugfix-2026-11-17.md](bugfix-2026-11-17.md) 记录的「修复前」形态（`visible=False`、只有
`WRY_WEBVIEW` + `Chrome_WidgetWin_0`（0×0）、没有 `Chrome_WidgetWin_1`/`RenderWidgetHost`），
本次实机**是修复后的形态**：窗口可见 + WebView2 控制器初始化完成 + 内尺寸 560×780（外部 576×819 = 边框）。
矩形 992,314,1568,1133 在 2560×1440 上居中（中心 1280,723.5，屏幕中心 1280,720，误差 ≤2px），
符合「首次创建居中」的预期。

计数（10:53–11:03 多次采样）：`Maltese 线条小狗桌面助手` 顶层窗口恒为 **1**，`Maltese · 桌宠设置` 恒为 **1**。

### 5.2 设置窗口内容（UI Automation，只读）

```text
root name=[Maltese · 桌宠设置] class=[Tauri Window] offscreen=False
descendants=837
texts: 桌宠设置 / 调整小狗的显示、互动和陪伴方式，改完自动保存。 / 显示 / 小狗不透明度 / 收起大小 /
       聊天框高度 / 动画流畅度 / 点击时 Q 弹 …
sliders: 小狗不透明度 100% / 收起大小 1.60× / 聊天框高度 480px /
         小狗数量（含主狗） 1只 / Bongo 大小 280px / Bongo 不透明度 98%
buttons=183（流畅 / 均衡 / 普通 / 省电 / 点击时 Q 弹 / 小白 / 小鸡毛 / 小白和小鸡毛 / Bongo 模式 /
         水平镜像 / 鼠标穿透 Bongo / 底部居中 …）
```

截图（`PrintWindow` + `PW_RENDERFULLCONTENT`，只截设置窗口，不含桌面）：
[delivery-verify-2026-11-17-settings.png](delivery-verify-2026-11-17-settings.png)
（576×819，56,589 B，平均亮度 237.2，93% 采样点非黑 —— 是正常浅色 UI 而非黑屏/空窗口。
本 agent 无图像查看能力，建议人眼扫一眼确认无空白块。）

> 结论：设置窗口**不只是「存在」，而是内容完整可交互的窗口**（对应 B1-01 Then 的「内容完整」）。
> 但「从哪个入口点的、点了多久出现」本 agent 没有触发，不能替人断言。

### 5.3 `focusd-island-position`（LevelDB 只读快照，未改用户数据）

路径：`%LOCALAPPDATA%\com.maolouis.maltese\EBWebView\Default\Local Storage\leveldb`
（以 `FileShare.ReadWrite` 共享读，未写、未删、未 compact）

```text
000488.log（活跃 WAL，mtime 10:54:08，1414 B）
  hit@46   : focusd-island-position  {"x":2285,"y":1203}
  hit@223  : focusd-island-position  {"x":2285,"y":1203}
  hit@754  : focusd-island-position  {"x":2285,"y":1203}
  hit@931  : focusd-island-position  {"x":2285,"y":1203}
  hit@1108 : focusd-island-position  （无值，键更新标记）
  hit@1283 : focusd-island-position  {"x":2285,"y":1211}      ← 最新值
000482.ldb（较早）: focusd-island-position {"x":-1093,"y":473}
000484.ldb（较早）: focusd-island-position {"x":-217,"y":879}
```

判定：

1. **最新值与真实窗口左上角完全一致**：localStorage `2285,1211` == 主窗口 `rect=2285,1211,…`。说明持久化位置没有被浮层矩形（727×480 / 567×400 的左上角）污染 —— 正是 B2 根因 3（拖拽收尾把放大矩形写进 `custom_position`）要防的那种脏值，当前没有。
2. 历史紧凑段里的 `-1093` / `-217` 落在**副屏**合法坐标（DISPLAY1 在 x=-1920..0），不是异常值；没有 `999999` / 浮层尺寸之类的荒谬坐标。
3. 本进程运行期间（10:51:06 起）该键只发生 **一次**变化：`y 1203 → 1211`（10:54:08），之后 4 次云朵/面板开合、1 次缩边唤醒都**没有再写**位置（`000488.log` mtime 仍停在 10:54:08）—— 开合不再污染位置记忆。

> 遗留：那次 `1203→1211`（8px 下移）需要归因，见 5.5。

### 5.4 单实例与锁（只读旁证）

```text
maltese-assistant 进程数 = 1（全程）
%APPDATA%\com.maolouis.maltese\instance.lock：207 B，mtime 10:51:06
  以 FileShare.None 打开 → 被另一个进程占用（拒绝）→ 锁被该实例持有
  以 FileShare.ReadWrite 读 → 仍被 LockFileEx 拒绝（字节区间锁）
show-request 文件：不存在（无待处理的第二实例唤起）
```

即：单实例锁已生效、无残留唤起请求。**未**做「启动第二个 exe」的双开测试（会唤起小狗、抢前台，属于交互动作）。

### 5.5 被动采样（不抢鼠标，只 `GetWindowRect` / `IsWindowVisible`）

两轮采样：80ms 轮询（10:56:27–10:58:57）与 2ms 轮询（10:59:38–11:02:38）。基线：

```text
R0（收起态）= 2285,1211,2544,1432  (259×221)      ← 比 bugfix 文档里的 2285,1203,2544,1424 整体下移 8px
```

| 时间 | 事件 | 矩形（L,T,R,B） | 尺寸 | 判定 |
| --- | --- | --- | --- | --- |
| 10:56:27.682 | 缩边（贴屏幕下沿） | 2285,1278,2544,**1499** | 259×221 | 下沿超出屏幕 59px，缩边态 |
| 10:56:42.257→.536 | 缩边唤醒（竖直动画 4 步） | …1259 → …1228 → …1213 → **1211,1432** | 259×221 | ✅ 纯竖直落定（几何文档「只有纯竖直才允许落定」），`R2==R0` 0px |
| 10:56:55.921 | 展开页打开（**中间帧**） | 2285,1211,**3012,1691** | 727×480 | ⚠️ 右沿越界 452px（屏宽 2560）；下一次 80ms 采样（.014）已归位。同类事件用 2ms 采样实测中间帧存活 **16ms** |
| 10:56:56.014 | 展开页终态 | **1817,952,2544,1432** | 727×480 | ✅ 右边 2544、下边 1432 与 R0 一致（面板向左/上） |
| 10:56:58.040 | 收起回落 | **2285,1211,2544,1432** | 259×221 | ✅ `R2==R0` 0px |
| 10:57:47.049 | 设置窗口隐藏 | 992,314,1568,1133，`visible=False` | 576×819 | ✅ 子链保留但隐藏 = 关闭仅隐藏不销毁 |
| 10:57:47.932 | 展开页再开 | 1817,952,2544,1432 | 727×480 | ✅ 锚定边保持 |
| 10:57:49.177 | 展开页高度变化 480→430 | 1817,1002,2544,1432 | 727×430 | ✅ 下沿 1432 不动 |
| 10:57:57.654 | 收起（**中间帧**） | 1817,1002,**2076,1223** | 259×221 | ⚠️ 先缩尺寸后归位，下一次 80ms 采样（107ms 后）已归位 |
| 10:57:57.761 | 收起终态 | 2285,1211,2544,1432 | 259×221 | ✅ 0px |
| 10:58:03.695 / 10:58:06.707 / 10:58:15.111 | 展开→改高→收起 | 1817,952 / 1817,1002 / 2285,1211 | 727×480→727×430→259×221 | ✅ 下沿始终 1432，终态 0px |
| 10:58:42.143 → .693 → .786 | 展开 → 中间帧 → 收起 | 1817,952 → 1817,952,**2076,1173** → 2285,1211 | 727×480→259×221 | ⚠️ 中间帧同上，终态 0px |
| 10:58:49.563 | 展开 | 1817,952,2544,1432 | 727×480 | ✅ |
| 10:58:50.966 | 收起 + **设置窗口重新可见** | 2285,1211 + 992,314,1568,1133 `visible=True` | | ✅ 关闭后 64s 重开，**矩形与关闭前完全一致** |
| 10:59:37.565 | **云朵气泡**（567×400，向左上展开） | 1977,1032,**2544,1432** | 567×400 | ✅ 右沿 2544、下沿 1432 与 R0 一致 |
| 10:59:40.602 | 云朵关闭 | **2285,1211,2544,1432** | 259×221 | ✅ `R2==R0` 0px |
| 10:59:49.006 → 11:00:10.964 | 展开页开→收起（期间改高度 520/430/480） | 1817,952 / 1817,912 / 1817,1002 / 1817,952 → 2285,1211 | | ✅ 下沿 1432，终态 0px；2ms 采样**未**捕到中间帧 |
| 11:02:34.752 | 云朵气泡再次出现 | 1977,1032,2544,1432 | 567×400 | ✅ 同上锚定 |

2ms 采样给出的中间帧量化：

```text
 10271.0ms rect=2285,1211,3012,1691 wh=727x480 vis=1 since_prev=8404ms
 10286.2ms rect=1817,952,2544,1432  wh=727x480 vis=1 since_prev=16ms   ← 中间帧只存活 16ms
 14119.5ms rect=1817,1002,2544,1482 wh=727x480 vis=1 since_prev=1308ms
 14135.3ms rect=1817,952,2544,1432  wh=727x480 vis=1 since_prev=16ms   ← 16ms
  1866.8ms rect=2285,1211,2544,1432  wh=259x221 vis=1（云朵关闭，前后无中间帧）
 32305.2ms rect=2285,1211,2544,1432  wh=259x221 vis=1（展开页收起，无中间帧）
```

结论：

- **浮层路径（云朵 567×400）是原子的**：2ms 采样没有任何中间帧，右/下锚定边保持、关闭 0px 复位。这与 B2 修复里「打开/关闭改用一次 `SetWindowPos`（`set_window_rect_atomic`）」一致。
- **展开页的阶段几何仍是「先 `set_size`、后 `set_position`」两步**：捕获到 16ms（60Hz 下 1 帧）的中间矩形，一次窗口右沿越出工作区 452px（3012 > 2560），另一次下沿越出 42px（1482 > 1440）。按验收 B2-05「录屏两帧内完成」的字面口径不算失败（16ms < 2 帧 @30fps），但比浮层路径弱一档，建议后续把 `apply_stage_geometry` 也换成 `set_window_rect_atomic`（P2，不在本次返工要求内）。

### 5.6 待归因观察：10:54:08 的 8px 位移

```text
10:53 采样：主窗口 2285,1203,2544,1424     （localStorage = 2285,1203）
10:54:08  ：localStorage 新增写入 {"x":2285,"y":1211}
10:54:49  ：主窗口 2285,1211,2544,1432     （localStorage = 2285,1211）
之后到 11:03  ：一直停在 2285,1211，所有开合/唤醒都精确回到这个值
```

- 位移量 8px、方向向下，且被写进位置记忆（说明 app 认为这是一次真实位置变化）。
- 同一时段 `qa-regression` agent 正在本机做交互测试（webview renderer 54060 于 10:52:28 创建 = 设置窗口冷开；10:56 起有缩边唤醒/展开页/云朵操作），本 agent 已发消息求证未获回复。
- 影响：若这是**拖动/放置测试**，属正常行为（R-09 期望位置可改）；若是**浮层开合或唤醒动画导致的漂移**，则是 B2/R-09 的 P0 问题，结论要改成「返工」。因此列为交付条件 3。

---

## 6. 对照验收清单逐条

图例：✅ 已验证 ｜ 🟡 有客观旁证/部分验证 ｜ ⬜ 未验证（只读约束，附人工步骤）｜ ❌ 失败（本轮无）

### 6.1 B1 设置打不开（10 条）

| 用例 | P | 结论 | 客观证据 | 缺口 / 人工怎么做 |
| --- | --- | --- | --- | --- |
| B1-01 冷开（岛内入口） | P0 | 🟡 | 本进程内设置窗口确实冷创建：WebView2 renderer PID 54060 创建于 10:52:28（启动后 82s）；窗口 `visible=True`、内 560×780、UIA 837 节点、截图非空；主窗口全程保持收起态 259×221（若真走了 fallback，岛内会切到展开的「布局」页，实测没有） | 入口与耗时未由我触发。人工：冷启动后双击小狗 → 顶部导航「设置」，秒表量 ≤3s；确认岛内不跳「布局」页 |
| B1-02 冷开（快捷入口页） | P0 | ⬜ | 同上窗口能力已具备 | 需点：展开 →「快捷入口」→ 右上「设置」；确认右上不出现「设置窗口打开失败…」。**注意产物文案是旧的**（见 2 节），复测要重建前端 |
| B1-03 托盘入口（含隐藏态） | P0 | ⬜ | 托盘宿主窗口 `tray_icon_app` 存在、进程单实例 | 需点：小狗可见时、托盘「隐藏到托盘」后，各点托盘右键「配置桌宠」；确认隐藏态能开、关设置后狗仍隐藏 |
| B1-04 重复点击聚焦不新建 | P0 | 🟡 | 全程「Maltese · 桌宠设置」顶层窗口数恒为 **1**（10:53–11:03），窗口矩形成立，说明不是每次点击都新建 | 需点：设置已开时切到别的应用 → 从入口再点 5 次（间隔 1s），确认提到前台、任务栏不新增按钮、表单不重置 |
| B1-05 关闭后重开 | P0 | 🟡（强） | 10:57:47.049 `visible=False`（**子窗口链保留但隐藏、位置不变** = 只隐藏未销毁）→ 10:58:50.966 `visible=True`，矩形 992,314,1568,1133 **与关闭前完全一致**；这 64s 内顶层设置窗口数一直 1 | 需人：X 关 3 轮，量重开耗时（应 ≤2s）、改一项设置确认不重置、看有无残影、确认 WebView2 进程数不增长（当前本 app 有 8 个 msedgewebview2 进程、3 个 renderer：主窗口/ bongo / 设置） |
| B1-06 与小狗显示状态解耦 | P0 | ⬜ | — | 需点：托盘隐藏小狗 → 托盘「配置桌宠」→ 关设置后确认狗仍隐藏 |
| B1-07 首开/复用耗时 | P1 | ⬜ | 旁证：进程内设置窗口只有 1 个 renderer（54060），隐藏后重开无新顶层窗口 → 复用迹象 | 需人：首开秒表 ≤3s、第二次起 ≤800ms、开关 5 次后窗口/进程数不增长 |
| B1-08 其它懒创建入口 | P1 | 🟡（静态） | 代码层已统一为 async：`lib.rs:974 open_settings_window`、`:1020 show_pet_bubble`、`:1058 resize_pet_bubble`、`:1464 open_billiards_window`、`:1481 pin_page_to_desktop`、`plugins.rs:400 open_plugin_window`、`translation.rs:56 toggle_translation_window` | 需人：逐个点翻译/插件/台球/固定标签页/独立气泡，确认都能开、不再有同步建窗口的死锁形态 |
| B1-09 失败反馈不误导 | P1 | 🟡（静态） | 源码 `App.tsx:5775` 已改为「设置窗口打开失败，请从托盘菜单「配置桌宠」再试一次」（不再是「右键菜单」） | **运行产物里仍是旧文案**（dist 9:58 < 提交 10:43，字节级检索确认）；失败注入未做。需重建前端后复测 |
| B1-10 多屏/150% | P2 | ⬜ | 本机双屏但 DPI 96（100%）；设置窗口居中正确、未越界 | 需人：150% 缩放 / 副屏各跑 B1-01、B1-04 |

### 6.2 B2 气泡点开后小狗移动（10 条）

| 用例 | P | 结论 | 客观证据 | 缺口 / 人工怎么做 |
| --- | --- | --- | --- | --- |
| B2-01 悬停互动面板 | P0 | ⬜ | 未捕获到 587×540 的悬停面板（本轮观测到的是 567×400 云朵与 727×480 展开页） | 需人：鼠标移入小狗 → 展开（≤500ms）→ 停 1s → 移开 → 等 420ms + 稳 500ms；录 R0/R1/R2 |
| B2-02 贴右边缘向左 + 抗累积 | P0 | ⬜ | 旁证：狗本身贴在右侧（右沿 2544 / 屏 2560），实测云朵与面板确实翻到**左/上**（1977 或 1817 起） | 需人：拖到最右 → 开合 10 次，量第 10 次 `R2` 与 `R0` 各边 ≤2px |
| B2-03 云朵气泡（消息/更新/剪贴板） | P0 | 🟡 | 两次云朵 567×400（10:59:37.6、11:02:34.8）：右沿 2544、下沿 1432 与 R0 一致；一次关闭 10:59:40.6 `R2==R0` 0px、2ms 采样无中间帧 | TTL 计时与文字换行未验证。需人：复制 ≥100 字触发剪贴板云朵 → 量 R0/R1/R2、核对消失时间与设置一致（±1s）、长文本不被裁 |
| B2-04 右键入口 | P1 | ⬜ | — | 需人：右键小狗（当前进聊天页）→ 量位置，收起回落 |
| B2-05 气泡→展开页→关闭回落 | P0 | 🟡 | 展开页 ↔ 收起 6 次以上：终态一律精确回到 2285,1211,2544,1432（0px）；右/下锚定边 2544/1432 全程保持 | 含 16ms 单帧中间态（5.5），需 30fps 录屏确认肉眼不可见；「先缩回去再弹开」的频闪需录屏判定 |
| B2-06 残影/裁切/空白 | P0 | 🟡 | 6 次开合后主窗口都回到 259×221，未出现「停在浮层尺寸」；子窗口尺寸与父窗口同步 | 像素残影/空白块要录屏或截图比对；需人复核 |
| B2-07 缩边唤醒后立即开气泡 | P1 | 🟡 | 缩边 1499 → 唤醒竖直 1259→1228→1213→1211（纯竖直落定），落定位置精确；`localStorage` 未被缩边临时 y 污染 | 「唤醒后**立刻**开气泡」未做。需人：设置开启全屏避让/缩边 → 缩到屏幕底 → 唤醒后马上开气泡再关 |
| B2-08 闲逛动画期间开气泡 | P1 | ⬜ | 代码层：`roam_island_step` 在 `OVERLAY_ACTIVE` 期间直接返回、`create_overlay_snapshot` 先取消动画并等 ≤80ms（静态） | 需人：开随机闲逛 → 动画途中开气泡 → 看狗是否被拽到终点 |
| B2-09 多屏 / 150% | P2 | ⬜ | 本机 100% + 双屏，未切 150% | 需人：副屏/150% 跑 B2-01、B2-05 |
| B2-10 连续压力（10 次开合） | P0 | 🟡 | 观测到的 6+ 次开合全部终态 0px，无累积；窗口数/进程数无增长；`focusd-island-position` 未再被写 | 10 次连续（悬停 + 云朵交替）需人跑 + 任务管理器看内存 |

### 6.3 回归风险清单（12 条）

| ID | P | 结论 | 证据 / 缺口 |
| --- | --- | --- | --- |
| R-01 多实例双开 | P0 | 🟡 | 进程数 1；`instance.lock` 207 B 被该进程持有（其它句柄 `FileShare.None` 打开被拒）；无 `show-request` 残留。**未**真启动第二个 exe（会唤起小狗、抢前台） |
| R-02 启动显示 | P0 | 🟡 | 本进程 10:51:06 启动后主窗口 `visible=True`、WebView2 子链完整、259×221 完整小狗槽，无空白/半窗。10 次冷启动/强杀重启未做 |
| R-03 懒加载窗口首开 | P0 | 🟡 | 设置窗口懒创建首开可用（10:52:28 renderer + UIA 内容 + visible）；隐藏后重开同矩形、无新顶层窗口。翻译/插件/台球/固定标签页未逐个首开 |
| R-04 插件窗口 | P1 | ⬜ | 需人打开插件窗口，看卡片/事件/按钮，关闭再开 |
| R-05 气泡自动隐藏 | P0 | 🟡 | 云朵气泡按自身生命周期关闭（10:59:37.6 出现 → 10:59:40.6 关闭，约 3s；TTL 设置值未知）；鼠标停在气泡上不消失、悬停 420ms 收起未验证 |
| R-06 托盘显示/隐藏 | P0 | ⬜ | 托盘宿主窗口存在；三轮回合与位置 ≤2px 需人点 |
| R-07 开机自启 | P1 | ⬜ | 未查注册表 RUN 项 |
| R-08 全屏避让/缩边 | P1 | 🟡 | 缩边 → 唤醒还原精确（纯竖直）；全屏视频/游戏触发未测 |
| R-09 拖拽/固定角落/位置记忆 | P1 | 🟡 | 位置记忆 `2285,1211` 与真实窗口一致、开合不写新值；拖动/锁定角落未测；10:54:08 的 8px 变化待归因（5.6） |
| R-10 视频摘要云朵（独立 bubble 窗口） | P1 | ⬜ | 未触发「刷到 N 条…」云朵 |
| R-11 焦点与置顶 | P1 | ⬜ | 未验证打开气泡不抢输入焦点；设置窗口获得焦点是预期 |
| R-12 更新提示 | P2 | ⬜ | 未触发更新云朵 |

---

## 7. 未验证项与人工步骤（可直接照做）

### 7.1 B1

1. **B1-01 / B1-02（P0，两入口）**：关掉现在开着的设置窗口 → 冷启动（`pnpm tauri dev` 或 `E:\Maltese2\maltese-assistant.exe`）→ 双击小狗展开 → 点顶部「设置」，秒表记时；关掉 → 走「快捷入口」页右上「设置」再测一次。看：≤3s、标题对、内容可点、无 fallback。
2. **B1-03 / B1-06（P0）**：托盘右键「隐藏到托盘」→ 再托盘「配置桌宠」，确认能开且狗仍隐藏；关闭设置后狗仍隐藏。
3. **B1-04（P0）**：设置开着时点任务栏切走 → 从任一入口连点 5 次（间隔 1s），数顶层窗口是否始终 1、是否被提到前台、滚动位置是否保持。
4. **B1-05（P0）**：改「气泡停留时长」6s→8s → 点 X 关 → 托盘再开，循环 3 次；每次 ≤2s、值还在、无残影、`msedgewebview2` 进程数不涨。
5. **B1-07（P1）**：记录首开与第 2 次起的耗时（3s / 800ms 阈值）。
6. **B1-10（P2）**：150% 缩放、副屏各跑 B1-01 / B1-04。

### 7.2 B2（含强触发场景）

1. **B2-01（P0）**：小狗放屏幕中左（左右各留 ≥400px）→ 记录 `R0`（用验收 0.3 脚本）→ 鼠标移入 → 完全展开记录 `R1` → 移开 → 等 420ms + 稳 500ms 记录 `R2`。判据：`R1.left == R0.left`；`R2` 各边 ≤2px。
2. **B2-02（P0，贴边 10 次开合）**：把狗拖到屏幕最右（现在就在最右附近）→ 开合 10 次，第 10 次关闭稳定后量 `R2`，各边 ≤2px。重点看「每开合一次被往里挤一点」。
3. **B2-03（P0，云朵 TTL）**：复制 ≥100 字 → 云朵出现记 `R1` → 等它按设置 TTL 消失（默认 6s，±1s）→ 稳 500ms 记 `R2`。文字换行不裁切。
4. **B2-05（P0）**：悬停气泡打开 → 点气泡里「待办/音乐/聊天」切展开页 → 收起 → 再悬停开合。**手机 30fps 录屏**，逐帧看切页/收起瞬间。
5. **B2-06（P0）**：连续 5 次开合，每次关闭后截图，看残影/裁切/空白。
6. **B2-07（P1，缩边唤醒）**：设置 → 布局开启全屏避让/缩边 → 狗缩到屏幕底 → 移入唤醒 → **立刻**悬停开气泡 → 关闭。看是否先跳到角落再回来。
7. **B2-08（P1，闲逛中开）**：开随机闲逛 → 等动画进行中 → 开悬停气泡。看狗是否被拽到动画终点。
8. **B2-10（P0，连续压力）**：10 次开合（悬停 + 云朵交替），最终 ≤2px，窗口/进程数不涨、内存不明显涨。
9. **B2-05 附加（本报告发现）**：展开页打开瞬间有 16ms 单帧「先放大后挪位」，用 30fps 录屏确认肉眼是否可见；若可见判 B2-05 失败。

### 7.3 R（优先级顺序）

R-01 双开（启动第二个 exe，2s 内退出、托盘仍 1 个图标、A 被带到前台）→ R-02 冷启动 10 次 + 强杀 3 次 → R-03 翻译/插件/台球/固定标签页首开 → R-05 悬停 420ms 收起、鼠标停在气泡上不消失 → R-06 托盘显隐 3 轮 → 其余 R-04/07/08/09/10/11/12 按清单逐条。

---

## 8. 对照验收判定门槛

### 8.1 「可以交付」七条（验收 §4.1）

| # | 条款 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | B1 P0 全过（01–06）+ P1 数据 + 150% | ❌ 未满足 | 05/04 有强旁证，01/02/03/06 未交互验证；150% 未测 |
| 2 | B2 P0 全过 + P1 失败 ≤1 条 | ❌ 未满足 | 03/05/10 有旁证，01/02/06 未交互验证 |
| 3 | R-01/02/03/05/06 全过 | ❌ 未满足 | 均有旁证，均未做完整交互回归 |
| 4 | tsc / cargo / node --test 全绿，≥58 测试 0 fail | ✅ 满足 | 见第 3 节 |
| 5 | 改动范围合规、未改版本、未 push/tag/Release、提交信息写清两个 bug | 🟡 基本满足（1 条待确认） | 版本未改 ✅；未 push/tag ✅；B1、B2 分开提交 ✅。**范围**：`4be5535` 除允许范围外还改了 `plugins.rs`、`translation.rs`、`show_pet_bubble`/`resize_pet_bubble`/`open_billiards_window`/`pin_page_to_desktop` 的命令签名（同根因的必要辐射，修复记录已说明），需产品确认这不算「夹带重构」 |
| 6 | 修复记录写进 docs/ | ✅ 满足 | `docs/bugfix-2026-11-17.md`（根因、文件:行、验证、剩余风险、实机复核） |
| 7 | 至少一台 Windows 实机跑过主用例 + 截图/矩形数值 | 🟡 部分 | 本机已有一轮实机复核（bugfix 文档附录）+ 本报告的运行中客观证据；完整交互矩阵仍缺 |

### 8.2 「必须返工」八条（验收 §4.2）

| # | 条款 | 本轮是否命中 |
| --- | --- | --- |
| 1 | B1 任一真实入口仍打不开 / 只能靠 fallback | 未命中（窗口确实能创建并可见），但入口矩阵未跑完，不能判「不命中」为最终结论 |
| 2 | B1 空白/闪烁/不可交互/第二个窗口/关后无法重开/首开 >5s | 未命中（内容完整、窗口数 1、关后同矩形重开） |
| 3 | B2 位移 >2px / 回不到原位 / 累积漂移 / 裁切残影 / 被动画拽走 | 未命中（观测到的开合终态全部 0px）；16ms 单帧中间态待录屏判定 |
| 4 | R-01/02/03/05/06 失败 | 未发现失败，未跑全 |
| 5 | 构建/测试失败、改版本、push/tag/Release | 未命中 |
| 6 | 改测试断言/放宽阈值 | 未命中（三个提交没碰 `tests/`） |
| 7 | 新体验降级（每次重新 show、延迟 >1s、抢焦点） | 未发现（重开复用同矩形、浮层原子）；抢焦点需人工确认 |
| 8 | 只靠重试/延时掩盖 | 未命中（根因是主线程同步建窗口死锁 + 两侧各读一次矩形，修复是结构性的：async 命令、共享快照、原子 SetWindowPos、浮层期间几何独占） |

即：**没有命中返工条款**，但「可以交付」的交互矩阵未跑完 → 只能判「有条件可交付」。

---

## 9. 条件清单（全部满足才可发布）

1. **B1 交互矩阵**：人工（或 qa-regression）跑完 B1-01～B1-06，记录入口、耗时、窗口数、fallback 情况；B1-07/09 数据补齐。全过才解除。
2. **B2 交互矩阵**：跑完 B2-01/02/03/05/06/10 与 P1 的 02/07/08，含**强触发场景**：贴边 10 次开合、缩边唤醒后立即开、闲逛动画中开、拖拽在浮层期间收尾、云朵 TTL；每条给出 R0/R1/R2 数值 + 30fps 录屏。
3. **归因 10:54:08 的 8px 位移**（5.6）：确认是拖动/放置测试 → 关闭该条件；若是浮层/唤醒导致 → 结论改判**返工**（B2/R-09 P0）。
4. **录屏复核展开页 16ms 单帧中间态**：若肉眼可见「面板先弹出去再回来」→ 按 B2-05 判失败 → 返工（或至少把 `apply_stage_geometry` 改成原子 `SetWindowPos` 后重测）。
5. **重建交付产物**：`dist` 落后 HEAD 一个文案提交，发布前 `pnpm build` + `pnpm tauri build --no-bundle`，再用新 exe 复跑 10 分钟冒烟（B1-01/03/04/05、B2-01/03、R-01/02）。本机不跑 `vite build`（安全软件拦 esbuild 临时文件），建议由用户/CI 在干净环境构建。
6. **范围确认**：请产品确认 `4be5535` 顺带把 6 个懒创建窗口命令改 async 属于同根因必要修复（B1-08 口径），而不是「夹带重构」。
7. **交付顺序**：以上全过后再 `git push`（当前未 push、未打 tag、版本仍 2.0.2），并补 `docs/releases/` 说明。

---

## 10. 回滚与提交

| 提交 | 内容 | 回滚 |
| --- | --- | --- |
| `4be5535` | B1：`open_settings_window` 等懒创建命令改 async、托盘菜单走 async_runtime、翻译/插件窗口命令重构、`window_factory::ensure` 文档、`App.tsx:5775` 文案 | `git revert 4be5535`（会连带 `plugins.rs` / `translation.rs` / `lib.rs` 的调用方签名，需一起回滚；不牵连 `tauri.conf.json`，本次没改它） |
| `ab03119` | B2：`create_overlay_snapshot`、`plan_island_overlay` 先钉快照、`set_island_overlay` 复用快照 + 原子 `SetWindowPos`、`show_island` 已可见不重算、拖拽收尾保护、兜底收回、排障日志 | `git revert ab03119`（只动 `src-tauri/src/lib.rs` + 文档） |
| `176b807` | 文档：实机复核结果 | 无需回滚 |

两者可独立回滚；`tauri.conf.json` 的窗口列表与 `window_factory.rs` 本次未成对修改（设置窗口仍是运行时懒创建）。

---

## 附录 A 原始命令输出（关键行）

```text
[tsc]
(no output)
TSC_EXIT=0

[cargo check]
warning: `maltese-assistant` (lib) generated 69 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.07s
warning: the following packages contain code that will be rejected by a future version of Rust:
    imap-proto v0.10.2
CARGO_EXIT=0
（对比 10:38 的修复中检查：generated 69 warnings / Finished in 0.84s → warning 数未增加）

[node --test]
ℹ tests 58
ℹ pass 58
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 537.2605
TEST_EXIT=0

[git]
HEAD=176b807
ORIGIN_MAIN=3d01ef5
BRANCH=refactor/external-resources
git status --porcelain=v1 → (clean)
git rev-list --count origin/main..HEAD → 23
git tag --points-at HEAD → (empty)
最新 tag v2.0.2 → 1c23ea1 2026-11-14 13:32:23
```

## 附录 B 证据文件

| 证据 | 位置 | 说明 |
| --- | --- | --- |
| 设置窗口截图（PrintWindow，仅窗口区域） | [delivery-verify-2026-11-17-settings.png](delivery-verify-2026-11-17-settings.png) | 576×819，56,589 B，平均亮度 237.2 |
| 80ms 窗口采样原始日志 | `%TEMP%\delivery-verify-watch.log` | 32 行状态变化，10:56:27–11:02:36 |
| 2ms 窗口采样原始日志 | `%TEMP%\delivery-verify-fast.log` | 12 行，含 16ms 中间帧量化 |
| 采样脚本（只读） | `%TEMP%\delivery-verify-watch.ps1`、`%TEMP%\delivery-verify-fast.ps1` | 只调用 `EnumWindows`/`GetWindowRect`/`IsWindowVisible` |
| LevelDB 只读扫描 | 本报告 5.3 | 共享读，未写用户数据 |

> 备注：`%TEMP%` 下三个文件是本机临时证据，不入库；需要长期留档可复制到 `docs/`。

---

_报告生成：2026-11-17 11:03（+0800），delivery-verify。只读验证，未改用户数据、未 push、未改版本号。_