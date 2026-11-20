# 桌宠形象：小白 / 小鸡毛 / 两只一起

Maltese 现在支持 LineDogPet 的两只小狗形象，并把「两只同框」的共享素材也接了进来。

## 素材来源

从 `E:\LineDogPet\LineDogPetv2.8.3\pets` 复制到 `assets/pets/chars/`：

```
assets/pets/chars/
├── xiaobai/    小白，25 个动作、394 张 GIF
├── xiaojimao/  小鸡毛，24 个动作、233 张 GIF
└── shared/     两只小狗同框，18 个动作、152 张 GIF（不是可选角色）
```

2026-11-16 做过一次角色归位：`shared` 里原先混入的单只小白 / 单只小鸡毛素材，按画面颜色和人工抽检分回 `xiaobai` / `xiaojimao`；随后又按帧复查清掉了剩余单角色、道具和多狗群像，`shared` 现在只保留同框素材。三张完全重复的 GIF 已移到 `work/shared-split-duplicates/`，不属于双狗的素材移到 `work/shared-nonduo/`，因此总数从 791 变为 779。

文件名保留原始中文，路径在生成清单时做了 URL 编码。素材清单由脚本生成：

```bash
node scripts/build-pet-manifest.mjs
```

它现在扫**三处**（顺序固定，stable diff）：

| 扫描位置 | 说明 |
| --- | --- |
| `chars/xiaobai` | 全量收 |
| `chars/xiaojimao` | 全量收 |
| `chars/shared` | 全量收，**只在 duo 形象下可选** |
| `stickers/weibo` | 微博官方表情包：只收「内容唯一」的（与 chars 完全相同的副本按 sha256 跳过） |
| 根级 `rest.gif` | 旧兜底里唯一不重复的（`resting` 用） |

> 各分组的**实际张数以 `node scripts/build-pet-manifest.mjs` 的输出为准**
> （脚本会打印「分组 / 动作 / 张数」与跳过多少重复）。
> 素材库当前还在白底抠图验收中，本文档暂时不写死总数，避免与工作区状态对不上。

- **去重按文件内容 sha256，不按文件名**：素材多次归位后同名不同图很常见。
- **删除策略**：只删「内容哈希与 `chars/` 某个文件完全相同」的副本（stickers 与根级旧兜底里那些重复文件）；
  `chars` 内部「内容相同但文件/路径不同」的条目**一律不动**（那是路径语义，不在清理范围）。
  待删清单（路径 + sha256 + 对应保留路径）在 `work/asset-dedupe-plan.txt`（`work/` 不进版本库）。
- **根级兜底表已删（2026-11-17）**：`src/petAssets.ts` 原先维护一套 `/assets/pets/<state>.gif` 根级路径表作为
  「最后兜底」，那些文件与 chars 内容重复、已被清理；现在 `resolvePetGif` 改为从生成的素材清单取图
  （`characterFramePaths("xiaobai", state)`），只有 `rest.gif`（趴睡）继续以根级路径保留。
  `tests/pet-asset-inventory.test.mjs` 有一条断言守着「源码不再引用已删除的根级 GIF」。
- 微博表情包（`stickers`）与 `legacy` 的 `rest.gif` 都并入了**单角色**（小白 / 小鸡毛）的素材池（`petCharacters.extraPoolFrames`），
  duo 只播同框池；微博表情包小动作按语义对齐：`sleep→sleeping`、`eat→eating`、`work→working`、`nervous→scared`、
  `hop→celebrate`、`paper→attention`、`walk→chase`。
- 设置页「表情轮播」里的**素材库总览**只放数字口径（总数、五个分组计数、本表情可选/轮播抽 30 张、同框 duo-only 一行短注），
  **详细解释统一放在本文档**（见下面「素材库说明」与「轮播权重随状态变化」两节）。
  测试见 `tests/pet-asset-inventory.test.mjs`（清单无失效路径、磁盘无未收录素材、磁盘无 chars 重复副本、物理数 = 清单数）。

## 白底抠图修复（工作区未提交，等用户验收）

**现象**：部分小白 / 小鸡毛 / 同框 GIF 在深色壁纸上只剩深色轮廓线，狗身白色填充透出壁纸，看起来「变透明了」。

