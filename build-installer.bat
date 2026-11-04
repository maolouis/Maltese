@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 goto :nonode
node scripts\build-windows.mjs
goto :done
:nonode
echo [ERROR] Node.js not found on PATH. Install Node.js 18+ first, then run this script again.
:done
pause
