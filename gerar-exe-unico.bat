@echo off
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instalando via winget...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo.
    echo Nao foi possivel instalar automaticamente.
    echo Instale o Node.js LTS em https://nodejs.org e rode este arquivo de novo.
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

call npm install
call npm run dist
pause