**根因**：上一轮提交 `b4f0748` 跑的旧版白底抠图脚本（`.tmp-build/fix-white-bg.py`）从图片边框对近白色像素做洪水填充去白底；线条轮廓存在抗锯齿缝隙，洪水填充漏进轮廓内部，把本应保留的白色狗身也一并置成透明。旧校验只在首帧检查内部白色保留率，没拦住漏填。

**影响范围**：一批白底素材（小白 / 小鸡毛 / 同框 / 微博表情包都有）；其余素材本就是透明底健康图，未受影响。**具体张数以脚本报告 `work/white-bg-repair-report.json` 为准**，本文档不写死。

**修法**：从 `.tmp-build/white-bg-backup/` 的备份原图重新抠底（备份是处理前原样，未被覆盖）：

- 近白色像素分两类：与边框连通的外部背景置透明；被轮廓围住的白色身体保留不透明。
- 轮廓屏障先做 2 像素膨胀封住抗锯齿缝隙，再从边框洪水填充，避免泄漏进身体。
- 洪水填充后再做 1–2 轮「边界白像素回收」，去掉轮廓外的 1–2px 白边（深色壁纸上的光晕）。
- GIF 容器自己拼（帧数 / 帧时长 / 画布 / 循环与备份逐一对照），避免第三方写库合并相邻帧或改写时长。
- 彩色底 / 暗底的少数文件白底算法不适用，回滚为 HEAD 版本（脚本 `ROLLED_BACK_FILES`，`--exclude` 可复核）。

复跑脚本：`python scripts/repair-white-bg-transparency.py --backup .tmp-build/white-bg-backup --assets assets/pets`（只处理备份与当前资产目录都存在的 GIF，原始备份不动）。

> **状态**：这一批素材改动**尚未提交**，等用户亲自验收后再更新结论与数字。

**第 2 版（2026-11-19）**：第一版留下的白底边缘有 1–2px 白环（深色壁纸上的「光晕」），且保存 GIF 时曾用 Pillow 直存，
会把「量化后完全相同」的相邻帧合并（`xiaojimao/angry/p18-6.gif` 14 帧压成 13 帧、末帧时长被并成 1100ms）。
现在脚本改为：白环按 8 邻接连通性回收 1–2 圈，再手写 GIF89a 容器逐帧写入（调色板预留 255 号索引做透明、`disposal=2`），
帧数 / 逐帧时长 / 画布与原图严格一致；全量复跑覆盖除回滚文件外的白底素材（数量见脚本报告）。

**第 3 版（2026-11-19，当前）**：动画里出现更隐蔽的漏抠——两只白狗相邻时轮廓在抗锯齿处断开，白身和外部背景连成一片，
2px 屏障挡不住，个别帧整只狗被抠成空壳（`happy/p15-9` 第 3/6/9 帧、`chars/xiaobai/idle/p2-teaser-6` 第 2 帧）。
现在屏障加厚到 **4px**，洪水填充后把背景**外沿内收 3px（不越过屏障）**压掉白环，既不漏抠也不会重新打穿缝隙。
同时手写 GIF89a 容器保存，逐帧保留独立调色板（255 号留作透明）、`disposal=2`、精确帧时长，不做帧合并。

## 微博表情包重做（2026-11-19）

**现象**：`stickers/weibo` 里 8 张贴纸在深色壁纸上狗身发白、边缘糊成一团白边——原图本身是纯白底（opaque≈1.0），
第一版白底修复对这些 240×240 的贴纸效果不好。

**做法**：按 `assets/pets/stickers/weibo/index.json` 的 `source_image`（微博 CDN 直链，带 `Referer: https://weibo.com/`）
重新下载原图，居中裁方 + LANCZOS 缩到 240×240，再用「近白判定 → 轮廓屏障膨胀 2px 封缝 → 从四边洪水填充 → 保留白区外沿内收 1px」
重做透明底：内收 1px 是为了压掉白底边缘残留的白边，狗身白色离边框远，不受影响（`dilate=1` 会漏进白狗身体，实测不可用）。

**结果**：微博表情包全部重做并回填素材库，狗身完整、无白底方块。
`pet/p11-7.gif` 重做后与 `chars/shared/pet/p11-7.gif` 不再字节相同，按去重策略可独立保留（具体数量以清单为准）。
`index.json` 中对应条目的 `width/height/frames/duration_ms/bytes/sha256` 已按实际文件刷新并记 `refetched_at`。
重下脚本与中间产物在 `work/`（不进版本库）。
`index.json` 中这 9 条的 `width/height/frames/duration_ms/bytes/sha256` 已按实际文件刷新并记 `refetched_at`。
重下脚本与中间产物在 `work/`（不进版本库）。

