# 桌宠自我状态（体力 / 情绪 / 亲密 / 专注）最终规格

> 日期：2026-11-17 · 仓库 HEAD `15ac5ad` + 并行改动（App.tsx 行号会漂移，规格一律以函数名/符号名为准）
> 目标：从现有互动量派生 4 个指标，只调节**待机轮播**的 GIF 权重；不改动作可用性、不改状态优先级。
> 结论：**可行，MVP 成本 M**。4 指标（体力/情绪/亲密/专注）+ 事件驱动纯函数 + 设置页状态卡 + 待机加权轮播；**默认开、可一键关闭**；不接线主动聊天频率。

## 0. 先说结论

1. **指标**：体力（energy）6h、情绪（mood）2h、亲密（bond）72h、专注（focus）45min（`startTodo` 进入即 ≥70）；下限 15/20/30/0，上限均 100。
2. **映射**：只在 `petState === "idle"` 时按指标给现有轮播状态加权，生成 24 张播放列表交给现有 `usePetGifRotation`；动作/通知/音乐等既有优先级完全不变。
3. **数据**：日记、聊天、待办、主动聊天时间戳现成；单击摸头、Bongo、互动来源、focus 会话需新增轻量埋点；**绝不读取聊天正文/OCR/剪贴板内容**。
4. **默认开**：四个指标总开关默认开，设置里可关；关闭后轮播回到现有行为（可 A/B 快照验证）。

## 1. 数据源盘点（读代码确认）

| 信号 | 现成位置（符号名） | 可用性 | 建议 |
| --- | --- | --- | --- |
| 宠物动作 | 统一入口 `triggerPetAction`（`App.tsx`）；互动面板按钮、睡觉按钮；陪玩狗点击经 `maltese-pet-action` 转发（`CompanionPet.tsx`，主窗监听同事件） | 现成，但只写日记文本，无结构化来源 | ✅ 主信号；加 `origin`（user/bongo/dsh/companion）防重复计数 |
| 小狗日记事件 | `recordDiaryEvent`、`DIARY_EVENTS_STORAGE_KEY`、`loadDiaryEvents`；类型 `DiaryTimeline.tsx`（仅 `pet`/`todo`） | 现成、跨会话，最多 500 条；文本已本地化 | ✅ 统计 kind+at；**不解析文本** |
| 聊天消息 | `PetChat.tsx`：`MESSAGES_KEY`、`MAX_MESSAGES=60`、`loadMessages/persist`；消息含 `role/text/at`；主动聊天也会追加 assistant 消息（`App.tsx` 的 `appendChat`，最多 200 条） | 现成；会被截断、assistant 混入 | ✅ 只数 `role==="user"` 的 `at`；**不读 `text`** |
| 待办完成 | `TodoItem`（`completedAt`）、`toggleTodo`、`loadTodos`、存档键 | 现成 | ✅ 按 `completedAt` 统计；`petSkills` 写入的完成也能读到 |
| **专注会话** | `startTodo`（开始/暂停；仓库没有独立 `stopTodo`，暂停复用同一函数）、`toggleTodo`（完成）、`deleteTodo`、`activeTodoId` 持久化/恢复、active-todo 失效清理 effect、`systemIdleSeconds` | 现成 | ✅ focus 主信号：开始/暂停/完成/切换/删除/无操作 |
| 系统闲置秒数 | Rust `get_system_idle_seconds`；前端 5s 轮询 `systemIdleSeconds` | 现成，仅当前值 | ✅ 上下文：专注累计与「长时间无操作」判定 |
| 主动聊天时间戳 | `maltese-proactive-times`（24h）、`maltese-proactive-history`（48 条/7 天）、`maltese-proactive-last`（`proactiveChat.ts`、`App.tsx`） | 现成 | ✅ 只读时间戳；**主动消息不算用户互动**，避免自激 |
| 媒体/前台活动 | `mediaState`、`refreshMediaState`、`mediaLooksLikeVideo`；`activity.rs` 的 `get_active_activity`、`ACTIVITY_LINES` | 现成，仅当前值 | ⚠️ 只做气泡语气/上下文，不涨亲密 |
| 连续活动分钟数 | `proactiveStreakRef`，仅主动聊天 effect 内计算 | 半现成，依赖主动聊天开关 | ⚠️ 不用于 focus；focus 由待办会话负责 |
| Bongo 敲击 | `BongoPet.tsx`：50ms 轮询按键、空格边沿 `emitBongoHit`；主狗响应 `triggerPetAction("happy")` | 现成事件，未持久化 | ✅ 新增「bongo」事件，冷却+日上限 |
| 实例联动 | `petLinkBus` 常量/发送/接收（`App.tsx`、`CompanionPet.tsx`） | 现成事件，无计数 | ✅ 可选「陪伴」小加成 |
| Agent/DSH 状态 | `agentStatus`、`agentVisualState` | 现成 | ❌ 不是用户互动；最多做「工作」上下文 |
| 单击小狗换表情 | `playNextExpression`（单击处理） | **未记录**，但最高频 | ⚠️ 轻量埋点（冷却 10s，情绪 +1） |
| 消息/OCR/剪贴板 | 微信提醒/QQ 通知（只提醒）、剪贴板历史 | 隐私敏感 | ❌ 不用于状态；不读正文/截图 |

