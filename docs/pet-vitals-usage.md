# 小狗的自我状态（体力 / 情绪 / 亲密 / 专注）

> 2026-11-17 · 版本 2.0.2（不改版本号）
> 配套规格：[research-pet-self-state.md](research-pet-self-state.md)。本文件面向使用者 + 接入方。

## 1. 这是什么

小狗有 4 个隐藏数值，会随着你的互动慢慢变化，也会随时间自然回落：

| 指标 | 含义 | 半衰期 | 下限 | 涨得快的事 |
| --- | --- | --- | --- | --- |
| 体力 energy | 精力 / 困不困 | 6 小时 | 15 | 喂食 +10、睡觉 +10、摸头 +2 |
| 情绪 mood | 开心 / 低落 | 2 小时 | 20 | 摸头 +4、陪玩 +6、完成待办 +5、聊天 +3 |
| 亲密 bond | 熟悉与信任 | 3 天 | 30 | 摸头 +1.5、聊天 +2、抱抱/挠下巴 +1 |
| 专注 focus | 陪你做事 | 45 分钟 | 0 | 开始待办 +15，待办进行中每 5 分钟 +1 |

- **只会影响「待机时轮播哪张表情」**：体力低 → 更容易趴下睡（sleeping/relax），情绪高 → 更容易 happy/love/spin，
  亲密高 → 更黏人（love/pet/peek），专注高 → 更像在陪你工作（working/attention）。
- **不会锁任何功能、不会弹责备气泡**：数值再低也保留 idle/happy，永远不会自动播 cry/angry。
- 动作、通知、音乐、Agent 状态的优先级完全不变；`usePetGifRotation` 与 `petGifRotation` 没改。
- 默认**开启**；关掉后待机轮播与以前完全一致（同一份配置下帧序列相同）。

## 2. 怎么涨 / 怎么掉

- **会涨**：摸头（包括单击小狗换表情）、喂食、陪玩、抱抱/挠下巴、睡觉、完成待办、开始待办、和它聊天、Bongo 敲击。
- **会掉**：时间（半衰期）与陪玩消耗的体力；久不互动会慢慢变累、变安静。
- **防刷**：每个动作有冷却（摸头 20s、喂食 30min、陪玩 60s、睡觉 4h…）、每日增益上限（情绪 60/天、亲密 30/天…）、
  重复动作递减（第 7 次大约只有一半），所以连点不会暴涨。
- **下限保护**：体力 15、情绪 20、亲密 30，长期不互动也不会「摆烂」惩罚你。

## 3. 在哪里看 / 怎么关

- 设置（岛内「感知与陪伴」区 / 独立设置窗口「小狗的状态」卡）里有 4 条进度条 + 一句话状态 +
  「摸摸头」「喂零食」两个按钮 + 可折叠详情（上次结算时间、精确数值、隐私说明）。
- 卡片上有总开关「让小狗有状态（影响待机动画）」，默认开；关掉后不写指标、不参与轮播权重。
- 隐藏技巧：聊天进行中卡片会显示「小狗正在思考…」（只读标记，不写进指标）；待办进行中会显示
  「待办进行中：专注会随时间上涨」。

## 4. 数据存在哪（隐私）

- 只在本机 `localStorage`：`maltese-pet-vitals`（4 个数值 + 更新时间 + 当日额度）和
  `maltese-pet-vitals-log`（最近 30 条**互动事实**：事件类型 + 时间戳 + 待办标题）。
- **不读聊天正文、不读剪贴板、不截图、不上传**；聊天只统计「用户发了一条」这个事实（读 `role`/`at`），
  待办只记录你自己写的标题。
- 设置窗口只读快照，主窗口是唯一写入方；其它窗口通过 `maltese-pet-vitals-changed` 事件拿到 4 个数值。

## 5. 给聊天 / 主动消息的只读接入层

`src/petVitals.ts` 导出（签名稳定，`dev-fix` 的聊天侧在消费）：

