# 桌宠聊天（DSH / 本地模型）

展开岛屿后切到「聊天」，可以选择两种后端：

- **DSH**：通过本机 DSH CLI 的 `headless` profile 对话，复用已保存的会话。
- **本地模型**：连接 Strata、Ollama、LM Studio、llama.cpp 等服务的 OpenAI Chat Completions 接口。Strata 是当前桌宠的推荐本地后端。

聊天记录保存在浏览器 `localStorage`（`focusd-island-pet-chat-messages`），DSH 会话 id 保存在 `focusd-island-pet-chat-session`；点右上角垃圾桶会清空这两项。模型后端配置保存在 `maltese-local-chat-settings`，两种后端共用同一份聊天记录。每次请求还会带上当前桌宠形象（小白 / 小鸡毛 / 两只一起），所以切换形象后，新回复会使用对应的性格。

## 聊天没反应？先看模型加载状态（排查第一步）

本机 Strata 默认是 **`lazy_load`**（`serve/runconfig.py:38`）：**进程在跑 ≠ 模型已加载**，
`GET /v1/models` 的 `status.value` 会长时间是 `unloaded`，此时发消息会很久没有任何事件。

1. 查状态：`curl http://127.0.0.1:8080/v1/models`，看 `data[0].status.value`（`loaded` / `unloaded`）。
2. 立刻加载：`curl -X POST http://127.0.0.1:8080/load -H "content-type: application/json" -d "{}"`
   （实测冷加载约 26–32s，热加载约 8s）。
3. 重启 Strata：`powershell -ExecutionPolicy Bypass -File F:\Strata\bin\start-qwen36.ps1`
   （端口占用时它只进监控；先关掉 Strata 窗口或 `POST /stop` 再启动）。
4. 空闲卸载：`serve/server.py:4866` 里 `idle_unload_s` 默认 **0 = 从不在空闲后卸载**；
   只有预设里显式配了才会卸。

我们自动做的（不需要用户操作）：
- 打开聊天 / 发送前调用 `ensure_local_model`：发现 `unloaded` 就先 `POST /load`，
  再**每 2s 轮询到 `loaded:true`，上限 240s**；加载期间气泡显示「正在加载本地模型…（已 Ns）」，
  可点「停止生成」取消；
- 聊天打开期间每 4 分钟一次心跳保活，防止预设里配了 `idle_unload_s` 时被卸载；
- 每次 ensure / 加载结果写入 `%APPDATA%\com.maolouis.maltese\local-model.log`，排查时先看它。

## 头像

小狗回复的每一行左边都带当前形象的头像，标题栏和空状态也用同一张；切换形象后立即跟着换。

- 三张头像是从对应角色的 GIF 里截的正面帧，统一裁成 160×160 透明 PNG，放在 `assets/pets/avatars/{xiaobai,xiaojimao,duo}.png`（会随 `assets/pets` 一起打进安装包）。
- 解析走 `src/petAvatars.ts` 的 `petAvatarUrl()`，与 GIF 同一套资源目录逻辑，开发 / 安装路径都能加载。
- 想换头像：直接替换同名 PNG 即可（建议方形、透明底）；小鸡毛和小白各自的头像互不影响。

## 主动聊天（会弹气泡）

在设置 →「感知与陪伴」或独立设置窗口「陪伴与感知」里打开「让模型观察并主动找你聊天」，再选方式和间隔（5–240 分钟，默认 30）。

两种方式：

- **定时**（默认）：每隔设定分钟数说一次。
- **跟随状态**：只有情境变化时才说。「情境」= 前台程序类型 + 是否在播放媒体 + 是否离开电脑（闲置超过 10 分钟）。
  - 情境一变只更新计时，不立刻说话；
  - 新情境稳定 **3 分钟**后才可能开口，避免频繁切应用时不停打扰；
  - 同一个情境只主动说一次；两次之间至少有「最短间隔」（即上面那个分钟数）的冷却。

