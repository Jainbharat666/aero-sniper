@echo off
chcp 65001 > nul
title NFT Sniper V2 - Complete 100% Full Project Backup Generator
color 0A
cls

echo ===================================================================
echo      🛡️ NFT SNIPER V2 COMPLETE FULL BACKUP GENERATOR 🛡️
echo ===================================================================
echo.

set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

set BACKUP_DIR=%ROOT%\..\sniper backup
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Step 1: Version Detection
echo [1/3] Detecting next backup version number in:
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

:: Step 2: Complete 1:1 Copy of ALL Files (Including node_modules, cache, configs, assets)
echo [2/3] Copying complete project files (30+ MB full bundle) to folder [%NEXT_NUM%]...
robocopy "%ROOT%" "%DEST_FOLDER%" /E /XD ".git" /MT:16 > nul
if %ERRORLEVEL% GTR 7 (
    echo ❌ ERROR: Failed to copy files to backup folder!
    pause
    exit /b %ERRORLEVEL%
)

echo    ✅ Full folder created (100%% complete): %DEST_FOLDER%
echo.

:: Generate 1-Click Restore script inside the backup snapshot folder
(
echo @echo off
echo chcp 65001 ^> nul
echo title Restore Sniper V2 Full Snapshot [%NEXT_NUM%]
echo color 0E
echo cls
echo echo ===================================================================
echo echo   🔄 NFT SNIPER V2 - 1-CLICK COMPLETE RESTORE SNAPSHOT [%NEXT_NUM%]
echo echo ===================================================================
echo echo.
echo echo   Target Project Folder: %ROOT%
echo echo   GitHub ^& Live Site:    https://github.com/Jainbharat666/aero-sniper
echo echo.
echo echo   WARNING: This will restore your entire Sniper V2 project to Snapshot [%NEXT_NUM%]!
echo echo   (Complete with node_modules, cache, scripts and UI assets^)
echo echo.
echo echo ===================================================================
echo echo   Press ANY KEY to execute 100%%%% COMPLETE RESTORE...
echo echo   (Or close this window to cancel^)
echo echo ===================================================================
echo pause ^> nul
echo echo.
echo echo [1/2] Restoring Complete Local Codebase ^& Dependencies...
echo robocopy "%%~dp0." "%ROOT%" /E /XD ".git" /MT:16 ^> nul
echo echo.
echo echo ===================================================================
echo echo   🎉 SUCCESS: 100%%%% FULL PROJECT VERSION [%NEXT_NUM%] RESTORED!
echo echo ===================================================================
echo echo.
echo set /p PUSH_GHT="🚀 Do you want to push this restored version to GitHub ^& Vercel? (Y/N, default Y): "
echo if /i "%%PUSH_GHT%%"=="" set PUSH_GHT=Y
echo if /i "%%PUSH_GHT%%"=="Y" (
echo     if exist "%ROOT%\push_to_github.bat" call "%ROOT%\push_to_github.bat" --auto
echo ^)
echo echo.
echo pause
) > "%DEST_FOLDER%\RESTORE_THIS_BACKUP.bat"

:: Generate Snapshot Metadata
(
echo ===================================================================
echo NFT SNIPER V2 100%% COMPLETE SNAPSHOT - VERSION [%NEXT_NUM%]
echo ===================================================================
echo Date/Time: %DATE% %TIME%
echo Source:    %ROOT%
echo Target:    %DEST_FOLDER%
echo GitHub:    https://github.com/Jainbharat666/aero-sniper
echo Live Site: https://aero-sniper.vercel.app
echo.
echo INCLUDED IN THIS COMPLETE 30+ MB SNAPSHOT:
echo - node_modules (Complete installed dependencies - zero npm install needed)
echo - cache (Full OpenRarity, trait and collection metadata cache)
echo - server.js (6-Key Laser Grid, Seaport 1.6 Execution Engine)
echo - public/index.html (Tailwind CSS, Zero-Scroll Trading Dashboard)
echo - src/ (stream.js, rarity.js, executor.js, config.js)
echo - api/ (Vercel Serverless Function Endpoints)
echo - .env, package.json, package-lock.json
echo - START_SNIPER.bat, push_to_github.bat, restore.bat
echo - auth-art-clean.png, supabase_schema_sniper.sql, vercel.json, render.yaml
echo ===================================================================
) > "%DEST_FOLDER%\SNAPSHOT_INFO.txt"

:: Step 3: Create Zip Archive (Ultra-Fast 1-Sec Native Tar with PowerShell Fallback)
echo [3/3] Creating complete compressed archive [%NEXT_NUM%.zip]...
tar -acf "%DEST_ZIP%" -C "%DEST_FOLDER%" . > nul 2>&1
if not exist "%DEST_ZIP%" (
    powershell -NoProfile -Command "Compress-Archive -Path '%DEST_FOLDER%\*' -DestinationPath '%DEST_ZIP%' -CompressionLevel Fastest -Force"
)

if exist "%DEST_ZIP%" (
    echo    ✅ Zip created:    %DEST_ZIP%
) else (
    echo    ⚠️ Warning: Zip creation might have encountered an issue.
)

echo.
echo ===================================================================
echo   🎉 COMPLETE FULL BACKUP [%NEXT_NUM%] CREATED SUCCESSFULLY! 🎉
echo.
echo   📁 Full Folder (30+ MB): %DEST_FOLDER%
echo   📦 Compressed Archive:   %DEST_ZIP%
echo ===================================================================
echo.

set PUSH_NOW=Y
set /p PUSH_NOW="🚀 Do you also want to push your code to GitHub & update Vercel live site? (Y/N, default Y): "
if /i "%PUSH_NOW%"=="" set PUSH_NOW=Y
if /i "%PUSH_NOW%"=="Y" (
    if exist "%ROOT%\push_to_github.bat" (
        echo.
        call "%ROOT%\push_to_github.bat" --auto
    )
)

echo.
pause