```ts
export function readPetVitals(storage?: Storage | null): {
  energy: number; mood: number; bond: number; focus: number; updatedAt: number;
};
// 纯读本地指标，无副作用；没有数据时返回 70/70/50/0 与 updatedAt 0。

export function summarizePetVitals(v: PetVitalsSnapshot | PetVitals): string;
// 一行中文摘要，例：「体力 32（有点累）、情绪 78（心情不错）、亲密 64（熟悉了）、专注 20（比较放松）」

export function describeRecentInteractions(
  storage: Storage | null,
  limit = 3,
  options?: { now?: number; activeTodoTitle?: string | null },
): string[];
// 最近互动事实，最多 limit 条，新的在前，例：
// ["正在做待办：重构聊天面板", "3 分钟前被摸头", "10 分钟前喂过食"]
// 只含「事件类型 + 相对时间 + 待办标题」，不含任何聊天正文。

export const VITALS_CHANGED_EVENT = "maltese-pet-vitals-changed"; // 写入后派发，detail = { energy, mood, bond, focus }

/** 聊天表情包兜底：按当前状态从候选池挑一个（与待机轮播用同一张权重表）。 */
export function pickStickerForVitals(
  vitals: { energy: number; mood: number; bond: number; focus: number },
  pool: ReadonlyArray<string | { id: string; state?: string; weight?: number }>,
  options?: { rng?: () => number; avoid?: ReadonlyArray<string> },
): string | null;
// 例：累了更容易挑 sleeping 表情包、开心更容易挑 happy/celebrate；
// avoid 用来跳过最近 3 条发过的 id；空池返回 null（调用方按「不发表情包」处理）。
```

- **待机轮播与聊天表情包共用同一张权重表**：`weightsForVitals()` 覆盖全部 25 个可轮播状态
  （体力低 → sleeping/relax/resting ↑、happy ↓；情绪高 → happy/celebrate/love ↑；情绪低 → pet/peek ↑、
  cry 仅在情绪 <25 时抬到 0.3 的小概率；专注高 → working/attention ↑；亲密高 → love/pet ↑），
  规则表见 [`docs/pet-characters.md`](pet-characters.md) 的「轮播权重随状态变化」一节。

- 聊天把状态作为 **system 消息**注入（≤120 字），主动消息上下文可选带 `vitals` / `recentInteractions`
  （由 `src/petContext.ts` 防御式读取，无数据时提示词逐字不变）。
- 消费方只需要「现在什么状态」与「最近发生过什么类型的互动」，**不要**把它当作聊天内容来源。

## 6. 实现位置

| 文件 | 作用 |
| --- | --- |
| `src/petVitals.ts` | 纯函数：衰减、事件、冷却/上限/递减、权重表、加权播放列表、只读接入层 |
| `src/usePetVitals.ts` | localStorage 持久化、60s 结算、可见性补结算、事件上报、聊天计数（只读 `role`/`at`） |
| `src/PetVitalsCard.tsx` + `.css` | 设置页状态卡（两处设置共用） |
| `src/App.tsx` | 埋点（`triggerPetAction` / `toggleTodo` / 单击摸头）、`carouselFrames` 只对 `idle` 加权、设置项默认值与卡片 |
| `src/SettingsWindow.tsx` | 独立设置窗口的状态卡（只读快照 + 事件按钮） |
| `tests/pet-vitals.test.mjs` | 18 条单测（衰减/冷却/上限/递减/权重/轮播/接入层） |
| `scripts/simulate-pet-vitals.mjs` | 模拟一天，打印每小时指标与轮播分布 |

## 7. 已知边界

- 待机轮播按「指标分桶」重建（energy/20、mood/20、bond/25、focus/20）：数值小幅变化不会重排播表，避免播放列表频繁从头开始。
- 关闭总开关后不再写指标；已有数值保留在本地，重新打开会按经过时间衰减一次。
- 专注只在「有待办在跑」时上涨；用技能/聊天创建的待办同样算（读 `activeTodoId` 与未完成状态）。
- 数值曲线与阈值的手感仍需真人试用（见 research 文档第 8 节「待实测」）。