- 到点且小狗处于**挂机（收起态）**时，读取前台程序、正在播放的音乐、系统闲置时长和当前时间，交给当前后端（本地模型 / DSH）生成一句不超过 30 字的中文关心。
- 生成后弹出只显示正文的云朵聊天气泡，同时写入聊天记录 `focusd-island-pet-chat-messages`，下次打开聊天能看到这句话。情绪由现有 GIF 和互动场景表达，不再用「小狗想你了」类标题表达情绪。
- 面板展开或正在聊天时本轮跳过，等回到挂机状态再说，避免打断。
- 模型未配置、调用失败或返回空内容时，用按时间段准备的本地兜底台词，保证气泡照常出现。
- 主动聊天提示词会按当前形象加入《亲爱的小狗》的故事语气。小白是安静细心、略害羞的白色马尔济斯，小鸡毛是活泼黏人、带一点贪吃和撒娇的金黄色小金毛；选择两只一起时保留一静一动的陪伴感。模型不可用时，兜底台词也按形象切换。
- 模型可在正文后附 `[情绪:陪伴]` 或 `[互动:踢球]` 标记。程序会把标记转换为白名单互动，并从气泡正文中移除。没有标记时按前台活动和正文关键词推断情绪。
- 计时基准只在第一次进入挂机时记录；切歌、开关面板等状态变化不会重置它（早期版本会，导致主动聊天几乎不会触发）。

## 《亲爱的小狗》的设定取用

本轮语气调整参考公开书介。故事集把小白和小鸡毛写成白色马尔济斯与金毛组成的好朋狗，内容围绕四季里的日常陪伴、无声默契、寻找幸福和与伙伴互动展开。实现只提取人物关系与情绪方向，不复述具体篇章，主动聊天仍以用户当前窗口、音乐和闲置状态为主要依据。

