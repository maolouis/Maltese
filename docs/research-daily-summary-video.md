# 每日刷视频图文总结视频预研

> 日期：2026-11-19 · 工作树 HEAD（并行开发中，引用以符号名为准）
> 需求：每天把当天刷到的视频做成「封面/截图 + 文字要点（+配音）」的总结视频，并自动发布。
> **结论：本机现在没有 ffmpeg；TTS 有；视频条目没有封面/截图；B 站 API 投稿可行但风控风险高。推荐「本地生成 + 平台投稿页人工最后一步」，MVP 复杂度 M。**

## 0. 结论先行

- **生成**：`ffmpeg` 未安装；`winget` 可用且能装 FFmpeg（Gyan.FFmpeg 9.0.2，已实测包存在）；Node 无 `ffmpeg-static`；Rust 侧没有 muxer/编码器依赖，纯 Rust 出 MP4 要新增 Media Foundation 或 `openh264+mp4`，成本 M/L。**推荐检测/引导安装 ffmpeg；没有就降级 GIF/长图。**
- **配音**：Windows 中文 TTS 可用。SAPI 有 `Microsoft Huihui Desktop`（zh-CN），实测合成 14.61s WAV（22.05kHz mono，644KB）；OneCore 还装了 Huihui/Kangkang/Yaoyao，Rust 的 `windows` crate 已启用 `Media`，含 `SpeechSynthesis`，音质需实测。
- **素材**：`video/sessions/YYYY-MM/*.json` 有 title/author/duration/tags/URL，**没有 cover/thumbnail/截图**（30 个会话文件里 0 个 cover 字段）；B 站可用 `x/web-interface/view` 回填封面（实测 `pic` 可取、带 Referer 下载 42KB JPEG）；抖音无此接口，需补抓/截图。
- **发布**：B 站 web 投稿 `x/vu/web/add/v3` 接受浏览器登录态（SESSDATA + `bili_jct` + wbi 签名），现有 CDP 浏览器档案可复用登录，但自动化投稿有风控/封号风险。**推荐不自动发布**：生成本地文件 + 面板打开投稿页/复制标题简介标签，用户点最后一步。

## 1. 生成能力核查

### 1.1 ffmpeg（已核实：没有）

| 检查 | 结果 |
| --- | --- |
| `where ffmpeg` / 常见路径 / `PATH` | 没有；`C:\ffmpeg`、Program Files、WinGet、scoop、choco bin 均无 |
| 安装器 | `winget v1.29.380` 可用；`winget search ffmpeg` 返回 `Gyan.FFmpeg 9.0.2`、BtbN 多个分支；`choco` 也在 |
| 应用自带 | `tauri.conf.json` 的 `bundle.resources` 只有 `assets/pets`，没有 ffmpeg 资源/`externalBin` |
| Node | `node_modules` 无 `ffmpeg-static` / `@ffmpeg-installer`，`package.json` 无相关依赖 |
| Rust | `Cargo.toml` 只有 `image`（仅 `png` 特性），没有 `mp4`/`openh264`/`gif`/`webp`；cargo 缓存里也没有这些 crate |

**不装 ffmpeg 的替代**：① 纯 Rust **GIF/WebP**（`image` 开 `gif`/`webp` 特性即可，PNG 已有）——能发图文/GIF，但没有 H.264/AAC；② 纯 Rust **MP4** 需 muxer + 编码器（Windows Media Foundation `SinkWriter` 或 `openh264`+`mp4`），且要处理 NV12/AAC，属于 M/L，不建议放进首版；③ 首次使用时用 winget 安装（需用户确认/UAC，网络与静默安装需实测）。**推荐：ffmpeg 作为可选的本地依赖，不打包 GPL 二进制**（打包会引入 GPL 分发合规问题）。

### 1.2 TTS（已核实：能用）

- 注册表 SAPI：`Microsoft Huihui Desktop - Chinese (Simplified)`、`Microsoft Zira Desktop`（en-US）。
- OneCore：`Microsoft Huihui / Kangkang / Yaoyao (zh-CN)`。
- 实测：`System.Speech.Synthesis.SpeechSynthesizer` 选 Huihui，合成一句约 14.6 秒中文 WAV（22.05kHz、16-bit、mono），可被 ffmpeg 直接读取。
- 质量：SAPI Huihui 偏“机器音”；更好的是 WinRT `Windows.Media.SpeechSynthesis`（可用 Yaoyao），`windows` crate 的 `Media` feature 已启用且有 `SpeechSynthesis` 模块；Rust 调 WinRT 合成到流/文件需实测。

### 1.3 视频素材与封面（已核实：缺封面）

