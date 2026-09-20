@echo off
rem Safari 5.1.7 check (tests/browsers/safari5.mjs), run in the SSH session:
rem %1 the page (file URL), %2 seconds to let it run, %3 the beacon log.
rem ticollect.exe logs the beacons the page copy sends (127.0.0.1:38517).
cd /d C:\tibrowsers\safari-5.1.7
set SAF=%ProgramFiles%\Safari\Safari.exe
if exist "%ProgramFiles(x86)%\Safari\Safari.exe" set "SAF=%ProgramFiles(x86)%\Safari\Safari.exe"
if exist %3 del /q %3
start "" /b ticollect.exe 38517 %3 5
start "" "%SAF%" %1
ping -n %2 127.0.0.1 >nul
echo @SAFARI
tasklist /fi "imagename eq Safari.exe" | find /i "Safari.exe"
taskkill /f /im Safari.exe >nul 2>&1
taskkill /f /im ticollect.exe >nul 2>&1
echo @BEACONS
if exist %3 type %3
