# 几何子系统架构复盘：多真值、推导与兜底反噬

> 日期：2026-11-20 · 范围：`src-tauri/src/lib.rs` 几何/浮层链路、`island_rect_store.rs`、`geometry_invariant.rs`、`src/App.tsx` 位置桥。
> 结论：几何 bug 不是 6 个孤立问题，而是**同一事实有 7+ 份副本、以公式替代实测、启动/浮层多路异步竞争、兜底路径用错误期望值校正**叠加的结果。必须按「单一真值 + 状态机」重构，继续打补丁会复现。

## 1. 现状：谁是位置真值

| # | 真值/载体 | 谁写 | 谁读 | 写入时机 | 失配时谁赢（实际） |
| --- | --- | --- | --- | --- | --- |
| 1 | `IslandWindowState.custom_position`（Rust，`lib.rs:469`） | 拖拽 `start_island_drag`（`:1653`）、启动恢复（`:1557`）、`set_island_interaction` 仅在 None 时填（`:727`）、`set_monitor_preferences` 清空（`:409`）、`ensure_island_on_screen` 清空（`:1608`） | `expected_slot_from_state`（`:1247`）、`set_island_interaction` 锚点（`:681`）、`apply_stage_geometry`/`resolve_stage_position`（`:5507`） | 拖拽/启动/切屏/兜底 | 名义最高；但会被「切屏/兜底」清空，被旧启动值覆盖 |
| 2 | 前端 `islandPositionRef`（`App.tsx:4736`） | 只由 `island-position-changed` 事件更新（`:7500`）；否则保持 localStorage 初始值（`:1121`） | 每次 `syncNativeInteraction` 作为 `customPosition` 上传（`:4996`） | 仅 Rust 发事件时；启动恢复不发事件 | 前端永远慢一拍，旧值可回灌 Rust |
| 3 | `localStorage["focusd-island-position"]`（`App.tsx:505`） | `:7502` 事件写、`:5224` 重置删 | `:1121` 启动读 | 仅事件/重置 | 同一份旧值的持久副本，启动时先入为主 |
| 4 | `LAST_SETTLED_ISLAND_RECT`（Rust，`lib.rs:133`） | `remember_settled_island_rect`（`:1363`）、最小化还原（`:1404`） | 右键/展开锚点（`:668`）、`expected_slot` 兜底（`:1255`） | 每次几何落定/还原 | 内存最新，但没有 mode/epoch，可能是上一块屏/上一布局的矩形 |
| 5 | `island-rect.json`（`island_rect_store.rs:16`） | `persist_island_snapshot`（`lib.rs:1476-1489`）写**outer window rect + mode** | `restore_island_rect_on_startup`（`:1510-1579`） | 几何落定/退出 | 启动最高；但快照可能是 expanded/overlay 的面板矩形，被当成狗槽 |
| 6 | `ISLAND_MONITOR_PREF` / `BONGO_MONITOR_PREF`（`lib.rs:148-149`） | 前端设置 effect 调 `set_monitor_preferences`（`App.tsx:4784-4799`） | 几何选屏（`:5049-5095`）、Bongo/陪伴狗 | 设置变化；启动由挂载 effect 触发 | 仅内存，重启后先为 None；None 时回主屏 |
| 7 | 显示器指纹 `name|WxH@x,y`（`lib.rs:172`） | 由 `Monitor` 计算 | 快照/启动/偏好匹配（`:1519`、`find_monitor_by_key:210`） | 每次读 | 四层回退（完整→名字+分辨率→名字→尺寸位置），可能认错屏 |
| 8 | `PET_SLOT_MEASURE`/`PET_SLOT_MEASURES`（`lib.rs:1082-1132`，前端上报 `App.tsx:1468-1518`） | 前端 `.maltese-pet` 的 `getBoundingClientRect`，在 mode/overlay/page 变化后 60/400/1200ms 上报（**且重复注册了两次同样的 effect**） | `report_pet_slot_offset` 纠偏（`:1149-1154`）、`measured_dog_slot`（`:1178`）、overlay 预纠正（`:2098-2120`） | 布局变化后异步 | 实测本应最高，但按 mode 分桶、无 epoch，旧桶会污染新布局；且只在「同 mode」时才被信任 |
| 9 | `LAST_PANEL_SIDE/VERTICAL`（`lib.rs:1800`） | `apply_stage_geometry`/overlay（`:5242-5246`、`:2079-2080`） | `dog_slot_now` 公式回退（`:1212-1224`） | 展开/浮层 | 公式提示值，与 CSS 实际可能相反 |
| 10 | `OVERLAY_SNAPSHOT`（`lib.rs:1792`） | `create_overlay_snapshot`（`:1817`） | 浮层关闭/规划（`:1943`、`:2008`） | 打开浮层 | 浮层期间最高；清 React 不一定是清它 |
| 11 | `PRE_MINIMIZE_ISLAND_RECT`（`lib.rs:134`） | 最小化（`:1376`） | 还原（`:1392`） | 最小化/还原 | 只覆盖最小化窗口期 |

