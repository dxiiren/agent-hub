@echo off
setlocal
set "sub=%~1"
set "rest="
rem SHIFT does not change %%*: cut the subcommand word off the raw argument string (quotes inside it stay intact)
for /f "tokens=1,* delims= " %%a in ("%*") do set "rest=%%b"
if /i "%sub%"=="usage" goto usage
if /i "%sub%"=="doctor" goto doctor
if /i "%sub%"=="provider" goto provider
if /i "%sub%"=="route" goto route
if /i "%sub%"=="reply" goto reply
if /i "%sub%"=="cleanup" goto cleanup
echo usage: agent-hub usage --session ID [--json] ^| agent-hub doctor [--deep] ^| agent-hub provider add^|list^|remove ^| agent-hub route TYPE "prompt" [opts] ^| agent-hub cleanup [--older-than 30m] [--mine^|--all] [--dry-run] ^| agent-hub reply AGENTID "text" 1>&2
exit /b 2
:usage
python -S -E "%~dp0agent_hub_usage.py" %*
exit /b %errorlevel%
:doctor
node "%~dp0..\..\..\scripts\hub.mjs" doctor %rest%
exit /b %errorlevel%
:provider
node "%~dp0..\..\..\scripts\hub.mjs" provider %rest%
exit /b %errorlevel%
:reply
node "%~dp0..\..\routing\route.mjs" reply %rest%
exit /b %errorlevel%
:route
node "%~dp0..\..\routing\route.mjs" %rest%
exit /b %errorlevel%

:cleanup
node "%~dp0..\..outing\cleanup.mjs" %rest%
exit /b %errorlevel%
