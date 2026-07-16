# Registers a Scheduled Task that starts Windows-to-Sonos at logon and
# restarts it automatically if it ever crashes. Run this once, from a normal
# PowerShell window (elevation not required for a per-user logon task):
#
#   cd "C:\Users\basva\OneDrive\Desktop\Tools\Windows-to-Sonos"
#   .\setup_autostart.ps1
#
# To remove it later: Unregister-ScheduledTask -TaskName "Windows-to-Sonos"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$action = New-ScheduledTaskAction -Execute (Join-Path $ProjectDir "run_server.bat") `
    -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName "Windows-to-Sonos" `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description "Auto-start Windows-to-Sonos local Hi-Fi server at logon; restarts automatically on crash." `
    -Force

Write-Host "Registered. It will start automatically at your next logon."
Write-Host "To start it right now without logging off: Start-ScheduledTask -TaskName 'Windows-to-Sonos'"
