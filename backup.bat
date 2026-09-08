@echo off
chcp 65001 > nul
title NFT Sniper V2 - Automated Script Backup Generator
color 0A
cls

echo ===================================================================
echo      🛡️ NFT SNIPER V2 SCRIPT ^& CODE FILE BACKUP GENERATOR 🛡️
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

:: Step 2: Copy Project Files (Excluding dependencies and git history)
echo [2/3] Copying script files to folder [%NEXT_NUM%]...
robocopy "%ROOT%" "%DEST_FOLDER%" /E /XD "node_modules" ".git" "cache" "backups" > nul
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
echo chcp 65001 ^> nul
echo title Restore Sniper V2 Script Snapshot [%NEXT_NUM%]
echo color 0E
echo cls
echo echo ===================================================================
echo echo   🔄 NFT SNIPER V2 - 1-CLICK CODE RESTORE SNAPSHOT [%NEXT_NUM%]
echo echo ===================================================================
echo echo.
echo echo   Target Project Folder: %ROOT%
echo echo   GitHub ^& Live Site:    https://github.com/Jainbharat666/aero-sniper
echo echo.
echo echo   WARNING: This will rollback your Sniper V2 script code to Snapshot [%NEXT_NUM%]!
echo echo   (Note: Cloud subscriber database is untouched and stays 100%%%% intact^)
echo echo.
echo echo ===================================================================
echo echo   Press ANY KEY to execute 100%%%% SCRIPT CODE RESTORE...
echo echo   (Or close this window to cancel^)
echo echo ===================================================================
echo pause ^> nul
echo echo.
echo echo [1/2] Restoring Local PC Script Codebase...
echo robocopy "%%~dp0." "%ROOT%" /E /XD "node_modules" ".git" "cache" "backups" ^> nul
echo echo.
echo echo ===================================================================
echo echo   🎉 SUCCESS: SCRIPT CODE VERSION [%NEXT_NUM%] RESTORED!
echo echo ===================================================================
echo echo.
echo set /p PUSH_GHT="🚀 Do you want to push this restored script to GitHub ^& Vercel? (Y/N, default Y): "
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
echo NFT SNIPER V2 SCRIPT SNAPSHOT - VERSION [%NEXT_NUM%]
echo ===================================================================
echo Date/Time: %DATE% %TIME%
echo Source:    %ROOT%
echo Target:    %DEST_FOLDER%
echo GitHub:    https://github.com/Jainbharat666/aero-sniper
echo Live Site: https://aero-sniper.vercel.app
echo.
echo INCLUDED SCRIPT MODULES:
echo - server.js (Node backend, Seaport 1.6 execution, laser grid)
echo - public/index.html (Tailwind CSS, frontend UI and console)
echo - src/stream.js (WebSocket Stream Listener)
echo - src/rarity.js (OpenRarity Engine)
echo - src/executor.js (Seaport Transaction Builder)
echo - src/config.js (Configurations)
echo - .env, package.json, START_SNIPER.bat, push_to_github.bat
echo ===================================================================
) > "%DEST_FOLDER%\SNAPSHOT_INFO.txt"

:: Step 3: Create Zip Archive
echo [3/3] Creating complete compressed archive [%NEXT_NUM%.zip]...
powershell -NoProfile -Command "Compress-Archive -Path '%DEST_FOLDER%\*' -DestinationPath '%DEST_ZIP%' -CompressionLevel Optimal -Force"

if exist "%DEST_ZIP%" (
    echo    ✅ Zip created:    %DEST_ZIP%
) else (
    echo    ⚠️ Warning: Zip creation might have encountered an issue.
)

echo.
echo ===================================================================
echo   🎉 SCRIPT BACKUP [%NEXT_NUM%] COMPLETED SUCCESSFULLY! 🎉
echo.
echo   📁 Folder: %DEST_FOLDER%
echo   📦 Zip:    %DEST_ZIP%
echo ===================================================================
echo.

set PUSH_NOW=Y
set /p PUSH_NOW="🚀 Do you also want to push this script to GitHub & update Vercel live site? (Y/N, default Y): "
if /i "%PUSH_NOW%"=="" set PUSH_NOW=Y
if /i "%PUSH_NOW%"=="Y" (
    if exist "%ROOT%\push_to_github.bat" (
        echo.
        call "%ROOT%\push_to_github.bat" --auto
    )
)

echo.
pause
