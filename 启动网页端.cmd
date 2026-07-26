@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer first.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Check your Node.js installation and PATH.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo [FIRST RUN] Installing web dependencies. Please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check the messages above and your network connection.
    pause
    exit /b 1
  )
)

echo Starting the full web app at http://127.0.0.1:1420/
echo Keep this window open while using the app. Press Ctrl+C to stop it.
call npm.cmd run web

if errorlevel 1 (
  echo.
  echo [ERROR] The web app did not start. Check the messages above.
  pause
  exit /b 1
)
