@echo off
setlocal
chcp 65001 >nul
title Typeless Toolkit - release
cd /d "%~dp0"

call build-tray.bat
if errorlevel 1 exit /b 1

set "RELEASE=..\release\TypelessToolkit-v1.4.0"
if not exist "%RELEASE%" mkdir "%RELEASE%"
if not exist "%RELEASE%\server" mkdir "%RELEASE%\server"
if not exist "%RELEASE%\server\lib" mkdir "%RELEASE%\server\lib"
if not exist "%RELEASE%\data" mkdir "%RELEASE%\data"

echo [release] Copying desktop application...
copy /Y TypelessToolkit.exe "%RELEASE%\TypelessToolkit.exe" >nul || exit /b 1
copy /Y Microsoft.Web.WebView2.Core.dll "%RELEASE%\Microsoft.Web.WebView2.Core.dll" >nul || exit /b 1
copy /Y Microsoft.Web.WebView2.WinForms.dll "%RELEASE%\Microsoft.Web.WebView2.WinForms.dll" >nul || exit /b 1
copy /Y WebView2Loader.dll "%RELEASE%\WebView2Loader.dll" >nul || exit /b 1
copy /Y ".build\webview2\1.0.4078.44\LICENSE.txt" "%RELEASE%\WEBVIEW2-LICENSE.txt" >nul || exit /b 1
copy /Y icon\tray-icon.ico "%RELEASE%\tray-icon.ico" >nul || exit /b 1
copy /Y icon\icon-rounded.png "%RELEASE%\icon.png" >nul || exit /b 1
copy /Y LICENSE "%RELEASE%\LICENSE" >nul || exit /b 1

echo [release] Copying local server...
copy /Y manager.js "%RELEASE%\server\manager.js" >nul || exit /b 1
copy /Y manager.html "%RELEASE%\server\manager.html" >nul || exit /b 1
copy /Y typeless-dict-sync.js "%RELEASE%\server\typeless-dict-sync.js" >nul || exit /b 1
copy /Y package.json "%RELEASE%\server\package.json" >nul || exit /b 1
copy /Y package-lock.json "%RELEASE%\server\package-lock.json" >nul || exit /b 1
copy /Y icon\icon-rounded.png "%RELEASE%\server\icon.png" >nul || exit /b 1
xcopy /E /I /Y lib "%RELEASE%\server\lib" >nul || exit /b 1
xcopy /E /I /Y node_modules "%RELEASE%\server\node_modules" >nul || exit /b 1

if not exist "%RELEASE%\data\config.json" copy /Y config.example.json "%RELEASE%\data\config.json" >nul
copy /Y accounts.example.json "%RELEASE%\data\accounts.example.json" >nul
if not exist "%RELEASE%\data\accounts.json" copy /Y accounts.example.json "%RELEASE%\data\accounts.json" >nul
if not exist "%RELEASE%\data\profiles" mkdir "%RELEASE%\data\profiles"

del /Q "%RELEASE%\TrayApp.exe" "%RELEASE%\TrayApp-wvbrowser.exe" "%RELEASE%\启动.bat" "%RELEASE%\启动-浏览器独立窗口.bat" "%RELEASE%\启动-内嵌窗口.bat" 2>nul
if exist "%RELEASE%\data\chrome-profile" rmdir /S /Q "%RELEASE%\data\chrome-profile"
if exist "%RELEASE%\data\webview2-profile" rmdir /S /Q "%RELEASE%\data\webview2-profile"

echo [release] Complete. Double-click TypelessToolkit.exe.
endlocal
