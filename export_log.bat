@echo off
setlocal EnableExtensions

cd /d %~dp0
if not exist logs mkdir logs

set "shell_log=logs\copilot-shell.log"

(
    echo [INFO] Starting Copilot CLI with shell output redirected to "%shell_log%".
    echo [INFO] Command line: copilot --allow-all --model=claude-sonnet-4.6 --log-dir=logs --log-level=all %*
    copilot --allow-all --model=claude-sonnet-4.6 --log-dir=logs --log-level=all %*
) > "%shell_log%" 2>&1

endlocal
