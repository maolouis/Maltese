# 全屏避让与 Bongo / 陪伴狗显隐

全屏玩游戏或看视频时，桌上这些窗口要不要留，分三档各自独立：

| 设置项 | 影响对象 | 可选值 |
| --- | --- | --- |
| 全屏时（`fullscreenAvoid`） | 主狗 | 缩边 / 隐藏 / 不处理 |
| 全屏时 Bongo 也收起来（`fullscreenHideBongo`） | `bongo-pet` | 开（默认）/ 关 |
| 全屏时连陪伴狗 / 跟随小狗一起隐藏（`fullscreenHideExtras`） | `companion-1..4`、`cursor-pet` | 开（默认）/ 关 |

- 三项互不牵连：主狗选「不处理」时，Bongo 与陪伴狗仍然可以按自己的开关在全屏时消失；反过来关掉 Bongo 的开关，也不会影响主狗继续缩边。
- `fullscreenHideExtras` 只在主狗不是「不处理」时才显示在设置里（跟主狗一起收才有意义）；`fullscreenHideBongo` 始终显示。
- 用「显示 / 隐藏桌宠」快捷键或托盘隐藏主狗，是另一套语义：Bongo、陪伴狗、跟随小狗会和主狗一起消失，重新显示时按最近一次同步的配置原样放回。

## 前端如何驱动

`src/useIslandAutomation.ts` 的 `useFullscreenAvoid(behavior, active, isTucked, isTauri, onTuck, onReveal, hideExtras, hideBongo)` 每 2.5 秒问一次 `is_foreground_fullscreen`：

- 刚进入全屏：主狗按 `behavior` 处理（`hide` → `minimize_island`，`tuck` → 缩边；`off` 时不动），同时调 `set_extra_pets_hidden(hideExtras)` 与 `set_bongo_hidden(hideBongo)`。
- 退出全屏 / effect 清理：两个显隐都复位为 `false`，再按进入前的状态恢复主狗。
- `insideFullscreenRef` 记住“已经处理过这次全屏”，`extrasHiddenRef` / `bongoHiddenRef` 记住已下发的显隐，避免每次轮询都重复调用命令。

## 原生如何落地

`src-tauri/src/desktop_extras.rs`：

- `PETS_HIDDEN`、`BONGO_HIDDEN` 两个独立标志。
- `hide_companion_pets` / `restore_companion_pets`：只动 4 只陪伴狗与 `cursor-pet`。
- `hide_bongo` / `restore_bongo`：只动 `bongo-pet`。
- `hide_extra_pets` / `restore_extra_pets`：主狗被整体隐藏时用，两个标志一起置位，全部窗口一起收 / 放。
- `sync_bongo` 的显示条件是 `config.bongo_enabled && !bongo_hidden() && !pets_hidden()`，所以恢复时不会把用户已经关掉的 Bongo 又弹出来。

`src-tauri/src/lib.rs` 暴露两个命令：`set_extra_pets_hidden(hidden)`、`set_bongo_hidden(hidden)`，均注册在 `generate_handler!` 里。

## 验证

1. 主狗设「缩边」，Bongo 开关开、陪伴狗开关开 → 打开全屏视频：主狗缩边，Bongo 与陪伴狗消失；退出后各自回来。
2. 主狗设「缩边」，Bongo 开关关 → 全屏时 Bongo 留在桌上，主狗仍然缩边。
3. 主狗设「不处理」，Bongo 开关开、陪伴狗开关开 → 主狗原地不动，另两类仍然收起 / 恢复。
4. 用「显示 / 隐藏桌宠」快捷键在非全屏下隐藏再显示：Bongo 与陪伴狗按配置回来，且与上面三种设置组合不冲突。
