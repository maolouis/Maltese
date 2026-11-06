# 桌宠形象：小白 / 小鸡毛 / 两只一起

Maltese 现在支持 LineDogPet 的两只小狗形象，并把「两只同框」的共享素材也接了进来。

## 素材来源

从 `E:\LineDogPet\LineDogPetv2.8.3\pets` 复制到 `public/assets/pets/chars/`：

```
public/assets/pets/chars/
├── xiaobai/    小白，20 个动作、254 张 GIF
├── xiaojimao/  小鸡毛，18 个动作、151 张 GIF
└── shared/     两只小狗同框，14 个动作、90 张 GIF（不是可选角色）
```

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

## 自定义 GIF 仍然可用

设置页「专属形象」卡片现在按形象分开保存：`maltese-pet-gif-rotation:<角色>`。
旧版按状态保存的配置会自动迁移到小白，其他形象第一次使用时直接用素材默认值。
