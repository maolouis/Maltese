# 表情轮播多样性（洗牌袋 + 最近去重 + 权重封顶）

> 2026-11-20 · 用户反馈 P1：「根据状态要轮换表情包播放，不能一直是那几个」。

## 根因（四个环节叠加）

1. **每会话固定抽 30 张**：`petCharacters.sampleFrames` 用 `stride + 固定 random offset` 从池子里抽
   `MAX_FRAMES_PER_STATE=30` 张，并缓存整个会话（`rawFrameCache`）——池子有 86 张也永远只看到那 30 张。
2. **列表顺序固定**：`rotationFramesForState` 把各状态帧按「状态顺序 × 帧顺序」拼起来，顺序稳定；
   `buildIdlePlaylist` 只做加权抽样 + 相邻去重，不洗牌。
3. **播放指针每次重建归零**：`usePetGifRotation` 的 effect 依赖 `frames.join("|")`，播放列表一重建
   （vitals 分桶变化 / 设置变动）就 `indexRef.current = 0; setSource(frames[0])`——永远从头几张开始。
4. **权重过度集中**：体力低时 `sleeping ×5`、情绪低时 `relax ×2` 等没有封顶，单状态可以占大头。

## 修法

- **洗牌袋（shuffle bag）**：新增 `src/petRotationBag.ts`。每个状态把**全部可用帧** Fisher–Yates 洗牌成袋子，
  逐个播完再重新洗——一轮内不重复、全量覆盖；袋子进度（`order/index`）与最近播放窗口持久化在
  `localStorage["maltese-rotation-bags"]`，跨会话保持。
- **最近 8 去重**：抽到最近 8 个播放过的帧就跳过，最多重试 5 次（避免死循环）；
  帧池比窗口还小时退化为「不连播同一张」。
- **不再固定抽 30**：`MAX_FRAMES_PER_STATE` 30 → **80**（仅作单次构建上限）；播放列表从 24 槽 → **64 槽**，
  由 `buildIdlePlaylistStateful` 用袋子逐槽推进，而不是固定 24 帧循环。
- **权重封顶 + 最低占比**：`clampRotationWeights`：单状态 ≤ **3.0**、每个状态 ≥ **2%** 占比
  （迭代到收敛），保证「累了更容易睡/休息」但不会某状态霸屏。
- **重建不重置指针**：`nextIndexAfterFramesChange`——新列表里还能找到刚播的帧就继续往后播，
  找不到（真正切换状态/换形象）才从第一张开始。
- 列表里再补一层「相邻不重复」：洗牌袋重洗边界处抽到与上一张相同则重抽。

## 200 次播放实测（`work/rotation-stats.mjs`，固定种子）

| 指标 | 旧实现 | 新实现 |
| --- | --- | --- |
| 200 次播放里出现过的不同帧 | **23 张**（重复率 88.5%） | **200 张**（重复率 0） |
| 单帧最高出现次数 | **17 次**（`happy/28.gif`） | **1 次** |
| 连续重复（相邻两张相同） | 0（旧实现有相邻去重） | 0 |
| 单状态最高占比 | idle 21%（`happy/28` 那类重复） | idle **12.5%**（权重封顶 3.0） |
| 权重范围 | `cry 0.05 … idle 3` 无封顶 | 全部落在 `[2%, 3.0]`（`idle=3, cry≥0.05` 抬到 2% 份额下限） |

新实现前 20 次播放（`state/索引.gif`，无重复）：
`sleeping/28、spin/17、spin/16、scared/16、working/4、happy/12、sleeping/11、celebrate/29、angry/30、hide/30、
 eating/20、attention/12、idle/9、idle/26、love/16、cry/13、hide/12、peek/1、sleeping/7、eating/11`。

旧实现前 20 次（同一批 24 槽循环，`happy/28` 在 20 次里就出现 2 次、8 轮里出现 17 次）：
`working/28、happy/28、idle/26、pet/2、idle/30、bath/16、…、happy/28、…`

## 单测

`tests/pet-rotation-bag.test.mjs`（7 条）：洗牌袋一轮全覆盖且不重复、重洗后顺序变化、
最近 8 不重复（40 次连续播放断言）、权重封顶 ≤3 且每状态 ≥2%、4000 次抽状态分布符合权重、
重建列表指针连续（找到刚播的帧 → 继续；找不到 → 0）、64 槽有状态列表不连播同一张。

`tests/pet-vitals.test.mjs` 里「体力低 → sleeping 远多于 happy」的阈值从 10× 调到 3×
（权重封顶后倍率从 ~25× 收敛到 ~5–10×，正是「不霸屏」的预期）。

## 相关文件

- `src/petRotationBag.ts`（新，纯函数 + 持久化）
- `src/petVitals.ts`（`buildIdlePlaylistStateful` / `buildIdlePlaylist` 包装）
- `src/petCharacters.ts`（`MAX_FRAMES_PER_STATE` 30 → 80）
- `src/usePetGifRotation.ts`（重建不重置指针 + 最近 8 去重）
- `src/App.tsx`（待机轮播改用有状态列表 + 持久化袋子）
- `tests/pet-rotation-bag.test.mjs`（新）、`tests/pet-vitals.test.mjs`