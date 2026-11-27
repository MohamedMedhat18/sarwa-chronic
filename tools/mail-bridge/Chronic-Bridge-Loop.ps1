<#
  Chronic-Bridge-Loop.ps1 - keeps the Chronic mail bridge running all the time (like Outlook's send/receive).
  Every 20 seconds: new Chronic@sarwa.life emails -> helpdesk tickets, helpdesk replies -> sent from Outlook.
  Started at logon by the "Chronic Mail Bridge" task (Install-ChronicTask.ps1). Only one copy runs at a time.

  27 Nov 2026: while a run works, Outlook is watched every 15 s and its state is reported to the helpdesk every minute
  (bridge action mail_health): security question open ("A program is trying to access email address information" - Outlook
  asks when the antivirus is out of date), Outlook closed / not responding, a run busy for long. The helpdesk banner then
  says WHY replies wait. Nothing here answers the security question: that stays a person's decision.
#>
param([int]$EverySeconds = 20, [switch]$Check)   # -Check: print what the watch sees now, then stop (read only)
$ErrorActionPreference = 'Continue'
$Home2  = Join-Path $env:LOCALAPPDATA 'ChronicIntake'
$script = Join-Path $Home2 'Save-ChronicEmails.ps1'
$log    = Join-Path $Home2 'log.txt'

# ---- Outlook watch (read only: window titles / texts and the antivirus status Windows reports) ----
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class ChronicOutlookWatch {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // the text of a visible Outlook dialog that asks about programmatic access ("A program is trying to ..."), else ""
  public static string Prompt(uint pid) {
    string found = "";
    EnumWindows((h, p) => {
      uint q; GetWindowThreadProcessId(h, out q); if (q != pid || !IsWindowVisible(h)) return true;
      var cl = new StringBuilder(64); GetClassName(h, cl, 64); if (cl.ToString() != "#32770") return true;
      EnumChildWindows(h, (c, p2) => { var s = new StringBuilder(400); GetWindowText(c, s, 400); var t = s.ToString(); if (t.Contains("A program is trying")) { found = t; return false; } return true; }, IntPtr.Zero);
      return found.Length == 0;
    }, IntPtr.Zero);
    return found;
  }
}
'@
} catch { }
$Utf8 = New-Object Text.UTF8Encoding($false)
$Cfg = $null; try { $Cfg = [IO.File]::ReadAllText((Join-Path $Home2 'bridge.json'), $Utf8) | ConvertFrom-Json } catch { }
$script:avText = ''; $script:avAt = [datetime]::MinValue
function Get-AvText {   # what Windows Security Center says about the antivirus (Outlook asks when it is not "on and up to date")
  if (((Get-Date) - $script:avAt).TotalMinutes -lt 10) { return $script:avText }
  $script:avAt = Get-Date
  try {
    $bad = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object {
      $s = '{0:X6}' -f $_.productState; $on = $s.Substring(2, 2) -in '10', '11'; $fresh = $s.Substring(4, 2) -eq '00'
      if ($on -and -not $fresh) { "$($_.displayName): definitions out of date" } })
    $script:avText = ($bad -join '; ')
  } catch { $script:avText = '' }
  return $script:avText
}
function Get-OutlookState($run) {
  $o = Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object -First 1
  $secs = if ($run) { [int]((Get-Date) - $run.StartTime).TotalSeconds } else { 0 }
  if (-not $o) { return @{ state = 'outlook_closed'; detail = 'Outlook is not running'; run_secs = $secs } }
  $p = ''; try { $p = [ChronicOutlookWatch]::Prompt([uint32]$o.Id) } catch { }
  if ($p) { return @{ state = 'security_prompt'; detail = ('Outlook asks: "' + ($p -replace '\s+', ' ').Substring(0, [Math]::Min(110, ($p -replace '\s+', ' ').Length)) + '" - waiting for someone at this PC to answer'); run_secs = $secs } }
  if (-not $o.Responding) { return @{ state = 'not_responding'; detail = 'Outlook is not responding'; run_secs = $secs } }
  if ($secs -gt 300) { return @{ state = 'run_stuck'; detail = "a mail run has been working for $([int]($secs / 60)) min"; run_secs = $secs } }
  return @{ state = 'ok'; detail = ''; run_secs = $secs }
}
$script:lastState = ''; $script:lastSent = [datetime]::MinValue
function Send-Health($run) {
  if (-not $Cfg) { return }
  $h = Get-OutlookState $run
  if ($h.state -eq $script:lastState -and ((Get-Date) - $script:lastSent).TotalSeconds -lt 60) { return }   # on change, else once a minute
  try {
    $json = @{ action = 'mail_health'; state = $h.state; detail = $h.detail; av = (Get-AvText); pc = $env:COMPUTERNAME; run_secs = $h.run_secs } | ConvertTo-Json -Compress
    Invoke-WebRequest -Method Post -Uri $Cfg.url -Headers @{ 'x-bridge-token' = $Cfg.token } -ContentType 'application/json; charset=utf-8' -Body $Utf8.GetBytes($json) -TimeoutSec 20 -UseBasicParsing | Out-Null
    if ($h.state -ne $script:lastState) { Add-Content -Path $log -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss}  Outlook state: {1}{2}' -f (Get-Date), $h.state, $(if ($h.detail) { ' - ' + $h.detail } else { '' })) }
    $script:lastState = $h.state; $script:lastSent = Get-Date
  } catch { }
}

if ($Check) { $h = Get-OutlookState $null; 'state: ' + $h.state; 'detail: ' + $h.detail; 'antivirus: ' + (Get-AvText); return }
$one = New-Object System.Threading.Mutex($false, 'Global\ChronicBridgeLoop')
if (-not $one.WaitOne(0)) { return }   # already running
try {
  Add-Content -Path $log -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss}  Bridge loop started (every {1}s, Outlook watched).' -f (Get-Date), $EverySeconds)
  $histScript = Join-Path $Home2 'Sync-ChronicHistory.ps1'; $nextHist = (Get-Date).AddMinutes(2)
  while ($true) {
    $t0 = Get-Date
    # GlobeMed chronic history: check the monthly files every 30 minutes (uploads only when they changed)
    if ($t0 -ge $nextHist -and (Test-Path $histScript)) {
      $nextHist = $t0.AddMinutes(30)
      try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$histScript`"") -WindowStyle Hidden | Out-Null } catch { }
    }
    try {
      # the same run as before (one at a time - the script has its own lock), now waited for while Outlook is watched
      # a run already working (e.g. started by an earlier loop, still waiting on Outlook) is watched, not started twice
      $busy = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'Save-ChronicEmails\.ps1' } | Select-Object -First 1
      $run = if ($busy) { Get-Process -Id $busy.ProcessId -ErrorAction SilentlyContinue } else { $null }
      if (-not $run) { $run = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$script`"", '-OverlapMinutes', '10') -WindowStyle Hidden -PassThru }
      while (-not $run.WaitForExit(15000)) { Send-Health $run }
      Send-Health $null
      # keep the log small
      if ((Test-Path $log) -and (Get-Item $log).Length -gt 3MB) { $tail = Get-Content $log -Tail 4000 -Encoding UTF8; Set-Content -Path $log -Value $tail -Encoding UTF8 }
    } catch { Add-Content -Path $log -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss}  Loop error: {1}' -f (Get-Date), $_.Exception.Message) }
    $wait = $EverySeconds - ((Get-Date) - $t0).TotalSeconds
    if ($wait -gt 0) { Start-Sleep -Seconds ([int][Math]::Ceiling($wait)) }
  }
} finally { $one.ReleaseMutex() }
