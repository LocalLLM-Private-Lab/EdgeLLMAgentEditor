@echo off
setlocal

cd /d "%~dp0extension"

if not exist node_modules (
    echo [build-extension] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [build-extension] npm install failed.
        exit /b 1
    )
)

echo [build-extension] Building extension...
call npm run build
if errorlevel 1 (
    echo [build-extension] Build failed.
    exit /b 1
)

echo [build-extension] Done. Load extension\dist as an unpacked extension in edge://extensions.
pause
