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

REM Wipe the stored session so a FRESH QR always shows
echo [2/3] Resetting WhatsApp session (fresh QR)...
rmdir /s /q ".wwebjs_auth" 2>nul
del /q ".wwebjs_auth\*" 2>nul

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

echo Restarting in 5 seconds (Ctrl+C in the next window breaks here)...
timeout /t 5 /nobreak >nul
echo.
goto loop