# Agent Hub daemon as a per-user Task Scheduler task (no admin). Usage: service.ps1 install|uninstall|start|stop|status
# Two triggers: at logon, and every minute with MultipleInstances=IgnoreNew. RestartOnFailure alone did NOT restart a killed daemon (tested 04-11).
param([Parameter(Mandatory)][ValidateSet('install','uninstall','start','stop','status')][string]$Action)
$ErrorActionPreference = 'Stop'
$Task  = if ($env:AGENT_HUB_TASK) { $env:AGENT_HUB_TASK } else { 'AgentHub' }
$Home_ = if ($env:AGENT_HUB_HOME) { $env:AGENT_HUB_HOME } else { Join-Path $HOME '.paseo' }
$paseo = (Get-Command paseo.cmd -ErrorAction SilentlyContinue).Source
if (-not $paseo) { $paseo = (Get-Command paseo -ErrorAction Stop).Source }
if ($env:AGENT_HUB_PASEO) { $paseo = $env:AGENT_HUB_PASEO }  # test hook: a fake paseo
# Run paseo without letting its stderr lines become terminating errors (PS 5.1 + EAP Stop turns native stderr into
# NativeCommandError, so `just down` failed with exit 1 although the daemon stopped).
function Invoke-Paseo { param([string[]]$PaseoArgs, [switch]$Scrub)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { if ($Scrub) { & node (Join-Path $PSScriptRoot '..\..\scripts\daemon-env.mjs') $paseo @PaseoArgs 2>&1 | ForEach-Object { "$_" } | Out-Host } else { & $paseo @PaseoArgs 2>&1 | ForEach-Object { "$_" } | Out-Host }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
  if ($code -and $code -ne 0) { Write-Host "[WARN] paseo $($PaseoArgs -join ' ') exited $code" }
}
# The usage UI must survive a reboot: bring Docker Desktop and the usage stack up (hidden, non-blocking, skipped in tests).
function Start-UsageStack { if ($env:AGENT_HUB_PASEO -or $env:AGENT_HUB_NO_USAGE_STACK -eq '1') { return }
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot '..\usage\ensure-usage.ps1')) }
# Put the Agent Hub kinds into Paseo's own Add-provider list (version+hash checked, idempotent, warns and skips on a Paseo it does not know).
function Invoke-WebPatch { if ($env:AGENT_HUB_PASEO -or $env:AGENT_HUB_NO_WEB_PATCH -eq '1') { return }; try { & node (Join-Path $PSScriptRoot '..\..\scripts\paseo-web-patch.mjs') apply --quiet 2>&1 | ForEach-Object { "$_" } | Out-Host } catch { Write-Host "[WARN] paseo web patch: $_" } }
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
  'uninstall' { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; Invoke-Paseo @('daemon','stop','--home',$Home_); Unregister-ScheduledTask -TaskName $Task -Confirm:$false; Write-Host "[OK] task '$Task' removed" } else { Write-Host "[OK] task '$Task' not present" } }
  'start'     { Invoke-WebPatch; Start-UsageStack; if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $Task | Out-Null; Start-ScheduledTask -TaskName $Task; Write-Host "[OK] task '$Task' started" } else { Invoke-Paseo @('daemon','start','--home',$Home_) -Scrub } }
  'stop'      { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $Task | Out-Null; Stop-ScheduledTask -TaskName $Task }; Invoke-Paseo @('daemon','stop','--home',$Home_); if (-not $env:AGENT_HUB_PASEO) { & node (Join-Path $PSScriptRoot '..\..\scripts\hub.mjs') reap-laptop --now 2>&1 | Out-Host } }  # disabled so the 1-minute trigger cannot revive it; start re-enables
  'status'    { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Get-ScheduledTask -TaskName $Task | Get-ScheduledTaskInfo | Format-List TaskName, LastRunTime, LastTaskResult }; Invoke-Paseo @('daemon','status','--home',$Home_) }
}
