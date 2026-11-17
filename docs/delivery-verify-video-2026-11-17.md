# 视频插件 P0 修复 + UI 精简 · 交付验证（2026-11-17）

> 验证对象：`d8d03ad fix(video): 修复刷视频 P0（残留浏览器/登录窗/失败提示/日志）并精简面板`
> （2026-11-17 13:22:34 +0800）。验收口径与缺陷清单：[qa-video-plugin-2026-11-17.md](qa-video-plugin-2026-11-17.md)
> （U1–U10、J1–J9、§6 dev-fix 修复状态）；用户文档：[video-plugin-usage.md](video-plugin-usage.md)。
> 版本仍 **2.0.2**；本轮未 push、未打 tag。验证方式：三条硬命令 + 源码/CSS 静态核对 + 运行中实例与
> 磁盘数据只读抽查（**没有抢鼠标、没有点击面板**）。

**注意 HEAD 已前移**：验证时分支 HEAD = `301d7b0`（另一 agent 的纯文档提交，+142 行
`docs/multi-instance-linkage-design.md`）。`git diff d8d03ad HEAD` 只有这一个文档，
**代码零差异**，所以本轮三条命令的结论对 `d8d03ad` 同样有效。

---

## 0. 交付结论

**有条件可交付**（修复方向与 UI 精简达标；缺「鼠标点击链路」和「登录窗真实出现」两类实机证据，
另有 1 条「采集到的是首页标题而不是视频条目」的实质缩水需要补验）。

已客观达成：

1. 三条硬验证全绿：`tsc` exit 0、`cargo check` exit 0（69 条既有 warning，与上一轮同数）、
   `node --test` **tests 92 / pass 92 / fail 0**（新增 `tests/video-panel-logic.test.mjs` 14 条，
   直接 import 真实模块 `src/plugins/video/videoPanelLogic.ts`）。
2. 版本四处仍 **2.0.2**，`d8d03ad` 未触碰版本文件；**未 push**（`origin/main` 仍 `3d01ef5`，
   remote-tracking ref 文件 mtime 仍是 11-14 13:37）、HEAD 无 tag。
3. **J1 静态计数达标**：首屏常驻交互控件 **6 个**（严格「按钮+输入+下拉」口径 4 个），
   条件控件 +3，常见状态 6–8 ≤ 8；旧版 21 个已降到目标区间。
4. **J2 按 CSS 估算达标**：岛内面板空态 **≈223px**，/430px 窗口 = **0.52 屏**、/480px = 0.46 屏；
   常见内容组合 0.6–0.9 屏；最坏组合（长小结 3 行×3 条 + 错误条 + 待投递按钮 + 15% 估算误差）
   ≈1.1–1.16 屏，仍在 ≤1.2 屏内（贴近阈值，需 UIA 实测确认）。
5. **J3 达标**：双击小狗 → 顶部「插件」页签 → 「开始看」= 3 步，`开始看` 在面板第一行，
   **无需滚动**。
6. **U4/U5/U10 有运行时可验证证据**：`video/logs/video-20261117.jsonl` 真实落了 2 条
   `PORT_BUSY`（UTF-8 中文），`GET /api/video/diagnostics` 非空；会话记录出现新的
   `stopReason:"browserUnavailable"` 与 `stopReason:"userStop"`（条目 1），不再是旧版一律
   `crash`；`video-browser.json` 实例标记已被删除、机器上**没有**残留 `video-profile` 的
   Chrome 进程（U10/停止后清理生效）。

仍阻断「无条件可交付」：

1. **面板鼠标点击链路未验证**：J1/J2 的 UIA 实测、J3 的真实点击、U3「收起重开后错误条仍在」
   都需要人或 QA 用真鼠标走一遍（dev-fix 自述 UIA 被同机进程抢焦点打断）。
2. **「打开登录窗」真实窗口出现未验证**（U2 的 `wait_for_visible_window` 分支）——这是新用户
   第一步，必须实机确认 5s 内出现可见窗口或给出中文错误。
3. **U6 缩水**：唯一一条「有内容」的会话 `bili-20261117-119fc1` 的条目标题是
   `哔哩哔哩 (゜-゜)つロ 干杯~-bilibili`、`canonicalUrl=https://www.bilibili.com/` ——
   这是**B 站首页标题**，不是一条视频。所以「条目 1」只能说明「采集链路通、能读到页面事实」，
   不能说明「看视频并给视频小结」已可用；真正的视频条目采集仍需在已登录 profile 上验证。
4. 交付产物与源码存在 **5 分钟级时间差**：exe（13:20:58）内嵌的 `dist` 构建于 **13:12:41**，
   晚于它的前端源码改动有 `videoPanelLogic.ts`（13:17:52）。关键文案全部命中（见 §3.4），
   判定为「实质对齐」，但发布前仍应重建前端 + exe。
5. 磁盘上还有 **2 条 `endedAt/stopReason = null` 的空会话**（13:16:12、13:21:22），是测试中
   应用被替换/重启时进程被杀导致；前端会显示成「已结束」（不误导，但建议启动时给未收尾会话补原因）。

