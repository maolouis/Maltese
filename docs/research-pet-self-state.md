# 桌宠自我状态（体力 / 情绪 / 亲密）预研

> 日期：2026-11-17 · 仓库 HEAD `15ac5ad`（App.tsx 仍有并行改动，行号以符号名为准）
> 目标：用现有互动量派生 3 个指标，只调节**待机轮播**的 GIF 权重；不改动作可用性、不写产品代码。
> 结论：**可行，MVP 成本 M**。3 个指标（体力/情绪/亲密）+ 事件驱动纯函数 + 设置页状态卡 + 待机加权轮播；**默认开、可一键关闭**；不接线主动聊天频率。

## 0. 先说结论

1. **指标**：体力（energy）、情绪（mood）、亲密（bond）。半衰期分别 6h / 2h / 72h；下限 15 / 20 / 30，上限 100。
2. **映射**：只在 `petState === "idle"` 时，按指标给现有轮播状态加权（weighted random），生成 24 张播放列表交给现有 `usePetGifRotation`；动作/通知/音乐等既有状态优先级完全不变。
3. **数据**：日记、聊天、待办、主动聊天时间戳都是现成的；摸头单击、联动次数、Bongo 敲击需要新增轻量埋点；**绝不读取聊天正文/OCR/剪贴板内容**。
4. **默认开**，但只有一个总开关；关闭后与现在完全一致（A/B 可验证）。

## 1. 数据源盘点（读代码确认）

| 信号 | 现成位置 | 可用性 | 建议 |
| --- | --- | --- | --- |
| 宠物动作（摸头/喂食/抱抱/陪玩/睡觉…） | 统一入口 `triggerPetAction`：`App.tsx:9225-9265`；互动面板按钮 `:2075-2095`、睡觉 `:2129-2135`；陪玩狗点击经 `maltese-pet-action` 转发（`CompanionPet.tsx:210-215`，主窗监听 `App.tsx:9266-9286`） | 现成，但**只写日记文本**（`:9230`），无结构化来源 | ✅ 主信号；需要加 `origin`（user/bongo/dsh/companion）避免重复计数 |
| 小狗日记日记事件 | `recordDiaryEvent` `App.tsx:8173-8187`；持久化 `:8836-8845`；键 `:511`（`focusd-island-diary-events`）；读取 `:1346-1381`；类型 `DiaryTimeline.tsx:4-10`（仅 `pet`/`todo`） | 现成、跨会话，最多 500 条；文本已本地化（`zh-CN.ts:472-502`） | ✅ 统计 kind+at；**不要解析文本** |
| 聊天消息数与时间 | `PetChat.tsx:57,81,90-107`（键 `focusd-island-pet-chat-messages`，保留 60 条），消息含 `role/text/at` `:37-49`；持久化 `:211-219`；主动聊天也会追加 assistant 消息（`App.tsx:7142-7153`，最多 200 条） | 现成；但会被截断，且 assistant 消息混入 | ✅ 只数 `role==="user"` 的 `at`；**不读 `text`** |
| 待办完成数 | `TodoItem` `App.tsx:223-235`（`completedAt`）；`toggleTodo` `:8208-8251`；读取 `:1204-1224`；存档键 `:509` | 现成 | ✅ 按 `completedAt` 统计；技能写入的完成（`petSkills.ts:338`）也能被读到 |
| 系统闲置秒数 | Rust `get_system_idle_seconds` `lib.rs:301-316`；前端 5s 轮询 `App.tsx:1576-1591` | 现成，只有当前值、无历史 | ✅ 作为上下文（是否刚回来），不单独涨指标 |
| 连续活动分钟数 | 主动聊天 effect 内 `proactiveStreakRef` `App.tsx:7104,7186-7190`；只在 `settings.proactiveChat` 开启时计算（`:7112`） | 半现成；未持久化、依赖主动聊天开关 | ⚠️ 若要「专注陪伴」指标，需新增独立采样（`get_active_activity` 每 60s） |
| 主动聊天次数 | `maltese-proactive-times`（24h 时间戳）`proactiveChat.ts:532-554`；`maltese-proactive-history`（48 条、7 天）`:25-29,90-101`；`maltese-proactive-last` `App.tsx:7366,7376` | 现成 | ✅ 只读时间戳；**不把主动消息算作用户互动**，否则「越聊越亲密」自激 |
| 媒体状态 | `mediaState` `App.tsx:6178-6179`，刷新 `:7851-7864,8657-8664`；视频判定 `:6207-6228` | 现成，仅当前值 | ⚠️ 只影响「专注」上下文或气泡语气，不涨亲密 |
| 感知前台活动 | `activity.rs:24,191`（`get_active_activity`）；气泡用法 `App.tsx:7552-7581` | 现成，仅当前值 | ⚠️ 被动观察，不涨指标 |
| Bongo 敲击 | `BongoPet.tsx:99-117`（50ms 轮询按键）、`:143-150`（空格边沿 → `emitBongoHit`）；主狗响应 `App.tsx:9309-9331` | 现成事件，未持久化 | ✅ 新增「bongo」事件，冷却+日上限 |
| 实例联动次数 | `petLinkBus.ts:63-95`；发送 `App.tsx:9247-9264`；接收 `CompanionPet.tsx:145-199` | 现成事件，无计数 | ✅ 可选；作为「陪伴」小加成，需新增计数 |
| DSH/Agent 状态 | `agentStatus` `App.tsx:6247-6248`；视觉状态 `:9130-9133` | 现成 | ❌ 不是用户互动；最多做「工作」上下文 |
| 单击小狗换表情 | `App.tsx:1988-2017`（`playNextExpression`） | **未记录**，但这是最高频的「摸头」动作 | ⚠️ 新增轻量埋点（冷却 10s，+1 情绪），否则互动量严重低估 |
| 消息/OCR/剪贴板 | 微信提醒与 QQ 通知当前为「只提醒」；剪贴板历史 | 隐私敏感 | ❌ 不用于状态；不读正文、不读截图 |

