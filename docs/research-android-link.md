# 联动 Android 手机 App 的方案调研

> 日期：2026-11-19 · 项目 star / license 均为 2026-11-19 用 GitHub API 查询；Android 限制来自官方文档（链接见文末）
> 结论：**推荐「局域网 WebSocket + 最小 Android App」作为主方案，ntfy 作为先落地/公网后备；不建议把现有 DSH API 暴露到局域网，也不建议自研完整推送基础设施。**

## 1. 目标场景（先列清单）

| # | 场景 | 方向 | 优先级 |
| --- | --- | --- | --- |
| ① | 手机通知（微信/QQ/短信/来电）→ 桌宠气泡提示 | 手机 → 桌面 | **P0** |
| ② | 手机状态（电量/充电/亮屏/步数/位置）→ 桌宠表现（低电量犯困等） | 手机 → 桌面 | **P0（电量/充电）** |
| ③ | 手机控制桌宠（发消息、开始刷视频、加待办、换形象） | 手机 → 桌面 | P1 |
| ④ | 桌宠推送到手机（待办提醒、日报） | 桌面 → 手机 | P1（可先用 ntfy） |

## 2. 通道方案对比

| 方案 | 原理 | 需公网 | 延迟 | 可靠性 | 功耗 | 需自建服务 | 成本 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **局域网直连 HTTP/WebSocket** | 桌面开 WS 服务，手机同 WiFi 连；二维码配对 + token | 否 | 极低（同网 <50ms） | 高（同网）；受路由器 AP 隔离/休眠影响 | 低（长连接）/中（重连） | 否（桌面即服务） | **S/M** |
| **ntfy** | HTTP PUT 发布、手机订阅（WebSocket/SSE/FCM）；可自建 | 否（自建 LAN）/是（公共或外出） | 低（<1s，视服务器） | 高（有 FCM/WS 重连） | 中 | 可选（自建） | **S** |
| Gotify | 自建 Go 服务，WebSocket 推送 + Android app | 否（同 LAN）/是（外出） | 低 | 高 | 中 | 是（一个 Go 服务） | S/M |
| PushDeer | 推送服务（可自建），多端 | 是 | 低 | 中高 | 中 | 可选 | S |
| Bark | iOS 推送（**仅 iOS**） | 是 | 低 | 高（iOS） | 中 | 可选 | S（不解决 Android） |
| MQTT（Mosquitto/EMQX） | Broker + 手机 MQTT 客户端；QoS/保留消息 | 视部署 | 低 | 高（QoS1） | 低 | 是（broker） | S/M |
| FCM 自建替代 | FCM 本身不可自建；替代即 UnifiedPush/ntfy/Gotify | 是 | 低 | 高 | 低（系统推送） | 是/第三方 | M |
| **现有 DSH API 暴露到局域网** | 把 `127.0.0.1:3218` 改 bind `0.0.0.0` | 否 | 极低 | 中 | 低 | 否 | S，但**安全风险高** |
| Tailscale / ZeroTier | 虚拟局域网（WireGuard/自建 SD-WAN），手机装客户端后访问桌面 WS | 是（控制面） | 中（中转/打洞） | 高 | 中 | 否（用其服务） | S/M |
| ADB（USB/无线调试） | `adb` 转发/`dumpsys notification` 读取 | 否（USB/同网） | 极低 | 调试用；断连即失效 | — | 否 | S（仅开发/调试） |
| KDE Connect / Phone Link / RustDesk | 现成跨端应用 | 视方案 | — | 成熟但不可嵌入 | — | 否 | 用户装 app；**无法给桌宠喂数据** |

**现有 DSH API 为什么不能直接暴露**：`dsh_api.rs` 明确「只监听回环地址」，`TcpListener::bind(("127.0.0.1", port))`；令牌、Host/Origin/CORS 都按本机设计（`127.0.0.1:3218`，端口写 `dsh-api-port.txt`）。改成 `0.0.0.0` 需要新增 LAN Host/Origin、TLS、限速、来源白名单，且它本来只服务视频/宠物扩展，**不建议**拿来当手机通道。

## 3. Android 侧能力与限制

| 能力 | API | 限制（官方文档） |
| --- | --- | --- |
| 读通知 | `NotificationListenerService`（`BIND_NOTIFICATION_LISTENER_SERVICE`，用户在「通知使用权」里手动开启） | Android 15 起，**非受信**的 listener 不能读取被判定为 OTP 的通知内容；投屏时含 OTP 的通知会被隐藏；受信 companion device manager 豁免。通知可能被 App 主动隐藏/合并，读不到全部字段 | 
| 电量/充电 | `BatteryManager` + `ACTION_BATTERY_CHANGED`（sticky） | 无危险权限；厂商可能限制后台广播 |
| 使用统计 | `UsageStatsManager`（`PACKAGE_USAGE_STATS` 特殊授权） | 需用户去设置授权；不是实时事件流 |
| 步数 | `SensorManager` `TYPE_STEP_COUNTER` + `ACTIVITY_RECOGNITION`（Android 10+ 运行时权限） | 需要硬件计步器；部分 ROM 无 sensor 或权限被拒 |
| 剪贴板 | `ClipboardManager` | Android 10+ 后台/非焦点应用读取返回 null；只适合前台交互，不能做常驻同步 |
| 常驻连接 | 前台服务（Android 14+ 必须声明 FGS 类型，如 `connectedDevice`/`dataSync`） + 常驻通知 | Doze/App Standby 会挂起网络；厂商省电策略会杀后台；需引导用户加白名单，但不能保证 |
| 局域网 | 普通 socket / `NsdManager` mDNS | **Android 17（target 37）起强制本地网络权限**；Android 16 为 opt-in；mDNS/NSD 都受影响，需要运行时授权 |

