@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" web_server.py %*
) else (
  python web_server.py %*
)
if errorlevel 1 pause
