param(
  [string]$Exe = 'E:\Maltese\src-tauri\target\release\maltese-assistant.exe',
  [string]$DataDir = 'E:\Maltese\work\data-cold-verify',
  [string]$ProfileDir = 'E:\Maltese\.tmp-build\wv-cold-verify',
  [string]$Tag = 'cold-verify',
  [int]$Rounds = 20,
  [int]$SampleSeconds = 15,
  [string]$LogRoot = 'E:\Maltese\work'
)
# Cold-start hang verification rounds (2026-11-26 rewrite of the 2026-11-20 repro script).
#
# Per round: kill leftovers -> 4s cool-down -> launch -> sample Responding/CPU/threads for
# $SampleSeconds -> verdict from stderr (frontend_ready + heartbeat + watchdog + MUTEX_TRACE).
# A round PASSES only when Responding=True and the frontend handshake + heartbeat are present.
# Failed rounds still get a procdump snapshot (if available) plus the stderr tail.
#
# Environment notes (agent sessions):
#  * E:\Maltese2\data is not writable -> keep MALTESE_DATA_DIR under the workspace;
#  * the default WebView2 profile may be in use by another holder (HRESULT 0x800700AA
#    "resource in use"), which makes the webview fail to create and invalidates every
#    observation -> pass an explicit WEBVIEW2_USER_DATA_FOLDER owned by this session;
#  * MALTESE_MUTEX_TRACE=1 turns on the lock probe (contention-only logs) in the app.
#
# ASCII only: Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI and mangles CJK.
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $LogRoot $Tag
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'rounds.log'

function L([string]$t) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $t
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

Set-Content -Path $log -Value ("cold rounds tag=$Tag exe=$Exe rounds=$Rounds start=" + (Get-Date -Format o)) -Encoding utf8
$env:MALTESE_DATA_DIR = $DataDir
$env:WEBVIEW2_USER_DATA_FOLDER = $ProfileDir
$env:TEMP = 'E:\Maltese\.tmp-build'
$env:TMP = $env:TEMP
$env:MALTESE_LOG = 'warn'
$env:MALTESE_MUTEX_TRACE = '1'
New-Item -ItemType Directory -Force $DataDir, $ProfileDir, $env:TEMP | Out-Null
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
$summary = @()

for ($r = 1; $r -le $Rounds; $r++) {
  Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
  $err = Join-Path $logDir ("r{0}.err.log" -f $r)
  $out = Join-Path $logDir ("r{0}.out.log" -f $r)
  Remove-Item $err, $out -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $Exe -RedirectStandardError $err -RedirectStandardOutput $out -PassThru
  $timeline = @()
  for ($s = 0; $s -lt $SampleSeconds; $s++) {
    Start-Sleep -Milliseconds 1000
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $p) { $timeline += ("t{0}=gone" -f ($s + 1)); break }
    $timeline += ("t{0}=resp={1},cpu={2},thr={3}" -f ($s + 1), $p.Responding, [math]::Round($p.CPU, 2), $p.Threads.Count)
  }
  $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($p) {
    $resp = $p.Responding
    $thr = $p.Threads.Count
    $cpu = [math]::Round($p.CPU, 2)
  } else {
    $resp = 'gone'; $thr = 0; $cpu = 0
  }
  $stderr = @()
  if (Test-Path $err) { $stderr = @(Get-Content $err) }
  $hasReady = [bool]($stderr | Select-String -Pattern 'frontend reported first paint ready' -Quiet)
  $hasHeartbeat = [bool]($stderr | Select-String -Pattern 'heartbeat frontend_ready' -Quiet)
  $hasWatchdog = [bool]($stderr | Select-String -Pattern 'STARTUP_WATCHDOG' -Quiet)
  $hasTrace = [bool]($stderr | Select-String -Pattern 'MUTEX_TRACE' -Quiet)
  $lastStartup = $stderr | Select-String -Pattern '\[startup\]' | Select-Object -Last 1
  $ok = ($resp -eq $true) -and $hasReady -and $hasHeartbeat
  L ("R{0} RESULT responding={1} threads={2} cpu={3} frontend_ready={4} heartbeat={5} watchdog={6} mutex_trace={7} ok={8}" -f $r, $resp, $thr, $cpu, $hasReady, $hasHeartbeat, $hasWatchdog, $hasTrace, $ok)
  L ("R{0} timeline: {1}" -f $r, ($timeline -join ' | '))
  if ($lastStartup) { L ("R{0} last_startup: {1}" -f $r, $lastStartup.Line) }
  if ($hasTrace) {
    ($stderr | Select-String -Pattern 'MUTEX_TRACE' | Select-Object -Last 16) | ForEach-Object { L ("R{0} TRACE {1}" -f $r, $_.Line) }
  }
  if (-not $ok) {
    ($stderr | Select-Object -Last 40) | ForEach-Object { L ("R{0} tail: {1}" -f $r, $_) }
    if ((Test-Path 'E:\tools\procdump\procdump64.exe') -and $p) {
      $dump = Join-Path $logDir ("hang-r{0}.dmp" -f $r)
      & 'E:\tools\procdump\procdump64.exe' -ma -accepteula $proc.Id $dump 2>&1 | ForEach-Object { L ("R{0} pd: {1}" -f $r, $_) }
    }
  }
  if ($p) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $summary += [pscustomobject]@{ Round = $r; Responding = $resp; Threads = $thr; CPU = $cpu; FrontendReady = $hasReady; Heartbeat = $hasHeartbeat; Watchdog = $hasWatchdog; Trace = $hasTrace; Ok = $ok }
}

L 'SUMMARY:'
$summary | ForEach-Object { L ("  R{0} Responding={1} frontend_ready={2} heartbeat={3} watchdog_fired={4} ok={5}" -f $_.Round, $_.Responding, $_.FrontendReady, $_.Heartbeat, $_.Watchdog, $_.Ok) }
$okCount = @($summary | Where-Object { $_.Ok }).Count
L ("SUMMARY ok={0}/{1} logdir={2}" -f $okCount, $Rounds, $logDir)