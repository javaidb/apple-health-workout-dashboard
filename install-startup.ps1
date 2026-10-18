# Registers a Windows scheduled task that starts the receiver at logon (no browser),
# so the phone can push whenever the PC is on. Remove with:
#   Unregister-ScheduledTask -TaskName "HealthAutoExportReceiver" -Confirm:$false
$TaskName = 'HealthAutoExportReceiver'
$launcher = Join-Path $PSScriptRoot 'launch.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -NoBrowser" `
    -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Receives Health Auto Export workout pushes and serves the workout calendar.' -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (runs at logon)." -ForegroundColor Green
