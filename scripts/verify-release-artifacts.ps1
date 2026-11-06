# 交付前检查：签名状态、Windows Defender 扫描、SHA-256。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/verify-release-artifacts.ps1 release\v1.3.5\*.exe ...
#
# 任何一件产物被 Defender 判定为威胁时退出码为 1，发布流程应当中止。
# 未签名只会告警：没有代码签名证书时无法避免，但至少要让人看见。

param(
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths
)

$ErrorActionPreference = "Stop"

if (-not $Paths -or $Paths.Count -eq 0) {
  Write-Host "用法: verify-release-artifacts.ps1 <产物路径> [更多产物...]" -ForegroundColor Yellow
  exit 2
}

$defender = "C:\Program Files\Windows Defender\MpCmdRun.exe"
$failed = $false

foreach ($path in $Paths) {
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host "[缺失] $path" -ForegroundColor Red
    $failed = $true
    continue
  }

  $file = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
  $signature = Get-AuthenticodeSignature -LiteralPath $path

  Write-Host ""
  Write-Host ("== {0}" -f $file.Name)
  Write-Host ("   大小   : {0:N1} MB" -f ($file.Length / 1MB))
  Write-Host ("   SHA256 : {0}" -f $hash)
  Write-Host ("   签名   : {0}" -f $signature.Status)
  if ($signature.Status -ne "Valid") {
    Write-Host "   [警告] 未签名或签名无效：SmartScreen / 杀软更容易拦截，建议用代码签名证书签后再发布。" -ForegroundColor Yellow
  }

  if (Test-Path -LiteralPath $defender) {
    $fullPath = [System.IO.Path]::GetFullPath($file.FullName)
    $output = & $defender -Scan -ScanType 3 -File $fullPath -DisableRemediation 2>&1
    $code = $LASTEXITCODE
    $text = ($output | Out-String)
    Write-Host ("   Defender: 退出码 {0}" -f $code)
    # MpCmdRun 的退出码：0 干净，2 发现威胁，其它为扫描失败（不能让失败当成通过）。
    if ($code -eq 0 -and $text -match "found no threats") {
      Write-Host "   Defender: 未发现威胁" -ForegroundColor Green
    } elseif ($code -eq 2) {
      Write-Host "   Defender: 检出威胁，需要人工复核上面的输出" -ForegroundColor Red
      Write-Host $text.Trim()
      $failed = $true
    } else {
      Write-Host ("   Defender: 扫描没有完成（退出码 {0}），按检查失败处理" -f $code) -ForegroundColor Red
      Write-Host $text.Trim()
      $failed = $true
    }
  } else {
    Write-Host "   Defender: 本机没有 MpCmdRun.exe，跳过病毒扫描" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($failed) {
  Write-Host "交付前检查未通过。" -ForegroundColor Red
  exit 1
}
Write-Host "交付前检查通过。" -ForegroundColor Green
exit 0
