$ErrorActionPreference = "Stop"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot "agent.mjs"
if (-not (Test-Path $script)) { throw "agent.mjs is missing" }
$arg = '"' + $script + '"'
$action = New-ScheduledTaskAction -Execute $node -Argument $arg -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At "08:30"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "OzonSellerBrowserAudit" -Action $action -Trigger $trigger -Settings $settings -Description "Read-only Ozon Seller notices and paid services audit; 08:30 local PC time" -Force | Out-Null
Write-Host "Scheduled task 'OzonSellerBrowserAudit' registered at 08:30 COMPUTER LOCAL TIME."
Write-Host "Keep this computer powered on and connected to the internet."
