# 多实例联动设计（初版）

> 记录时间：2026-11-17 · 版本 2.0.2（不改版本号）
> 目标：让主狗、陪玩狗、Bongo、跟随狗之间「有点互动」，初版先做 1–2 条看效果。
> 说明：本文的「多实例」= **同一个 Maltese 进程内的多个透明 WebView 窗口**，不是多进程。第二个进程会被 `instance_lock` 的文件锁直接挡掉（[instance_lock.rs:61](../src-tauri/src/instance_lock.rs)），所以联动只能走**窗口间事件**，不需要跨进程通信。

---

## 1. 现状盘点（读代码确认）

| 窗口 | 数量上限 | 创建方式 | 位置/尺寸 | 现有跨窗口通信 |
| --- | --- | --- | --- | --- |
| `main`（主狗） | 1 | 启动即建 | 用户拖动 / 角落锁定 / 闲逛 | 只 **listen**，从不 emit（`App.tsx` 内无 `emit(`） |
| `companion-1..4` | 4（`petCount` 1–5，减主狗） | 首次需要时 `ensure_if_known` 懒创建，之后只隐藏不销毁 | Rust 固定网格：左起 80px、间距 200px、底部对齐，200×180（[desktop_extras.rs:146](../src-tauri/src/desktop_extras.rs)） | 被摸时 `emit("maltese-pet-action", {action:"pet"})` → 主狗播一次摸头（[CompanionPet.tsx:67](../src/CompanionPet.tsx)、[App.tsx:9089](../src/App.tsx)） |
| `bongo-pet` | 1 | 懒创建，Bongo 开关开时显示 | 尺寸/位置按设置，可鼠标穿透；前端每 50ms 轮询 `get_pressed_keys` 切帧（[BongoPet.tsx:73](../src/BongoPet.tsx)） | 无 |
| `cursor-pet` | 1 | 懒创建，跟随鼠标开关开时显示 | Rust 线程每 16ms 读光标并 `set_position`（[desktop_extras.rs:233](../src-tauri/src/desktop_extras.rs)），前端只渲染 GIF（[CursorPet.tsx:11](../src/CursorPet.tsx)） | 无 |

补充事实：

- **配置同步有、行为联动几乎没有**：独立设置窗口保存后 `emit("maltese-settings-updated")`（[SettingsWindow.tsx:279](../src/SettingsWindow.tsx)），主窗口与陪玩狗/Bongo 重新读 `localStorage["focusd-island-settings"]`（[App.tsx:7613](../src/App.tsx)、[CompanionPet.tsx:54](../src/CompanionPet.tsx)、[BongoPet.tsx:62](../src/BongoPet.tsx)）；主狗自己改设置时靠 `storage` 事件，Bongo 另有 800ms 轮询兜底。
- 所有窗口由 `window_factory::ensure` 懒创建，陪玩狗/Bongo/跟随宠分别是固定参数的 overlay 窗口（[window_factory.rs:113](../src-tauri/src/window_factory.rs)、[window_factory.rs:132](../src-tauri/src/window_factory.rs)、[window_factory.rs:138](../src-tauri/src/window_factory.rs)）；capabilities 已包含这些 label，`core:default` 的 event 能力可直接 emit/listen。
- 每个窗口是**独立 React 根**（[main.tsx:16](../src/main.tsx)），各自渲染、各自持有状态；主狗当前的 `petState`、位置、气泡**都没有对外广播**。
- 位置是「一次性同步」：`sync_desktop_extras` 只在设置变化/显隐恢复时跑（[App.tsx:7577](../src/App.tsx)、[desktop_extras.rs:277](../src-tauri/src/desktop_extras.rs)），主狗拖动或闲逛不会带动陪玩狗。
- 已有素材只有动作状态（`idle/pet/happy/peek/spin/...`），**没有方向性「转头」帧**（`assets/pets/chars/*` 目录）——「同步抬头」初版只能用 `peek` 状态 + 朝向措辞近似，真转头要补素材。

