# 界面与桌宠自定义字体

设置页（独立设置窗口「显示」卡片与岛内展开设置「布局设置」）提供两个字体下拉项：

| 设置 | 作用范围 | CSS 变量 |
| --- | --- | --- |
| **界面字体** | 整个应用界面（`body`） | `--app-font-family` |
| **桌宠字体** | 聊天、气泡、状态条（`.pet-chat` / `.pet-bubble-cloud` / `.pet-bubble-panel` / `.pet-state`） | `--pet-font-family` |

## 自动检测系统现用与已安装字体

不需要手动记忆或输入字体名称，后端 `list_system_fonts` 命令（`src-tauri/src/system_fonts.rs`）会自动检测：

1. **系统现用字体（`activeFont`）**：通过 `SystemParametersInfoW(SPI_GETNONCLIENTMETRICS)` 读取 Windows 当前正在使用的界面/消息字体（如 `Microsoft YaHei UI` 或用户在系统级替换后的现用字体），置顶展示并标注「系统现用」；
2. **本机可用字体列表（`fonts`）**：通过 `CreateCompatibleDC` + `EnumFontFamiliesExW` 枚举本机已安装字体，自动过滤 `@` 竖排变体与纯符号图标字体（如 `Wingdings` / `Segoe MDL2 Assets`），并将现用字体与中文字体优先排列；
3. **内置预设**：保留 `默认（跟随系统现用字体）`、`像素字体（Fusion Pixel）`、`系统无衬线`、`系统衬线`。

## 回退策略与持久化

- 选中任意检测到的系统字体时，生成 `"<字体名>", "Maltese Emoji", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`；
- 字体名中的引号与特殊字符会自动清理，避免破坏 CSS；桌宠字体选默认时自动跟随界面字体；
- 字体值保存在设置 JSON（`settings.appFont` / `settings.petFont`），选择后立即写入根元素 CSS 变量并持久化。
