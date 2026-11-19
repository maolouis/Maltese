# 小红书采集与图文草稿（MVP1 + MVP2 最小版）

> 版本 2.0.3 · 只本地 commit。研究依据：[docs/research-xiaohongshu.md](research-xiaohongshu.md)。
> 代码：`src-tauri/src/video/{model,adapter,extract,queue,xhs_draft,session}.rs`、
> `src/plugins/video/{XhsDraftPanel.tsx,types.ts,VideoAutomationPlugin.tsx}`。

## 一、MVP1：只读采集

### 平台与入口

- `Platform::Xiaohongshu`（serde `"xiaohongshu"`，也接受 `xhs` / `redbook`）；
- 首页 feed：`https://www.xiaohongshu.com/explore`；
- 面板平台下拉新增「小红书（只读采集）」；采集会话与 B 站/抖音完全共用
  `ROUND / CANDIDATES / ITEM_COLLECTED / SESSION_SUMMARY` 队列骨架。

### 为什么必须用 feed 链接导航

小红书笔记详情 `www.xiaohongshu.com/explore/<noteId>` **必须带 `xsec_token`**
（裸链接会 403）。所以候选脚本只收「带 `xsec_token` 的完整链接」：

- 优先 `window.__INITIAL_STATE__` 的 `feed.feeds`（或 `feed.value`）里的
  `noteId + xsecToken`，拼成 `/explore/<id>?xsec_token=…&xsec_source=pc_feed`；
- 兜底深度遍历 state，找同时带 `noteId`/`note_id` 与 `xsecToken`/`xsec_token` 的对象；
- 再兜底 DOM `a[href*="/explore/"]` / `a[href*="/discovery/item/"]`；
- **没有 `xsec_token` 的链接直接丢弃**，不导航，避免 403 后反复失败。

`queue.rs` 的 `parse_candidates` 支持 `urls` 通道：保留 feed 给的完整 URL（含 token），
按 noteId 去重；URL 命中判定只比 noteId，忽略 query（token 变化不影响判定）。

### 字段

`ContentItem` 新增（`serde(default)`，旧数据兼容）：

| 字段 | 说明 |
| --- | --- |
| `image_urls[]` | 图片直链（**只记录，不下载**，最多 18 张） |
| `note_type` | `image` / `video` |
| `like_count` / `collect_count` | 互动数（页面显示 k/w 已换算） |
| `published_at` | 发布时间（unix 秒；页面只有日期时按本地 0 点估算） |
| `xsec_token` | 导航该笔记必须带的 token |
| `cover_url` | 封面（og:image 或首图） |

`extract.rs` 白名单同步扩充；`is_video_page` 对小红书识别
`/explore/<20–32 位 alnum>` 与 `/discovery/item/<id>`（`/explore` 本身是 feed，不算详情页）。

### 登录与风控

- 登录复用 `video_open_login_window` + 每个账号独立 profile
  （`%LOCALAPPDATA%\Maltese\video-accounts\<accountId>`），人工扫码一次即可持久化；
- **同一账号不要同时在多个网页端登录**：小红书只允许一个网页端会话，别处登录会把
  专用 profile 踢下线（表现为笔记页跳登录/403）；
- 页面识别 `login_visible` / `captcha_visible` / `risk_banner`，命中登录墙进
  `AwaitingLogin`（`LOGIN_REQUIRED`），命中验证码/风控记 `RISK_CONTROL` 并停止；
- 只读采集也控制节奏（沿用 15s+ 翻页间隔），不绕验证码、不做签名（不引入 `x-s`）。

### 不做

- 不自动发布（不点发布按钮、不调发布接口）；
- 不做签名算法（`x-s`/`x-s-common`）与 API 直连；
- 不做评论/点赞/收藏（小红书评论在面板里被显式跳过）。

## 二、MVP2：最小草稿流

### 生成

- 面板（平台选「小红书」）出现「小红书图文草稿」卡片：
  **生成图文草稿** → 取最近一轮有内容的会话（或指定会话）条目 → 生成
  `标题 ≤20 字 / 正文 ≤1000 字 / tags ≤8 个`；
- 优先用当前聊天模型（45s 超时），失败/未配置降级模板，日志：
  `XHS_DRAFT_FALLBACK reason=… generator=template`、`XHS_DRAFT_BUILT generator=… dir=…`；
- 落盘：`<数据目录>/xiaohongshu/drafts/<时间戳>/draft.json + readme.md`
  （本机数据目录当前为 `E:\MalteseData`，与 `video/` 同级）。

### 复制与投稿

- 卡片提供：复制标题 / 复制正文 / 复制标签 / 复制全部文案；
- 「打开小红书投稿页」→ `https://creator.xiaohongshu.com/publish/publish?source=official`
  （默认停在「上传视频」，需手切「上传图文」）；
- 「打开草稿文件夹」→ `xhs_open_drafts_dir`。

### 图片策略（重要）

**只准备文案，不下载/不转存他人原图。** 配图由用户在小红书创作中心用平台自带的
「文生图」生成；`draft.json` 只记录来源笔记的图片**数量**与来源作者，不保存图片文件。
原因：图片防盗链（`sns-webpic-qc.xhscdn.com` 直链 403）+ 再发布版权风险。

发布的最后一步（选图、确认、点发布）始终由人完成；本模块**没有任何自动发布请求**。

## 三、验证

```powershell
cargo check
node node_modules/typescript/bin/tsc --noEmit
node --test tests/video-*.mjs
```

实机采集需先人工扫码登录专用 profile，然后用平台「小红书」启动一轮采集；
日志里应看到 `CANDIDATES n=…`、逐条 `ROUND`、`ITEM_COLLECTED url=…/explore/… title=…`。