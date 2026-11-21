<#
  Installs the portal bridge on THIS PC (the Outlook bridge PC) and starts it at Windows sign-in (Task Scheduler).
  - copies the bridge files to %LOCALAPPDATA%\ChronicPortalBridge\app (outside any project / temp folder)
  - installs the Playwright library there (no browser download: it uses the installed Google Chrome)
  - registers the task ChronicPortalBridge; -Live = live writes for whatever the server allows (Settings > Portal)
  Needs Node.js. The account and token come from Set-PortalCredential.ps1 (DPAPI, this Windows user only).
  Remove with:  Unregister-ScheduledTask ChronicPortalBridge -Confirm:$false
#>
param([Parameter(Mandatory)] [string] $SupabaseUrl, [switch] $Live, [switch] $Headless, [int] $IntervalMin = 5)
$ErrorActionPreference = 'Stop'
$portableNode = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge\node'   # portable Node.js (no admin rights needed)
if (Test-Path (Join-Path $portableNode 'node.exe')) { $env:Path = "$portableNode;$env:Path" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed (winget install OpenJS.NodeJS.LTS)' }
$root = Join-Path $env:LOCALAPPDATA 'ChronicPortalBridge'; $app = Join-Path $root 'app'
New-Item -ItemType Directory -Force $app | Out-Null
foreach ($f in 'bridge.mjs', 'portal-reader.js', 'portal-agent.js', 'reply-map.json', 'package.json', 'Start-PortalBridge.ps1', 'Set-PortalCredential.ps1') { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $app $f) -Force }
Push-Location $app
try {
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'; $ErrorActionPreference = 'Continue'   # npm writes notices to stderr
  & npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | ForEach-Object { "$_" } | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally { $ErrorActionPreference = 'Stop'; Pop-Location }
$script = Join-Path $app 'Start-PortalBridge.ps1'
$arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -SupabaseUrl `"$SupabaseUrl`" -IntervalMin $IntervalMin" + $(if ($Live) { ' -Live' } else { '' }) + $(if ($Headless) { ' -Headless' } else { '' })
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ChronicPortalBridge' -Action $action -Trigger $trigger -Settings $settings -Description ('Sarwa Chronic <-> portal Chronic Attach bridge' + $(if ($Live) { ' (live writes as allowed by Settings > Portal)' } else { ' (dry run)' })) -Force | Out-Null
Write-Host ('Installed in ' + $app + ' - task ChronicPortalBridge registered' + $(if ($Live) { ' (live)' } else { ' (dry run)' }) + '.')
