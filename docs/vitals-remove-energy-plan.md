# 移除「体力 energy」方案（只出方案，未改代码）

> 决策：电子宠物不会累——删除 `energy`，保留 `mood` 情绪 / `bond` 亲密 / `focus` 专注。
> 目的：避免「不互动就掉体力」变成惩罚。本文是照做清单（文件级），实现时按顺序改。

## 1. 数据结构（`src/petVitals.ts`、`src/usePetVitals.ts`）

- `PetVitals` / `PetVitalsSnapshot` / `VitalsDelta` / `VitalsEventKind` 的 `gained`：删 `energy` 字段。
- `VITALS_HALF_LIFE_MS`、`VITALS_FLOOR`、`VITALS_INITIAL`、`VITALS_DAILY_GAIN_CAP`、`VITALS_EVENTS.delta` 删 `energy`。
  新默认值：`{ mood: 70, bond: 50, focus: 0 }`；floor `{ mood: 20, bond: 30, focus: 0 }`。
- `decayVitals` 不再算 energy；`applyDecay` 保持不变。
- **旧 localStorage 兼容**：读取时忽略多余字段（`normalize` 只取 mood/bond/focus，缺字段补默认值），
  **写回时不再写 energy**；不做一次性删除迁移也行（旧字段自然消失）。
  若想干净：读取后若对象里存在 `energy`，立即按新结构重写一次 `maltese-pet-vitals`（幂等，可加）。

## 2. 权重表（`src/petVitals.ts`）

- `weightsForVitals`：删掉所有 `energy < 25 / 25–50 / > 80` 分支；`vitals` 入参类型改 `Pick<PetVitals,"mood"|"bond"|"focus">`。
- `VITALS_BASE_WEIGHTS` 保留 `sleeping / relax / resting` 的**基准权重**（不再被体力放大）；
  夜间（23:00–05:00）可小幅提高 `sleeping/relax`（+30%~50%）——若已有夜间逻辑（聊天/联动有夜段判断）就复用，没有则做一个小纯函数 `nightFactor(hour)` 并加单测。
- `pickStickerForVitals`、`vitalsLevel`、`summarizePetVitals` 的入参/分支同步删 energy；
  `VitalsLevel` 里的 `"tired"` 由 energy 触发 → 删除该档（或改由 `mood` 低位触发，二选一，见 §7）。

## 3. 事件与埋点（`src/petVitals.ts`）

- `feed`（喂食）：`{ energy: 10, mood: 3, bond: 1 }` → **改为主要涨情绪**：`{ mood: 6, bond: 1.5 }`（`key: "mood"`），保留每日上限 3 次/30min 冷却。
- `sleep`（睡觉）：原 `{ energy: 10, mood: 2 }` → **改为 `{ mood: 3, bond: 0.5 }` + `key: "mood"`**（保留 4h 冷却、每天 2 次）；不建议直接删事件（睡觉仍应有正反馈）。
- `pet` / `play` / `care` / `chat` / `todoDone` / `todoStart` / `bongo`：删 `energy` 字段，其余不动；`todoStart` 的 `focus: 15` 保留。
- `vitalsEventForPetAction`：映射表不变（动作→事件），只是事件的 delta 里没有 energy。
- 埋点 `gained` 结构同步删 energy（`App.tsx` 里记录 vitals 的地方按类型自动报错，按 §1 改）。

## 4. UI 与 i18n

- `src/PetVitalsCard.tsx`（设置卡）：4 行 → 3 行（mood/bond/focus），删 energy 的滑条/进度/档位文案引用。
- `src/PetStateBar.tsx` + `src/petStateBarLogic.ts`：状态条 4 项 → 3 项；`stateBarVisible`/文案函数删 energy 参数与 `tired` 档。
- `src/PetChat.tsx`、`src/petContext.ts`（system 注入的状态行）、`src/proactiveChat.ts`：状态摘要改 3 项，删「体力」字样。
- i18n 三处同步：`src/i18n/types.ts`、`locales/zh-CN.ts`、`locales/en.ts`：
  `petVitals.energy` 删除；`levels.tired` 删除（或改映射）；`hint`/`detailsHint`/`summarize` 文案改「情绪/亲密/专注」。
- `src/summarizePetVitals` 输出例：`情绪 78（心情不错）、亲密 64、专注 20`。

## 5. 测试（`tests/`）

- `pet-vitals.test.mjs`：删/改所有 energy 断言（默认值、衰减、feed/sleep delta、`gained`、`vitalsLevel`、`weightsForVitals` 体力分支）；
  新增：① 旧数据带 energy 能正常读且不回写 energy；② feed 主要涨 mood；③ 夜间睡眠权重上调（若实现）。
- `pet-state-bar.test.mjs`：4 项 → 3 项、删 `tired` 档文案断言。
- `pet-context.test.mjs`：system 状态行断言去掉体力。
- 新增单测建议：`tests/pet-vitals.test.mjs` 内加「无 energy 字段的默认值 = mood70/bond50/focus0」。

## 6. 文档与 README

- `docs/pet-vitals-usage.md`（主要文档）：改成 3 指标，写「为什么不设体力：电子宠物不会累，避免用掉体力惩罚用户」。
- `docs/pet-chat.md`：状态条/上下文相关段落 4→3。
- `docs/research-pet-self-state.md`：补一行「2026-11-19 决策：移除体力」并说明理由（历史调研保留）。
- `README.md`：「小狗的自我状态」段落 4→3，删「累了更容易趴下睡/休息」里的体力归因（保留 sleeping/relax 基准权重说明）。
- `docs/pet-characters.md` 里轮播权重表的「体力 <25 / 25–50 / >80」三行删除。

## 7. 需要用户拍板的取舍

1. **睡觉事件**：改成涨情绪+亲密（建议），还是干脆删掉事件？（睡觉仍会切 GIF，只是不记数值）
2. **`VitalsLevel.tired` 档**：删掉（只剩 great/good/ok/lonely/focused），还是改由 `mood` 低位触发「没精神」？
3. **夜间权重**：`sleeping/relax` 在 23:00–05:00 是否上调（+30%~50%），还是完全只用基准权重？
4. **旧数据迁移**：只「读时忽略」，还是读一次就按新结构重写（清掉 energy 字段）？
5. **`feed` 幅度**：`mood +6 / bond +1.5` 是否合适（比原来的 mood +3 翻倍），要不要保留每日 3 次上限。