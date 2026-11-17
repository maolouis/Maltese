# 聊天表情包预研：生图能力核查与「表情包信使」MVP

> 日期：2026-11-17 · 工作树 HEAD（并行开发中，行号会漂移，引用以符号名为准）
> 用户需求：聊天里让小狗发表情包，利用模型生图能力。
> **结论：本机当前没有可用的生图路径**（Strata 软件支持可选 images 模块，但未安装/未配置；DSH 无生图端点；无 ComfyUI/SD/Ollama）。推荐 MVP 改为「**表情包信使**」：模型输出受控标记，前端从现有 789 张 GIF 素材库挑对应表情内联显示。**复杂度 S（半天到 1 天）**。

## 1. 生图能力核查（读代码 + 只读探测）

| 来源 | 证据（已核实） | 判定 |
| --- | --- | --- |
| **Strata 软件** | `serve/images.py` 明确支持 `POST /v1/images/generations`（Qwen-Image-2.1-Turbo + stable-diffusion.cpp `sd-cli`），但**仅当 run config 有 `images` 段**；本机 `F:\Strata\Strata\launch\ud-q4_k_xl-8k.json` 没有该段 | 代码支持，未启用 |
| Strata 运行态 | `GET http://127.0.0.1:8080/v1/status` → `"image_generation": {"enabled": false}`；`/v1/models` → `"output_modalities": ["text"]` | **无生图** |
| Strata 资产 | `models/qwen36-UD-Q4_K_XL/` 只有文本 GGUF（22.8GB）+ `mmproj-F16.gguf`（视觉输入）；全盘无 `engine-image/sd-cli`、无 `*.safetensors/*.ckpt` diffusion 权重 | 未安装 |
| 显存 | RTX 4070 12GB，`/v1/status` 显示已用 12075 MiB；images.py 的 `gpu_policy=auto` 在放不下时会 `unload` 文本引擎 | 即使装上也需卸载文本模型 |
| **DSH** | `src-tauri/src/dsh_api.rs` 的 `/api/capabilities` 仅列 video 相关 + `/api/pet/action`；无生图端点。`dsh_chat.rs` 只把 CLI stdout 当文本流（`dsh-chat-stream {requestId,text}`） | **无生图** |
| 本机应用 | 无 `ollama/comfy/sd` 命令；卸载注册表无 ComfyUI/SD/Ollama；C/D/E/F 盘根目录无相关目录；Docker 未安装；7860/8188/11434 未监听（仅 8080=Strata） | 无第三方生图 |
| 本地聊天后端 | `local_chat.rs` 走 OpenAI 兼容 `/v1/chat/completions`，`images` 字段是**视觉输入**，不是图片输出；模型输出只有 text | 无生图 |

**结论**：能生图的「代码可能性」存在（Strata 可选 images 模块），但**本机当前不存在可用路径**：没有 images 配置、没有 sd-cli、没有 diffusion 权重；DSH 与本地聊天都只返回文本。用户要的「利用模型生图」现在做不到，除非下载数 GB~十 GB 级 Qwen-Image-2.1-Turbo + sd-cli 并接受文本模型卸载/重载。

## 2. 推荐方案：表情包信使（MVP）

### 2.1 素材与 id 映射（已核实）

- 素材总清单 `PET_CHARACTER_ASSETS` 共 **789** 条：`xiaobai 394 / xiaojimao 233 / shared 152 / stickers 9 / legacy 1`；分组中文名在 `PET_ASSET_GROUP_LABELS`（`petCharacters.ts`）。
- 表情 id 只开放 12 个（都能在当前形象下解析出帧）：`happy, celebrate, love, pet, play, sleeping, eating, chin, peek, cry, angry, relax`。
- 解析链：`sticker id → STATE_TO_ACTION[id]`（`petCharacters.ts`）→ 取帧。优先 `PET_CHARACTER_ASSETS.stickers[action]`（微博表情包，共 9 张：happy 4、pet/eat/sleep 各 1、scared 2），没有再走 `characterFramesForState(petCharacter, id)`（自带 own→stickers/legacy 回退，duo 走 shared→xiaobai）；取首帧或按 `hash(message.id) % min(3, n)` 选一张，**空数组就不显示**。
- 中文别名（提示词与兜底共用）：开心/高兴→happy，庆祝/兴奋→celebrate，比心/爱你→love，摸摸/撒娇→pet，玩→play，困/睡→sleeping，吃/饿→eating，托腮→chin，偷看/好奇→peek，委屈/难过→cry，生气→angry，放松/安静→relax。

