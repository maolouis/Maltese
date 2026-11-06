# 用 PowerShell 直接安装最新版 Maltese。
#
# 为什么需要它：浏览器下载的文件会带上「来自其他计算机」标记（Mark of the Web），
# 未签名的新文件会被 Microsoft Defender SmartScreen 拦成「未知发布者」。
# PowerShell 的 Invoke-WebRequest 下载不会写这个标记，所以用脚本安装可以绕开提示。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1            # 下载并静默安装
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1 -CheckOnly # 只下载校验，不安装
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1 -Portable  # 下载便携 exe 到桌面

param(
  [switch]$CheckOnly,
  [switch]$Portable
)

$ErrorActionPreference = "Stop"
$repo = "maolouis/Maltese"
$headers = @{ "User-Agent" = "maltese-install-script"; "Accept" = "application/vnd.github+json" }
$utf8 = New-Object System.Text.UTF8Encoding($false)

Write-Host "查询最新版本…"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$version = $release.tag_name
Write-Host ("最新版本：{0}" -f $version)

$wantPortable = $Portable
$pattern = if ($wantPortable) { "maltese-assistant-*-win64.zip" } else { "Maltese-*-x64-setup.exe" }
$asset = $release.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
if (-not $asset) { throw "这个版本没有找到匹配的安装包（$pattern）。" }

$work = Join-Path $env:TEMP "maltese-install"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$target = Join-Path $work $asset.name

Write-Host ("下载 {0}（{1:N1} MB）…" -f $asset.name, ($asset.size / 1MB))
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -UseBasicParsing
# 保险起见再解除一次标记；Invoke-WebRequest 通常不会写 Zone.Identifier。
Unblock-File -LiteralPath $target -ErrorAction SilentlyContinue

# 校验哈希：Release 里同时上传了 SHA256SUMS-vX.Y.Z.txt
$sumsAsset = $release.assets | Where-Object { $_.name -like "SHA256SUMS-*.txt" } | Select-Object -First 1
if ($sumsAsset) {
  $sumsPath = Join-Path $work $sumsAsset.name
  Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsPath -UseBasicParsing
  $expected = $null
  foreach ($line in Get-Content -LiteralPath $sumsPath) {
    if ($line -match "^\s*([0-9a-fA-F]{64})\s+\*?(.+)$" -and $Matches[2].Trim() -eq $asset.name) {
      $expected = $Matches[1].ToLower()
    }
  }
  $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
  if ($expected) {
    if ($expected -ne $actual) { throw "哈希不匹配，文件可能下载损坏：期望 $expected，实际 $actual" }
    Write-Host "哈希校验通过。" -ForegroundColor Green
  } else {
    Write-Host ("校验文件里没有 {0}，跳过比对（实际 {1}）。" -f $asset.name, $actual) -ForegroundColor Yellow
  }
}

if ($CheckOnly) {
  Write-Host ("已下载并校验：{0}" -f $target) -ForegroundColor Green
  return
}

if ($wantPortable) {
  $dest = Join-Path ([Environment]::GetFolderPath("Desktop")) "Maltese"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Write-Host ("解压到 {0} …" -f $dest)
  Expand-Archive -LiteralPath $target -DestinationPath $dest -Force
  Get-ChildItem $dest -Filter *.exe | ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
  $exe = Join-Path $dest "Maltese-assistant.exe"
  if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
  Write-Host ("完成：{0}" -f $dest) -ForegroundColor Green
  return
}

# 安装前先结束正在运行的旧实例，否则单实例插件会让新进程静默退出，看起来像“打不开”。
$running = Get-Process -Name "Maltese-assistant" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host ("结束正在运行的 Maltese（{0} 个进程）…" -f @($running).Count)
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

Write-Host "静默安装…"
$installer = Start-Process -FilePath $target -ArgumentList "/S" -PassThru -Wait
if ($installer.ExitCode -ne 0) { throw ("安装程序返回 {0}" -f $installer.ExitCode) }

$installed = $null

# 安装目录名带中文和空格，直接猜路径容易猜错；优先读注册表里的 InstallLocation。
$installLocation = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
) | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.DisplayName -like "*Maltese*" } |
  Select-Object -First 1 -ExpandProperty InstallLocation

$candidates = @()
if ($installLocation) {
  $candidates += (Join-Path ($installLocation.Trim('"')) "maltese-assistant.exe")
}
$candidates += (Join-Path $env:LOCALAPPDATA "Maltese 线条小狗桌面助手\maltese-assistant.exe")
$candidates += (Join-Path $env:LOCALAPPDATA "Maltese\Maltese-assistant.exe")
$candidates += (Join-Path $env:ProgramFiles "Maltese\Maltese-assistant.exe")
$installed = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($installed) {
  Write-Host ("已安装：{0}" -f $installed) -ForegroundColor Green
  Start-Process -FilePath $installed
} else {
  Write-Host "安装完成，请从开始菜单启动 Maltese。" -ForegroundColor Green
}
