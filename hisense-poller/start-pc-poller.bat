@echo off
REM ╔══════════════════════════════════════════════════════════════╗
REM ║  LaundryHub — local PC poller                                ║
REM ║                                                              ║
REM ║  Use this when Fly.io is down OR you want to test locally.   ║
REM ║                                                              ║
REM ║  1. Open admin → API tab → set Active poller to "PC"         ║
REM ║  2. Double-click this file (or run it from PowerShell)       ║
REM ║  3. Keep this window open — close it = poller stops          ║
REM ║                                                              ║
REM ║  To switch back to Fly.io:                                   ║
REM ║  1. Admin → API tab → Active poller "Fly"                    ║
REM ║  2. Close this window                                        ║
REM ╚══════════════════════════════════════════════════════════════╝

setlocal
cd /d "%~dp0"
set POLLER_ID=pc

echo.
echo ===============================================
echo   LaundryHub PC Poller — starting...
echo ===============================================
echo.
echo  Tagged as POLLER_ID=pc
echo  Will only write to Firebase when admin sets
echo  Active Poller = "PC" in the app's API tab.
echo.
echo  Press Ctrl+C to stop.
echo.

REM Check Python is available
where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python is not installed or not in PATH.
  echo Install from https://www.python.org/downloads/ and check
  echo "Add python.exe to PATH" during install.
  pause
  exit /b 1
)

REM Auto-install requirements first time (idempotent — pip skips if already installed)
echo Checking dependencies...
python -m pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo [WARN] pip install had issues — continuing anyway.
)

REM Run the poller. Will loop forever via supervisor inside poller.py.
echo.
echo Starting poller...
echo.
python poller.py

echo.
echo Poller exited. Press any key to close.
pause >nul
