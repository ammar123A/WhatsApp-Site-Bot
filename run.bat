@echo off
cd /d "%~dp0"
title WhatsApp Site Bot - SiteMate

:loop
echo.
echo ==============================================
echo  WhatsApp Site Bot launcher
echo ==============================================
echo.

REM Kill any leftover bot node/chrome processes from a previous run
echo [1/3] Cleaning up old bot processes...
for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH 2^>nul') do (
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'wwebjs_auth' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'index.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

REM Keep the stored session - re-linking a new device on every start is a
REM strong automation signal to WhatsApp. It is only wiped on exit code 2.
echo [2/3] Keeping existing WhatsApp session...

echo [3/3] Starting bot...
echo.

node index.js
set EXITCODE=%ERRORLEVEL%

echo.
echo Bot exited with code %EXITCODE%.
if "%EXITCODE%"=="0" (
  echo Manual stop detected. Exiting launcher.
  pause
  exit /b 0
)

REM Exit code 2 = session revoked by WhatsApp - wipe it so a fresh QR shows
if "%EXITCODE%"=="2" (
  echo Stale session - wiping it, a fresh QR will show.
  rmdir /s /q ".wwebjs_auth" 2>nul
)

REM Long delay so a crash loop doesn't hammer WhatsApp with logins
echo Restarting in 60 seconds (Ctrl+C breaks here)...
timeout /t 60 /nobreak >nul
echo.
goto loop