参考来源：[治愈系顶流来袭！线条小狗首部漫画萌化全宇宙！](https://www.sohu.com/a/894795117_121124734)

## 切换本地模型

1. 打开 **聊天**，点击右上角的模型设置按钮。
2. 选择「本地模型」。
   接口地址和模型名称**默认都是空的**——本地服务是每台机器自己装的，程序不预填任何地址或模型名；
   点下面的 Ollama / LM Studio / Strata 预设按钮可以一键填好地址。
3. 填写接口地址和模型名称：
   - **Strata**：点击「Strata」预设，地址为 `http://127.0.0.1:8080/v1`，模型通常是 `qwen3.6-35b-a3b-ud-q4_k_xl`。点击「启动 Strata」可以从桌宠内启动 F 盘部署。
   - **Ollama**：`http://127.0.0.1:11434/v1`，模型例如 `qwen2.5:7b`
   - **LM Studio**：`http://127.0.0.1:1234/v1`，模型用 LM Studio 里加载的名称
   - **llama.cpp server**：`http://127.0.0.1:8080/v1`，模型名按服务端 `--model` 配置填写
4. 点「测试连接」，服务返回模型列表后会显示连接成功，并把模型列表加入输入建议。
5. 发送消息即可。API Key 通常留空；服务开启鉴权时再填。

设置里的「生成参数」会随本地请求发送 `max_tokens`、`temperature`、`top_p`、`enable_thinking`。启用流式输出后，Strata 会通过 SSE 将增量 token 直接显示在桌宠聊天气泡中。

图片按钮位于聊天输入框左侧。图片会以 OpenAI `image_url` 内容块发送给本地服务。当前多模态路径面向本地模型，DSH 后端会提示切换到本地模型。Strata 的 Qwen3.6 部署使用 CPU 视觉编码器，避免从 12 GB 显存中的专家缓存再分配约 1.4 GB。

接口地址可以只填服务根地址（如 `http://127.0.0.1:11434`），程序会自动补齐 `/v1/chat/completions`；也可以填完整的 `/v1/chat/completions` 地址。

## 本地模型工作方式

- 前端 `src/PetChat.tsx` 调用原生命令 `local_chat_stream`，传入当前文本、最近 16 条消息、接口地址、模型名、当前形象、生成参数和可选图片。关闭流式输出时回退到 `local_chat`。
- Rust `src-tauri/src/local_chat.rs` 向 `POST <base>/v1/chat/completions` 发送 OpenAI 兼容请求，流式响应通过 `local-chat-stream` 事件逐段转发给前端；连接超时为 25 秒，请求超时为 180 秒。
- 每次请求会带当前形象的桌宠 system prompt，并要求用简体中文、1 到 3 句话回答。小白的设定是安静温柔、细心、略害羞；小鸡毛的设定是活泼、贪吃、爱撒娇；两只一起时，模型必须分别用「小白：」和「小鸡毛：」各说一句，同时保持一静一动的陪伴关系。
- 「测试连接」调用 `local_chat_models`，读取 `<base>/v1/models`；只用于展示模型列表，不会保存服务返回的其他内容。
- 「启动 Strata」调用 `strata_launch`，执行带有 Qwen3.6 参数的官方启动命令：

  ```text
  F:\Strata\bin\strata.cmd launch --family qwen36 --model ud-q4_k_xl --context 8192 --vision cpu --mtp on --tune skip --access local --port 8080 --restart --no-tui --yes
  ```

  启动完成后，桌宠还会把 Strata 的共享 Chat 设置固定为关闭思考、`max_tokens=256`、`temperature=0.7`、`top_p=0.9`，避免 Strata 网页端遗留的高思考预算拖慢桌宠。该启动器也会设置 Strata 的 F 盘数据目录。
- 接口只接受 `http` / `https`。请求从本机直接发到配置的地址，不经过 DSH 或 Maltese 的服务器。

## Strata 运行路径与 GPU 调度

- 控制脚本和 Python 服务位于 `E:\Maltese\work\strata-control-extract`，F 盘启动器是 `F:\Strata\bin\strata.cmd`。
- 模型文件位于 `F:\Strata\models\qwen36-UD-Q4_K_XL`，tokenizer 位于 `F:\Strata\packs\qwen36-ud-q4_k_xl\tokenizer`，启动配置位于 `F:\Strata\Strata\launch\ud-q4_k_xl-8k.json`。
- CUDA engine 位于 `F:\Strata\components\engine\0.1.58-windows-x86_64-cuda-cuda13\strata.exe`，视觉投影文件 `mmproj-F16.gguf` 由 CPU 视觉进程读取，避免占用专家缓存显存。
- 当前启动参数是 `--max-context 8192 --prefill auto --mtp 2 --vision`。Qwen3.6 的 engine 会把 dense 权重和一部分热门专家放入 RTX 4070 显存，其余专家放入 pinned host memory，再由 CPU worker 与 CUDA kernel 交错处理。
- 当前 12 GB 显卡的官方自动布局稳定地放入约 26 个专家、约 1.90 GiB 专家缓存。Qwen3.6 engine 不接受通用 `--expert-cache`，显式提高 `--expert-vram` 或 `--expert-slots` 在本机测试会触发 pinned host memory 分配失败，所以保留自动布局。
- `/health` 当前报告上下文上限 8192，视觉服务已开启。运行日志在 `F:\Strata\Strata\launch\ud-q4_k_xl-8k.engine.log`，可用 `strata monitor --url http://127.0.0.1:8080` 查看实时状态。

## DSH 工作方式

- 前端 `src/PetChat.tsx` 调用原生命令 `dsh_chat`，传入用户文本、当前形象和可选 `sessionId`。
- Rust `src-tauri/src/dsh_chat.rs` 启动：

  ```text
  dsh.cmd --patch <headless-credentials.yml> --profile headless --json [--session-id <id>] <prompt>
  ```

  `--patch` 必须放在 profile 名之前，否则会被 headless 当成未知 app 参数。命令用 `CREATE_NO_WINDOW`，不弹终端，120 秒超时。

- 默认 headless profile 关闭了 `credentials`、`authorization`、`deepseek-account` 模块。首次调用时在应用数据目录写入 patch 文件，让 headless 读到 DSH 已保存的凭据；不复制、不打印、不上传密钥。
- patch 里还会把默认模型指到 `provider: deepseek-account` + `model: deepseek-flash`。headless 默认的 `deepseek-official` 路由需要 `DEEPSEEK_API_KEY`，没配过的机器会直接报 `MISSING_CREDENTIAL`，聊天完全用不了；改用桌面端登录后的账号路由即可正常对话。
- 解析 NDJSON：`session` 取 `sessionId`，`final` 取最终文本；没有 `final` 时回退到最后一个 `text`。空回复会报错，由界面显示。
- `sessionId` 让 DSH 复用同一会话；CLI 返回新 id 时前端自动更新。会话不存在等错误由后端清空 id 后重试一次。

## 形象与聊天提示词

- `src/petCharacters.ts` 是前端唯一的形象来源，`usePetCharacter()` 将当前选择同步到聊天组件。
- `src-tauri/src/dsh_chat.rs` 和 `src-tauri/src/local_chat.rs` 各自根据 `character` 生成 system prompt；未知值回退到小白，避免旧客户端或异常调用导致聊天不可用。

## 配置覆盖

| 变量 | 作用 |
| --- | --- |
| `MALTESE_DSH_CLI` | 指定 `dsh.cmd` 绝对路径，优先于自动探测 |
| `MALTESE_DSH_CHAT_PATCH` | 指定凭据 patch 文件，跳过自动生成 |

自动探测顺序：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`、`E:\dsh\resources\runtime\cli\bin\dsh.cmd`、`C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。

## 边界

- DSH 需要本机已安装并登录；本地模型需要对应的本地服务已启动。连接失败时聊天页会显示具体地址和错误，不影响宠物其他功能。
- DSH 的消息会发送给其当前配置的模型提供方；本地模型的消息只发送到填写的地址。
- 本地模型的 API Key 只保存在本机 `localStorage`，请求时通过 `Authorization: Bearer` 发给配置的服务；不会上传到 GitHub 或 Maltese 服务器。
- 本功能不注入 DSH GUI 进程，也不依赖 GUI 是否打开。


## 2026-11-14 小狗技能扩展（六项）

新增/调整的技能动作（`src/petSkills.ts`，默认全部开启，可在技能设置里关）：

| 动作 | 用途 | 触发话术示例 |
| --- | --- | --- |
| `todo_start` | 开始给待办计时，没有这条待办就新建；其它进行中的待办自动暂停 | 「我要开始学雅思口语」 |
| `todo_pause` | 暂停计时并累计时长 | 「休息一下」「暂停雅思」 |
| `diary_add` | 写进今天的时间线日记 | 「记一下今天…」 |
| `diary_read` | 读出今天记了什么 | 「今天都记了什么」 |
| `music_play` | 播放系统当前播放器；一个播放器都没有时尝试唤起音乐软件 | 「帮我播放音乐」 |
| `open_app` | 改为「开始菜单应用 + 桌面/开始菜单 exe、lnk」双通道匹配打开 | 「打开微信」 |
| `pet_settings` | 调整小狗自己的设置，目前支持形象（小白/小鸡毛/双狗） | 「换成小鸡毛」 |
| `web_search` | 联网搜资料，再由模型整理成回答 | 「帮我查一下…」 |

实现要点：

- 待办/日记直接写主窗口同一份 localStorage（`focusd-island-todos`、
  `focusd-island-active-todo`、`focusd-island-diary-events`），并派发
  `maltese-todos-updated` / `maltese-diary-updated`；`App.tsx` 监听这两个事件即时刷新，
  因为之前同窗口写入不会触发 `storage` 事件，技能改了数据面板却不动。
- `web_search` 是新增 Rust 命令（`src-tauri/src/web_search.rs`）：DuckDuckGo HTML 版优先、
  Bing 兜底，只取标题/链接/摘要，过滤广告跳转位；不依赖任何 API Key。
- **DSH 后端也能用技能了**：之前技能决策只在 `backend === "local"` 时执行，默认 DSH 下技能形同虚设。
  现在决策与总结都按当前后端走（DSH 用 `sessionId: null` 的独立短会话，不污染聊天上下文），
  决策失败会自动退回普通聊天。


## 2026-11-17 聊天「卡死」修复

现象：聊天发消息后长时间没有回复，像卡死。

原因有两个，叠加放大：

1. `dsh_chat` 原来是等整个 `dsh --profile headless --json` 进程退出后才把文字返回前端，
   模型慢时中间完全没有任何输出。实测一次最简回复约 7.5 秒，长回复更久。
2. 上一轮技能扩展让**每条消息**都先跑一轮完整的技能判断（DSH 下同样要走一次 CLI），
   等于回复前白等一轮，两轮串联就是十几秒无反馈。

修复：

- `src-tauri/src/dsh_chat.rs`：逐行读取 dsh stdout，`type:"text"` 事件通过
  `dsh-chat-stream`（`requestId` + `text`）实时推给前端；`dsh_chat` 新增可选 `request_id`，
  不传则保持旧的非流式行为（主动聊天等调用方不受影响）。120 秒硬超时保留。
- `src/PetChat.tsx`：DSH 回复改为监听 `dsh-chat-stream` 边收边显示；
  技能判断加了关键词门禁（开始/暂停/记一下/播放/打开/查一下…才触发），
  并给判断 20s、总结 25s 的超时，超时或失败一律退回普通聊天，不再阻塞回复。

注意：在本机沙箱里直接跑 dsh CLI 会报 `EPERM ... .dsh/profiles/headless/cordis.yml`，
那是沙箱可写目录限制，不是应用故障；沙箱外运行正常。

## 小狗状态 / 近期互动接入模型上下文（2026-11-17）

- 数据源：`localStorage["maltese-pet-vitals"]`（dev-shell 的 vitals 落盘），防御式读取：
  缺字段或损坏返回 null，不抛错、不阻塞聊天；不读取聊天正文，互动描述只来自 `lastAt` 时间戳。
- 聊天：`PetChat.tsx` 把状态拼成一条 **system 消息**放进历史，不污染用户消息：
  `【小狗现在】体力 32（有点累）、情绪 78（心情不错）、亲密 64（很黏你）、专注 20`
  `【最近的互动】3 分钟前被摸头；刚刚被喂食`
  再附一句行为约束（体力低 → 更安静/撒娇；情绪高 → 更活泼）。总长度 **≤120 字**，
  放不下时先丢互动行，保证不拖慢首字。无状态时整段不注入。
- 主动消息：`ProactiveContext` 新增可选 `vitals` / `recentInteractions`；`buildPrompt`
  在「已知信息」里加一行「它现在的状态：…」。**没有数据时提示词与旧版逐字一致**
  （`tests/pet-context.test.mjs` 用改动前的 `buildPrompt` 输出做基线断言）。
- 低体力时主动消息优先「累/困/趴」类台词与 `care/empathy/self` 角度。
- 模型忙碌态：聊天气泡在 3s 后显示「小狗在加载模型或思考，稍等（Ns）」+「停止生成」
  （把「加载/思考/等待」变成可见文案；表情状态映射需要 App 侧接线，由 dev-shell 提供）。
- 单测：`tests/pet-context.test.mjs` 6 条（旧提示词逐字一致、状态摘要与 120 字上限、
  行为约束分档、互动描述来自 lastAt、损坏存储容错、低体力台词/角度）。

## 聊天超时与自检（2026-11-17 实测修正）

本机 Strata 实测（`scripts/probe-chat.mjs`）：流式关思考首个正文 0.4–17s；思考标准
首个正文 **25–45s**；带 vitals system 注入首个正文 **44.9s**；非流式 128 token 55s。
因此旧的「首字 8s / 总 60s」会把正常但慢的请求全部误杀（用户表现：完全没回复→报错）。

当前分级：

| 档位 | 首字（无任何事件） | 总上限 | 空窗中止 |
| --- | --- | --- | --- |
| 关 / 浅 | 15s | 120s | 20s |
| 标准 / 深 | 25s | 120s | 20s |

- 判断逻辑 `shouldAbortStream`：**只要还有事件（reasoning/delta/progress）就不算卡死**；
  已开始输出的请求不会被「首字慢」误杀，只看 20s 空窗和 120s 总时长；
- 失败链：模板拒绝注入 → 去注入重试；流式失败 → **退回非流式**再试一次；
  仍失败才报错（中文原因 + 重试按钮），并把完整错误对象 `console.error("[chat] error", {code, raw, error})`；
- 非流式只有 120s 总时长兜底（本机 55s 属正常）；
- 一键自检：`node scripts/probe-chat.mjs`（打印首字/总耗时/finish_reason/content 长度/是否只有 reasoning）。

## 聊天里的「小狗状态条」（2026-11-17）

- 聊天头部下方一行 ≤28px：`体力 32 · 情绪 78 · 亲密 64 · 专注 20`，点一下折叠/展开
  （折叠状态存 `maltese-pet-statebar-collapsed`）；
- 没有 `maltese-pet-vitals` 或设置里 `petVitalsEnabled=false` 时整行不渲染，聊天布局不变；
- 忙碌时右侧显示「小狗在加载模型或思考… Ns」+ 呼吸小点（数据来自现有 `waitSeconds`）；
- 阈值跨越（体力跌破 35 / 情绪升过 75）在聊天里插一条灰色小字「（小白看起来有点累了）」，
  每 10 分钟最多一次、去重，**不写进消息、不发给模型**；
- 单测：`tests/pet-state-bar.test.mjs` 6 条（文案/显隐/阈值/节流/折叠容错/忙碌文案）。

## 模型「未加载 / 单槽位排队」导致的「完全没回复」（2026-11-17 实机取证）

实机抓到用户看到的那句报错原文与错误码（持久化在 `localStorage["maltese-chat-last-error"]`）：

```
{"code":"CHAT_UNKNOWN","raw":"Error: 模型中途 20 秒没有新内容，已停止。","at":...}
{"code":"CHAT_TIMEOUT","raw":"Error: 模型中途 45 秒没有新内容，已停止。","at":...}
```
UI 显示：`模型响应超时，已停止。首次加载会比较慢，稍后重试或调浅思考。`（带「重试」按钮）

真正原因（本机 Strata 实测）：
- 端口活着 ≠ 模型可用：`GET /health` 会出现 `"loaded": false`，此时 `/v1/chat/completions`
  会先**加载模型**，期间长时间没有任何 SSE 事件；旧的前端看门狗把它当成「卡死」取消。
- 单槽位：`/slots` `is_processing: true` 时新请求排在队头后面，同样长时间无事件。

修复：
- `local_chat.rs::ensure_local_model` 现在会检查 `/v1/models` 的 `status.value`：`unloaded` 时
  先发一次 `max_tokens:1` 的极短补全把模型**预热**（最多 240s），前端发送前等待它完成；
  打不开聊天也会在后台预热。
- 前端看门狗：**没有任何事件时不中止**（只提示「排队 / 模型忙」），开始输出后才按 45s 空窗判卡死，
  总上限 180s；错误映射新增 `CHAT_MODEL_NOT_READY` / `CHAT_BUSY` / `CHAT_BACKEND_ERROR`。
- 失败时把完整错误对象写 `console.error` 并持久化到 `maltese-chat-last-error`（不含聊天正文），
  方便下次直接取证。

## 本地模型一直是 `loaded:false`：Strata 的 lazy_load 与 /load（2026-11-17 定案）

用户实测 `http://127.0.0.1:8080/health` 一直 `loaded:false`，等不来。只读排查结论（`E:\Maltese\work\strata-control-extract`）：

- `serve/runconfig.py:38` → `lazy_load`：「Start without loading the model; the first request loads it (text only)」。
  这台机器的 Strata 是 lazy 启动：**进程在跑 ≠ 模型已加载**，`/v1/models` 的 `status.value` 长时间是 `unloaded`。
- `serve/server.py:4866` → `idle_unload_s = 0`（默认 0 = 从不在空闲后卸载）；只有显式配置/`--idle-unload`
  才会卸载。所以「加载后又被卸载」只在预设里设过 `idle_unload_s` 时才发生。
- `serve/server.py:8228` → `POST /load`：「load now, e.g. ahead of a request」，本地控制请求可用；
  实测 `POST /load` 返回 200，从 unload 到真正 `loaded:true` 冷加载约 **26s**（我们机器）。

我们做的：
- `ensure_local_model(base_url, model)`：读 `/v1/models` 判断 `status.value`；不是 `loaded` 就先 `POST /load`，
  然后**每 2s 轮询 `/v1/models` 直到 `loaded:true`，最多 240s**（只有真加载好才返回 true）。
- 前端：打开聊天即后台预热；发送前等待预热完成，期间气泡显示
  「正在加载本地模型…（已 Ns，首次约 1–4 分钟）」+「停止生成」；加载失败给中文原因
  「模型没能加载：请检查 Strata 是否在运行、显存是否够」。
- 保活：聊天打开期间每 4 分钟轻触一次 `ensure_local_model`，防止预设里配了 `idle_unload_s` 时被卸载。

手动排查/恢复：
1. `curl http://127.0.0.1:8080/v1/models` 看 `status.value`（`loaded` / `unloaded`）。
2. 想立刻加载：`curl -X POST http://127.0.0.1:8080/load -H "content-type: application/json" -d "{}"`。
3. 想彻底重启：`powershell -ExecutionPolicy Bypass -File F:\Strata\bin\start-qwen36.ps1`
   （端口占用时它只进监控；先 `curl -X POST http://127.0.0.1:8080/stop` 或关掉 Strata 窗口）。

## 停止加载 / 错误文案统一（2026-11-17）

- 「正在加载本地模型…」阶段点「停止生成」：前端调用 `local_model_load_cancel(token)`，
  Rust `ensure_local_model` 每 2s 检查取消登记表，取消后**立即返回 `Err("已停止")`**，
  不再 `POST /load` 轮询到 240s、也不会在后台偷偷出结果；下一次发送会自动清掉旧 token。
- 三类失败统一成同一句可操作文案：`CHAT_MODEL_NOT_READY` / `CHAT_BACKEND_DOWN` /
  「连不上」都显示「模型没能加载：请检查 Strata 是否在运行、显存是否够，或聊天设置里的地址是否正确。」
  + 「重试」按钮；用户主动停止映射为 `CHAT_STOPPED`（「已停止生成。想继续可以点「重试」或再说一句。」）。
- 日志：`%APPDATA%\com.maolouis.maltese\local-model.log` 会记录 `ensure: call` / `loaded after N ms` /
  `cancelled by user` / `load timeout`，排查先看它。

## 字体与 emoji 回退链（2026-11-17）

聊天主字体是像素字 **Fusion Pixel**，它没有彩色 emoji 字形。现在聊天容器/气泡/输入框/
思考面板/状态条统一使用这条回退链（`src/PetChat.css` 末尾）：

```
"Maltese Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Nirmala UI",
"Fusion Pixel", "Microsoft YaHei", "Segoe UI", sans-serif
```

- `Maltese Emoji` 是 `App.css` 里用 `unicode-range` 指向系统彩色 emoji 的 `@font-face`；
- 颜文字里的卡纳达/组合符号（`ಥ`、`•̀`）靠 `Segoe UI Symbol` / `Nirmala UI` 兜底；
- 中文正文仍由 Fusion Pixel 渲染，观感不变；
- 如果仍有方块：确认系统里有 `Segoe UI Emoji`（Windows 自带），或用浏览器 devtools 看
  该字符命中了哪个字体（Computed → Rendered Fonts）。

## 表情包信使（sticker 标记）

本机没有可用的生图路径（预研：`docs/research-chat-sticker.md`），聊天表情包走「模型输出标记 →
前端从既有素材库取 GIF」：

- **指令在 Rust 侧 persona 注入**（前端 system 消息会被 `build_messages` 过滤掉，模型看不到，
  所以不能放前端）：
  - `src-tauri/src/local_chat.rs`：`sticker_instruction()` + `build_messages(..., sticker)`；
    命令 `local_chat` / `local_chat_stream` 新增 `sticker: Option<bool>`。
  - `src-tauri/src/dsh_chat.rs`：`STICKER_INSTRUCTION` + `dsh_chat` / `chat` 的 `sticker` 参数。
  - 只有正常聊天传 `sticker: true`；技能判断/工具调用/摘要传 `false`，避免污染动作决策。
- **标记格式**：回复末尾单独一行 `<sticker:表情>`，最多一个；表情只能取：
  `happy` `celebrate` `love` `pet` `play` `sleeping` `eating` `chin` `peek` `cry` `angry` `relax`。
- **渲染**：`src/chatSticker.ts` 解析并从正文移除标记；`PetChat` 用 `stickerPoolOrder`
  依次尝试「微博 stickers 池（happy/pet/eating/sleeping）→ 当前角色动作 → duo 回退 shared→xiaobai」，
  找到 GIF 后 96×96 圆角内联显示，点击放大；取不到素材或图片 `onError` 时静默隐藏（绝不显示破图）。
- **去重**：连续 3 条消息不重复同一 sticker（重复则这次不显示）。
- **持久化**：消息记录新增可选 `sticker` 字段；旧记录没有该字段照常渲染。
- **调试取证**：最近 10 次解析结果写到 `localStorage["maltese-chat-sticker-debug"]`
  （只存 id、时间和模型原文末尾 80 字，便于确认标记来自模型）。

## 排队与超时分级（2026-11-18）

单槽位模型（Strata 默认 1 个槽）下，连发消息时第二条会在后端排队，**期间没有任何 SSE 事件**；
旧逻辑把「没有事件」一律当超时（45s 空窗），于是第二条消息必现 `CHAT_TIMEOUT`。

三态判定：
- **排队中**：还没有任何事件，且后端 `GET /slots` 的 `is_processing=true`（或拿不到状态时，
  发请求后 3s 无事件即视为排队）。UI 显示「前面还有请求，排队中…（已 Ns）」，**不中止**；
  排队上限 240s，超过后报 `CHAT_QUEUED`（不是超时）。
- **加载中**：模型 `loaded:false` 时由 `ensure_local_model` 先 `POST /load` 并轮询，
  UI 显示「正在加载本地模型…（已 Ns）」，同样不中止。
- **已开始输出**：收到正文或 reasoning 事件后，才启用 **45s 空窗**判定 → 触发才是
  `CHAT_TIMEOUT`（「已经输出了一部分但中途 45 秒没有新内容」）。总上限 300s。

多入口（岛内聊天 + 固定标签页聊天）同时发：requestId 各自独立，取消登记表按 id 成对登记/取出，
不会互相误杀；同一窗口忙时连发走**客户端发送队列**（气泡显示「已排队 N 条，等前面回答完就发…」），
前一条结束后自动发下一条。

`GET /slots` 取不到时退化为「3s 无事件即显示排队提示」，只是提示，不影响最终是否中止。

## 表情包消息（2026-11-18 调整）

- 模型输出 `<sticker:x>` 后**拆成两条消息**：文字消息（去掉标记；若文字为空则只产生下面那条）
  → 独立的 `kind:"sticker"` 消息（只有 GIF，不带文字）。顺序固定「文字 → 表情包」。
- 兼容：旧记录没有 `kind`、`sticker` 内联在文字消息里的，照旧内联渲染。
- 尺寸：内联 144–160px（最小 128、最大 180；源 GIF 小于 128 时按自然尺寸渲染，不拉伸），
  圆角 12、与文字间距 ≥8px、淡阴影；点击放大到 **窗口 60%**，点任意处或 Esc 关闭。
- 兜底：模型没给标记且当前**体力 < 35** 时，用 `pickStickerForVitals`（dev-shell 的 vitals 权重表）
  从白名单里挑一个安静表情（`avoid` 最近 3 条，避免重复）；其他状态不自说自话补表情。
- 调试：`localStorage["maltese-chat-sticker-debug"]` 记录最近 10 次解析（id + 模型原文末尾），
  用来确认标记确实来自模型。
