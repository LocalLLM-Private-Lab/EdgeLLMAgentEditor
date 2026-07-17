@echo off
setlocal enabledelayedexpansion

rem One-time setup: registers lsp-host.exe as an Edge Native Messaging host,
rem so the extension can ask the browser to launch it (no other way for an
rem extension to start a local process exists). Run this once after
rem building; re-run only if you move/rebuild lsp-host.exe to a new path.
rem HKCU registration, no admin rights needed. Mirrors
rem terminal-host/install-native-messaging-host.bat.

set "HOST_NAME=com.edgellmagenteditor.lsp_host"
set "EXT_ID=fehlbbjdbgjgjnbgjnhcehkdgnlagboo"
set "SCRIPT_DIR=%~dp0"

if exist "%SCRIPT_DIR%target\release\lsp-host.exe" (
    set "EXE_PATH=%SCRIPT_DIR%target\release\lsp-host.exe"
) else if exist "%SCRIPT_DIR%target\debug\lsp-host.exe" (
    set "EXE_PATH=%SCRIPT_DIR%target\debug\lsp-host.exe"
) else (
    echo [install-native-messaging-host] lsp-host.exe not found. Run "cargo build --release" first.
    exit /b 1
)

set "MANIFEST_PATH=%SCRIPT_DIR%native-messaging-host-manifest.json"

> "%MANIFEST_PATH%" (
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "Launches the lsp-host companion process for EdgeLLMAgentEditor",
    echo   "path": "%EXE_PATH:\=\\%",
    echo   "type": "stdio",
    echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
    echo }
)

reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo [install-native-messaging-host] Registered %HOST_NAME%
echo   exe:      %EXE_PATH%
echo   manifest: %MANIFEST_PATH%
echo Done. Reload the extension (edge://extensions) and open a .rs file to
echo have the editor launch lsp-host automatically.