### 2.2 提示词约束（只对主聊天调用生效，技能判断不注入）

```
你可以在回复的最后另起一行发 1 个表情包，格式：<sticker:happy>。
id 只能是：happy, celebrate, love, pet, play, sleeping, eating, chin, peek, cry, angry, relax。
必须和这句话的情绪一致；不确定就不发；不要解释标记，不要发多个，标记必须单独一行。
```

- **注入位置**：放在 Rust `persona` 之后（`local_chat.rs` 的 `build_messages`、`dsh_chat.rs` 的 prompt 拼接）。实测两个后端都收不到前端 history 里的 system 消息：`build_messages` 只保留 `user/assistant`；DSH 调用只传 `message/session/character`、不传 history——**只在前端注入指令模型看不到，标记会完全不出现**。
- 为省 token，给两个命令加 `sticker: bool` 参数：主聊天传 `true`，技能判断（`askAgent`/`skillsPrompt`）传 `false`，避免 128 token 的技能判断被额外指令拖慢。
- 首字延迟：指令约 70~90 token；`/v1/status` 实测 prompt 处理 4.78 ms/token → 约 **0.34~0.43s** 额外 prefill，目标 <500ms（DSH 后端另测）。
- 工作树已有一版 `src/chatSticker.ts` 初稿（8 个 id，含 `attention/working`），但它把指令拼进前端 `systemContext`——按上面的实测，两个后端都收不到，标记基本不会出现；落地时应把指令移到 Rust，并建议补 `love/chin/peek/cry/angry/relax` 这些聊天常用情绪。

### 2.3 解析与渲染

- `ChatMessage`（`PetChat.tsx`）加 `sticker?: StickerId`；落盘仍走现有 `MESSAGES_KEY`，旧消息无字段不受影响。
- 最终回复：正则 `/<sticker:\s*([a-z_]+)\s*>/i` 取第一个；校验 allowlist → 记录 `sticker`；用 `/<sticker:[^>]*>/gi` 从 `text` 删除；非法/拼错 **只删标记、不猜、不显示**。
- 流式阶段：`streamingReply` 渲染前同样剥掉完整标记与未闭合的 `<sticker` 尾巴，避免半截标记闪现；表情包在最终消息落库后显示。
- 气泡内渲染：`<img class="pet-chat__sticker" width=96 height=96 loading="lazy" alt="小狗的表情包">`，放在文字上方；点击切换 240px 放大（再点/失焦复原）。`onError` 隐藏该图并清掉 `sticker`，不出现破图。
- 复制按钮仍复制 `message.text`（已不含标记）；不复制图片。

### 2.4 兜底与去重

- 模型没出标记 → 正常文字回复；可选**高精度关键词兜底**（哈哈→happy、晚安/困→sleeping、想你→love、生气→angry），只在无标记且命中时启用，保证「5 条至少 2 条」可验收。
- 连续 3 条不重复：内存保留 `lastStickers[3]`；命中重复时在同族里换（happy↔celebrate、love↔pet、sleeping↔relax），换不到就省略。
- 安全：id 经 allowlist 映射到内部帧，不接受模型给出的路径，杜绝任意文件读取；全程本地，无上传、无额外网络请求。

## 3. 如果将来启用生图（不作为 MVP）

