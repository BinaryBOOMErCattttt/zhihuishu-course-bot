@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)
if not exist config.json (
  echo Please copy config.example.json to config.json and fill studyUrl first.
  pause
  exit /b 1
)
node server.js
echo.
echo Server stopped.
pause
