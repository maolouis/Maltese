# Maltese DSH API

Maltese 启动后只在本机监听 `127.0.0.1:3218`。端口可通过环境变量 `MALTESE_DSH_API_PORT` 修改。

## 能力

- `GET /api/capabilities`：读取 API 版本和端点。
- `GET /api/status`：读取 Maltese 与视频助手状态。
- `GET /api/video/status`：读取 B 站/抖音观看状态、翻页次数和上限。
- `POST /api/video/config`：设置 `intervalSeconds` 与 `maxMinutes`。
- `POST /api/video/start`：设置 `provider` 为 `bilibili` 或 `douyin`，打开有窗口浏览器并开始定时翻页。
- `POST /api/video/stop`：暂停自动观看。
- `POST /api/pet/action`：设置 `action`，支持 `pet`、`eating`、`pickup`、`wave`、`scared`、`sleeping`、`celebrate`。

视频助手使用有窗口浏览器，首次运行需要用户手动登录和完成验证；Maltese 只负责打开页面、维护时长/间隔并发送 PageDown，不读取账号凭据。