**小结**：同一件“小狗在哪”有 7 份以上副本；其中 1/2/3/4/5 都是“位置”，但语义不同（狗槽 vs 窗口矩形 vs 面板矩形），没有版本号、没有 owner、没有一致性校验。

## 2. 冲突矩阵（时序 → 现象）

| 组合 | 冲突时序 | 结果 / 对应现象 |
| --- | --- | --- |
| 快照 vs `custom_position` | 启动 `restore` 把 **window rect** 写进 `custom_position`（`lib.rs:1556-1559`）；若快照是 expanded/overlay，写进去的是面板左上角 | 狗槽被平移一个 panel 宽/高 → **双击往左上/右下、启动偏移、8px 类位移** |
| 快照 mode vs 当前 mode | `persist_island_snapshot` 存了 `mode`（`:1481-1485`）但 `restore` 完全不用它；仍按快照尺寸设窗口 | 启动窗口停在 587×540 面板尺寸，狗槽被当成面板原点 → **启动不跟随、Esc 后尺寸不对** |
| `set_monitor_preferences` vs 启动恢复 | 前端挂载 effect 无条件调用（`App.tsx:4784-4799`），Rust 无条件 `custom_position=None`（`lib.rs:409-410`） | 刚恢复的副屏位置被清掉，`apply_stage_geometry` 回主屏 → **启动不跟随副屏** |
| `LAST_SETTLED` vs `custom_position` | 右键/展开时 `settled_anchor` 优先（`:668`），但选屏用 `custom_position`（`:5040`）；两者可能来自不同屏 | 窗口锚点与选屏不一致 → **右键跨屏/往右跳** |
| 实测偏移 vs `panelSide` 公式 | `dog_slot_now` 用实测（`:1200`），`plan_island_overlay` 用 `panelSide` 反推（`:2121-2132`）；实测 (467,258) 是 CSS 布局的真实偏移，公式假设贴角 | 规划/校正方向相反 → **双击向下/向右（上一版）、往左上（本版）** |
| 重复上报 vs 单次纠偏 | 同一 effect 注册两次（`App.tsx:1468-1492`、`:1494-1518`）；`OFFSET_ALREADY_APPLIED` 被 `swap` 后第二次可能再次纠偏 | 窗口被二次平移/振荡 → **8px/回弹** |
| `enforce_slot_invariant` vs 期望值 | `plan_island_overlay` 在**规划阶段**就调用 enforce（`lib.rs:2291`），expected 来自旧 `custom_position`/`LAST_SETTLED`，而 after 用实测偏移 | 规划阶段先移动窗口，set 阶段再预纠正 → **先动再拉回**，自检“通过”但用户看到位移 |
| `OVERLAY_SNAPSHOT` vs `set_island_interaction` | `apply_stage_geometry` 在 snapshot 存在时直接返回（`:1940-1943` 附近/`:5013` 相关）；`clearPetOverlayForPage` 只清 React（`App.tsx:5383`） | 窗口停在浮层尺寸 → **Esc/右键后 587×540** |
| 显示器偏好内存 vs 快照 | 偏好只在内存（`lib.rs:148`），重启后前端 effect 才设置；`None` 表示“跟随上次”但被解析为主屏 | 先按快照副屏恢复、再被偏好 None 打回主屏 → **启动屏错** |
| 测量 mode vs Rust mode | 前端按 DOM class 判 `overlay/expanded/collapsed`（`App.tsx:1475-1479`），Rust 按 `OVERLAY_SNAPSHOT` 判（`lib.rs:1090-1097`） | 同一时刻 mode 不同 → 实测样本放错桶，纠偏用错偏移 |

## 2.5 已知 7 个现象 → 触发链

