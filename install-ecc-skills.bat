@echo off
rem Copies the ECC skills, reviewer agents and coding rules into this project's .claude folder (for Claude Code).
cd /d "%~dp0"
if not exist ecc-skills (
  echo ecc-skills folder not found.
  pause
  exit /b 1
)
xcopy /e /i /y ecc-skills\skills .claude\skills >nul
xcopy /e /i /y ecc-skills\agents .claude\agents >nul
xcopy /e /i /y ecc-skills\rules .claude\rules\ecc >nul
echo Done. Open this folder in Claude Code and type /skills to see them.
pause
