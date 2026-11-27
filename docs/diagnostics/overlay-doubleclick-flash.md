# 双击浮层「向下闪一下」：单次落位后的二次纠正（2026-11-26）

## 现象

双击小狗打开 hover 浮层时，窗口已经「单次落位」（`OVERLAY_SINGLE_SHOT ok=true ...
corrections=0`），但用户仍能看到画面向下闪一下。

## 证据（work/v2b-boot.log，11-26 14:19 真实会话）

```
overlay plan (cloud): side=left vertical=above anchor=(2285, 1155) base=259.0x221.0
OVERLAY_SINGLE_SHOT phase=plan kind=cloud rect=(1977,747,567,629) preCompensated=false
OVERLAY_SINGLE_SHOT ok=true kind=cloud rect=(1977,747,567,629) preCompensated=false corrections=0
SLOT_INVARIANT_VIOLATION op=set_island_overlay dx=-308 dy=-408 corrected=true before=(2285,1155) after=(1977,747) target=(2285,1155)
OVERLAY_DOG_MEASURE mode=overlay window=(2285,1155,567,629) offset=(307.8,408.2) ..., dx=308 dy=408 corrected=true target=(1977,747)
```

一次打开浮层窗口被移动了 **3 次**：
1. `set_window_rect_atomic` 落到 plan 的 (1977,747)；
2. 紧接着 `enforce_slot_invariant` 用「上一次布局的实测狗槽偏移」判定有偏差，把窗口
   set_position 到 (2285,1155)（-308/-408 即纵向 408px 的跳动）；
3. 前端 60ms 后 `report_pet_slot_offset` 实测上报，又把窗口挪回 (1977,747)。

第 2 步是错的：单次落位时前端还没有本次布局的实测样本（首次打开浮层连 overlay
样本都没有），`dog_slot_now()` 回退公式又用了 stale 的 `LAST_PANEL_SIDE/VERTICAL`，
算出的「狗槽」与 CSS 实际钉住的位置不一致。用户看到的「向下闪一下」就是这次多余的
set_position。

第二个同源问题在 plan 的预补偿：

```rust
let overlay_layout_mode = if overlay == "hover" { "overlay" } else { "expanded" };
```

非 hover（cloud/menu）拿的是**展开页**的偏移样本，而且不区分窗口尺寸
（hover 面板 540 / 云朵 400 的窗口高度不同 → 狗在窗口内的偏移也不同）。用旧尺寸的
偏移预补偿会把窗口放低一截，然后等实测纠正，同样表现为闪一下。

第三个同源问题：**锚点（custom_position）可能是 stale 的**。plan 阶段原来无条件用
`expected_slot_from_state()` 当锚点：

```
DOUBLECLICK_GEOM phase=pre source=settled old_anchor=(-259, 862) new_anchor=(2285, 1155)   # v2b
DOUBLECLICK_GEOM phase=pre source=settled old_anchor=(-619, 504) new_anchor=(1204, 1262)   # 本机复现
overlay plan (hover): anchor=(1204, 1262) -> rect=(876,714,479,678)
```

实际窗口在 (-619,504)，persisted custom_position 却是 (1204,1262)：浮层直接按旧坐标
落到另一块屏，随后 `report_pet_slot_offset` 实测又把窗口拽回来——一次打开窗口被
移动 2~3 次，跨 1200px。正常用户拖拽时 `Moved` 会刷新 custom_position，但
startup 恢复矩形 / 换屏 / 旧脚本直接 `SetWindowPos` 都会让两者脱节。

## 修法（src-tauri/src/lib.rs）

1. **单次落位分支不再纠错**：`set_island_overlay` 的 PLANNED_OVERLAY 分支只做
   `verify mismatch` 日志（对比计划矩形与实际矩形），不再调用
   `enforce_slot_invariant`；真正的兜底交给前端 60ms 后的
   `report_pet_slot_offset`（只有真偏了才 set_position）。
2. **方向透传**：`PlannedOverlay` 增加 `side` / `vertical`，单次落位后 emit 真实方向；
   原来写死 `emit("maltese-panel-side", "left")` / `"above"`，方向算错时会把小狗
   钉到窗口另一侧。
3. **预补偿不再跨尺寸/跨布局**：浮层一律只认 `overlay` 样本，且
   `PetSlotMeasure` 记录采样时的窗口逻辑尺寸，只有
   「采样窗口尺寸 == 本次计划尺寸（±2px）」才用它的偏移预补偿，否则打印
   `OVERLAY_SINGLE_SHOT phase=plan skipPreCompensate ...` 并走公式。