---

## 2. 联动设计（6 条，按性价比排序）

### L1 情绪传染（P0 · 复杂度 S）
- **触发**：主狗播放正面动作（`pet/happy/chin/pickup/spin/play/chase/love/eating/celebrate`）或用户悬停主狗。
- **表现**：随机 1–2 只陪玩狗在 0–300ms 后跟着播一次同系动作（摸头→`pet`，喂食→`eating`，开心→`happy`），2.6s 后回 idle；约 1/3 概率冒一句小气泡（「我也要！」「摸摸我～」）。
- **实现**：主窗口 `triggerPetAction` / `onPetHoverStart` 里 `emit("maltese-pet-link", {kind:"action", action, seq, source:"main"})`；`CompanionPet` listen 后用现有 `rotationFramesForState` 临时换帧（复用 [usePetGifRotation.ts:32](../src/usePetGifRotation.ts)），定时器结束恢复 idle。
- **文件**：`src/petLinkBus.ts`（新）、`src/App.tsx`、`src/CompanionPet.tsx`、`src/DesktopExtras.css`、i18n。
- **降级**：事件没送到 / 素材缺失 → 不播，主狗动作绝不受影响（发射端包 `try/catch`，不 await）。

### L2 Bongo 呼应（P0 · 复杂度 S）
- **触发**：①主狗播 `happy/celebrate` → Bongo 敲一下（切一帧「爪子按下」+ 80ms 缩放脉冲）；②Bongo 按下空格 → 主狗 500ms 内摇尾巴（播 `happy` 1.2s）。
- **表现**：双向小反馈，Bongo 窗口内的动画为主，不弹气泡。
- **实现**：主窗口复用 `maltese-pet-link`（`kind:"action"`）；`BongoPet` listen 后设 `reaction` 状态 600ms 覆盖按键帧，并对比 `pressed` 数组做**空格边沿检测**（避免 50ms 轮询重复触发），emit `{kind:"bongo-hit", source:"bongo-pet"}`；主窗口 listen 后 `triggerPetAction("happy")`。
- **文件**：`src/petLinkBus.ts`、`src/App.tsx`、`src/BongoPet.tsx`、`src/DesktopExtras.css`。
- **降级**：Bongo 未开启/被穿透时不反应；主狗正在睡觉/缩边则不响应（见 §5）。

### L3 一起看过来（P1 · 复杂度 M；真·转头需补素材）
- **触发**：鼠标移入主狗 1.5s 内（`onPetHoverStart`）。
- **表现**：最多 2 只陪玩狗切 `peek` 状态 1.5s，像一起抬头看你；不改变窗口位置，不弹气泡。
- **实现**：同 L1 事件总线增加 `kind:"hover"`；以后要「跟着鼠标方向看」再在 Rust 侧 8–10Hz 读 `GetCursorPos`（已有 Win32 依赖），按「左/右/上/下」四档做 bucket，只在档位变化时 emit，配合补 `look-left/look-right` 素材。
- **文件**：`src/petLinkBus.ts`、`src/App.tsx`、`src/CompanionPet.tsx`（+ 后续 `desktop_extras.rs` 光标线程）。
- **降级**：无 `peek` 素材的角色走回退链到 idle，不报错。

### L4 跟随队形（P1 · 复杂度 M）
- **触发**：主狗被拖动结束、闲逛落点、角落锁定后。
- **表现**：陪玩狗在 1s 内平滑挪到主狗左/右侧的队形位（间距 200px、底部对齐），不瞬移；用户手动拖过的陪玩狗记住自己的偏移，不强制归队。
- **实现**：Rust 侧加只读位置观察线程（仅当 `petCount>1` 时启动，6Hz 读主窗口 `outer_position`，变化 >24px 才动），复用 `sync_companions` 的定位逻辑做 lerp；陪玩狗拖动结束 `emit("maltese-companion-moved", {label, dx, dy})` 记录偏移到 localStorage。
- **文件**：`src-tauri/src/desktop_extras.rs`、`src/App.tsx`（拖动结束触发一次同步）、`src/CompanionPet.tsx`。
- **降级**：主狗隐藏/缩边/拖动中不算位置；失败只记 `eprintln`，不回滚主狗位置。

