# 小狗浮层（云朵气泡 / 互动面板）几何锚点

这一块负责「小狗不动、窗口变宽变高」：气泡打开时窗口向右或向左长出面板，小狗在屏幕上必须原地不动，关闭时再原样缩回。历史上 1.3.14→1.3.18 与 2.0.x 都因为同一类原因出现过「打开气泡时小狗闪一下」，这里记录当前的不变量与实现位置。

## 不变量

1. **独立 `bubble` 窗零扩窗架构（2026-11-27 根治左上角重影闪动）**：Tauri 桌面环境下，悬停面板 / 云朵气泡 / 菜单由 `show_pet_bubble` 渲染在独立预热的透明置顶窗口 `"bubble"`（`PetBubble.tsx`）中，并在 `frontend_ready` 后 +1s 空闲后台预热，主窗口自身完全不再扩窗或挪位（`SetWindowPos` 零调用），从而彻底消除 DirectComposition SwapChain 重绘 1–3 帧延迟造成的「左上角重影闪动」。`place_bubble_near_main` 优先停在小狗右侧，右侧越界时翻到左侧并返回 `side = "left"` 让云朵小尾巴翻转指向小狗，在 `show()` 之前通过 `set_window_rect_atomic` 一次性落位。
2. **非 Tauri 回退（旧单窗方案基准如下）**：收缩态里小狗槽贴在窗口左下角……
2. **两侧必须用同一份输入。** 前端先调 `plan_island_overlay`（只算方向、不改窗口矩形），拿到方向后 `flushSync` 把小狗按正确方向钉住，再调 `set_island_overlay` 一次性设矩形。只要两次计算里的基准矩形或锚点有一丝不同，小狗就会朝反方向闪一下。**实现上由 `plan_island_overlay` 先把锚点快照 `OVERLAY_SNAPSHOT` 钉下来，`set_island_overlay` 直接复用**（2026-11-17 回归修复后）；两侧不再各自读一次窗口矩形。
3. **关闭时不做无谓的“归位”。** 收起时先按快照原样恢复矩形；只有浮层期间尺寸设置真的变了才重算几何，否则 `apply_stage_geometry` 会按 `custom_position` / 居中算法把窗口挪回去，看起来就是关闭瞬间小狗跳一下。没有快照、但窗口尺寸明显不等于收起态时（上一次浮层请求丢了）按收起态几何收回。
4. **浮层期间由浮层独占窗口几何。** 快照存在（含 `plan` 已钉、`set` 还没落地的空档）时 `apply_stage_geometry` 一律直接返回；`show_island` 对已经可见的窗口不再重算几何；`roam_island_step` 在 `OVERLAY_ACTIVE` 期间不跑。
5. **浮层期间结束的拖拽不算数。** `start_island_drag` 收尾线程只在收起态且浮层未打开时才把窗口矩形写进 `custom_position` / emit `island-position-changed`；否则窗口左上角是「狗槽 + 面板」的角，存下去会让小狗在之后每次归位时都偏。

## 基准从哪来

- 基准尺寸和锚点一律取窗口**真实矩形**：`window.outer_position()` + `window.inner_size()`，physical 转 logical 除以 `monitor.scale_factor()`。由 `create_overlay_snapshot()` 统一读取，`plan_island_overlay` 与 `set_island_overlay` 共用同一份快照。
- 不再用 `state.custom_position` 或 `stage_dimensions()` 当锚点：这两个值都只是“应该在的位置”，和真实窗口可能不一致（多屏切换、DPI 变化、闲逛动画停在中间、拖拽后未落库）。
- 打开前会先把窗口真实位置写回 `custom_position`（缩边态除外——缩边时 y 是临时位置，写回去会污染正常位置）。这样关闭浮层时不会再按旧坐标挪一次。

## 位移动画（闲逛 / 缩边唤醒）

- `POSITION_ANIMATING` 记录位移动画是否在跑，`POSITION_ANIMATION_DELTA_X` 记录这段动画的横向位移。
- 打开浮层时先取消动画并等它真的停下（最多 80 ms），再读真实矩形当锚点。
- **纯竖直**（缩边唤醒 / 落定回缩边位）才允许 `apply_stage_geometry(..., animate=false)` 落定到终点；**带横向位移**（闲逛）不落定，直接钉在当前位置。把闲逛动画“落定”会瞬间把小狗拽到终点，正是用户看到的「向左闪」。
- `roam_island_step` 在浮层打开期间直接返回：窗口已经按气泡尺寸放大，再闲逛会让整块面板一起滑走。

## 代码位置

- `src-tauri/src/lib.rs`：`POSITION_ANIMATING` / `POSITION_ANIMATION_DELTA_X`（顶部静态量）、`OVERLAY_SNAPSHOT` / `OVERLAY_ACTIVE`、`create_overlay_snapshot`（建快照：取消动画、读真实矩形、写回 `custom_position`）、`plan_island_overlay`（先钉快照再算方向）、`set_island_overlay`（打开分支复用快照 + 关闭分支恢复）、`show_island`（已可见不重算几何）、`start_island_drag`（浮层期间丢弃拖拽收尾）、`apply_stage_geometry`（位移动画线程）、`roam_island_step`。
- `src/App.tsx`：`applyPetOverlay`（`plan → flushSync 钉方向 → set` 三步）、`overlaySide` / `overlayVertical` 状态。
- `src/App.css`：`.island--overlay-left` / `.island--overlay-below` 的钉角规则，以及 `.island--overlay-open` 下禁用过渡。

## 排障日志

原生侧 `eprintln`（release 下无控制台，用 DebugView / 附加调试器看，或看 dev 终端）：

```text
overlay plan (hover): side=right vertical=above anchor=(x, y) base=WxH
overlay open (hover): anchor=(x, y) base=WxH side=right vertical=above -> rect=(x, y) WxH
overlay closed: restored rect Some((x, y))
```

对照这三行即可判断「打开后 R1 的锚定边有没有守住 R0」「关闭后 R2 有没有回到 R0」。

## 验证

```powershell
cd E:\Maltese
.\node_modules\.bin\tsc.cmd --noEmit
cd src-tauri; cargo check --target x86_64-pc-windows-msvc
```

实机检查（肉眼一步，无需工具）：

1. 让小狗停在屏幕中间偏左，双击打开互动面板、移开鼠标关闭；确认打开/关闭两下小狗都原地不动。
2. 把小狗拖到屏幕最右侧（气泡翻到左边那一侧），重复上一步。
3. 打开「闲逛」后重复步骤 1：闲逛动画途中打开气泡，小狗应停在当前位置而不是被拽到终点。
4. 打开悬浮消息（QQ / 微信 / 剪贴板预览）观察云朵气泡出现的一帧，小狗不应左右抖动。
