@echo off
chcp 65001 > nul
title Restore Sniper V2 Full Snapshot [15]
color 0E
cls
echo ===================================================================
echo   🔄 NFT SNIPER V2 - 1-CLICK COMPLETE RESTORE SNAPSHOT [15]
echo ===================================================================
echo.
echo   Target Project Folder: C:\Users\MY PC\OneDrive\Desktop\abc\sniper v2
echo   GitHub & Live Site:    https://github.com/Jainbharat666/aero-sniper
echo.
echo   WARNING: This will restore your entire Sniper V2 project to Snapshot [15]!
echo   (Complete with node_modules, cache, scripts and UI assets)
echo.
echo ===================================================================
echo   Press ANY KEY to execute 100%% COMPLETE RESTORE...
echo   (Or close this window to cancel)
echo ===================================================================
pause > nul
echo.
echo [1/2] Restoring Complete Local Codebase & Dependencies...
robocopy "%~dp0." "C:\Users\MY PC\OneDrive\Desktop\abc\sniper v2" /E /XD ".git" /MT:16 > nul
echo.
echo ===================================================================
echo   🎉 SUCCESS: 100%% FULL PROJECT VERSION [15] RESTORED!
echo ===================================================================
echo.
set /p PUSH_GHT="🚀 Do you want to push this restored version to GitHub ^& Vercel? (Y/N, default Y): "
if /i "%PUSH_GHT%"=="" set PUSH_GHT=Y
if /i "%PUSH_GHT%"=="Y" (
    if exist "C:\Users\MY PC\OneDrive\Desktop\abc\sniper v2\push_to_github.bat" call "C:\Users\MY PC\OneDrive\Desktop\abc\sniper v2\push_to_github.bat" --auto
)
echo.
pause
