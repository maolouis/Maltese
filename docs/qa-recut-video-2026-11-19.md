# 两项验收 · 2026-11-19（白底 GIF 抠图重做 / 视频插件 v2.0.3）

- 角色：QA（**只读代码与素材、只读 DSH API，未改源码/素材**；本文件是本批唯一新增文件）
- 基线：`7cd5ae7`（`chore(release): 2.0.3`）；工作区含未提交的白底修复（218 个 GIF 变更 + 清单/测试/README/文档 + 未跟踪脚本 `scripts/repair-white-bg-transparency.py`）
- 实装：`E:\Maltese2\maltese-assistant.exe` **2.0.3**（构建 2026-11-18 20:12:46），运行中 pid 65580
- 方法：Pillow/numpy 逐像素对比 `HEAD` 版本与工作区版本；DSH API（`http://127.0.0.1:3218`）+ 磁盘会话文件核对视频插件
- 素材/配置未改动；视频会话为用户 10:12:36 启动的 `bili-20261119-ec2701`（running），**QA 没有停止它**，避免干扰用户操作

---

## A. 白底 GIF 抠图质量（218 个文件，工作区未提交）

### A0. 范围核对

- `git diff --name-only -- assets/pets` = 219 项：**217 个 GIF 重写 + 1 个 GIF 删除**（`stickers/weibo/pet/p11-7.gif`），即 218 个 GIF 变更（任务口径 218 张）；另有 `src/petCharacterAssets.generated.ts`、`tests/pet-asset-inventory.test.mjs`、`README.md`、`docs/pet-characters.md` 与未跟踪修复脚本。
- 变更体积：217 个重写文件 `12,484,537 → 13,588,926 B`（**+1,104,389 B，+8.8%**；对应全库 60,298,013 → 61,481,689 B 的口径）。
- 清单/测试：manifest 已重生成 **788**（stickers 9→8，去掉上述重复贴纸）；`node --test tests/pet-asset-inventory.test.mjs` **7/7 pass**（清单无失效路径、磁盘无未收录、无 chars 重复副本、788=788）。

### A1. 结构一致性：**通过**

- 全量 217 个文件：**帧数 0 差异、画布尺寸 0 差异、解码错误 0**（`work/qa-recut/report.json`）。
- 抽样 24 张（xiaobai 8 / xiaojimao 6 / shared 6 / stickers 4）：**帧时长列表逐项相等、loop 相等**；首帧尺寸与 HEAD 完全一致。
- 结论：重编码没有丢帧、没有改画布、没有把动画时长改掉。

### A2. 主体误抠（白肚皮/白身体）：**基本通过，1 张失败**

- 用备份原图（`.tmp-build/white-bg-backup`，处理前原图）计算「被轮廓围住的白色身体」：工作区版本对这部分白色身体的**不透明保留率 body_ratio 均值 0.977**（217 张中 212 张 = 1.0）。
- **4 张首帧全透明**（`xiaobai/idle/p22-1.gif`、`xiaobai/sleep/p19-9.gif`、`xiaojimao/angry/p18-6.gif`、`xiaojimao/eat/p12-2.gif`）：HEAD 同样首帧全透明（0 像素不透明）→ 属动画首帧设计，**不算误抠**。
- **1 张仍误抠**：`stickers/weibo/happy/p15-9.gif` body_ratio **0.007**（白色身体几乎仍透明），且同时背景未除（见 A3）。

### A3. 边缘质量：**未通过（两个问题）**

1. **6 个文件背景未除（首帧左上角 alpha=255，会看到白/灰底方块）**：

| 文件 | 首帧不透明占比 | 说明 |
| --- | --- | --- |
| `chars/shared/pet/p11-7.gif` | 0.372 | 四角不透明 |
| `chars/xiaobai/play/p22-7.gif` | 0.533 | 四角不透明 |
| `chars/xiaojimao/idle/p18-2.gif` | 0.599 | 四角不透明 |
| `chars/xiaojimao/sleep/sp-xxgold-2-8.gif` | 0.479 | 四角不透明 |
| `stickers/weibo/happy/p15-9.gif` | 0.385 | 四角不透明 + 身体误抠 |
| `stickers/weibo/happy/p16-8.gif` | 0.542 | 四角不透明（46% 不透明像素是白背景） |

