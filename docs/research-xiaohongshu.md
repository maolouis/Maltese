# 小红书自动刷 / 总结 / 发图文预研

> 日期：2026-11-19 · 事实标注：**已核实**（代码/实测/来源原文）、**推测**、**需实测**。
> 结论：**只读采集 + 本地总结 + 生成图文草稿 + 人工发布**可行（M）；**不建议全自动发布**。小红书 Web 登录态、`xsec_token`、图片防盗链和创作中心反自动化是主要障碍。

## 1. 登录与反爬现实

### 1.1 登录态

| 站点 | 现状 | 结论 |
| --- | --- | --- |
| `www.xiaohongshu.com/explore` | 2026-11-19 未登录 GET 返回 200，页面标题“小红书 - 你的生活兴趣社区”，正文含登录入口；OpenCLI 站点资料（2026-06/08）称 explore/search/profile **全有 login wall**，未登录仅极少数 note URL 可看 | **需实测**：未登录可能只看到登录墙/少量内容；不能假设可匿名采集 |
| `www.xiaohongshu.com/explore/<noteId>` | note URL **必须带 `xsec_token`**（feed/search 自带），手拼裸 URL 会 403 | **已核实（来源）**，需实测 |
| `creator.xiaohongshu.com` | 2026-11-19 未登录 `/publish/publish`、`/login` 均 200，标题“小红书创作服务平台”（SPA 登录页） | 发布必须在 creator host，且需登录 |
| 登录方式 | 网页端扫码最常用；手机 App 扫码确认；手机号验证码也可 | 需人工扫码一次；cookie 可持久化 |

> 任务里提到的 `publish.xiaohongshu.com`：2026 年的开源工具与实测资料都走 `creator.xiaohongshu.com` 发布，未见到仍可用的 publish 独立入口；本方案按 creator 处理，**需实测旧域名是否跳转**。

**可复用的登录态**：项目现有 CDP 专用 profile（`%LOCALAPPDATA%\Maltese\video-accounts\<accountId>`，`accounts.json` 记录 `profileDir`），每个账号独立 user-data-dir；`video_open_login_window` 可打开登录页，人工扫码后 cookie 留在 profile。**需实测**：小红书主站与 creator 共享 SSO，登录一次后 creator 是否直接可用；以及“同一账号只允许一个网页端登录”——若用户还在别处登录，会把 profile 踢下线（xiaohongshu-mcp README 明确提到）。

### 1.2 签名与反爬（已核实/来源）

- **API 请求签名**：主站 API 需要 `x-s`、`x-t`、`x-s-common`，依赖 `a1`、`web_session`、`webId` 等 cookie；开源实现 `xhshow`（1,123★，MIT）可生成。`ReaJason/xhs`（2,239★，MIT）、`MediaCrawler`（71,372★，非商业学习许可）均走 API+签名。
- **DOM 采集不需要签名**：页面渲染后直接读 DOM/SSR state 即可；但登录墙、验证码、风控仍可能中断。我们现有 CDP（`Runtime.evaluate`/`Page.navigate`）就是 DOM 路线，**不引入签名算法**。
- **风控特征**：频率/短时间大量请求、无头浏览器/自动化指纹、滑块/验证码、账号异常提示“当前账号存在异常”“网页版发布受限”、cookie 过期。xiaohongshu-mcp 项目记录：未实名/新号容易触发实名认证提醒；账号被风控限制网页版发布；不要纯搬运/引流。
- **只读也要登录**：OpenCLI 称大多数读写需要 `web_session`；小红书的 feed/search 走 SSR Pinia store，未登录 store 缺 `feed.feeds` 会跳 `/login`。**需实测本机 profile 能否稳定浏览**。

## 2. 采集可行性

### 2.1 页面结构（需实测选择器）

- **首页 Feed**：`/explore` 瀑布流卡片，SSR Pinia store；候选脚本需返回 `{noteId, xsecToken, url, title, author, cover}`。`xsecToken` 必须从卡片链接/状态中取，不能手拼。
- **图文笔记页**：`/explore/<noteId>?xsec_token=...`，标题、作者、正文、标签、图片列表（`sns-webpic-qc` 域名）、点赞/收藏数、发布时间。图片可能懒加载，需滚动/等待；可用 `window.__INITIAL_STATE__`（若存在）或 DOM。
- **视频笔记页**：同 note 页，`<video>` 的 `src` 可用于记录（不建议下载/转存）；标题/作者/正文同上。
- **候选队列 + `Page.navigate`**：可复用 B 站/抖音骨架：`PlatformAdapter::candidate_script` 产出候选 → session 队列逐条 `Page.navigate` → extract → 下一轮；XHS 需要新增 adapter、`Platform` variant、login/risk 判定、候选脚本。

