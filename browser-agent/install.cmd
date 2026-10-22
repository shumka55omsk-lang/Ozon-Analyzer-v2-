@echo off
cd /d "%~dp0"
echo === Ozon Seller Browser Audit ===
where node >nul 2>&1 || (echo Node.js 22+ not found. Install Node.js from https://nodejs.org/ && pause && exit /b 1)
call npm install
if errorlevel 1 (echo npm install failed && pause && exit /b 1)
echo Running setup...
node setup.mjs
echo Setup finished.
pause
