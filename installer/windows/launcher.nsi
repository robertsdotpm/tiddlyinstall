; TiddlyInstall -- launcher (design.md 1.7).
;
; Copied into every app folder as launch.exe. Reads launch.txt beside it
; (format.md section 5), sets the environment and working folder, and starts
; the app. No window of its own. XP SP3 and later.
;
;   launch.exe                 start the app (console apps: cmd /k, so the
;                              window stays open)
;   launch.exe /out=<file>     tests: run via cmd /c, send stdout and stderr
;                              to <file>, wait, and exit with the app's code
;
; Apps without a console (launch.txt `console 0`) are started directly, with
; no console window (CREATE_NO_WINDOW) and their stdout and stderr in
; <app>\data\launch.log (%TEMP%\ti-launch-<appid>.log where that can't be
; written, as in all-user installs). If the app exits with a non-zero code
; within ${GUI_WAIT_MS} ms, a message box shows the end of that log and where
; it is; a normal exit, or an app still running then, shows nothing. The
; launcher's own exit code is then the app's (0 if it is still running).

Unicode true
ManifestSupportedOS all
RequestExecutionLevel user
SilentInstall silent
CRCCheck off
SetCompressor /SOLID lzma

!ifndef TI_VERSION
  !define TI_VERSION "0.1.0.0"
!endif

!addincludedir "include"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "tiutil.nsh"

!define GUI_WAIT_MS 10000

Name "TiddlyInstall launcher"
OutFile "out\launcher.exe"
Icon "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"

VIProductVersion "${TI_VERSION}"
VIAddVersionKey ProductName "TiddlyInstall"
VIAddVersionKey CompanyName "TiddlyInstall"
VIAddVersionKey FileDescription "TiddlyInstall app launcher"
VIAddVersionKey FileVersion "${TI_VERSION}"
VIAddVersionKey ProductVersion "${TI_VERSION}"
VIAddVersionKey LegalCopyright "TiddlyInstall"

!insertmacro TI_UTIL ""

Var Cwd
Var Exec
Var Console
Var PathAdd
Var OutFile
Var LogPath
Var AppLabel

Section
  InitPluginsDir
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/out=" $OutFile
  ${If} ${Errors}
    StrCpy $OutFile ""
  ${EndIf}

  ${IfNot} ${FileExists} "$EXEDIR\launch.txt"
    MessageBox MB_OK|MB_ICONSTOP "$EXEDIR\launch.txt is missing. Reinstall the app."
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $U_a "$EXEDIR\launch.txt"
  StrCpy $U_b "$PLUGINSDIR\launch.u16"
  Call TiUtf8ToUtf16

  StrCpy $Cwd $EXEDIR
  StrCpy $Console 0
  StrCpy $PathAdd ""
  FileOpen $1 "$PLUGINSDIR\launch.u16" r
  !insertmacro TiRead "" $1
  StrCpy $T_rest $T_line
  Call TiSplitTab
  ${If} $T_field S!= "ti-launch"
    FileClose $1
    MessageBox MB_OK|MB_ICONSTOP "$EXEDIR\launch.txt isn't a ti-launch file."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${Do}
    !insertmacro TiRead "" $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "cwd"
      StrCpy $Cwd $F1
    ${ElseIf} $K S== "env"
      StrCpy $U_a $F1
      StrCpy $U_b $F2
      Call TiSetEnv
    ${ElseIf} $K S== "unset"
      StrCpy $U_a $F1
      Call TiUnsetEnv
    ${ElseIf} $K S== "path"
      ${If} $PathAdd == ""
        StrCpy $PathAdd $F1
      ${Else}
        StrCpy $PathAdd "$PathAdd;$F1"
      ${EndIf}
    ${ElseIf} $K S== "console"
      StrCpy $Console $F1
    ${ElseIf} $K S== "exec"
      StrCpy $Exec $F1
    ${EndIf}
  ${Loop}
  FileClose $1
  StrCpy $U_a $PathAdd
  Call TiPrependPath

  ${If} $Exec == ""
    MessageBox MB_OK|MB_ICONSTOP "$EXEDIR\launch.txt has no exec line."
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetOutPath "$Cwd"           ; the working folder of what we start

  ${If} $OutFile != ""
    ExecWait '"$SYSDIR\cmd.exe" /s /c "$Exec >"$OutFile" 2>&1"' $0
    SetErrorLevel $0
  ${ElseIf} $Console == "1"
    Exec '"$SYSDIR\cmd.exe" /s /k "$Exec"'
  ${Else}
    Call StartGui
  ${EndIf}
SectionEnd

; Open $LogPath for writing, inheritable. $U_out = the handle, or -1.
Function OpenLog
  Push $0
  System::Call '*(i 12, p 0, i 1) p .r0'   ; SECURITY_ATTRIBUTES, bInheritHandle
  ; GENERIC_WRITE, share read/write/delete, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL
  Push $1
  StrCpy $1 $LogPath
  System::Call 'kernel32::CreateFileW(w r1, i 0x40000000, i 7, p r0, i 2, i 0x80, p 0) p .s'
  Exch
  Pop $1
  Pop $U_out
  System::Free $0
  Pop $0
