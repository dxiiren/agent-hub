<#
.SYNOPSIS
    Installs the `just` command runner on Windows, so `just install` can run.

.DESCRIPTION
    Solves the chicken-and-egg problem of a fresh PC: every repo's one-command setup is
    `just install`, but you need `just` to run it. Run this script first:

        powershell -ExecutionPolicy Bypass -File install-just.ps1

    Flow (each step is skipped once `just` works):
      1. `just` already runs        -> print its version, exit 0.
      2. winget Casey.Just          -> exit code -1978335189 means "already installed" and is fine.
      3. Refresh PATH from the Machine + User environment.
      4. WinGet Links fix           -> winget leaves just.exe in a versioned Packages folder that is
                                       not on PATH; copy it to WinGet\Links and put Links on the User PATH.
      5. Fallbacks                  -> scoop, then `uv tool install rust-just`.
      6. Verify, and say what to do next. Exits non-zero if every route failed.

    Windows PowerShell 5.1 compatible. Idempotent. Safe to re-run.

.PARAMETER DryRun
    Print the plan and what would be done, change nothing.

.PARAMETER Force
    Install again even if `just` already runs.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$WingetId   = 'Casey.Just'
$WingetDone = -1978335189   # 0x8A15002B: winget says the package is already installed

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-JustVersion {
    if (-not (Test-Command 'just')) { return $null }
    try {
        $v = & just --version 2>&1 | Select-Object -First 1
        if ($LASTEXITCODE -eq 0 -and $v) { return [string]$v }
    } catch { }
    return $null
}

function Add-UserPath([string]$Dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries  = @()
    if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
    $already = $false
    foreach ($e in $entries) {
        if ($e.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { $already = $true }
    }
    if (-not $already) {
        $new = (@($entries) + $Dir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $new, 'User')
        Write-Host "[OK] Added $Dir to the User PATH" -ForegroundColor Green
    }
}

function Invoke-Native([scriptblock]$Block) {
    # Native tools write progress to stderr; do not let that become a terminating error.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>&1 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray } } finally { $ErrorActionPreference = $saved }
    return $LASTEXITCODE
}

# ---------- the plan ----------
$linksDir    = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
$packagesDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'

Write-Host ''
Write-Host 'install-just: get the `just` command runner' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
if ($DryRun) {
    Write-Host '[DRY RUN] Nothing will be changed. The plan:' -ForegroundColor Yellow
    Write-Host "  1. If 'just --version' already works: print it and stop (unless -Force)."
    Write-Host "  2. winget install --id $WingetId -e --accept-source-agreements --accept-package-agreements"
    Write-Host "     (exit code $WingetDone = already installed = fine)"
    Write-Host '  3. Refresh PATH from Machine + User.'
    Write-Host "  4. If just is still missing: copy just.exe from $packagesDir"
    Write-Host "     to $linksDir and add that folder to the User PATH."
    Write-Host '  5. Still missing: scoop install just, then uv tool install rust-just.'
    Write-Host '  6. Verify, then: open a new terminal, then: just install'
    Write-Host ''
}

# ---------- 1. already installed? ----------
$ver = Get-JustVersion
if ($ver -and -not $Force) {
    Write-Host "[OK] just already installed: $ver" -ForegroundColor Green
    Write-Host '     Next: just install' -ForegroundColor Gray
    exit 0
}
if ($DryRun) {
    if ($ver) { Write-Host "[DRY RUN] just is installed ($ver); -Force would reinstall it via the steps above." -ForegroundColor Yellow }
    else      { Write-Host '[DRY RUN] just is not on PATH; a real run would install it via the steps above.' -ForegroundColor Yellow }
    exit 0
}

# ---------- 2. winget ----------
if (Test-Command 'winget') {
    Write-Host "[INSTALL] winget install --id $WingetId ..." -ForegroundColor Yellow
    $wingetArgs = @('install', '--id', $WingetId, '-e', '--accept-source-agreements', '--accept-package-agreements')
    if ($Force) { $wingetArgs += '--force' }
    $code = Invoke-Native { & winget @wingetArgs }
    if ($code -eq 0 -or $code -eq $WingetDone) {
        Write-Host "[OK] winget finished (exit $code)" -ForegroundColor Green
    } else {
        Write-Host "[WARN] winget exited $code -- trying the other routes." -ForegroundColor Yellow
    }
} else {
    Write-Host '[WARN] winget not found (install "App Installer" from the Microsoft Store: https://aka.ms/getwinget).' -ForegroundColor Yellow
}

# ---------- 3. refresh PATH ----------
Refresh-Path

# ---------- 4. the WinGet Links gap ----------
if (-not (Get-JustVersion) -and (Test-Path $packagesDir)) {
    $exe = Get-ChildItem -Path $packagesDir -Recurse -Filter 'just.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($exe) {
        Write-Host "[FIX] winget left just.exe off PATH; copying it to $linksDir" -ForegroundColor Yellow
        if (-not (Test-Path $linksDir)) { New-Item -ItemType Directory -Path $linksDir -Force | Out-Null }
        Copy-Item -Path $exe.FullName -Destination (Join-Path $linksDir 'just.exe') -Force
        Add-UserPath $linksDir
        Refresh-Path
    }
}

# ---------- 5. fallbacks ----------
if (-not (Get-JustVersion) -and (Test-Command 'scoop')) {
    Write-Host '[INSTALL] scoop install just ...' -ForegroundColor Yellow
    [void](Invoke-Native { & scoop install just })
    Refresh-Path
}
if (-not (Get-JustVersion) -and (Test-Command 'uv')) {
    Write-Host '[INSTALL] uv tool install rust-just ...' -ForegroundColor Yellow
    [void](Invoke-Native { & uv tool install rust-just })
    Refresh-Path
    # uv puts its tool shims in ~/.local/bin; make sure that is on PATH too.
    $uvBin = Join-Path $env:USERPROFILE '.local\bin'
    if ((Test-Path (Join-Path $uvBin 'just.exe')) -and -not (Get-JustVersion)) {
        Add-UserPath $uvBin
        Refresh-Path
    }
}

# ---------- 6. verify ----------
$ver = Get-JustVersion
if ($ver) {
    Write-Host "[OK] just installed: $ver" -ForegroundColor Green
    Write-Host '     Open a new terminal (so the PATH change lands), then: just install' -ForegroundColor Gray
    exit 0
}

Write-Host '[FAIL] Could not install just: winget, the WinGet Links fix, scoop and uv all failed or are missing.' -ForegroundColor Red
Write-Host '       Install it by hand from https://github.com/casey/just#packages, then open a new terminal and run: just install' -ForegroundColor Red
exit 1
