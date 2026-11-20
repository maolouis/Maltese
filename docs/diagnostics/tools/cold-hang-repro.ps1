# Cold-start hang repro + evidence collection (read-only diagnosis; no business code changes)
# ASCII only: Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI and mangles CJK comments.
$ErrorActionPreference = 'Continue'
$log = 'E:\Maltese\work\cold-hang-diag.log'
$dmpDir = 'E:\Maltese\work\hang'
$procdump = 'E:\tools\procdump\procdump64.exe'
$exe = 'E:\Maltese2\maltese-assistant.exe'
New-Item -ItemType Directory -Force $dmpDir | Out-Null

function L([string]$t) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $t) -Encoding utf8
  Write-Host $t
}
Set-Content -Path $log -Value ("cold-start hang repro " + (Get-Date -Format o)) -Encoding utf8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
}
"@

function Get-UiThread([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  [uint32]$procOfWin = 0
  $tid = [W32]::GetWindowThreadProcessId($hwnd, [ref]$procOfWin)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W32]::GetWindowTextW($hwnd, $sb, 256)
  $cn = New-Object System.Text.StringBuilder 256
  [void][W32]::GetClassNameW($hwnd, $cn, 256)
  return [pscustomobject]@{ Thread = [int]$tid; Title = $sb.ToString(); Class = $cn.ToString() }
}

function Get-Wv2Count([string]$tag) {
  $wv2 = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)maltese' })
  L ("{0} msedgewebview2.maltese={1} [{2}]" -f $tag, $wv2.Count, (($wv2 | ForEach-Object { $_.ProcessId }) -join ','))
}

function Get-ModOf([uint64]$addr, $mods) {
  foreach ($m in $mods) {
    $b = [uint64]$m.BaseAddress
    if ($addr -ge $b -and $addr -lt ($b + [uint64]$m.ModuleMemorySize)) {
      return ("{0}+0x{1:x}" -f $m.ModuleName, ($addr - $b))
    }
  }
  return ("0x{0:x}" -f $addr)
}

function DumpThreads([string]$tag, $p) {
  $mods = $p.Modules
  L ("{0} --- thread evidence ---" -f $tag)
  $p.Threads | Group-Object ThreadState | Sort-Object Count -Descending | ForEach-Object { L ("{0}   state {1} = {2}" -f $tag, $_.Name, $_.Count) }
  $p.Threads | Group-Object WaitReason | Sort-Object Count -Descending | ForEach-Object { L ("{0}   waitreason {1} = {2}" -f $tag, $_.Name, $_.Count) }
  $ui = Get-UiThread $p.MainWindowHandle
  if ($ui) { L ("{0} mainWindow '{1}' class='{2}' uiThread={3}" -f $tag, $ui.Title, $ui.Class, $ui.Thread) }
  else { L ("{0} mainWindow=none" -f $tag) }
  foreach ($t in $p.Threads) {
    $sa = [uint64]$t.StartAddress.ToInt64()
    $isUi = '-'
    if ($ui -and $ui.Thread -eq [int]$t.Id) { $isUi = 'YES' }
    L ("{0}   tid={1} ui={2} state={3} wait={4} start={5}" -f $tag, $t.Id, $isUi, $t.ThreadState, $t.WaitReason, (Get-ModOf $sa $mods))
  }
}

# ---------- 0. baseline on the currently running instance ----------
$existing = @(Get-Process maltese-assistant -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  $e0 = $existing[0]
  L ("BASELINE existing pid={0} resp={1} cpu={2} threads={3}" -f $e0.Id, $e0.Responding, [math]::Round($e0.CPU, 2), $e0.Threads.Count)
  Get-Wv2Count 'BASELINE'
  DumpThreads 'BASELINE' $e0
} else { L 'BASELINE no running instance' }

$hangCount = 0
$healthyCount = 0
$rounds = 6

for ($r = 1; $r -le $rounds; $r++) {
  Get-Process maltese-assistant -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
  $leftover = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)maltese' })
  L ("R{0} pre leftover_wv2={1} [{2}]" -f $r, $leftover.Count, (($leftover | ForEach-Object { $_.ProcessId }) -join ','))

  $err = "E:\Maltese\work\hang\cold-r$r.err.log"
  Remove-Item $err -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $exe -RedirectStandardError $err -PassThru
  $targetPid = $proc.Id

  $timeline = @()
  for ($s = 0; $s -lt 14; $s++) {
    Start-Sleep -Milliseconds 1000
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $p) { $timeline += ("t{0}s=gone" -f ($s + 1)); break }
    $timeline += ("t{0}s resp={1} cpu={2} thr={3}" -f ($s + 1), $p.Responding, [math]::Round($p.CPU, 2), $p.Threads.Count)
  }
  L ("R{0} timeline: {1}" -f $r, [string]::Join(' | ', $timeline))

  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $p) { L ("R{0} process exited early (single-instance lock? crash?)" -f $r); continue }

  $resp = $p.Responding
  L ("R{0} verdict resp={1} cpu={2} threads={3}" -f $r, $resp, [math]::Round($p.CPU, 2), $p.Threads.Count)
  DumpThreads "R$r" $p
  Get-Wv2Count "R$r"
  L ("R{0} --- stderr tail ---" -f $r)
  Get-Content $err -ErrorAction SilentlyContinue | Select-Object -Last 14 | ForEach-Object { L ("R{0}   {1}" -f $r, $_) }

  if (-not $resp) {
    $hangCount++
    $stamp = Get-Date -Format 'HHmmss'
    $dmp = Join-Path $dmpDir ("hang-r{0}-{1}.dmp" -f $r, $stamp)
    L ("R{0} HANG -> procdump {1}" -f $r, $dmp)
    & $procdump -ma -accepteula $targetPid $dmp 2>&1 | ForEach-Object { L ("R{0}   pd: {1}" -f $r, $_) }
    if (Test-Path $dmp) {
      $fi = Get-Item $dmp
      L ("R{0} DMP ok path={1} size={2}MB time={3}" -f $r, $fi.FullName, [math]::Round($fi.Length / 1MB, 1), $fi.LastWriteTime)
    } else { L ("R{0} DMP FAILED" -f $r) }
    Get-Process -Id $targetPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  } else {
    $healthyCount++
    L ("R{0} HEALTHY" -f $r)
    Get-Process -Id $targetPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  if ($hangCount -ge 3) { L 'got 3 hang samples, stop early'; break }
}

L ("SUMMARY rounds hang={0} healthy={1}" -f $hangCount, $healthyCount)
Get-ChildItem $dmpDir -Filter '*.dmp' | ForEach-Object { L ("DMP {0} {1}MB {2}" -f $_.FullName, [math]::Round($_.Length / 1MB, 1), $_.LastWriteTime) }
L 'DONE'