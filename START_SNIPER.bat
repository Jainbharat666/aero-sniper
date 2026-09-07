@echo off
title ⚡ NFT SNIPER V2 - ULTRA SPEED SNIPER
cd /d "%~dp0"
cls
echo ======================================================================
echo   ⚡ NFT SNIPER V2 — ULTRA LOW-LATENCY 6-KEY LASER SNIPER ⚡
echo ======================================================================
echo.
echo  [1] Starting Sniper Engine with 6 OpenSea API Keys...
echo  [2] Starting AeroMint Multi-RPC Mempool Blast Engine...
echo  [3] Pre-Warming Web Sockets and Ports...
echo.

:: Automatically open default browser after 1 second
start http://localhost:3000

:: Run Node Server
node server.js

pause
