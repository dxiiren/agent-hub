# Agent Hub daemon as a per-user Task Scheduler task (no admin). Usage: service.ps1 install|uninstall|start|stop|status
# Two triggers: at logon, and every minute with MultipleInstances=IgnoreNew. RestartOnFailure alone did NOT restart a killed daemon (tested 04-11).
param([Parameter(Mandatory)][ValidateSet('install','uninstall','start','stop','status')][string]$Action)
$ErrorActionPreference = 'Stop'
$Task  = if ($env:AGENT_HUB_TASK) { $env:AGENT_HUB_TASK } else { 'AgentHub' }
$Home_ = if ($env:AGENT_HUB_HOME) { $env:AGENT_HUB_HOME } else { Join-Path $HOME '.paseo' }
$paseo = (Get-Command paseo.cmd -ErrorAction SilentlyContinue).Source
if (-not $paseo) { $paseo = (Get-Command paseo -ErrorAction Stop).Source }
switch ($Action) {
  'install' {
    $cmd = "& '$(Join-Path $PSScriptRoot 'daemon-run.ps1')'"
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
    $t1  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $t2  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $pri = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Task -Action $act -Trigger @($t1,$t2) -Settings $set -Principal $pri -Force | Out-Null
    Write-Host "[OK] task '$Task' registered (logon + every minute, IgnoreNew)"
  }
  'uninstall' { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; & $paseo daemon stop --home $Home_ 2>&1 | Out-Host; Unregister-ScheduledTask -TaskName $Task -Confirm:$false; Write-Host "[OK] task '$Task' removed" } else { Write-Host "[OK] task '$Task' not present" } }
  'start'     { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $Task | Out-Null; Start-ScheduledTask -TaskName $Task; Write-Host "[OK] task '$Task' started" } else { & $paseo daemon start --home $Home_ 2>&1 | Out-Host } }
  'stop'      { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $Task | Out-Null; Stop-ScheduledTask -TaskName $Task }; & $paseo daemon stop --home $Home_ 2>&1 | Out-Host }  # disabled so the 1-minute trigger cannot revive it; start re-enables
  'status'    { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Get-ScheduledTask -TaskName $Task | Get-ScheduledTaskInfo | Format-List TaskName, LastRunTime, LastTaskResult }; & $paseo daemon status --home $Home_ 2>&1 | Out-Host }
}
