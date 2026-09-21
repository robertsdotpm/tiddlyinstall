@echo off
rem Samples a browser's processes on Windows without PowerShell (XP, Vista).
rem
rem   sample-wmic.cmd chrome.exe C:\tipackmem\s.txt
rem
rem One line per process per sample: <local time> <WorkingSetSize>
rem <PageFileUsage> <VirtualSize>, all in bytes except PageFileUsage (KB on
rem some builds -- the reader normalises). wmic is the only thing on XP that
rem reports virtual size, which is the number that matters on a 32-bit
rem browser: it runs out of address space long before the machine runs out
rem of RAM.
setlocal
set NAME=%~1
set OUT=%~2
if "%NAME%"=="" set NAME=chrome.exe
if "%OUT%"=="" set OUT=s.txt
break > "%OUT%"
:loop
echo @T %date% %time%>> "%OUT%"
wmic process where "name='%NAME%'" get WorkingSetSize,PageFileUsage,VirtualSize /format:csv 2>nul >> "%OUT%"
ping -n 2 127.0.0.1 >nul
goto loop