2. **2px 白色光晕环（普遍存在）**：对 213 个有透明背景的文件统计「贴着透明边界的最外 2 圈不透明像素」：
   - 这些像素在**工作区版本里近白色占 97.5%**，而它们在**备份原图里就是白色背景（白色占比 97.6%）** → 即轮廓外保留了约 **2px 宽的白底环**；
   - **207/213 个文件**该比例 ≥0.9（`ring_white_ratio` 均值 0.975，最小 0，最大 1）。
   - 成因（读脚本）：`repair-white-bg-transparency.py` 先把非白轮廓**膨胀 2px** 当屏障再从边框洪水填充，屏障外侧 2px 内的白色背景因此不会被填成透明，形成白边。
   - 视觉：深色壁纸上狗轮廓外会有一圈白边（当前缩放 1.6× 下约 3px），属于"光晕/脏边"类缺陷；不是半透明脏边（GIF alpha 是二值 0/255，没有半透明边）。

### A4. 重编码画质：**可接受**

- 与备份原图相比，工作区不透明区域 RGB **平均绝对差 1.50（最大 3.62）**/通道。
- 抽样 24 张：HEAD 与工作区首帧**唯一颜色数相同**（如 38→38、34→34、48→48）→ 本次重编码没有在 HEAD 基础上进一步明显降色；体积 +8.8% 主要来自 `optimize=False` 与白边环，而非画质提升。

### A5. 清单/安装目录一致性：**通过**

- 仓库工作区 GIF 数 **788**、安装目录 `E:\Maltese2\resources\assets\pets` GIF 数 **788**；217 个重写文件与安装目录对应文件 **SHA-256 全部相同（217/217）** → 当前安装目录已是修复后素材（用户实机跑的就是新版），**不需要重新覆盖素材**；清单已重跑（788），未来打包会带上。
- 删除的 `stickers/weibo/pet/p11-7.gif`：测试口径为 788 后"无 chars 重复副本"通过；直接按 HEAD blob 哈希在 HEAD/work 的 788 个 GIF 中未找到同哈希文件，**删除依据建议研发补一条说明**（例如"修复后与某张 shared 内容一致"的具体 sha256），目前只能以清单/测试通过作为佐证。

### A6. 结论：**部分收（不能直接进发布）**

- 修复方向正确：**白色身体恢复**（HEAD 版"只剩轮廓"的致命问题被修好）、结构/时长/尺寸零回归、清单与安装目录已对齐、体积增幅可解释。
- 但仍有可见缺陷：
  1. **6 个文件背景完全没除**（上表白框文件）——必须单独重做或从改动里剔除；
  2. **207 个文件有约 2px 白边环**（暗色壁纸可见）——需要改脚本（例如洪水填充后，对"与透明相邻且备份为白背景"的 1–2px 白环再置透明，或用形态学收边），或在产品侧接受"白边狗"；
  3. `stickers/happy/p15-9.gif` 身体仍误抠。
- 建议：**部分收**——把除 6 个背景未除 + p15-9 之外的 211 张先收进仓库（它们修好了身体，只剩白边待优化），6 张 + p15-9 回滚/重做；白边环作为 P1 视觉问题在 v2.0.4 前由脚本修复后统一重跑。**不建议"全部回滚"**（回滚会恢复"白色身体透明"的严重缺陷）。

### A 需要研发修的问题

