@echo off
rem Put a test VM back as it was: removes only what the test matrix creates.
rem Build servers left by `dotnet build` hold files open, so stop them first.
for %%p in (dotnet.exe VBCSCompiler.exe MSBuild.exe launch.exe) do taskkill /F /IM %%p >nul 2>&1
for /f "delims=" %%p in ('tasklist /fo csv /nh 2^>nul ^| find /i "install_"') do echo still running: %%p
ping -n 3 127.0.0.1 >nul
if exist "C:\ti" rd /s /q "C:\ti"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ti" rd /s /q "%LOCALAPPDATA%\ti"
for /d %%d in ("%APPDATA%\Microsoft\Windows\Start Menu\Programs\Hello *") do rd /s /q "%%d"
for /d %%d in ("%USERPROFILE%\Start Menu\Programs\Hello *") do rd /s /q "%%d"
for /f "delims=" %%k in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" 2^>nul ^| find /i "\ti-"') do reg delete "%%k" /f >nul 2>&1
for /d %%d in ("%TEMP%\~nsu*.tmp" "%TEMP%\ns*.tmp") do rd /s /q "%%d" 2>nul
if exist "C:\titest" rd /s /q "C:\titest"
if exist "%USERPROFILE%\titest" rd /s /q "%USERPROFILE%\titest"
echo @check
if exist "C:\ti" echo left: C:\ti
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ti" echo left: %LOCALAPPDATA%\ti
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" 2>nul | find /i "\ti-"
echo clean-done