条件清单见 §8。

---

## 1. 三条硬验证（原始关键行）

### 1.1 `node node_modules\typescript\bin\tsc --noEmit`

```text
(无输出)
TSC_EXIT=0
```

### 1.2 `cd src-tauri; cargo check`

```text
warning: associated items `memory`, `root`, and `memory_only` are never used
   --> src\video\store.rs:127:12
warning: constant `LAZY_WINDOW_LABELS` is never used
   --> src\window_factory.rs:220:7
warning: `maltese-assistant` (lib) generated 69 warnings
    (run `cargo fix --lib -p maltese-assistant` to apply 1 suggestion)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.10s
warning: the following packages contain code that will be rejected by a future version of Rust:
    imap-proto v0.10.2
CARGO_EXIT=0
```

69 条 warning 与上一轮（B1/B2 修复）**完全同数** → 本轮 Rust 改动没有引入新 warning（既有 warning
都是 `video/store.rs`、`window_factory.rs` 等历史遗留）。

### 1.3 `node --test tests/*.test.mjs`

```text
...
✔ 错误码有中文文案 (0.1442ms)
ℹ tests 92
ℹ suites 0
ℹ pass 92
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 585.2034
TEST_EXIT=0
```

- 预期 92 条，实测 **92 / 92 / 0 fail**，与 dev-fix §6.3 一致。
- 新增 `tests/video-panel-logic.test.mjs`：`select-string '^test\('` 计 **14 条**，与 dev-fix
  「新增 14 条」一致；其余文件合计 78 条（92−14），无删改既有测试（`git show --stat d8d03ad`
  里 `tests/` 只有这一个新增文件）。
- 该文件 `import ... from "../src/plugins/video/videoPanelLogic.ts"`，是**真实模块**的单测，
  不是复制逻辑；覆盖 U3/U5/U7/U8/J6 的文案与决策表。

---

## 2. 版本与仓库卫生

### 2.1 版本仍为 2.0.2（四处）

| 位置 | 值 |
| --- | --- |
| `package.json` | `"version": "2.0.2"` |
| `src-tauri/tauri.conf.json` | `"version": "2.0.2"` |
| `src-tauri/Cargo.toml` | `version = "2.0.2"` |
| `README.md` 徽章 | `version-2.0.2-orange` |

`git show --name-only d8d03ad` 里**没有**版本文件（实测 `(none)`）。

### 2.2 工作区

```text
$ git status --porcelain=v1      # 13:27:22
(clean)
```

（13:26 时曾看到另一个 agent 的 `docs/multi-instance-linkage-design.md` 未跟踪，它随后以
`301d7b0` 提交，与本轮无关；本报告只提交自己的文件。）

### 2.3 未推送提交（`git log origin/main..HEAD --oneline`，共 40 条，最新在上）

