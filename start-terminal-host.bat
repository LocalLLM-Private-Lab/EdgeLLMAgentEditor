@echo off
setlocal

rem Dev convenience only: builds+runs from source, so its cwd (and thus
rem new terminals' cwd) is this repo's terminal-host folder, not whatever
rem project you actually want to edit. For real use, run the built
rem terminal-host.exe from inside the project folder instead — see
rem README.md.
cd /d "%~dp0terminal-host"

echo [start-terminal-host] Starting terminal-host (Ctrl+C to stop)...
echo [start-terminal-host] NOTE: terminals will open in %cd%, not your project folder.
echo [start-terminal-host] For real use, run terminal-host.exe from inside your project instead.
cargo run
