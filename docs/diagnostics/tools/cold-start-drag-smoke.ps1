param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [string]$Tag = 'drag'
)
# Drag smoke test (collapsed island only): collapse with ESC, drag the pet, require window moved
# and island-rect.json updated. Verifies the Moved path now served by the geometry worker.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
$logDir = 'E:\Maltese\work\cold-geom'
New-Item -ItemType Directory -Force $logDir | Out-Null
function L([string]$t) { Write-Host ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $t) }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
function Get-Island([int]$targetPid) {
  $script:best = $null
  $cb = [DW+EnumProc]{
    param($h, $l)
    $owner = 0
    [void][DW]::GetWindowThreadProcessId($h, [ref]$owner)
    if ([int]$owner -eq $targetPid) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][DW]::GetWindowText($h, $sb, 512)
      if ($sb.ToString() -like '*Maltese*') {
        $r = New-Object DW+RECT
        [void][DW]::GetWindowRect($h, [ref]$r)
        $w = $r.Right - $r.Left
        if ($w -gt 60 -and $r.Left -gt -30000) {
          $script:best = [pscustomobject]@{ Hwnd = $h; Left = $r.Left; Top = $r.Top; Width = $w; Height = ($r.Bottom - $r.Top) }
        }
      }
    }
    return $true
  }
  [void][DW]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:best
}

$env:MALTESE_DATA_DIR = $DataDir
$env:WEBVIEW2_USER_DATA_FOLDER = $ProfileDir
$env:TEMP = 'E:\Maltese\.tmp-build'
$env:TMP = $env:TEMP
$env:MALTESE_LOG = 'warn'
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$err = Join-Path $logDir ("$Tag.err.log")
Remove-Item $err -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $Exe -RedirectStandardError $err -PassThru
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 250
  if ((Test-Path $err) -and (Select-String -Path $err -Pattern 'frontend reported first paint ready' -Quiet)) { break }
}
Start-Sleep -Seconds 5
$island = Get-Island $proc.Id
L ("start rect=$($island.Left),$($island.Top),$($island.Width),$($island.Height)")
# collapse any expanded/overlay layout with ESC (frontend handles it)
for ($i = 0; $i -lt 4 -and $island.Width -gt 400; $i++) {
  [void][DW]::SetForegroundWindow($island.Hwnd)
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
  Start-Sleep -Milliseconds 800
  $island = Get-Island $proc.Id
  L ("after ESC width=$($island.Width)")
}
if (-not $island -or $island.Width -gt 400) { L 'ABORT not collapsed'; Get-Content $err -Tail 8 | ForEach-Object { L ("  " + $_) }; Stop-Process -Id $proc.Id -Force; exit 2 }

$rectFile = Join-Path $DataDir 'island-rect.json'
$beforeText = if (Test-Path $rectFile) { Get-Content $rectFile -Raw } else { '' }
$before = ("{0},{1},{2},{3}" -f $island.Left, $island.Top, $island.Width, $island.Height)
$cx = [int]($island.Left + $island.Width / 2)
$cy = [int]($island.Top + $island.Height * 0.6)
[void][DW]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 250
[void][DW]::SetForegroundWindow($island.Hwnd)
Start-Sleep -Milliseconds 200
[DW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($step = 1; $step -le 10; $step++) {
  [void][DW]::SetCursorPos($cx + 6 * $step, $cy - 5 * $step)
  Start-Sleep -Milliseconds 45
}
[DW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 2000
$after = Get-Island $proc.Id
$p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
$afterText = if (Test-Path $rectFile) { Get-Content $rectFile -Raw } else { '' }
$moved = [math]::Abs($after.Left - $island.Left) -ge 8 -or [math]::Abs($after.Top - $island.Top) -ge 8
$snapshotChanged = ($beforeText -ne $afterText)
L ("DRAG before=$before after=$($after.Left),$($after.Top),$($after.Width),$($after.Height) moved=$moved snapshot_changed=$snapshotChanged responding=$($p.Responding)")
L ("SNAPSHOT_BEFORE=$($beforeText -replace '\s+',' ')")
L ("SNAPSHOT_AFTER=$($afterText -replace '\s+',' ')")
$hasTrace = if (Test-Path $err) { [bool](Select-String -Path $err -Pattern 'MUTEX_TRACE' -Quiet) } else { $false }
L ("STDERR mutex_trace=$hasTrace")
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
L 'DONE'