```text
301d7b0 docs: 多实例联动设计初版（情绪传染/Bongo 呼应 MVP）      ← 验证期间另一 agent 提交
d8d03ad fix(video): 修复刷视频 P0（残留浏览器/登录窗/失败提示/日志）并精简面板   ← 本次验证对象
fb44af1 docs(qa): 视频插件可用性验收（冗长点/不可用点/MVP/交付判定）
e2fd8cb docs: 记录误删 GIF 的定位/恢复过程与删除安全化验收口径
0057085 feat(pet): 删除 GIF 前必须确认，并支持撤销与「恢复最近删除」
2d9c346 docs(team): 固定 4 角色编制与写入边界，停止一次性 agent 派活
2122a6f fix(pet-gifs): 修表情方格「拖不动」并精简表情设置区
7773a86 docs: 聊天 vs 主动聊天诊断（单槽位/思考预算/技能决策）
98da63b docs(qa): 补充 D1-D5 处置状态与证据（修复提交 17b3541）
17b3541 fix(qa): 修 QA 缺陷清单 D1-D5（视频文档/账号状态/拖拽插入线/岛内表情轮播）
d38a2c2 docs: QA 实机验收报告（表情方格墙 / 插件点击说明 / 视频文档）
22f079e docs: B2 强触发矩阵录制（只读采样，12 格矩阵 + E1～E18 被动序列）
bb73d3d fix(island): 唤醒后的过渡帧不再被拖拽写成持久化位置（8px 位移）
bf36a49 docs(plugins): 新增视频插件使用说明（登录/参数/评论/数据/排障）
ba0910a feat(plugins): 插件说明改为点击展开，浮层避开卡片操作区
eab2133 feat(settings): 表情轮播改为方格展示 + 拖拽排序 + 右键删除
2d97517 docs: 交付验证报告（B1/B2 回归修复，HEAD 176b807）
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

### 2.4 确认未 push

```text
origin/main            = 3d01ef5（2026-11-14 13:36:54 docs: 新增 handoff-2026-11-14…）
refs/remotes/origin/main mtime = 2026-11-14 13:37:08     ← 11-17 没有更新
git tag --points-at HEAD = （空）；最新 tag v2.0.2 → 1c23ea1（11-14）
当前分支 refactor/external-resources 无 upstream
```

→ **未 push、未打 tag、未发 Release**。

---

## 3. J1 / J2 / J3 静态核对（含计算过程）

数据来源：`src/plugins/video/VideoAutomationPlugin.tsx`（410 行）、`VideoDigestList.tsx`（77 行）、
`VideoChannelCard.tsx`（79 行）、`VideoAutomationPlugin.css`（492 行）、`useVideoPluginState.ts`
（278 行）、`App.tsx:2155-2164`（「插件」页签）、`App.tsx:4970-4989`（`VideoPage`）。

### 3.1 J1：首屏交互控件数

识别口径：面板 `section.video-automation` 内、**不展开任何 `<details>`** 时可见的可交互元素
（按钮 / select / input / textarea / `<summary>` 折叠标题）。

| # | 控件 | 元素 | 位置 | 默认出现 | 出现条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 开始看 / 停下 | `button.video-automation__primary` | tsx:220-226 | ✅ | 常驻（唯一主按钮） |
| 2 | 平台 | `<select>`（B站推荐流 / 抖音实验） | tsx:247-254 | ✅ | 常驻 |
| 3 | 打开登录窗 | `button.video-automation__secondary` | tsx:259-266 | ✅ | 常驻 |
| 4 | 刷新历史 | `button.video-automation__link` | VideoDigestList:30-32 | ✅ | 常驻（小结区标题行） |
| 5 | 高级设置 | `<summary>` | tsx:287-288 | ✅ | 常驻（折叠） |
| 6 | 评论（可选…） | `<summary>` | tsx:383-384 | ✅ | 常驻（折叠） |
| 7 | 我已登录 | `button.video-automation__secondary` | tsx:267-275 | ⬜ | 仅当所选账号 `status === "awaitingLogin"` |
| 8 | 查看待投递小结 | `button.video-automation__secondary` | VideoDigestList:35-39 | ⬜ | 仅当 `pendingCount > 0` |
| 9 | 历史会话（N） | `<summary>` | VideoDigestList:61-73 | ⬜ | 仅当 `sessions.length > 0`（**只有点过「刷新历史」才会加载**，见 useVideoPluginState:226-234） |

计数结论：

- **常驻 = 6**（其中严格「按钮 + 输入 + 下拉」= 4：开始/停下、平台、打开登录窗、刷新历史）；
  与 dev-fix §6.4「静态计数 6」一致。
- **条件全开 = 9**；常见状态 6–8：点过刷新 +1 → 7；有待投递 +1 → 8；账号等待登录 +1 → 9。
- 判定：**达标（≤8）**——默认 6、常见 7–8；只有「账号等待登录 + 有待投递 + 已加载历史」三个
  条件同时成立时才会到 9（超 1 个）。这是低频组合，但建议把「我已登录」并进「登录：…」那一行
  的文案里（或轮询后自动判定）以彻底消除第 9 个。
- 对比旧版：旧面板首屏 21 个交互控件（QA §1），现在 6 个，且参数/账号档案/自检/清空全部收进
  「高级设置」，观后感草稿/投稿/直播整块删除（`dist` 里已检索不到这些文案，见 §3.4）。

### 3.2 J2：面板总高 / 窗口高（按 CSS 估算）

测量口径：面板容器 `.video-automation` 的高度（与 QA 当年测 1503px 的口径一致）。
两个渲染上下文：

- **岛内展开（深色，QA 实测就是这里，宽度 391px）**：`.island__expanded .video-automation`
  = `padding:10px 12px; gap:8px; border:1px`（css:364-372）；字体 11.5/12.5/10.5px。
- **插件窗口（浅色）**：`.plugin-window/.video-page/.plugins-page .video-automation`
  = `padding:14px 16px; gap:10px`（css:9-17）；字体 12.5/14/12px。

岛内展开、默认（无错误条、无小结、折叠全关）逐块算：

| 块 | 计算依据 | 高度 |
| --- | --- | --- |
| 容器 padding + border | 10×2 + 1×2 | 22 |
| 状态条 | `.video-automation__statusbar{min-height:36px}`，主按钮 30px | 36 |
| 平台/登录行 | `.video-automation__row`，内部 select `height:32px` | 32 |
| 最近小结（空态） | padding 8×2 + 标题行 ~14 + gap 6 + 空态文案 1 行（10.5px×1.6≈16.8） | 52.8 |
| 高级设置（折叠） | border-top 1 + padding-top 8 + summary 行 ~15 | 24 |
| 评论（折叠） | 同上 | 24 |
| 5 个子块之间 gap | 8×4 | 32 |
| **合计** | | **≈223px** |

宽度核对（避免「平台/登录行折行」低估）：内容宽 391−24=367px；「平台」21 + 6 + select ≈84 +
登录文案 ≈126 + 「打开登录窗」≈75 + 2×8 gap ≈ 328 < 367 → **单行**，行高按 32 计成立。

内容变体（同一容器）：

| 状态 | 追加/替换 | 合计 | /430 屏 | /480 屏 |
| --- | --- | --- | --- | --- |
| 空态（默认，刚打开） | — | **223** | **0.52** | **0.46** |
| 失败态（常驻错误条，U3） | +gap 8 + 错误条（border 2 + padding 16 + 1 行 16.3）≈34 | 265 | 0.62 | 0.55 |
| 有小结（主题 + 3 条 ×2 行 + 生成方式） | 空态文案 16.8 → ≈154 | 360 | 0.84 | 0.75 |
| 有小结 + 错误条 + 「查看待投递」 | 再 +42 +34 | 436 | 1.01 | 0.91 |
| 最坏（3 条各 3 行、估算 +15%） | ≈196 替换 154，整体 ×1.15 | ≈500 | 1.16 | 1.04 |

- 窗口高取值：QA 基线 **430px**；本机设置「聊天框高度」= **480px**（实机观察展开窗口 727×480），
  两个都算。
- 判定：**达标（≤1.2 屏）**。默认 0.46–0.52 屏；常见 0.6–0.9 屏；最坏 ≈1.0–1.16 屏，贴近阈值
  —— 只要真实标题不是三条都占 3 行就不会超；仍需 UIA 实测确认（QA 的 1503px 是实测，本次是估算，
  误差来源：真实标题长度、窗口宽度、字体实际行高）。
- 对比旧版：1503px / 430px = **3.5 屏** → 估算 0.46–1.16 屏，量级上从 3.5 屏降到 ≤1.2 屏。

### 3.3 J3：到「开始采集」的点击数 / 是否要滚动

入口代码：`App.tsx:2155-2164` 岛内顶部页签「插件」（`t.island.plugins` = zh-CN「插件」，
`src/i18n/locales/zh-CN.ts:246`）→ `onPageChange("video")` → `App.tsx:9242 {page === "video" && <VideoPage />}`
→ `VideoPage` 顶部就是 `VideoAutomationPanel`（App.tsx:4970-4985）。

| 步骤 | 操作 | 点击 |
| --- | --- | --- |
| 1 | 双击小狗展开浮层（QA 口径算 1 步；物理上是 2 次点击） | 1（物理 2） |
| 2 | 顶部页签「插件」 | 1 |
| 3 | 面板第一行「开始看」 | 1 |
| 合计 | | **3 步（物理 4 次点击）** |

- `开始看` 在 `.video-automation__statusbar`（面板第一个子块，容器顶部 10px），**无需滚动**即可点到
  —— 满足「≤3 次 + 不需要滚动」。
- 补充：旧版面板把「开始看」压在第 3 区（QA §1 #3），且小结/历史/评论在 3.5 屏下方；新版把
  「开始看」提到第一行，这是本次精简最实质的改动。
- 独立插件窗口入口（`PluginWindow.tsx:28-29`）需要先安装 `video-automation` 插件，本机
  `%APPDATA%\com.maolouis.maltese\plugins` 里没有 → 本机只有主窗入口（与 QA 环境一致）。

### 3.4 产物（dist）与本轮源码的一致性抽查

`E:\Maltese2\maltese-assistant.exe`（PID 58828，13:20:58 构建，28,559,872 B，FileVersion 2.0.2）
内嵌的 `dist` 是 **13:12:41** 构建的 `index-CbMKCNyk.js`（990,180 B）。字节级检索：

```text
新增/保留文案              出现
高级设置                    ✅ offset 742217
最近小结                    ✅ 735495
关闭专用浏览器               ✅ 739252
评论（可选…）                 ✅ 745841
本轮失败                    ✅ 731615
调试端口被占用                ✅ 725812
浏览器状态未知                ✅ 733133
检测到上次留下的专用浏览器      ✅ 733340
专用浏览器没启动起来（调试接口不可用） ✅ 732200
本轮中断了，原因见下方历史记录。 ✅ 731252
删除的旧区块                 出现
观后感草稿                   ❌ -1（已删）
打开投稿页                   ❌ -1（已删）
直播中心                     ❌ -1（已删）
```

- 时间关系：`dist` 13:12:41 → `videoPanelLogic.ts` 13:17:52（晚于 dist）→ Rust `session.rs`
  13:19:59 → exe 13:20:58 → 提交 13:22:34。**前端最后一次改动晚于 dist 构建**，但所有关键行为
  文案都能在 bundle 里命中，所以判「实质对齐、建议重建」，不判「产物内容不符」。
- `src-tauri` 侧：`session.rs`(13:19:59) 与其它 Rust 文件都早于 exe 构建时间 13:20:58 → Rust 代码
  与产物对齐。

---

## 4. U1–U10 逐条

图例：✅ 已验证 ｜ 🟡 部分验证（静态/数据能证，交互不能）｜ ⬜ 未验证（需人）

| 编号 | 级别 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| **U1** 残留专用浏览器占 profile，开始必失败 | P0 | 🟡 | 静态：`browser.rs` 新增 `reuse_decision`(:60) / `same_profile`(:105) / `wait_for_cdp`(:126) / `pid_alive_browser`(:140) / `find_reusable`(:152) / `close_profile_instance`(:269)；`session.rs` 启动三路径 **owned → 上次残留 → 清理后重开**（:697 `owned_reusable`、:713 `find_reusable` 接管、:721 `close_profile_instance`、:744 `launch`、:753 `wait_for_cdp(8s)`、:757 失败即 `fail_start` 清理+写日志，:765 写实例标记）。运行时：`video-browser.json` 实例标记已被清理（文件不存在），机器上**没有**残留 `video-profile` 的 Chrome；13:19 那轮会话 `channelCapability:"full"` 且 `itemCount:1`，没有再出现 `CDP_UNAVAILABLE` | 「复用 QA 留下的 9333/pid 12488」这个细节来自 dev-fix 的实测记录（证据文件 `work/`，本轮已被清理/重启覆盖），我只能验证「结果没再失败、标记与残留都清理干净」 |
| **U2** 「打开登录窗」假成功 | P0 | 🟡 | 静态：`session.rs:1513-1603` 现在按「复用实例 → `focus_browser_window` 不行就 CDP `/json/new` 前置 → 仍不行报 `LOGIN_WINDOW_NOT_VISIBLE`」；新启动分支 `wait_for_cdp(8s)` + `write_marker` + `wait_for_visible_window(pid, 5s)`（browser.rs:334）任一失败立即 `process.close()` + `clear_marker()` + 返回中文错误；前端 `VideoAutomationPlugin.tsx:97-119` 只在 `await invoke(...)` 成功后才提示「已打开…」，失败走 `describeVideoError` | **真实窗口是否出现未验证**（dev-fix 也列为未覆盖）。需人：点「打开登录窗」，5s 内是否真的出现一个新的可见浏览器窗口并停在平台首页；再在有残留实例时点一次，确认是复用/前置而不是假成功 |
| **U3** 失败提示丢失 | P0 | 🟡 | 静态：`resolvePanelError()`（videoPanelLogic.ts:57-74）优先 `localError` → 回落 Rust snapshot 的 `errorCode/error` → `interrupted` 兜底；`phaseText()` 新增 `interrupted`/`blocked`（:95-98）；4 条单测覆盖。运行时：`GET /api/video/status` 里 `errorCode:"PORT_BUSY"` + 中文 `error` **常驻在 snapshot**，正是前端回落来源 | 「收起浮层→重开→错误条仍在」的 UI 行为需人验证（面板要真实渲染一次） |
| **U4** 失败不写日志 | P1 | ✅ | 运行时：`%APPDATA%\com.maolouis.maltese\video\logs\video-20261117.jsonl` 存在，UTF-8 两条 `PORT_BUSY`（`level:"error"` + sessionId + 中文 message）；`GET /api/video/diagnostics?limit=10` 返回对应 `PORT_BUSY` 条目。静态：`set_runtime_error`(:534→store.log:555)、`abort_start`(:782-804)、`fail_start`(:513)、`finish`(:1227) 都落日志；前端诊断改为 4s 轮询后端 `video_diagnostics`（useVideoPluginState:105-120） | 无（「重启后仍在」由文件落盘保证） |
| **U5** 失败记成「异常崩溃」 | P1 | ✅ | `model.rs` `StopReason` 新增 `BrowserUnavailable/LoginRequired/ParseFailed`；`finish()`(:1128-1132) 对 0 条按 `LOGIN_REQUIRED` / 无错误细分；前端 `sessionReason()`(:122-139) + `STOP_REASON_LABEL` 全中文，3 条单测。运行时：`bili-20261117-29987f` = `stopReason:"browserUnavailable"`、`errorCode:"PORT_BUSY"`；`bili-20261117-119fc1` = `stopReason:"userStop"`、`itemCount:1`（旧版这里是 `crash` + 0 条） | 小瑕疵：磁盘上仍有 2 条 `endedAt/stopReason=null` 的空会话（见 §6.4） |
| **U6** 从未成功采集到内容 | P1 | 🟡 | 运行时：`119fc1` 确实 `itemCount:1`（首次非 0），说明 CDP 采集链路能跑 | **这条「1 条」是 B 站首页标题**：`title:"哔哩哔哩 (゜-゜)つロ 干杯~-bilibili"`、`canonicalUrl:"https://www.bilibili.com/"`、`durationSeconds:6`、`visits:7` → 不是视频条目。真正「看视频并解析视频条目/生成视频小结」**仍未验证** |
| **U7** 英文错误码 | P2 | ✅ | 运行时：`/api/video/status` 的 `channel.degradedReason` 已是中文「只能读标题，无法判断完成度，不作兴趣结论」；前端 `failureReasonText()`(:159-162) 把 `noResponse/portBusy/...` 全翻中文，通道卡移进「高级设置」（tsx:356-360 在 `<details>` 内），英文码只留 `title` tooltip（VideoChannelCard:70） | 无 |
| **U8** `[object Object]` | P2 | ✅ | `describeVideoError()`(:33-51) 解析 Rust `VideoError` 对象取 `code+message`，`[object Object]`/空串走中文兜底；评论/账号/配置/登录/清空全部改走它（tsx:80/93/113/134/151/161/172/195）；3 条单测直接断言不出现 `[object Object]` | 无 |
| **U9** 参数不落盘无提示 | P2 | ✅ | 高级设置参数区首行文案「观看参数仅本次运行有效：重开面板或重启后会回到已保存值…」（tsx:290-292），保存后 notice「本轮观看参数已生效（重开面板会回到已保存值）」（tsx:148）；文档同步（video-plugin-usage.md「五、已知限制」） | 无（「只写内存」是既定设计，现在有显式提示） |
| **U10** 退出后不关专用浏览器 | P2 | ✅ | 静态：`finish()` 内 `close_browser_instance()`（session.rs:1288）、`stop()`(:836/892/950/983)、`RunEvent::Exit`（lib.rs:4495-4506）、`fail_start`(:513)、面板按钮 `关闭专用浏览器`→`video_close_browser`（lib.rs:4485）/`session.rs:1453-1454`。运行时：`%LOCALAPPDATA%\Maltese\video-browser.json` **不存在**；无 `video-profile` 的 chrome 进程残留 | 「应用退出时」这条靠代码路径（RunEvent::Exit）保证，未做「退出应用看浏览器是否关」的实机（会重启应用，属于交互动作） |

---

## 5. J1–J9 达标情况

| # | 判据 | 结论 | 依据 / 说明 |
| --- | --- | --- | --- |
| J1 | 首屏交互控件 ≤8 | ✅ 达标（默认 6） | §3.1：常驻 6、条件 +3、常见 6–8；严格按钮/下拉口径 4；三条件同在时 9（超 1，建议消掉「我已登录」这个条件控件） |
| J2 | 面板总高 ≤1.2 屏 | ✅ 估算达标 | §3.2：空态 223px（0.52/0.46 屏）、常见 0.6–0.9 屏、最坏 ≈1.0–1.16 屏；旧版 1503px = 3.5 屏 |
| J3 | 到开始采集 ≤3 次、无需滚动 | ✅ 达标 | §3.3：双击小狗 → 「插件」页签 → 「开始看」= 3 步；主按钮在面板第一行 |
| J4 | 开始后 ≤20s 有结果或常驻错误 | 🟡 部分 | 后端：`CDP_READY_TIMEOUT=8s`（browser.rs:22）→ 失败立刻 `fail_start` + `set_runtime_error` + `finish`，总耗时 <10s；实测 `PORT_BUSY` 失败在 **1s 内**返回（13:21:46 → 13:21:47）。前端：常驻错误条来自 snapshot（U3）。**「用户真的能在 20s 内看到中文错误条」需人点一次** |
| J5 | 失败可排障 | ✅ 达标 | §4 U4：日志文件 + `/api/video/diagnostics` 都实测非空 |
| J6 | 残留浏览器恢复 | ✅ 达标 | 复用/清理/重开三态（`reuse_decision` + 单测 1 条 + 状态文案 1 条）、面板「专用浏览器状态 + 关闭专用浏览器」按钮、运行时标记已清理 |
| J7 | 0 条显示真实原因 | ✅ 达标 | `sessionReason()` 映射（browserUnavailable/loginRequired/parseFailed/riskControl/…）；运行时会话 `29987f` 记 `browserUnavailable` 而不是 `crash`；单测 3 条 |
| J8 | 错误文案全中文 | ✅ 达标 | 单测 5+ 条 + 运行时 API 全中文（status/diagnostics 实测） |
| J9 | 端到端最小演练 | 🟡 部分（API 驱动） | 「开始 → 采集 1 条 → 停 → 浏览器关闭」在 API 驱动下跑通（会话 119fc1 + 标记清理）；但 **UI 点击链路**与**登录窗真实出现**未验证，且「采集 1 条」是首页标题（U6 缩水） |

---

## 6. 运行时 / 数据面证据（只读）

### 6.1 运行实例

```text
maltese-assistant PID 58828，13:21:36 启动
E:\Maltese2\maltese-assistant.exe  28,559,872 B  构建 13:20:58  FileVersion 2.0.2
备份：maltese-assistant.exe.video.bak（12:45:27 = QA 那版）、.b1b2.bak（11:32:59）、.c327044.bak（10:00:06）
视频数据根：%APPDATA%\com.maolouis.maltese\video\（index.json / sessions / logs 均有 13:16–13:21 的新写入）
```

### 6.2 DSH API（`GET`，只读；端口 3218 取自 `dsh-api-port.txt`）

```text
GET /api/video/status   HTTP 200
  {"phase":"stopped","running":false,"sessionId":"bili-20261117-29987f",
   "errorCode":"PORT_BUSY","error":"本机调试端口被占用，无法启动小狗浏览器。",
   "channel":{"type":"windowTitle","capability":"basic",
              "degradedReason":"只能读标题，无法判断完成度，不作兴趣结论"},
   "itemCount":0,"pendingCount":0,"provider":"bilibili"}

