@echo off
setlocal enabledelayedexpansion
rem Upload this folder to GitHub (first time and later updates).
cd /d "%~dp0"
set REPO=https://github.com/showmik121/Banglar_Biriyani_backend.git

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Close this window, restart the computer once, then try again.
  pause
  exit /b 1
)

rem Put the CI workflow where GitHub Actions looks for it
if exist github-ci.yml (
  if not exist .github\workflows mkdir .github\workflows
  move /y github-ci.yml .github\workflows\ci.yml >nul
)

if not exist .git (
  git init -b main
  git remote add origin %REPO%
)

rem Git needs a name and email for commits (asked only once)
for /f "delims=" %%i in ('git config user.email') do set GIT_EMAIL=%%i
if "!GIT_EMAIL!"=="" (
  echo Git needs your name and email to label your commits.
  set /p GIT_NAME=Your name: 
  set /p GIT_EMAIL=Your GitHub email: 
  git config --global user.name "!GIT_NAME!"
  git config --global user.email "!GIT_EMAIL!"
)

git add -A

rem Safety check: stop if a .env file was about to be uploaded
git diff --cached --name-only | findstr /r /c:"^\.env$" /c:"/\.env$" >nul
if not errorlevel 1 (
  echo STOP: a .env file is staged. It must never be pushed. Check .gitignore.
  pause
  exit /b 1
)

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Banglar Biriyani backend: theme, tests and CI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
)

echo.
echo Uploading to %REPO% ...
echo A GitHub sign-in window may open. Sign in with an account that can push to this repository.
git push -u origin main
if errorlevel 1 (
  echo.
  echo PUSH FAILED. Read the message above.
  echo "Permission denied" or "403" means this GitHub account has no access to the repository.
  pause
  exit /b 1
)

echo.
echo DONE. Open https://github.com/showmik121/Banglar_Biriyani_backend/actions to watch the tests run.
pause