## 素材库说明（为什么设置里看到的数量是这样）

1. **总清单条数 = 磁盘上的 GIF 数**（`chars` 全量 + `stickers` 唯一内容 + `legacy` 的 `rest.gif`），一一对应；
   设置页顶部「共 N 张」就是它。具体 N 以生成脚本输出为准（见上）。
2. **双狗同框 152 张只在「小白和小鸡毛」形象下可选**：小白 / 小鸡毛各自只播自己的素材，同框池是 duo 专用（产品决定）；
   所以单独选一个角色时，格子墙里看不到那 152 张，但总览里仍然会计数。
3. **同一张图只保留一份**：微博表情包与根级旧兜底里与 `chars` 内容完全相同的副本已按 sha256 删除，
   所以「物理文件数」比历史版本少，但**内容没少**。
4. **单个表情的可选张数** = 当前形象 + 当前表情的素材池；轮播每次只从池里随机抽 **30 张**上屏（`MAX_FRAMES_PER_STATE`），
   所以「本表情可选 X 张 / 轮播随机抽 30 张」这两个数字本来就不同：池子更大的表情不会全部出现在轮播里，但都能在格子墙里勾选。
5. **轮播默认包含全部 25 个表情**（设置页「轮播范围」可改）；只勾少数几个时，轮播就只在勾选的表情里换。
6. 详细来源、动作映射、同框规则见上文各节；素材版权归 ©MALTESE / 线条小狗官方。

## 轮播权重随状态变化（桌宠自我状态）

待机轮播不再等概率换表情，而是按「体力 / 情绪 / 亲密 / 专注」四个指标的权重表取样：

| 指标 | 权重变化（相对倍率） |
| --- | --- |
| 体力 < 25 | `sleeping ×5`、`relax ×3`、`resting ×2.5`、`chin ×2`；`happy/play ×0.2`、`celebrate/chase/spin ×0.3` |
| 体力 25–50 | `relax ×2`、`idle ×2`、`sleeping/resting ×1.4`、`play ×0.6` |
| 体力 > 80 | `play ×1.6`、`happy ×1.3`、`chase ×1.3` |
| 情绪 > 75 | `happy ×3`、`celebrate ×1.8`、`love ×2`、`spin/play ×1.2` |
| 情绪 < 35 | `relax ×2`、`chin ×1.5`、`pet ×1.6`、`peek ×1.6`；`happy ×0.3`、`celebrate ×0.2`；**情绪 < 25 时 `cry` 才抬到 0.3（小概率）** |
| 亲密 > 80 | `love ×3`、`pet ×2`、`peek ×1.5`、`happy/chin ×1.2` |
| 亲密 < 35 | `idle ×2`、`peek ×1`、`pet ×0.6`、`love ×0.2`、`chin ×0.8` |
| 专注 > 60 | `working ×2.4`、`attention ×1.6`、`listening ×1.2`；`sleeping ×0.4`、`relax ×0.8` |
| 专注 30–60 | `working ×1.4`、`attention ×1.15` |

- **覆盖全部 25 个可轮播状态**：每个状态都有基线权重（`VITALS_BASE_WEIGHTS`），不会出现「没配到权重就等概率」的情况。
  负面表情基线压得很低（`angry 0.3`、`cry 0.05`），数值再差也不会变成「哭脸/生气惩罚」。
- **只影响待机轮播**：动作、通知、音乐、Agent 指定的表情优先级不变；总开关关掉后完全回到原来的等概率轮播。
- 实现：`src/petVitals.ts` 的 `VITALS_ROTATION_STATES` / `VITALS_BASE_WEIGHTS` / `weightsForVitals()` /
  `buildIdlePlaylist()`；`src/App.tsx` 的 `carouselFrames` 按 `vitalsBucketKey` 分桶重建（数值小幅变化不重排播表）。
- **聊天表情包兜底**：`pickStickerForVitals(vitals, pool, { rng?, avoid? })` 用同一张权重表从候选中挑一个
  （例如累了更容易挑 `sleeping` 表情包、开心更容易挑 `happy`/`celebrate`），供聊天「表情包信使」在模型没给标记、
  或需要从库里挑代表帧时使用；`avoid` 用来跳过最近发过的 id。
