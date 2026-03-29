@echo off
setlocal EnableExtensions

set "interval=%~1"
if "%interval%"=="" set "interval=30"

set "mode=%~2"
set "sessions_dir=%~dp0sessions"

:wait_loop
for %%F in ("%sessions_dir%\*.md") do (
    if exist "%%~fF" (
        echo TASK_DETECTED %%~nxF
        exit /b 0
    )
)

if /I not "%mode%"=="continuous" (
    exit /b 1
)

timeout /t %interval% /nobreak >nul
goto wait_loop
