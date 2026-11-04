# 桌宠聊天（DSH 接入）

展开岛屿后切到「聊天」，小狗会通过本机 DSH CLI 的 `headless` profile 对话。聊天记录保存在浏览器 `localStorage`（`focusd-island-pet-chat-messages`），会话 id 保存在 `focusd-island-pet-chat-session`，用于多轮上下文；点右上角垃圾桶可同时清空两者。

## 工作方式

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

- 需要本机已安装 DSH 并完成登录；未安装或未登录时聊天页会显示错误，不影响宠物其他功能。
- 消息会发送给 DSH 当前配置的模型提供方，受该提供方的隐私策略约束；本地只保留聊天文本。
- 该功能不注入 DSH GUI 进程，也不依赖 GUI 是否打开。