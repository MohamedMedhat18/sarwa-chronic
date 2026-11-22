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
try {
  Push-Location $PSScriptRoot
  $args2 = @('bridge.mjs'); if ($Once) { $args2 += '--once' }; if ($Recheck) { $args2 += @('--recheck', $Recheck) }
  $ErrorActionPreference = 'Continue'   # node writes to stderr; keep going and log it (UTF-8)
  & node @args2 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath (Join-Path $dir 'bridge.log') -Append -Encoding utf8
} finally {
  Pop-Location
  Remove-Item Env:PORTAL_PASS, Env:PORTAL_TOKEN -ErrorAction SilentlyContinue
}
