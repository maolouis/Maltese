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

抱起、转圈这两个招牌动作固定用 `shared` 里指定的那一张
（`举起来.gif`、`转圈.gif`）；追逐固定用 `xiaojimao/chase/狂奔.gif`，
和 LineDogPet 的手感一致。

## 同框素材什么时候出现

默认角色在某个动作里有同框素材时，按「每 3 张本角色图插 1 张同框图」的比例混进轮播，
比 LineDogPet 的 35% 概率更容易观察到，也不至于抢戏。

每个状态最多轮播 30 张：素材池里有的动作有 100 多张 GIF，全部预加载会吃掉几十 MB 内存，
所以按均匀间隔抽一批，本次运行保持不变；设置页的「全选」仍然可以拿到完整素材池。

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
- **整库已并入轮播池**：21 类 296 张全部并入 `assets/pets/chars/shared/<动作>/`，随后按角色归位——单只小白 / 小鸡毛回到各自目录，`shared` 只留同框素材（当前 152 张）。默认形象每 3 张本角色图插 1 张同框图，所以官方表情包会自然混进轮播。
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

