# 桌面图标台球（和小狗一起玩）

把 Windows 桌面图标当成一局台球：拉杆蓄力、松手击球，球会滚动、碰撞、入袋，小狗在旁边帮你加油。

## 入口

**插件页 →「桌面图标台球」→ 和小狗开一局**。

需要桌面图标处于显示状态；如果图标是隐藏的，插件卡片会直接提示先去显示图标。

## 玩法

- 按住左键从白球往上拉杆（拉得越远力度越大），松手击球；
- 瞄准时显示虚线轨迹和力度条；
- 白球撞到图标球且速度够快，图标球入袋 +1 分，小狗会喊「好球！」；
- 顶部条显示用时、进球、剩余、桌面图标数、杆数；
- `R` 重开（重新读取桌面图标摆球），`Esc` 或「退出」关闭。

## 和参考项目的取舍

玩法参考开源项目 [desktop-icon-billiards](https://github.com/liuxiaogang-com/desktop-icon-billiards)（作者 **GitHub@liuxiaogang-com**，MIT 许可）：它把桌面图标真的当成球在桌面上滚动、碰撞、入袋，退出后恢复。

Maltese 这一版**刻意不真的搬动桌面图标**：

- 真实移动图标需要跨进程写 explorer 的 `SysListView32` 位置（`LVM_SETITEMPOSITION`），
  一旦进程异常退出（崩溃、被强杀、断电），桌面布局就可能留在"打完球"的乱序状态；
- 所以这里改成一层透明覆盖窗口：读取图标真实屏幕位置（`LVM_GETITEMPOSITION` + 远程内存），
  在覆盖层里画出球、做物理和入袋，桌面本身完全不动。

界面右下角固定显示参考项目与作者署名，转发截图时请保留。

## 实现

- `src-tauri/src/desktop_icons.rs`：找到 `Progman/WorkerW → SHELLDLL_DefView → SysListView32`，
  用 `LVM_GETITEMCOUNT` / `LVM_GETITEMPOSITION` / `LVM_GETITEMSPACING` 读出图标数量、位置与格距，
  再用 `ClientToScreen` 换算成屏幕坐标。
- `src/Billiards.tsx`：canvas 游戏循环（摩擦、库边反弹、与图标球碰撞、入袋动画、小狗跟随与欢呼）。
- 窗口 `billiards`：透明、无边框、置顶、不占任务栏，打开时铺满主显示器工作区。

## 已知限制

- 需要 explorer 桌面正常响应窗口消息。若资源管理器正忙，读取会超时并提示"读取桌面图标数量超时"。
- 多显示器只铺主显示器；其他屏幕上的图标不参与这一局。
- 图标很多时最多取 300 个。