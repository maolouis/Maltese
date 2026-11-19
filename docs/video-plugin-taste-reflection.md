# 视频口味（聊天调整）与看完感悟

> 版本 2.0.3（本地改造）。代码：`src-tauri/src/video/{taste,reflection,profile,mod,session}.rs`、
> `src/plugins/video/{VideoTasteCard.tsx,videoStateStore.ts}`、`src/petSkills.ts`。

## A. 聊天调整视频口味（skill `video_taste`）

### 入口

- 技能注册在 `src/petSkills.ts`：`SkillAction` 增加 `video_taste`，`SKILLS` 增加定义，
  老用户用独立迁移键 `maltese-skills-migrated-20261119-video-taste` 自动补进已启用列表；
- 模型输出 `{"tool":"video_taste","args":{"text":"少刷游戏区，多来点纪录片"}}`，
  `runSkill` 调 Tauri 命令 `video_update_taste { text }`，把返回的 `reply` 交回模型作自然语言确认；
- 只改视频口味画像的**正/负标签**，不改平台、时长、自动评论、投递等设置。

### 解析规则（`video/taste.rs`，纯逻辑有单测）

| 说法 | 结果 |
| --- | --- |
| 我不想看游戏区了 / 少刷游戏 / 别看直播 | 负标签 `游戏` / `直播`，同时把同名正标签移除 |
| 多给我刷点美食/纪录片 | 正标签 `美食`、`纪录片`，同时移除同名负标签 |
| 少刷游戏，多看纪录片 | 一句话同时处理两件事 |
| 恢复默认口味 | 清空正/负标签与来源（`video_reset_taste`） |
| 今天天气不错 | 解析失败 → 返回 `TASTE_UNCLEAR` + 反问文案，**不改任何东西** |

分类词会归一化（`游戏区/电竞` → `游戏`，`番剧/动漫` → `动画`，`吃播` → `美食` …）。

### 面板可见

`VideoTasteCard` 渲染在视频面板「最近小结」下方：

- 显示当前口味标签（`少看 X` 橙 / `多看 X` 绿）；
- 「恢复默认口味」按钮（运行中禁用）；
- 聊天技能改完后派发 `video-taste-changed` 事件，面板立即刷新。

### 日志

`TASTE_UPDATED text=… moves=[…] positive=[…] negative=[…]`、`TASTE_RESET`。

## B. 看完感悟（reflection）

- `Digest` 增加 `reflection` / `reflectionSource`（serde default，兼容旧 JSON）；
- 停止并保存终态后**异步**生成（不阻塞停止、不阻塞面板）：
  - 优先用当前聊天模型（`local` 或 `dsh` 后端，≤60 字、第一人称、有情绪）；
  - 25s 超时 / 模型未配置 / 调用失败 → 按内容情绪（美食/旅行/游戏/音乐/平静）选模板，
    日志记 `REFLECTION_FALLBACK reason=… mood=…`；
  - 生成完成记 `REFLECTION_BUILT reflection=model|template chars=… text=…`；
- 感悟只写回 `session.digest`，**不进待投递正文**（`DigestDraft` 不包含它，默认不投递）；
- 展示：小结卡片底部独立斜体段落、历史详情里也保留。

## 验证

```powershell
cargo check
node node_modules/typescript/bin/tsc --noEmit
node --test tests/video-*.mjs
```

实机面板文本（WebView2 CDP）：小结卡片有主题句/条目标题/感悟；口味卡片显示
`少看 游戏`、`多看 纪录片` 等标签；历史详情里同样能看到感悟。