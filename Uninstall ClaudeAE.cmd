@echo off
rem Removes the ClaudeAE After Effects panel, the Claude desktop / Claude Code
rem connections and the claude-motion skill. Your After Effects projects are not touched.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Uninstall
echo.
pause
