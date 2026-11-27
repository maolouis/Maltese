# Maltese 待办清单（TODO）

> 最后更新：2026-11-26 · 面向用户与协作者。
> 只记**已复现或已确认**的待办；每条给出现象、影响、状态、归属模块和文档入口，不写猜测。
> 状态值：**待做**（还没动手）/ **进行中**（已开工或已有部分改动）/ **已定位待修**（现象和停点清楚，缺修复或验证）/ **已完成**（代码落地并通过验证）；
> 「已评估 · 暂不实现」单独放在最后一节。
> 优先级：**P0** 影响启动或主线交付 · **P1** 影响日常使用 · **P2** 增强项 / 待发布验证。

## P0：阻断主线

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-01 | 冷启动间歇卡死：双击后小狗不出现、进程 `Responding=False`；曾停在 `setup:island_ready` 之后没有首帧 | 用户以为没启动，只能强杀重开；发布可信度受损 | 已完成 | Rust 启动流程（建窗 / setup）+ 前端首帧握手 | 已修复并通过 20/20 × 2 轮冷启动验收（缓存锁全 `try_lock`、`on_window_event` 脏标记、专用几何线程、extras 延后、watchdog 异步）。见 [diagnostics/cold-start-hang-fix.md](diagnostics/cold-start-hang-fix.md) |
| T-02 | 小红书评论自动提交走不通：`click-placeholder` → `wait-editor` → `write` 均已通过，卡在最后一步找不到发送按钮（原因码 `no-button`） | 小红书自动评论只能试跑、不能真发 | 已完成（待安静窗口线上复验） | 视频插件 `src-tauri/src/video/comment.rs` | 已修复 `/\.submit/` 字面点号正则 bug、兼容「发 送」带空格文案与纯图标 `.submit-btn`、优先在编辑器所属底栏容器查找并支持 `pointerSequence` + `Enter` 清空校验，Mock DOM 4 场景单测全过 |

