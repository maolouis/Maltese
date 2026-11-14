# Maltese 插件

Maltese 的「插件」页同时管理内置功能和第三方插件。当前的「自动刷视频」就是
内置插件；第三方开发者不需要重新编译 Maltese，只要提供插件文件夹即可。

## 插件目录

点击插件页的「打开插件目录」会打开：

```
%APPDATA%\<应用标识>\plugins\
```

每个插件是其中一个子文件夹，根目录必须有 `plugin.json`。也可以点击
「安装插件」，粘贴插件文件夹路径，Maltese 会把它复制到插件目录。

> 目前安装入口接收的是**文件夹**。从 GitHub 下载的 zip 请先解压，再选择解压后的
> 文件夹（文件夹里应直接看到 `plugin.json`）。

## plugin.json

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "0.1.0",
  "description": "一个最小插件示例",
  "author": "your-name",
  "homepage": "https://github.com/you/hello-world",
  "actions": [
    {
      "id": "say-hello",
      "label": "打招呼",
      "description": "弹出一个小窗口",
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "${pluginDir}\\hello.ps1"
      ]
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，只能包含字母、数字、`.`、`_`、`-`，不能以 `.` 开头 |
| `name` | 是 | 显示名称 |
| `version` | 否 | 插件版本，默认 `0.0.0` |
| `description` | 否 | 插件说明 |
| `author` | 否 | 作者 |
| `homepage` | 否 | 项目地址，只用于展示 |
| `ui` | 否 | 插件自带页面的文件名（相对插件目录，例如 `index.html`）；有它时「打开」会加载这个页面 |
| `actions` | 否 | 可执行动作列表；没有动作时插件只作为说明展示 |

每个 action：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 动作唯一标识 |
| `label` | 是 | 按钮文字 |
| `description` | 否 | 悬停提示 |
| `command` | 是 | 要启动的可执行文件，例如 `powershell.exe`、`python.exe`、插件自带的 exe |
| `args` | 否 | 参数数组，不经过 shell，避免拼接注入 |

`command` 和每个参数里的 `${pluginDir}`（也兼容 `${plugin_dir}`）会替换成插件
所在文件夹的绝对路径，适合调用插件自带的脚本或资源。

## 插件自己的页面（ui 字段）

每个插件在「插件窗口」里有独立的一页，不再挤在插件中心的列表里：

- 第三方插件在清单里写 `"ui": "index.html"`，宿主就把插件目录里的这个文件装进
  iframe 显示。页面可以是任何前端技术写的静态文件，页面内的相对路径资源同样
  会从插件目录加载。
- 写 `"ui": "host"` 表示界面由宿主渲染。**自动刷视频、关系就是这样分发的**：它们的
  `plugin.json` 在 `examples/plugins/video-automation`、`examples/plugins/relationship`，
  用 `scripts/pack-plugins.ps1` 打成 zip 后由用户自行安装，应用本身不内置、不预置任何插件。
  桌面图标台球仍走自己的卡片（不是插件）。

插件页面里的 iframe 与宿主隔离，只能用自己的前端能力；需要启动本机程序时，仍然
在插件中心点它声明的动作。

## 分发、安装、停用和卸载

- **默认不安装任何插件**，插件中心初始是空的。
- 每个插件打成一个独立 zip：`powershell -File scripts/pack-plugins.ps1 -OutputDir <目录>`，
  压缩包里带一层同名目录，根目录含 `plugin.json`。
- **安装**：把插件 zip 或文件夹路径粘进插件中心点「安装插件」即可，zip 由宿主解压
  （只取含 `plugin.json` 的那一层目录）；也可以把文件夹放进插件目录后点「刷新」。
- **停用**：只在本机记录停用状态，不删除文件；重新启用后动作恢复。
- **卸载**：只删除 `%APPDATA%` 插件目录里的副本，不会动你原来的开发目录和 zip。
- **预置目录**：宿主也会扫描 `<安装目录>\resources\plugins`（标「预置」、只读），
  但默认发布不带任何预置插件；用户目录里同 id 的插件会覆盖它。

## 安全模型

插件动作会以当前 Windows 用户权限启动本机程序。它**不会**被注入到 WebView，
也不会获得 Maltese 的内部 API；但被启动的程序本身拥有和你在终端运行它相同的
权限。因此：

- 只安装你信任的来源；
- 发布插件时把源码放在仓库里，方便用户审查；
- 不要要求用户以管理员身份运行 Maltese；
- 如果插件需要长期后台运行，应自己提供退出方式，避免残留进程。

## 最小示例

仓库里的 `examples/plugins/hello-world/` 是最小示例，可用 `scripts/pack-plugins.ps1`
打成 `hello-world.zip`：

1. 在插件中心把 zip 路径粘进去点「安装插件」；
2. 装好后点「打开」，会看到插件自带的 `index.html` 页面；
3. 它同时声明了一个「打招呼」动作，会用 PowerShell 弹一个窗口；
4. 想改着玩：复制整个文件夹到别处改完，卸载旧的再装新的。

## 版本约定

- `plugin.json` 的 `id` 一旦发布就应保持稳定；升级时用相同 `id` 覆盖安装目录
  中的文件（或先卸载再安装），不要改 id。
- 宿主不会自动更新第三方插件；插件作者应在自己的仓库发布新版本。
- 自动刷视频、关系等宿主渲染的插件跟随 Maltese 主版本一起打包成 zip，不单独升级。