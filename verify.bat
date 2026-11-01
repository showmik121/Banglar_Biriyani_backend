@echo off
setlocal enabledelayedexpansion
rem Runs the same checks as GitHub Actions, on your own computer.
cd /d "%~dp0"
echo Running checks... (results are also saved to verify-log.txt)
(
  echo === npm install ===
  call npm install
  echo === typecheck ===
  call npm run typecheck
  echo TYPECHECK_EXIT=!errorlevel!
  echo === unit tests ===
  call npm run test:unit
  echo TEST_EXIT=!errorlevel!
) > verify-log.txt 2>&1
type verify-log.txt
echo.
echo Done. Look for EXIT=0 lines above: 0 means passed.
pause
