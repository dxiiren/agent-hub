# Run the host pollers (Qoder, OpenCode, limit %) on this machine. Credentials come from the environment only:
#   $env:USAGE_MONITOR_USER / $env:USAGE_MONITOR_PASS (limit % poller). HUB_DEV names this developer.
# Optional: pip install qoder-agent-sdk for the Qoder balance and reset date.
param([string]$Pollers = 'limits,qoder,opencode', [string]$Dev = $env:USERNAME, [int]$Port = 9109)
$env:POLLERS = $Pollers; $env:HUB_DEV = $Dev; $env:PORT = "$Port"
python "$PSScriptRoot/pollers.py"