### 2.2 字段与图片

需在 `ContentItem` 增加：`body`（已有 `description` 可复用）、`image_urls: Vec<String>`、`note_type`（image/video）、`like_count`、`collect_count`、`published_at`、`xsec_token`（导航用）、`cover_url`。
**图片下载**：`sns-webpic-qc.xhscdn.com` 直链会 403（防盗链，XHS-Downloader 项目明确）；可行做法是**在页面上下文 fetch**（带 referer/cookie）或 CDP `Network.getResponseBody`，或加 `Referer: https://www.xiaohongshu.com/` + cookie。**需实测**；不建议使用第三方“换域名/参数”绕防盗链（不稳定且版权风险）。

## 3. 总结与图文草稿

### 3.1 总结提示词（本地 Strata/DSH，一次调用）

输入 1 篇或 N 篇：标题、作者、正文（每篇截断 ≤500 字）、标签、图片数；输出严格 JSON：

```json
{"title":"≤20字","body":"≤1000字","tags":["≤8个"],"selectedImageIndexes":[0,2,4],"coverIndex":0,"sourceAuthors":["..."]}
```

要求：只做信息整合/评论，不逐字复制原文，不编造；正文按“是什么/亮点/适合谁”三段；保留作者/来源标注；N 篇按主题聚合。标题 ≤20 字、正文 ≤1000 字（小红书限制）；图片 ≤9 张（平台实际最多 18 张，MVP 按需求收敛到 9）。

### 3.2 草稿目录