### L5 群聊式回声（P2 · 复杂度 M）
- **触发**：主狗弹云朵气泡（消息/主动聊天/更新提示，`applyPetOverlay({mode:"cloud"})`）。
- **表现**：随机 1 只陪玩狗在 600ms 后补一句短回声（「我也在」「听见啦」），8s 内不重复；不抢主气泡时长。
- **实现**：主窗口 emit `kind:"bubble"`（带 `bubbleId` + 文本 hash 去重）；陪玩狗窗口内加一个 1 行迷你气泡（200×180 窗口内绝对定位，最多 90px 宽）；文本走 i18n。
- **文件**：`src/App.tsx`、`src/CompanionPet.tsx`、`src/DesktopExtras.css`、i18n。
- **降级**：窗口太窄/文本过长时只播动作不弹字；用户关闭联动则完全不发。

### L6 实例感知/避让（P3 · 复杂度 L）
- **触发**：主狗被拖到某只陪玩狗附近（<160px）。
- **表现**：那只陪玩狗向远离方向挪 80–120px，带缓动，不互相推挤。
- **实现**：同 L4 的位置观察线程 + 简单碰撞判断；需要每只狗的当前矩形与用户锁定位置，冲突处理复杂。
- **文件**：`src-tauri/src/desktop_extras.rs`、`src/CompanionPet.tsx`。
- **降级**：初版不做；若做，单次只让 1 只狗避让，且 3s 内不重复。

---

## 3. MVP 范围建议

**初版只做 L1 + L2**（情绪传染 + Bongo 呼应），理由：共用一条事件总线、纯前端、无 Rust 改动、视觉反馈直接（动作 + Bongo 敲击），失败也只影响额外窗口。

- **最小可交付**：
  1. 新增 `src/petLinkBus.ts`：`emitLink` / `listenLink` + 节流（≥120ms/类）、随机参与（0.6）、单次最多 2 个实例、去重（`seq`+`source`）、冷却（同动作 1.5s）。
  2. 主狗发事件（动作/悬停），陪玩狗播动作 + 小气泡，Bongo 敲击 + 主狗摇尾。
  3. 设置项 `petLinkage`（默认**开**）：主设置页「外观/桌宠」区、独立设置窗口都要有；仅当 `petCount>1` 或 `bongoEnabled` 时显示。
  4. 关闭开关后：零事件、零反应，主狗行为与现在完全一致。
- **不在初版**：L3 真转头（要补素材 + Rust 光标线程）、L4 队形（要 Rust 位置线程）、L5 大量气泡文案、L6 避让。
- **默认配置提醒**：出厂 `petCount=1`、`bongoEnabled=false`，所以默认看不到效果；文档/发布说明要写清「先把小狗数量调到 ≥2 或打开 Bongo」。
- **L3 的 hover 部分**可作为初版彩蛋一起做（同一个事件总线，+10 行），但真·跟随鼠标方向留到 P1。

---

## 4. 验收标准（可执行）

