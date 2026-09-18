; Installer Builder -- launcher (design.md 1.7).
;
; Copied into every app folder as launch.exe. Reads launch.txt beside it
; (format.md section 5), sets the environment and working folder, and starts
; the app. No window of its own. XP SP3 and later.
;
;   launch.exe                 start the app (console apps: cmd /k, so the
;                              window stays open)
;   launch.exe /out=<file>     tests: run via cmd /c, send stdout and stderr
;                              to <file>, wait, and exit with the app's code

Unicode true
ManifestSupportedOS all
RequestExecutionLevel user
SilentInstall silent
CRCCheck off
SetCompressor /SOLID lzma

!ifndef IB_VERSION
  !define IB_VERSION "0.1.0.0"
!endif

!addincludedir "include"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "ibutil.nsh"

Name "Installer Builder launcher"
OutFile "out\launcher.exe"
Icon "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"

VIProductVersion "${IB_VERSION}"
VIAddVersionKey ProductName "Installer Builder"
VIAddVersionKey CompanyName "Installer Builder"
VIAddVersionKey FileDescription "Installer Builder app launcher"
VIAddVersionKey FileVersion "${IB_VERSION}"
VIAddVersionKey ProductVersion "${IB_VERSION}"
VIAddVersionKey LegalCopyright "Installer Builder"

!insertmacro IB_UTIL ""

Var Cwd
Var Exec
Var Console
Var PathAdd
Var OutFile

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
  Call IbUtf8ToUtf16

  StrCpy $Cwd $EXEDIR
  StrCpy $Console 0
  StrCpy $PathAdd ""
  FileOpen $1 "$PLUGINSDIR\launch.u16" r
  !insertmacro IbRead "" $1
  StrCpy $T_rest $T_line
  Call IbSplitTab
  ${If} $T_field S!= "ib-launch"
    FileClose $1
    MessageBox MB_OK|MB_ICONSTOP "$EXEDIR\launch.txt isn't an ib-launch file."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${Do}
    !insertmacro IbRead "" $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "cwd"
      StrCpy $Cwd $F1
    ${ElseIf} $K S== "env"
      StrCpy $U_a $F1
      StrCpy $U_b $F2
      Call IbSetEnv
    ${ElseIf} $K S== "unset"
      StrCpy $U_a $F1
      Call IbUnsetEnv
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
  Call IbPrependPath

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
    Exec '$Exec'
  ${EndIf}
SectionEnd