| 现象 | 直接触发 | 冲突链（谁覆盖谁） |
| --- | --- | --- |
| 8px 位移 | 位移动画/最小化还原的过渡帧被写为落定矩形 | `remember_settled_island_rect`（`:1356`）与 `PET_SLOT_MEASURES` 同帧竞争；旧 `custom_position` 再被前端回灌 |
| 右键跨屏/往右跳 | `set_island_interaction` 用 `LAST_SETTLED` 做锚点（`:668`） | 选屏用 `custom_position`（`:5040`）；快照/偏好/实际屏不一致 |
| Esc 停在浮层尺寸 | `clearPetOverlayForPage` 只清 React（`App.tsx:5383`），未清 `OVERLAY_SNAPSHOT` | `apply_stage_geometry` 在 snapshot 存在时跳过；close 路径与 Esc 路径不一致 |
| 启动不跟随上次位置 | `restore` 写 `custom_position`（`:1556`）后，前端挂载 effect 无条件 `set_monitor_preferences`（`App.tsx:4784`）清空（`:409`） | 快照窗口矩形 vs 狗槽；启动恢复 vs 前端回灌 |
| 双击向下/向右（旧） | `plan_island_overlay` 用 `panelSide` 反推（`:2121`） | 公式假设 vs CSS 实际偏移；`dog_slot_now` 实测（`:1200`）与规划不一致 |
| 双击往左上（现） | 旧 mode 的 `PET_SLOT_MEASURE` 被用于新布局预纠正（`:2098-2120`） | 重复上报（`App.tsx:1468-1518`）与 `OFFSET_ALREADY_APPLIED` 竞态；expected 仍是旧 `custom_position` |
| 启动不跟随副屏 | 显示器偏好只在内存（`:148`），重启后为 None；`apply_stage_geometry` 回主屏 | 快照副屏 vs 偏好 None；`set_monitor_preferences` 清空 `custom_position` |

## 3. 根因归类（验证 + 补充）

1. **多真值（成立，且最严重）**：7+ 份位置副本，语义混用（狗槽 / 窗口矩形 / 面板矩形 / 缩放后矩形）；没有 owner、epoch、优先级和一致性断言。上述矩阵的每一行最终都是“谁最后写谁赢”。
2. **推导代替测量（成立）**：`panel_side` 公式假设狗槽永远贴窗口角，但实际布局由 CSS 决定；用户实测偏移 `(467,258)` 直接证伪。`measured_dog_slot` 只在 after/纠偏使用，**expected 仍来自 `custom_position`/公式**，所以“测了但不作为真值”。
3. **时序竞争（成立）**：启动 3 秒窗口（`STARTUP_RESTORE_UNTIL_MS`）、前端挂载的 monitor effect、`islandPositionRef` 回灌、DOM 测量 60/400/1200ms、overlay plan/set 两段异步、重复 report，全部无 epoch/取消机制；先到者/最后写者胜。
4. **兜底反噬（成立）**：`enforce_slot_invariant` 用同一套可能错误的 expected 校验（`:1263`），纠正目标由 `after` 反推（`:1300-1303`），再检查也基于 `dog_slot_now`；于是“自欺通过”。`plan_island_overlay` 在规划阶段就移动窗口（`:2291`），违反“先规划后落位”，用户看到先动再纠正。
5. **补充：语义/生命周期混用**：`island-rect.json` 存窗口矩形却当狗槽；`custom_position` 同时表示“用户拖动意图”和“几何真值”；`OVERLAY_SNAPSHOT` 与 `apply_stage_geometry` 的“谁独占几何”没有显式状态；前端/ Rust 各自维护 mode。不是单纯“副本多”，而是**同一字段承担了不同语义**。

## 4. 目标架构：单一真值 + 状态机

### 4.1 唯一真值 `DogSlot`

```rust
struct DogSlot { x: i32, y: i32, w: i32, h: i32, monitor: MonitorKey, scale: f64, epoch: u64 }
```

- **唯一 writer：Rust `GeometryAuthority`**；所有命令/事件只能提交 `GeometryIntent { source, slot }`，由 authority 校验后落位；前端只读 `DogSlot` 和提交测量/拖动意图。
- **只持久化 `DogSlot`**（含 monitor 指纹、scale、epoch）；不再持久化窗口矩形/面板矩形；`custom_position` 降级为 `DragIntent`（仅表示用户拖到哪，不参与几何真值）；`island-rect.json` 迁移为 `dogs slot v2`；localStorage 位置副本废弃（迁移后删除）。
- **优先级**：用户拖动（DragIntent，最高）> 切屏/锁角显式选择 > 最后落定 `DogSlot` > 旧快照（仅迁移）> 偏好 > 默认锚点。每次写前 `assert`：槽中心在目标屏工作区内、scale 匹配、尺寸在合法范围；失败**不静默夹取**，记录并回退上一合法槽。

### 4.2 状态机与不变量

`Restoring → Settled → OverlayPlanned → OverlayOpen → Collapsing → Settled`