| 用例 | 操作 | 通过判据 |
| --- | --- | --- |
| A1 摸头传染 | `petCount=3`，摸主狗头 | 500ms 内 ≥1 只陪玩狗出现 `pet/happy` 帧变化（录屏对比 2 帧）；2.6s±0.3s 后回 idle |
| A2 喂食传染 | 主狗喂食 | 500ms 内 ≥1 只陪玩狗切到 `eat/eating` 系帧；不出现所有狗同时换帧（≤2 只） |
| A3 一起看过来 | 鼠标移入主狗 | 1.5s 内最多 2 只陪玩狗切 `peek`；窗口位置不变（矩形差 ≤2px） |
| A4 Bongo 呼应 | 主狗 celebrate | 600ms 内 Bongo 有可见敲击/缩放反馈，800ms 后恢复按键帧 |
| A5 Bongo→主狗 | Bongo 开、按空格 3 次（间隔 2s） | 每次 500ms 内主狗播 `happy` 并 1.2s 内恢复；主狗不锁死在该动作 |
| A6 开关 | 关闭 `petLinkage` 后重复 A1/A4 | 陪玩狗/Bongo 零反应；主狗自身动作正常 |
| A7 静默态 | 主狗收起/缩边/睡眠/面板展开/隐藏到托盘 | 不产生联动事件；已开始的联动 1s 内停止 |
| A8 事件风暴 | 5s 内连续摸头 20 次 | 陪玩狗实际反应 ≤6 次；主狗帧率 ≥50fps（录屏抽帧）、无堆积延迟 >500ms |
| A9 空闲开销 | 不操作放置 5 分钟 | 无联动事件、CPU 无持续轮询（Bongo 原有 50ms 键轮询除外）、内存不持续增长 |
| A10 多屏/缩放 | 150% 缩放、副屏 | 动作/气泡正常，不因窗口尺寸变化裁切或抖动 |

性能约束：事件 ≤4 次/秒；单次联动实例 ≤2；每个实例同事件 ≥1.5s 冷却；小气泡每实例 ≥8s 冷却；接收端不得再 `emit`（防回声环）；不新增任何高频定时器（复用现有 GIF 轮播与动作定时器）。

---

## 5. 风险与边界

- **别让所有狗同时乱跳**：概率 0.6、单次上限 2、0–300ms 错峰、同动作 1.5s 冷却、全局 4 次/秒上限；动作结束后必须回 idle，不允许叠加多个动作定时器（用单 ref 覆盖）。
- **不联动状态**：收起态之外的展开面板、缩边（`isTucked`）、睡眠（`petState==="sleeping"` 或 `deep`）、隐藏到托盘、全屏避让隐藏、主狗正在拖动。
- **不链式传播**：接收端只播动作不转发；`source` 为自身的消息直接丢弃；`seq` 单调递增，旧事件丢弃。
- **不影响主链路**：发射端异步、不 await、`try/catch`；事件失败不允许影响主狗动作、气泡、窗口几何。
- **Bongo 特殊性**：可鼠标穿透，用户无法点击，反馈只能靠视觉；空格边沿检测用 ref，避免 50ms 轮询重复触发。
- **性能**：陪玩狗最多 4 个窗口，每个窗口一次动作只换 `img src`，不做窗口 resize；Bongo 增加的状态覆盖与轮询共用同一 tick，不新增定时器。
- **素材风险**：没有方向帧，L3 初版是「一起看过来」而非真转头；L1 动作走现有回退链，缺素材自动降级。
- **可观测性**：`petLinkBus` 在 dev 下 `console.debug` 一行（kind/action/seq/接收者），生产静默；方便验收 A1–A8。

---

## 6. 研发实现清单（MVP）

| 顺序 | 文件 | 改动 | 复杂度 |
| --- | --- | --- | --- |
| 1 | `src/petLinkBus.ts`（新） | 事件名 `maltese-pet-link`、类型、节流/概率/去重/冷却；提供 `emitLink(kind, payload)`、`usePetLink(handler)` | S |
| 2 | `src/App.tsx` | `triggerPetAction` / `onPetHoverStart` 发事件；listen `bongo-hit` 播 happy；新增 `petLinkage` 设置（`IslandSettings` + `DEFAULT_SETTINGS` + `normalizeSettings` + 设置页开关） | S |
| 3 | `src/CompanionPet.tsx` | listen 后按动作临时换帧（`rotationFramesForState` + 2600ms 定时器）、迷你气泡、拖动结束上报偏移（为 L4 预留） | M |
| 4 | `src/BongoPet.tsx` | listen 动作做 600ms 敲击反馈；空格边沿 emit `bongo-hit` | S |
| 5 | `src/DesktopExtras.css` | 陪玩狗动作态、迷你气泡、Bongo 脉冲 | S |
| 6 | `src/SettingsWindow.tsx` | `PetSettings` + `DEFAULTS` 增加 `petLinkage`（设置窗口与主窗口各一份默认值，别只改一处） | S |
| 7 | `src/i18n/{types.ts,locales/zh-CN.ts,locales/en.ts}` | 开关文案 + 4–6 句回声台词 | S |

