@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 exit /b 1
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Install the pnpm version declared in package.json, then run setup again.
  exit /b 1
)
call pnpm run setup:local
exit /b %errorlevel%
