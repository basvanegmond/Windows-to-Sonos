# Registers the Scheduled Task that keeps Windows-to-Sonos running in the
# background: it starts at logon and is restarted within ~5 minutes whenever
# the server process is gone (crash, sleep/resume, accidental kill, Windows
# update reboot). Run this once, from a normal PowerShell window (elevation
# is not required for a per-user logon task):
#
#   cd <the folder holding app.py>
#   .\setup_autostart.ps1
#
# Re-running it is safe; it replaces the existing task definition.
# To remove it later: Unregister-ScheduledTask -TaskName "Windows-to-Sonos"

# A task registered from an elevated session can only be replaced from one.
# If you cannot elevate, register under a different name instead and leave the
# old task be; it points at a directory that no longer exists, so it fails
# harmlessly:  .\setup_autostart.ps1 -TaskName "Windows-to-Sonos-KeepAlive"
param([string]$TaskName = "Windows-to-Sonos")

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Run the interpreter directly, NOT via run_server.bat/run_server.vbs. Those
# detach the process and return immediately, so Task Scheduler considered the
# task "finished successfully" the moment it launched and could never notice
# that the server had died, let alone restart it. Pointing the action at
# pythonw.exe makes the task instance *be* the server process: it stays
# "Running" while the server lives, and ends the moment it dies.
$Pythonw = Join-Path $ProjectDir ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $Pythonw)) { $Pythonw = Join-Path $ProjectDir ".venv\Scripts\python.exe" }
if (-not (Test-Path $Pythonw)) { throw "No interpreter found in $ProjectDir\.venv\Scripts - create the venv first." }

$action = New-ScheduledTaskAction -Execute $Pythonw -Argument "app.py" -WorkingDirectory $ProjectDir

# Two triggers. The logon one covers a normal boot; the repeating one is the
# watchdog: every 5 minutes Windows tries to start the task again, which does
# nothing while the server is alive (MultipleInstances = IgnoreNew) and brings
# it straight back when it is not.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
# No -RepetitionDuration: an absent <Duration> in the task XML means "repeat
# indefinitely". Do NOT pass [TimeSpan]::MaxValue here - Task Scheduler's XML
# validator rejects it at *registration* time, not when the trigger is built,
# so the failure surfaces as "The task XML contains a value which is
# incorrectly formatted or out of range. (11,42):Duration:P99999999DT23H59M59S"
# and no task is created.
$keepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger @($atLogon, $keepAlive) -Settings $settings `
    -Description "Windows-to-Sonos local Hi-Fi server: starts at logon and is re-started within 5 minutes if it stops." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

$registered = Get-ScheduledTask -TaskName $TaskName
Write-Host "Registered '$TaskName' and started it now."
Write-Host "  action:     $($registered.Actions[0].Execute) $($registered.Actions[0].Arguments)"
Write-Host "  keep-alive: every $($registered.Triggers[1].Repetition.Interval)"
Write-Host "Check it is up:  Invoke-RestMethod http://127.0.0.1:8756/api/health"
Write-Host "Task state:      Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
