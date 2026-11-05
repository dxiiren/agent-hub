# Brings the usage stack (collector, Prometheus, Grafana) up. USAGE_MODE=native (default on Windows, from the environment or .env): native processes via native.ps1, no Docker.
# USAGE_MODE=docker: starts Docker Desktop if it is not running, then `docker compose up -d`.
# Idempotent and safe to call on every `just up` / logon. Needs deploy/usage/.env (GRAFANA_ADMIN_PW); skips quietly when there is none.
param([int]$WaitSeconds = 240)
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
if (-not (Test-Path (Join-Path $dir '.env'))) { Write-Host '[SKIP] usage stack: deploy/usage/.env not set up'; exit 0 }
$mode = $env:USAGE_MODE
if (-not $mode) { $m = Select-String -Path (Join-Path $dir '.env') -Pattern '^\s*USAGE_MODE\s*=\s*(\S+)' | Select-Object -First 1; if ($m) { $mode = $m.Matches[0].Groups[1].Value } }
if ($mode -ne 'docker') {
  & (Join-Path $dir 'native.ps1') start
  if ($?) { exit 0 } else { Write-Host '[WARN] usage stack: native start failed'; exit 1 }
}
function Test-Docker { docker info *> $null; return ($LASTEXITCODE -eq 0) }
if (-not (Test-Docker)) {
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path $exe)) { Write-Host '[WARN] usage stack: Docker is not installed'; exit 1 }
  Write-Host '[..] starting Docker Desktop'
  Start-Process $exe
  $end = (Get-Date).AddSeconds($WaitSeconds)
  while (-not (Test-Docker) -and (Get-Date) -lt $end) { Start-Sleep -Seconds 3 }
  if (-not (Test-Docker)) { Write-Host "[WARN] usage stack: Docker not ready after $WaitSeconds s"; exit 1 }
}
docker compose -f (Join-Path $dir 'compose.yaml') up -d 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host '[WARN] usage stack: compose up failed'; exit 1 }
Write-Host '[OK] usage stack up (Grafana http://127.0.0.1:3000)'
