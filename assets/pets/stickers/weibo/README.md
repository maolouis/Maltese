# 微博表情包素材：线条小狗 Maltese

从官方微博 [@线条小狗Maltese](https://weibo.com/u/7776232700)（认证：动漫博主）收的整套表情包，2026-11-16 采集：第 1–33 弹加 emoji、漫画、新春、小小狗/小小金毛、补充包等特辑，共 36 组 **296 张**。统一归一化成 240×240 透明底多帧 GIF，**按动作分目录**，目录名与 `assets/pets/chars/` 的动作名对齐。

## 动作分类

| 目录 | 动作 | 张数 |
| --- | --- | --- |
| `idle/` | 发呆/站着 | 61 |
| `happy/` | 开心/欢呼 | 39 |
| `pet/` | 贴贴/被摸 | 38 |
| `sleep/` | 睡觉 | 35 |
| `eat/` | 吃东西 | 21 |
| `love/` | 比心/爱心 | 15 |
| `relax/` | 躺平/休息 | 14 |
| `play/` | 玩闹 | 12 |
| `nervous/` | 紧张/尴尬 | 11 |
| `scared/` | 受惊/害怕 | 9 |
| `angry/` | 生气 | 9 |
| `peek/` | 探头偷看 | 5 |
| `cry/` | 哭 | 5 |
| `work/` | 用电脑/干活 | 4 |
| `hide/` | 躲藏 | 4 |
| `costume/` | 装扮 | 3 |
| `ride/` | 骑车 | 3 |
| `bath/` | 泡澡 | 3 |
| `hop/` | 蹦跳 | 2 |
| `paper/` | 报纸/纸箱 | 2 |
| `walk/` | 走动/奔跑 | 1 |

`angry`、`cry`、`love`、`ride`、`bath`、`costume` 是这次新加的动作名，`assets/pets/chars/` 里原本没有，要在桌宠里真正触发它们，还得在 `src/petCharacters.ts` 的 `STATE_TO_ACTION` 里挂上状态。

## 情绪标签

除了动作，每张还按画面标了情绪（一张取最明显的一种），逐张清单见 [`by-emotion.md`](by-emotion.md)，接口字段是 `index.json` 的 `emotion`。

| 情绪 | 张数 |
| --- | --- |
| 中性 | 99 |
| 亲昵 | 45 |
| 开心 | 43 |
| 困倦 | 39 |
| 进食 | 20 |
| 玩耍 | 16 |
| 惊讶 | 11 |
| 生气 | 9 |
| 无语 | 8 |
| 难过 | 5 |
| 害羞 | 1 |

## 目录结构

```
assets/pets/stickers/weibo/
├── idle/  happy/  pet/  sleep/  eat/  love/  relax/  play/ ...   # 240x240 GIF
├── index.json        # 逐张：动作、情绪、来源帖、帧数、SHA-256
├── by-action.md      # 按动作的逐张清单
├── by-emotion.md     # 按情绪的逐张清单
└── preview.png       # 每类动作一张代表帧
```

文件名 `<组>-<序号>.gif`，组名对应官方帖（`p33` = 第 33 弹，`sp-*` = 特辑），序号是九宫格里的顺序。
官方没在微博单独发帖的弹数（第 6、8、9、10、20 弹）没有收录；第 26、27 弹同帖发布，组名合并为 `p26-27`。

## 怎么用

这些文件目前只是素材，**没有被代码引用**，桌宠当前行为不变。

- 整类接入：把某个动作目录（例如 `sleep/`）里的 GIF 复制进 `assets/pets/chars/xiaobai/sleep/` 或 `shared/sleep/`，再跑 `node scripts/build-pet-manifest.mjs`。
- 按情绪挑图：先看 `by-emotion.md`，再到对应动作目录取文件。
- 新增动作（`angry`、`cry`、`love`、`ride`、`bath`、`costume`）想被桌宠用到，需要同时改 `src/petCharacters.ts` 的映射，否则只是躺着占位。

## 规格

- 画布统一 **240×240**，透明底保留（自带背景的图保持原底），四周留白裁掉后居中；开头/结尾的全透明空帧已剔除。
- 原图多为 1080×1080 多帧 GIF，帧时长与循环沿用原图；个别 GIF 因起始帧与前一帧完全相同会少一帧。
- 素材合计约 29.6 MB。

## 采集与复现

- 帖子与图片来自 `https://m.weibo.cn/u/7776232700` 时间线，遍历 64 页；原图地址是把缩略路径 `/orj360/` 换成 `/large/`。
- 脚本在仓库根目录的 `work/weibo-stickers/`（`work/` 已被 `.gitignore` 忽略）：`bulk.py` 下载/归一化/首次入库，`sheets.py` 出标注拼版，`organize.py` 按动作重组并重写索引与预览。

## 版权

素材版权归 ©MALTESE / 线条小狗官方所有。这里只做本地素材归档；随安装包分发或商用需自行向版权方取得授权。

## 2026-11-17 去重后只保留 9 张

按 sha256 复查：本目录 296 张里 **287 张与 `assets/pets/chars/` 中的文件内容完全相同**（早前归位时已并入三个角色池），
经用户确认已从磁盘删除；**只保留 9 张唯一内容**（`eat/1`、`happy/4`、`nervous/1`、`pet/1`、`scared/1`、`sleep/1`）。
删除清单（路径 + sha256 + 对应保留路径）见仓库根 `work/asset-dedupe-plan.txt`（`work/` 不进版本库）。

`index.json`、`by-action.md`、`by-emotion.md`、`preview.png` 仍记录采集时的完整 296 张（含已删文件路径），用于追溯来源与版权说明。