GET /api/video/sessions?limit=10   HTTP 200
  bili-20261117-29987f  stopReason=browserUnavailable  errorCode=PORT_BUSY  itemCount=0
  bili-20261117-219847  stopReason=null  endedAt=null   itemCount=0     ← 见 6.4
  bili-20261117-119fc1  stopReason=userStop             itemCount=1
  bili-20261117-c99f09  stopReason=null  endedAt=null   itemCount=0     ← 见 6.4
  bili-20261117-b1a124  stopReason=crash  errorCode=CDP_UNAVAILABLE      ← QA 那轮的旧会话
  …（11/14 五条 durationLimit，均 itemCount=0，旧构建）

GET /api/video/diagnostics?limit=10  HTTP 200
  [{"at":1794892907,"code":"PORT_BUSY","level":"error",
    "sessionId":"bili-20261117-29987f","message":"本机调试端口被占用，无法启动小狗浏览器。"}]
```

### 6.3 诊断日志（UTF-8 校验，非乱码）

```text
%APPDATA%\com.maolouis.maltese\video\logs\video-20261117.jsonl（352 B，前 3 字节 123,34,97 = '{,"'，无 BOM）
{"at":1794892883,"sessionId":"bili-20261117-219847","channel":null,"level":"error","code":"PORT_BUSY",
 "message":"本机调试端口被占用，无法启动小狗浏览器。"}
{"at":1794892907,"sessionId":"bili-20261117-29987f","channel":null,"level":"error","code":"PORT_BUSY",
 "message":"本机调试端口被占用，无法启动小狗浏览器。"}
