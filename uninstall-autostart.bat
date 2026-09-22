@echo off
title Uninstall Autostart
cd /d "%~dp0"

schtasks /delete /tn "DataMonitor" /f
if errorlevel 1 goto FAIL

echo.
echo   [OK] Autostart removed.
echo.
pause
exit /b 0

:FAIL
echo.
echo   Task not found, or permission denied.
echo   Please RIGHT-CLICK this file and choose "Run as administrator".
echo.
pause
exit /b 1