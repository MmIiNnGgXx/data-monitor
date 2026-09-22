@echo off
title Data Monitor
cd /d "%~dp0"
if not exist logs mkdir logs

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   ==================================================
echo     Data Monitor  -  starting ...
echo   ==================================================
echo.
echo   A "Data Monitor Service" window will open.
echo   Please KEEP IT OPEN (you may minimize it).
echo.
echo   Your browser will open the console automatically.
echo   To STOP monitoring: close that service window.
echo.

start "Data Monitor Service" cmd /k "node server.mjs --port=4210"

rem wait ~3 seconds for the server to come up (ping works even with redirected IO)
ping 127.0.0.1 -n 4 >nul

start "" http://127.0.0.1:4210/
echo.
echo   Started. You can close THIS window now.
echo.
ping 127.0.0.1 -n 5 >nul
exit /b 0

:NONODE
echo.
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Please install Node.js first (free, about 1 minute):
echo     1. Open  https://nodejs.org/
echo     2. Download the LTS version and install it
echo     3. Then double-click this file again
echo.
pause
exit /b 1