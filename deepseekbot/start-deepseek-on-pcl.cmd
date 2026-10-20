@echo off
cd /d "%~dp0"
wscript.exe //B //Nologo "%~dp0scripts\start-bridge.vbs" --fresh
