@echo off
rem Changes the admin password/email/phone on the live database (details come from .env).
cd /d "%~dp0"
if not exist .env (
  echo STOP: .env file not found in this folder.
  pause
  exit /b 1
)
call npm run db:set-admin
echo.
pause
