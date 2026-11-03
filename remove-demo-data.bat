@echo off
rem Removes the demo customer account and demo order from the live database.
cd /d "%~dp0"
if not exist .env (
  echo STOP: .env file not found in this folder.
  pause
  exit /b 1
)
call npm run db:remove-demo
echo.
pause
