# 桌宠聊天（DSH / 本地模型）

展开岛屿后切到「聊天」，可以选择两种后端：

- **DSH**：通过本机 DSH CLI 的 `headless` profile 对话，复用已保存的会话。
- **本地模型**：连接 Strata、Ollama、LM Studio、llama.cpp 等服务的 OpenAI Chat Completions 接口。Strata 是当前桌宠的推荐本地后端。

聊天记录保存在浏览器 `localStorage`（`focusd-island-pet-chat-messages`），DSH 会话 id 保存在 `focusd-island-pet-chat-session`；点右上角垃圾桶会清空这两项。模型后端配置保存在 `maltese-local-chat-settings`，两种后端共用同一份聊天记录。每次请求还会带上当前桌宠形象（小白 / 小鸡毛 / 两只一起），所以切换形象后，新回复会使用对应的性格。

## 主动聊天（会弹气泡）

在设置 →「感知与陪伴」或独立设置窗口「陪伴与感知」里打开「让模型观察并主动找你聊天」，再选方式和间隔（5–240 分钟，默认 30）。

两种方式：

- **定时**（默认）：每隔设定分钟数说一次。
- **跟随状态**：只有情境变化时才说。「情境」= 前台程序类型 + 是否在播放媒体 + 是否离开电脑（闲置超过 10 分钟）。
  - 情境一变只更新计时，不立刻说话；
  - 新情境稳定 **3 分钟**后才可能开口，避免频繁切应用时不停打扰；
  - 同一个情境只主动说一次；两次之间至少有「最短间隔」（即上面那个分钟数）的冷却。

- 到点且小狗处于**挂机（收起态）**时，读取前台程序、正在播放的音乐、系统闲置时长和当前时间，交给当前后端（本地模型 / DSH）生成一句不超过 30 字的中文关心。
- 生成后**弹出云朵聊天气泡**（标题「小狗想你了」），同时写入聊天记录 `focusd-island-pet-chat-messages`，下次打开聊天能看到这句话。
- 面板展开或正在聊天时本轮跳过，等回到挂机状态再说，避免打断。
- 模型未配置、调用失败或返回空内容时，用按时间段准备的本地兜底台词，保证气泡照常出现。
- 计时基准只在第一次进入挂机时记录；切歌、开关面板等状态变化不会重置它（早期版本会，导致主动聊天几乎不会触发）。
## 切换本地模型

1. 打开 **聊天**，点击右上角的模型设置按钮。
2. 选择「本地模型」。
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
- 每次请求会带当前形象的桌宠 system prompt，并要求用简体中文、1 到 3 句话回答。小白的设定是安静温柔、细心、略胆小；小鸡毛的设定是活泼、贪吃、爱撒娇；选择两只一起时，模型必须分别用「小白：」和「小鸡毛：」各说一句。
- 「测试连接」调用 `local_chat_models`，读取 `<base>/v1/models`；只用于展示模型列表，不会保存服务返回的其他内容。
- 「启动 Strata」调用 `strata_launch`，执行 `F:\Strata\bin\strata.cmd launch --no-tui --yes`。该启动器由本机用户 PATH 提供，也会设置 Strata 的 F 盘数据目录。
- 接口只接受 `http` / `https`。请求从本机直接发到配置的地址，不经过 DSH 或 Maltese 的服务器。

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