**结论**：MVP 不需要新持久化存储；用「事件 → 聚合状态」即可。需要新增的只是 3 个埋点：单击摸头、bongo 敲击、联动/互动来源标记。

## 2. 指标模型（纯函数）

状态结构与公式（放 `src/petVitals.ts`，无 React 依赖，可直接单测）：

```ts
export type PetVitals = {
  energy: number; mood: number; bond: number;   // 0–100
  updatedAt: number;                             // 上次结算时间
  lastAt: Partial<Record<VitalsEventKind, number>>;
  today: { date: string; gained: Record<"energy"|"mood"|"bond", number>; count: Partial<Record<VitalsEventKind, number>> };
};

clamp(x, lo = 0, hi = 100): number
applyDecay(v, elapsedMs, halfLifeMs, floor = 0):
  floor + (clamp(v, floor, 100) - floor) * 2 ** (-max(0, elapsedMs) / halfLifeMs)
applyEvent(v, delta): clamp(v + delta)
```

| 指标 | 含义 | 半衰期 | 下限/上限 | 主要上涨（每次） | 封顶 |
| --- | --- | --- | --- | --- | --- |
| 体力 energy | 精力/困倦 | 6 小时 | 15 / 100 | 喂食 +10、睡觉 +10、摸头 +2、陪玩 -3 | 每日吃 3 次、睡 2 次；≥100 封顶 |
| 情绪 mood | 开心/低落 | 2 小时 | 20 / 100 | 摸头 +4、陪玩 +6、完成待办 +5、聊天 +3、Bongo +0.5 | 每日 +60；单类事件冷却 |
| 亲密 bond | 熟悉与信任 | 72 小时（3 天） | 30 / 100 | 摸头 +1.5、抱抱/挠下巴 +1、聊天 +2、完成待办 +1 | 每日 +30；重复动作递减 |
| （可选）专注 focus | 被陪伴着做事 | 45 分钟 | 0 / 100 | 专注工作/待机 1 点/5 分钟 | MVP 不做 |

