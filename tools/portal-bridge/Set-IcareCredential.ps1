<#
  Stores the i-CARE account for the i-CARE reader, on THIS PC only.
  A normal Windows sign-in box asks for the user name and password; they are encrypted with Windows DPAPI (only this Windows user
  on this PC can decrypt them). Nothing is printed, logged or sent anywhere. Run it again after a password change.
  A separate read-only i-CARE user for the reader is best: i-CARE allows one session per account, so a person signing in with
  the same account signs the reader out (and the other way round).
#>
$dir = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'
New-Item -ItemType Directory -Force $dir | Out-Null
$cred = Get-Credential -Message 'i-CARE account for the Sarwa Chronic i-CARE reader (read-only)'
if (-not $cred) { Write-Host 'Cancelled.'; exit 1 }
$cred | Export-Clixml -Path (Join-Path $dir 'icare.cred.xml')
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
Write-Host 'i-CARE account saved (encrypted) in' $dir
Read-Host 'Press Enter to close' | Out-Null
