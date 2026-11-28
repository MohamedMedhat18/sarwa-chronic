<#
  Installs the i-CARE reader next to the portal bridge (same app folder and Playwright library, its own Chrome profile and task).
  Run Set-IcareCredential.ps1 first. Remove with:  Unregister-ScheduledTask ChronicIcareReader -Confirm:$false
#>
param([Parameter(Mandatory)] [string] $SupabaseUrl)
$ErrorActionPreference = 'Stop'
$app = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge\app'
if (-not (Test-Path (Join-Path $app 'node_modules\playwright'))) { throw 'Install the portal bridge first (Install-PortalBridgeTask.ps1): the reader uses its Playwright library.' }
foreach ($f in 'icare-bridge.mjs', 'icare-parse.mjs', 'Start-IcareBridge.ps1', 'Set-IcareCredential.ps1') { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $app $f) -Force }
$script = Join-Path $app 'Start-IcareBridge.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -SupabaseUrl `"$SupabaseUrl`"" -WorkingDirectory $app
$trigger = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ChronicIcareReader' -Action $action -Trigger $trigger -Settings $settings -Description 'Sarwa Chronic i-CARE reader (read-only): member details and limits for verified tickets' -Force | Out-Null
Write-Host "Installed in $app - task ChronicIcareReader registered."
