# Maltese DSH API

Maltese 启动后只在本机监听 `127.0.0.1:3218`。端口可通过环境变量 `MALTESE_DSH_API_PORT` 修改。

## 鉴权

- `POST` / `DELETE` 以及 `GET /api/video/pending`、`GET /api/video/sessions/{id}` 需要令牌。
- 令牌来源：
  1. 环境变量 `MALTESE_DSH_API_TOKEN`（优先，便于测试）；
  2. 应用数据目录下的 `dsh-api-token.txt`（不存在时启动生成并保存）。
- 请求头二选一：`X-Maltese-Token: <token>` 或 `Authorization: Bearer <token>`。
- 令牌比较为常量时间；长度不等直接拒绝。
- `Host` 必须是 `127.0.0.1:{port}` 或 `localhost:{port}`。
- `Origin` 白名单：`tauri://localhost`、`http://localhost:1420`、`http://127.0.0.1:1420`，以及 `MALTESE_EXTENSION_ORIGIN` 指定的扩展来源。
- CORS 只对白名单来源回显 `Access-Control-Allow-Origin: <origin>`，并带 `Vary: Origin`；**不再返回 `*`**。
- `OPTIONS` 返回 204 与 `Allow-Methods`；请求体上限 256 KB；读超时 5 秒；不支持 chunked。
- 响应头 `Allow-Methods: GET, POST, DELETE, OPTIONS`，`Allow-Headers: content-type, x-maltese-token, authorization`。

统一错误体：

```json
{ "error": { "code": "UNAUTHORIZED", "message": "缺少或无效的本机令牌。", "detail": null } }
```

## 端点

| 方法 + 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/capabilities` | 无 | API 版本、端点与能力 |
| `GET /api/status` | 无 | Maltese 与视频助手精简状态 |
| `GET /api/video/status` | 无 | `VideoSnapshot`（不含条目正文） |
| `GET /api/video/sessions?limit=20` | 无 | 历史会话摘要 |
| `GET /api/video/sessions/{id}` | 令牌 | 单个会话详情 |
| `GET /api/video/diagnostics?limit=20` | 无 | 最近脱敏诊断 |
| `GET /api/video/pending` | 令牌 | 队首待投递小结或 `null` |
| `POST /api/video/config` | 令牌 | `VideoConfigPatch` |
| `POST /api/video/start` | 令牌 | `{ provider, config? }` |
| `POST /api/video/stop` | 令牌 | `{ reason? }` |
| `POST /api/video/facts` | 令牌 | 扩展 / UIA 通道上报 |
| `POST /api/video/self-check` | 令牌 | 通道自检 |
| `POST /api/video/profile` | 令牌 | 画像编辑 |
| `POST /api/video/delivery` | 令牌 | `{ sessionId, outcome }` |
| `DELETE /api/video/data` | 令牌 | `{ scope, includeBrowserProfile? }` |
| `POST /api/pet/action` | 无 | 桌宠动作（保留原行为） |

## 示例

```bash
TOKEN="$(cat "$APPDATA/com.maolouis.maltese/dsh-api-token.txt" 2>/dev/null || cat "$APPDATA/com.maltese.assistant/dsh-api-token.txt")"

curl -s -X POST http://127.0.0.1:3218/api/video/start \
  -H "Content-Type: application/json" -H "X-Maltese-Token: $TOKEN" \
  -d '{"provider":"bilibili"}' | head -c 400

curl -s http://127.0.0.1:3218/api/video/status

curl -s "http://127.0.0.1:3218/api/video/diagnostics?limit=10"

curl -s -X DELETE http://127.0.0.1:3218/api/video/data \
  -H "Content-Type: application/json" -H "X-Maltese-Token: $TOKEN" \
  -d '{"scope":"all","includeBrowserProfile":false}'
```

## 通道上报（experimental）

`POST /api/video/facts` 是浏览器扩展 / 可访问性树通道的唯一入口：

```json
{
  "channel": "extension",
  "platform": "bilibili",
  "facts": {
    "itemId": "BV1xx",
    "title": "标题",
    "author": "作者",
    "durationSeconds": 120,
    "positionSeconds": 60,
    "playing": true,
    "visible": true,
    "tags": ["标签"],
    "url": "https://www.bilibili.com/video/BV1xx"
  }
}
```

`channel` 只接受 `extension`（可信度 1.0）或 `uia`（0.5）；可信度由后端赋值，不接受客户端自报。字段白名单外的内容会被丢弃。

## 兼容性

- 路径不改名，响应字段只增；旧客户端可以继续读 `provider/running/steps/...`。
- `/api/video/status` 是旧 `VideoAutomationState` 的超集。
- 端点与错误码以本文件为准；新增字段不会移除既有字段。

## 边界

视频助手使用有窗口浏览器，首次运行需要用户手动登录；Maltese 只负责打开页面、维护时长/间隔并驱动页面，不读取账号凭据、不上传数据。