## P1：影响日常使用

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-03 | B 站自动评论被平台拒：站点返回 `-107 账号未转正` | 未转正账号发不出评论；这是平台侧限制，代码不绕过风控 | 已定位待修 | 视频插件 comment / session + 面板文案 | 面板已给出中文原因并用 `verified` 如实回读；原因码见 [video-plugin-commands.md](video-plugin-commands.md)。账号转正后需再实机真发一条确认 |
| T-04 | 混合 DPI 未实测：本机两块屏都是 100%，150% 副屏的尺寸 / 字号换算只有单测 | 副屏缩放不是 100% 的用户可能遇到窗口偏小或偏移 | 进行中 | 几何 / 多屏（Rust monitor 选择 + 前端换算） | 已补齐 `restore_island_rect_on_startup` 按目标屏实际 `scale_factor` 换算落定物理宽高；仍待真实 100%+150% 双屏硬件环境实测 |
| T-05 | 几何双击闪动架构修复：双击小狗偶发向左上角闪动 / 位移；根因是多份真值相互覆盖 | 小狗跳位、向左上角闪动，影响日常体验 | 进行中（核心闪动已修） | Rust 几何入口 + `src/App.tsx` 锚点 | 已修复：① `LAST_SETTLED_ISLAND_RECT` 与 `LAST_OUTER_WINDOW_RECT` 分离（浮层/展开外框不再污染狗槽缓存）；② `expected_slot_from_state` 在浮层期优先认 `OVERLAY_SNAPSHOT`；③ 云朵气泡已开时双击不再误用放大窗口左上角；④ `set_monitor_preferences` 启动不清空位置；⑤ 按 `side/vertical` 隔离实测偏移并改测 `.island__collapsed--pet-only` 消除首开 ~5px 残差 + `SWP_NOCOPYBITS`。完整 `DogSlot` 单一真值终态见 [geometry-architecture.md](geometry-architecture.md) |
| T-06 | 窗口边缘缩放 + 尺寸持久化：希望能直接拖窗口边缘改大小，并记住上次尺寸 | 每次都要进设置里调，展开 / 收起尺寸不跟手 | 已完成 | 前端岛壳 + Rust 窗口几何 | 边缘拖拽缩放 + `island-size.json` 持久化 + 设置「恢复默认窗口大小」均已落地并验收 |
| T-07 | 切页签窗口上下移动：在待办 / 音乐 / 剪贴板 / 聊天等页签之间切换，窗口高度变化会带动窗口位置抖动 | 切换页签时小狗跟着上下跳 | 已完成 | 前端页签 + Rust 窗口尺寸 / 位置 | 展开态高度已与 tab 解耦（`UNIFIED_EXPANDED_ISLAND_HEIGHT = 520`），切页签窗口不动 |
| T-08 | 字体自定义：要能换界面与桌宠字体，且直接检测本机系统现用字体 | 手输字体名门槛高、容易输错 | 已完成 | `src-tauri/src/system_fonts.rs` + `src/SystemFontSelect.tsx` | 已改为自动检测 Windows 现用系统字体（`SPI_GETNONCLIENTMETRICS`）与本机全部已安装可用字体（`EnumFontFamiliesExW`），下拉即选即生效；说明见 [ui-fonts.md](ui-fonts.md) |
| T-09 | 实例联动下线待修复：双狗接话偶发问题，已用 feature flag 关闭 | 设置里的联动区块隐藏、联动不再说话（不报错、不崩） | 已定位待修 | 联动 `petLinkBus` + 设置页 | 下线提交 `fc5bb3a`：`PET_LINK_ENABLED=false`；设计与回开清单见 [multi-instance-linkage-design.md](multi-instance-linkage-design.md) |
| T-13 | 主窗口自身遇 WebView2 `ERROR_BUSY (0x800700AA)` 无自动恢复 | 上一实例退出慢或默认 `EBWebView` 被占时主窗口建不出句柄 | 已完成 | `src-tauri/src/webview_profile_guard.rs` + `lib.rs` | 建主窗口前做 `lockfile` 独占探测 + 3 级退避重试，仍被锁死或只读时自动切换 `<data_root>\webview2-fallback-N`，实机锁文件压测通过 |
| T-14 | 新手引导过于简陋、白底浅字看不清且无重开入口 | 新用户无法直观选形象、学手势或调外观，英文界面未翻译 | 已完成 | `src/OnboardingPanel.tsx` + `OnboardingPanel.css` + `i18n` | 重构为高对比度浅色云朵 6 步交互式向导（角色实时切换、经典/液态玻璃与停靠角预览、手势试玩台、百宝箱、热键录制重置、中英双语），并在两个设置入口均支持重新打开 |

## P2：待发布验证 / 增强

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-10 | 数据目录改到 `<exe>\data` + 视频浏览器 profile 迁出 C 盘 | 用户关心数据位置与 C 盘占用 | 已完成 | `paths.rs` + `video/browser.rs` | 便携 `data/` 与 `<data_root>\video-browsers` 迁移均已生效并释放 C 盘约 3.5 GiB，见 [data-directory-plan.md](data-directory-plan.md) |
| T-11 | 每日图文总结视频：把当天刷到的内容做成「封面 / 截图 + 文字要点 + 配音」的总结视频 | 目前只有文字小结，没有能直接发布的视频成品 | 待做 | 视频插件 + 新增渲染 / TTS 流水线 | 预研见 [research-daily-summary-video.md](research-daily-summary-video.md) |

## 已评估 · 暂不实现

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-12 | Agent 控制台的外部 CLI / 平台用量：想统计 Codex、Claude Code、豆包、ChatGPT 网页等的 token 用量 | 当前只覆盖我们自己发起的调用，外部平台用量缺失 | 已评估 · 暂不实现 | Agent 控制台 usage 记录 | 结论：外部平台 token 数基本拿不到；研究见 [research-external-token-usage.md](research-external-token-usage.md) |

## 怎么维护这张清单

1. 修完一条就改「当前状态」，不要删行，保留历史口径；
2. 新增待办沿用 `T-编号` 递增，写清现象 + 影响 + 归属模块；
3. 提交信息用 `docs:` 前缀，代码改动不要混进本文档；
4. 只有「已复现 / 已确认」的才进清单，传言和想法先放会话里。