| # | 问题 | 涉及文件 | 建议 |
| --- | --- | --- | --- |
| A-1 | 背景未除（四角 alpha=255） | 上表 6 个 | 排查为何这 6 张的 exterior 未覆盖（可能备份原图本身带 alpha/边框，或屏障把整图封住）；修复后重跑 |
| A-2 | 2px 白边环 | 207/213 张 | 屏障膨胀后做"白环回收"：对与透明相邻、且备份为白背景的像素再置透明；或改为闭运算轮廓 + 边界 alpha 羽化（GIF 只能二值，可做 1px 收边） |
| A-3 | 身体仍误抠 | `stickers/weibo/happy/p15-9.gif` | 与 A-1 一起处理 |
| A-4 | 删除文件缺依据 | `stickers/weibo/pet/p11-7.gif` | 在提交说明/文档补 sha256 与对照文件 |
| A-5 | 体积 +8.8% | 218 个 | 可接受；修白边后若改用 optimize=True 可回落，但需重新验证帧时长/颜色 |

---

## B. 视频插件可用性（v2.0.3 已发布版本）

> 实测时用户已启动一轮采集（`bili-20261119-ec2701`，10:12:36 开始，账号 `dog-1794880825-1`），QA 只读观察、**未点停止/未发评论**，以免破坏用户会话。

### B1. 面板与首屏控件：**未实测（环境限制）**

- 多次用 UIA 切到「插件」页失败：切换后岛屿因失焦自动收起（窗口回到 259×221），面板元素树不可达；本次无法给出 v2.0.3 首屏控件数的可靠数字。
- 可给代码口径（`VideoAutomationPlugin.tsx`，v2.0.2 实测同结构）：面板约 13 个按钮 / 6 个输入 / 2 个下拉，首屏只有状态头 + 参数行 + 账号卡；需人工按 §C 步骤复测。

### B2. 开始/采集：**部分通过（运行中会话证据）**

- DSH API `/api/video/status` 实测（10:47 / 10:53 两次）：
  - `phase=collecting`、`running=true`、`channel={type:"cdp",capability:"full",lastSuccessAt:1795054357}`、`steps=6→8`、`itemCount=1`、`currentUrl="https://www.bilibili.com/"`、`accountId=dog-…`、`pendingCount=0`、`error=null`；
  - 说明专用浏览器、CDP 连接、采集循环都已跑起来（v2.0.3 可用）。
- 自己点「开始看/停止」：**未执行**（用户会话运行中）；开始按钮/停止按钮的 UI 行为需人工复测（§C）。

### B3. `items[].canonicalUrl` 是否为具体视频页：**失败（上轮问题仍在）**

- 读取磁盘会话（`%APPDATA%\com.maolouis.maltese\video\sessions\2026-11\`）：
  - `bili-20261118-2ff70e`（itemCount 1）：`title="哔哩哔哩 (゜-゜)つロ 干杯~-bilibili"`、`canonicalUrl="https://www.bilibili.com/"`、`durationSeconds=6`、`visits=9`；
  - `bili-20261117-818b4e`、`bili-20261117-299aa3`：同样只有**首页条目**（`canonicalUrl` 均为 `https://www.bilibili.com/`）；
  - 当前运行会话 status `currentUrl` 也是首页，`itemCount=1`（会话文件尚未落盘 items）。
- 结论：**「itemCount>0」是首页被当成内容条目造成的虚高；没有任何 `/video/BV…` 具体视频页**。上轮未解决的问题仍在。
- 代码定位：页面事实归一化在 `src-tauri/src/video/extract.rs:209-240`（`canonical_url`），采集判断在 `adapter.rs:38-39,87`（`PageKind::Feed` 仍可产出 link 条目）/ `session.rs:1074,1745`（`merge_facts` 未按 `canonicalUrl` 是否 `/video/` 过滤）；建议在 merge 前丢弃 `PageKind::Feed` 的页面级条目、只接受能归一化出 `/video/` 的条目。

### B4. 小结/待投递：**未产生（运行中，未验证成功路径）**

- `/api/video/pending` = `null`；本次会话 `digest:null`、`strongCount=0`；历史所有 itemCount=1 的会话也都 `strongCount=0`、无 digest → 尚未见到一次"看完 → 小结"的成功案例。
- 数据位置：`%APPDATA%\com.maolouis.maltese\video\sessions\2026-11\<sessionId>.json`、`index.json`、`pending.json`（不存在说明没有待投递）。