## 4. 可借的开源项目（star / license，2026-11-19）

| 项目 | Stars | License | 能借什么 |
| --- | --- | --- | --- |
| [ntfy](https://github.com/binwiederhier/ntfy) | 35,640 | Apache-2.0 | 桌面→手机推送、自建服务器、Android app；**不能替手机读通知** |
| [Gotify](https://github.com/gotify/server) | 16,224 | MIT | 自建 WebSocket 推送 + Android app；同类备选 |
| [KDE Connect Android](https://github.com/KDE/kdeconnect-android) | 1,519 | GPL-2.0 | 通知镜像/电量/命令的完整实现参考；有桌面客户端但**无可嵌入 SDK**，Windows 版成熟度低于 Linux |
| [Home Assistant Companion](https://github.com/home-assistant/android) | 4,067 | Apache-2.0 | 通知/传感器上报范式；但需要用户自建 Home Assistant |
| [PushDeer](https://github.com/easychen/pushdeer) | 5,027 | 非商业 + GPLv2（见 LICENSE） | 多端推送；**商用/分发受限** |
| [Bark](https://github.com/Finb/Bark) | 9,594 | MIT | 仅 iOS，Android 不适用 |
| [UnifiedPush 规范/连接器](https://github.com/UnifiedPush/specifications) | 110 / 38 | Apache-2.0 | 去 FCM 的推送协议与 Android 连接器；仍需自建 distributor/发布端 |
| [Tailscale](https://github.com/tailscale/tailscale) | 39,303 | BSD-3-Clause | 远程组网，免端口映射；手机需装客户端 |
| [ZeroTierOne](https://github.com/zerotier/ZeroTierOne) | 17,271 | MPL + 部分 source-available（见仓库） | 同类组网；商用需看 nonfree 目录 |
| [Mosquitto](https://github.com/eclipse-mosquitto/mosquitto) | 11,474 | EPL-2.0 / EDL | 轻量 MQTT broker |
| [EMQX](https://github.com/emqx/emqx) | 16,925 | BSL 1.1（单节点生产可用；嵌入/托管需商业授权） | 大规模 MQTT；桌宠用不上 |
| [RustDesk](https://github.com/rustdesk/rustdesk) | 130,090 | AGPL-3.0 | 远程桌面，不是通知联动；不借 |
| MacroDroid / Tasker / Automate | — | 闭源付费 | 可用「通知触发 → HTTP 请求」做无自研 app 的临时方案；依赖用户装两个 app，隐私/稳定性不可控 |

**「装现成 app + 桌面适配」vs「自研最小 app」**：KDE Connect/Phone Link 只能让用户「看到」通知，桌宠拿不到数据；ntfy + MacroDroid/Tasker 可以让手机把通知 POST 到桌面 WS（或 ntfy），**无需自研 App，S 成本**，但依赖自动化 App 的通知权限、后台存活和付费授权。自研最小 App 能稳定拿到 `NotificationListenerService` 的结构化字段、电量、配对鉴权，**M 成本**但可控。

## 5. 推荐方案与 MVP

### 5.1 推荐（分阶段）

- **Phase 0（S，1–2 天）：ntfy 先跑通「桌面 → 手机」**。用于待办提醒、日报、桌宠状态；手机装 ntfy 订阅私有 topic，桌面 Rust 里 POST。无需 Android 开发，先验证需求；公网/隐私场景可自建 ntfy。
- **Phase 1（M，5–8 天）：最小 Android App + 局域网 WebSocket**（主方案）。手机→桌面：通知（微信/QQ/短信/来电）+ 电量/充电；桌面→手机：配对确认/测试消息。控制指令放 Phase 2。
- **Phase 2（L）：控制类指令**（发消息、开始刷视频、加待办、换形象）与远程（Tailscale 或 ntfy 后备）；iOS 另议。

### 5.2 配对与安全

- 桌面生成一次性 32 字节 token，二维码包含 `ws://<LAN-IP>:<port>/ws` + token（token 走首帧认证，不放 URL query，避免日志泄露）；手机存 token，桌面存 deviceId+token（可轮换/撤销）。
- 仅绑定**私有网段**（拒绝公网来源），Windows 防火墙入站规则限定「专用网络 + 本地子网」；可选自签 TLS + 二维码指纹 pinning（实现成本 +S）。
- mDNS（`_maltese._tcp`）只用于发现，失败时二维码/手输 IP 兜底；路由器 AP 隔离时直连会失败。
- 默认只传「来源 App + 通知标题/数量」，正文需用户显式开启；OTP/验证码类通知不转发；不做云端存储。

### 5.3 桌面端改动（文件级）

| 文件 | 改动 |
| --- | --- |
| 新增 `src-tauri/src/android_link.rs` | WS 服务（`tokio-tungstenite` 已有依赖的 server 端）、token 配对、设备白名单、事件收发、心跳/重连、可选 mDNS、限速；命令 `android_link_start/stop/status/pair/revoke` |
| `src-tauri/src/lib.rs` | `mod android_link`、初始化与 `generate_handler!` 注册 |
| `src-tauri/Cargo.toml` | 如需 mDNS 加 `mdns-sd`（可选）；WS 可复用现有 tokio/tungstenite |
| 新增 `src/AndroidLinkSettings.tsx` | 配对二维码、连接状态、设备列表、开关（通知/电量/远程）、权限说明 |
| `src/App.tsx`、`src/i18n` | 接入气泡/状态（低电量→犯困等）、设置入口、文案 |
| 新增 `android/`（独立 Gradle 工程） | Kotlin：`NotificationListenerService`、`BatteryReceiver`、前台服务 + WS 客户端、二维码配对、权限引导 |
| `docs/android-link.md` | 使用/权限/安全/排障 |

### 5.4 成本与前置

- Phase 0 **S**；Phase 1 **M**（Android 3–5 天 + Rust/React 2–3 天，含联调）；Phase 2 **L**。
- 本机现状：**无 `adb`、无 Android SDK，只有 Java 8**（Android Gradle 需要 JDK 17+）；需安装 Android Studio/JDK17/SDK，并处理签名与分发，这部分不算在功能工期里。

## 6. 风险

- **Android 版本**：Android 15 对通知监听做 OTP 脱敏/投屏隐藏；Android 17 起 target 37 的 App 必须申请本地网络权限；FGS 类型与后台限制持续收紧。
- **厂商 ROM**：MIUI/ColorOS/EMUI 等会杀后台、限制自启/通知监听，需引导省电白名单，仍可能断连。
- **局域网发现**：路由器 AP 隔离/访客网络/双频分离会让 mDNS 和直连失败；必须有二维码/手输 IP 兜底。
- **隐私**：通知正文、联系人、验证码高度敏感；默认不传正文、不上云，自建 ntfy 也要鉴权/TLS。
- **安全**：LAN 服务暴露面（token 泄露、ARP 欺骗、无 TLS）；DSH API 不要直接改成 `0.0.0.0`。
- **iOS**：没有 Android `NotificationListenerService` 等价物，不能读取其他 App 通知；iPhone 只能做「桌面→手机」推送，联动需另案。

## 7. 来源（2026-11-19）

- 项目：[ntfy](https://github.com/binwiederhier/ntfy)、[Gotify](https://github.com/gotify/server)、[KDE Connect](https://github.com/KDE/kdeconnect-android)、[HA Companion](https://github.com/home-assistant/android)、[PushDeer](https://github.com/easychen/pushdeer)、[Bark](https://github.com/Finb/Bark)、[UnifiedPush](https://github.com/UnifiedPush/specifications)、[Tailscale](https://github.com/tailscale/tailscale)、[ZeroTier](https://github.com/zerotier/ZeroTierOne)、[Mosquitto](https://github.com/eclipse-mosquitto/mosquitto)、[EMQX](https://github.com/emqx/emqx)、[RustDesk](https://github.com/rustdesk/rustdesk)
- Android：[NotificationListenerService](https://developer.android.com/reference/android/service/notification/NotificationListenerService)、[Android 15 行为变更（OTP/通知监听）](https://developer.android.com/about/versions/15/behavior-changes-all)、[前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[Doze/省电](https://developer.android.com/training/monitoring-device-state/doze-standby)、[BatteryManager](https://developer.android.com/reference/android/os/BatteryManager)、[UsageStatsManager](https://developer.android.com/reference/android/app/usage/UsageStatsManager)、[步数传感器/ACTIVITY_RECOGNITION](https://developer.android.com/guide/topics/sensors/sensors_motion#sensors-motion-stepcounter)、[Android 10 剪贴板限制](https://developer.android.com/about/versions/10/privacy/changes#clipboard-data)、[本地网络权限（Android 16 opt-in / 17 强制）](https://developer.android.com/privacy-and-security/local-network-permission)
- 本机代码：`src-tauri/src/dsh_api.rs`（仅 bind `127.0.0.1:3218`、token/Host/Origin 校验）、`src-tauri/Cargo.toml`（tokio/tungstenite 依赖）、`src/App.tsx`（气泡/状态接入点）