- 单测：`tests/pet-vitals.test.mjs`（25 个状态全覆盖、低体力 sleeping 远多于 happy、专注/亲密/情绪档位、
  cry 只在极低情绪小概率、`pickStickerForVitals` 的权重/avoid/空池）。

## 三个形象

| 设置里的名字 | id | 行为 |
| --- | --- | --- |
| 小白 | `xiaobai` | 只播小白自己的素材，必要时插播同框素材 |
| 小鸡毛 | `xiaojimao` | 只播小鸡毛自己的素材，必要时插播同框素材 |
| 小白和小鸡毛 | `duo` | 只播同框素材；没有对应动作时沿回退链借近似动作 |

形象保存在 `localStorage` 的 `maltese-pet-character`，主窗口、陪玩狗、跟随狗和设置窗口通过 storage 事件同步。

## 动作映射与回退

界面状态到 LineDogPet 动作目录的映射写在 `src/petCharacters.ts` 的 `STATE_TO_ACTION`，
例如 `celebrate → hop`、`resting → relax`、`attention → paper`。

某个动作缺素材时按 `ACTION_FALLBACK` 找视觉相近的动作，最后兜底小白 `idle`，
保证任何形象在任何状态下都有画面。

抱起、转圈这两个招牌动作固定用 `shared` 里指定的那一张
（`举起来.gif`、`转圈.gif`）；追逐固定用 `xiaojimao/chase/狂奔.gif`，
和 LineDogPet 的手感一致。

## 同框素材什么时候出现

2026-11-17 最终口径：同框（两条狗）GIF **只给「一起出现」(duo)**，小白 / 小鸡毛
各自只播自己的素材——曾短暂改成「全量并入单角色池」，用户确认不要双狗图后回退。
单角色的已存轮播列表里如果残留 `shared` 条目，读取时也会一并剔除；
抱起 / 转圈这两张双狗招牌图同样不再给单角色用。

设置页工具栏的「N 张 GIF」显示的是**该动作的素材库库存**（单角色 = 自己的素材，
duo = 同框池），不是已选列表长度；展开按钮上的 N 才是已选列表张数。
轮播配置读取时按素材路径去重，并剔除已失效（文件已移动/删除）的内置路径，
所以历史重复配置和失效条目不会再撑大数量。

每个状态最多轮播 30 张：素材池里有的动作有 100 多张 GIF，全部预加载会吃掉几十 MB 内存，
所以按均匀间隔抽一批，本次运行保持不变；设置页的「全选」仍然可以拿到完整素材池。
另外，轮播配置在**读取时**也会按素材路径去重，历史重复配置（29 张变 713 张那类）
不再撑大「共 N 张」和实际轮播列表。

## 待机轮播范围（设置 UI 已下线，配置保留）

- 「轮播范围」勾选的状态会在待机时合并轮播（动作/情绪状态仍优先播自己的动画）。
  **默认勾选全部 25 个状态**，所以待机时能看到全部素材，而不是只有 `idle` 那 30 张；
  旧版默认只有 `idle`，升级时用 `maltese-pet-gif-rotation-scope-v2` 标记迁移一次，用户之后改过的不再覆盖。
- 2026-11-17 用户反馈「表情设置区只留轮播 GIF 网格」，设置页里的「轮播范围」面板（状态勾选、
  「全选所有状态 / 仅当前状态」、「轮播中的 GIF」缩略图墙）已整块删除。**底层数据没动**：
  `maltese-pet-gif-rotation-states` 的读写、默认全选、一次性迁移，以及 `rotationFramesForState()`
  的合并规则都保持原样，已有用户配置照常读取。
- 预加载改成「只提前 4 张」：之前是全量预加载，几百张 GIF 会一次性解码；现在每 10 秒前进一张，
  命中下一张前有 40 秒左右预热，内存占用不随素材数量线性增长。

## 自定义 GIF 仍然可用

设置页「专属形象」卡片现在按形象分开保存：`maltese-pet-gif-rotation:<角色>`。
旧版按状态保存的配置会自动迁移到小白，其他形象第一次使用时直接用素材默认值。

## 表情轮播设置：方格网格 + 指针拖动排序 + 右键删除

「表情轮播」有**两处入口，共用同一个组件**（`src/PetGifRotationSettings.tsx`）：

- 岛内展开浮层 → 顶部「设置」页签 → 岛内设置页的「表情轮播」小节；
- 独立「桌宠设置」窗口（托盘 / 快捷入口页「设置」/ 岛内设置页右上「独立设置窗口」）。

