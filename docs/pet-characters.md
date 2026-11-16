# 桌宠形象：小白 / 小鸡毛 / 两只一起

Maltese 现在支持 LineDogPet 的两只小狗形象，并把「两只同框」的共享素材也接了进来。

## 素材来源

从 `E:\LineDogPet\LineDogPetv2.8.3\pets` 复制到 `assets/pets/chars/`：

```
assets/pets/chars/
├── xiaobai/    小白，25 个动作、380 张 GIF
├── xiaojimao/  小鸡毛，24 个动作、225 张 GIF
└── shared/     两只小狗同框，21 个动作、180 张 GIF（不是可选角色）
```

2026-11-16 做过一次角色归位：`shared` 里原先混入的单只小白 / 单只小鸡毛素材，按画面颜色和人工抽检分回 `xiaobai` / `xiaojimao`；`shared` 只保留同框素材。三张完全重复的 GIF 已移到 `work/shared-split-duplicates/`，另有三张不属于单只角色的素材（两张多狗群像、一张灰狗）移到 `work/shared-nonduo/`，因此总数从 791 变为 785。抱起 / 转圈 / 追逐的固定招牌图仍留在 `shared`。

文件名保留原始中文，路径在生成清单时做了 URL 编码。素材清单由脚本生成：

```bash
node scripts/build-pet-manifest.mjs
```

它会扫描上面三个目录，写出 `src/petCharacterAssets.generated.ts`。新增素材后重跑这个脚本即可，不需要改代码。

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

抱起、转圈、追逐这三个招牌动作固定用 `shared` 里指定的那一张
（`举起来.gif`、`转圈.gif`、`狂奔.gif`），和 LineDogPet 的手感一致。

## 同框素材什么时候出现

默认角色在某个动作里有同框素材时，按「每 3 张本角色图插 1 张同框图」的比例混进轮播，
比 LineDogPet 的 35% 概率更容易观察到，也不至于抢戏。

每个状态最多轮播 30 张：素材池里有的动作有 100 多张 GIF，全部预加载会吃掉几十 MB 内存，
所以按均匀间隔抽一批，本次运行保持不变；设置页的「全选」仍然可以拿到完整素材池。

## 待机轮播范围

- 「轮播范围」勾选的状态会在待机时合并轮播（动作/情绪状态仍优先播自己的动画）。
  **默认勾选全部 25 个状态**，所以待机时能看到全部素材，而不是只有 `idle` 那 30 张；
  旧版默认只有 `idle`，升级时用 `maltese-pet-gif-rotation-scope-v2` 标记迁移一次，用户之后改过的不再覆盖。
- 设置页的「轮播范围」面板直接铺出合并后**实际会轮到的全部 GIF 缩略图**（带状态角标），
  默认形象几百张，和主窗口的合并规则完全一致（`rotationFramesForState`）。
- 预加载改成「只提前 4 张」：之前是全量预加载，几百张 GIF 会一次性解码；现在每 10 秒前进一张，
  命中下一张前有 40 秒左右预热，内存占用不随素材数量线性增长。

## 自定义 GIF 仍然可用

设置页「专属形象」卡片现在按形象分开保存：`maltese-pet-gif-rotation:<角色>`。
旧版按状态保存的配置会自动迁移到小白，其他形象第一次使用时直接用素材默认值。

## 微博官方表情包（独立素材池）

`assets/pets/stickers/weibo/` 存了一份从官方微博 [@线条小狗Maltese](https://weibo.com/u/7776232700) 收集的整套表情包：第 1–33 弹加 emoji、漫画、新春、小小狗/小小金毛、补充包等特辑，共 36 组 296 张，已归一化成 240×240、保留透明底的多帧 GIF。

- **按动作分目录**：`weibo/<动作>/<组>-<序号>.gif`，动作名对齐 `assets/pets/chars/` 现有的 `idle / happy / pet / sleep / eat / relax / play / nervous / scared / peek / hide / work / paper / hop / walk`，另按画面补了 6 个新动作名 `angry`、`cry`、`love`、`ride`、`bath`、`costume`，共 21 类。逐张清单见同目录 `by-action.md`。
- 每张还带情绪标签（开心 / 亲昵 / 难过 / 生气 / 惊讶 / 困倦 / 无语 / 害羞 / 进食 / 玩耍 / 中性），清单见 `by-emotion.md`。
- **整库已并入轮播池**：21 类 296 张全部并入 `assets/pets/chars/shared/<动作>/`，随后按角色归位——单只小白 / 小鸡毛回到各自目录，`shared` 只留同框素材（当前 180 张）。默认形象每 3 张本角色图插 1 张同框图，所以官方表情包会自然混进轮播。
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