- 存储：`%APPDATA%\com.maolouis.maltese\video\sessions\2026-11\*.json`，当前 30 个文件（11-14/17/18/19），全部 `platform=bilibili`；按 `index.json` 汇总。
- `ContentItem` 字段（`video/model.rs`）：`itemKey/clusterKey/platform/title/description/author/durationSeconds/watchedSeconds/positionSeconds/completionPercent/tags/canonicalUrl/...`，**无封面、无截图**。
- `video/adapter.rs` 的 B 站/抖音注入脚本只提取标题/描述/作者/时长/标签/URL；`extract.rs` 的 `drops_superset_fields` 测试明确把 `coverUrl` 当未知字段丢弃。`digest.rs` 已有“≤5 条、≤300 字”的文本小结，可复用选题逻辑，但不含图片。
- **封面回填（B 站）**：`GET https://api.bilibili.com/x/web-interface/view?bvid=BV...` 实测返回 `code=0`、`pic`、`owner.name`、`duration`；图片 CDN 带 `Referer: https://www.bilibili.com/` 下载 200/JPEG（42KB）。可加 `video/covers/<bvid>.jpg` 缓存。
- **抖音**：无公开 view 接口；建议在会话采集时从 `meta[property=og:image]` 或播放器 `poster` 抓取（adapter 已有 `meta()` 辅助函数），抓不到就用生成的标题卡；CDP 截图（`Page.captureScreenshot`）目前未实现，可作为兜底新增。
- 存量会话没有封面：生成日报时对 B 站条目用 view API 回填；抖音/失败条目用文字卡。

## 2. 发布路径核查

**B 站投稿 API 可用但有门槛（已核实/社区证据）**

- web 投稿：`POST https://member.bilibili.com/x/vu/web/add/v3`，需要 Cookie `SESSDATA` + `bili_jct`（CSRF）+ **wbi 签名**（`wts`/`w_rid`，`web_location=333.1024`）；`x/vu/client/add` 对浏览器 Cookie 返回 `-101`。缺少/错误 csrf 返回 `-111`。
- 封面上传：`x/vu/web/cover/up`（multipart，jpeg/png，≤5MB，推荐 ≥1146×717）；投稿 body 需要 `title≤80`、`tid`、`copyright`（1 原创/2 转载+source）、`tag`、`cover`、`videos` 等。
- 风控：社区工具（biliup-rs、bili-cli、catbus、dsh-bili-upload-kit）均提示——新号最严、要限速/间隔（≥10 分钟）、遇风控立即停、禁止批量/刷量；自动化投稿不受官方承诺保护，账号风险由用户承担。B 站开放平台也有“视频稿件提交”接口，但需要开放平台权限，不适用于个人桌面工具。

**现有登录态能否复用**

- `video/browser.rs`/`cdp.rs` 为每个账号启动独立 Chrome/Edge profile：`...\AppData\Local\Maltese\video-accounts\dog-...`（`accounts.json` 可见，已存在）；当前支持 `Runtime.evaluate`、`Page.navigate`、`dispatch_key`。
- **但没有 cookie 读取**：`SESSDATA` 通常是 HttpOnly，`document.cookie` 拿不到；需在 `cdp.rs` 增加 `Network.getCookies`（或 `Storage.getCookies`），并实现 wbi 签名。技术上可复用登录态，但属于“自动化投稿”，风险同上。

**推荐发布路径（不自动提交）**：生成 `mp4` + 元数据 JSON → 面板「打开投稿页」`https://member.bilibili.com/platform/upload/video/frame` + 「复制标题/简介/标签/封面路径」；用户拖入文件、确认 AI 声明后手动发布。默认不调用投稿 API；即使以后做 API，也仅支持私密/定时、每天 ≤1 条、遇风控码停止并审计。

## 3. MVP 建议（按投入产出）

