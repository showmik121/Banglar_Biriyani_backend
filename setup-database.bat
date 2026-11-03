@echo off
setlocal
rem First-time database setup: creates the tables in Supabase and adds the admin account,
rem menu, delivery points and the DIU10 offer. Run this ONCE. Running it again erases all data.
cd /d "%~dp0"

if not exist .env (
  echo STOP: .env file not found in this folder.
  pause
  exit /b 1
)
findstr /b /c:"DATABASE_URL" .env | findstr /c:"[YOUR-PASSWORD]" >nul
if not errorlevel 1 (
  echo STOP: .env still contains [YOUR-PASSWORD]. Open .env in Notepad and put your database password there.
  pause
  exit /b 1
)

echo WARNING: this erases everything in the database and adds fresh starting data.
echo Close this window now if you already have real orders.
pause

echo.
echo [1/3] Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo.
echo [2/3] Creating tables in Supabase...
call npx drizzle-kit push --force
if errorlevel 1 goto fail

echo.
echo [3/3] Adding the admin account, menu, delivery points and offers...
call npm run db:seed
if errorlevel 1 goto fail

echo.
echo DONE. The database is ready.
pause
exit /b 0

:fail
echo.
echo Something failed above. Send a screenshot of this window.
pause
exit /b 1
