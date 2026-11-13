@echo off
setlocal
set "sub=%~1"
set "rest="
rem SHIFT does not change %%*: cut the subcommand word off the raw argument string (quotes inside it stay intact)
for /f "tokens=1,* delims= " %%a in ("%*") do set "rest=%%b"
if "%sub%"=="" goto help
if /i "%sub%"=="--help" goto help
if /i "%sub%"=="-h" goto help
if /i "%sub%"=="help" goto help
for %%h in (--help -h help) do if /i "%~2"=="%%h" goto help
if /i "%sub%"=="usage" goto usage
if /i "%sub%"=="direct" goto direct
if /i "%sub%"=="doctor" goto doctor
if /i "%sub%"=="provider" goto provider
if /i "%sub%"=="routes" goto routes
if /i "%sub%"=="route" goto route
if /i "%sub%"=="reply" goto reply
if /i "%sub%"=="cleanup" goto cleanup
echo usage: agent-hub usage --session ID [--json] ^| agent-hub doctor [--deep] ^| agent-hub provider add^|list^|remove ^| agent-hub routes show^|set^|chain^|move^|undo ^| agent-hub route TYPE "prompt" [opts] ^| agent-hub cleanup [--older-than 30m] [--mine^|--all] [--dry-run] ^| agent-hub reply AGENTID "text" 1>&2
exit /b 2
:help
node "%~dp0..\..\..\scripts\help.mjs" %sub%
exit /b %errorlevel%
:usage
python -S -E "%~dp0agent_hub_usage.py" %*
exit /b %errorlevel%
:direct
python -S -E "%~dp0agent_hub_direct.py" %rest%
exit /b %errorlevel%
:doctor
node "%~dp0..\..\..\scripts\hub.mjs" doctor %rest%
exit /b %errorlevel%
:provider
node "%~dp0..\..\..\scripts\hub.mjs" provider %rest%
exit /b %errorlevel%
:routes
node "%~dp0..\..\..\scripts\hub.mjs" routes %rest%
exit /b %errorlevel%
:reply
node "%~dp0..\..\routing\route.mjs" reply %rest%
exit /b %errorlevel%
:route
node "%~dp0..\..\routing\route.mjs" %rest%
exit /b %errorlevel%

:cleanup
node "%~dp0..\..\routing\cleanup.mjs" %rest%
exit /b %errorlevel%
