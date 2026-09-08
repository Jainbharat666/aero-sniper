@echo off
title NFT Sniper V2 - Automated Full Backup Generator
color 0A
cls

echo ===================================================================
echo      🛡️ NFT SNIPER V2 AUTOMATED FULL BACKUP GENERATOR 🛡️
echo ===================================================================
echo.

set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

set BACKUP_DIR=%ROOT%\..\sniper backup
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Step 1: Automated Database Snapshot
echo [1/4] Running automated cloud database backup (Supabase)...
if exist "%ROOT%\scripts\backup_db.js" (
    node "%ROOT%\scripts\backup_db.js"
) else (
    echo       [NOTE] scripts\backup_db.js not found, skipping cloud DB dump.
)
echo.

:: Step 2: Version Detection
echo [2/4] Detecting next backup version number in:
echo       %BACKUP_DIR%
echo.

set NEXT_NUM=1
:find_loop
if exist "%BACKUP_DIR%\%NEXT_NUM%" (
    set /a NEXT_NUM+=1
    goto find_loop
)
if exist "%BACKUP_DIR%\%NEXT_NUM%.zip" (
    set /a NEXT_NUM+=1
    goto find_loop
)

echo 👉 Next Backup Version will be: [%NEXT_NUM%]
echo.
set DEST_FOLDER=%BACKUP_DIR%\%NEXT_NUM%
set DEST_ZIP=%BACKUP_DIR%\%NEXT_NUM%.zip

:: Step 3: Copy Project Files
echo [3/4] Copying complete project files to folder [%NEXT_NUM%]...
robocopy "%ROOT%" "%DEST_FOLDER%" /E /XD "node_modules" ".git" > nul
if %ERRORLEVEL% GTR 7 (
    echo ❌ ERROR: Failed to copy files to backup folder!
    pause
    exit /b %ERRORLEVEL%
)

echo    ✅ Folder created: %DEST_FOLDER%
echo.

:: Generate 1-Click Restore script inside the backup snapshot folder
(
echo @echo off
echo title Restore Sniper V2 Backup Snapshot [%NEXT_NUM%]
echo color 0E
echo cls
echo ===================================================================
echo   🔄 NFT SNIPER V2 - 1-CLICK RESTORE SNAPSHOT [%NEXT_NUM%]
echo ===================================================================
echo.
echo   Target Project Folder: %ROOT%
echo   GitHub ^& Live Site:    https://github.com/Jainbharat666/aero-sniper
echo.
echo   WARNING: This will restore your Sniper V2 codebase back to Snapshot [%NEXT_NUM%]!
echo.
echo ===================================================================
echo   Press ANY KEY to execute 100%%%% COMPLETE RESTORE...
echo   (Or close this window to cancel^)
echo ===================================================================
echo pause ^> nul
echo.
echo [1/2] Restoring Local PC Codebase...
echo robocopy "%%~dp0." "%ROOT%" /E /XD "node_modules" ".git" ^> nul
echo.
echo ===================================================================
echo   🎉 SUCCESS: VERSION [%NEXT_NUM%] RESTORED TO SNIPER V2!
echo ===================================================================
echo.
echo set /p PUSH_GHT="🚀 Do you want to push this restored version to GitHub ^& Vercel? (Y/N, default Y): "
echo if /i "%%PUSH_GHT%%"=="" set PUSH_GHT=Y
echo if /i "%%PUSH_GHT%%"=="Y" (
echo     if exist "%ROOT%\push_to_github.bat" call "%ROOT%\push_to_github.bat" --auto
echo ^)
echo.
echo pause
) > "%DEST_FOLDER%\RESTORE_THIS_BACKUP.bat"

:: Generate Snapshot Metadata
(
echo ===================================================================
echo NFT SNIPER V2 SNAPSHOT METADATA - VERSION [%NEXT_NUM%]
echo ===================================================================
echo Date/Time: %DATE% %TIME%
echo Source:    %ROOT%
echo Target:    %DEST_FOLDER%
echo GitHub:    https://github.com/Jainbharat666/aero-sniper
echo Live Site: https://aero-sniper.vercel.app
echo.
echo INCLUDED MODULES:
echo - server.js (6-Key Laser Grid, Seaport v1.6 Mempool Blast, SSE Engine)
echo - public/index.html (Tailwind CSS, Bento Box Deck, Zero-Scroll UI)
echo - src/stream.js (WebSocket Stream Listener)
echo - src/rarity.js (OpenRarity Engine)
echo - src/executor.js (Seaport Transaction Builder ^& Multi-RPC Dispatch)
echo - src/config.js (Network, RPC, Key Configurations)
echo - scripts/backup_db.js (Supabase 24/7 Cloud Database Backup Engine)
echo - backups/ (Supabase Cloud JSON Snapshots: Users, Invites, Configs, RPCs)
echo - .env, package.json, START_SNIPER.bat, push_to_github.bat
echo ===================================================================
) > "%DEST_FOLDER%\SNAPSHOT_INFO.txt"

:: Step 4: Create Zip Archive
echo [4/4] Creating complete compressed archive [%NEXT_NUM%.zip]...
powershell -NoProfile -Command "Compress-Archive -Path '%DEST_FOLDER%\*' -DestinationPath '%DEST_ZIP%' -CompressionLevel Optimal -Force"

if exist "%DEST_ZIP%" (
    echo    ✅ Zip created:    %DEST_ZIP%
) else (
    echo    ⚠️ Warning: Zip creation might have encountered an issue.
)

echo.
echo ===================================================================
echo   🎉 BACKUP [%NEXT_NUM%] COMPLETED SUCCESSFULLY! 🎉
echo.
echo   📁 Folder: %DEST_FOLDER%
echo   📦 Zip:    %DEST_ZIP%
echo ===================================================================
echo.

set PUSH_NOW=Y
set /p PUSH_NOW="🚀 Do you also want to push this backup to GitHub & update Vercel live site? (Y/N, default Y): "
if /i "%PUSH_NOW%"=="" set PUSH_NOW=Y
if /i "%PUSH_NOW%"=="Y" (
    if exist "%ROOT%\push_to_github.bat" (
        echo.
        call "%ROOT%\push_to_github.bat" --auto
    )
)

echo.
pause
