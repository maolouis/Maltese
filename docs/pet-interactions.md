# 桌宠互动与情绪表达

## 互动场景

互动场景由 `src/petInteractions.ts` 描述，不再把双狗互动塞进单一的 `PetState`。
每个场景包含角色、动作、情绪、开始时间和持续时间。当前支持以下场景类型：

- `single-hop`：单角色轻跳和身体摆动
- `kick-ball`：两只小狗踢球和追球
- `duo-wave`：两只小狗互相招手
- `comfort`：一只小狗靠近陪伴
- `clone-wave`：分身同步挥手
- `celebrate`：庆祝和跳跃

场景层使用现有角色 GIF，并通过 CSS 位置轨迹和道具层组成伙伴、分身和球的连续动作。主狗的命中区域保持独立，互动伙伴不接收鼠标事件。素材缺失时回到角色动作回退链。

手动互动动作会触发对应场景。摸头进入单角色轻跳，`play` 和 `chase` 进入踢球场景，`spin` 和 `celebrate` 进入庆祝场景，`pickup` 和 `chin` 进入陪伴场景。

## 模型情绪标记

主动聊天提示词允许模型在正文后附加一个机器标记：

```text
[情绪:陪伴]
[互动:踢球]
```

`parsePetReply()` 会移除这些标记，再把正文交给气泡显示。正文兼容没有标记的旧回复。情绪无法解析时，程序根据当前前台活动和正文关键词推断情绪，并回落到陪伴或倾听场景。

模型只能选择白名单中的情绪和互动，不能指定 GIF 路径、脚本或任意 URL。

## 气泡规则

宠物说话使用无标题气泡，只显示正文。主动聊天、音乐切换、前台活动、整点提醒和夜间陪伴都通过 `showPetSpeech()` 显示。

更新提示、待办类别、消息来源、剪贴板摘要等系统信息仍然保留标题，以便区分来源和执行状态。

## 验证清单

- 预览模式：收起态互动面板中的「摸头 / 陪玩 / 追球 / 转圈」按钮直接触发对应场景，便于逐项检查动作与回退链。
- 场景数据：`PetInteractionSession` 固定记录场景、情绪、主角色、伙伴角色、开始时间和持续时间。
- 单角色、双狗并行和分身均使用独立生命周期计时器，新的场景会取消上一个场景。
- 双狗和分身场景能在主狗旁边显示伙伴，不覆盖主狗命中区域。
- 场景结束后伙伴和道具节点会自动清理。
- 单角色场景只给主狗加轻跳，不会额外生成伙伴节点。
- 缺少伙伴 GIF 时仍能使用角色动作回退链。
- 拖拽、睡眠和面板展开不会留下正在运行的互动层。
- 模型返回带标记和不带标记的文本都能正常显示。
- 宠物说话气泡不再出现“小狗想你了”类标题。
- 系统消息、更新提示和待办提醒仍能保留功能性标题。

自动化检查：`tests/pet-interactions.test.mjs` 覆盖标记解析、情绪与动作映射、单角色生命周期和双狗角色配对。桌面手动检查已进入运行中的 Maltese，看到互动面板和全部动作入口；本轮后续截图检查因物理 Esc 中止，未继续调用桌面工具。

## 「固定当前标签到桌面」（置顶窗口）2026-11-17 修复

**用户反馈**：把弹窗置于顶层的按钮失效。

### 定位

- 前端唯一相关的「置顶」入口是展开面板顶栏的 📌 按钮：
  `aria-label="固定当前标签到桌面"`（`src/App.tsx`，另有气泡里的
  `maltese-pin-current-page` 事件走同一条命令），调 IPC `pin_page_to_desktop`，
  对应窗口 label `pinned`（`src-tauri/src/window_factory.rs` 懒创建，规格
  `always_on_top: true`）。置顶窗口内的「取消固定 / 关闭这个窗口」调
  `unpin_page_from_desktop`。
- 三个调用点原来都是 `invoke(...).catch(() => undefined)`，**失败完全静默**，
  所以用户只能看到「点了没反应」。

### 真实失效点（代码 + 实机）

1. **首次固定丢页面**：`pin_page_to_desktop` 先 `window_factory::ensure` 建窗口，
   紧接着 `emit("maltese-pinned-page")`；新窗口前端还没挂载 listen，事件丢失，
   `PinnedPanel` 只能退回默认「聊天」。用户点「把待办固定到桌面」却得到聊天窗，
   看起来就是按钮没生效。
2. **最小化/隐藏后再点无反应**：原命令只做 `set_always_on_top` + `show()` +
   `set_focus()`，没有 `unminimize()`；`pinned` 窗口曾被「取消固定」隐藏或手动
   最小化时，`show()` 不会把它从最小化状态恢复。实机复现：对 `pinned` 窗口
   `ShowWindow(SW_MINIMIZE)` 后点 📌，窗口保持 `iconic=True`、位置仍是
   `-32000,-32000`。
3. 错误被吞：建窗/显示失败时前端没有任何提示（也没有 console 记录）。

### 修法

- Rust（`src-tauri/src/lib.rs`）：
  - 新增 `static PINNED_PAGE: Mutex<Option<String>>`：`pin_page_to_desktop`
    先记住目标页面，再建窗/显示/emit；`unpin_page_from_desktop` 清空。
  - 顺序改为 `unminimize()` → `show()` → `set_always_on_top(true)` →
    `set_focus()`，保证「重新固定」一定回到前台置顶。
  - 新增命令 `get_pinned_page()` 并注册到 `generate_handler!`。
- 前端：`PinnedPanel` 挂载后先 `invoke("get_pinned_page")` 拿到本次要固定的页面
  （兜底 localStorage），再订阅 `maltese-pinned-page` 做后续切换。
  三个 `pin_page_to_desktop` 调用点把 `.catch(() => undefined)` 改成
  `console.error(...)`，不再静默。

### 实机验证（UIA 点按钮 + 读 Win32 扩展样式）

| 步骤 | 实测 |
| --- | --- |
| 展开面板 → 点「固定当前标签到桌面」 | 新窗口 `固定在桌面的标签页` 出现：`visible=True`，`exstyle=0x40118` → `WS_EX_TOPMOST(0x8)` **为真** |
| 置顶窗口内容 | 在「待办」页固定后，窗口内是 `加一条待办，回车确认 / 经济学金融基础 …`（修复前退回「聊天」） |
| 最小化后再点 📌 | 修复后：`iconic=True → False`，`visible=True`，`topmost=True`，位置从 `-32000` 恢复到 `182,182` |
| 置顶窗口点「取消固定」 | 窗口 `visible=False`（隐藏）；再次点 📌 能重新显示 |
