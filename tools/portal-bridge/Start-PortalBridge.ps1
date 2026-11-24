<#
  Starts the portal bridge. Decrypts the stored account + token (DPAPI) into this process's environment only,
  then runs bridge.mjs. Defaults are SAFE: DRY_RUN=1 (previews only, nothing submitted to the portal).

  .\Start-PortalBridge.ps1 -SupabaseUrl https://<project>.supabase.co                       # dry run, every 5 minutes
  .\Start-PortalBridge.ps1 -SupabaseUrl ... -Once                                          # one cycle (health / backfill check)
  .\Start-PortalBridge.ps1 -SupabaseUrl ... -LiveWriteAllow 38206                          # live writes ONLY for request 38206
  .\Start-PortalBridge.ps1 -SupabaseUrl ... -Live                                          # live writes for whatever the server allows
                                                                                           # (Settings > Portal: dry run off + live list / live for all)
#>
param(
  [Parameter(Mandatory)] [string] $SupabaseUrl,
  [string] $LiveWriteAllow = '',
  [switch] $Live,
  [int] $IntervalMin = 5,
  [switch] $Once,
  [string] $Recheck = '',   # read-only re-check of "conflict" replies: path of the jobs JSON (nothing is submitted)
  [switch] $Headless
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'
if (Test-Path (Join-Path $dir 'node\node.exe')) { $env:Path = (Join-Path $dir 'node') + ";$env:Path" }   # portable Node.js
$cred = Import-Clixml (Join-Path $dir 'portal.cred.xml')
$tokSecure = (Import-Clixml (Join-Path $dir 'bridge.token.xml')).token
$plain = { param($s) [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$env:SUPABASE_URL = $SupabaseUrl
$env:PORTAL_TOKEN = & $plain $tokSecure
$env:PORTAL_USER = $cred.UserName
$env:PORTAL_PASS = & $plain $cred.Password
$env:BRIDGE_DIR = $dir
$env:NODE_USE_SYSTEM_CA = '1'   # trust the Windows certificate store (the company network inspects HTTPS with its own CA)
$env:INTERVAL_MIN = "$IntervalMin"
$env:HEADLESS = $(if ($Headless) { '1' } else { '0' })
if ($Live) { $env:DRY_RUN = '0'; $env:LIVE_WRITE_ALLOW = '*' }
elseif ($LiveWriteAllow) { $env:DRY_RUN = '0'; $env:LIVE_WRITE_ALLOW = $LiveWriteAllow } else { $env:DRY_RUN = '1'; $env:LIVE_WRITE_ALLOW = '' }
# Keep this PC working while the bridge runs (23 Nov 2026: Modern Standby throttled the network from 18:40 and the PC slept
# 03:28-10:10, so requests waited all night). A Windows power request (like a media player's): the screen may turn off, the
# PC does not go to standby / sleep. No power setting is changed; it ends with this process (normal sleep afterwards).
$awake = $null
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class BridgeAwake {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct REASON_CONTEXT { public uint Version; public uint Flags; public string Reason; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerSetRequest(IntPtr h, int type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerClearRequest(IntPtr h, int type);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint f);
  public static IntPtr On(string why) {
    var c = new REASON_CONTEXT { Version = 0, Flags = 1, Reason = why };
    var h = PowerCreateRequest(ref c);
    PowerSetRequest(h, 1);   // PowerRequestSystemRequired: no idle sleep
    PowerSetRequest(h, 3);   // PowerRequestExecutionRequired: keeps running (and its network) in Modern Standby
    SetThreadExecutionState(0x80000001);   // ES_CONTINUOUS | ES_SYSTEM_REQUIRED (older Windows)
    return h;
  }
  public static void Off(IntPtr h) { if (h != IntPtr.Zero) { PowerClearRequest(h, 3); PowerClearRequest(h, 1); } SetThreadExecutionState(0x80000000); }
}
'@
  $awake = [BridgeAwake]::On('Sarwa Chronic portal bridge is reading the portal and sending replies')
} catch { "$(Get-Date -Format o) keep-awake not available: $($_.Exception.Message)" | Out-File -FilePath (Join-Path $dir 'bridge.log') -Append -Encoding utf8 }
try {
  Push-Location $PSScriptRoot
  $args2 = @('bridge.mjs'); if ($Once) { $args2 += '--once' }; if ($Recheck) { $args2 += @('--recheck', $Recheck) }
  $ErrorActionPreference = 'Continue'   # node writes to stderr; keep going and log it (UTF-8)
  $logFile = Join-Path $dir 'bridge.log'
  # self-healing: whatever stops the bridge (watchdog, browser closed, crash, network) it starts again in 20 s.
  # Exit code 10 = needs a person (the portal refused the sign-in / captcha): no restart here; the task tries again later.
  while ($true) {
    & node @args2 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath $logFile -Append -Encoding utf8
    $code = $LASTEXITCODE
    if ($Once -or $Recheck -or $code -eq 10) { break }
    "$((Get-Date).ToUniversalTime().ToString('o')) bridge stopped (exit $code) - starting it again in 20 s" | Out-File -FilePath $logFile -Append -Encoding utf8
    Start-Sleep -Seconds 20
  }
} finally {
  Pop-Location
  if ($awake) { [BridgeAwake]::Off($awake) }
  Remove-Item Env:PORTAL_PASS, Env:PORTAL_TOKEN -ErrorAction SilentlyContinue
}
