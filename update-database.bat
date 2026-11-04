@echo off
rem Applies small, safe updates to the live database. Keeps all existing data.
cd /d "%~dp0"
if not exist .env (
  echo STOP: .env file not found in this folder.
  pause
  exit /b 1
)
call npm run db:upgrade > update-log.txt 2>&1
echo EXIT=%ERRORLEVEL%>> update-log.txt
type update-log.txt
echo.
pause
