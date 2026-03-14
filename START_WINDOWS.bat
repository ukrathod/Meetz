@echo off
title Meetz Server
echo.
echo  ============================================
echo    MEETZ v2.0 — Starting Server
echo  ============================================
echo.

cd /d "%~dp0"

node --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js is NOT installed.
    echo.
    echo  1. Go to https://nodejs.org
    echo  2. Download the LTS version
    echo  3. Install it ^(just click Next a few times^)
    echo  4. Restart your PC
    echo  5. Double-click this file again
    echo.
    pause
    exit /b 1
)

echo  Installing packages ^(first time only, takes ~30 sec^)...
call npm install

echo.
echo  ============================================
echo    Meetz is LIVE!
echo.
echo    Open your browser and go to:
echo    http://localhost:3000
echo.
echo    Test Connect Codes:
echo    - Open TWO browser tabs/windows
echo    - Both go to http://localhost:3000
echo    - Enter same code in both
echo    - They will connect to each other!
echo  ============================================
echo.
echo  Keep this window open. Press Ctrl+C to stop.
echo.

node server.js
pause