**结论**：不需要新持久化存储；「事件 → 聚合状态」即可。新增埋点：单击摸头、Bongo 敲击、互动来源、focus 会话（`startTodo`/`toggleTodo`/`deleteTodo`/持久化恢复）。

## 2. 指标模型（纯函数）

```ts
export type PetVitals = {
  energy: number; mood: number; bond: number; focus: number; // 0–100
  updatedAt: number; activeFocus: { todoId: string; startedAt: number; lastAccruedAt: number } | null;
  lastAt: Partial<Record<VitalsEventKind, number>>;
  today: { date: string; gained: Partial<Record<"energy"|"mood"|"bond"|"focus", number>>; count: Partial<Record<VitalsEventKind, number>> };
};

clamp(x, lo = 0, hi = 100): number
applyDecay(v, elapsedMs, halfLifeMs, floor = 0):
  floor + (clamp(v, floor, 100) - floor) * 2 ** (-max(0, elapsedMs) / halfLifeMs)
applyEvent(v, delta): clamp(v + delta)
```

| 指标 | 含义 | 半衰期 | 下限/上限 | 主要上涨（每次） | 封顶 |
| --- | --- | --- | --- | --- | --- |
| 体力 energy | 精力/困倦 | 6 小时 | 15 / 100 | 喂食 +10、睡觉 +10、摸头 +2、陪玩 -3 | 每日吃 3 次、睡 2 次；100 封顶 |
| 情绪 mood | 开心/低落 | 2 小时 | 20 / 100 | 摸头 +4、陪玩 +6、完成待办 +5、聊天 +3、Bongo +0.5 | 每日 +60；单类冷却 |
| 亲密 bond | 熟悉与信任 | 72 小时 | 30 / 100 | 摸头 +1.5、抱抱/挠下巴 +1、聊天 +2、完成待办 +1 | 每日 +30；重复递减 |
| 专注 focus | 正在专心做一件事 | 45 分钟 | 0 / 100 | 开始待办立即 ≥70；专注期间 +1/分钟 | 100 封顶；完成转化，不清零 |

结算（事件驱动，不每秒重算）：

```ts
tick(state, now, ctx) {
  const hours = max(0, now - state.updatedAt) / 3_600_000;
  energy = applyDecay(state.energy, now - updatedAt, 6h, 15) + (ctx.sleeping ? 4 * hours : 0);
  mood = applyDecay(state.mood, now - updatedAt, 2h, 20); bond = applyDecay(state.bond, now - updatedAt, 72h, 30);
  focus = state.activeFocus ? state.focus : applyDecay(state.focus, now - updatedAt, 45min, 0);
}
```

