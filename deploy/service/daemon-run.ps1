# Runs the Agent Hub daemon in the foreground with the plugin environment (the Task Scheduler task calls this).
# The plugins read the password and the routing file from the daemon's environment; both come from local files, never from the task definition.
$ErrorActionPreference = 'Stop'
$Home_ = if ($env:AGENT_HUB_HOME) { $env:AGENT_HUB_HOME } else { Join-Path $HOME '.paseo' }
$Repo  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$secret = Join-Path $Home_ 'agent-hub-secret'
if (Test-Path $secret) { $env:PASEO_PASSWORD = (Get-Content $secret -Raw).Trim() }
$port = if ($env:AGENT_HUB_PORT) { $env:AGENT_HUB_PORT } else { '6767' }
$env:AGENT_HUB_MCP = "http://127.0.0.1:$port/mcp/agents"
$routes = Join-Path $Repo 'config/routes/routes.local.json'
if (Test-Path $routes) { $env:AGENT_HUB_ROUTES = $routes }
if (-not $env:AGENT_HUB_OTLP) { $env:AGENT_HUB_OTLP = 'http://127.0.0.1:4318/v1/metrics' }
$env:AGENT_HUB_POLLER_DIR = Join-Path $Repo 'plugins/usage-otel/pollers'
# Gates and agents may run hooks through Git Bash: put it first so Windows does not pick System32's WSL bash.exe.
$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if ($git) { $gr = Split-Path (Split-Path $git); foreach ($d in @("$gr\bin", "$gr\usr\bin")) { if (Test-Path $d) { $env:Path = "$d;$env:Path" } } }
$paseo = (Get-Command paseo.cmd -ErrorAction SilentlyContinue).Source
if (-not $paseo) { $paseo = (Get-Command paseo -ErrorAction Stop).Source }
# Own hidden console + new process group: a stray CTRL_C_EVENT aimed at another console group (e.g. os.kill(pid, 0) on Windows) cannot reach the daemon.
$p = Start-Process -FilePath $paseo -ArgumentList @('daemon','run','--home',$Home_) -WindowStyle Hidden -PassThru
$p.WaitForExit()
exit $p.ExitCode