- 调用 `POST /v1/images/generations`（prompt/size/steps/seed/response_format），需先装 Qwen-Image-2.1-Turbo + sd-cli 并写 `images` 配置；服务端一次只跑一个 GPU job，聊天与生图共享 FIFO 队列。
- 本机 12GB 显存被文本模型占满，`gpu_policy` 会卸载文本引擎（会话存盘、下次重载 1~4 分钟）；单张图预计数十秒级，**放在聊天单槽位里会直接卡住对话**。
- 若要接：异步「生成中」占位卡 + 按 prompt/size 哈希缓存到磁盘（限 64 张）+ 内容安全过滤 + 超时降级为纯文字/现成表情包；复杂度 L，不建议进 MVP。

## 4. 文件清单与复杂度

| 文件 | 改动 |
| --- | --- |
| 新增 `src/petStickers.ts` | allowlist、中文别名、`parseStickerMarker()`（返回 `{text, sticker}`）、`stickerFrame(character,id,seed)`、同族替换与 3 条去重、关键词兜底表 |
| `src/PetChat.tsx` | `ChatMessage.sticker`；最终回复解析/剥离；流式剥离；气泡内 96px 内联 GIF + 点击放大；`onError` 清空 |
| `src/PetChat.css` | `.pet-chat__sticker`（96×96、圆角）、放大态、移动端不溢出 |
| `src-tauri/src/local_chat.rs`、`src-tauri/src/dsh_chat.rs` | 新增 `sticker: bool` 参数与约 80 token 指令；仅主聊天注入，技能判断不注入；`build_messages`/prompt 拼接 |
| `src/i18n/locales/zh-CN.ts`、`en.ts`、`i18n/types.ts` | 表情包 alt/aria、放大提示（默认中文即可，设置窗部分未 i18n） |
| `README.md`、`docs/pet-chat.md` | 功能说明、隐私口径（本地素材、不上传、不生图） |
| `tests/pet-stickers.test.mjs` | 解析/剥离/别名/非法 id/空帧/去重/兜底 单测 |

复杂度 **S**（半天到 1 天）：无新依赖、无模型调用、无后端推理；Rust 只加提示词与参数。

## 5. 验收判据

| 场景 | 判据 |
| --- | --- |
| 连续发 5 条普通聊天 | ≥2 条带表情包；表情与文字语义一致（人工抽 10 条，≥8 条认可） |
| 标记不合法/拼错（人工注入 20 次） | 文本里不残留 `<sticker:...>`；不显示任何图；不报错 |
| 连续 3 条回复 | 不出现同一个 sticker id；同族替换生效 |
| 破图 | 全部素材路径可加载；`onError` 时图消失、气泡高度不塌陷 |
| 首字延迟 | 同一后端对比改动前，首个 token 延迟增加 <500ms（本地约 +0.4s） |
| 技能判断 | 带 `sticker:false` 的调用不出现标记、不增加明显延迟 |
| 持久化/刷新 | 刷新后历史消息的表情包仍在；旧消息无字段正常渲染 |
| 离线/隐私 | 断网可用；不新增网络请求；不上传聊天内容 |

## 6. 参考（符号名）

- 素材：`src/petCharacters.ts`（`PET_ASSET_GROUP_LABELS`、`STATE_TO_ACTION`、`characterFramesForState`、`petAssetTotalCount`）、`src/petCharacterAssets.generated.ts`
- 聊天：`src/PetChat.tsx`（`ChatMessage`、`MESSAGES_KEY`、`persist`、`streamingReply` 渲染）、`src-tauri/src/local_chat.rs`（`persona`、`build_messages`）、`src-tauri/src/dsh_chat.rs`（`persona`）
- 生图核查：`E:\Maltese\work\strata-control-extract\serve\images.py`、`serve\server.py`（`/v1/images/generations`、`image_generation`）、运行态 `/v1/status`、`/v1/models`
- DSH：`src-tauri/src/dsh_api.rs`（`/api/capabilities` 端点清单）