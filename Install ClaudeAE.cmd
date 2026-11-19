@echo off
rem ClaudeAE installer: double-click to install the After Effects panel,
rem connect the Claude desktop app + Claude Code, and install the skill.
rem See INSTALL.txt for details.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -All
echo.
pause
