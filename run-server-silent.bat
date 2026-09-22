@echo off
rem Called by the scheduled task: start the service silently in the background.
cd /d "%~dp0"
if not exist logs mkdir logs
node server.mjs --port=4210 >> "logs\server.log" 2>&1