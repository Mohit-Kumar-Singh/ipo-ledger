@echo off
REM Launched either by double-clicking directly, or by the portal's "Run
REM local sync bot" button via the ipojisyncbot:// link (see
REM register-protocol.ps1) - %~dp0 resolves to this file's own folder
REM regardless of which way it was started, so it always finds npm start
REM here rather than wherever the browser's working directory happened to be.
title ipoji sync bot
cd /d "%~dp0"
set PORTAL_URL=https://mohit-kumar-singh-ipo-ledger.vercel.app
call npm start
echo.
echo ---
echo Done (or stopped on an error above). Press any key to close this window...
pause >nul
