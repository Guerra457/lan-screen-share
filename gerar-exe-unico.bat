@echo off
cd /d %~dp0
call npm install
call npm run dist
echo.
echo O .exe unico esta na pasta "dist".
pause
