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

set "NEED_DEPENDENCY_REPAIR="
if not exist "node_modules\vite\bin\vite.js" set "NEED_DEPENDENCY_REPAIR=1"
if not exist "node_modules\.bin\vite.cmd" set "NEED_DEPENDENCY_REPAIR=1"

if defined NEED_DEPENDENCY_REPAIR (
  echo [SETUP] Installing or repairing web dependencies. Please wait...
  call npm.cmd install --include=dev --no-audit --no-fund
  if errorlevel 1 if not exist "node_modules\vite\bin\vite.js" (
    echo [ERROR] Dependency installation failed. Check the messages above and your network connection.
    pause
    exit /b 1
  )
)

echo Starting the full web app at http://127.0.0.1:1420/
echo Keep this window open while using the app. Press Ctrl+C to stop it.
if exist "node_modules\.bin\vite.cmd" (
  call npm.cmd run web
) else (
  echo [WARN] npm command shims are unavailable. Starting Vite directly.
  call node "node_modules\vite\bin\vite.js" --host 127.0.0.1 --open
)

if errorlevel 1 (
  echo.
  echo [ERROR] The web app did not start. Check the messages above.
  pause
  exit /b 1
)