4. **锚点先校验再使用**：`plan_island_overlay` 比较 `expected_slot_from_state` 与
   窗口实际 `outer_position()`，偏差 >2px 时判定 state stale，改用**实际窗口位置**
   当锚点、把它写回 `custom_position`，并打
   `DOUBLECLICK_GEOM phase=pre source=actual(stale-settled) settled=(..) actual=(..)`。
   这样浮层不会先跳到旧坐标再被纠正。

## 验证方式

- 日志断言（可直接 grep）：
  - 正常会话不应出现 `source=actual(stale-settled)`；出现说明 state 确实 stale，
    但此时 plan 用的就是实际位置，仍然只落位一次；
  - 修复后一次双击只应出现一条 `OVERLAY_SINGLE_SHOT ok=true`，**不应再出现**
    `SLOT_INVARIANT_VIOLATION op=set_island_overlay`；
  - `OVERLAY_DOG_MEASURE ... dx=0 dy=0 corrected=false`；
  - 若落位和执行不一致会出现 `OVERLAY_SINGLE_SHOT verify mismatch`（本次未出现）。
- 窗口矩形逐帧采样（80ms）：打开后的中间帧矩形不得再变化。脚本：
  `work/verify-flash.ps1`（fix-ui2）/ `work/ui-flash.ps1`。
- 启动说明：隔离 `MALTESE_DATA_DIR` 会让应用进入首次运行向导（展开态），此时双击
  不会打开 hover 浮层（`showPetHoverBubble` 只在 collapsed 生效）；验证双击闪动时
  要用真实 localStorage（默认 EBWebView profile），只隔离 `MALTESE_DATA_DIR`
  跳过 2.9GB 数据迁移。

## 实测 before / after（fix-ui2，`work/verify-flash-*.log`，脚本 `scripts/verify-flash.ps1`）

同一个 profile 副本（`customPosition=(1204,1262)`，窗口实际 `(-619,504)`，故意保留
stale 状态），5 轮双击 + 80ms 逐帧（每轮 20 帧，约 2.5s）：

| | before（16:20 build，`exe-1620.exe`） | after（16:47 build） |
| --- | --- | --- |
| 双击后落位 | `OVERLAY_SINGLE_SHOT ok=true rect=(1207,719,479,678) preCompensated=true` | `DOUBLECLICK_GEOM phase=pre source=actual(stale-settled) settled=(1204,1262) actual=(-619,504)` → `OVERLAY_SINGLE_SHOT ok=true rect=(-619,-44,479,678)` |
| 60ms 实测纠正 | `dx=-2 dy=545 corrected=true target=(1209,174)`（窗口被拉走 545px，浮层随即自关） | 仅首次 `dx=-3 dy=-5 corrected=true`（CSS 狗元素相对窗口原点约 4.5px 的固有偏差），之后各轮 `preCompensated=true corrections=0`、`dx=0 dy=0 corrected=false` |
| 逐帧矩形 | `136ms:1207,171 -> 525ms:1204,166 -> 650ms:已关`，5 轮 FAIL | R1-R5 全部 `open=-616,-39,479,678 distinctRects=1 driftFrames=0 maxDriftPx=0 FRAME_VERDICT=PASS`，浮层撑到 ESC 不再自关 |
| 日志断言 | `set_island_overlay_violations=5 dog_measure_corrections=6 -> FAIL` | `set_island_overlay_violations=0 single_shot_mismatches=0 large_corrections=0 small_residual_corrections=1 (tolerance=8px) -> PASS`；`RESULT frame_pass=5 frame_fail=0 log_ok=True` |

残留的首次 ~5px 纠正来自 `.island__collapsed--pet-only` 元素相对窗口原点约
(-3,-4.5)px 的 CSS 偏差；打开浮层时窗口按公式落位后由实测纠正一次，第二次打开起
就使用同一尺寸的 overlay 样本，`corrected=false`（在 8px 容差内，不影响观感）。

CSS 侧结论（不需要改）：`src/App.css:5572` 的
`.island--collapsed, .island--expanded { transition: none; }` 已禁用岛的尺寸过渡，
浮层/展开容器没有 `height: 0` 展开动画；`.island__expanded` 只有
opacity + `translateY(-6px)`→none 的 280ms 淡入。「向下闪」来自原生窗口在开浮层
瞬间被移动 2~3 次，与 CSS 无关。

---

## 2026-11-27 后续跟进：v2.0.5「双击向左上角闪动」根因与闭环

### 为什么 v2.0.5 仍会在正常使用中复现「向左上角闪动」

`scripts/verify-flash.ps1` 当时复用的测试快照恰好带有非空 `customPosition`，掩盖了常规冷启动（未手拖或挂载后同步显示器偏好）下的多真源污染链路：

