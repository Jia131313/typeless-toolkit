@echo off
setlocal
chcp 65001 >nul
title Typeless Toolkit - public release
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-public-release.ps1"
exit /b %errorlevel%