| 状态 | 允许的写 | 前置条件/不变量 |
| --- | --- | --- |
| Restoring | 仅 authority 按磁盘 `DogSlot` 落位 | 显示器指纹存在；无前端位置写入；3s 超时→按偏好默认，记录 `source=startup_fallback` |
| Settled | 用户拖动/切屏/锁角 | `slot` 唯一；窗口矩形由 `slot + 当前 mode` 推导；每次转移写 `source+epoch` |
| OverlayPlanned | **只计算，不 set_position** | 用当前 epoch 的实测 offset 预测面板矩形；校验 `slot` 不变；失败回 Settled 不打开 |
| OverlayOpen | 一次 `set_rect` | 窗口矩形 = 预测值；忽略一切 `apply_stage_geometry`；快照由 `slot` 派生，不是真值 |
| Collapsing | 一次恢复 `slot` | 与“点击外部/Esc/失焦”同一条路径；恢复后校验 `dx=dy=0` |
| Settled | 持久化 `DogSlot` | 只在 Settled 持久化；Overlay/中间态不写盘 |

- **测量优先**：前端上报 `{epoch, layout, offset, size}`；authority 按 epoch 存测量；公式只做预测，**落位后实测一次并校正一次**，绝不在规划阶段移动窗口；epoch 变化丢弃旧测量。
- **拒绝自欺**：断言比较 `DogSlot` 与实测槽，不以“窗口矩形 + 同一公式”互证；失败即回退并记录，不做循环纠正；`enforce` 只允许在 Settled 后执行一次，且不允许改变 `slot`。
- **前端**：删除 `islandPositionRef` 的持久化职责；拖动结束只上报 `DragIntent`；DOM 测量只上报，不触发原生纠偏；删除重复的 `report_pet_slot_offset` effect。
- **启动**：`Restoring` 读取 `DogSlot` + `ISLAND_MONITOR_PREF`（偏好需持久化）；`set_monitor_preferences` 只在用户改设置时调用，且不无条件清空位置；`frontend_ready` 后进入 `Settled`，期间拒绝前端位置回灌。

## 5. 迁移路径（3 步）

**Step 1（2–3 天，可回滚）加权威层与影子断言**：在 lib.rs 外包 `GeometryAuthority`；所有现有写入点（:`409`、`:727`、`:1363`、`:1557`、`:1608`、`:5242`）统一走 authority 并记录 `source/epoch/before/after`；旧逻辑继续生效，但每次对比新真值与旧结果，输出差异日志；加 `assert` 但不改变行为。验证：矩阵回归 + 日志无 `UNEXPLAINED_DELTA`；回滚=关 feature flag。

**Step 2（4–6 天）切换读写**：启动恢复、`set_island_interaction`、overlay plan/set、monitor 切换改为读 `DogSlot`；前端停止上传 `customPosition`，只上传拖动意图/测量；持久化切到 `DogSlot v2`，旧快照只读迁移；删除 `enforce_slot_invariant` 的规划阶段调用与重复 correction。验证：主/副屏 × 双击/右键/Esc/拖拽/重启各 5 次 `dx=dy=0`；启动落在上次 `DogSlot` 与指定屏；回滚=保留旧快照 reader 一版。

**Step 3（2–3 天）删除旧副本**：移除 `LAST_SETTLED_ISLAND_RECT`/`custom_position` 真值语义、前端 localStorage 位置、`island-rect.json` 旧格式；`custom_position` 仅保留为 DragIntent；清理 `pet-overlay-geometry`/`island-geometry-status` 文档口径。验证：全量几何 selftest + 实机矩阵 + 无旧写入日志。

**预估**：整体 **L（约 8–12 个工作日）**；改动集中在 `lib.rs`（建议拆出 `geometry_authority.rs`、`geometry_types.rs`、`overlay_geometry.rs`）、`island_rect_store.rs`、`App.tsx`（新增 `useIslandGeometry`/`geometryBridge.ts`）、`geometry_invariant.rs` 与测试。

## 6. 验收标准

- 主屏/副屏 × 双击/右键/Esc/拖拽/重启 × 5 次：`dx=dy=0`，`OVERLAY_DOG_MEASURE`/`SLOT_INVARIANT_VIOLATION` 无未解释记录。
- 启动必须落在上次 `DogSlot` 与指定显示器；拔插副屏/改分辨率/DPI 100%/150% 各验证一次。
- 所有几何写入日志含 `source`、`epoch`、`before/after`、`monitor`；`OverlayPlanned` 阶段无 `set_position`。
- 失败路径：快照损坏/显示器丢失/测量缺失 → 稳定回退，不循环抖动；前端不再回灌旧 `islandPositionRef`。

## 7. 依据

- 代码：`src-tauri/src/lib.rs`（上述行号）、`island_rect_store.rs`、`geometry_invariant.rs`、`src/App.tsx`（1468-1518、4736、4784-4799、4996、7500-7505、7531-7573、7575-7593）。
- 既有状态：`docs/island-geometry-status.md`（已修复 8 项）、`docs/pet-overlay-geometry.md`（不变量 2/3）、`docs/bugfix-2026-11-17.md`（8px 判定）。