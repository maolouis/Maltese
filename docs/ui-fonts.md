# 界面与桌宠自定义字体

设置页「显示」卡片提供两个字体项：

| 设置 | 作用范围 | CSS 变量 |
| --- | --- | --- |
| **界面字体** | 整个应用界面（`body`） | `--app-font-family` |
| **桌宠字体** | 聊天、气泡、状态条（`.pet-chat` / `.pet-bubble-cloud` / `.pet-bubble-panel` / `.pet-state`） | `--pet-font-family` |

## 可选项

- `默认（系统）`：不覆盖（跟随全局字体栈）；
- `像素字体（Fusion Pixel）`：内置 `@font-face` 像素字体；
- `系统无衬线`：`Segoe UI / system-ui`；
- `系统衬线`：`Noto Serif SC / Songti SC / Georgia`；
- **自定义字体名**：输入任意本机已安装字体名（如 `华文中宋`），会生成
  `"<字体名>", "Maltese Emoji", "Microsoft YaHei", system-ui, sans-serif`。

## 回退策略

- 字体不存在时，浏览器按 CSS 堆栈自动回退到系统字体（不会白屏/报错）；
- 自定义字体名里的引号会被清理，避免破坏 CSS；
- 桌宠字体留空时跟随界面字体。

## 持久化

字体值存在设置 JSON（`settings.appFont` / `settings.petFont`），改完自动保存；
启动时 `applyFontVariables()` 写入根元素 CSS 变量。
