@echo off
if /i "%~1"=="usage" (python -S -E "%~dp0agent_hub_usage.py" %* & exit /b %errorlevel%)
if /i "%~1"=="route" (shift & node "%~dp0..\..\routing\route.mjs" %* & exit /b %errorlevel%)
echo usage: agent-hub usage --session ID [--json] ^| agent-hub route TYPE "prompt" [opts] 1>&2
exit /b 2
