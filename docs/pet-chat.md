# 桌宠聊天（DSH / 本地模型）

展开岛屿后切到「聊天」，可以选择两种后端：

- **DSH**：通过本机 DSH CLI 的 `headless` profile 对话，复用已保存的会话。
- **本地模型**：连接 Strata、Ollama、LM Studio、llama.cpp 等服务的 OpenAI Chat Completions 接口。Strata 是当前桌宠的推荐本地后端。

聊天记录保存在浏览器 `localStorage`（`focusd-island-pet-chat-messages`），DSH 会话 id 保存在 `focusd-island-pet-chat-session`；点右上角垃圾桶会清空这两项。模型后端配置保存在 `maltese-local-chat-settings`，两种后端共用同一份聊天记录。每次请求还会带上当前桌宠形象（小白 / 小鸡毛 / 两只一起），所以切换形象后，新回复会使用对应的性格。

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