### 2.1 专注会话（focus）细则

- **进入**：`startTodo(id)` 且 `id !== activeTodoId`（待办未完成）→ `focus = max(focus, 70)`，`activeFocus = { todoId, startedAt: now, lastAccruedAt: now }`；切换待办时旧会话先结算、新会话立即 `max(focus, 70)`，不因切换掉状态。
- **累计**：仅当 `activeTodoId` 存在、待办未完成且 `systemIdleSeconds < 300` 时，`focus = min(100, focus + 1/分钟)`；用 `lastAccruedAt` 计算，单次最多补 5 分钟，防止睡眠恢复后一次性暴涨；重启时 `activeTodoId` 存在且未完成则先结算衰减再恢复累计，**不重新奖励 70**。
- **退出**：`startTodo(同一 id)`（暂停）→ 会话结束；`toggleTodo` 完成当前待办 → 结束；`deleteTodo` 删除当前待办 → 结束；active-todo 失效清理 effect → 结束；`systemIdleSeconds ≥ 900`（15 分钟无操作）→ 只停止累计并开始衰减，**不清空 `activeTodoId`**；回到电脑且 idle < 300 时按当前值继续累计。
- **衰减**：非会话期间按 45 分钟半衰期、floor 0。**100 → 50（45 分钟后）**；若刚开始即退出（70），45 分钟后约 35。
- **完成转化**：`focus = clamp(focus * 0.5 + 25)`（保留余韵、不清零），并在同一事件里给情绪 +5、亲密 +1；**不要与「todoDone」奖励重复计算两次**。

上涨速率与防刷：`applyEvent` 前先检查 `now - lastAt[kind] >= cooldown`，再检查当日该类上限；重复动作按 `delta / (1 + countToday / 6)` 递减。冷却：摸头 20s、喂食 30min、陪玩 60s、抱抱/挠下巴 30s、聊天 30s、完成待办无冷却、Bongo 30s、睡觉 4h、focus 进入 5min（防抖）。

## 3. 状态映射与轮播接入

### 3.1 现有素材与状态（已核实：磁盘 + 代码）

- 素材根 `assets/pets/chars/<character>/<action>/`；`petCharacters.ts` 的 `STATE_TO_ACTION` 做「界面状态 → 动作目录」映射、`ACTION_FALLBACK` 兜底；清单由 `petCharacterAssets.generated.ts` 生成。动作目录：`xiaobai` 25 个（`angry chase chin costume cry deep eat groom happy hide hop idle love nervous paper peek pet pickup play relax scared sleep spin walk work`）；`xiaojimao` 24 个（缺 `deep/scared/walk`）；`shared` 18 个同框池。
- 可轮播状态（`PET_STATE_LABELS`，25 个）：`idle resting listening working attention pet eating pickup scared sleeping celebrate happy relax chin spin play hide chase peek angry cry love ride bath costume`。
- **没有 `tired` 状态/目录**；「累」映射到 `sleeping`（动作 `sleep`）和 `relax`/`resting`（动作 `relax`）。`eat` 是动作目录，界面状态叫 `eating`；`working` 对应 `work`，`attention` 对应 `paper`。
- 运行时优先级（`petState` memo）：`petAction > activityMood > listening > attention/working > idle`；**指标只影响最后的 `idle` 分支**。待机轮播现状由 `carouselFrames` 调 `rotationFramesForState(config,"idle",rotationStates,character)` 合并勾选状态帧，`usePetGifRotation` 顺序轮播（10s/张）。

### 3.2 指标 → 状态权重（只影响 idle 池）

