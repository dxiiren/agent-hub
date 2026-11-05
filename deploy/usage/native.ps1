# Native (no Docker) usage stack for a Windows laptop: OTel collector -> Prometheus -> Grafana, same configs as compose.yaml.
# Usage: native.ps1 install|start|stop|status|paths. Binaries, data and generated configs live in
# %LOCALAPPDATA%\agent-hub\usage (override: AGENT_HUB_USAGE_HOME), never in the repo. Idempotent; ports and settings come from deploy/usage/.env.
param([Parameter(Position = 0)][ValidateSet('install', 'start', 'stop', 'status', 'paths')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$home_ = if ($env:AGENT_HUB_USAGE_HOME) { $env:AGENT_HUB_USAGE_HOME } else { Join-Path $env:LOCALAPPDATA 'agent-hub\usage' }
$V = @{ otel = '0.157.0'; prom = '3.10.0'; grafana = '13.3.0' }   # keep in step with the compose.yaml image tags
$bin = Join-Path $home_ 'bin'; $conf = Join-Path $home_ 'conf'; $data = Join-Path $home_ 'data'; $logs = Join-Path $home_ 'logs'; $run = Join-Path $home_ 'run'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'   # bsdtar: Git's GNU tar on PATH reads C: as a host
function F($p) { $p -replace '\\', '/' }
# settings: deploy/usage/.env, overridden by the process environment
$cfg = @{}
$envFile = Join-Path $src '.env'
if (Test-Path $envFile) { foreach ($l in Get-Content $envFile) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] } } }
function S($k, $d) { $e = [Environment]::GetEnvironmentVariable($k); if ($e) { $e } elseif ($cfg[$k]) { $cfg[$k] } else { $d } }
$bind = S 'HUB_BIND' '127.0.0.1'; $grpc = S 'HUB_OTLP_GRPC_PORT' 4317; $http = S 'HUB_OTLP_HTTP_PORT' 4318
$promPort = S 'HUB_PROM_PORT' 9090; $grafPort = S 'HUB_GRAFANA_PORT' 3000; $retention = S 'HUB_RETENTION' '180d'; $expPort = S 'HUB_OTEL_EXPORT_PORT' 8889
$exe = @{ otel = "$bin\otelcol-contrib.exe"; prom = "$bin\prometheus\prometheus.exe"; grafana = "$bin\grafana\bin\grafana.exe" }

