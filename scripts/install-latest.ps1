# 用 PowerShell 直接安装最新版 Maltese。
#
# 为什么需要它：浏览器下载的文件会带上「来自其他计算机」标记（Mark of the Web），
# 未签名的新文件会被 Microsoft Defender SmartScreen 拦成「未知发布者」。
# PowerShell 的 Invoke-WebRequest 下载不会写这个标记，所以用脚本安装可以绕开提示。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1            # 下载并静默安装
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1 -CheckOnly # 只下载校验，不安装
#   powershell -ExecutionPolicy Bypass -File scripts\install-latest.ps1 -Portable  # 下载便携版到桌面

param(
  [switch]$CheckOnly,
  [switch]$Portable
)

$ErrorActionPreference = "Stop"
$repo = "maolouis/Maltese"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Download([string]$url, [string]$path) {
  Write-Host ("下载 {0} …" -f (Split-Path $path -Leaf))
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
  Unblock-File -LiteralPath $path -ErrorAction SilentlyContinue
}

# 优先读 latest.json：GitHub API 对匿名请求有速率限制，latest.json 走的是
# releases/latest 的 CDN 跳转，不占配额。API 只作为兜底。
$manifestUrl = "https://github.com/$repo/releases/latest/download/latest.json"
$manifest = $null
try {
  $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing
} catch {
  Write-Host "latest.json 读取失败，改用 GitHub API…" -ForegroundColor Yellow
}

if ($manifest) {
  $version = "v" + $manifest.version
  $installerUrl = $manifest.platforms.'windows-x86_64'.url
  if (-not $installerUrl) { throw "latest.json 里没有 windows-x86_64 的下载地址。" }
  $assetName = Split-Path $installerUrl -Leaf
  $zipUrl = "https://github.com/$repo/releases/download/$version/maltese-assistant-v$($manifest.version)-win64.zip"
} else {
  $headers = @{ "User-Agent" = "maltese-install-script"; "Accept" = "application/vnd.github+json" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
  $version = $release.tag_name
  $asset = $release.assets | Where-Object { $_.name -like "Maltese-*-x64-setup.exe" } | Select-Object -First 1
  if (-not $asset) { throw "没有找到安装包。" }
  $installerUrl = $asset.browser_download_url
  $assetName = $asset.name
  $zipUrl = "https://github.com/$repo/releases/download/$version/maltese-assistant-$version-win64.zip"
}

Write-Host ("最新版本：{0}" -f $version)
$work = Join-Path $env:TEMP "maltese-install"
New-Item -ItemType Directory -Force -Path $work | Out-Null

if ($Portable) {
  $zipPath = Join-Path $work "maltese-assistant-$version-win64.zip"
  Download $zipUrl $zipPath
  $dest = Join-Path ([Environment]::GetFolderPath("Desktop")) "Maltese"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Write-Host ("解压到 {0} …" -f $dest)
  Expand-Archive -LiteralPath $zipPath -DestinationPath $dest -Force
  Get-ChildItem $dest -Filter *.exe | ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
  $exe = Join-Path $dest "Maltese-assistant.exe"
  if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $dest "maltese-assistant.exe" }
  if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
  Write-Host ("完成：{0}" -f $dest) -ForegroundColor Green
  return
}

$target = Join-Path $work $assetName
Download $installerUrl $target

# 校验哈希：Release 同时上传了 SHA256SUMS-vX.Y.Z.txt
$sumsUrl = "https://github.com/$repo/releases/download/$version/SHA256SUMS-$version.txt"
$sumsPath = Join-Path $work "SHA256SUMS-$version.txt"
try {
  Download $sumsUrl $sumsPath
  $expected = $null
  foreach ($line in Get-Content -LiteralPath $sumsPath) {
    if ($line -match "^\s*([0-9a-fA-F]{64})\s+\*?(.+)$" -and $Matches[2].Trim() -eq $assetName) {
      $expected = $Matches[1].ToLower()
    }
  }
  $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
  if ($expected) {
    if ($expected -ne $actual) { throw "哈希不匹配，文件可能下载损坏：期望 $expected，实际 $actual" }
    Write-Host "哈希校验通过。" -ForegroundColor Green
  } else {
    Write-Host ("校验文件里没有 {0}，跳过比对（实际 {1}）。" -f $assetName, $actual) -ForegroundColor Yellow
  }
} catch {
  Write-Host ("跳过哈希校验：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

if ($CheckOnly) {
  Write-Host ("已下载并校验：{0}" -f $target) -ForegroundColor Green
  return
}

# 安装前先结束正在运行的旧实例，否则单实例插件会让新进程静默退出，看起来像“打不开”。
$running = Get-Process -Name "maltese-assistant" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host ("结束正在运行的 Maltese（{0} 个进程）…" -f @($running).Count)
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

Write-Host "静默安装…"
$installer = Start-Process -FilePath $target -ArgumentList "/S" -PassThru
$finished = $true
try {
  Wait-Process -Id $installer.Id -Timeout 180 -ErrorAction Stop
} catch {
  $finished = $false
  Write-Host "安装程序 180 秒没有结束，改为直接替换安装目录里的 exe。" -ForegroundColor Yellow
}

if (-not $finished) {
  Stop-Process -Id $installer.Id -Force -ErrorAction SilentlyContinue
  $installLocation = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  ) | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -like "*Maltese*" } |
    Select-Object -First 1 -ExpandProperty InstallLocation

  if ($installLocation -and (Test-Path -LiteralPath $installLocation.Trim('"'))) {
    $dir = $installLocation.Trim('"')
    $portableDir = Join-Path $work "portable"
    if (-not (Test-Path -LiteralPath $portableDir)) {
      Download $zipUrl (Join-Path $work "portable.zip")
      Expand-Archive -LiteralPath (Join-Path $work "portable.zip") -DestinationPath $portableDir -Force
    }
    $newExe = Get-ChildItem $portableDir -Filter *.exe | Select-Object -First 1
    if ($newExe) {
      Copy-Item $newExe.FullName (Join-Path $dir "maltese-assistant.exe") -Force
      Write-Host ("已用便携版覆盖：{0}" -f (Join-Path $dir "maltese-assistant.exe")) -ForegroundColor Green
    }
  }
}

$installed = $null
$installLocation = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
) | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.DisplayName -like "*Maltese*" } |
  Select-Object -First 1 -ExpandProperty InstallLocation

$candidates = @()
if ($installLocation) { $candidates += (Join-Path ($installLocation.Trim('"')) "maltese-assistant.exe") }
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