| 条件 | 加权（相对值） |
| --- | --- |
| 基线 | `idle 3, happy 1.5, relax 1.2, play 1, peek 0.5, pet 1, chin 0.6, love 1` |
| energy < 25 | `sleeping ×5, relax ×3, chin ×2`，`happy/play ×0.2`（**不主动播 cry/angry**） |
| 25 ≤ energy < 50 | `relax ×2, idle ×2, sleeping ×1`，`play ×0.6` |
| energy > 80 | `play ×1.6, happy ×1.3` |
| mood > 75 | `happy ×3, celebrate ×1.5, love ×2, spin ×1.2` |
| mood < 35 | `relax ×2, chin ×1.5, happy ×0.3`（**不用哭脸惩罚用户**） |
| bond > 80 | `love ×3, pet ×2, peek ×1.5, happy ×1.2` |
| bond < 35 | `idle ×2, peek ×1, pet ×0.6, love ×0.2` |
| **focus ≥ 70** | `working ×3, attention ×2, sleeping ×0.2, idle ×0.6, play ×0.5` |
| **40 ≤ focus < 70** | `working ×1.8, attention ×1.2, sleeping ×0.6` |

权重只在 `idle` 时参与；不改变 `attention/working` 的实际触发逻辑（通知/Agent 仍优先）。用户勾选状态为空或权重总和为 0 时回退现状（等权合并）。

### 3.3 加权轮播算法与接入点

```ts
buildIdlePlaylist(v, config, states, character, rng, slots = 24) {
  const weights = weightsFor(v);
  const pool = states.map(s => [s, max(0.05, weights[s] ?? 0.5)] as const);
  const total = pool.reduce((n, [, w]) => n + w, 0);
  const out: string[] = [];
  while (out.length < slots) {
    let r = rng() * total, pick = pool[0][0];
    for (const [s, w] of pool) { if ((r -= w) <= 0) { pick = s; break; } }
    const frames = rotationFramesForState(config, pick, undefined, character);
    if (frames.length) out.push(frames[Math.floor(rng() * frames.length)]);
  }
  return dedupeAdjacent(out);
}
```

接入点：`carouselFrames` 的 useMemo 内分流——`petState === "idle"` 且总开关开 → `buildIdlePlaylist`，否则继续 `rotationFramesForState`；`usePetGifRotation` 与 `petGifRotation.ts` **不改**。按指标分桶生成 `bucketKey`（energy/20、mood/20、bond/25、focus/20），仅在 key 变化时重建，避免轮播频繁从头开始。

## 4. 用户可见性与默认值

- 设置页新增「小狗的状态」卡片（独立设置窗 `sw-card`，放在「互动」卡后；岛内设置页放在「感知与陪伴」的「自动切换表情」旁）。共用 `src/PetVitalsCard.tsx`，内容为 **4 条** 0–100 进度条（体力/情绪/亲密/专注）+ 一句话 + 「摸摸头」「喂零食」按钮（复用 `triggerPetAction`）+ 可折叠「状态详情」（数值、最后结算、当前权重、最近 5 条事件）。
- **默认**：`petVitalsEnabled: true`、状态卡显示开；关闭后立即恢复现有轮播与行为（无事件写入）。
- 不打扰：卡片只在设置页，不弹气泡、不新增通知；专注不做强制提醒；状态详情足够验收，不另开调试窗口。

## 5. 边界与风险

| 风险 | 处理 |
| --- | --- |
| 变成「惩罚用户」 | 只加权 idle；不自动播 cry/angry；下限 15/20/30/0；久不互动仍有 idle/happy；不锁功能、不弹责备文案 |
| 与睡眠/缩边/自动轮播冲突 | 指标不触发 `tuckIsland`、不改 `sleepAfterSeconds`；`restingAsleep` 时固定趴睡帧、权重不生效；`autoRotateExpressions=false` 不重建列表，状态卡仍可看 |
| 专注与真实状态偏离 | focus 只影响 idle 权重；Agent/通知仍优先；无操作 15 分钟只停止累计，不暂停待办计时 |
| 与主动聊天耦合 | MVP 不按指标改主动频率；主动消息不计入互动 |
| 防刷 | 冷却 + 当日上限 + 重复递减；喂食 3 次/日、摸头每日情绪增益 40、focus 进入 5min 防抖 |
| 持久化/多窗 | `maltese-pet-vitals-v1` 存聚合值 + `updatedAt` + `activeFocus`；跨会话保留、跨设备不做；主窗口唯一写入，设置窗只读 |
| 性能/脏数据 | 事件驱动 + 60s tick + 可见性变化；写入 debounce 5–10s；`elapsed<0` 按 0、NaN/越界回默认、超 30 天按最低值 |

