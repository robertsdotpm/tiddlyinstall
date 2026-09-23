; tiutil.nsh -- helpers shared by base.nsi (installer and uninstaller) and
; launcher.nsi. Unicode NSIS 3, XP SP3 and later.
;
; NSIS has no arrays and a 1024-character string limit, so:
; - UTF-8 text files are converted to UTF-16LE once (TiUtf8ToUtf16) and then
;   read line by line with FileReadUTF16LE;
; - UTF-8 output is written with WideCharToMultiByte + WriteFile (TiAppendUtf8);
; - functions take their inputs in the global $U_* / $T_* variables below and
;   preserve $0-$9 and $R0-$R9.
;
; Functions are instantiated per prefix: !insertmacro TI_UTIL "" and
; !insertmacro TI_UTIL "un." (NSIS requires un. functions in the uninstaller).

!ifndef TIUTIL_NSH
!define TIUTIL_NSH

; Not every script uses every helper.
!pragma warning disable 6010
!pragma warning disable 6001

!include "LogicLib.nsh"

Var U_a      ; input 1
Var U_b      ; input 2
Var U_c      ; input 3
Var U_out    ; output
Var T_line   ; line being parsed
Var T_rest   ; SplitTab: remaining text
Var T_field  ; SplitTab: field taken
Var T_more   ; SplitTab: 1 if a tab followed the field
Var K        ; ParseLine: key
Var F1
Var F2
Var F3
Var F4
Var F5
Var F6

!define B32ALPHA "abcdefghijklmnopqrstuvwxyz234567"

; Every printable ASCII character, for the `ascii` prerequisite check
; (a path with anything else in it): NSIS cannot turn a character into
; a number, so "is this ASCII" is asked as "is it one of these 95".
; $$ is a literal $ and $\" a literal quote.
!define ASCII_PRINTABLE " !$\"#$$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
!define ASCII_PRINTABLE_LEN 95

; Strip a trailing \n and \r from a variable.
!macro TiTrimNL VAR
  Push $R9
  StrCpy $R9 ${VAR} 1 -1
  StrCmp $R9 "$\n" 0 +2
    StrCpy ${VAR} ${VAR} -1
  StrCpy $R9 ${VAR} 1 -1
  StrCmp $R9 "$\r" 0 +2
    StrCpy ${VAR} ${VAR} -1
  Pop $R9
!macroend
!define TiTrimNL "!insertmacro TiTrimNL"

; Read the next non-blank, non-comment line of HANDLE into $T_line.
!macro TiRead PFX HANDLE
  StrCpy $U_a ${HANDLE}
  Call ${PFX}TiReadLine
!macroend
!define TiRead '!insertmacro TiRead ""'
!define un.TiRead '!insertmacro TiRead "un."'

!macro TI_UTIL P

