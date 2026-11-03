@echo off
rem Applies small, safe updates to the live database. Keeps all existing data.
cd /d "%~dp0"
if not exist .env (
  echo STOP: .env file not found in this folder.
  pause
  exit /b 1
)
call npm run db:upgrade
echo.
pause