**Rust 不需要改**（MVP 全走 Tauri 全局事件，`core:default` 已允许）。L3 真转头/L4 队形再动 `src-tauri/src/desktop_extras.rs`。

---

## 7. 待确认

1. 联动声音要不要加？（Bongo 敲击/陪玩狗回应是否出声，受 `settings.soundOn` 控制；初版建议静音）
2. `petLinkage` 默认开是否可接受？关闭入口放主设置页还是独立设置窗口（本文建议两处都放，默认开）。
3. L3 真·转头是否补素材（`assets/pets/chars/*/look-*`）；不补的话产品文案就叫「一起看过来」。
4. 是否允许联动触发主狗动作（Bongo→主狗），还是严格「主狗单向驱动其它实例」；本文按双向设计，若担心打断用户操作可先只做单向。
---

## 8. 初版实现状态（2026-11-17）

按产品 MVP 只落地了 L1 + L2 两条（其它不夹带），开关默认开。

### 已实现

| 项 | 内容 | 文件 |
| --- | --- | --- |
| L1 情绪传染 | 主狗 `pet/eating/happy/celebrate` 动作 → 随机 1–2 只陪玩狗（`companion-*`）跟播对应动作 + 约 1/3 概率一句小气泡；2.6s 后回 idle | `src/petLinkBus.ts`、`src/App.tsx`（`triggerPetAction` 广播）、`src/CompanionPet.tsx`（接收 + 气泡）、`src/DesktopExtras.css` |
| L2 Bongo 呼应 | ①主狗 happy/celebrate → Bongo 敲一下（切「空格爪子」帧 + 560ms 缩放脉冲）；②Bongo 空格按下沿 → 主狗播 happy 1.2s | `src/BongoPet.tsx`、`src/App.tsx`（监听 `bongo-hit`） |
| 设置开关 | 「实例联动」默认开；岛内设置页与独立设置窗口各一处，仅在小狗数量 ≥2 或 Bongo 开启时显示 | `src/App.tsx`、`src/SettingsWindow.tsx`、i18n `petLink` |
| 总线 | `BroadcastChannel("maltese-pet-link")`（多窗口同源，优先）+ Tauri 全局事件兜底 | `src/petLinkBus.ts` |

### 防线（与 §5 一致，单测锁定）

| 参数 | 值 |
| --- | --- |
| 联动概率 | 0.6 |
| 单次最多实例 | 2 |
| 错峰 | 0–300ms（第一只 0，其余随机） |
| 同动作冷却 | 1.5s（发送端 + 接收端各一层） |
| 全局限速 | ≤4 次/秒 |
| 气泡冷却 | 每实例 8s |
| 回声抑制 | 接收端丢弃 `source === self` 与旧 `seq`；接收端**不转发** |
| 不联动场景 | 缩边 / 睡觉 / 展开面板 / 隐藏 / 拖动中（以及 Bongo 触发主狗时抑制回传） |

### 未做（按产品范围）

- L3「一起看过来」（`peek` 近似或补 `look-*` 素材）；
- L4 队形/位置跟随、L5 声音、L6 跨进程；
- 联动声音（初版静音）。

### 验证

- `node --test tests/pet-link-bus.test.mjs`：12 条（概率 / 上限 / 错峰 / 冷却 / 限速 / 回声 /
  气泡冷却 / 开关关闭不发事件 / 消息形态 / 设置读取）。
