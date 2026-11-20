# Maltese 待办清单（TODO）

> 最后更新：2026-11-20 · 面向用户与协作者。
> 只记**已复现或已确认**的待办；每条给出现象、影响、状态、归属模块和文档入口，不写猜测。
> 状态值：**待做**（还没动手）/ **进行中**（已开工或已有部分改动）/ **已定位待修**（现象和停点清楚，缺修复或验证）；
> 「已评估 · 暂不实现」单独放在最后一节。
> 优先级：**P0** 影响启动或主线交付 · **P1** 影响日常使用 · **P2** 增强项 / 待发布验证。

## P0：阻断主线

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-01 | 冷启动间歇卡死：双击后小狗不出现、进程 `Responding=False`；最近一轮压测 **5 次里 4 次**复现，停点 `setup:island_ready` 之后没有首帧 | 用户以为没启动，只能强杀重开；发布可信度受损 | 已定位待修 | Rust 启动流程（建窗 / setup）+ 前端首帧握手 | 已内置 `[startup]` 分步时间戳与 8s watchdog，还差**卡死时抓主线程栈**（本机未装 procdump，有替代方案）。手册：[diagnostics/startup-hang-playbook.md](diagnostics/startup-hang-playbook.md)。注意更早一轮还记录过「首帧后才卡死」，两条路径要分别抓栈 |
| T-02 | 小红书评论自动提交走不通：`click-placeholder` → `wait-editor` → `write` 均已通过，卡在最后一步找不到发送按钮（原因码 `no-button`） | 小红书自动评论只能试跑、不能真发，结果如实报「未发送」 | 已定位待修 | 视频插件 `src-tauri/src/video/`（CDP 注入脚本 / comment）+ `src/plugins/video/` 面板 | 已能输出候选按钮与逐步日志；原因码定义见 [video-plugin-commands.md](video-plugin-commands.md)，真发验收清单见 [video-plugin-todo.md](video-plugin-todo.md) §B |

## P1：影响日常使用

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-03 | B 站自动评论被平台拒：站点返回 `-107 账号未转正` | 未转正账号发不出评论；这是平台侧限制，代码不绕过风控 | 已定位待修 | 视频插件 comment / session + 面板文案 | 面板已给出中文原因并用 `verified` 如实回读；原因码见 [video-plugin-commands.md](video-plugin-commands.md)。账号转正后需再实机真发一条确认 |
| T-04 | 混合 DPI 未实测：本机两块屏都是 100%，150% 副屏的尺寸 / 字号换算只有单测 | 副屏缩放不是 100% 的用户可能遇到窗口偏小或偏移，属于未验证风险 | 待做 | 几何 / 多屏（Rust monitor 选择 + 前端换算） | 静态换算与 `toPhysical` / `pinnedPhysicalSize` 单测已过；见 [island-geometry-status.md](island-geometry-status.md) §3 与 [pet-multi-monitor.md](pet-multi-monitor.md) |
| T-05 | 几何双击闪动架构修复：双击 / 右键开浮层会偶发位移、闪一下；现在靠「合并右键 / 双击路径 + 事后纠正」止血，根因仍是多份真值与事件竞态 | 偶发小狗跳位、闪动，观感与信任度受损 | 进行中 | Rust 几何入口 + `src/App.tsx` 锚点 | 双击已复用右键的锚点 / 纠正序列（`1bb566a`），并已加「浮层单次落位（预补偿）+ 启动恢复同步 settled」（`96ab152`）；单一真值 + 状态机重构方案见 [geometry-architecture.md](geometry-architecture.md)，现状汇总见 [island-geometry-status.md](island-geometry-status.md) |
| T-06 | 窗口边缘缩放 + 尺寸持久化：希望能直接拖窗口边缘改大小，并记住上次尺寸 | 每次都要进设置里调，展开 / 收起尺寸不跟手 | 进行中 | 前端岛壳 + Rust 窗口几何 | 代码已落地（`96ab152`：窗口可拖拽改大小并持久化 + 启动恢复同步 settled），差实机验证与边界回归；尺寸真值还要并入几何重构（T-05），避免再多一份 |
| T-07 | 切页签窗口上下移动：在待办 / 音乐 / 剪贴板 / 聊天等页签之间切换，窗口高度变化会带动窗口位置抖动 | 切换页签时小狗跟着上下跳 | 进行中 | 前端页签 + Rust 窗口尺寸 / 位置 | 与 T-05 / T-06 同源（几何真值不唯一）；先按狗槽不变量校正，再随重构收敛 |
| T-08 | 字体自定义：要能换界面与桌宠字体，而不是只有「默认字体 / 像素字体」两档 | 想换字体或放大像素字只能改代码 | 进行中 | 前端 `App.tsx` / `App.css` / `i18n` | 已落地「界面字体 / 桌宠字体」预设 + 自定义字体名 + CSS 变量持久化，说明见 [ui-fonts.md](ui-fonts.md)；剩余实机验证、字号粒度与 emoji 回退边界，回退链见 [pet-chat.md](pet-chat.md) 字体一节 |
| T-09 | 实例联动下线待修复：双狗接话偶发问题，已用 feature flag 关闭 | 设置里的联动区块隐藏、联动不再说话（不报错、不崩） | 已定位待修 | 联动 `petLinkBus` + 设置页 | 下线提交 `fc5bb3a`：`PET_LINK_ENABLED=false`，事件不派发（日志 `PET_LINK_DISABLED`），代码与文档保留；设计与回开清单见 [multi-instance-linkage-design.md](multi-instance-linkage-design.md)，原用法见 [pet-linkage-usage.md](pet-linkage-usage.md) |

