@echo off
setlocal enabledelayedexpansion

rem One-time setup: registers lsp-host.exe as an Edge Native Messaging host,
rem so the extension can ask the browser to launch it (no other way for an
rem extension to start a local process exists). Run this once after
rem building; re-run only if you move/rebuild lsp-host.exe to a new path.
rem Normally this uses HKCU and does not need admin rights. If the Edge policy
rem NativeMessagingUserLevelHosts is set to 0, Edge only accepts a machine-
rem level HKLM registration, so this script relaunches itself with UAC
rem elevation before registering the host.

set "HOST_NAME=com.edgellmagenteditor.lsp_host"
set "EXT_ID=fehlbbjdbgjgjnbgjnhcehkdgnlagboo"
set "SCRIPT_DIR=%~dp0"
set "REG_ROOT=HKCU"

rem Check the documented policy name, plus the singular spelling used by
rem some existing enterprise setup scripts, in both registry views/hives.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$names=@('NativeMessagingUserLevelHosts','NativeMessagingUserLevelHost'); $hives=@([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryHive]::CurrentUser); $views=@([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32); foreach($hive in $hives){ foreach($view in $views){ $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view); $key=$base.OpenSubKey('SOFTWARE\Policies\Microsoft\Edge'); if($null -ne $key){ foreach($name in $names){ $value=$key.GetValue($name); if($null -ne $value -and [int]$value -eq 0){ exit 0 } } } } }; exit 1" >nul 2>&1
if not errorlevel 1 (
    set "REG_ROOT=HKLM"
    fltmc >nul 2>&1
    if errorlevel 1 (
        echo [install-native-messaging-host] Edge disables user-level Native Messaging.
        echo [install-native-messaging-host] Requesting administrator permission...
        powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
        exit /b !ERRORLEVEL!
    )
    echo [install-native-messaging-host] Detected NativeMessagingUserLevelHosts=0; using HKLM.
)

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

reg add "%REG_ROOT%\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
if errorlevel 1 (
    echo [install-native-messaging-host] Registry registration failed.
    exit /b 1
)

echo [install-native-messaging-host] Registered %HOST_NAME% in %REG_ROOT%
echo   exe:      %EXE_PATH%
echo   manifest: %MANIFEST_PATH%
echo Done. Reload the extension (edge://extensions) and open a .rs file to
echo have the editor launch lsp-host automatically.
