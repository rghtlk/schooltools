@echo off
rem Start classbook on Windows: double-click this file.
rem It runs start.ps1 (which asks before installing anything) without changing
rem PowerShell's script policy, and keeps the window open if something fails.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