## 6. MVP 范围与文件清单

**做**：4 指标；事件（pet/eat/play/care/sleep/todoDone/chat/bongo/focusStart/focusEnd）；纯函数模型 + hook + 状态卡 + idle 加权播放列表 + 总开关；单测与模拟。**不做**：按情绪改气泡/主动聊天、成就/等级、跨设备、Bongo/联动计数展示。

| 文件 | 改动 |
| --- | --- |
| 新增 `src/petVitals.ts` | 类型、`clamp/applyDecay/applyEvent/tick`、focus 会话函数（`enterFocus/accrueFocus/exitFocus/completeFocus`）、`weightsFor`、`buildIdlePlaylist`、`describeVitals` |
| 新增 `src/usePetVitals.ts` | `maltese-pet-vitals-v1` 读写、60s tick、事件订阅、focus 会话恢复、主窗口写入/跨窗口只读 |
| 新增 `src/PetVitalsCard.tsx` + `PetVitalsCard.css` | 4 条进度条、一句话、两个动作按钮、详情折叠 |
| 新增 `tests/pet-vitals.test.mjs`、`scripts/simulate-pet-vitals.mjs` | 单测 + 模拟一天（含一段专注会话） |
| `src/App.tsx` | 调 hook；`carouselFrames` 分流；`triggerPetAction` 加 `origin`/上报；`toggleTodo` 上报；单击摸头埋点；**focus 埋点接入 `startTodo`、`toggleTodo`、`deleteTodo`、active-todo 清理 effect、`systemIdleSeconds` 判定**；状态卡与开关；`IslandSettings` 类型/默认值（`petVitalsEnabled: true`） |
| `src/PetChat.tsx` | 用户发送成功时上报 `chat`（只报 `at`，不带文本） |
| `src/SettingsWindow.tsx` | 新 `sw-card` 状态卡 + 两个开关；`PetSettings` 类型/`DEFAULTS`（`petVitalsEnabled: true`） |
| `src/i18n/locales/zh-CN.ts`、`en.ts`、`i18n/types.ts` | 4 个指标名、级别句、卡片/开关文案（放在 `petGifs` 附近） |
| `docs/pet-self-state.md`、`README.md` | 指标说明、focus 行为、开关与隐私口径（无文本/无上传） |

复杂度：**M（约 2–3 天）**；不含数值调优。逻辑全在纯模块，Rust 零改动。
## 7. 验证方案

**单测**（Node 24 直接跑 TS）：`node --test tests/pet-vitals.test.mjs`

- 衰减：`applyDecay(100, 6h, 6h)=50`；带 floor 15 → 57.5；elapsed=0/负数不变；封顶 100；分段 tick 与一次 tick 等价。
- 事件：clamp 0–100；冷却/日上限生效；重复递减；当日重置。
- **focus**：`enterFocus` 后 ≥70；累计 1/分钟封顶 100；45 分钟无累计时 100→≈50、70→≈35；完成转化 `0.5×+25`；暂停/切换/删除/无操作退出语义；重启只结算不重新奖励。
- 映射：energy 20 → sleeping 高、happy 低；mood 90 → happy/love 高；bond 90 → love 高；**focus 85 → working/attention 高、sleeping 低**；空池等权回退。
- 轮播：seeded RNG 1000 次分布误差 <5%；去连续重复；只产出勾选状态；总开关关时 `weightsFor` 返回空/不参与，输出与旧 `rotationFramesForState` 快照一致。

