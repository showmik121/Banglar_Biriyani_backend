@echo off
rem Creates .env from env-ready.txt, then opens it in Notepad so you can add your password.
cd /d "%~dp0"
if exist .env (
  echo .env already exists. Opening it in Notepad.
) else (
  if not exist env-ready.txt (
    echo env-ready.txt not found.
    pause
    exit /b 1
  )
  move /y env-ready.txt .env >nul
  echo Created .env
)
echo.
echo In Notepad: replace [YOUR-PASSWORD] in BOTH lines with your Supabase database password,
echo fill SEED_ADMIN_PASSWORD and SEED_STAFF_PASSWORD, then press Ctrl+S and close Notepad.
start "" notepad .env
