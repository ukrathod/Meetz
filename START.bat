@echo off
title Meetz v4
cd /d "%~dp0"
echo.
echo  =============================================
echo    MEETZ v4 - Final Build
echo  =============================================
echo.
node --version >nul 2>&1
if errorlevel 1 (
  echo  Node.js NOT found. Download from: https://nodejs.org
  pause & exit /b 1
)
echo  Installing packages...
call npm install
echo.
echo  =============================================
echo    OPEN BROWSER: http://localhost:3000
echo    To test voice: open 2 browser windows
echo    Use same Connect Code to match together
echo  =============================================
echo.
node server.js
pause
