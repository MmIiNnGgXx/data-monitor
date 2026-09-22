@echo off
title Install Autostart
cd /d "%~dp0"

echo.
echo   Registering: start Data Monitor automatically on logon ...
echo.

schtasks /create /tn "DataMonitor" /tr "\"%~dp0run-server-silent.bat\"" /sc onlogon /f
if errorlevel 1 goto FAIL

echo.
echo   [OK] Registered. It will start silently in the background after logon.
echo        Log file: logs\server.log
echo.
echo   To undo, run:  uninstall-autostart.bat
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