结算（事件驱动，不每秒重算）：

```ts
tick(state, now, ctx) {
  const hours = max(0, now - state.updatedAt) / 3_600_000;
  energy = applyDecay(state.energy, now - updatedAt, 6h, 15) + (ctx.sleeping ? 4 * hours : 0);
  mood   = applyDecay(state.mood,  now - updatedAt, 2h, 20);
  bond   = applyDecay(state.bond,  now - updatedAt, 72h, 30);
}
```

上涨速率与防刷：`applyEvent` 前先检查 `now - lastAt[kind] >= cooldown`，再检查当日该类上限；重复动作按 `delta / (1 + countToday / 6)` 递减。冷却建议：摸头 20s、喂食 30min、陪玩 60s、抱抱/挠下巴 30s、聊天 30s、待办完成无冷却、Bongo 30s、睡觉 4h。

## 3. 状态映射与轮播接入

### 3.1 现有素材与状态（已核实，磁盘 + 代码）

- 素材根：`assets/pets/chars/<character>/<action>/`；`petCharacters.ts:43-69` 做「界面状态 → 动作目录」映射，`:72-100` 是缺素材回退链；生成清单 `petCharacterAssets.generated.ts`。
- 现有动作目录（`xiaobai`，25 个）：`angry chase chin costume cry deep eat groom happy hide hop idle love nervous paper peek pet pickup play relax scared sleep spin walk work`；`xiaojimao` 24 个（缺 `deep/scared/walk`，回退链兜底）；`shared` 18 个同框池（`ride` 等）。
- 可轮播状态清单（`petGifRotation.ts:38-64`，25 个）：`idle resting listening working attention pet eating pickup scared sleeping celebrate happy relax chin spin play hide chase peek angry cry love ride bath costume`。
- **没有 `tired` 这个状态/目录**；「累」应映射到 `sleeping`（动作 `sleep`）和 `relax`/`resting`（动作 `relax`）。`eat` 是动作目录，界面状态叫 `eating`。`working` 对应动作 `work`，`attention` 对应 `paper`。
- 运行时状态优先级（`App.tsx:9381-9399`）：`petAction > activityMood > listening > attention/working > idle`。**指标只影响最后的 `idle` 分支**，不能覆盖动作与通知。
- 待机轮播现状：`App.tsx:1605-1613` 用 `rotationFramesForState(config,"idle",rotationStates,character)` 合并用户勾选状态的帧，`usePetGifRotation.ts:32-63` 顺序轮播（10s/张）。

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
| focus > 60（可选） | `working ×2, attention ×0.5`（只做语气，不抢通知态） |

权重只在 `idle` 时参与；用户勾选的状态为空/权重总和为 0 时回退现状（等权合并）。

### 3.3 加权轮播算法（建议实现）

