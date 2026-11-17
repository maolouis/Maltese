# 子 agent 编制（2026-11-17 精简版）

> 原则：**只留必要的 6 个角色**；一次性 agent 全部归档，不再派活。新任务一律用 `send_message` 续跑常设 agent。
> 写入必须落在各自 write scope 内；只有用户明确说「发布」才升版本号 + push + 打 tag + 发 Release。

## 一、常设角色（唯一在用的）

| 角色 | agent | 负责模块 | write scope |
| --- | --- | --- | --- |
| 产品 | `product-acceptance` | 需求澄清、验收标准、优先级、人设/文案脚本、产品文档 | `docs/**`（产品/验收/脚本类 md） |
| 测试 | `qa-feature-test` | 用例设计、实机观测、缺陷复现定位、验收报告 | `docs/qa-*.md`、`work/**` |
| 研发·核心 | `dev-fix` | 聊天与模型链路、消息提醒、隐私边界、数据结构、构建 | `src/PetChat*`、`src/localChat*`、`src-tauri/src/local_chat.rs`、`dsh_chat.rs`、`wechat_*`、`qq_*`、`tests/**` |
| 研发·桌面 | `dev-shell`（首次派活时创建） | 主岛窗口几何、最小化/漂移、置顶、多实例联动、插件面板 UI | `src/App.tsx`、`src/App.css`、`src/DesktopExtras.css`、`src/petLink*`、`src/plugins/**`、`src-tauri/src/{lib,window_factory,desktop_extras,desktop_icons,instance_lock}.rs` |
| 预研 | `research-im-source` | 技术选型调研、方案对比、可行性结论 | `docs/research-*.md` |
| 交付 | `delivery-verify` | 三条硬验证、仓库卫生、产物核对、交付结论 | `docs/delivery-*.md` |

**研发分模块规则**：同一文件同一时间只归一个研发；跨模块改动由 lead 拆成两条任务分别派给 `dev-fix` 与 `dev-shell`，禁止两边同时改同一文件。

## 二、归档（不再派活，仅作历史记录）

| agent | 曾负责 |
| --- | --- |
| `startup-diag` | 启动显示不全诊断 |
| `proactive-diag` | 主动消息不触发诊断 |
| `multi-instance-impl` | 多实例启动 P0/P1 修复 |
| `qa-regression` | B1/B2 回归定位 |
| `dev-adjudicate` | 8px 位移判定 |
| `b2-matrix` | B2 强触发矩阵录制 |
| `dev-fix-qa` | D1–D5 缺陷修复 |
| `gif-grid-dev` | GIF 方格/拖拽/右键删除初版 |
| `dev-drag-fix` | 拖拽失效修复 |
| `plugins-ux-dev` | 插件说明改点击 + 视频文档 |
| `release-2-1-0` | v2.1.0 发版（已叫停，未产生副作用） |

归档 agent 的产出都已在 `docs/`，需要跟进时由对应常设角色接手，**不再新开一次性 agent**。

## 三、固定流转

```
产品定验收标准 → 测试跑缺陷清单 → 研发（按模块）修 + 补单测 → 测试复测 → 交付验证出结论 → （用户点头）发布
```

## 四、汇报格式（所有 agent 统一四段）

**改了什么 / 结论与证据（文件:行号）/ 验证输出 / 还没验证什么**
禁止"已完成"式空口汇报；禁止用"应该可以"代替实测。

## 五、进度

`.arts/team-progress.json`（`node scripts/team-progress.mjs --watch`），团队任务板同步 claim → 完成。