; UTF-8 file $U_a -> UTF-16LE file (with BOM) $U_b. Error flag on failure.
Function ${P}TiUtf8ToUtf16
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ClearErrors
  FileOpen $0 "$U_a" r
  ${If} ${Errors}
    Goto tiu_end
  ${EndIf}
  FileSeek $0 0 END $1
  FileSeek $0 0 SET
  FileOpen $2 "$U_b" w
  ${If} ${Errors}
    FileClose $0
    Goto tiu_end
  ${EndIf}
  FileWriteWord $2 0xFEFF
  ${If} $1 > 0
    IntOp $3 $1 + 4
    System::Alloc $3
    Pop $3
    System::Call 'kernel32::ReadFile(p r0, p r3, i r1, *i .r4, p 0) i .r5'
    ; skip a UTF-8 BOM if one slipped in
    StrCpy $6 0
    System::Call '*$3(&i1 .r5)'
    IntOp $5 $5 & 0xFF
    ${If} $5 = 0xEF
    ${AndIf} $4 >= 3
      StrCpy $6 3
    ${EndIf}
    IntOp $5 $3 + $6
    IntOp $4 $4 - $6
    System::Call 'kernel32::MultiByteToWideChar(i 65001, i 0, p r5, i r4, p 0, i 0) i .r1'
    ${If} $1 > 0
      IntOp $6 $1 * 2
      IntOp $6 $6 + 4
      System::Alloc $6
      Pop $6
      System::Call 'kernel32::MultiByteToWideChar(i 65001, i 0, p r5, i r4, p r6, i r1) i .r1'
      IntOp $1 $1 * 2
      System::Call 'kernel32::WriteFile(p r2, p r6, i r1, *i .r4, p 0) i .r5'
      System::Free $6
    ${EndIf}
    System::Free $3
  ${EndIf}
  FileClose $2
  FileClose $0
  ClearErrors
  tiu_end:
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Append text $U_b (include your own newline) to file $U_a as UTF-8.
Function ${P}TiAppendUtf8
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ClearErrors
  FileOpen $0 "$U_a" a
  ${IfNot} ${Errors}
    FileSeek $0 0 END
    StrCpy $4 $U_b
    System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r4, i -1, p 0, i 0, p 0, p 0) i .r1'
    ${If} $1 > 1
      System::Alloc $1
      Pop $2
      System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r4, i -1, p r2, i r1, p 0, p 0) i .r1'
      IntOp $1 $1 - 1
      System::Call 'kernel32::WriteFile(p r0, p r2, i r1, *i .r3, p 0)'
      System::Free $2
    ${EndIf}
    FileClose $0
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The app that owns folder $U_a: the `appid` line of its .ti-owner file
; (format.md section 5) -> $U_out, or "" if there is none. Uses $PLUGINSDIR.
; Keeps the caller's parsed line ($K, $F1-$F6, $T_*).
Function ${P}TiOwnerOf
  Push $0
  Push $1
  Push $K
  Push $F1
  Push $F2
  Push $F3
  Push $F4
  Push $F5
  Push $F6
  Push $T_line
  Push $T_rest
  Push $T_field
  Push $T_more
  StrCpy $1 ""
  ${If} ${FileExists} "$U_a\.ti-owner"
    StrCpy $U_a "$U_a\.ti-owner"
    StrCpy $U_b "$PLUGINSDIR\owner.u16"
    Call ${P}TiUtf8ToUtf16
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\owner.u16" r
    ${IfNot} ${Errors}
      ${Do}
        StrCpy $U_a $0
        Call ${P}TiReadLine
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        Call ${P}TiParseLine
        ${If} $K S== "appid"
          StrCpy $1 $F1
          ${Break}
        ${EndIf}
      ${Loop}
      FileClose $0
    ${EndIf}
  ${EndIf}
  StrCpy $U_out $1
  Pop $T_more
  Pop $T_field
  Pop $T_rest
  Pop $T_line
  Pop $F6
  Pop $F5
  Pop $F4
  Pop $F3
  Pop $F2
  Pop $F1
  Pop $K
  Pop $1
  Pop $0
FunctionEnd

; Take the text up to the first tab of $T_rest into $T_field; $T_rest keeps
; what follows the tab. $T_more = 1 if there was a tab.
Function ${P}TiSplitTab
  Push $0
  Push $1
  Push $2
  StrLen $1 $T_rest
  StrCpy $0 0
  StrCpy $T_more 0
  ${Do}
    ${If} $0 >= $1
      StrCpy $T_field $T_rest
      StrCpy $T_rest ""
      ${Break}
    ${EndIf}
    StrCpy $2 $T_rest 1 $0
    ${If} $2 == "$\t"
      StrCpy $T_field $T_rest $0
      IntOp $0 $0 + 1
      StrCpy $T_rest $T_rest "" $0
      StrCpy $T_more 1
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Split $T_line into $K and $F1..$F6 (missing fields are empty).
Function ${P}TiParseLine
  StrCpy $T_rest $T_line
  Call ${P}TiSplitTab
  StrCpy $K $T_field
  Call ${P}TiSplitTab
  StrCpy $F1 $T_field
  Call ${P}TiSplitTab
  StrCpy $F2 $T_field
  Call ${P}TiSplitTab
  StrCpy $F3 $T_field
  Call ${P}TiSplitTab
  StrCpy $F4 $T_field
  Call ${P}TiSplitTab
  StrCpy $F5 $T_field
  Call ${P}TiSplitTab
  StrCpy $F6 $T_field