岛内入口是为了解决「改轮播 GIF 必须弹第二个窗口」的反馈（QA D5）：点「设置」页签不再弹独立
设置窗口，就地展开岛内设置页，改 GIF、拖动排序、右键删除全程只有主窗口一个窗口。
独立窗口里的那份保留不变；从岛内/快捷入口打独立窗口时会先收起浮层再弹窗，避免两个窗口同时出现。
两处渲染的是同一个组件，折叠状态（`maltese-gif-settings-expanded`）共享。

设置页「表情轮播」的 GIF 列表从「每行一张的长条 + ↑↓ 按钮」改成**缩略图方格墙**：
`grid-template-columns: repeat(auto-fill, minmax(96px, 1fr))` 自适应列数，
每格是 GIF 缩略图 + 左上角序号角标 + 底部文件名；「上移/下移」按钮和对应 i18n 文案已移除，
`order()` 现在只用于序号角标和无障碍标签。

组件里**只保留**：表情状态下拉、方格网格、张数提示 + 拖动/右键说明、全选、恢复默认顺序、
添加 GIF（≤8 MB）、折叠按钮、错误/操作提示。2026-11-17 按用户反馈删掉了「轮播范围」面板
和它的缩略图预览墙（用户原话：「只留轮播 gif，然后操作里面的小表情包就可以，下面这些没有
什么用就不需要了」）——删掉的只是 UI，`petGifRotation.ts` 里的范围数据与默认值原样保留
（见上一节）。折叠按钮文案跟着张数走：`展开（N 张）` / `收起（N 张）`，走 i18n
`petGifs.expandWithCount` / `collapseWithCount`；旧文案键 `rotationScope* / selectAllStates /
currentStateOnly / scopeCount / rotationFrames*` 已从 `src/i18n/types.ts` 与两份 locale 删除。

### 拖动排序：Pointer Events（不是 HTML5 拖放）

用户实机反馈「展开表情轮播后，鼠标拖动格子没有任何排序效果」。**真实原因**：Tauri v2 的
窗口配置 `dragDropEnabled` 默认是 `true`，wry 会在窗口 HWND 上 `RevokeDragDrop()` +
`RegisterDragDrop()` 自己的 `IDropTarget`（只处理 `CF_HDROP` 文件拖入），WebView2 里的
HTML5 拖放事件（`dragstart/dragover/drop`）根本送不到网页 → React 的
`onDragStart/onDragOver/onDrop` 一次都不会触发。Tauri 源码里的原话是
「Disabling it is required to use HTML5 drag and drop on the frontend on Windows」。

修复分两层：

1. **配置层**：`src-tauri/tauri.conf.json` 的 `main` 窗口加 `"dragDropEnabled": false`；
   `src-tauri/src/window_factory.rs` 给 `settings` 窗口加 `.disable_drag_drop_handler()`
   （字段 `WindowSpec::drag_drop_enabled`）。本项目没有任何地方监听 `onDragDropEvent` /
   文件拖入，关掉不影响其它功能；其它窗口保持 Tauri 默认。`window_factory` 里有一条单测
   锁住「settings 关闭、其它窗口保持默认」。关掉原生拖放后 WebView2 会把「从资源管理器把文件
   拖进窗口」当浏览器默认行为（导航到 `file://` 白页），所以 `src/main.tsx` 里全局
   `preventDefault()` 掉 `dragover` / `drop`。
2. **实现层**：排序改成 **Pointer Events**，不再依赖浏览器拖放——`onPointerDown` 记下源下标
   并 `setPointerCapture()`；`pointermove` 用 `petGifDropTargetIndex()`
   （`src/utils/gifRotationOrder.ts`，纯函数、可单测）拿格子的 `getBoundingClientRect`
   算落点；`pointerup` 提交。4px 阈值区分「单击」和「拖动」，`pointercancel` /
   `lostpointercapture` 清理状态。指针事件天然支持鼠标 / 触摸 / 笔；CSS 给格子加了
   `touch-action: none` + `user-select: none`，触屏也能直接拖。拖到网格上下边缘会自动滚动
   （触屏没有滚轮，靠它把格子拖到远处）；拖到自身格子上或拖出网格（24px 容错外）松手
   = 不排序、不写盘。