**模拟**：`node scripts/simulate-pet-vitals.mjs` 模拟一天：09:00 摸头×3、10:00 开始待办并专注 40 分钟、11:00 完成待办、12:00 喂食、14:00 陪玩、20:00 聊天×5、其余闲置；打印每小时四指标与 1000 次轮播分布，断言 0≤值≤100、无 NaN、衰减单调。

**人工验收判据**：

| 场景 | 判据 |
| --- | --- |
| 初始 | 体力/情绪/亲密 = 70/70/50、focus=0；状态卡显示「还不错」 |
| 摸头 5 次（间隔 ≥20s） | 体力 ≥80、情绪 ≥90，卡片升级，idle 中 happy/love 增多 |
| **开始待办** | **focus 立刻 ≥70**；同一配置下 1000 次抽样里 working/attention 明显增加、sleeping 减少 |
| **专注 45 分钟不操作** | focus 衰减到 **≈50**（从 100）；若刚开始就退出则 ≈35；sleeping 权重回升 |
| **完成待办** | focus = `0.5×原值+25`（不清零）；情绪/亲密只加一次；working 仍短暂偏高 |
| 放置 6 小时 | 体力 ≤40、情绪落到下限 20、亲密约 40；sleeping/relax 上升；不出现 cry/angry |
| 放置 3 天 | 亲密接近下限 30；仍有 idle/happy，不「摆烂」 |
| 连点摸头 20 次 | 只有冷却/上限内生效，数值不暴涨 |
| 总开关关 / autoRotate 关 | 轮播帧序列与改动前一致（快照对比）、无状态写入；autoRotate 不重建轮播、状态卡数值仍随时间变化 |
| 性能 | 60s tick 期间 CPU 无可测增量；localStorage 写入 ≤1 次/分钟 |

## 8. 上线后需人工确认

1. 单击小狗、Bongo 敲击、实例联动是否计入互动，以及各自真实频率与体感。
2. 睡眠回体力（+4/小时）是否让体力长期满值；阈值/半衰期手感（是否摆烂、是否太粘人、focus 45 分钟是否偏短）；「看视频/开会时开始待办」导致的 focus 偏离是否需要白名单或手动暂停。
3. 完成待办转化公式 `0.5×+25` 的体感（是否应更低/更高）。
4. 低配机器上 60s tick + 播放列表重建是否可感知。
5. 卡片放两处还是只放独立设置窗口（独立窗部分文案未 i18n）；默认开启对老用户是否打扰，需一轮真实反馈。

## 9. 参考（符号名，不依赖行号）

- 轮播与状态：`petGifRotation.ts`（`PET_STATE_LABELS`、`rotationFramesForState`）、`petCharacters.ts`（`STATE_TO_ACTION`、`ACTION_FALLBACK`）、`usePetGifRotation.ts`；互动与日记见 `App.tsx` 的 `triggerPetAction`、`recordDiaryEvent`、`DIARY_EVENTS_STORAGE_KEY` 与 `DiaryTimeline.tsx`
- 专注：`App.tsx` 的 `startTodo`、`toggleTodo`、`deleteTodo`、`activeTodoId` 持久化/恢复、active-todo 清理 effect、`systemIdleSeconds`
- 聊天/主动聊天：`PetChat.tsx`（`MESSAGES_KEY`、`loadMessages/persist`）、`proactiveChat.ts`（`maltese-proactive-times`、`maltese-proactive-history`）；待办/闲置/媒体见 `App.tsx`（`TodoItem`、`loadTodos`、`mediaState`、`refreshMediaState`）与 `src-tauri/src/lib.rs`（`get_system_idle_seconds`）
- 联动/Bongo：`petLinkBus.ts`、`BongoPet.tsx`、`App.tsx` 的 bongo 响应 effect；设置见 `SettingsWindow.tsx`（`PetSettings`、`DEFAULTS`、`sw-card`）与 `App.tsx`（`IslandSettings`、`DEFAULT_SETTINGS`、`settings-section--companion`）