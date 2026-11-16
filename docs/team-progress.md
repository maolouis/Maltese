# 团队进度看板

多窗口/多 agent 协作时，用一份约定好的 JSON 记录每个任务的**步骤级**进度，随时可以看。

## 用法

```powershell
node scripts/team-progress.mjs           # 打印一次看板
node scripts/team-progress.mjs --watch   # 每 2 秒刷新（Ctrl+C 退出）
node scripts/team-progress.mjs --json    # 原始 JSON，给别的工具消费
```

## 数据文件：`.arts/team-progress.json`

```json
{
  "updatedAt": "2026-11-16 16:22:42",
  "tasks": [
    {
      "id": "task-1",
      "title": "诊断：主动程度 100% 但长时间不发消息",
      "status": "done",
      "owner": "proactive-diag",
      "eta": "已收尾",
      "updatedAt": "2026-11-16 16:22:42",
      "steps": [
        { "title": "梳理门控链", "status": "done", "log": "18 个 return 点全部定位" },
        { "title": "回归", "status": "pending", "log": "冷启动 10 次" }
      ]
    }
  ]
}
```

字段约定：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `status`（任务） | `pending` / `running` / `blocked` / `done` / `failed` | 看板首行显示中文状态 |
| `status`（步骤） | 同上 | `running` 的那个会成为「当前步骤」 |
| `owner` | agent 名 | 显示成 `@名字` |
| `log` | 一句话 | 步骤后面跟一行「最近发生了什么」 |
| `eta` | 自由文本 | 「预计：…」行 |
| `updatedAt` | 本地时间字符串 | 看板显示「N 分钟前更新」 |

## 团队协作时的约定

1. 领任务时先写一条 `status=running` 的任务；
2. 每个步骤开始/结束都更新对应 `steps[i].status` 和 `log`；
3. 全部步骤 `done` 后把任务置 `done`，并更新 `updatedAt`；
4. 卡住就置 `blocked` 并在 `log` 写清卡在哪，别人一眼能看到。

## 局限

这是文件驱动的看板，不是 GUI 面板：它反映的是**被写进 `team-progress.json` 的进度**。
如果要在 DSH Web GUI 里做成常驻面板，需要写一个 DSH 插件页面（读同一份 JSON），
可作为下一步；当前先用这个看板 + `node --watch` 方式看进度。