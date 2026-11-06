# 交付前检查项

发布前必须逐项过一遍，自动化检查脚本是最后一道闸门：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-release-artifacts.ps1 `
  release\vX.Y.Z\Maltese-X.Y.Z-x64-setup.exe `
  release\vX.Y.Z\Maltese-assistant.exe
```

脚本会输出每件产物的大小、SHA-256、Authenticode 签名状态，并调用 Windows Defender
（`MpCmdRun.exe`）扫描；**检出威胁或扫描没能完成时退出码为 1**，发布流程应当中止。

## 清单

1. **版本一致**：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处相同。
2. **构建通过**：`tsc --noEmit`、`vite build`、`cargo check` 全部通过。
3. **文档同步**：README / `docs/` / `docs/releases/vX.Y.Z.md` 与本次改动一致。
4. **产物检查**：跑上面的脚本，确认「未发现威胁」；未签名会告警，要明确知道风险。
5. **签名**：有代码签名证书时必须签 exe 和安装包（`signtool sign /fd sha256 ...`）；
   没有证书时，发布说明里注明未签名，并提醒用户 SmartScreen 可能拦截。
6. **哈希与附件**：`SHA256SUMS-vX.Y.Z.txt` 与实际附件一致；GitHub Release 附件齐全
   （安装包、`.sig`、`latest.json`、便携 exe、zip、校验和）。
7. **更新链路**：`https://github.com/maolouis/Maltese/releases/latest/download/latest.json`
   返回新版本号，且安装包 URL 指向本次发布。

## 关于误报与 SmartScreen

未签名的 NSIS 安装包 + 新哈希 + 自带更新器，容易被 Defender / SmartScreen 或第三方杀软
按启发式判成风险。遇到拦截时先分清是哪一类：

- **「Windows 已保护你的电脑」/「发布者未知」**：SmartScreen 对未签名新文件的提醒，不是病毒。
  点「更多信息 → 仍要运行」即可；或者用 `scripts/install-latest.ps1`（PowerShell 下载不带
  Mark of the Web，不会触发提示，也会先结束旧实例再安装）。根本解决办法是代码签名。
- **Defender 弹出具体威胁名（如 Trojan:Win32/Wacatac）**：走误报流程，先本机复核。

处理步骤：

1. 先用本机 Defender 复核（上面的脚本），确认不是真的被感染。
2. 把文件哈希、下载地址、项目说明提交到
   <https://www.microsoft.com/en-us/wdsi/filesubmission> 申请误报复核（开发者可以同时提交
   文件申请 SmartScreen 信誉）。
3. 同时提供 zip 便携版和 `install-latest.ps1` 作为替代下载方式。
4. 根本解决办法是购买代码签名证书（OV/EV），长期能显著降低拦截率；**自签名证书无效**，
   Windows 不信任，SmartScreen 照样拦。
5. 可选渠道：提交 winget（`winget-pkgs`）或维护 Scoop bucket，包管理器下载同样不带标记。
