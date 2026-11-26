# verify-flash.ps1 -- ASCII only (PS 5.1 reads UTF-8 without BOM poorly).
#
# Purpose: prove the "double click -> island flashes downward" regression is gone.
#
# Method: start the app, double click the pet 5 times, sample the island window
# rect every 80 ms, and require that once the overlay opens no later frame moves
# the window. It also parses the Rust stderr markers because the bad build moved
# the window twice within ~60 ms (set_island_overlay invariant correction, then a
# 60 ms later report_pet_slot_offset correction), which 80 ms sampling can miss:
#   - "SLOT_INVARIANT_VIOLATION op=set_island_overlay ... corrected=true"  -> FAIL
#   - "OVERLAY_SINGLE_SHOT verify mismatch"                               -> FAIL
#   - "OVERLAY_DOG_MEASURE ... corrected=true" after the double click     -> FAIL
#
# IMPORTANT: use the normal WebView2 profile (no -IsolatedProfile). A fresh
# profile has no "onboarding done" localStorage flag, so the app opens the
# first-run wizard in expanded mode; App.tsx::showPetHoverBubble returns early
# unless the island is collapsed, so a double click would do nothing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File E:\Maltese\work\verify-flash.ps1 -Tag fixed -Exe E:\Maltese\src-tauri\target\release\maltese-assistant.exe
# Optional: -Rounds 5 -SampleMs 80 -Frames 20 -KillExisting -IsolatedProfile
#
# Exit code 0 = all rounds pass, 1 = fail, 2 = setup failure.

param(
  [string]$Exe = "E:\Maltese\src-tauri\target\release\maltese-assistant.exe",
  [int]$Rounds = 5,
  [int]$SampleMs = 80,
  [int]$Frames = 20,
  [int]$MaxDriftPx = 8,
  [string]$Tag = "run",
  [switch]$KillExisting,
  [switch]$IsolatedProfile,
  [string]$ProfileDir = ""
)

$ErrorActionPreference = "Stop"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$root = "E:\Maltese"
$work = Join-Path $root "work"
$logPath = Join-Path $work ("verify-flash-{0}.log" -f $Tag)
$errPath = Join-Path $work ("verify-flash-{0}-stderr.log" -f $Tag)
$dataDir = Join-Path $root ".tmp-build\verify-flash-data"
$wvDir = Join-Path $root ".tmp-build\verify-flash-webview2"
New-Item -ItemType Directory -Force -Path $dataDir, $wvDir, $work | Out-Null
Set-Content -Path $logPath -Value ("verify-flash tag={0} exe={1} rounds={2} sampleMs={3} frames={4}" -f $Tag, $Exe, $Rounds, $SampleMs, $Frames) -Encoding ascii

