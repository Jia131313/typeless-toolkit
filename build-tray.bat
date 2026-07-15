@echo off
setlocal
chcp 65001 >nul
title Typeless Toolkit - build
cd /d "%~dp0"

set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
set "WV2_VERSION=1.0.4078.44"
set "WV2_DIR=.build\webview2\%WV2_VERSION%"
set "WV2_CORE=%WV2_DIR%\lib\net462\Microsoft.Web.WebView2.Core.dll"
set "WV2_WINFORMS=%WV2_DIR%\lib\net462\Microsoft.Web.WebView2.WinForms.dll"
set "WV2_LOADER=%WV2_DIR%\runtimes\win-x64\native\WebView2Loader.dll"
set "WINDOWS_OUT=.build\windows"

if not exist ".build" mkdir ".build"
if not exist "%WINDOWS_OUT%" mkdir "%WINDOWS_OUT%"

if not exist "%CSC%" (
  echo [ERROR] .NET Framework C# compiler not found.
  exit /b 1
)

echo [1/4] Generating application icons...
"%CSC%" /nologo /reference:System.Drawing.dll /platform:anycpu /out:.build\gen-icon.exe gen-icon.cs
if errorlevel 1 exit /b 1
.build\gen-icon.exe
if errorlevel 1 exit /b 1

if not exist "%WV2_CORE%" (
  echo [2/4] Downloading Microsoft WebView2 SDK %WV2_VERSION%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root='%WV2_DIR%'; $zip='.build\webview2.zip'; New-Item -ItemType Directory -Force -Path '.build' | Out-Null; Invoke-WebRequest -UseBasicParsing 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/%WV2_VERSION%/microsoft.web.webview2.%WV2_VERSION%.nupkg' -OutFile $zip; Expand-Archive -Force -LiteralPath $zip -DestinationPath $root; Remove-Item -LiteralPath $zip"
  if errorlevel 1 exit /b 1
)

echo [3/4] Compiling the single desktop application...
"%CSC%" /nologo /target:winexe /platform:x64 /win32icon:icon\tray-icon.ico /win32manifest:app.manifest /out:"%WINDOWS_OUT%\TypelessToolkit.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:"%WV2_CORE%" /reference:"%WV2_WINFORMS%" main.cs
if errorlevel 1 exit /b 1

copy /Y "%WV2_CORE%" "%WINDOWS_OUT%\Microsoft.Web.WebView2.Core.dll" >nul
copy /Y "%WV2_WINFORMS%" "%WINDOWS_OUT%\Microsoft.Web.WebView2.WinForms.dll" >nul
copy /Y "%WV2_LOADER%" "%WINDOWS_OUT%\WebView2Loader.dll" >nul

echo [4/4] Done: %WINDOWS_OUT%\TypelessToolkit.exe
endlocal
