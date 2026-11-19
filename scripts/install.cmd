@echo off
rem Double-click to install ClaudeAE (add -All to also connect Claude Desktop, Claude Code and the skill)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