视觉与持久化：被拖的格子加 `is-dragging`（半透明 + 虚线），落点格加 `is-drop-target`
（青色描边 + 3px 插入线；向上拖线在左侧、向下拖线在右侧，与松手结果一致）。松手用
`movePetGifItem(items, from, to)` 换算顺序，再走 `saveItems()` →
`savePetGifRotationConfig({ ...config, [state]: next }, character)` 写回
`localStorage["maltese-pet-gif-rotation:<角色>"]` 并派发 `maltese-pet-gif-rotation-updated`；
主窗口 / 陪玩狗 / 跟随狗照旧通过 storage 事件和自定义事件同步，**没有新增存储**。

- **右键删除**：格子 `onContextMenu` 阻止默认菜单后直接删除（无确认弹窗）。自定义 GIF 仍先调
  `remove_pet_gif` 删掉应用数据目录里的文件，再 `saveItems` 过滤掉该项；删除成功后显示 2.4 秒的
  「已删除 N 张 GIF」状态提示（`role="status"` / `aria-live="polite"`）。格子悬停或聚焦时右上角
  也会浮出一个小删除按钮，走同一个 `remove()`，不会再弹二次确认。
- 方格区域最大高度在独立设置窗口里 460px、岛内浮层里 300px，超出内部滚动，避免一个表情几百张图把设置页拉成一条长柱。
- 单测：`tests/gif-rotation-order.test.mjs` 覆盖下标换算（向上/向下/相邻/首尾/原位/拖到自身）
  和指针落点命中（命中格子、压在被拖格子上、间隙取最近、拖出网格取消）。
- 相关文件：`src/PetGifRotationSettings.tsx`、`src/PetGifRotationSettings.css`、
  `src/utils/gifRotationOrder.ts`（持久化仍复用 `src/petGifRotation.ts`）。
- 已知限制：键盘可达性只做到格子可聚焦（`:focus-visible` 描边），暂不支持键盘排序；
  触屏在网格内滚动请从格子间隙或网格边缘拖（拖动格子本身是排序手势）。

## 微博官方表情包（独立素材池）

