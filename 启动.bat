@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)
node server.js
echo.
echo Server stopped.
pause