FunctionEnd

; Read one line from handle $U_a into $T_line (trimmed). Error flag at EOF.
; Blank lines and # comments are skipped.
Function ${P}TiReadLine
  ${Do}
    ClearErrors
    FileReadUTF16LE $U_a $T_line
    ${If} ${Errors}
      SetErrors                  ; IfErrors cleared it; callers test it again
      Return
    ${EndIf}
    ; A line longer than NSIS_MAX_STRLEN (1024) comes back with no
    ; newline on the end: FileRead stopped at the buffer, not at the
    ; line. What follows is the rest of that line and is not a line of
    ; its own, so it must not be parsed as one. `rtroots` is 1564
    ; characters, and its tail was read as a plan key -- the review
    ; screen told the reader this installer could not describe what it
    ; does, and printed 500 bytes of base64 as the name of the thing it
    ; could not describe (Windows 10, 2026-09-23).
    ;
    ; The remainder is swallowed here, so one physical line always
    ; yields exactly one logical line. What is returned is that line cut
    ; short, which is all an NSIS string can hold; anything that needs a
    ; long value whole reads the file itself, as tisig::rtverify does.
    Push $0
    StrCpy $0 $T_line 1 -1
    ${If} $0 != "$\n"
      ${Do}
        ClearErrors
        FileReadUTF16LE $U_a $0
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        StrCpy $0 $0 1 -1
        ${If} $0 == "$\n"
          ${Break}
        ${EndIf}
      ${Loop}
      ClearErrors
    ${EndIf}
    Pop $0
    ${TiTrimNL} $T_line
    ${If} $T_line == ""
      ${Continue}
    ${EndIf}
    StrCpy $T_field $T_line 1
    ${If} $T_field == "#"
      ${Continue}
    ${EndIf}
    ${Break}
  ${Loop}
  ClearErrors
FunctionEnd

; Hex digest $U_a -> first $U_b characters of its base32 (RFC 4648,
; lowercase, no padding) encoding, in $U_out. 5 hex digits = 4 base32 chars.
Function ${P}TiHexToB32
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out ""
  StrCpy $0 0
  ${Do}
    StrLen $1 $U_out
    ${If} $1 >= $U_b
      ${Break}
    ${EndIf}
    StrCpy $1 $U_a 5 $0
    StrLen $2 $1
    ${If} $2 < 5
      StrCpy $1 "$1000000" 5
    ${EndIf}
    IntOp $1 0x$1 + 0
    IntOp $2 $1 >> 15
    IntOp $2 $2 & 31
    StrCpy $3 "${B32ALPHA}" 1 $2
    StrCpy $U_out "$U_out$3"
    IntOp $2 $1 >> 10
    IntOp $2 $2 & 31
    StrCpy $3 "${B32ALPHA}" 1 $2
    StrCpy $U_out "$U_out$3"
    IntOp $2 $1 >> 5
    IntOp $2 $2 & 31
    StrCpy $3 "${B32ALPHA}" 1 $2
    StrCpy $U_out "$U_out$3"
    IntOp $2 $1 & 31
    StrCpy $3 "${B32ALPHA}" 1 $2
    StrCpy $U_out "$U_out$3"
    IntOp $0 $0 + 5
  ${Loop}
  StrCpy $U_out $U_out $U_b
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if $U_a is exactly $U_b characters of [a-z2-7] (case-sensitive).
Function ${P}TiIsB32
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out 0
  StrLen $0 $U_a
  ${If} $0 = $U_b
    StrCpy $U_out 1
    StrCpy $0 0
    ${Do}
      ${If} $0 >= $U_b
        ${Break}
      ${EndIf}
      StrCpy $1 $U_a 1 $0
      StrCpy $3 0
      ${Do}
        ${If} $3 >= 32
          StrCpy $U_out 0
          ${Break}
        ${EndIf}
        StrCpy $2 "${B32ALPHA}" 1 $3
        ${If} $1 S== $2
          ${Break}
        ${EndIf}
        IntOp $3 $3 + 1
      ${Loop}
      ${If} $U_out = 0
        ${Break}
      ${EndIf}
      IntOp $0 $0 + 1
    ${Loop}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if $U_a contains $U_b (case-insensitive).
