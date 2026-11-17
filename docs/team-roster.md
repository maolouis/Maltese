# 子 agent 编制与责任边界（团队常设）

> 规则：**不再为每个任务新开 agent**。每个角色只保留 1 个常设 agent，新任务用 `send_message` 交给它继续做；
> 只有角色本身缺失时才新建。所有 agent 共享同一工作目录，写入必须落在各自的 write scope 内。

## 1. 常设编制（4 个角色，各 1 个 agent）

| 角色 | 常设 agent | 职责（只做这些） | 不做 |
| --- | --- | --- | --- |
| **产品** | `product-acceptance` | 需求澄清、验收标准（Given/When/Then）、优先级与取舍、用户视角结论、`docs/` 里的产品类文档 | 不改代码、不跑构建、不判定技术可行性 |
| **测试** | `qa-feature-test` | 按验收标准设计用例、实机构建与观测、缺陷复现与定位（只读）、缺陷清单 D1/D2…、验收报告 | 不改 `src/`、`src-tauri/`、`tests/`；不修缺陷 |
| **研发** | `dev-fix` | 根因定位、实现修复、补单测、构建自测、修复记录；**唯一可改源码的角色** | 不改验收标准；不替测试判定通过 |
| **交付验证** | `delivery-verify` | 三条硬验证（tsc / cargo check / node --test）、版本与仓库卫生、产物核对、交付结论（可交付 / 有条件 / 返工） | 不改代码、不改产品条款 |

> 历史遗留的一次性 agent（`proactive-diag`、`startup-diag`、`multi-instance-impl`、`qa-regression`、`plugins-ux-dev`、
> `gif-grid-dev`、`dev-adjudicate`、`b2-matrix`、`dev-fix-qa`、`dev-drag-fix`）**不再派活用**，只作为历史记录。
> 它们的产出已经落在 `docs/` 里，需要继续时一律交给上面 4 个常设 agent。

## 2. 写入边界（write scope）

| agent | 允许写 | 明确禁止 |
| --- | --- | --- |
| product-acceptance | `docs/**` 下的产品/验收类 md | 任何源码、`tests/`、版本文件 |
| qa-feature-test | `docs/qa-*.md`、`work/**`（截图/日志） | 任何源码、`tests/`、用户 localStorage/profile |
| dev-fix | `src/**`、`src-tauri/**`、`tests/**`、`docs/`（修复记录） | 版本号四处（`package.json` / `tauri.conf.json` / `Cargo.toml` / README 徽章）、远端推送 |
| delivery-verify | `docs/delivery-*.md` | 任何源码、版本号、发布动作 |

**只有用户明确说「发布」**，才允许：升版本号 + `git push` + 打 tag + 发 Release。平时一律"只本地提交"。

## 3. 任务流转（固定 4 步，不跳步）

```
产品：定义验收标准（docs/bug-acceptance-*.md）
  ↓
测试：按标准跑 → 缺陷清单（D1…Dn，含复现/证据/可疑代码）
  ↓
研发：修缺陷（补单测、构建自测、写修复记录）
  ↓
交付验证：三条硬验证 + 版本/仓库卫生 → 交付结论
```

- 研发修完必须回到测试复测（同一 agent，`send_message` 续跑，不开新 agent）；
- 交付验证只认测试的复测结论 + 自己的三条命令，不认研发自述；
- 任何角色发现"根因在别的角色范围内"，写进报告并 `send_message` 移交，不越界改。

## 4. 进度可见

每个任务在认领/推进/完成时更新 `.arts/team-progress.json`（结构见 `docs/team-progress.md`），
用 `node scripts/team-progress.mjs --watch` 看步骤级进度。团队任务板（`team_task_*`）与这份 JSON 保持同步：
- 建任务 → 认领（claim）→ 每步更新 → 完成（complete）；
- 一个任务在同一时刻只有一个 owner。

## 5. 当前待办（按角色）

| 角色 | 待办 |
| --- | --- |
| 产品 | 确认设置入口语义（顶部设置 → 岛内设置页 vs 独立窗口）；给「对话 vs 主动」P0 三条排优先级 |
| 测试 | 复测拖拽排序 / 右键删除（真人鼠标）；复测「对话首字」在思考档位下的表现 |
| 研发 | 待产品确认后修「对话思考不出正文」P0 三条（主动让路 / token 联动 / 流式空正文重试） |
| 交付验证 | 待上述修复完成后做一轮完整交付验证（含产物重建） |

## 6. 汇报格式

每个 agent 回报固定四段：**改了什么 / 结论与证据（文件:行号）/ 验证输出 / 还没验证什么**。
禁止只说"已完成"而不给证据；禁止用"应该可以"代替实测。