```

（PowerShell 控制台按 ANSI 解码会显示成乱码，用 `[System.Text.Encoding]::UTF8.GetString` 读出是正常中文；
文件本身 UTF-8 无 BOM。）

### 6.4 「采集到 1 条」到底是什么（U6 缩水证据）

`bili-20261117-119fc1.json`（13:19:16 → 13:19:32，`stopReason:"userStop"`，`itemCount:1`，
会话级 `channelCapability:"full"`，说明 CDP 通道是通的）：

```json
"items": [{
  "title": "哔哩哔哩 (゜-゜)つロ 干杯~-bilibili",
  "canonicalUrl": "https://www.bilibili.com/",
  "durationSeconds": 6, "watchedSeconds": 10, "visits": 7,
  "sourceConfidence": 1.0
}]
```

→ 抓到的是**首页标题**这一条页面事实（`canonicalUrl` 指到 `www.bilibili.com/` 根路径），不是视频；
解析路径还没有在真正的视频页上产出条目。这条证据**不能**用来支持「U6 已修」。

另：`c99f09`（13:16:12）与 `219847`（13:21:22）两条 `endedAt=null / stopReason=null` 的会话，是
应用在会话进行中被替换重启（exe 13:20:58、进程 13:21:36）导致没收尾。前端 `sessionReason(null)`
会显示「已结束」，不误导，但建议**启动时把上次未结束的会话补一个 stopReason（例如 `crash`/「异常结束后台」）**，
否则历史里会出现「已结束 · 条目 0」这种没有信息量的行。

---

## 7. 未验证项与人工步骤

### 7.1 必须人工补的（阻断「可交付」）

1. **面板鼠标点击链路（J1/J2/J3 + U3）**：冷启动 → 双击小狗 → 点顶部「插件」页签 →
   ① 数首屏可交互控件（应为 6，最多 8）；② 量 `.video-automation` 容器高度（应 ≤1.2×窗口高，
   窗口高取「聊天框高度」设置值）；③ 点「开始看」应在首屏直接点到、不用滚动；
   ④ 制造一次失败（例如占端口或断网）→ 收起浮层 → 重开面板，确认错误条**仍在**（U3）。
2. **「打开登录窗」（U2）**：点按钮 → **5s 内必须看到一个新的可见浏览器窗口**；
   失败时应出现中文错误条而不是「已打开」提示。建议两种状态各测一次：无残留实例、有残留实例。
3. **真实视频采集（U6/J9）**：在专用浏览器里登录一次 → 点开始 → 20s 内看 `条目 > 0`，
   并且打开 `sessions\` 里的最新会话确认 `items[0].canonicalUrl` 是**具体视频**（`www.bilibili.com/video/BV...`）
   而不是首页；再点停下，确认专用浏览器进程消失、历史里是「手动停止 · 条目 N」。
4. **U1 残留场景回归**：人为留一个旧专用浏览器（或直接杀应用不关浏览器）→ 再点开始，
   确认面板/日志里出现「复用上次实例」或「先清理残留再启动」，而不是 8s 超时。

### 7.2 可选但建议（P2）

5. **U10 退出关闭**：开一轮采集 → 直接退出应用 → 确认专用浏览器进程随之退出、标记文件被删。
6. **下发文案走查**：`video-plugin-usage.md` 已按新 UI 重写（两段结构：首屏 + 高级 + 评论），
   与代码一致；发布前请产品再读一遍（尤其「参数仅本次有效」「评论不校验是否真的发布」两句）。
7. **空会话收尾**（§6.4）：启动时给未结束会话补原因，避免历史里「已结束 · 条目 0」。

---

## 8. 条件清单（全部满足才可「可交付」）

1. §7.1 的 1–3 项由人或 QA 用真鼠标跑通，留 `R0/J1-J3` 数值或 UIA 结果：
   - 首屏控件 ≤8（预期 6）；
   - 面板高度 ≤1.2 屏（估算 0.46–1.16 屏）；
   - 开始看 ≤3 步且不滚动；
   - 失败后收起重开，错误条仍在。
2. 「打开登录窗」在「无残留 / 有残留」两种状态下都出现**真实可见窗口**（5s 内），失败有中文错误。
3. 已登录 profile 上跑一轮：`条目 > 0` 且条目是**具体视频**（`/video/BV…`），停下后浏览器自动关闭。
4. 发布前重建产物：`pnpm build` + `pnpm tauri build --no-bundle`（当前 exe 的 dist 构建于 13:12:41，
   早于源码 13:17:52 的最后一次前端改动；关键文案已命中，但发布以重建为准）。本机不跑 `vite build`
   （安全软件会拦 esbuild 临时文件）。
5. 以上全过后再 `git push`（当前 `origin/main` 仍 `3d01ef5`、无 tag、版本 2.0.2）。

**不阻断但建议**：U6 的「条目 1 = 首页标题」这一证据口径要在 QA 报告/发布说明里改成「采集链路已通，
视频条目待验证」，避免把「首页标题」当成「刷视频成功」。

---

## 9. 改动范围与回滚

`d8d03ad` 共 18 个文件、+2279/−757：

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| Rust | `video/browser.rs`(+442)、`video/session.rs`(+447)、`video/mod.rs`、`video/model.rs`、`video_automation.rs`、`dsh_api.rs`、`lib.rs` | U1/U2/U4/U5/U10 的实例标记、复用决策、CDP/可见窗校验、失败落盘、StopReason 扩展、`video_close_browser` 注册、退出关闭 |
| 前端 | `plugins/video/VideoAutomationPlugin.tsx`、`VideoAutomationPlugin.css`、`VideoDigestList.tsx`、`VideoChannelCard.tsx`、`useVideoPluginState.ts`、`types.ts`、**新增** `videoPanelLogic.ts` | UI 精简 + U3/U7/U8/U9 的文案与错误解析 |
| 测试 | **新增** `tests/video-panel-logic.test.mjs`（14 条） | 面板纯逻辑单测 |
| 文档 | `qa-video-plugin-2026-11-17.md` §6、`video-plugin-usage.md`（重写）、`plugins.md` | 修复记录 / 使用说明重写 / 插件说明 |

- 未改版本号、未改 `tauri.conf.json`、未 push、未打 tag。
- 回滚：`git revert d8d03ad` 即可（前端/后端/文档同一提交；不会牵连窗口配置与版本号）。
  回滚后旧问题 U1/U2/U3 会回来（主流程 100% 失败 + 失败不可见）。

---

## 附录 A 原始命令输出

```text
[tsc]
(no output)
TSC_EXIT=0

