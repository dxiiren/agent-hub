# Agent Hub daemon as a per-user Task Scheduler task (no admin). Usage: service.ps1 install|uninstall|start|stop|restart|status|watchdog-install|watchdog-uninstall
# Two triggers: at logon, and every minute with MultipleInstances=IgnoreNew. RestartOnFailure alone did NOT restart a killed daemon (tested 04-11).
param([Parameter(Mandatory)][ValidateSet('install','uninstall','start','stop','restart','status','watchdog-install','watchdog-uninstall')][string]$Action)
$ErrorActionPreference = 'Stop'
$Task  = if ($env:AGENT_HUB_TASK) { $env:AGENT_HUB_TASK } else { 'AgentHub' }
$Home_ = if ($env:AGENT_HUB_HOME) { $env:AGENT_HUB_HOME } else { Join-Path $HOME '.paseo' }
$WatchTask = if ($env:AGENT_HUB_WATCHDOG_TASK) { $env:AGENT_HUB_WATCHDOG_TASK } else { 'AgentHubWatchdog' }
$Marker = Join-Path $Home_ 'deliberate-stop'  # written by a deliberate `stop`, removed by `start`: the hang watchdog (scripts/daemon-watchdog.mjs) restarts nothing while it exists
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
# Caps the daemon's provider probes at 4 at once and shortens a failed probe's error (version + sha256 checked, skipped on a Paseo it does not know; the daemon is started right after, so it loads the patched files).
function Invoke-ServerPatch { if ($env:AGENT_HUB_PASEO -or $env:AGENT_HUB_NO_SERVER_PATCH -eq '1') { return }; try { & node (Join-Path $PSScriptRoot '..\..\scripts\paseo-server-patch.mjs') apply --quiet 2>&1 | ForEach-Object { "$_" } | Out-Host } catch { Write-Host "[WARN] paseo server patch: $_" } }
# Who asked for this start/stop: one line (requester process chain) in <home>/restart-requests.log. Never fails the action.
function Write-RestartLog { if ($env:AGENT_HUB_PASEO -or $env:AGENT_HUB_NO_RESTART_LOG -eq '1') { return }; try { & node (Join-Path $PSScriptRoot '..\..\scripts\restart-log.mjs') $Action 2>&1 | Out-Null } catch { } }
# Reliable restart (scripts/daemon-ctl.mjs): `down` proves the daemon is gone (stops the pid in <home>/paseo.pid when `paseo daemon stop` fails), `up` prints [OK] only when HTTP
# and `paseo ls` answer and all four plugins run. Skipped under the fake-paseo test hook unless AGENT_HUB_CTL=1.
function Use-Ctl { return (-not $env:AGENT_HUB_PASEO) -or $env:AGENT_HUB_CTL -eq '1' }
function Invoke-Ctl { param([string]$Step) $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & node (Join-Path $PSScriptRoot '..\..\scripts\daemon-ctl.mjs') $Step 2>&1 | ForEach-Object { "$_" } | Out-Host; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old } }
if ($Action -in 'start','stop') { Write-RestartLog }
function Install-Watchdog {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $cmd = "& '$node' '$(Resolve-Path (Join-Path $PSScriptRoot '..\..\scripts\daemon-watchdog.mjs'))'"
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
  $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $pri = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $WatchTask -Action $act -Trigger $trg -Settings $set -Principal $pri -Force | Out-Null
  Write-Host "[OK] task '$WatchTask' registered (every 2 min: health check, restart after 3 failures in a row)"
}
switch ($Action) {
  'install' {
    $cmd = "& '$(Join-Path $PSScriptRoot 'daemon-run.ps1')'"
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
    $t1  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $t2  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $pri = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Task -Action $act -Trigger @($t1,$t2) -Settings $set -Principal $pri -Force | Out-Null
    Write-Host "[OK] task '$Task' registered (logon + every minute, IgnoreNew)"; Install-Watchdog
  }
  'watchdog-install' { Install-Watchdog }
  'watchdog-uninstall' { if (Get-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $WatchTask -Confirm:$false; Write-Host "[OK] task '$WatchTask' removed" } else { Write-Host "[OK] task '$WatchTask' not present" } }
  'restart'   { $env:AGENT_HUB_RESTART = '1'; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath stop; $stopCode = $LASTEXITCODE; if ($stopCode -ne 0) { Write-Host "[FAIL] restart: stop failed ($stopCode)"; exit $stopCode }; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath start; exit $LASTEXITCODE }
  'uninstall' { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; Invoke-Paseo @('daemon','stop','--home',$Home_); Unregister-ScheduledTask -TaskName $Task -Confirm:$false; if (Get-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $WatchTask -Confirm:$false }; Write-Host "[OK] task '$Task' removed" } else { Write-Host "[OK] task '$Task' not present" } }
  'start'     { Remove-Item $Marker -ErrorAction SilentlyContinue; Invoke-WebPatch; Invoke-ServerPatch; Start-UsageStack
    if (Use-Ctl) { Invoke-Ctl 'heal' | Out-Null }
    if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $Task | Out-Null; Start-ScheduledTask -TaskName $Task; Write-Host "[..] task '$Task' started, waiting for the daemon" } else { Invoke-Paseo @('daemon','start','--home',$Home_) -Scrub }
    if (Use-Ctl) { if (-not (Invoke-Ctl 'ready')) { Write-Host "[FAIL] the hub did not come up: see $(Join-Path $Home_ 'daemon.log')"; exit 1 }; if (-not (Invoke-Ctl 'plugins')) { exit 1 }; try { & node (Join-Path $PSScriptRoot '....pluginsoutingcleanup.mjs') --stale-projects --home $Home_ 2>&1 | ForEach-Object { "$_" } | Out-Host } catch { }; Write-Host "[OK] hub up" } else { Write-Host "[OK] start requested" } }
  'stop'      { if ($env:AGENT_HUB_RESTART -ne '1' -and -not $env:AGENT_HUB_PASEO) { New-Item -ItemType Directory -Force -Path $Home_ | Out-Null; Set-Content -Path $Marker -Value (Get-Date -Format o) }; if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $Task | Out-Null; Stop-ScheduledTask -TaskName $Task }; Invoke-Paseo @('daemon','stop','--home',$Home_); if (Use-Ctl) { if (-not (Invoke-Ctl 'stop')) { exit 1 } }; if (-not $env:AGENT_HUB_PASEO) { & node (Join-Path $PSScriptRoot '..\..\scripts\hub.mjs') reap-laptop --now 2>&1 | Out-Host } }  # disabled so the 1-minute trigger cannot revive it; start re-enables
  'status'    { if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Get-ScheduledTask -TaskName $Task | Get-ScheduledTaskInfo | Format-List TaskName, LastRunTime, LastTaskResult }; Invoke-Paseo @('daemon','status','--home',$Home_) }
}
