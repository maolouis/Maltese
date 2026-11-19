# 视频插件剩余工作清单（2026-11-19）

> 状态快照基于 `89bb3af`（BROWSER_RESTART 重新拉起）及其之前的提交；
> 当前工作区有未提交改动（用户正在改框架），本清单只描述"还差什么"，不涉及提交代码。

## 0. 总体目标

让视频插件达到「可交付」：连续 3 次启动都能各采到 ≥2 条真实 `/video/BV…` 条目；
评论能真发并有 `verified` 证据；抖音与 B 站能力对齐；日报/小节能稳定产出。

---

## A. 采集稳定性（P0，最高优先）

### A1. 已验证到哪一步

- ✅ 单实例化：启动时 + 每 10s 探测 9333–9338，多于一个关掉多余的
  （`BROWSER_ENFORCED_SINGLE closed=1 kept_port=9334 alive=[9333,9334]`）。
- ✅ target 选择：`pick_page` 优先 `/video/` + `Page.bringToFront`；`NAV_VERIFIED` 复核。
- ✅ `TARGET_REPICK`：每轮采样前读 `location.href`，不在 `/video/` 就重选 page 并重导航
  （实机日志已出现 `from=https://www.bilibili.com/ to=…/video/BV15es76gEgL/`）。
- ✅ `NAV_REVERT`：页面被带回首页时记录 `from/to/expect/referrer/history/attempt`，
  并重导航最多 3 次（`e286613`）。
- ✅ `BROWSER_RESTART`：关闭旧实例 → 重新 launch（同 profile，失败重试一次）→ `wait_for_cdp(8s)`
  → `force_enter_video_page` → `ok=true port=… url=…`；任一步失败写 `ok=false step=launch|cdp|nav`
  并停止本轮（`89bb3af`）。**仅编译通过，尚未实机跑到 `ok=true`。**
- ✅ `SESSION_STALLED`：30s 无采集变化 → 中文原因 + 停止本轮。
- ✅ `ITEM_ADVANCED` 后同步 `expect_video_url`，并立即 `ADVANCE_RENAV` 复核（`9f60879`/`3ae363d`）。

### A2. 还缺什么

| 项 | 优先级 | 预估改动 | 复杂度 |
|---|---|---|---|
| 实机验证 `BROWSER_RESTART ok=true` 后能继续 `ITEM_COLLECTED` | P0 | 无代码，需一次实跑（用户手动点「开始看」） | 低 |
| 连续 3 次启动各采 ≥2 条真实 BP 视频（稳定性硬指标） | P0 | 无代码，需 3 次实跑 + 日志归档 | 中 |
| `NAV_REVERT` 归因：用 `referrer/history` 判断是站点重定向还是我们点击；若是我方点击则移除该兜底 | P0 | `session.rs`（`force_enter_video_page`/健康检查） | 中 |
| 切换视频后偶发 `SESSION_STALLED`（`1411fd`：`ADVANCE to=BV1JNsr67EbT` 后 39s 停在旧视频） | P0 | `session.rs`（advance 后等页面 load 完成再采样） | 中高 |
| `ADVANCE_RENAV` 实机验证（切视频后 URL 不是 /video/ 时当场重导航） | P1 | 无代码，实跑 | 低 |
| `BROWSER_RESTART` 失败分支的面板文案/停止按钮验证 | P1 | 前端面板（可选） | 低 |
| 多标签页同实例（同一端口多个视频 tab）的 target 切换验证 | P1 | `cdp.rs`（按 target id 锁定） | 中 |

---

## B. 评论真发验证（P0）

### B1. 已验证到哪一步

- ✅ dry-run 全链路：生成 → `COMMENT_DRY_RUN url=… text=…` → 气泡事件；
  实机文本「阳光洒在辛德拉的角落，光影温柔得像一首无声的诗…」。
- ✅ 真发前置校验：登录/风控 → `COMMENT_SKIPPED reason=login_or_risk`；
  非视频页 → `reason=not_video_page`（`add1d20`）。
- ✅ 发送后回读：3×1.5s 轮询 `document.body.innerText`，`comment_in_text` 匹配；
  命中 `COMMENT_POSTED verified=true`，未命中 `COMMENT_UNVERIFIED` + 面板中文原因。
- ✅ `last_comment_verified` 进 live snapshot；面板显示（预演）/（已发）/（未验证）。
- ✅ 评论自检命令 `video_comment_selftest` + 「评论自检」按钮（不依赖采集）。

### B2. 还缺什么

