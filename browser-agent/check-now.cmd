@echo off
cd /d "%~dp0"
node agent.mjs
echo.
echo Exit code: %ERRORLEVEL%
pause
