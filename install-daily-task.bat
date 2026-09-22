@echo off
title Install Daily Task
cd /d "%~dp0"

echo.
echo   Registering: collect data every day at 08:00 ...
echo.

schtasks /create /tn "DataMonitor-Daily" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0run-daily.ps1\"" /sc daily /st 08:00 /f
if errorlevel 1 goto FAIL

echo.
echo   [OK] Registered. Every day at 08:00 it will:
echo        - collect all targets once
echo        - push a notification if any alert / failure (configure it in the console)
echo        - write the report into  out\   and the log into  logs\
echo.
echo   To undo:  schtasks /delete /tn "DataMonitor-Daily" /f
echo.
pause
exit /b 0

:FAIL
echo.
echo   [FAILED] Permission denied.
echo   Please RIGHT-CLICK this file and choose "Run as administrator".
echo.
pause
exit /b 1