```ts
buildIdlePlaylist(v, config, states, character, rng, slots = 24) {
  const weights = weightsFor(v);                 // 上表，纯函数
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

接入点：`App.tsx:1605-1608` 的 `carouselFrames` useMemo 内分流——`petState === "idle"` 且总开关开 → `buildIdlePlaylist`，否则继续用 `rotationFramesForState`；`usePetGifRotation` 与 `petGifRotation.ts` **不改**。为避免频繁重建导致轮播从头开始，按指标分桶（energy/20、mood/20、bond/25）生成 `bucketKey`，只在 key 变化时重建播放列表。

## 4. 用户可见性

- 设置页新增「小狗的状态」卡片（`SettingsWindow.tsx` 的 `sw-card` 区，建议放在「互动」卡 `:513` 之后；岛内设置页放在「感知与陪伴」`App.tsx:2932-2963` 的「自动切换表情」旁）。共用新组件 `src/PetVitalsCard.tsx`。
- 内容：3 条 0–100 进度条 + 一句话（如「精神不错，想和你玩」）+ 「摸摸头」「喂零食」两个按钮（复用 `triggerPetAction`）+ 可折叠「状态详情」（原始数值、最后结算时间、当前权重、最近 5 条事件）。
- 默认：**总开关开、状态卡显示开**。理由：只改待机权重，不改变任何功能；提供「让小狗有状态（影响待机动画）」一键关闭，关闭后完全回到当前行为。
- 不打扰：卡片只在设置页，不弹气泡、不新增通知；`false` 时不写任何事件。
- 调试：状态详情足够验收，不另开调试窗口。

## 5. 边界与风险

| 风险 | 处理 |
| --- | --- |
| 变成「惩罚用户」 | 只加权 idle；不用 cry/angry 自动表达；下限 15/20/30；久不互动仍会 idle/happy，不锁功能、不弹责备文案 |
| 与睡眠/缩边冲突 | 指标**不触发** `tuckIsland`、不修改 `sleepAfterSeconds`；`restingAsleep` 时固定趴睡帧，权重不生效即可 |
| 与自动轮播开关冲突 | `autoRotateExpressions=false` 时不重建播放列表；状态卡仍可看 |
| 与主动聊天耦合 | MVP 不按指标改主动频率（否则「聊天→情绪高→更多聊天」自激）；主动消息不计入互动 |
| 防刷 | 每类动作冷却 + 当日上限 + 重复递减；建议「喂食」3 次/日、「摸头」每日情绪增益 40 |
| 持久化 | `maltese-pet-vitals-v1` 存聚合值 + `updatedAt`；跨会话保留，跨设备不做；主窗口唯一写入，设置窗只读 |
| 性能 | 事件驱动 + 60s tick + `document.visibilitychange`；权重分桶；localStorage 写入 debounce 5–10s；不需要每秒重算 |
| 时钟/脏数据 | `elapsed<0` 按 0；数值 NaN/越界回默认；超过 30 天按最低值结算 |

## 6. MVP 范围与文件清单

**做**：3 指标；7 类事件（pet/eat/play/care/sleep/todoDone/chat，bongo 可选）；纯函数模型 + hook + 状态卡 + idle 加权播放列表 + 开关；单测与模拟脚本。**不做**：focus 指标、按情绪改气泡/主动聊天、成就/等级、跨设备、Bongo 联动计数展示。

| 文件 | 改动 |
| --- | --- |
| 新增 `src/petVitals.ts` | 类型、`clamp/applyDecay/applyEvent/tick`、`weightsFor`、`buildIdlePlaylist`、`describeVitals`（纯函数，无 React） |
| 新增 `src/usePetVitals.ts` | `maltese-pet-vitals-v1` 读写、60s tick、订阅事件、主窗口写入/跨窗口只读 |
| 新增 `src/PetVitalsCard.tsx` + `PetVitalsCard.css` | 进度条、一句话、两个动作按钮、详情折叠 |
| 新增 `tests/pet-vitals.test.mjs`、`scripts/simulate-pet-vitals.mjs` | 单测 + 模拟一天 |
| `src/App.tsx` | 调 hook；`carouselFrames` 分流（`:1605-1608`）；`triggerPetAction` 增加 `origin` 与事件上报（`:9225-9265`）；`toggleTodo` 上报（`:8208-8251`）；单击摸头埋点（`:1988-2017`）；状态卡与开关（`settings-section--companion` `:2932-2963`）；`IslandSettings` 类型/默认值（`:380-438,680-727`） |
| `src/PetChat.tsx` | 用户发送成功时上报 `chat`（只报 `at`，不带文本） |
| `src/SettingsWindow.tsx` | 新 `sw-card` 状态卡 + 两个开关；`PetSettings` 类型/`DEFAULTS`（`:60-130`） |
| `src/i18n/locales/zh-CN.ts`、`en.ts`、`i18n/types.ts` | 指标名、级别句、卡片/开关文案（放在 `petGifs` 附近，`zh-CN.ts:311`、`types.ts:314`） |
| `docs/pet-self-state.md`、`README.md` | 指标说明、开关与隐私口径（无文本/无上传） |

复杂度：**M（约 2–3 天）**；不含美术/数值调优。所有逻辑可在纯模块完成，Rust 零改动。

## 7. 验证方案

**单测（Node 24 直接跑 TS）**：`node --test tests/pet-vitals.test.mjs`

- 衰减：`applyDecay(100, 6h, 6h)=50`；带 floor 15 → 57.5；elapsed=0/负数不变；封顶 100；`tick` 连续调用与一次调用等价（可组合）。
- 事件：clamp 到 0–100；冷却内不生效；日上限不生效；重复递减；当日重置。
- 映射：energy 20 → `sleeping` 权重高且 `happy` 低；mood 90 → `happy/love` 高；bond 90 → `love` 高；空状态池回退等权。
- 轮播：seeded RNG 下 1000 次抽样的分布与权重误差 <5%；连续重复帧被去掉；只产出用户勾选的状态。
- 状态卡：阈值文案与数值一致；关闭总开关时 `weightsFor` 返回空/不参与。

**模拟**：`node scripts/simulate-pet-vitals.mjs`（导入 `../src/petVitals.ts`）模拟一天：09:00 摸头×3、10:00 完成待办、12:00 喂食、14:00 陪玩、20:00 聊天×5、其余闲置；逐小时打印三指标与 1000 次轮播分布；断言 0≤值≤100、无 NaN、衰减单调。

**人工验收判据**（【待实测】需真实手感确认）：

| 场景 | 判据 |
| --- | --- |
| 初始状态 | 70/70/50；状态卡显示「还不错」 |
| 摸头 5 次（间隔 ≥20s） | 体力 ≥80、情绪 ≥90，卡片升级为「很开心」，idle 中 happy/love 明显变多 |
| 放置 6 小时 | 体力 ≤40、情绪落到下限 20、亲密约 40；idle 中 sleeping/relax 权重上升；**不出现 cry/angry** |
| 放置 3 天 | 亲密接近下限 30；仍有 idle/happy，不「摆烂」 |
| 连点摸头 20 次 | 只有冷却/上限内的次数生效，数值不暴涨 |
| 总开关关 | 同一配置下轮播帧序列与改动前一致（快照对比） |
| autoRotate 关 | 不重建轮播；状态卡数值仍随时间变化 |
| 性能 | 60s tick 期间 CPU 无可测增量；localStorage 写入 ≤1 次/分钟 |

## 8. 待实测 / 标记

- 【已核实】数据源位置、状态优先级、素材目录、轮播合并逻辑、待机 10s/张、主动聊天时间戳键。
- 【推测】指标数值曲线与阈值带来的体感；「久不互动也不摆烂」需要真人试用；`applyDecay` 的 floor 参数对手感的影响。
- 【待实测】单击小狗是否应计入摸头（目前只换表情）；Bongo 敲击/联动的实际频率；睡眠自动回体力是否会让体力长期满值；Windows 低配机器上 60s tick + 播放列表重建是否可感知。
- 【待实测】设置页两处（岛内 / 独立设置窗口）都要放卡片，还是只放独立窗口（当前独立窗口部分文案未 i18n，`SettingsWindow.tsx:381`）。

## 9. 参考

- 轮播与状态：`src/petGifRotation.ts:38-64,298-321`、`src/petCharacters.ts:43-100`、`src/usePetGifRotation.ts:32-63`
- 互动与日记：`src/App.tsx:9225-9265,8173-8187,8836-8845`、`src/DiaryTimeline.tsx:4-10`
- 聊天与主动聊天：`src/PetChat.tsx:37-49,57,81,211-219`、`src/proactiveChat.ts:25-29,532-554`、`src/App.tsx:7138-7153`
- 待办/闲置/媒体：`src/App.tsx:223-235,8208-8251,1576-1591,6178-6229`、`src-tauri/src/lib.rs:301-316`
- 联动与 Bongo：`src/petLinkBus.ts:63-95`、`src/App.tsx:9247-9264,9309-9331`、`src/BongoPet.tsx:143-150`
- 设置：`src/SettingsWindow.tsx:60-130,386-460,513`、`src/App.tsx:380-438,680-727,2916-2963`