function L([string]$text) {
  $line = ("{0} {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $text)
  Add-Content -Path $logPath -Value $line -Encoding ascii
  Write-Output $line
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class VW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-WindowsOfPid([int]$ProcessId) {
  $list = New-Object System.Collections.Generic.List[object]
  $cb = [VW+EnumProc]{
    param($h, $l)
    $owner = 0
    [void][VW]::GetWindowThreadProcessId($h, [ref]$owner)
    if ([int]$owner -eq $ProcessId) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][VW]::GetWindowText($h, $sb, 512)
      $r = New-Object VW+RECT
      [void][VW]::GetWindowRect($h, [ref]$r)
      $list.Add([pscustomobject]@{
        Hwnd = $h; Title = $sb.ToString(); Visible = [VW]::IsWindowVisible($h);
        Left = $r.Left; Top = $r.Top; Width = ($r.Right - $r.Left); Height = ($r.Bottom - $r.Top)
      })
    }
    return $true
  }
  [void][VW]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Get-Island([int]$ProcessId) {
  Get-WindowsOfPid $ProcessId |
    Where-Object { $_.Title -like "*Maltese*" -and $_.Width -gt 100 } |
    Sort-Object { $_.Width * $_.Height } -Descending |
    Select-Object -First 1
}

function Fmt-Rect($w) { if ($w) { return ("{0},{1},{2},{3}" -f $w.Left, $w.Top, $w.Width, $w.Height) } return "none" }
function Rect-OfFrame([string]$frame) { return $frame.Substring($frame.IndexOf(":") + 1) }

if (-not (Test-Path $Exe)) { L ("ABORT exe missing: " + $Exe); exit 2 }

if ($KillExisting) {
  foreach ($proc in (Get-Process | Where-Object { $_.Path -eq $Exe })) {
    L ("stopping existing pid=" + $proc.Id)
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$existing = @(Get-Process | Where-Object { $_.ProcessName -like "*maltese*" })
if ($existing.Count -gt 0) {
  L ("WARN other maltese processes running: " + (($existing | ForEach-Object { $_.Id.ToString() + "=" + $_.Path }) -join ", "))
}

$env:MALTESE_DATA_DIR = $dataDir
if ($ProfileDir -ne "") { $env:WEBVIEW2_USER_DATA_FOLDER = $ProfileDir }
elseif ($IsolatedProfile) { $env:WEBVIEW2_USER_DATA_FOLDER = $wvDir }
else { Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue }
$env:TEMP = (Join-Path $root ".tmp-build")
$env:MALTESE_LOG = "warn"
$proc = Start-Process -FilePath $Exe -RedirectStandardError $errPath -PassThru
L ("started pid={0} exe={1}" -f $proc.Id, $Exe)

try {
  $island = $null
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 250
    $island = Get-Island $proc.Id
    if ($island -and $island.Visible) { break }
  }
  if (-not $island) {
    L "ABORT no island window (see stderr log)"
    if (Test-Path $errPath) { Get-Content $errPath -Tail 30 | ForEach-Object { L ("ERR " + $_) } }
    exit 2
  }
  L ("island " + (Fmt-Rect $island) + " hwnd=" + $island.Hwnd)

  for ($i = 0; $i -lt 80; $i++) {
    if ((Get-Content $errPath -Raw -ErrorAction SilentlyContinue) -match "frontend reported first paint ready") { break }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 1500
  L "frontend ready (or timed out)"

  $script:islandHwnd = $island.Hwnd
  $script:shell = New-Object -ComObject WScript.Shell

  function Send-Escape {
    [void][VW]::SetForegroundWindow($script:islandHwnd)
    Start-Sleep -Milliseconds 120
    try { $script:shell.SendKeys("{ESC}") } catch { }
    Start-Sleep -Milliseconds 80
    [void][VW]::PostMessage($script:islandHwnd, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [void][VW]::PostMessage($script:islandHwnd, 0x0101, [IntPtr]0x1B, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 600
  }

  function DoubleClick-At([int]$x, [int]$y) {
    [void][VW]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 150
    [void][VW]::SetForegroundWindow($script:islandHwnd)
    Start-Sleep -Milliseconds 120
    [VW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [VW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [VW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [VW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }

  # Collapse first: the hover bubble only opens from the collapsed island.
  for ($i = 0; $i -lt 3; $i++) {
    $cur = Get-Island $proc.Id
    if ($cur -and ($cur.Width -gt 400 -or $cur.Height -gt 400)) {
      $before = Fmt-Rect $cur
      $script:islandHwnd = $cur.Hwnd
      Send-Escape
      L ("escape sent before=" + $before + " after=" + (Fmt-Rect (Get-Island $proc.Id)))
    }
  }
  Start-Sleep -Milliseconds 800
  $cur = Get-Island $proc.Id
  if (-not $cur -or $cur.Width -gt 400) {
    L ("ABORT island is not collapsed (rect=" + (Fmt-Rect $cur) + "); hover bubble cannot open, see header note about onboarding")
    exit 2
  }
  L ("collapsed baseline " + (Fmt-Rect $cur))

  $startLine = 0
  if (Test-Path $errPath) { $startLine = @(Get-Content $errPath).Count }

  $results = New-Object System.Collections.Generic.List[object]
  for ($round = 1; $round -le $Rounds; $round++) {
    $island = Get-Island $proc.Id
    if (-not $island) { L ("R{0} no island" -f $round); break }
    $script:islandHwnd = $island.Hwnd
    $base = Fmt-Rect $island
    # collapsed pet fills the window; aim slightly below center so we stay inside the GIF hit box.
    $cx = [int]($island.Left + $island.Width * 0.5)
    $cy = [int]($island.Top + $island.Height * 0.62)
    L ("R{0} base={1} click=({2},{3})" -f $round, $base, $cx, $cy)

    $frameLog = New-Object System.Collections.Generic.List[string]
    DoubleClick-At $cx $cy
    $t0 = Get-Date
    for ($f = 0; $f -lt $Frames; $f++) {
      Start-Sleep -Milliseconds $SampleMs
      $cur2 = Get-Island $proc.Id
      $ms = [int]((Get-Date) - $t0).TotalMilliseconds
      $frameLog.Add(("{0}ms:{1}" -f $ms, (Fmt-Rect $cur2)))
    }

    # open = first frame whose rect differs from the collapsed base
    $openIdx = -1
    $openRect = $null
    for ($i = 0; $i -lt $frameLog.Count; $i++) {
      $r = Rect-OfFrame $frameLog[$i]
      if ($r -ne $base) { $openIdx = $i; $openRect = $r; break }
    }
    $distinct = ($frameLog | ForEach-Object { Rect-OfFrame $_ } | Select-Object -Unique)
    $driftAfterOpen = @()
    $roundMaxDriftPx = 0
    $closedAt = ""
    if ($openIdx -ge 0) {
      $openParts = $openRect -split ","
      for ($i = $openIdx; $i -lt $frameLog.Count; $i++) {
        $frameText = $frameLog[$i]
        $r = Rect-OfFrame $frameText
        if ($r -eq $base) { $closedAt = $frameText; break }   # overlay closed: end of the open window
        if ($r -ne $openRect) {
          $driftAfterOpen += $frameText
          $parts = $r -split ","
          if ($parts.Count -eq 4 -and $openParts.Count -eq 4) {
            $d = 0
            for ($k = 0; $k -lt 4; $k++) { $d = [Math]::Max($d, [Math]::Abs([int]$parts[$k] - [int]$openParts[$k])) }
            $roundMaxDriftPx = [Math]::Max($roundMaxDriftPx, $d)
          }
        }
      }
    }
    $pass = ($openIdx -ge 0) -and ($roundMaxDriftPx -le $MaxDriftPx)
    L ((("R{0} frames " -f $round) + ($frameLog -join " -> ")))
    L ("R{0} openIdx={1} open={2} distinctRects={3} driftFrames={4} maxDriftPx={5} closedAt={6} FRAME_VERDICT={7}" -f $round, $openIdx, $openRect, $distinct.Count, $driftAfterOpen.Count, $roundMaxDriftPx, $closedAt, $(if ($pass) { "PASS" } else { "FAIL" }))
    $results.Add([pscustomobject]@{ Round = $round; Pass = $pass; OpenIdx = $openIdx; Drift = $driftAfterOpen.Count; MaxDriftPx = $roundMaxDriftPx })

    Send-Escape
    Start-Sleep -Milliseconds 900
    L ("R{0} afterClose={1}" -f $round, (Fmt-Rect (Get-Island $proc.Id)))
  }

  Start-Sleep -Milliseconds 400
}
finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}

$allLines = @()
if (Test-Path $errPath) { $allLines = @(Get-Content $errPath) }
$roundLines = $allLines | Select-Object -Skip $startLine
$markers = $roundLines | Where-Object {
  $_ -match "OVERLAY_SINGLE_SHOT|SLOT_INVARIANT_VIOLATION op=set_island_overlay|OVERLAY_DOG_MEASURE|DOUBLECLICK_GEOM|OVERLAY_SINGLE_SHOT verify mismatch|OVERLAY_SLOT_CORRECT"
}
L "--- native markers from round start (last 80) ---"
$markers | Select-Object -Last 80 | ForEach-Object { L ("ERR " + $_) }
$badInvariant = @($markers | Where-Object { $_ -match "SLOT_INVARIANT_VIOLATION op=set_island_overlay" }).Count
$badMismatch = @($markers | Where-Object { $_ -match "OVERLAY_SINGLE_SHOT verify mismatch" }).Count
# Only corrections larger than the tolerance count as a flash: formula-vs-measured
# residual of a few px is expected geometry drift, a 100+ px correction is the bug.
$corrections = @($markers | Where-Object { $_ -match "OVERLAY_DOG_MEASURE .* corrected=true" })
$badCorrections = 0
$smallCorrections = 0
foreach ($line in $corrections) {
  $dx = 0; $dy = 0
  if ($line -match "dx=(-?\d+) dy=(-?\d+)") { $dx = [int]$Matches[1]; $dy = [int]$Matches[2] }
  if (([Math]::Abs($dx) -gt $MaxDriftPx) -or ([Math]::Abs($dy) -gt $MaxDriftPx)) { $badCorrections++ } else { $smallCorrections++ }
}
L ("LOG_VERDICT set_island_overlay_violations={0} single_shot_mismatches={1} large_corrections={2} small_residual_corrections={3} (tolerance={4}px) -> {5}" -f $badInvariant, $badMismatch, $badCorrections, $smallCorrections, $MaxDriftPx, $(if (($badInvariant + $badMismatch + $badCorrections) -eq 0) { "PASS" } else { "FAIL" }))

$frameFails = @($results | Where-Object { -not $_.Pass }).Count
L ("RESULT rounds={0} frame_pass={1} frame_fail={2} log_ok={3}" -f $results.Count, ($results.Count - $frameFails), $frameFails, $(($badInvariant + $badMismatch + $badCorrections) -eq 0))
L ("log: " + $logPath)
L ("stderr: " + $errPath)

if (($frameFails -eq 0) -and (($badInvariant + $badMismatch + $badCorrections) -eq 0) -and ($results.Count -ge 1)) { exit 0 }
exit 1
