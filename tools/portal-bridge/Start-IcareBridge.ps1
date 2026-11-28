<#
  Starts the i-CARE reader (icare-bridge.mjs, read-only). Decrypts the stored i-CARE account (Set-IcareCredential.ps1) and the
  Sarwa Chronic bridge token (Set-PortalCredential.ps1) into this process's environment only.
    .\Start-IcareBridge.ps1 -SupabaseUrl https://<project>.supabase.co              # keeps running (restarts itself)
    .\Start-IcareBridge.ps1 -SupabaseUrl ... -Test 12345678                         # read ONE card number, print what was found, send nothing
#>
param([Parameter(Mandatory)] [string] $SupabaseUrl, [string] $Test = '', [switch] $Visible)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'
if (Test-Path (Join-Path $dir 'node\node.exe')) { $env:Path = (Join-Path $dir 'node') + ";$env:Path" }
$logFile = Join-Path $dir 'icare.log'
$credFile = Join-Path $dir 'icare.cred.xml'
$plain = { param($s) [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$env:SUPABASE_URL = $SupabaseUrl
$env:PORTAL_TOKEN = & $plain ((Import-Clixml (Join-Path $dir 'bridge.token.xml')).token)
if (Test-Path $credFile) { $cred = Import-Clixml $credFile; $env:ICARE_USER = $cred.UserName; $env:ICARE_PASS = & $plain $cred.Password } else { $env:ICARE_USER = ''; $env:ICARE_PASS = '' }
$env:BRIDGE_DIR = $dir
$env:NODE_USE_SYSTEM_CA = '1'
$env:HEADLESS = $(if ($Visible) { '0' } else { '1' })
try {
  Push-Location $PSScriptRoot
  $args2 = @('icare-bridge.mjs'); if ($Test) { $args2 += @('--test', $Test) }
  $ErrorActionPreference = 'Continue'
  while ($true) {
    if ($Test) { & node @args2 2>&1 | ForEach-Object { "$_" }; break }
    & node @args2 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath $logFile -Append -Encoding utf8
    $code = $LASTEXITCODE
    if ($code -eq 10) { "$((Get-Date).ToUniversalTime().ToString('o')) i-CARE reader needs a person (sign-in / account / page layout) - next try in 1 hour" | Out-File -FilePath $logFile -Append -Encoding utf8; Start-Sleep -Seconds 3600; continue }
    "$((Get-Date).ToUniversalTime().ToString('o')) i-CARE reader stopped (exit $code) - starting it again in 30 s" | Out-File -FilePath $logFile -Append -Encoding utf8
    Start-Sleep -Seconds 30
  }
} finally {
  Pop-Location
  Remove-Item Env:ICARE_PASS, Env:PORTAL_TOKEN -ErrorAction SilentlyContinue
}
