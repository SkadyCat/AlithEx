@echo off

setlocal EnableExtensions

cd /d %~dp0

:: 启动 copilot
copilot --allow-all --model=claude-sonnet-4.6

endlocal