1. **挂载同步清空了 `custom_position`**：前端 `App.tsx` 挂载时调用 `set_monitor_preferences`，旧实现无条件执行 `state.custom_position = None`。
2. **`LAST_SETTLED_ISLAND_RECT` 被浮层外框覆盖**：双击打开 `hover`（尤其在右下角 `side=left, vertical=above` 时，窗口左上角相比小狗槽向左上方扩出约 `(-328, -410)` 物理像素），`WindowEvent::Resized` 调 `remember_settled_island_rect` 把**浮层大窗口左上角**写进了 `LAST_SETTLED_ISLAND_RECT`。
3. **60ms 实测上报二次向左上角拉飞**：`report_pet_slot_offset` 调 `expected_slot_from_state()` 时，因 `OVERLAY_SNAPSHOT` 未优先返回且 `state.custom_position == None`，回退读到了被污染的 `LAST_SETTLED_ISLAND_RECT`（浮层外框左上角），把本已对齐的窗口再次减去 `(328, 410)` 推向屏幕左上角。
4. **云朵气泡开着时双击小狗（`cloud → hover`）**：`plan_island_overlay` 在 `existing.is_some()` 时仍把当前云朵大窗口的 `outer_position()` 与 `settled_anchor` 比较，误判 `stale-settled` 并把云朵窗口左上角写回 `custom_position` 与 `OVERLAY_SNAPSHOT`。
5. **跨方向样本误补偿 + `.maltese-pet` 内边距残差**：`PetSlotMeasure` 原先不区分 `(side, vertical)`，且前端量的是带 `(-3, -4.5)px` 偏移的 `.maltese-pet` 而非 `.island__collapsed--pet-only`；叠加重复挂载的一组 `[60, 400, 1200]ms` 定时器与缺少 `SWP_NOCOPYBITS` 的位图拷贝，造成首帧残差与左上角旧位图闪现。

### 本次根治改动

1. **拆分两份缓存职责（`src-tauri/src/lib.rs`, `mutex_trace.rs`）**：
   - `LAST_OUTER_WINDOW_RECT`：记录任意合法外框（专供最小化/还原恢复外框）；
   - `LAST_SETTLED_ISLAND_RECT`：严格只存**收起态狗槽矩形 `(dog_x, dog_y, slot_w, slot_h)`**，展开态/浮层态一律经 `dog_slot_now` 折算后再写入。
2. **`expected_slot_from_state` 浮层快照优先**：`OVERLAY_SNAPSHOT` 存在时直接返回 `(anchor_x, anchor_y, base_w, base_h)`，绝不回退读外框。
3. **`plan_island_overlay` 与 `set_island_overlay` 共用 `compute_overlay_window_rect`**：消除计划阶段与落位阶段的尺寸/顶边夹取分叉；`existing.is_some()` 时直接沿用 `snapshot.anchor`，不再拿云朵外框左上角覆盖锚点。
4. **同方向测量匹配 + 槽位容器对齐 + `SWP_NOCOPYBITS`**：
   - `PetSlotMeasure` 增加 `(side, vertical)`，`same_mode_directed_measure` 只允许同模式同方向同尺寸样本参与预补偿；
   - `App.tsx` 改为测量 `.island__collapsed--pet-only` 并移除重复的 `report_pet_slot_offset` `useEffect`，消除首次 `~5px` 纠正；
   - `set_window_rect_atomic`（`SetWindowPos`）补上 `SWP_NOCOPYBITS`，杜绝 Win32 在窗口向左上扩窗瞬间把旧位图贴到新窗口 `(0, 0)` 左上角；
   - `set_monitor_preferences` 在目标屏未变化或启动恢复窗口已在该屏时不再清空 `custom_position`；`island_rect_store` 统一跟随 `paths::data_root()` 并在旧快照尺寸不匹配当前缩放时原地贴边自愈。

### 真机逐帧回归证据（`work/verify-followup.log`，2026-11-27）

- **场景 A（`custom_position == None` 默认冷启动，`side=right, vertical=above`）**：4 轮双击 × 30 帧（35ms 采样），`base=1204,1310,151,130 -> open=1204,900,479,540`，4 轮全部 `maxDriftPx=0 pass=True`，`OVERLAY_SINGLE_SHOT ok=true corrections=0`，`OVERLAY_DOG_MEASURE dx=0 dy=0 corrected=false`（连首次打开也是 `dx=0 dy=0`）。
- **场景 B（右边缘 `side=left, vertical=above` + 旧 `261x222` 快照自愈为 `151x130`）**：4 轮双击 × 30 帧，`base=-151,950,151,130 -> open=-479,540,479,540`，4 轮全部 `maxDriftPx=0 pass=True`，`violations=0`，`dogMeasureCorrections=0`。