| 项 | 优先级 | 预估改动 | 复杂度 |
|---|---|---|---|
| 实机真发一条并拿到 `COMMENT_POSTED verified=true/false` | P0 | 无代码；需一次真实评论（用户知情） | 低 |
| 回读窗口验证：B 站评论区懒加载/折叠时可能 3×1.5s 不够，必要时改 5×2s | P1 | `session.rs` 常量 | 低 |
| 发送前置校验补「评论输入框存在/发送按钮可点」两项（目前只有 URL/登录/风控） | P1 | `session.rs`（CDP 选择器检查） | 中 |
| 历史小结里展示该会话评论列表（url + text + verified） | P1 | `VideoSession` + `VideoDigestList.tsx` | 中 |
| 抖音评论选择器（`[data-e2e=comment-input]`/`[data-e2e=comment-publish]`） | P1 | `comment.rs`/`session.rs` | 中 |
| 风控/验证码出现时立即停评并提示 | P0 | `session.rs`（已有 hints，需接入停评） | 低 |

---

## C. 抖音（douyin）适配（P1，共 8 项）

现状：抖音走通用适配（能打开首页、尝试导航/采集），但专用能力缺失，UI 仍标注实验特性。

| # | 项 | 优先级 | 预估改动 | 复杂度 |
|---|---|---|---|---|
| 1 | URL 白名单：`is_video_page` 支持 `/video/<id>`、`/note/<id>`；过滤首页/`/discover`/`/search`/`/user`/`/live` | P1 | `video/extract.rs` | 低 |
| 2 | `canonicalUrl` 归一化：去 query、去 `modal_id`，统一成 `https://www.douyin.com/video/<id>` | P1 | `video/extract.rs` | 低 |
| 3 | 强制进视频页：`a[href*="/video/"]`/`[data-e2e="feed-video"]` 卡片点击 + 关闭登录弹窗（`.login-mask`/`[data-e2e="login-modal"]`/Esc）+ 轮询 `/video/` | P1 | `video/session.rs`（新 `force_enter_douyin_page`） | 高 |
| 4 | 登录/风控识别：登录弹窗、`#captcha_container`/`[class*="captcha"]` 滑块 → `login_visible/risk_banner` 打点并停评 | P1 | `video/adapter.rs`/`session.rs` | 中 |
| 5 | 采集字段：标题（`[data-e2e="video-desc"]`/og:title）、作者（`[data-e2e="video-author"]`）、时长（`video.duration`）、点赞/播放、封面（og:image/poster） | P1 | `video/adapter.rs` | 中高 |
| 6 | 评论选择器与真发流程复用（输入框 + 发布按钮 + 回读） | P1 | `video/comment.rs`/`session.rs` | 中 |
| 7 | `channelCapability` 给抖音真实能力（full/partial）并把 UI「实验特性」改成明确限制说明 | P1 | `video/session.rs`/`channel.rs` + 前端文案 | 低 |
| 8 | 抖音实机验证（`NAV_OK/NAV_VERIFIED`、≥1 `ITEM_COLLECTED`、评论 dry-run/真发）与文档操作步骤 | P1 | 无代码（验证）/`docs/video-plugin-usage.md` | 中 |

---

## D. 日报/小节的视频依赖项（P0 依赖 A/B）

| 项 | 优先级 | 依赖 | 复杂度 |
|---|---|---|---|
| `DIGEST_BUILT` + `pending.json` 入队（已验证：`items=2 strong=5`、磁盘 `digest` 存在） | 已有 | A 稳定采集 | — |
| 历史会话能点开摘要（历史面板展示 `digest`/评论列表） | P1 | B 评论列表 + 前端 `VideoDigestList` | 中 |
| 视频日报与日常日报合并（投递渠道/去重/每日上限） | P1 | 稳定采集 + digest | 中高 |
| 内容质量：真实条目 title/author/duration 齐全后才进摘要（N2 已过滤伪条目） | 已有 | — | — |

---

## E. 建议执行顺序

1. **P0-1**：用户手动点「开始看」一次 → 拿 `BROWSER_RESTART ok=true` + ≥2 条 `ITEM_COLLECTED`；
2. **P0-2**：据 `NAV_REVERT` 的 referrer/history 修「页面被带回首页」的根因；
3. **P0-3**：真发 1 条评论，拿 `COMMENT_POSTED verified=…`，必要时调回读窗口；
4. **P0-4**：连续 3 次启动稳定性验收（各 ≥2 条）；
5. P1：评论输入框/按钮前置校验、历史评论列表、抖音 8 项（按 1→8 顺序）。

---

## F. 已知未提交改动（截至本文档创建时，勿与用户手动改动冲突）

- `src-tauri/src/video/config.rs`：`auto_comment=false`、`comment_dry_run=true`（用户把默认改回安全值）；
- `src-tauri/src/video/session.rs`：约 485 行改动（用户/框架调整，含格式与逻辑混合）；
- `src/plugins/video/VideoAutomationPlugin.tsx`、`types.ts`、`useVideoPluginState.ts`：少量字段/校验调整；
- 这些改动**未提交**，恢复改代码前需与用户确认归属。