# .NET calls, not Get-FileHash/Expand-Archive/Get-NetTCPConnection: those modules are missing when PSModulePath is inherited from another shell.
function Sha256($f) { $s = [IO.File]::OpenRead($f); try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() } }
function Get-Verified($url, $sha, $out) {
  if (-not (Test-Path $out)) { Write-Host "[..] download $url"; curl.exe -fsSL --retry 3 -o $out $url; if ($LASTEXITCODE -ne 0) { throw "download failed: $url" } }
  $h = (Sha256 $out)
  if ($h -ne $sha.ToLower()) { Remove-Item $out -Force; throw "checksum mismatch for $url (got $h, want $sha)" }
}
function Install-All {
  foreach ($d in $bin, $conf, $data, $logs, $run) { New-Item -ItemType Directory -Force $d | Out-Null }
  $dl = Join-Path $home_ 'download'; New-Item -ItemType Directory -Force $dl | Out-Null
  if (-not (Test-Path $exe.otel)) {
    $n = "otelcol-contrib_$($V.otel)_windows_amd64.tar.gz"
    $base = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$($V.otel)"
    $sums = (curl.exe -fsSL "$base/opentelemetry-collector-releases_otelcol-contrib_windows_checksums.txt") -join "`n"
    if ($sums -notmatch "(?m)^([0-9a-f]{64})\s+\*?$([regex]::Escape($n))\s*$") { throw "no checksum line for $n" }
    Get-Verified "$base/$n" $Matches[1] "$dl\$n"
    & $tar -xzf "$dl\$n" -C $bin otelcol-contrib.exe
  }
  if (-not (Test-Path $exe.prom)) {
    $n = "prometheus-$($V.prom).windows-amd64.zip"
    $base = "https://github.com/prometheus/prometheus/releases/download/v$($V.prom)"
    $sums = (curl.exe -fsSL "$base/sha256sums.txt") -join "`n"
    if ($sums -notmatch "(?m)^([0-9a-f]{64})\s+$([regex]::Escape($n))\s*$") { throw "no checksum line for $n" }
    Get-Verified "$base/$n" $Matches[1] "$dl\$n"
    & $tar -xf "$dl\$n" -C $dl; Move-Item "$dl\prometheus-$($V.prom).windows-amd64" "$bin\prometheus" -Force
  }
  if (-not (Test-Path $exe.grafana)) {
    $n = "grafana-$($V.grafana).windows-amd64.zip"
    $sha = ((curl.exe -fsSL "https://dl.grafana.com/oss/release/$n.sha256") -join '').Trim().Split()[0]
    Get-Verified "https://dl.grafana.com/oss/release/$n" $sha "$dl\$n"
    & $tar -xf "$dl\$n" -C $dl; Move-Item "$dl\grafana-$($V.grafana)" "$bin\grafana" -Force
  }
  Remove-Item $dl -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[OK] usage binaries in $bin"
}
# The generated configs are the repo's own files with the container addresses swapped for local ones.
function Write-Configs {
  New-Item -ItemType Directory -Force "$conf\targets", "$conf\grafana\provisioning\datasources", "$conf\grafana\provisioning\dashboards", "$conf\grafana\dashboards", "$data\prom", "$data\grafana", $logs, $run | Out-Null
  (Get-Content "$src\otel-collector.yaml" -Raw) -replace 'grpc: \{endpoint: 0\.0\.0\.0:4317\}', "grpc: {endpoint: ${bind}:$grpc}" -replace 'http: \{endpoint: 0\.0\.0\.0:4318\}', "http: {endpoint: ${bind}:$http}" `
    -replace 'endpoint: 0\.0\.0\.0:8889', "endpoint: 127.0.0.1:$expPort" | Set-Content "$conf\otel-collector.yaml" -NoNewline
  Copy-Item "$src\grafana\dashboards\*" "$conf\grafana\dashboards" -Force   # a copy, so the running stack does not depend on the repo path
  Copy-Item "$src\rules.yml" "$conf\rules.yml" -Force
  Get-ChildItem "$conf\targets" -Filter *.yml | Remove-Item -Force
  Get-ChildItem "$src\targets" -Filter *.yml | ForEach-Object { (Get-Content $_.FullName -Raw) -replace 'host\.docker\.internal', '127.0.0.1' | Set-Content "$conf\targets\$($_.Name)" -NoNewline }
  (Get-Content "$src\prometheus.yml" -Raw) -replace 'collector:8889', "127.0.0.1:$expPort" -replace 'host\.docker\.internal', '127.0.0.1' `
    -replace '/etc/prometheus/rules\.yml', (F "$conf\rules.yml") -replace '/etc/prometheus/targets/', ((F "$conf\targets") + '/') | Set-Content "$conf\prometheus.yml" -NoNewline
  Get-ChildItem "$src\grafana\provisioning\datasources" -File | ForEach-Object { (Get-Content $_.FullName -Raw) -replace 'http://prometheus:9090', "http://127.0.0.1:$promPort" | Set-Content "$conf\grafana\provisioning\datasources\$($_.Name)" -NoNewline }
  Get-ChildItem "$src\grafana\provisioning\dashboards" -File | ForEach-Object { (Get-Content $_.FullName -Raw) -replace '/var/lib/grafana/dashboards', (F "$conf\grafana\dashboards") | Set-Content "$conf\grafana\provisioning\dashboards\$($_.Name)" -NoNewline }
}
function Test-Port($p) { [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq [int]$p }) }
function Get-Pid($n) { $f = "$run\$n.pid"; if (Test-Path $f) { $id = [int](Get-Content $f); if (Get-Process -Id $id -ErrorAction SilentlyContinue) { return $id } } return 0 }
function Start-One($name, $port, $file, $argv, $workdir) {
  if (Get-Pid $name) { return }
  if (Test-Port $port) { throw "${name}: port $port is already in use (another usage stack running? stop it first)" }
  $p = Start-Process -FilePath $file -ArgumentList $argv -WorkingDirectory $workdir -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logs\$name.out.log" -RedirectStandardError "$logs\$name.err.log"
  Set-Content "$run\$name.pid" $p.Id
}
function Start-All {
  foreach ($k in 'otel', 'prom', 'grafana') { if (-not (Test-Path $exe[$k])) { Install-All; break } }
  Write-Configs
  $pw = S 'GRAFANA_ADMIN_PW' ''
  if (-not $pw) { throw 'set GRAFANA_ADMIN_PW in deploy/usage/.env' }
  $env:HUB_DEV_DEFAULT = S 'HUB_DEV_DEFAULT' 'unknown'
  Start-One 'collector' $http $exe.otel @("--config=$conf\otel-collector.yaml") $home_
  Start-One 'prometheus' $promPort $exe.prom @("--config.file=$conf\prometheus.yml", "--storage.tsdb.path=$data\prom", "--storage.tsdb.retention.time=$retention", "--web.listen-address=${bind}:$promPort") (Split-Path $exe.prom)
  $env:GF_SECURITY_ADMIN_PASSWORD = $pw; $env:GF_AUTH_ANONYMOUS_ENABLED = 'true'; $env:GF_AUTH_ANONYMOUS_ORG_ROLE = 'Viewer'
  $env:GF_ANALYTICS_REPORTING_ENABLED = 'false'; $env:GF_ANALYTICS_CHECK_FOR_UPDATES = 'false'
  $env:GF_PATHS_DATA = "$data\grafana"; $env:GF_PATHS_LOGS = $logs; $env:GF_PATHS_PROVISIONING = "$conf\grafana\provisioning"
  $env:GF_SERVER_HTTP_ADDR = $bind; $env:GF_SERVER_HTTP_PORT = "$grafPort"
  Start-One 'grafana' $grafPort $exe.grafana @('server', '--homepath', "$bin\grafana") "$bin\grafana"
  Write-Host "[OK] native usage stack starting (Grafana http://127.0.0.1:$grafPort, logs $logs)"
}
function Stop-All { foreach ($n in 'grafana', 'prometheus', 'collector') { $id = Get-Pid $n; if ($id) { Stop-Process -Id $id -Force; Write-Host "[OK] stopped $n ($id)" }; Remove-Item "$run\$n.pid" -ErrorAction SilentlyContinue } }
switch ($Action) {
  'install' { Install-All }
  'start'   { Start-All }
  'stop'    { Stop-All }
  'paths'   { Write-Output $home_ }
  'status'  { $bad = 0; foreach ($n in 'collector', 'prometheus', 'grafana') { $id = Get-Pid $n; if ($id) { Write-Host "[OK] $n pid $id" } else { Write-Host "[FAIL] $n not running"; $bad = 1 } }; exit $bad }
}