## P2：待发布验证 / 增强

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-10 | 数据目录改到 `<exe>\data`：2.0.4 实测默认 `data/` 未生效（数据仍写在旧位置），**自 2.0.5 起生效**；首次启动迁移旧数据并在原处留说明 | 用户关心的「数据到底在哪、能不能带走」还没有稳定答案 | 待做 | `paths.rs` + 启动迁移 | 代码已落地（便携 `data/` + 迁移 + 启动即创建），剩余是 2.0.5 实机验证与迁移回归。方案与体积盘点见 [data-directory-plan.md](data-directory-plan.md) |
| T-11 | 每日图文总结视频：把当天刷到的内容做成「封面 / 截图 + 文字要点 + 配音」的总结视频 | 目前只有文字小结，没有能直接发布的视频成品 | 待做 | 视频插件 + 新增渲染 / TTS 流水线 | 预研完成：本机没有 ffmpeg、TTS 可用、条目缺封面 / 截图；推荐「本地生成 + 平台投稿页人工最后一步」，MVP 复杂度 M。见 [research-daily-summary-video.md](research-daily-summary-video.md)（预研按 B 站 / 抖音条目做，小红书图文要另补图源） |

## 已评估 · 暂不实现

| 编号 | 现象 / 需求 | 影响 | 当前状态 | 归属模块 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T-12 | Agent 控制台的外部 CLI / 平台用量：想统计 Codex、Claude Code、豆包、ChatGPT 网页等的 token 用量 | 当前只覆盖我们自己发起的调用，外部平台用量缺失 | 已评估 · 暂不实现 | Agent 控制台 usage 记录 | 结论：外部平台 token 数基本拿不到（豆包只有额度百分比；网页版要 CDP 注入、易被风控），只抓「额度百分比」收益不够。研究与后续建议见 [research-external-token-usage.md](research-external-token-usage.md)，控制台说明见 [agent-hub.md](agent-hub.md) |

## 怎么维护这张清单

1. 修完一条就改「当前状态」，不要删行，保留历史口径；
2. 新增待办沿用 `T-编号` 递增，写清现象 + 影响 + 归属模块；
3. 提交信息用 `docs:` 前缀，代码改动不要混进本文档；
4. 只有「已复现 / 已确认」的才进清单，传言和想法先放会话里。