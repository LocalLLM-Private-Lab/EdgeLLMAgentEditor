@echo off
setlocal enabledelayedexpansion

rem One-time setup: registers terminal-host.exe as an Edge Native Messaging
rem host, so the extension can ask the browser to launch it (no other way
rem for an extension to start a local process exists). Run this once after
rem building; re-run only if you move/rebuild terminal-host.exe to a new
rem path. HKCU registration, no admin rights needed.

set "HOST_NAME=com.m365copilot.terminal_host_launcher"
set "EXT_ID=fehlbbjdbgjgjnbgjnhcehkdgnlagboo"
set "SCRIPT_DIR=%~dp0"

if exist "%SCRIPT_DIR%target\release\terminal-host.exe" (
    set "EXE_PATH=%SCRIPT_DIR%target\release\terminal-host.exe"
) else if exist "%SCRIPT_DIR%target\debug\terminal-host.exe" (
    set "EXE_PATH=%SCRIPT_DIR%target\debug\terminal-host.exe"
) else (
    echo [install-native-messaging-host] terminal-host.exe not found. Run "cargo build --release" first.
    exit /b 1
)

set "MANIFEST_PATH=%SCRIPT_DIR%native-messaging-host-manifest.json"

> "%MANIFEST_PATH%" (
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "Launches the terminal-host companion process for M365 Copilot Code Editor",
    echo   "path": "%EXE_PATH:\=\\%",
    echo   "type": "stdio",
    echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
    echo }
)

reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo [install-native-messaging-host] Registered %HOST_NAME%
echo   exe:      %EXE_PATH%
echo   manifest: %MANIFEST_PATH%
echo Done. Reload the extension (edge://extensions) and use the terminal
echo panel's launch button to start terminal-host from the browser.
