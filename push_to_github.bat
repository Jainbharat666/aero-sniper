@echo off
chcp 65001 > nul
title Push Aero-Sniper V2 to GitHub
color 0A
echo ===================================================================
echo      🚀 PUSHING AERO-SNIPER V2 CODE ^& DATABASE TO GITHUB... 🚀
echo ===================================================================
echo.
cd /d "%~dp0"

:: Step 1: Automated Database Snapshot
echo [1/6] Fetching complete Supabase Cloud database snapshot...
if exist "scripts\backup_db.js" (
    node "scripts\backup_db.js"
) else (
    echo       [NOTE] scripts\backup_db.js not found, skipping DB snapshot.
)
echo.

:: Step 2: Initialize git repo if not already done
if not exist ".git" (
    echo [2/6] Initializing git repository...
    git init
    echo       Done!
) else (
    echo [2/6] Git repository verified.
)

:: Step 3: Set git identity
echo [3/6] Setting git identity...
git config user.email "jainbharat666@gmail.com"
git config user.name "Jainbharat666"

:: Step 4: Configure remote origin safely using .git_token if needed
echo [4/6] Verifying remote origin...
set GHTOKEN=
if exist "%~dp0.git_token" set /p GHTOKEN=<"%~dp0.git_token"
git remote get-url origin >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if not "%GHTOKEN%"=="" (
        git remote add origin https://Jainbharat666:%GHTOKEN%@github.com/Jainbharat666/aero-sniper.git
    ) else (
        git remote add origin https://github.com/Jainbharat666/aero-sniper.git
    )
) else (
    if not "%GHTOKEN%"=="" (
        git remote set-url origin https://Jainbharat666:%GHTOKEN%@github.com/Jainbharat666/aero-sniper.git
    )
)

:: Step 5: Stage all changes
echo [5/6] Staging all files and database backups...
git add .

:: Step 6: Commit with timestamp
echo [6/6] Committing with timestamp...
git commit -m "Aero-Sniper V2 Full Sync Update - %DATE% %TIME%"

:: Step 7: Push to main
echo.
echo Pushing to GitHub (aero-sniper)...
git branch -M main
git push -u origin main --force

echo.
echo ===================================================================
echo   🎉 DONE! Aero-Sniper V2 code ^& database pushed successfully!
echo   📁 GitHub:  https://github.com/Jainbharat666/aero-sniper
echo   🌐 Vercel:  https://aero-sniper.vercel.app (Auto-deploying in ~15s)
echo ===================================================================
echo.
if not "%1"=="--auto" pause
