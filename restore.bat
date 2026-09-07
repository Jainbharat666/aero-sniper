@echo off
title NFT Sniper V2 - Universal 1-Click Restore Manager
color 0B
cls

set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%
set BACKUP_DIR=%ROOT%\..\sniper backup

echo ===================================================================
echo         🔄 NFT SNIPER V2 UNIVERSAL RESTORE MANAGER 🔄
echo ===================================================================
echo.

if not exist "%BACKUP_DIR%" (
    echo [ERROR] No backup directory found at:
    echo        %BACKUP_DIR%
    echo.
    echo Please run backup.bat first to create your first backup!
    pause
    exit /b 1
)

echo Available Snapshots in sniper backup:
echo.
dir /B /AD "%BACKUP_DIR%" 2>nul
echo.

echo ===================================================================
set /p TARGET_VER="👉 Enter Version Number to restore (or press ENTER to cancel): "
if "%TARGET_VER%"=="" (
    echo [INFO] Restore cancelled.
    pause
    exit /b 0
)

if not exist "%BACKUP_DIR%\%TARGET_VER%" (
    echo.
    echo [ERROR] Backup version [%TARGET_VER%] was not found at:
    echo        %BACKUP_DIR%\%TARGET_VER%
    pause
    exit /b 1
)

echo.
if exist "%BACKUP_DIR%\%TARGET_VER%\RESTORE_THIS_BACKUP.bat" (
    call "%BACKUP_DIR%\%TARGET_VER%\RESTORE_THIS_BACKUP.bat"
) else (
    echo [1/1] Restoring Local PC Codebase from [%TARGET_VER%]...
    robocopy "%BACKUP_DIR%\%TARGET_VER%" "%ROOT%" /E /XD "node_modules" ".git" > nul
    echo       [OK] Sniper V2 codebase restored successfully!
    echo.
    echo ===================================================================
    echo   🎉 SUCCESS: VERSION [%TARGET_VER%] RESTORED TO SNIPER V2!
    echo ===================================================================
    pause
)