- `tsc --noEmit`、`cargo check` 通过；未改 Rust。
- 人工 30 秒看效果：设置里把「小狗数量」调到 ≥2（或打开 Bongo）→ 摸头/喂食主狗
  → 1–2 只陪玩狗跟着动一下（偶尔冒小气泡）；主狗开心时 Bongo 会敲一下；
  Bongo 按空格时主狗摇尾巴。关掉「实例联动」后上述现象消失。

---

## 9. 增强版实现（2026-11-17，让联动「一眼看得见」）

用户反馈「联动效果不明显」。除了「默认没有第二只狗」这个首要原因，还做了可见性增强：

### 9.1 参数现值（增强前 → 增强后）

| 参数 | 增强前 | 增强后 | 位置 |
| --- | --- | --- | --- |
| 首只触发概率 | 0.6 | **1.0（必触发）** | `src/petLinkBus.ts` `PET_LINK_PROBABILITY` |
| 第二只 | 0.5 | 0.5（保留，单次最多 2 只） | `PET_LINK_SECOND_PROBABILITY` |
| 错峰 | 0–300ms | **0–120ms** | `PET_LINK_STAGGER_MAX_MS` |
| 同动作冷却 | 1500ms | **800ms** | `PET_LINK_ACTION_COOLDOWN_MS` |
| 气泡 | 1/3 概率、8s 冷却 | **每次都带、1.2s、冷却同 800ms** | `shouldAttachBubble` / `PET_LINK_BUBBLE_COOLDOWN_MS` / `PET_LINK_BUBBLE_MS` |
| 陪玩狗位移 | 无 | **朝主狗方向 8–16px 再回位** | `PET_LINK_SHIFT_MIN_PX` / `PET_LINK_SHIFT_MAX_PX` |
| 缩放脉冲 | 无 | **1.0 → 1.08 → 1.0，260ms** | `PET_LINK_PULSE_MS` / `.companion-pet--reacting img` |
| 主狗对 Bongo 敲击 | 只换帧 | **摇尾巴（happy）+ 轻跳 300ms** | `PET_LINK_MAIN_HOP_MS` / `.maltese-pet--link-hop` |
| Bongo 路线 | 只发给陪玩狗，Bongo 收不到 | **happy/celebrate 带 `toBongo`，无随从也发** | `petLinkBus` 消息字段 `toBongo` |
| Bongo 节流 | 800ms | **250ms（敲一次必响应）** | `PET_LINK_BONGO_THROTTLE_MS` |

仍保留：限速 ≤4 次/秒、单次最多 2 只、回声抑制（source/seq）、开关关闭零事件。

### 9.2 「试一下联动」

`src/petLinkPreview.ts` 的 `previewPetLinkage()`：

1. 读 localStorage 里的真实设置（只读）；
2. 用**一次性** `sync_desktop_extras` 把 `petCount` 临时提到 ≥2（只在 Rust 侧显示随从窗口，不写回配置）；
3. 500ms 后 `emitAction("pet", { force: true, labels: ["companion-1"], origin, toBongo })` → 一次必中的完整联动；
4. 3 秒后（`finally` 里，抛错也执行）用真实 `petCount/bongoEnabled` 再同步一次，把临时随从收回去。

全程不写 localStorage、不改 React settings，因此用户持久配置不会被改动。设置页两处入口：
岛内「实例联动」区块按钮（`src/App.tsx`）与独立设置窗口按钮（`src/SettingsWindow.tsx`）。

### 9.3 验收判据（可测）

- `petCount≥2` 或 Bongo 开时，摸头 → 500ms 内至少 1 只随从开始动作，位移 ≥8px、出现台词气泡；
- 连续 5 次操作 ≥4 次可见（受 800ms 冷却/每秒 4 次限制）；
- 关掉「实例联动」→ 0 次联动（单测覆盖 `enabled=false` 不发事件）；
- 联动期间主窗口 rAF 间隔 <25ms（联动只做 CSS transform/animation，不触发布局计算）。
- 单测：`tests/pet-link-bus.test.mjs` 17 条（含首只必中/第二只概率、force 预览、toBongo 路由、origin/bubble 下发）。