[cargo check]
warning: `maltese-assistant` (lib) generated 69 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.10s
warning: the following packages contain code that will be rejected by a future version of Rust:
    imap-proto v0.10.2
CARGO_EXIT=0

[node --test]
ℹ tests 92 / pass 92 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 585.2034
TEST_EXIT=0

[git]
HEAD=301d7b0（验证时 301d7b0；被验证提交 d8d03ad）
ORIGIN_MAIN=3d01ef5
git status --porcelain=v1 → (clean)
git rev-list --count origin/main..HEAD → 40
git tag --points-at HEAD → (empty)
git diff --name-only d8d03ad HEAD → docs/multi-instance-linkage-design.md（纯文档，代码零差异）
```

## 附录 B 证据位置

| 证据 | 位置 |
| --- | --- |
| 诊断日志（U4/J5） | `%APPDATA%\com.maolouis.maltese\video\logs\video-20261117.jsonl` |
| 会话记录（U5/U6/J7/J9） | `%APPDATA%\com.maolouis.maltese\video\sessions\2026-11\*.json`、`index.json` |
| 实例标记（U1/U10） | `%LOCALAPPDATA%\Maltese\video-browser.json`（当前不存在 = 已清理） |
| DSH API | `GET http://127.0.0.1:<dsh-api-port>/api/video/{status,sessions,diagnostics}`（只读） |
| 产物 dist | `dist\assets\index-CbMKCNyk.js`（13:12:41，字节级检索见 §3.4） |
| QA 原始证据 | `work/qa-video-*`（gitignore，本轮未改动） |

---

_报告生成：2026-11-17 13:29（+0800），delivery-verify。只读验证：未点击面板、未登录、未发评论、未改用户数据；未 push、未改版本号。_