`assets/pets/stickers/weibo/` 存了一份从官方微博 [@线条小狗Maltese](https://weibo.com/u/7776232700) 收集的整套表情包：第 1–33 弹加 emoji、漫画、新春、小小狗/小小金毛、补充包等特辑，共 36 组 296 张，已归一化成 240×240、保留透明底的多帧 GIF。

- **按动作分目录**：`weibo/<动作>/<组>-<序号>.gif`，动作名对齐 `assets/pets/chars/` 现有的 `idle / happy / pet / sleep / eat / relax / play / nervous / scared / peek / hide / work / paper / hop / walk`，另按画面补了 6 个新动作名 `angry`、`cry`、`love`、`ride`、`bath`、`costume`，共 21 类。逐张清单见同目录 `by-action.md`。
- 每张还带情绪标签（开心 / 亲昵 / 难过 / 生气 / 惊讶 / 困倦 / 无语 / 害羞 / 进食 / 玩耍 / 中性），清单见 `by-emotion.md`。
- **归位与去重（2026-11-17）**：296 张里 **287 张与 chars 内容完全相同**（按 sha256 比对，分布在
  xiaobai 137 / xiaojimao 80 / shared 70），只有 **9 张是唯一内容**（`happy×4`、`scared×2`、`eating×1`、`pet×1`、`sleeping×1`）。
  经用户确认，这 287 个冗余副本**已从磁盘删除**（清单见 `work/asset-dedupe-plan.txt`），
  保留的 9 张收进清单的 `stickers` 分组并并入单角色素材池。`stickers/weibo/index.json` 与
  `by-action.md` / `by-emotion.md` 仍记录采集时的完整 296 张（含已删文件路径），用于追溯来源。
  `src/petCharacters.ts` 的 `STATE_TO_ACTION` 与 `ACTION_FALLBACK` 已挂上 6 个新动作
  （回退链分别是 `angry → nervous → scared → idle`、`cry → scared → nervous → idle`、`love → pet → happy → idle`、
  `ride → play → walk → idle`、`bath → relax → idle`、`costume → happy → idle`），
  `PetState` 联合类型、悬停气泡面板的 6 个按钮（生气 / 委屈 / 比心 / 兜风 / 泡澡 / 装扮）、
  原生 `maltese-pet-action` 事件白名单和 i18n 的 `diary.petActions` 也已补齐，桌宠能直接触发。
- **内存不会跟着素材线性涨**：`MAX_FRAMES_PER_STATE = 30`，每个状态下按均匀间隔抽样，素材再多也只预加载 30 张。
- 逐张规格、帧数、来源原图地址、动作与情绪见 `assets/pets/stickers/weibo/index.json`，总览见同目录 `preview.png`，采集与归一化脚本在 `work/weibo-stickers/`（`work/` 不进版本库）。
- 因为 `tauri.conf.json` 把整个 `assets/pets` 打进安装包资源，这一池会让安装包多约 30 MB；不想带上就把目录移出 `assets/pets`。
- 版权归 ©MALTESE / 线条小狗官方，随安装包分发或商用需自行取得授权。

## 趴下睡觉那张图

主狗多久没动静自动趴下、缩到屏幕边缘、手动点「让小狗睡觉」时，都会单独播这一张「趴睡」帧。

- 默认跟随当前形象：取该角色 `sleeping` 动作的第一张（小白是小白的睡觉动画，小鸡毛是小鸡毛的）。
  早期版本固定播 `assets/pets/rest.gif`，那是金黄色的小鸡毛，选小白也会变成小鸡毛，已修掉。
- 设置页「趴下睡觉的 GIF」（紧挨着「多久没动静就趴下睡」）可以换成自己的 GIF：文件存到应用数据目录的
  `pet-gifs/tuck/`，路径记在 `localStorage` 的 `maltese-tuck-gif`；「恢复默认」清掉这个键即可。
- 岛内设置和独立设置窗口共用同一个控件（`src/TuckGifControl.tsx`）。

## 删除 GIF：确认、撤销、回收站（2026-11-17）

背景：表情轮播的方格右键 / 垃圾桶按钮原来**直接删除**，内置素材会立刻从轮播列表消失，
自定义 GIF（`pet-gifs/<表情>/gif-*.gif`）还会当场删掉磁盘文件。用户误删一个 GIF 后
没有任何挽回入口，属于 P0 数据丢失。现在改成三段式：

1. **删除前确认**：右键或点垃圾桶只弹应用内确认框（不用浏览器原生 `confirm`），
   框里显示该 GIF 的缩略图、文件名和会发生什么：
   - 内置素材：「只会从轮播列表移除，内置素材文件不会被删除。」
   - 自定义 GIF：「会从轮播列表移除，并删除这个 GIF 文件；8 秒内可以撤销。」
   `Esc` / 点「取消」/ 点遮罩都只关闭确认框；默认焦点在「取消」。
   确认流程是纯状态机（`src/utils/petGifRemoval.ts`），**未确认拿不到待删项**，
   单测锁住「未确认不删」「删除中不重复删」。
2. **可撤销的删除**：确认后自定义 GIF 先由 Rust `park_pet_gif` 复制到
   `<应用数据目录>/pet-gifs-trash/<时间戳>-<计数器>-<原文件名>`，再删原文件、
   写回配置；同时把一条记录写进 `localStorage` 的 `maltese-pet-gif-trash`
   （含 `character/state/index/item/deletedAt/trashPath`，最多 10 条，新的在前，
   被挤出去的最旧一条会顺手删掉它的磁盘副本）。底部提示条给「撤销删除」按钮，
   约 8 秒内点击会把副本用 `restore_pet_gif` 复制回原路径，并按原下标插回轮播列表。
3. **常驻「恢复最近删除」**：表情轮播卡片底部固定一个入口（不依赖轮播区是否展开），
   展开后逐条列出最近删除的 GIF（文件名、形象 · 表情、删除时间），点「恢复」即可
   走同一套恢复逻辑。

实现位置：

- `src/utils/petGifRemoval.ts`：确认状态机 + 回收站列表（上限/出栈顺序）+ 顺序恢复，纯函数、可单测。
- `src/petGifTrash.ts`：`maltese-pet-gif-trash` 的读写、跨窗口事件、Tauri 文件命令封装。
- `src/PetGifRotationSettings.tsx` / `.css`：确认框、撤销提示条、恢复入口与样式。
- `src-tauri/src/pet_gifs.rs`：`park_pet_gif` / `restore_pet_gif` / `discard_trashed_pet_gif`。
  恢复时拒绝覆盖已存在的同名文件；回收站目录和表情目录都做了路径越界校验。
- 单测：`tests/pet-gif-removal.test.mjs`（12 条）。


## 表情轮播拖拽排序（2026-11-17 二次修复）

**用户反馈**：上一轮改成 Pointer Events 之后，设置页的方格「还是拖不动」。

### 真实失败原因（WebView2 实测，非推理）

用 WebView2 远程调试（临时在 `tauri.conf.json` 的 main 窗口加
`additionalBrowserArgs: "--remote-debugging-port=9222"`）接管真实窗口，在页面里注入
pointer 事件探针 + 用 `Input.dispatchMouseEvent` 走真实指针路径后确认：

1. 事件确实到达页面（`pointerdown/move/up` 都记录到了），但**事件目标不是格子**：
   `closest("[data-gif-index]")` 为 `null`，`.is-dragging` 一直是 0，
   `localStorage` 一次都没写。旧实现把 `onPointerDown` 挂在每个 `figure` 格子上，
   只要命中测试没落到格子上（隐藏/重挂载的另一份 DOM、图片子节点、滚动后坐标）
   整个拖拽链就静默失效——**没有错误提示，看起来就是"拖不动"**。
2. 另一个隐藏杀手：「全选现有表情」比较的是**绝对路径 vs 存储里的相对路径**
   （`/assets/pets/chars/...` 对 `chars/...`），永远判成"没选过"，点一次就把整个素材池
   追加一遍。用户配置从 29 张涨到 713 张，几百个格子里拖动更容易踩到 1 的坑。

### 修法：网格容器级拖拽 + 路径归一 + 写回校验

- `PetGifRotationSettings.tsx`：`onPointerDown/Move/Up/Cancel/LostPointerCapture`
  全部挪到**网格容器**上；按下时用 `petGifIndexAtPoint()`（纯函数）按坐标命中格子，
  `setPointerCapture` 也捕获在容器上。不再依赖被按下的格子节点是否存活或被替换。
- **松手时重新量一遍矩形**再算落点（`measureTiles()` → `petGifDropTargetIndex()`），
  拖动中滚动/窗口变化不会用过期坐标。
- 排序写回后**回读 localStorage 校验**，不一致就显示中文错误「顺序没能写进配置，请重试」，
  不再静默失败。
- 「全选」与去重统一用 `builtinAssetRelative()` 归一后的唯一键（`petGifItemKey`），
  写回时顺手 `dedupePetGifItems()` 清掉历史重复项。
- CSS：网格容器也加 `touch-action: none`（格子原本就有）。

### 实机验证（CDP 真实指针）

- 修复前：pointerdown 命中 `tile:null`、`.is-dragging=0`、无 `storage.set`，顺序不变。
- 修复后（同一台机器、29 张素材、真实 `Input.dispatchMouseEvent`）：
  从第 1 格拖到第 3 格，拖动中 `dragging=1 / dropTarget=1`，松手后
  - DOM 序号：`写.gif, normal2.gif, 吹心心_2.gif` → `normal2.gif, 吹心心_2.gif, 写.gif`
  - `localStorage["maltese-pet-gif-rotation:xiaojimao"]` 同步变成同样顺序（只写了一次）；
  - 对应单测 `movePetGifItem(items, 0, 2)` 的结果一致。

### 人工复测步骤

1. 启动后双击小狗 → 快捷面板点「待办」→ 顶部「设置」→「表情轮播」卡片（自动展开或点「展开（N 张）」）。
2. 按住第 1 张方格往右/下拖到第 3 张位置，松手：序号应立刻重排，刷新/重开设置页顺序保持。
3. 点一次「全选现有表情」：数字只应增加缺的那几张（不是整个素材池再来一遍）。
4. 若仍拖不动：把 DevTools Console 里 `[pet-gif-drag]` 相关日志（或页面错误）连同现象一起反馈。

> 多实例联动（情绪传染 / Bongo 呼应）见 [multi-instance-linkage-design.md](multi-instance-linkage-design.md)：
> 主狗被摸头/喂食/开心时，陪玩狗会跟着动、Bongo 会敲鼓呼应；开关在「设置 → 桌宠」的
> 「实例联动」（岛内设置页与独立设置窗口都有，默认开，需小狗数量 ≥2 或打开 Bongo）。

> 「实例联动」增强版：设置页「实例联动」区块有「试一下联动」按钮，会临时拉一只随从演示一次
> （动作 + 朝主狗方向位移 + 缩放脉冲 + 台词气泡），3 秒后自动复原，不改你的设置。