`%APPDATA%\com.maolouis.maltese\xiaohongshu\drafts\<timestamp>\`：`draft.json`（标题/正文/tags/来源/作者）、`images/01.jpg…`（最多 9 张）、`README.txt`（版权与来源说明）；面板可预览、打开文件夹、复制文案。**图片再发布有版权风险**：优先用自己拍摄/生成的图；使用他人图片必须获授权并标注来源，不能纯搬运。

## 4. 发布路径对比（重点风险）

| 路径 | 原理 | 成本 | 被封风险 | 扫码 | 签名 |
| --- | --- | --- | --- | --- | --- |
| **A. 创作中心 Web 自动化** | CDP 打开 `creator.xiaohongshu.com`，上传图片、填标题/正文/话题、点发布 | **M/L** | **高**：反自动化、验证码、审核、账号权重、发布频率限制 | 首次需扫码，发布可能再验证 | 不需要（DOM 操作） |
| **B. 官方开放平台/第三方 API** | OAuth2 + 开放平台接口 | **L** | 低（若获授权） | 不需要 | 不需要（官方鉴权） |
| **C. 本地草稿 + 一键打开投稿页（推荐）** | 生成本地图片/文案，面板打开 creator 发布页并复制文案；用户上传、确认、点发布 | **S** | **低**（人工操作） | 已登录则通常不需要；过期需扫码 | 不需要 |

- **A**：开源 `xiaohongshu-mcp`（17,210★，Apache-2.0）已实现登录/图文发布/视频发布；XHS Publisher 等 skill 也用 CDP 自动化。2026-09 实测资料补充：发布页默认停在「上传视频」，需先切「上传图文」；图片最多 18 张、逐张上传；标题 20 字上限；正文是 tiptap 编辑器（普通 fill 填不进去）；话题需等候选框点选；**发布按钮是 closed shadow DOM 自定义元素，host 级 click 不触发**——选择器非常易碎。其 README 也提示风控/发布受限/实名/账号异常；**不建议默认开启**，最多做“用户明确确认后的半自动”。
- **B**：小红书开放平台面向商家/服务商，`note/info`、`note/comment/list` 等接口需资质+OAuth；第三方资料称内容接口面向商家/服务商、个人可用性有限（**官方对个人发布权限未核实**，需向开放平台确认）→ **不能作为当前默认方案**。
- **C**：唯一推荐默认路径；发布最后一步由人点，不涉及自动化投稿。

## 5. 集成架构建议

**把小红书作为视频插件的新平台（`platform=xiaohongshu`）复用采集骨架；草稿/发布辅助放独立子模块。**

| 层 | 改动 |
| --- | --- |
| `src-tauri/src/video/model.rs` | `Platform::Xiaohongshu`；`ContentItem` 加 `image_urls/note_type/like_count/collect_count/published_at/xsec_token/cover_url` |
| `src-tauri/src/video/adapter.rs` | `XiaohongshuAdapter`：feed/detail/风险/登录脚本、候选脚本；URL 匹配 `xiaohongshu.com` |
| `src-tauri/src/video/extract.rs`、`session.rs`、`browser.rs` | 字段白名单、登录 URL、候选队列；尽量复用现有 Phase/队列/重试 |
| 新增 `src-tauri/src/video/xhs_draft.rs` | 总结调用、草稿生成、图片落盘、`xhs_generate_draft/xhs_open_publish_page/xhs_copy_draft` |
| `src-tauri/src/video/mod.rs`、`lib.rs` | 注册命令/初始化 |
| `src/plugins/video/types.ts` | `Platform` 加 `"xiaohongshu"`、`PLATFORMS`、字段类型 |
| `src/plugins/video/VideoAutomationPlugin.tsx`、`useVideoPluginState.ts` | provider 选项「小红书」、登录入口、提示文案 |
| 新增 `src/plugins/video/XhsDraftPanel.tsx` | 草稿预览（≤9 图）、生成/复制/打开文件夹/打开投稿页 |
| `src/i18n`、`docs/video-plugin-usage.md` | 文案、权限/风险说明 |

不新建独立“图文自动化”大模块：会重复浏览器/CDP/账号/队列；但**发布自动化**应隔离在 `xhs_draft` 的可选路径里，默认关闭。

## 6. MVP 与验收

**MVP（两阶段）**

1. **只读采集（M，2–4 天）**：新增小红书平台；人工扫码登录专用 profile；feed 采 5 篇笔记 → 详情页抓标题/作者/正文/标签/图片 URL/互动数/发布时间；不做评论/点赞/发布。
2. **总结 + 本地草稿（S/M，2–3 天）**：对 1 或 N 篇生成标题/正文/tags/≤9 图，落 `%APPDATA%\...\xiaohongshu\drafts\<ts>\`；面板预览、复制、打开文件夹、打开 creator 发布页；**不自动发布**。

**验收判据**：① 登录 profile 重启后仍有效（或明确提示重新扫码）；② 能采到 5 篇笔记，字段缺一即报错但不崩；③ 生成 1 份草稿含 ≤9 图 + 标题 ≤20 字 + 正文 ≤1000 字 + tags；④ 图片本地可打开、无 403；⑤ 面板能预览/复制/打开文件夹；⑥ 打开 creator 发布页后手动发布成功 1 次；⑦ 全程无自动发布请求。

**待实测**：未登录 explore 是否可看；DOM 选择器/SSR state 稳定性；`xsec_token` 导航；图片防盗链方案；creator 登录共享；发布页 DOM 与验证码；账号是否被踢下线。

## 7. 合规与风险

- **平台规则**：自动化抓取/发布可能违反用户协议；只读浏览也应控制频率、避免批量；不绕过验证码/风控；不做引流、纯搬运（xiaohongshu-mcp README 明确）。
- **账号风险**：登录环境异常、频繁发布、内容重复/搬运会触发限流/封号；新号/未实名更严；同一账号只允许一个网页端登录。
- **版权**：笔记图片/正文属于原作者；再发布需授权；草稿应优先原创素材，使用来源图必须标注并取得许可；总结只做评论/整合，不大段复制。
- **合规**：官方 API 需资质与 OAuth；不使用第三方“签名破解/绕风控”作为产品能力；只读采集也应尊重 robots/频控。
- **明确不建议全自动发布**：没有已核实的个人发布官方 API；Web 自动化有验证码/审核/账号权重风险；发布内容需人工确认版权与合规。若未来要做，条件：官方 API 获批 + 人工终审 + 每天 ≤1 条 + 不批量/不多账号。

## 8. 来源（2026-11-19）

- [OpenCLI 小红书站点资料](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/sitemaps/xiaohongshu/SITE.md)（登录墙/xsec_token/双 host）
- [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)（17,210★，Apache-2.0；登录/发布/详情需 xsec_token/单网页端登录/风险说明）
- [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)（13,333★，GPL-3.0；`sns-webpic-qc` 403/图片域名）
- [xhshow](https://github.com/Cloxl/xhshow)（1,123★，MIT；x-s/x-s-common 签名）、[ReaJason/xhs](https://github.com/ReaJason/xhs)（2,239★，MIT）、[MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)（71,372★，非商业学习许可）
- [XHS Publisher skill](https://skillhub.360.com/skills/waao666/xhs-publisher)（CDP 创作中心发布、需人工扫码、反自动化提示）
- [huashu-chrome 小红书实测笔记](https://github.com/shuaipotian-joke/huashu-chrome/blob/HEAD/docs/%E7%BB%8F%E9%AA%8C/xiaohongshu.com.md)（2026-09 发布页 DOM：18 图、tiptap 正文、话题候选、closed shadow DOM 发布按钮）
- [开放平台 API 实操](https://cloud.tencent.cn/developer/article/2735161)（OAuth2/资质/笔记接口，个人限制；**发布权限需向官方核实**）
- 本机代码：`src-tauri/src/video/{model,adapter,extract,session,browser}.rs`、`src/plugins/video/*`；实测 `GET /explore` 200 含登录、creator `/publish/publish` 200 登录页
## 9. 图片懒加载处理与已知易碎点（2026-11-20 实测补充）

### 9.1 懒加载处理（已实现）

- 详情页 `Page.navigate` 成功、页面就绪后，先 `prime` 一次：
  `window.scrollTo(0, document.body.scrollHeight)` → 回顶 → 对滑动画廊逐张
  `scrollIntoView({block:"center"})`（每步 180–220ms），触发首屏外/轮播图加载；
- 轮询图片签名（`src` → `data-src` → `srcset` 第一项），签名**连续 2 次 300ms 相同**视为稳定，
  最多等 6s；随后才执行抽取脚本；
- 抽取时同一来源再读一遍 `src / data-src / srcset`，过滤 `data:`、`blob:`、
  `/placeholder` 与 `complete` 且 `naturalWidth<=1` 的占位图；
- `image_urls` 去重按**去掉 query/hash 的路径**（`?imageView2/…` 参数不同视为同一张），
  Rust 侧 `normalize_image_urls` 再做一次同样规则的兜底去重；
- 抽不到图时落诊断日志：
  `XHS_EXTRACT_MISS field=image_urls url=… reason=selector-empty|placeholder-only|lazy-not-loaded`。

### 9.2 其它字段健壮性

- 点赞/收藏：多套选择器（`.like-wrapper .count`、`.interact-container .count`、
  `[class*="like"] .count`、`.collect-wrapper .count`…）任一命中即取；解析 `1.2万`→12000、`3k`→3000；
- 发布时间：`.date`、`.bottom-container .date`、`time`、`[class*="date"]`，支持
  「刚刚 / N分钟前 / N小时前 / 昨天 / YYYY-MM-DD / MM-DD」（未来日期回退到上一年）；
- 正文/标签：`.desc`、`#detail-desc`、`[class*="desc"]`；标签取正文里以 `#` 开头的 `a` 文本。

### 9.3 已知易碎点

- 小红书 Web 前端更新频繁，`#detail-title`、`.note-slider`、`.like-wrapper` 等 class 可能改名；
  选择器均带 `[class*="…"]` 兜底，但仍需按 `XHS_EXTRACT_MISS` / 缺字段日志回归；
- 滑动画廊若未真正切换，部分图片仍可能拿不到（`lazy-not-loaded`），此时 `image_urls` 会偏少但不会崩；
- 点赞/收藏/日期在首屏异步渲染前可能短暂缺失（值为 `null`），不是采集失败；
- 登录墙/验证码/风控未做绕过（只识别并停止）；未登录时 explore feed 可用，但部分笔记会跳登录；
- 图片直链有防盗链（`sns-webpic-qc.xhscdn.com` 直链 403）：本插件**只记录 URL、不下载**，
  再发布一律使用平台「文生图」，不搬运原图。

## 10. 登录检测修正（2026-11-20，误判「已登录仍报登录墙」）

旧逻辑只看 `loginVisible`（`.login-container/.login-mask` 选择器存在或正文含
`登录后查看/请先登录`），会把隐藏的登录按钮容器/页脚文案误判成登录墙。

新逻辑三级判定（`adapter::XIAOHONGSHU_LOGIN_PROBE`，导航后、抽取后执行并覆盖旧判断）：

1. URL 是否被重定向：`/login` 或含 `redirectPath=`；
2. 登录用户标识：`.user .avatar` / `.user-info` / `[class*="user-avatar"]` 可见，
   或 `window.__INITIAL_STATE__.user.userId` 非空；
3. 登录弹窗遮罩：`.login-container` / `[class*="login-modal"]` / `.mask` **可见**
   且内部 `input` 可见。

只有「① 重定向」或「② 无用户标识 **且** ③ 弹窗可见」才判为登录墙；否则忽略旧误判并继续采集。
诊断日志（未登录判定或纠正误判时）：

```
XHS_LOGIN_PROBE url=… hasAvatar=… userId=… loginModal=… redirected=… verdict=login-wall|logged-in
```

实测（已登录 profile）：4 分钟采到 7 篇不同笔记、0 失败、无 `LOGIN_REQUIRED`。
