<#
  Registers the portal bridge to start when this Windows user signs in (Task Scheduler), in DRY RUN.
  Run it yourself after the first successful manual run. Remove with:  Unregister-ScheduledTask ChronicPortalBridge
#>
param([Parameter(Mandatory)] [string] $SupabaseUrl)
$script = Join-Path $PSScriptRoot 'Start-PortalBridge.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File `"$script`" -SupabaseUrl `"$SupabaseUrl`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'ChronicPortalBridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Sarwa Chronic <-> portal Chronic Attach bridge (dry run until enabled)' -Force | Out-Null
Write-Host 'Registered: ChronicPortalBridge (starts at sign-in, dry run).'