- **触发**：每日 00:05 结算前一天（本机时区）；错过则下次启动补跑一次；面板保留「生成今天的小狗日报」手动按钮。**默认自动生成（本地文件）开，自动发布永远关**（发布需每次点击/一次性确认）。
- **选题**：读当天 sessions/items，按 `verdict.final_score`/兴趣分组去重，最多 **8–10 条**；优先有封面、有作者、时长≥8s 的条目；同一 UP/聚类最多 1–2 条。
- **结构**：封面（当天最强兴趣的封面 + 标题「小狗的 YYYY-MM-DD 视频日报」）→ 每 3–5 秒一屏（缩略图 + 一句话要点 + 时长/UP 名）→ 结尾一句「今天先看到这里」。总长 **≤90 秒**。
- **规格**：1080p30（或 720p30）、H.264 + AAC（128kbps）、`daily-YYYY-MM-DD.mp4`，落 `%APPDATA%\com.maolouis.maltese\video\daily\`（目录当前不存在，首次创建）；同时写 `daily-YYYY-MM-DD.json` 记录元数据/条目/发布状态。
- **流水线**：聚合 sessions → 选条目 → B 站 view API 回填封面/缓存（失败用文字卡）→ 每屏文案（模板/模型二选一）→ 中文 TTS 每屏 WAV（失败静音）→ 渲染 PNG 幻灯片（GDI `DrawTextW`，或已有 `PrintWindow` 截隐藏 WebView，两者都需实测中文字体）→ ffmpeg 按每屏时长拼接 + 音轨 → mp4。每屏时长 = `max(3s, 音频时长+0.5s)`。
- **失败降级**：无 ffmpeg → 输出 `daily-YYYY-MM-DD.png` 长图（每屏一张拼成长图）或 `daily-YYYY-MM-DD.gif`（`image` 的 gif 特性），面板提示「已生成图文版」；无 TTS → 静音 MP4；无封面 → 生成纯色标题卡；当天 0 条 → 生成「今天没看视频」一张图。
- **面板**：视频插件「最近小结」旁新增卡片：预览（`<video controls>` 或图片）、生成/重生成、打开文件夹（`opener`）、复制投稿元数据、打开投稿页；显示 ffmpeg/TTS 检测状态。

## 4. 合规与授权

- **默认不自动发布**；发布按钮每次都要用户确认（可记忆“今天不再询问”），且首次使用弹出说明：自动化投稿违反平台自动化条款的风险、账号可能被风控/限流/封禁。
- 内容：封面是他人作品，摘要只做缩略引用并标注 UP/来源；不大段搬运；「原创/转载」按实际填写；AI 配音/生成内容按平台要求勾选「含 AI 生成内容」。
- 频率：每天最多 1 条、手动触发；不做批量、多账号、刷量；账号建议用长期正常使用的老号。
- 隐私：sessions/封面/成片全部本地；除 B 站 view API 拉封面外不联网；不把观看记录上传。

## 5. 文件清单与复杂度

| 文件 | 改动 |
| --- | --- |
| 新增 `src-tauri/src/video/daily.rs` | 按日聚合 sessions、选题、封面回填/缓存、TTS、幻灯片渲染、ffmpeg 调度、降级；命令 `daily_video_generate/status/open_folder/prepare_publish` |
| `src-tauri/src/video/model.rs`、`extract.rs`、`adapter.rs` | `ContentItem` 加 `cover_url`；B 站/抖音注入脚本加 `meta('og:image')`/poster；未知字段白名单同步 |
| `src-tauri/src/video/mod.rs`、`lib.rs` | 注册新命令到 `generate_handler!` |
| `src/plugins/video/DailySummaryCard.tsx`（新） | 预览、生成、打开文件夹、复制元数据、打开投稿页 |
| `src/plugins/video/VideoAutomationPlugin.tsx`、`useVideoPluginState.ts`、`types.ts` | 挂载卡片、状态与 invoke 类型 |
| `src-tauri/Cargo.toml` | `image` 开 `gif`/`webp` 特性（降级用）；纯 Rust MP4 另议（Media Foundation feature / openh264+mp4） |
| `README.md`、`docs/video-plugin-usage.md` | 说明 ffmpeg/TTS 依赖、生成目录、发布风险与手动流程 |

**复杂度**：有 ffmpeg + SAPI TTS **M（约 3–5 天）**；无 ffmpeg 且坚持 MP4 → **L（1–2 周）**；自动 API 投稿另算 **L 且不建议**。

## 6. 验收判据

| 场景 | 判据 |
| --- | --- |
| 正常生成 | 产出 ≥30 秒 mp4，含 ≥3 条视频信息、封面/标题/要点字幕；Windows 播放器可播；1080p30 H.264+AAC；≤90 秒 |
| 文件位置 | `%APPDATA%\com.maolouis.maltese\video\daily\daily-YYYY-MM-DD.mp4` + 同名 json |
| 无 ffmpeg | 自动降级 `daily-YYYY-MM-DD.png`（长图）或 `.gif`，面板明确提示；不报“失败” |
| TTS | 中文配音可听；TTS 失败时静音成片仍可播 |
| 封面 | B 站条目封面成功回填并缓存；无封面条目显示文字卡；无破图 |
| 面板 | 可预览、重生成、打开文件夹；投稿元数据可一键复制；投稿页能打开 |
| 自动生成 | 00:05 或下次启动补跑，重复运行不覆盖已有成片（除非手动重生成） |
| 发布（人工） | 用户手动上传成功至少 1 次；若未来做 API：私密/定时投稿成功 1 次、遇风控码停止并记录 |
| 合规 | 默认不自动发布；无后台 API 投稿请求；成片标注来源/AI |

## 7. 参考

- ffmpeg：`winget search ffmpeg`（Gyan.FFmpeg 9.0.2）；本地 `Cargo.toml`/`tauri.conf.json` 核查
- B 站投稿：`x/vu/web/add/v3` + Cookie/CSRF/wbi（[chengjilai](https://chengjilai.github.io/posts/2026-06-01-bilibili-web-upload.html)、[bilibili-API-collect 投稿](https://github.com/socialsisteryi/bilibili-api-collect/blob/e99f64c9b5c2bbd156e95ca254620378a22697f7/docs/creativecenter/upload.md)）；封面/稿件字段（[B 站开放平台](https://openhome.bilibili.com/doc/4/f7fc57dd-55a1-5cb1-cba4-61fb2994bf0f#h1-u89C6u9891u7A3Fu4EF6u63D0u4EA4)）；风控提示（[bili-cli](https://pypi.org/project/bili-agent/1.2.0/)、[dsh-bili-upload-kit](https://github.com/xushilianzhuren/dsh-bili-upload-kit)）
- 本地代码：`src-tauri/src/video/{model,extract,adapter,session,store,digest,cdp}.rs`、`src/plugins/video/*`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`