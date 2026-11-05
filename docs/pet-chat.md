# 桌宠聊天（DSH / 本地模型）

展开岛屿后切到「聊天」，可以选择两种后端：

- **DSH**：通过本机 DSH CLI 的 `headless` profile 对话，复用已保存的会话。
- **本地模型**：连接 Ollama / LM Studio / llama.cpp 等服务的 OpenAI Chat Completions 接口。

聊天记录保存在浏览器 `localStorage`（`focusd-island-pet-chat-messages`），DSH 会话 id 保存在 `focusd-island-pet-chat-session`；点右上角垃圾桶会清空这两项。模型后端配置保存在 `maltese-local-chat-settings`，两种后端共用同一份聊天记录。

## 切换本地模型

1. 打开 **聊天**，点击右上角的模型设置按钮。
2. 选择「本地模型」。
3. 填写接口地址和模型名称：
   - **Ollama**：`http://127.0.0.1:11434/v1`，模型例如 `qwen2.5:7b`
   - **LM Studio**：`http://127.0.0.1:1234/v1`，模型用 LM Studio 里加载的名称
   - **llama.cpp server**：`http://127.0.0.1:8080/v1`，模型名按服务端 `--model` 配置填写
4. 点「测试连接」，服务返回模型列表后会显示连接成功，并把模型列表加入输入建议。
5. 发送消息即可。API Key 通常留空；服务开启鉴权时再填。

接口地址可以只填服务根地址（如 `http://127.0.0.1:11434`），程序会自动补齐 `/v1/chat/completions`；也可以填完整的 `/v1/chat/completions` 地址。

## 本地模型工作方式

- 前端 `src/PetChat.tsx` 调用原生命令 `local_chat`，传入当前文本、最近 16 条消息、接口地址、模型名和可选 API Key。
- Rust `src-tauri/src/local_chat.rs` 向 `POST <base>/v1/chat/completions` 发送非流式请求，超时 180 秒；连接超时为 25 秒。
- 每次请求会带一条固定桌宠 system prompt，并要求用简体中文、1 到 3 句话回答。
- 「测试连接」调用 `local_chat_models`，读取 `<base>/v1/models`；只用于展示模型列表，不会保存服务返回的其他内容。
- 接口只接受 `http` / `https`。请求从本机直接发到配置的地址，不经过 DSH 或 Maltese 的服务器。

## DSH 工作方式

- 前端 `src/PetChat.tsx` 调用原生命令 `dsh_chat`，只传用户文本和可选 `sessionId`。
- Rust `src-tauri/src/dsh_chat.rs` 启动：

  ```text
  dsh.cmd --patch <headless-credentials.yml> --profile headless --json [--session-id <id>] <prompt>
  ```

  `--patch` 必须放在 profile 名之前，否则会被 headless 当成未知 app 参数。命令用 `CREATE_NO_WINDOW`，不弹终端，120 秒超时。

- 默认 headless profile 关闭了 `credentials`、`authorization`、`deepseek-account` 模块。首次调用时在应用数据目录写入一个只包含三行 `disabled: false` 的 patch 文件，让 headless 读到 DSH 已保存的凭据；不复制、不打印、不上传密钥。
- 解析 NDJSON：`session` 取 `sessionId`，`final` 取最终文本；没有 `final` 时回退到最后一个 `text`。空回复会报错，由界面显示。
- `sessionId` 让 DSH 复用同一会话；CLI 返回新 id 时前端自动更新。会话不存在等错误由后端清空 id 后重试一次。

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
