@echo off
cd /d "%~dp0"
if not exist "node_modules\mineflayer" (
    echo Dependencies are missing. Run npm install in this directory.
    pause
    exit /b 1
)
wscript.exe //B //Nologo "%~dp0scripts\start-bridge.vbs"
