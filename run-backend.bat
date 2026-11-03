@echo off
title Banglar Biriyani - API server
cd /d "%~dp0"
if not exist .env (
  echo No .env file found. Copy .env.example to .env and fill in your Supabase DATABASE_URL first.
  pause
  exit /b 1
)
if not exist node_modules call npm install
echo Starting the API at http://localhost:3001
call npm run dev
pause
