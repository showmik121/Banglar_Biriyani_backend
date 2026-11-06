@echo off
rem Creates the keys for phone notifications (once) and adds them to .env.
rem Afterwards run deploy-supabase.bat so Supabase gets them too.
cd /d "%~dp0"
node scripts/make-push-keys.mjs
echo.
echo Next: double-click deploy-supabase.bat to send the keys to Supabase.
pause