---

## 10. 双狗互动（2026-11-17 第二轮，按 `docs/pet-duo-interaction-script.md`）

### 10.1 「没有台词」的真实原因（已实测定证）

- 旧样式 `DesktopExtras.css` 的 `.companion-pet__bubble` 是 `position:absolute; bottom:100%`，
  父容器 `.companion-pet` 为 100% 窗口高（200×180）→ 气泡被推到**窗口顶边之外**，
  再被 `html, body, #root { overflow: hidden }` 与窗口矩形裁掉，所以永远看不到。
- 只有随从有通用台词、主狗不说话、Bongo 无台词，观感就是「只换了个表情包」。
- 气泡时长 1200ms 偏短。

**像素证据**（用仓库真实 `DesktopExtras.css` + 200×180 视口，headless 渲染后统计近白像素）：

| 版本 | 近白像素 | 气泡 bbox |
| --- | --- | --- |
| 修复前（`bottom:100%` 对照组） | **0** | 无（完全被裁掉） |
| 修复后（`top:2px` 钉在窗口内） | **2741** | x 22–177，y 2–24（完整在窗口内） |

### 10.2 机制实现

- `src/petLinkScript.ts`（新增，纯函数、可单测）：场景映射（pet/eating/cheerful/bongo）、
  成对台词选取（同一组的两句）、最近 5 条不重复（`localStorage["maltese-pet-link-history"]`，
  只存 hash、滚动 20 条）、随从角色身份 `resolveCompanionRole()`（companion 奇数=小白、
  偶数=小鸡毛，与主狗重复则交换）、`buildLinkPlan()` 产出「谁在几毫秒后说哪句」。
- `src/petLinkBus.ts`：消息新增 `targets[].line/speaker`、`sceneId/mainLine/mainDelayMs`；
  气泡时长 1200 → **1800ms**；发送端把剧本台词挂到命中的目标上。
- 主窗口 `App.tsx`：主狗动作 → 生成剧本 → 广播（随从各说一句）+ 主狗自己用云朵气泡说另一句；
  `petCount=1` 时主狗自说两句（第二句 1200ms 后）；Bongo 敲击 → 播 S4 剧本（毛/白成对台词）。
- `CompanionPet.tsx`：按 label 解析角色身份并据此选 GIF（小白/小鸡毛不同素材池）；
  台词优先用消息里下发的那句；动作人设：小鸡毛「蹦过去」（260ms 位移 + 1.08 脉冲 + 朝另一只狗靠近 10px），
  小白「退半步再缓慢回靠」（反向位移 + 1200ms 回位 + `chin` 小幅点头）。
- `SettingsWindow.tsx`：独立设置窗口也支持「试一下联动」（把主狗那句通过
  `maltese-pet-link-say` 转给主窗口显示）。
- 气泡落位：`top:2px`、宽 ≤160px、字号 11.5px、1.8s、z-index 6、`pointer-events:none`，
  同一窗口最多 1 个（全局 ≤2 由 targets ≤2 保证）。

### 10.3 台词与去重

台词在 i18n `petLink.scenes.{pet,eating,cheerful,bongo}.pairs[]`（zh/en 各 3 组，每组
`{active, shy, main}`）。选择规则：同一场景内最近 5 条说过的组不重复，全说过则回退到最久未用；
同一次联动两只狗必须来自同一组（不跨组拼接）。「试一下联动」用 `force` 固定第一组，保证一次看全。

### 10.4 验收（可测）

- 有随从时一次联动产出 **≥2 条台词**（主狗 + 随从，不同角色），先说的先显示（差 ≥120ms）；
- `petCount=1`：主狗自说两句（A），有 Bongo 时追加 Bongo 敲击回应（B）；
- 关掉「实例联动」：0 句台词、0 动作；
- 单测：`tests/pet-link-script.test.mjs` 9 条（成对、角色映射、去重滚动、force、无随从不崩）。
