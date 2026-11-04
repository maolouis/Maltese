# Maltese DSH 插件

把已经构建好的 Maltese（线条小狗桌宠）接入 DeepSeek Harness：

- DSH 启动或启用插件时，自动唤醒原生的 `maltese-assistant.exe`。
- 向 Agent 注册 `maltese_pet` 工具：`open` 启动桌宠，`status` 查看是否在运行。
- 桌宠仍然是独立的 Tauri 原生窗口，不是网页 iframe，也不读取桌面内容。

本插件**不包含 exe**。请先安装 Maltese，或让插件找到构建产物。

## 安装

在 DSH 插件管理里选择“从本地目录安装”，目标指向本目录；也可以在仓库根目录执行（具体命令以当前 DSH 版本为准）：

```bash
dsh plugin install ./dsh-plugin
```

安装后插件会出现在插件列表中，标题为“Maltese 线条小狗桌宠”。

## 找到 exe

按以下顺序查找：

1. 插件配置 `executablePath`
2. 环境变量 `MALTESE_EXE`
3. 本目录、仓库根目录、当前工作目录下的 `release/<version>/maltese-assistant.exe`（取最新修改的版本）
4. `%LOCALAPPDATA%\Programs\Maltese\maltese-assistant.exe`
5. `%LOCALAPPDATA%\Maltese\maltese-assistant.exe`
6. `%ProgramFiles%\Maltese\maltese-assistant.exe`

本机开发时，如果 `E:\Maltese\release\v1.1.3\maltese-assistant.exe` 存在，插件会自动找到它。

自定义路径可以写进插件配置：

```yaml
- insert:
    - id: maltese-dsh
      name: 'maltese-dsh'
      config:
        autoLaunch: true
        executablePath: 'C:\Tools\Maltese\maltese-assistant.exe'
```

或者设置用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable("MALTESE_EXE", "C:\Tools\Maltese\maltese-assistant.exe", "User")
```

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoLaunch` | `true` | DSH 启动/启用插件时自动打开桌宠 |
| `executablePath` | 空 | 显式指定 exe；留空则自动查找 |

## 卸载

在 DSH 插件管理里移除 `maltese-dsh` 即可。它不会删除 Maltese 本体，也不会删除桌宠的待办、剪贴板或聊天记录。