### B5. 评论入口：**未实测（遵守"不要真的发评论"）**

- 代码入口存在：`VideoAutomationPlugin.tsx:332-359`（textarea + 「发送评论」，`disabled={commentBusy || !commentDraft.trim()}`）。v2.0.3 UI 未抓到面板，未点击；未发送任何评论。

### B6. 结论：**部分可用**

- 可用：专用浏览器启动、CDP 通道、采集循环/翻页（steps 增长）、账号绑定、面板数据落盘链路（会话/索引）。
- 不可用/失败点：
  1. **采集内容不可用**：`canonicalUrl` 只有首页；`itemCount` 虚高；**没有任何具体视频页条目**（P0）；
  2. 无小结/无待投递（因为没有有效条目）；
  3. 运行中诊断日志缺失：`video\logs\` 只有 `video-20261117.jsonl`（4 条 CDP/PORT_BROWSER 错误），11/18–11/19 的运行没有日志（P1，排障困难）；
  4. UI 面板在失焦收起后无法观察/操作（既有 UX，验收也受影响）。
- **下一版必修**：
  - N1（P0）过滤非视频页条目：`canonicalUrl` 必须匹配 `/video/(BV|av)\d+` 才计入 `items`；首页/推荐流页面级条目不计数；
  - N2（P0）item 质量门槛：标题=站点名、时长 0–6s、无 author 的条目直接过滤（当前首页条目正是这类）；
  - N3（P1）每次运行落 `logs\video-<date>.jsonl`（含 channel/phase/丢弃原因），便于定位"为什么 0 条"；
  - N4（P1）面板状态在失焦收起后保持可见（或给系统通知/气泡提示采集状态），否则用户无法判断"是否在刷"；
  - N5（P2）首屏精简与"采集到 0 条时的人话解释"（当前只有 `itemCount` 数字）。

---

## C. 人工复测步骤（约 5 分钟）

1. **A 白边/背景**：把 `E:\Maltese2\resources\assets\pets` 换回工作区版本（当前已一致，无需操作），深色桌面看 6 个问题文件（清单见 A3-1）是否出现白框；随机看 3 只狗轮廓外是否有 2px 白边。
2. **B 面板**：展开桌宠 → 点「插件」页签 → 截图首屏；数首屏按钮/输入；确认状态条（正在准备/等待登录/小狗正在看）。
3. **B 开始/停止**：先确保没有正在运行的会话，再点「开始看」→ 等 60–90s，记录 API `phase/itemCount/currentUrl` 与页面提示；点「停下」确认回到 `interrupted` 且浏览器关闭。
4. **B 视频页**：在专用浏览器里点开一个具体视频页（`/video/BV…`），回到面板等 1–2 个采集间隔，查 `/api/video/sessions/<id>` 的 `items[].canonicalUrl` 是否变成具体视频页。

---

## D. 证据文件

| 文件 | 内容 |
| --- | --- |
| `work/qa-recut/report.json` | 24 张抽样（帧数/尺寸/时长/颜色/body/halo）+ 全量 217 张帧数与尺寸对比（0 差异） |
| `work/qa-recut/scan-all.json` | 217 张首帧全量：corner alpha、ring_white、body_ratio、颜色差；6 个 corner 问题文件、207 个 ring≥0.9 |
| `work/qa-recut-analysis.py` / `qa-recut-scan-all.py` / `qa-recut-halo.py` | 复跑脚本（只读） |
| DSH API | `/api/video/status`（10:47/10:53）：collecting、steps 6→8、itemCount 1、currentUrl 首页 |
| 磁盘会话 | `sessions/2026-11/bili-20261118-2ff70e.json` 等：`canonicalUrl=https://www.bilibili.com/` |
| 日志 | `%APPDATA%\com.maolouis.maltese\video\logs\video-20261117.jsonl`（仅 11/17，4 条错误） |