@echo off
title LightStock
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org/ and check "Add to PATH"
  pause
  exit /b 1
)

if not exist "server\node_modules" (
  echo [1/3] Installing backend dependencies - first run, needs internet...
  pushd server
  call npm install --no-audit --no-fund
  popd
)

if not exist "web\node_modules" (
  echo [2/3] Installing frontend dependencies - needs internet...
  pushd web
  call npm install --no-audit --no-fund
  popd
)

if not exist "web\dist\index.html" (
  echo [3/3] Building frontend - first run, about 1-2 min...
  pushd web
  call npm run build
  popd
)

echo.
echo Starting server... browser will open at http://localhost:3000
echo Close this window to stop. Data file: server\data\warehouse.db
echo.
start "" http://localhost:3000
pushd server
node src/index.js
popd
pause
