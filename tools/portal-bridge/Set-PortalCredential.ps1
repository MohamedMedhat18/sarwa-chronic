<#
  Stores the portal account and the Sarwa Chronic bridge token for the portal bridge, on THIS PC only.
  You type them; they are encrypted with Windows DPAPI (only this Windows user on this PC can decrypt them).
  Nothing is printed, logged or sent anywhere. Run it again to change them (e.g. after a password change).
#>
$dir = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'
New-Item -ItemType Directory -Force $dir | Out-Null
Write-Host 'Portal account used by the bridge (a dedicated account without a second factor is best).'
$cred = Get-Credential -Message 'Sarwa portal account for the Chronic Attach bridge'
if (-not $cred) { Write-Host 'Cancelled.'; exit 1 }
$tok = Read-Host -AsSecureString 'Sarwa Chronic portal token (chp_..., from Settings > Portal > New bridge token)'
$cred | Export-Clixml -Path (Join-Path $dir 'portal.cred.xml')
[pscustomobject]@{ token = $tok } | Export-Clixml -Path (Join-Path $dir 'bridge.token.xml')
# only this user may read the folder
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
Write-Host "Saved (encrypted) in $dir"
