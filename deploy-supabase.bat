@echo off
setlocal
rem Put the backend API live on Supabase Edge Functions.
rem Double-click this file. It asks for your Supabase Project ID once per run.
cd /d "%~dp0"

if not exist .env (
  echo STOP: .env file not found in this folder. It holds DATABASE_URL and JWT_SECRET.
  pause
  exit /b 1
)

rem The Project ID is saved in supabase-project-id.txt (not a secret).
set PROJECT_REF=
if exist supabase-project-id.txt set /p PROJECT_REF=<supabase-project-id.txt
if "%PROJECT_REF%"=="" (
  echo Supabase Dashboard -^> your project -^> Project Settings -^> General -^> "Project ID"
  set /p PROJECT_REF=Paste your Supabase Project ID here: 
)
if "%PROJECT_REF%"=="" (
  echo No Project ID given.
  pause
  exit /b 1
)

echo.
echo [1/5] Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo.
echo [2/5] Building the API for Supabase...
call node edge/build.mjs
if errorlevel 1 goto fail

echo.
echo [3/5] Signing in to Supabase. Press Enter if asked, then click Authorize in the browser...
rem Already signed in? Then skip the browser login.
call npx --yes supabase projects list >nul 2>nul
if errorlevel 1 (
  call npx --yes supabase login
  if errorlevel 1 goto fail
) else (
  echo Already signed in.
)

echo.
echo [4/5] Copying secrets from .env to Supabase (values are not shown)...
call npx --yes supabase secrets set --env-file .env --project-ref %PROJECT_REF% --yes
if errorlevel 1 goto fail
call npx --yes supabase secrets set NODE_ENV=production --project-ref %PROJECT_REF% --yes
if errorlevel 1 goto fail

echo.
echo [5/5] Deploying the "api" function...
call npx --yes supabase functions deploy api --project-ref %PROJECT_REF% --no-verify-jwt --use-api --yes
if errorlevel 1 goto fail

set API_URL=https://%PROJECT_REF%.supabase.co/functions/v1/api
echo.
echo Checking %API_URL%/health
curl -s %API_URL%/health
echo.

rem Point the Netlify site at the new backend (frontend folder next to this one)
set REDIRECTS=..\Banglar_Biriyani_frontend\public\_redirects
if exist "%REDIRECTS%" (
  (
    echo # Netlify routing rules ^(order matters: first match wins^).
    echo.
    echo # 1^) API calls go to the backend on Supabase Edge Functions.
    echo /api/*  %API_URL%/:splat  200!
    echo.
    echo # 2^) Every other page ^(/admin, /admin/orders, ...^) loads the React app.
    echo /*  /index.html  200
  ) > "%REDIRECTS%"
  echo Updated the frontend's _redirects file.
  echo NEXT: run push-to-github in Banglar_Biriyani_frontend so Netlify picks it up.
) else (
  echo Add this line at the top of the frontend's public\_redirects file:
  echo /api/*  %API_URL%/:splat  200!
)

echo.
echo DONE. Backend is live at %API_URL%
pause
exit /b 0

:fail
echo.
echo Something failed above. Read the red message, fix it, then run this file again.
pause
exit /b 1
