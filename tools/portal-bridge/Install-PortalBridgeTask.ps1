<#
  Installs the portal bridge on THIS PC (the Outlook bridge PC) and starts it at Windows sign-in (Task Scheduler).
  - copies the bridge files to %LOCALAPPDATA%\ChronicPortalBridge\app (outside any project / temp folder)
  - installs the Playwright library there (no browser download: it uses the installed Google Chrome)
  - registers the task ChronicPortalBridge; -Live = live writes for whatever the server allows (Settings > Portal)
  Needs Node.js. The account and token come from Set-PortalCredential.ps1 (DPAPI, this Windows user only).
  Remove with:  Unregister-ScheduledTask ChronicPortalBridge -Confirm:$false
#>
param([Parameter(Mandatory)] [string] $SupabaseUrl, [switch] $Live, [int] $IntervalMin = 5)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed (winget install OpenJS.NodeJS.LTS)' }
$root = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'; $app = Join-Path $root 'app'
New-Item -ItemType Directory -Force $app | Out-Null
foreach ($f in 'bridge.mjs', 'portal-reader.js', 'portal-agent.js', 'reply-map.json', 'package.json', 'Start-PortalBridge.ps1') { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $app $f) -Force }
Push-Location $app
try { $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'; & npm install --omit=dev --no-audit --no-fund 2>&1 | Out-Host } finally { Pop-Location }
$script = Join-Path $app 'Start-PortalBridge.ps1'
$arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -SupabaseUrl `"$SupabaseUrl`" -IntervalMin $IntervalMin" + $(if ($Live) { ' -Live' } else { '' })
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ChronicPortalBridge' -Action $action -Trigger $trigger -Settings $settings -Description ('Sarwa Chronic <-> portal Chronic Attach bridge' + $(if ($Live) { ' (live writes as allowed by Settings > Portal)' } else { ' (dry run)' })) -Force | Out-Null
Write-Host ('Installed in ' + $app + ' - task ChronicPortalBridge registered' + $(if ($Live) { ' (live)' } else { ' (dry run)' }) + '.')