FunctionEnd

; The app's display name, from manifest.txt beside us, into $AppLabel.
Function ReadAppName
  Push $1
  StrCpy $AppLabel "The app"
  StrCpy $U_a "$EXEDIR\manifest.txt"
  StrCpy $U_b "$PLUGINSDIR\manifest.u16"
  Call TiUtf8ToUtf16
  ${If} ${Errors}
    Pop $1
    Return
  ${EndIf}
  FileOpen $1 "$PLUGINSDIR\manifest.u16" r
  ${Do}
    !insertmacro TiRead "" $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "name"
    ${AndIf} $F1 != ""
      StrCpy $AppLabel $F1
      ${Break}
    ${EndIf}
  ${Loop}
  FileClose $1
  Pop $1
FunctionEnd

; A stop-sign message box $U_a, captioned with the app's name ($AppLabel).
Function ShowError
  Push $0
  Push $1
  StrCpy $0 $U_a
  StrCpy $1 $AppLabel
  System::Call 'user32::MessageBoxW(p 0, w r0, w r1, i 0x10010) i'   ; MB_ICONSTOP|MB_SETFOREGROUND
  Pop $1
  Pop $0
FunctionEnd

; The last lines of $LogPath (at most about 600 bytes) into $U_out.
Function LogTail
  Push $0
  Push $1
  Push $2
  StrCpy $U_out ""
  ClearErrors
  FileOpen $0 "$LogPath" r
  ${If} ${Errors}
    Goto lt_end
  ${EndIf}
  FileSeek $0 0 END $1
  ${If} $1 > 600
    FileSeek $0 -600 END
    FileRead $0 $2            ; drop the partial first line
  ${Else}
    FileSeek $0 0 SET
  ${EndIf}
  ${Do}
    ClearErrors
    FileRead $0 $2
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ${TiTrimNL} $2
    ${If} $2 != ""
      StrCpy $U_out "$U_out$2$\r$\n"
    ${EndIf}
  ${Loop}
  FileClose $0
  lt_end:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; An app without a console (design.md 1.7): no console window, output to a
; log, and a message box if it fails at once.
Function StartGui
  CreateDirectory "$EXEDIR\data"
  StrCpy $LogPath "$EXEDIR\data\launch.log"
  Call OpenLog
  ${If} $U_out = -1
    ${GetFileName} $EXEDIR $0
    StrCpy $LogPath "$TEMP\ti-launch-$0.log"
    Call OpenLog
  ${EndIf}
  StrCpy $1 $U_out                  ; the log (-1: none; the app gets no stdout/stderr)
  ${If} $1 = -1
    StrCpy $1 0
    StrCpy $LogPath ""
  ${EndIf}
  ; STARTUPINFOW: cb, reserved, desktop, title, x, y, xsize, ysize, xcount,
  ; ycount, fill, flags (STARTF_USESTDHANDLES), show, reserved2 (2), stdin,
  ; stdout, stderr
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0x100, &i2 0, &i2 0, p 0, p 0, p r1, p r1) p .r2'
  System::Call '*(p 0, p 0, i 0, i 0) p .r3'   ; PROCESS_INFORMATION
  ; bInheritHandles, CREATE_NO_WINDOW (a console program gets no window)
  ; The command line and folder go in through registers: quotes inside them
  ; would end a quoted System::Call argument.
  StrCpy $8 $Exec
  StrCpy $9 $Cwd
  System::Call 'kernel32::CreateProcessW(p 0, w r8, p 0, p 0, i 1, i 0x08000000, p 0, w r9, p r2, p r3) i .r0 ?e'
  Pop $5                            ; GetLastError
  ${If} $1 <> 0
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
  System::Free $2
  ${If} $0 = 0
    System::Free $3
    Call ReadAppName
    StrCpy $U_a "$AppLabel couldn't be started (Windows error $5).$\r$\n$\r$\n$Exec"
    Call ShowError
    SetErrorLevel 2
    Return
  ${EndIf}
  System::Call '*$3(p .r4, p .r6)'
  System::Free $3
  System::Call 'kernel32::CloseHandle(p r6)'
  System::Call 'kernel32::WaitForSingleObject(p r4, i ${GUI_WAIT_MS}) i .r0'
  StrCpy $7 0
  ${If} $0 = 0                      ; it has exited
    System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r7)'
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r4)'
  SetErrorLevel $7
  ${If} $7 = 0
    Return
  ${EndIf}
  Call ReadAppName
  ${If} $LogPath == ""
    StrCpy $U_a "$AppLabel stopped with an error (exit code $7)."
    Call ShowError
    Return
  ${EndIf}
  Call LogTail
  ${If} $U_out == ""
    StrCpy $U_a "$AppLabel stopped with an error (exit code $7) and wrote nothing.$\r$\n$\r$\nIts output would be in:$\r$\n$LogPath"
    Call ShowError
  ${Else}
    StrCpy $U_a "$AppLabel stopped with an error (exit code $7):$\r$\n$\r$\n$U_out$\r$\nThe full output is in:$\r$\n$LogPath"
    Call ShowError
  ${EndIf}
FunctionEnd
