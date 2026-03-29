@echo off
cd /d %~dp0
set "ALITH_PORT=%PORT%"
if not defined ALITH_PORT set "ALITH_PORT=7439"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = [int]$env:ALITH_PORT; " ^
  "$connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); " ^
  "foreach ($processId in $connections) { if ($processId -and $processId -ne 0) { Write-Host ('[runserver] stopping previous listener PID=' + $processId + ' on port ' + $port); Stop-Process -Id $processId } }"

npm start
