param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [string]$Tag = 'geom'
)
# Geometry smoke test for the "window events -> dirty flags -> geometry worker" refactor:
#   1. minimize / restore keeps the island rect (cache locks still work with try_lock),
#   2. a real mouse drag still updates island-rect.json (Moved path still records),
#   3. the app answers Responding throughout (no main-thread blocking).
# ASCII only (PS 5.1 + BOM-less UTF-8).
$ErrorActionPreference = 'Continue'
$logDir = 'E:\Maltese\work\cold-geom'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("$Tag.log")
function L([string]$t) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $t
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}
Set-Content -Path $log -Value ("geom smoke tag=$Tag start=" + (Get-Date -Format o)) -Encoding utf8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-Island([int]$targetPid, [switch]$VisibleOnly) {
  $script:best = $null
  $cb = [GW+EnumProc]{
    param($h, $l)
    $owner = 0
    [void][GW]::GetWindowThreadProcessId($h, [ref]$owner)
    if ([int]$owner -eq $targetPid) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][GW]::GetWindowText($h, $sb, 512)
      $title = $sb.ToString()
      $vis = [GW]::IsWindowVisible($h)
      $r = New-Object GW+RECT
      [void][GW]::GetWindowRect($h, [ref]$r)
      $w = $r.Right - $r.Left
      $h2 = $r.Bottom - $r.Top
      if ($title -like '*Maltese*' -and $w -gt 60 -and $r.Left -gt -30000) {
        if (-not $VisibleOnly -or $vis) {
          $script:best = [pscustomobject]@{ Hwnd = $h; Left = $r.Left; Top = $r.Top; Width = $w; Height = $h2; Title = $title; Visible = $vis }
        }
      }
    }
    return $true
  }
  [void][GW]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:best
}
function Rect-Text($w) { if ($w) { return ("{0},{1},{2},{3}" -f $w.Left, $w.Top, $w.Width, $w.Height) } return 'none' }

$env:MALTESE_DATA_DIR = $DataDir
$env:WEBVIEW2_USER_DATA_FOLDER = $ProfileDir
$env:TEMP = 'E:\Maltese\.tmp-build'
$env:TMP = $env:TEMP
$env:MALTESE_LOG = 'warn'
Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($Exe)) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$err = Join-Path $logDir ("$Tag.err.log")
Remove-Item $err -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $Exe -RedirectStandardError $err -PassThru
L ("launched pid=" + $proc.Id)

# 1) wait for frontend first-paint handshake (stderr marker)
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 250
  if ((Test-Path $err) -and (Select-String -Path $err -Pattern 'frontend reported first paint ready' -Quiet)) { $ready = $true; break }
}
L ("frontend_ready=$ready")
if (-not $ready) { Get-Content $err -Tail 20 | ForEach-Object { L ("  " + $_) }; Stop-Process -Id $proc.Id -Force; exit 2 }

# 2) let the 3s startup-restore window expire, then find the visible island window
Start-Sleep -Seconds 5
$island = Get-Island $proc.Id -VisibleOnly
if (-not $island) { $island = Get-Island $proc.Id }
$p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
L ("island rect=" + (Rect-Text $island) + " visible=$($island.Visible) responding=$($p.Responding)")
if (-not $island) { Stop-Process -Id $proc.Id -Force; exit 2 }

$rectFile = Join-Path $DataDir 'island-rect.json'
$snapshotBefore = 'none'
if (Test-Path $rectFile) { $snapshotBefore = Get-Content $rectFile -Raw }

# ---- minimize / restore ----
$before = Rect-Text $island
[void][GW]::ShowWindow($island.Hwnd, 6)   # SW_MINIMIZE
Start-Sleep -Milliseconds 2000
$p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
L ("after minimize responding=$($p.Responding)")
[void][GW]::ShowWindow($island.Hwnd, 9)   # SW_RESTORE
Start-Sleep -Milliseconds 2500
$after = Get-Island $proc.Id
$p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
$driftX = if ($after) { [math]::Abs($after.Left - $island.Left) } else { -1 }
$driftY = if ($after) { [math]::Abs($after.Top - $island.Top) } else { -1 }
$minimizeOk = ($before -eq (Rect-Text $after)) -and ($driftX -le 2) -and ($driftY -le 2)
L ("MINIMIZE_RESTORE before=$before after=$(Rect-Text $after) drift=$driftX,$driftY responding=$($p.Responding) ok=$minimizeOk")

# ---- drag by 40px right / 32px up ----
$island = Get-Island $proc.Id
if ($island -and $minimizeOk) {
  $cx = [int]($island.Left + $island.Width / 2)
  $cy = [int]($island.Top + $island.Height * 0.6)
  [void][GW]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 200
  [void][GW]::SetForegroundWindow($island.Hwnd)
  Start-Sleep -Milliseconds 150
  [GW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # left down
  Start-Sleep -Milliseconds 120
  for ($step = 1; $step -le 8; $step++) {
    [void][GW]::SetCursorPos($cx + 5 * $step, $cy - 4 * $step)
    Start-Sleep -Milliseconds 40
  }
  [GW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # left up
  Start-Sleep -Milliseconds 1500
  $dragged = Get-Island $proc.Id
  $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  $moved = if ($dragged -and $island) { [math]::Abs($dragged.Left - $island.Left) -ge 8 } else { $false }
  $snapshotAfter = 'none'
  if (Test-Path $rectFile) { $snapshotAfter = Get-Content $rectFile -Raw }
  $snapshotChanged = ($snapshotBefore -ne $snapshotAfter)
  $dragOk = $moved -and $snapshotChanged -and $p.Responding
  L ("DRAG before=$before drag_after=$(Rect-Text $dragged) moved=$moved snapshot_changed=$snapshotChanged responding=$($p.Responding) ok=$dragOk")
  L ("SNAPSHOT before=$($snapshotBefore -replace '\s+',' ') after=$($snapshotAfter -replace '\s+',' ')")
}

# ---- stderr evidence ----
$stderr = @()
if (Test-Path $err) { $stderr = @(Get-Content $err) }
$hasTrace = [bool]($stderr | Select-String -Pattern 'MUTEX_TRACE' -Quiet)
$skipCount = @($stderr | Select-String -Pattern 'STARTUP_SKIP_RECALC').Count
L ("STDERR frontend_ready=$ready mutex_trace=$hasTrace startup_skip_recalc=$skipCount lines=$($stderr.Count)")
($stderr | Select-Object -Last 10) | ForEach-Object { L ("  tail: " + $_) }

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
L 'DONE'