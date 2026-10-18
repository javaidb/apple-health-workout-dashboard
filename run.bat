@echo off
rem Thin wrapper - all launch logic lives in launch.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