Function ${P}TiContains
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out 0
  StrLen $0 $U_a
  StrLen $1 $U_b
  StrCpy $2 0
  ${Do}
    IntOp $3 $2 + $1
    ${If} $3 > $0
      ${Break}
    ${EndIf}
    StrCpy $3 $U_a $1 $2
    ${If} $3 == $U_b
      StrCpy $U_out 1
      ${Break}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if $U_a starts with $U_b (case-insensitive, as Windows paths are).
Function ${P}TiStartsWith
  Push $0
  StrLen $0 $U_b
  StrCpy $0 $U_a $0
  StrCpy $U_out 0
  ${If} $0 == $U_b
    StrCpy $U_out 1
  ${EndIf}
  Pop $0
FunctionEnd

; Environment of this process (inherited by what it starts).
; $U_a name, $U_b value.
Function ${P}TiSetEnv
  Push $0
  Push $1
  StrCpy $0 $U_a
  StrCpy $1 $U_b
  System::Call 'kernel32::SetEnvironmentVariableW(w r0, w r1) i'
  Pop $1
  Pop $0
FunctionEnd
Function ${P}TiUnsetEnv
  Push $0
  StrCpy $0 $U_a
  System::Call 'kernel32::SetEnvironmentVariableW(w r0, p 0) i'
  Pop $0
FunctionEnd
; Prepend $U_a (one or more ;-separated folders) to PATH. Works on PATHs
; longer than the NSIS string limit by doing it in a System buffer.
Function ${P}TiPrependPath
  Push $0
  Push $1
  Push $2
  ${If} $U_a != ""
    System::Alloc 131072
    Pop $0
    StrCpy $2 "$U_a;"
    System::Call 'kernel32::lstrcpyW(p r0, w r2)'
    StrLen $1 "$U_a;"
    IntOp $1 $1 * 2
    IntOp $1 $0 + $1
    System::Call 'kernel32::GetEnvironmentVariableW(w "PATH", p r1, i 32000) i .r2'
    System::Call 'kernel32::SetEnvironmentVariableW(w "PATH", p r0) i'
    System::Free $0
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if this process runs with administrator rights.
Function ${P}TiIsAdmin
  Push $0
  UserInfo::GetAccountType
  Pop $0
  StrCpy $U_out 0
  ${If} $0 == "Admin"
    StrCpy $U_out 1
  ${EndIf}
  Pop $0
FunctionEnd

; Run $EXEPATH again, elevated (verb runas), with parameters $U_a; wait
; for it and return its exit code in $U_out, or "error" if it didn't start.
Function ${P}TiRunElevated
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $3 $EXEPATH
  StrCpy $4 $U_a
  StrCpy $5 $EXEDIR
  ; SHELLEXECUTEINFOW, 60 bytes on x86. fMask = SEE_MASK_NOCLOSEPROCESS (0x40)
  System::Call '*(i 60, i 0x40, p $HWNDPARENT, w "runas", w r3, w r4, w r5, i 1, p 0, p 0, p 0, p 0, i 0, p 0, p 0) p .r0'
  System::Call 'shell32::ShellExecuteExW(p r0) i .r1'
  StrCpy $U_out "error"
  ${If} $1 <> 0
    System::Call '*$0(i, i, p, p, p, p, p, i, p, p, p, p, i, p, p .r2)'
    ${If} $2 <> 0
      System::Call 'kernel32::WaitForSingleObject(p r2, i -1) i'
      System::Call 'kernel32::GetExitCodeProcess(p r2, *i .r1) i'
      System::Call 'kernel32::CloseHandle(p r2) i'
      StrCpy $U_out $1
    ${Else}
      StrCpy $U_out 0
    ${EndIf}
  ${EndIf}
  System::Free $0
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macroend

!endif
