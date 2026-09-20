; TiddlyInstall -- Windows base installer.
;
; One generic engine for every app and runtime: it finds a record and a plan
; (docs/format.md), picks the plan's first [target] matching this machine,
; downloads and checks each file, runs the recipe steps, installs the
; project, and writes the launcher, shortcuts, manifest and uninstaller.
; There is no per-runtime code here; everything comes from the plan.
;
; Unicode NSIS 3.09. Runs on Windows XP SP3 to 11 / Server 2022.
; Build with build.sh (it compiles launcher.nsi first).

Unicode true
ManifestSupportedOS all
ManifestDPIAware true
RequestExecutionLevel user
CRCCheck off              ; the browser editor may change resources (icon)
SetCompressor /SOLID lzma
XPStyle on

!ifndef IB_BACKEND
  !define IB_BACKEND "http://10.0.1.76:8080"
!endif
!ifndef IB_VERSION
  !define IB_VERSION "0.1.0.0"
!endif
!ifndef IB_OUTFILE
  !define IB_OUTFILE "out\base.exe"
!endif
; The plan signing key (docs/format.md "Plan signature"), base64 of the raw 32-byte
; Ed25519 public key, and its short id. build.sh reads them from a file.
!ifndef IB_PLAN_PUBKEY
  !error "IB_PLAN_PUBKEY is not defined: build with build.sh"
!endif
!ifndef IB_PLAN_KEYID
  !define IB_PLAN_KEYID "?"
!endif
; When this base was built (build.sh passes both): RFC 3339 for messages,
; and whole days since 1970 for arithmetic (seconds would overflow NSIS's
; 32-bit integers in 2038). The real time is certainly not earlier than
; this, which is the only floor a machine with a wrong clock gives us
; (design.md 7.1, "Clocks").
!ifndef IB_BUILD_TIME
  !define IB_BUILD_TIME "1970-01-01T00:00:00Z"
!endif
!ifndef IB_BUILD_DAYS
  !define IB_BUILD_DAYS 0
!endif

!addplugindir /x86-unicode "plugins\x86-unicode"
!addincludedir "include"

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "ibutil.nsh"

Name "TiddlyInstall"
Caption "TiddlyInstall: $AppName"
UninstallCaption "TiddlyInstall: uninstall $AppName"
OutFile "${IB_OUTFILE}"
BrandingText "TiddlyInstall ${IB_VERSION}"
ShowInstDetails show
ShowUninstDetails show
InstallDir "$TEMP"        ; replaced once the plan is read

VIProductVersion "${IB_VERSION}"
VIAddVersionKey ProductName "TiddlyInstall"
VIAddVersionKey CompanyName "TiddlyInstall"
VIAddVersionKey FileDescription "TiddlyInstall base installer"
VIAddVersionKey FileVersion "${IB_VERSION}"
VIAddVersionKey ProductVersion "${IB_VERSION}"
VIAddVersionKey LegalCopyright "TiddlyInstall"

; ---------------------------------------------------------------- state

; command line and logging
Var Params
Var LogPath
Var L_msg
Var Elevated         ; 1 when started by our own runas relaunch
Var Reinstall        ; 1: /reinstall (install again even if already installed)
Var InstTime         ; the install's UTC time, for manifest.txt and .ib-installed
Var FinishText       ; the finish page's text: where to find the app
; metadata
Var RecFile          ; record, UTF-8 ("" if none)
Var PlanFile         ; plan, UTF-8
Var RecU16
Var PlanU16
Var RecHash          ; 26-char base32 hash of the record
Var Backend
Var OptBackend
Var MetaSrc          ; where the record came from, for the transparency page
Var PlanSrc
Var PlanKind         ; fetched, cmdline or embedded
Var PlanSig          ; ibsig::check's answer
Var PlanWarn         ; a warning for the review page
Var PlanRec          ; the plan header's `record`
Var PlanReq          ; the plan header's first `request` (plans by name), fields joined by |
Var PlanReqWant      ; what a plan by name must say there
Var PlanNonce        ; the `request nonce` this installer sent (design.md 7.1)
Var PlanNonceGot     ; the one the plan came back with
Var PlanSigned       ; the plan header's `signed`
Var PlanMaxAge       ; the plan header's `maxage`
Var AgeWarn          ; a warning about a carried plan's age
Var RevokeNote       ; what the revocation list said, for the review page
Var ShaList          ; file of every SHA-256 this install would download
Var RecSrcKey        ; the record's source as the takedown list spells it
Var UnsignedOK       ; 1: /unsigned-plan
Var HasBlock         ; 1: an appended metadata block
Var ModeA            ; 1: signed base with no block (design.md 3): file name + built-in backend only
Var SignedBy
Var PackOff          ; offset of the pack in $EXEPATH (0 = none)
Var PackLen
Var TokRuntime       ; plain file-name tokens
Var TokProject
; record fields shown on the transparency page
Var RecSource
Var RecLaunch
; plan header
Var AppName
Var Project
Var AppId
Var Console
Var Menu
Var WantDesktop
Var RootMode
Var RootName
Var RecRoot          ; the record's root and rootname ("" if none), for the offline check
Var RecRootName
Var SrcLine          ; plan line number of `source` (0 = none)
Var SrcName
Var SrcSha
Var SrcSize
Var SrcFmt
Var SrcStrip
Var SrcUrl1
; machine
Var WinVer
Var WinBuild
Var Arch
; chosen target
Var TgtLine          ; plan line number of the chosen [target]
Var TgtNo
Var TgtRuntime
Var TgtRtName        ; the runtime's id, for the architecture note
Var TgtRtArch        ; the architecture of the build this block installs
Var TgtExe
Var TgtInstall
Var TgtLaunch
Var TgtAdmin
Var TgtNote
Var TgtFail
; system-wide prerequisites (format.md "Prerequisites"): the block's `need` entries
Var NdCount          ; how many
Var NdSat            ; one character per need, in order: 1 present, 0 missing
Var NdMissing        ; how many are missing
Var NdManual         ; missing ones with no way to install them here (no nrun)
Var NdLabels         ; the missing ones' labels, joined by ", "
Var NdHow            ; the first missing one's nhow
Var NdManualMsg      ; the message for the first missing one that can't be installed
Var NdFail           ; 1: installing a prerequisite failed (nothing of the app was touched)
Var FF_ukey          ; FetchFile: the url key after the file line (url, or nurl for a need)
; paths
Var SysDrv
Var Root
Var AppDir
Var DataDir
Var RuntimeDir
Var Runtime
Var TmpDir
Var DlDir
Var FileMap          ; "\tname\thash12" per plan file
Var SafeName         ; app name usable as a file name
Var CurDir           ; {dir} inside a file's steps
Var CurFile          ; {file}
Var CurName
Var CurFname
Var CurSha
; results
Var Failed
Var FailMsg
Var NeedAdmin
Var LnkDir
Var LnkApp
Var LnkUn
Var LnkDesk
Var RegRootName
Var RegKey
Var Created          ; 1 once we have created the app folder
Var SumH
; function parameters
Var FF_line
Var FF_sha
Var FF_unpinned      ; this one file may have no SHA-256 (the app's source)
Var FF_name
Var FF_path
Var FF_h
Var FF_t
Var RC_cmd
Var RC_cwd
Var RC_quiet
Var RC_code
Var UP_file
Var UP_fmt
Var UP_dest
Var UP_strip
Var UP_excl          ; unpack's 4th field: "|"-separated exclude globs
Var UP_zargs         ; $UP_excl as 7za switches
Var EX_pat
Var EX_str
Var EX_dir
Var EX_rel
Var SI_src
Var SI_level
Var SI_dest
Var CR_h
Var CR_off
Var CR_len
Var CR_dst
Var BH               ; block-scan handle
Var LineNo
; uninstaller
Var UnRoot
Var UnSmCur
Var UnSmAll
Var UnDeskCur
Var UnDeskAll

!insertmacro IB_UTIL ""
!insertmacro IB_UTIL "un."

!macro Log MSG
  StrCpy $L_msg "${MSG}"
  Call LogLine
!macroend
!define Log "!insertmacro Log"

!macro FailWith MSG
  StrCpy $FailMsg "${MSG}"
  StrCpy $Failed 1
!macroend
!define FailWith "!insertmacro FailWith"

!macro Sum MSG
  FileWriteUTF16LE $SumH "${MSG}$\r$\n"
!macroend
!define Sum "!insertmacro Sum"

; ---------------------------------------------------------------- pages

!include "MUI2.nsh"
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

Page custom ReviewShow ReviewLeave
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Installed"
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "Installation failed"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "Nothing was left behind. The log above says what went wrong."
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPre
!define MUI_FINISHPAGE_TITLE "$AppName is installed"
!define MUI_FINISHPAGE_TEXT "$FinishText"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Run $AppName now"
!define MUI_FINISHPAGE_RUN_FUNCTION RunApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- logging

Function LogLine
  DetailPrint "$L_msg"
  ${If} $LogPath != ""
    Push $U_a
    Push $U_b
    StrCpy $U_a $LogPath
    StrCpy $U_b "$L_msg$\r$\n"
    Call IbAppendUtf8
    Pop $U_b
    Pop $U_a
  ${EndIf}
FunctionEnd

; Write the lines of an ANSI/OEM text file (a command's output) to the log.
Function LogFile
  Push $0
  Push $1
  ClearErrors
  FileOpen $0 "$U_a" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileRead $0 $1
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${IbTrimNL} $1
      ${Log} "  | $1"
    ${Loop}
    FileClose $0
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- small helpers

; SHA-256 of file $U_a -> lowercase hex in $U_out ("" on error).
Function Sha256File
  Push $0
  HashInfo::GetFileCryptoHash "SHA2-256" "$U_a"
  Pop $0
  StrLen $U_out $0
  ${If} $U_out = 64
    System::Call 'user32::CharLowerW(w r0 r0)'
    StrCpy $U_out $0
  ${Else}
    StrCpy $U_out ""
  ${EndIf}
  Pop $0
FunctionEnd

; Base32 record hash (26 chars) of file $U_a -> $U_out.
Function RecordHashOf
  Call Sha256File
  ${If} $U_out != ""
    StrCpy $U_a $U_out
    StrCpy $U_b 26
    Call IbHexToB32
  ${EndIf}
FunctionEnd

; Folder hash (12 chars) for plan file $U_a: base32(sha256(appid + name)).
Function FolderHash
  Push $0
  StrCpy $0 $U_a
  Delete "$PLUGINSDIR\fh.txt"
  StrCpy $U_a "$PLUGINSDIR\fh.txt"
  StrCpy $U_b "$AppId$0"
  Call IbAppendUtf8
  StrCpy $U_a "$PLUGINSDIR\fh.txt"
  Call Sha256File
  StrCpy $U_a $U_out
  StrCpy $U_b 12
  Call IbHexToB32
  Pop $0
FunctionEnd

; Read a little-endian 32-bit number at offset $U_b of open file $U_a.
Function ReadU32
  Push $0
  Push $1
  FileSeek $U_a $U_b SET
  FileReadByte $U_a $0
  StrCpy $U_out $0
  FileReadByte $U_a $0
  IntOp $0 $0 << 8
  IntOp $U_out $U_out | $0
  FileReadByte $U_a $0
  IntOp $0 $0 << 16
  IntOp $U_out $U_out | $0
  FileReadByte $U_a $0
  IntOp $0 $0 << 24
  IntOp $U_out $U_out | $0
  Pop $1
  Pop $0
FunctionEnd

; "000000001234" -> 1234 (NSIS reads a leading 0 as octal).
Function DecNum
  Push $0
  ${Do}
    StrCpy $0 $U_a 1
    StrLen $U_out $U_a
    ${If} $0 == "0"
    ${AndIf} $U_out > 1
      StrCpy $U_a $U_a "" 1
    ${Else}
      ${Break}
    ${EndIf}
  ${Loop}
  IntOp $U_out $U_a + 0
  Pop $0
FunctionEnd

; Copy $CR_len bytes at $CR_off of open handle $CR_h to new file $CR_dst.
Function CopyRange
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ClearErrors
  FileOpen $0 "$CR_dst" w
  ${If} ${Errors}
    StrCpy $U_out 0
    Goto cr_end
  ${EndIf}
  FileSeek $CR_h $CR_off SET
  System::Alloc 1048576
  Pop $1
  StrCpy $U_out 1
  ${Do}
    ${If} $CR_len <= 0
      ${Break}
    ${EndIf}
    StrCpy $2 1048576
    ${If} $CR_len < $2
      StrCpy $2 $CR_len
    ${EndIf}
    System::Call 'kernel32::ReadFile(p $CR_h, p r1, i r2, *i .r3, p 0) i .r4'
    ${If} $4 = 0
    ${OrIf} $3 = 0
      StrCpy $U_out 0
      ${Break}
    ${EndIf}
    System::Call 'kernel32::WriteFile(p r0, p r1, i r3, *i .r2, p 0) i .r4'
    ${If} $4 = 0
      StrCpy $U_out 0
      ${Break}
    ${EndIf}
    IntOp $CR_len $CR_len - $3
  ${Loop}
  System::Free $1
  FileClose $0
  cr_end:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Replace characters Windows forbids in file names. $U_a -> $U_out.
Function SafeFileName
  Push $0
  Push $1
  Push $2
  StrCpy $U_out ""
  StrLen $1 $U_a
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $1
      ${Break}
    ${EndIf}
    StrCpy $2 $U_a 1 $0
    ${If} $2 == "\"
    ${OrIf} $2 == "/"
    ${OrIf} $2 == ":"
    ${OrIf} $2 == "*"
    ${OrIf} $2 == "?"
    ${OrIf} $2 == '"'
    ${OrIf} $2 == "<"
    ${OrIf} $2 == ">"
    ${OrIf} $2 == "|"
      StrCpy $2 "_"
    ${EndIf}
    StrCpy $U_out "$U_out$2"
    IntOp $0 $0 + 1
  ${Loop}
  ; no trailing dots or spaces
  ${Do}
    StrCpy $2 $U_out 1 -1
    ${If} $2 == "."
    ${OrIf} $2 == " "
      StrCpy $U_out $U_out -1
    ${Else}
      ${Break}
    ${EndIf}
  ${Loop}
  ${If} $U_out == ""
    StrCpy $U_out "App"
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if $U_a is a plain file name (no path parts, no ..).
Function IsPlainName
  Push $0
  StrCpy $U_out 1
  ${If} $U_a == ""
  ${OrIf} $U_a == "."
  ${OrIf} $U_a == ".."
    StrCpy $U_out 0
  ${Else}
    StrCpy $0 $U_a
    StrCpy $U_b "\"
    Call IbContains
    ${If} $U_out = 0
      StrCpy $U_a $0
      StrCpy $U_b "/"
      Call IbContains
      ${If} $U_out = 0
        StrCpy $U_a $0
        StrCpy $U_b ":"
        Call IbContains
      ${EndIf}
    ${EndIf}
    ${If} $U_out = 1
      StrCpy $U_out 0
    ${Else}
      StrCpy $U_out 1
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; Tokens (format.md section 1) in $U_a -> $U_out.
Function Subst
  Push $0
  Push $1
  Push $2
  StrCpy $0 $U_a
  ; {dir:<name>} first
  StrCpy $T_rest $FileMap
  Call IbSplitTab                        ; leading empty field
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call IbSplitTab
    StrCpy $1 $T_field
    Call IbSplitTab
    StrCpy $2 $T_field
    ${WordReplace} "$0" "{dir:$1}" "$Root\$2" "+" $0
  ${Loop}
  ${WordReplace} "$0" "{app_dir}" "$AppDir" "+" $0
  ${WordReplace} "$0" "{data_dir}" "$DataDir" "+" $0
  ${WordReplace} "$0" "{runtime_dir}" "$RuntimeDir" "+" $0
  ${WordReplace} "$0" "{runtime}" "$Runtime" "+" $0
  ${WordReplace} "$0" "{dir}" "$CurDir" "+" $0
  ${WordReplace} "$0" "{file}" "$CurFile" "+" $0
  ${WordReplace} "$0" "{tmp}" "$TmpDir" "+" $0
  ${WordReplace} "$0" "{project}" "$Project" "+" $0
  ${WordReplace} "$0" "{sep}" "\" "+" $0
  StrCpy $U_out $0
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Command-line option $U_a ("/name=" or a "/flag") -> $U_out, error flag
; set if it isn't there. Unlike GetOptions, which ends a value at the next
; "/" (so /backend=http://host lost everything after "http:"), a value
; ends at the next space, or at the closing quote if it starts with one.
Function IbGetOpt
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $U_out ""
  StrCpy $3 " $Params"
  StrLen $1 $3
  StrLen $2 $U_a
  StrCpy $0 0
  StrCpy $5 0                           ; found
  ${Do}
    ${If} $0 >= $1
      ${Break}
    ${EndIf}
    StrCpy $4 $3 1 $0
    ${If} $4 == " "
      IntOp $4 $0 + 1
      StrCpy $4 $3 $2 $4
      ${If} $4 == $U_a
        IntOp $0 $0 + 1
        IntOp $0 $0 + $2                ; value start
        StrCpy $4 $U_a 1 -1
        ${If} $4 != "="
          ; a flag: must end here
          StrCpy $4 $3 1 $0
          ${If} $4 != " "
          ${AndIf} $4 != ""
            ${Continue}
          ${EndIf}
          StrCpy $5 1
          ${Break}
        ${EndIf}
        StrCpy $5 1
        StrCpy $4 $3 1 $0
        ${If} $4 == '"'
          IntOp $0 $0 + 1
          StrCpy $4 '"'
        ${Else}
          StrCpy $4 " "
        ${EndIf}
        ${Do}
          StrCpy $2 $3 1 $0
          ${If} $2 == ""
          ${OrIf} $2 == $4
            ${Break}
          ${EndIf}
          StrCpy $U_out "$U_out$2"
          IntOp $0 $0 + 1
        ${Loop}
        ${Break}
      ${EndIf}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  ${If} $5 = 1
    ClearErrors
  ${Else}
    SetErrors
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macro IbGetOpt OPT OUT
  StrCpy $U_a "${OPT}"
  Call IbGetOpt
  StrCpy ${OUT} $U_out
!macroend
!define IbGetOpt "!insertmacro IbGetOpt"

; Download $U_a to file $U_b with INetC. $U_out = "OK" or an error.
Function Download
  Delete "$U_b"
  ${If} ${Silent}
    inetc::get /SILENT /CONNECTTIMEOUT 10 /RECEIVETIMEOUT 60 "$U_a" "$U_b" /END
  ${Else}
    inetc::get /CONNECTTIMEOUT 10 /RECEIVETIMEOUT 60 "$U_a" "$U_b" /END
  ${EndIf}
  Pop $U_out
FunctionEnd

; Same, with no progress window (used before the UI exists).
Function DownloadQuiet
  Delete "$U_b"
  inetc::get /SILENT /CONNECTTIMEOUT 10 /RECEIVETIMEOUT 60 "$U_a" "$U_b" /END
  Pop $U_out
FunctionEnd

; A small document the install can do without (the revocation list): a
; short timeout, so an offline installer -- which carries everything it
; needs -- isn't held up by a network that isn't there.
Function DownloadOptional
  Delete "$U_b"
  inetc::get /SILENT /CONNECTTIMEOUT 5 /RECEIVETIMEOUT 15 "$U_a" "$U_b" /END
  Pop $U_out
FunctionEnd

; Is this path inside one of this app's folders (app, runtime folders, tmp)?
; $U_a path -> $U_out 1/0
Function InAppFolders
  Push $0
  Push $1
  StrCpy $0 $U_a
  StrCpy $U_b ".."
  Call IbContains
  ${If} $U_out = 1
    StrCpy $U_out 0
    Goto iaf_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$AppDir\"
  Call IbStartsWith
  ${If} $U_out = 1
    Goto iaf_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$TmpDir\"
  Call IbStartsWith
  ${If} $U_out = 1
    Goto iaf_end
  ${EndIf}
  StrCpy $T_rest $FileMap
  Call IbSplitTab
  ${Do}
    ${If} $T_more = 0
      StrCpy $U_out 0
      ${Break}
    ${EndIf}
    Call IbSplitTab
    Call IbSplitTab
    StrCpy $1 $T_field
    StrCpy $U_a $0
    StrCpy $U_b "$Root\$1\"
    Call IbStartsWith
    ${If} $U_out = 1
      ${Break}
    ${EndIf}
  ${Loop}
  iaf_end:
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- metadata

; Look for the appended block (format.md section 4). Extracts record.txt and
; plan.txt into $PLUGINSDIR and sets $PackOff/$PackLen. $U_out = 1 if found.
Function FindBlock
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  StrCpy $U_out 0
  StrCpy $SignedBy ""
  ClearErrors
  FileOpen $0 "$EXEPATH" r
  ${If} ${Errors}
    Goto fb_end
  ${EndIf}
  FileSeek $0 0 END $1                 ; $1 = end of the block
  ; PE certificate table (data directory 4)
  StrCpy $U_a $0
  StrCpy $U_b 0x3C
  Call ReadU32
  StrCpy $2 $U_out                     ; e_lfanew
  IntOp $3 $2 + 24                     ; optional header
  FileSeek $0 $3 SET
  FileReadByte $0 $4
  FileReadByte $0 $5
  IntOp $5 $5 << 8
  IntOp $4 $4 | $5                     ; magic
  ${If} $4 = 0x20b
    IntOp $3 $3 + 112
  ${Else}
    IntOp $3 $3 + 96
  ${EndIf}
  IntOp $3 $3 + 32                     ; entry 4
  StrCpy $U_a $0
  StrCpy $U_b $3
  Call ReadU32
  StrCpy $6 $U_out                     ; cert table file offset
  IntOp $3 $3 + 4
  StrCpy $U_a $0
  StrCpy $U_b $3
  Call ReadU32
  StrCpy $7 $U_out                     ; cert table size
  ${If} $6 > 0
  ${AndIf} $6 < $1
  ${AndIf} $7 > 0
    StrCpy $1 $6
    StrCpy $SignedBy "signed"
  ${EndIf}
  ; skip up to 7 NUL bytes of signing padding
  StrCpy $2 0
  ${Do}
    ${If} $2 >= 7
    ${OrIf} $1 < 65
      ${Break}
    ${EndIf}
    IntOp $3 $1 - 1
    FileSeek $0 $3 SET
    FileReadByte $0 $4
    ${If} $4 <> 0
      ${Break}
    ${EndIf}
    StrCpy $1 $3
    IntOp $2 $2 + 1
  ${Loop}
  ; footer (from here on $U_out is "found?"; ReadU32 used it above)
  StrCpy $U_out 0
  ${If} $1 < 64
    FileClose $0
    Goto fb_end
  ${EndIf}
  IntOp $3 $1 - 64
  FileSeek $0 $3 SET
  FileRead $0 $4 64
  StrCpy $5 $4 8
  StrLen $2 $4
  ${If} $5 S!= "IBMETA1 "
  ${OrIf} $2 <> 64
    FileClose $0
    Goto fb_end
  ${EndIf}
  StrCpy $U_a $4 12 8
  Call DecNum
  StrCpy $5 $U_out                     ; record length
  StrCpy $U_a $4 12 21
  Call DecNum
  StrCpy $6 $U_out                     ; plan length
  StrCpy $U_a $4 12 34
  Call DecNum
  StrCpy $7 $U_out                     ; pack length
  IntOp $PackOff $3 - $7
  StrCpy $PackLen $7
  IntOp $2 $PackOff - $6               ; plan offset
  IntOp $4 $2 - $5                     ; record offset
  ${If} $4 < 512
  ${OrIf} $5 <= 0
    FileClose $0
    Goto fb_end
  ${EndIf}
  StrCpy $CR_h $0
  StrCpy $CR_off $4
  StrCpy $CR_len $5
  StrCpy $CR_dst "$PLUGINSDIR\record.txt"
  Call CopyRange
  StrCpy $RecFile "$PLUGINSDIR\record.txt"
  ${If} $6 > 0
    StrCpy $CR_h $0
    StrCpy $CR_off $2
    StrCpy $CR_len $6
    StrCpy $CR_dst "$PLUGINSDIR\plan.txt"
    Call CopyRange
    StrCpy $PlanFile "$PLUGINSDIR\plan.txt"
  ${EndIf}
  ${If} $PackLen = 0
    StrCpy $PackOff 0
  ${EndIf}
  FileClose $0
  StrCpy $U_out 1
  fb_end:
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Name of the Authenticode signer (as the certificate states it) -> $SignedBy.
; Windows itself verifies the signature (file Properties, SmartScreen).
Function GetSigner
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  StrCpy $1 $EXEPATH
  StrCpy $2 0
  StrCpy $3 0
  System::Call 'crypt32::CryptQueryObject(i 1, w r1, i 0x400, i 2, i 0, p 0, p 0, p 0, *p .r2, *p .r3, p 0) i .r0'
  ${If} $0 <> 0
    System::Call 'crypt32::CryptMsgGetParam(p r3, i 6, i 0, p 0, *i .r4) i .r0'
    ${If} $0 <> 0
      System::Alloc $4
      Pop $5
      System::Call 'crypt32::CryptMsgGetParam(p r3, i 6, i 0, p r5, *i r4) i .r0'
      ; CMSG_SIGNER_INFO: dwVersion, Issuer blob, SerialNumber blob
      System::Call '*$5(i, i .r6, p .r7, i .r8, p .r9)'
      ; CERT_INFO with SerialNumber (offset 4) and Issuer (offset 24)
      System::Call '*(i 0, i r8, p r9, p 0, i 0, p 0, i r6, p r7, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0) p .R0'
      System::Call 'crypt32::CertFindCertificateInStore(p r2, i 0x10001, i 0, i 0xB0000, p R0, p 0) p .R1'
      ${If} $R1 <> 0
        System::Call 'crypt32::CertGetNameStringW(p R1, i 4, i 0, p 0, w .R2, i ${NSIS_MAX_STRLEN}) i'
        StrCpy $SignedBy $R2
        System::Call 'crypt32::CertFreeCertificateContext(p R1)'
      ${EndIf}
      System::Free $R0
      System::Free $5
    ${EndIf}
  ${EndIf}
  ${If} $3 <> 0
    System::Call 'crypt32::CryptMsgClose(p r3)'
  ${EndIf}
  ${If} $2 <> 0
    System::Call 'crypt32::CertCloseStore(p r2, i 0)'
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Mode A/B file name: strip the copy suffix, lowercase, split on "_".
; Sets $RecHash (if the last token is a 26-char base32 hash), $TokRuntime
; and $TokProject.
Function ParseFileName
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 $EXEFILE
  StrCpy $1 $0 4 -4
  ${If} $1 == ".exe"
    StrCpy $0 $0 -4
  ${EndIf}
  ; copy suffixes: " (1)", "(1)", " - Copy", " - Copy (2)"
  ${Do}
    StrCpy $2 $0
    StrCpy $1 $0 1 -1
    ${If} $1 == ")"
      StrLen $3 $0
      ${Do}
        IntOp $3 $3 - 1
        ${If} $3 < 0
          ${Break}
        ${EndIf}
        StrCpy $1 $0 1 $3
        ${If} $1 == "("
          StrCpy $0 $0 $3
          ${Break}
        ${EndIf}
      ${Loop}
    ${EndIf}
    StrCpy $1 $0 7 -7
    ${If} $1 == " - Copy"
      StrCpy $0 $0 -7
    ${EndIf}
    ${Do}
      StrCpy $1 $0 1 -1
      ${If} $1 == " "
        StrCpy $0 $0 -1
      ${Else}
        ${Break}
      ${EndIf}
    ${Loop}
  ${LoopUntil} $0 == $2
  System::Call 'user32::CharLowerW(w r0 r0)'
  ; last "_" token
  StrLen $1 $0
  StrCpy $2 -1
  StrCpy $3 $1
  ${Do}
    IntOp $3 $3 - 1
    ${If} $3 < 0
      ${Break}
    ${EndIf}
    StrCpy $2 $0 1 $3
    ${If} $2 == "_"
      ${Break}
    ${EndIf}
  ${Loop}
  StrCpy $RecHash ""
  ${If} $3 >= 0
    IntOp $2 $3 + 1
    StrCpy $U_a $0 "" $2
    StrCpy $U_b 26
    Call IbIsB32
    ${If} $U_out = 1
      StrCpy $RecHash $U_a
      StrCpy $0 $0 $3                  ; drop the hash token
    ${EndIf}
  ${EndIf}
  ; install_<runtime>_<project>
  StrCpy $TokRuntime ""
  StrCpy $TokProject ""
  StrCpy $1 $0 8
  ${If} $1 == "install_"
    StrCpy $0 $0 "" 8
    StrLen $1 $0
    StrCpy $3 0
    ${Do}
      ${If} $3 >= $1
        ${Break}
      ${EndIf}
      StrCpy $2 $0 1 $3
      ${If} $2 == "_"
        StrCpy $TokRuntime $0 $3
        IntOp $3 $3 + 1
        StrCpy $TokProject $0 "" $3
        ${Break}
      ${EndIf}
      IntOp $3 $3 + 1
    ${Loop}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The record's source as the takedown list and the revocation list spell
; it, "<kind> <value>": lowercased, and a GitHub URL reduced to
; owner/repo, exactly as the server's sourceKey does (backend/server.js).
Function SourceKey            ; $U_a kind, $U_b value -> $RecSrcKey
  Push $0
  Push $1
  StrCpy $0 $U_b
  System::Call 'user32::CharLowerW(w r0 r0)'
  ${If} $U_a S== "github"
    StrCpy $1 $0 8
    ${If} $1 == "https://"
      StrCpy $0 $0 "" 8
    ${Else}
      StrCpy $1 $0 7
      ${If} $1 == "http://"
        StrCpy $0 $0 "" 7
      ${EndIf}
    ${EndIf}
    StrCpy $1 $0 11
    ${If} $1 == "github.com/"
      StrCpy $0 $0 "" 11
    ${EndIf}
    StrCpy $1 $0 "" -1
    ${If} $1 == "/"
      StrCpy $0 $0 -1
    ${EndIf}
    StrCpy $1 $0 "" -4
    ${If} $1 == ".git"
      StrCpy $0 $0 -4
    ${EndIf}
  ${EndIf}
  StrCpy $RecSrcKey "$U_a $0"
  Pop $1
  Pop $0
FunctionEnd

; Read the record's display fields and its backend line.
Function ReadRecord
  Push $0
  StrCpy $RecU16 "$PLUGINSDIR\record.u16"
  StrCpy $U_a $RecFile
  StrCpy $U_b $RecU16
  Call IbUtf8ToUtf16
  FileOpen $0 $RecU16 r
  ${IbRead} $0
  StrCpy $T_rest $T_line
  Call IbSplitTab
  ${If} $T_field S!= "ib-record"
    FileClose $0
    ${FailWith} "The record is not an ib-record file."
    Goto rr_end
  ${EndIf}
  Call IbSplitTab
  IntOp $T_field $T_field + 0
  ${If} $T_field > 1
    FileClose $0
    ${FailWith} "The record's format version is newer than this installer understands. Download the installer again."
    Goto rr_end
  ${EndIf}
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "backend"
    ${AndIf} $OptBackend == ""
    ${AndIf} $ModeA = 0
      StrCpy $Backend $F1
    ${ElseIf} $K S== "source"
      StrCpy $RecSource "$F1 $F2"
      ${If} $F3 != ""
        StrCpy $RecSource "$RecSource $F3"
      ${EndIf}
      StrCpy $U_a $F1
      StrCpy $U_b $F2
      Call SourceKey
    ${ElseIf} $K S== "launch"
      StrCpy $RecLaunch $F1
    ${ElseIf} $K S== "root"
      StrCpy $RecRoot $F1
    ${ElseIf} $K S== "rootname"
      StrCpy $RecRootName $F1
    ${EndIf}
  ${Loop}
  FileClose $0
  rr_end:
  Pop $0
FunctionEnd

; Read the plan header and pick the first [target] matching this machine.
Function ReadPlan
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $PlanU16 "$PLUGINSDIR\plan.u16"
  StrCpy $U_a $PlanFile
  StrCpy $U_b $PlanU16
  Call IbUtf8ToUtf16
  FileOpen $0 $PlanU16 r
  ${IbRead} $0
  StrCpy $T_rest $T_line
  Call IbSplitTab
  ${If} $T_field S!= "ib-plan"
    FileClose $0
    ${FailWith} "The plan is not an ib-plan file."
    Goto rp_end
  ${EndIf}
  Call IbSplitTab
  IntOp $T_field $T_field + 0
  ${If} $T_field > 1
    FileClose $0
    ${FailWith} "The plan's format version is newer than this installer understands. Download the installer again."
    Goto rp_end
  ${EndIf}
  StrCpy $LineNo 1
  StrCpy $1 0          ; in a block?
  StrCpy $2 0          ; this block's when matched
  StrCpy $3 1          ; this block's minbuild matched
  StrCpy $4 0          ; block number
  StrCpy $TgtLine 0
  StrCpy $SrcLine 0
  StrCpy $Console 0
  StrCpy $Menu 1
  StrCpy $WantDesktop 0
  StrCpy $RootMode "user"
  StrCpy $RootName "ib"
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    IntOp $LineNo $LineNo + 1
    Call IbParseLine
    ${If} $K S== "[target]"
      ${If} $1 = 1
      ${AndIf} $2 = 1
      ${AndIf} $3 = 1
        ${Break}
      ${EndIf}
      StrCpy $1 1
      StrCpy $2 0
      StrCpy $3 1
      IntOp $4 $4 + 1
      StrCpy $TgtLine $LineNo
      StrCpy $TgtNo $4
      ${Continue}
    ${EndIf}
    ${If} $1 = 0
      ; header
      ${If} $K S== "record"
        ${If} $PlanRec == ""
          StrCpy $PlanRec $F1
        ${EndIf}
      ${ElseIf} $K S== "request"
        ; The first `request` line is the one that says what was asked for
        ; (format.md section 1); a `nonce` line is read on its own.
        ${If} $F1 S== "nonce"
          ${If} $PlanNonceGot == ""
            StrCpy $PlanNonceGot $F2
          ${EndIf}
        ${ElseIf} $PlanReq == ""
          StrCpy $PlanReq "$F1|$F2|$F3"
        ${EndIf}
      ${ElseIf} $K S== "signed"
        StrCpy $PlanSigned $F1
      ${ElseIf} $K S== "maxage"
        StrCpy $PlanMaxAge $F1
      ${ElseIf} $K S== "name"
        StrCpy $AppName $F1
      ${ElseIf} $K S== "project"
        StrCpy $Project $F1
      ${ElseIf} $K S== "appid"
        StrCpy $AppId $F1
      ${ElseIf} $K S== "console"
        StrCpy $Console $F1
      ${ElseIf} $K S== "menu"
        StrCpy $Menu $F1
      ${ElseIf} $K S== "desktop"
        StrCpy $WantDesktop $F1
      ${ElseIf} $K S== "root"
        StrCpy $RootMode $F1
      ${ElseIf} $K S== "rootname"
        StrCpy $RootName $F1
      ${ElseIf} $K S== "source"
        StrCpy $SrcLine $LineNo
        StrCpy $SrcName $F1
        StrCpy $SrcSha $F2
        StrCpy $SrcSize $F3
        StrCpy $SrcFmt $F4
        StrCpy $SrcStrip $F5
      ${ElseIf} $K S== "url"
      ${AndIf} $SrcLine > 0
      ${AndIf} $SrcUrl1 == ""
        StrCpy $SrcUrl1 $F1
      ${EndIf}
      ${Continue}
    ${EndIf}
    ; inside a block
    ${If} $K S== "when"
      ${If} $F1 S== "windows"
      ${AndIf} $WinVer >= $F2
      ${AndIf} $WinVer <= $F3
        ${If} $F4 == "*"
          StrCpy $2 1
        ${Else}
          StrCpy $U_a " $F4 "
          StrCpy $U_b " $Arch "
          Call IbContains
          StrCpy $2 $U_out
        ${EndIf}
      ${EndIf}
    ${ElseIf} $K S== "minbuild"
      ${If} $WinBuild < $F1
        StrCpy $3 0
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $0
  ${If} $1 = 0
  ${OrIf} $2 = 0
  ${OrIf} $3 = 0
    StrCpy $TgtLine 0
  ${EndIf}
  rp_end:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Open the plan positioned just after the chosen [target] line: handle $BH.
Function OpenBlock
  Push $0
  FileOpen $BH $PlanU16 r
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $TgtLine
      ${Break}
    ${EndIf}
    ${IbRead} $BH
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $LineNo $TgtLine
  Pop $0
FunctionEnd

; Append one SHA-256 to $ShaList (the file is opened per line, so no
; register has to survive the loop in ReadTarget).
Function AppendSha            ; $U_a
  Push $0
  ${If} $U_a != ""
    FileOpen $0 "$ShaList" a
    ${If} $0 != ""
      FileSeek $0 0 END
      FileWrite $0 "$U_a$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; Read the chosen block's single-value keys and map each file to its folder.
Function ReadTarget
  Push $0
  StrCpy $FileMap ""
  StrCpy $RuntimeDir ""
  StrCpy $TgtAdmin 0
  ; Every SHA-256 this install would download, for the revocation list
  ; (format.md section 7): the source in the header, and this block's
  ; files and prerequisite installers.
  Delete "$ShaList"
  StrCpy $U_a $SrcSha
  Call AppendSha
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "runtime"
      StrCpy $TgtRuntime "$F1 $F2"
      StrCpy $TgtRtName $F1
      StrCpy $TgtRtArch $F3          ; 3rd value, empty in plans made before 2026-09-20
    ${ElseIf} $K S== "exe"
      StrCpy $TgtExe $F1
    ${ElseIf} $K S== "install"
      StrCpy $TgtInstall $F1
    ${ElseIf} $K S== "launch"
      StrCpy $TgtLaunch $F1
    ${ElseIf} $K S== "admin"
      StrCpy $TgtAdmin $F1
    ${ElseIf} $K S== "note"
      StrCpy $TgtNote $F1
    ${ElseIf} $K S== "fail"
      StrCpy $TgtFail $F1
    ${ElseIf} $K S== "nfile"
      StrCpy $U_a $F2
      Call AppendSha
    ${ElseIf} $K S== "file"
      StrCpy $0 $F3
      StrCpy $U_a $0
      Call AppendSha
      StrCpy $0 $F1
      StrCpy $U_a $F2
      Call IsPlainName
      ${If} $U_out = 0
        ${FailWith} "The plan names a file with a path in it: $U_a"
        ${Break}
      ${EndIf}
      StrCpy $U_a $0
      Call FolderHash
      StrCpy $FileMap "$FileMap$\t$0$\t$U_out"
      ${If} $RuntimeDir == ""
        StrCpy $RuntimeDir "$Root\$U_out"
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $BH
  ${If} $RuntimeDir == ""
    StrCpy $RuntimeDir $AppDir
  ${EndIf}
  StrCpy $Runtime ""
  ${If} $TgtExe != ""
    StrCpy $Runtime "$RuntimeDir\$TgtExe"
  ${EndIf}
  Pop $0
FunctionEnd

; Where the metadata is, in plan.md 1.1 order.
Function FindMetadata
  StrCpy $RecFile ""
  StrCpy $PlanFile ""
  StrCpy $RecHash ""
  StrCpy $PackOff 0
  StrCpy $PackLen 0
  StrCpy $PlanKind ""
  ; The appended block first, only to learn which mode this file is in:
  ; a certificate table with no block before it is a signed base (mode A),
  ; which only installs what its file name names (design.md 3 and 7).
  Call FindBlock
  StrCpy $HasBlock $U_out
  ${If} $SignedBy == "signed"
    Call GetSigner
    ${If} $SignedBy == "signed"
    ${OrIf} $SignedBy == ""
      StrCpy $SignedBy "an Authenticode signature whose signer couldn't be read"
    ${EndIf}
  ${EndIf}
  StrCpy $ModeA 0
  ${If} $SignedBy != ""
  ${AndIf} $HasBlock = 0
    StrCpy $ModeA 1
    ${Log} "Signed base with no metadata block: mode A (file name and the built-in backend only)"
  ${EndIf}
  ; 1. command line (not in mode A)
  StrCpy $1 ""
  ClearErrors
  ${IbGetOpt} "/record=" $0
  ${IfNot} ${Errors}
    StrCpy $1 "/record="
  ${EndIf}
  ClearErrors
  ${IbGetOpt} "/plan=" $2
  ${IfNot} ${Errors}
    StrCpy $1 "$1 /plan="
  ${EndIf}
  ${If} $UnsignedOK = 1
    StrCpy $1 "$1 /unsigned-plan"
  ${EndIf}
  ${If} $OptBackend != ""
  ${AndIf} $ModeA = 1
    StrCpy $1 "$1 /backend="
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $ModeA = 1
    ${FailWith} "This installer is signed by $SignedBy and only installs the app its file name names, from ${IB_BACKEND}. It doesn't accept $1. For your own settings use an unsigned base or one you sign yourself (modes B and C)."
    Return
  ${EndIf}
  ${If} $1 == ""
  ${OrIf} $1 == " /unsigned-plan"
    Goto fm_block
  ${EndIf}
  ; the command line replaces the block entirely, pack included
  StrCpy $RecFile ""
  StrCpy $PlanFile ""
  StrCpy $PackOff 0
  StrCpy $PackLen 0
  ClearErrors
  ${IbGetOpt} "/record=" $0
  ${IfNot} ${Errors}
    StrCpy $RecFile $0
    StrCpy $MetaSrc "the command line (/record=$0)"
    ${IfNot} ${FileExists} "$RecFile"
      ${FailWith} "Can't read $RecFile."
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${IbGetOpt} "/plan=" $0
  ${IfNot} ${Errors}
    StrCpy $PlanFile $0
    StrCpy $PlanKind "cmdline"
    StrCpy $PlanSrc "the command line (/plan=$0)"
    ${If} $RecFile == ""
      StrCpy $MetaSrc "the command line (/plan=$0)"
    ${EndIf}
  ${EndIf}
  Return
  fm_block:
  ; 2. appended block (FindBlock extracted it)
  ${If} $HasBlock = 1
    ${If} $SignedBy != ""
      StrCpy $MetaSrc "the block appended to this installer, before its signature"
    ${Else}
      StrCpy $MetaSrc "the block appended to this installer (unsigned, editable)"
    ${EndIf}
    ${If} $PlanFile != ""
      StrCpy $PlanKind "embedded"
      StrCpy $PlanSrc "embedded in this installer"
    ${EndIf}
    Return
  ${EndIf}
  ; 3. install.txt next to the installer (not in mode A)
  ${If} ${FileExists} "$EXEDIR\install.txt"
    ${If} $ModeA = 1
      ${Log} "Ignoring $EXEDIR\install.txt: a signed installer only uses its file name."
    ${Else}
      StrCpy $RecFile "$EXEDIR\install.txt"
      StrCpy $MetaSrc "install.txt next to the installer"
      Return
    ${EndIf}
  ${EndIf}
  ; 4. record hash in the file name (mode A)
  Call ParseFileName
  ${If} $RecHash != ""
    Call OfflineInstalled               ; installed already? checked before fetching
    StrCpy $U_a "$Backend/api/records/$RecHash"
    StrCpy $U_b "$PLUGINSDIR\record.txt"
    ${Log} "Fetching the record: $U_a"
    Call DownloadQuiet
    ${If} $U_out != "OK"
      Call TakenDownHint
      ${FailWith} "Couldn't fetch this installer's settings from $Backend/api/records/$RecHash ($U_out).$U_c"
      Return
    ${EndIf}
    StrCpy $U_a "$PLUGINSDIR\record.txt"
    Call RecordHashOf
    ${If} $U_out S!= $RecHash
      ${FailWith} "The record from $Backend doesn't match the hash in this file's name (got $U_out). Refusing to continue."
      Return
    ${EndIf}
    StrCpy $RecFile "$PLUGINSDIR\record.txt"
    StrCpy $MetaSrc "the record $RecHash named in the file name, fetched from $Backend and checked against that hash"
    Return
  ${EndIf}
  ; 5. plain file-name tokens: the plan is fetched by name
  ${If} $TokRuntime != ""
  ${AndIf} $TokProject != ""
    StrCpy $U_a "$TokRuntime/$TokProject"
    Call MakeNonce
    StrCpy $U_a "$Backend/api/plan/name/$TokRuntime/$TokProject"
    StrCpy $PlanSrc "fetched from $U_a"
    ${If} $PlanNonce != ""
      StrCpy $U_a "$U_a?nonce=$PlanNonce"
    ${EndIf}
    StrCpy $U_b "$PLUGINSDIR\plan.txt"
    ${Log} "Fetching a plan by name: $U_a"
    Call DownloadQuiet
    ${If} $U_out != "OK"
      ${FailWith} "Couldn't fetch a plan for $TokRuntime/$TokProject from $Backend ($U_out)."
      Return
    ${EndIf}
    StrCpy $PlanFile "$PLUGINSDIR\plan.txt"
    StrCpy $PlanKind "fetched"
    StrCpy $PlanReqWant "name|$TokRuntime|$TokProject"
    StrCpy $MetaSrc "the file name (runtime $TokRuntime, project $TokProject; no record hash)"
    Return
  ${EndIf}
  ${FailWith} "This installer has no settings: no appended block, no install.txt and no record hash in its file name ($EXEFILE)."
FunctionEnd

; $U_out = an INetC error. $U_c = a sentence to add when it looks like the
; backend's "taken down" answer (HTTP 451, design.md 7), else "".
Function TakenDownHint
  StrCpy $U_c ""
  Push $U_out
  StrCpy $U_a $U_out
  StrCpy $U_b "451"
  Call IbContains
  ${If} $U_out = 1
    StrCpy $U_c " The backend says this installer has been taken down (HTTP 451)."
  ${EndIf}
  Pop $U_out
FunctionEnd

; The plan's signature (format.md "Plan signature") and where it came from decide
; whether it may be used. Fetched plans must be signed by the key built
; into this base; so must /plan= files unless /unsigned-plan is given.
; Embedded plans are as trustworthy as the file carrying them, so an
; unsigned one is used with a warning on the review page.
Function CheckPlan
  ibsig::check "$PlanFile" "${IB_PLAN_PUBKEY}"
  Pop $PlanSig
  ${Log} "Plan signature: $PlanSig (key ${IB_PLAN_KEYID})"
  StrCpy $PlanWarn ""
  StrCpy $0 $PlanSig 2
  ${If} $0 == "ok"
    StrCpy $PlanSrc "$PlanSrc; signed by the TiddlyInstall key ${IB_PLAN_KEYID}"
    Return
  ${EndIf}
  ${If} $PlanKind == "embedded"
    StrCpy $PlanWarn "The embedded plan isn't signed by the TiddlyInstall key ($PlanSig). It is only as trustworthy as this installer file."
    Return
  ${EndIf}
  ${If} $PlanKind == "cmdline"
  ${AndIf} $UnsignedOK = 1
    StrCpy $PlanWarn "The plan from the command line isn't signed ($PlanSig); /unsigned-plan was given."
    Return
  ${EndIf}
  ${If} $PlanKind == "cmdline"
    ${FailWith} "The plan $PlanFile isn't signed by the TiddlyInstall key ${IB_PLAN_KEYID} ($PlanSig). Use a plan saved from <backend>/api/plan/<record>, or add /unsigned-plan if you wrote it yourself."
  ${Else}
    ${FailWith} "The install plan from $Backend isn't signed by the TiddlyInstall key ${IB_PLAN_KEYID} ($PlanSig). It may have been changed on the way; nothing was installed."
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- stale plans (design.md 7.1)

!define IB_MAXAGE_DEFAULT_DAYS 90     ; the plan's `maxage` when it says nothing
!define IB_MAXAGE_LIMIT_DAYS 365      ; past this a carried plan is refused
!define IB_CLOCK_SPAN_DAYS 3653       ; ten years: past this the clock isn't believable

; A nonce for a plan request: 32 hex characters, echoed by the backend
; into the signed plan so that a plan signed for an earlier request can
; be told from the answer to this one. RtlGenRandom (advapi32, XP and
; later) where it works, mixed with the tick count, this file, the
; installer's own temporary folder and what is being asked for, and
; hashed: an XP-era machine's entropy can be poor, and it does not matter
; much, because the nonce only has to be unpredictable to someone who
; prepared a replay in advance.
Function MakeNonce            ; $U_a: what is being asked for -> $PlanNonce
  Push $0
  Push $1
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $PlanNonce ""
  StrCpy $1 ""
  System::Alloc 16
  Pop $R0
  ${If} $R0 <> 0
    System::Call 'advapi32::SystemFunction036(p R0, i 16) i .r0'
    ${If} $0 <> 0
      System::Call '*$R0(i .R1, i .R2, i .R3, i .R4)'
      IntFmt $R1 "%08x" $R1
      IntFmt $R2 "%08x" $R2
      IntFmt $R3 "%08x" $R3
      IntFmt $R4 "%08x" $R4
      StrCpy $1 "$R1$R2$R3$R4"
    ${Else}
      ${Log} "RtlGenRandom is not available here; the nonce comes from the clock and this process."
    ${EndIf}
    System::Free $R0
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i .r0'
  Delete "$PLUGINSDIR\nonce.txt"
  StrCpy $U_b "$1|$0|$EXEPATH|$PLUGINSDIR|$U_a"
  StrCpy $U_a "$PLUGINSDIR\nonce.txt"
  Call IbAppendUtf8
  StrCpy $U_a "$PLUGINSDIR\nonce.txt"
  Call Sha256File
  Delete "$PLUGINSDIR\nonce.txt"
  ${If} $U_out != ""
    StrCpy $PlanNonce $U_out 32
  ${EndIf}
  StrLen $0 $PlanNonce
  ${If} $0 <> 32
    StrCpy $PlanNonce ""
    ${Log} "No nonce could be made here; asking for the plan without one."
  ${EndIf}
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $1
  Pop $0
FunctionEnd

; The plan must be the answer to this request. A backend that echoes no
; nonce is simply an older backend: the plan is used, and the review page
; says an older plan replayed on the way could not be ruled out.
Function CheckNonce
  ${If} $PlanNonce == ""
  ${OrIf} $PlanKind != "fetched"
    Return
  ${EndIf}
  ${If} $PlanNonceGot == ""
    ${Log} "Nonce $PlanNonce sent; the plan carries none (an older backend)."
    StrCpy $PlanSrc "$PlanSrc; no nonce in the answer (an older backend), so an older plan replayed on the way can't be ruled out"
    Return
  ${EndIf}
  ${If} $PlanNonceGot S!= $PlanNonce
    ${FailWith} "The install plan from $Backend is the answer to another request (it carries nonce $PlanNonceGot, not the $PlanNonce this installer sent). It may be an older plan replayed on the way; nothing was installed."
    Return
  ${EndIf}
  ${Log} "Nonce $PlanNonce echoed in the plan."
  StrCpy $PlanSrc "$PlanSrc; nonce checked"
FunctionEnd

; Days since 1970-01-01 for the civil date $R1-$R2-$R3 -> $U_out (Howard
; Hinnant's days_from_civil). Whole days, so nothing here can overflow
; NSIS's 32-bit arithmetic the way seconds would in 2038.
Function CivilDays
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out ""
  ${If} $R1 < 1970
  ${OrIf} $R1 > 2200
  ${OrIf} $R2 < 1
  ${OrIf} $R2 > 12
  ${OrIf} $R3 < 1
  ${OrIf} $R3 > 31
    Goto cd_end
  ${EndIf}
  StrCpy $0 $R1                       ; yy
  ${If} $R2 <= 2
    IntOp $0 $0 - 1
  ${EndIf}
  IntOp $1 $0 / 400                   ; era
  IntOp $2 $1 * 400
  IntOp $2 $0 - $2                    ; yoe
  ${If} $R2 > 2
    IntOp $3 $R2 - 3
  ${Else}
    IntOp $3 $R2 + 9
  ${EndIf}
  IntOp $3 $3 * 153
  IntOp $3 $3 + 2
  IntOp $3 $3 / 5
  IntOp $3 $3 + $R3
  IntOp $3 $3 - 1                     ; doy
  IntOp $0 $2 * 365
  IntOp $3 $3 + $0
  IntOp $0 $2 / 4
  IntOp $3 $3 + $0
  IntOp $0 $2 / 100
  IntOp $3 $3 - $0                    ; doe
  IntOp $0 $1 * 146097
  IntOp $3 $3 + $0
  IntOp $U_out $3 - 719468
  cd_end:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; This machine's clock, in days since 1970 -> $U_out ("" if unreadable).
Function TodayDays
  Push $0
  Push $R1
  Push $R2
  Push $R3
  System::Call '*(&i2, &i2, &i2, &i2, &i2, &i2, &i2, &i2) p .r0'
  ${If} $0 = 0
    StrCpy $U_out ""
  ${Else}
    System::Call 'kernel32::GetSystemTime(p r0)'
    System::Call '*$0(&i2 .R1, &i2 .R2, &i2, &i2 .R3)'
    System::Free $0
    Call CivilDays
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $0
FunctionEnd

; An RFC 3339 UTC time (2026-09-20T11:02:07Z) in $U_a, as days since 1970
; -> $U_out ("" if it isn't one).
Function Rfc3339Days
  Push $0
  Push $1
  Push $R1
  Push $R2
  Push $R3
  StrCpy $1 $U_a
  StrCpy $U_out ""
  StrLen $0 $1
  ${If} $0 <> 20
    Goto rd_end
  ${EndIf}
  StrCpy $0 $1 1 10
  ${If} $0 S!= "T"
    Goto rd_end
  ${EndIf}
  StrCpy $R1 $1 4
  StrCpy $R2 $1 2 5
  StrCpy $R3 $1 2 8
  ; Digits only: IntOp would read "20x6" as 20.
  StrCpy $U_a "$R1$R2$R3"
  Call IbIsDigits
  StrCpy $U_a $1
  ${If} $U_out = 0
    StrCpy $U_out ""
    Goto rd_end
  ${EndIf}
  IntOp $R1 $R1 + 0
  IntOp $R2 $R2 + 0
  IntOp $R3 $R3 + 0
  Call CivilDays
  rd_end:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $1
  Pop $0
FunctionEnd

; $U_out = 1 if $U_a is one or more ASCII digits (IbIsB32's shape: a
; comparison per character, because NSIS's < and > are numeric).
Function IbIsDigits
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $U_out 0
  StrLen $4 $U_a
  ${If} $4 > 0
    StrCpy $U_out 1
    StrCpy $0 0
    ${Do}
      ${If} $0 >= $4
        ${Break}
      ${EndIf}
      StrCpy $1 $U_a 1 $0
      StrCpy $3 0
      ${Do}
        ${If} $3 >= 10
          StrCpy $U_out 0
          ${Break}
        ${EndIf}
        StrCpy $2 "0123456789" 1 $3
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
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; `signed` / `maxage` on a plan this installer carries (format.md section
; 3). A fetched plan was made this minute, so this is for embedded and
; /plan= plans only.
;
; The rule: **a wrong clock must never stop an install.** The build time
; baked into this base is a floor the machine's clock cannot move, and a
; clock outside [build time, build time + 10 years] is not believed -- the
; plan's age is then reported and nothing is refused.
Function CheckAge
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $AgeWarn ""
  ${If} $PlanSigned == ""
  ${OrIf} $PlanKind == "fetched"
    Goto ca_end
  ${EndIf}
  StrCpy $U_a $PlanSigned
  Call Rfc3339Days
  StrCpy $1 $U_out                    ; the day the plan was signed
  ${If} $1 == ""
    ${Log} "Plan signed '$PlanSigned': not a time this installer reads; age not checked."
    Goto ca_end
  ${EndIf}
  Call TodayDays
  StrCpy $2 $U_out                    ; today, by this machine
  StrCpy $3 ${IB_MAXAGE_DEFAULT_DAYS}
  ${If} $PlanMaxAge != ""
    StrCpy $U_a $PlanMaxAge
    Call IbIsDigits
    ${If} $U_out = 1
      IntOp $3 $PlanMaxAge / 86400
    ${EndIf}
  ${EndIf}
  ${If} $3 > ${IB_MAXAGE_LIMIT_DAYS}
    StrCpy $3 ${IB_MAXAGE_LIMIT_DAYS}
  ${EndIf}
  ; Is the clock believable at all?
  StrCpy $0 0
  ${If} $2 != ""
  ${AndIf} ${IB_BUILD_DAYS} > 0
  ${AndIf} $2 >= ${IB_BUILD_DAYS}
    IntOp $0 $2 - ${IB_BUILD_DAYS}
    ${If} $0 <= ${IB_CLOCK_SPAN_DAYS}
    ${AndIf} $2 >= $1
      StrCpy $0 1
    ${Else}
      StrCpy $0 0
    ${EndIf}
  ${EndIf}
  ${If} $0 <> 1
    Call NowText
    StrCpy $AgeWarn "This installer's plan was signed on $PlanSigned, and this machine's clock says $U_out, which can't be right (this installer was built ${IB_BUILD_TIME}), so how old the plan is can't be told. Nothing is refused for age."
    ${Log} "Clock not plausible; the plan's age is reported only."
    Goto ca_end
  ${EndIf}
  IntOp $0 $2 - $1                    ; age in days
  ${Log} "Plan signed $PlanSigned, $0 days ago; maxage $3 days."
  ${If} $0 <= $3
    Goto ca_end
  ${EndIf}
  ${If} $0 > ${IB_MAXAGE_LIMIT_DAYS}
    ${FailWith} "This installer's plan was signed on $PlanSigned, $0 days ago, past the ${IB_MAXAGE_LIMIT_DAYS}-day limit. What it installs may since have been withdrawn or found unsafe. Get a current installer from $Backend and run that instead; nothing was installed."
    Goto ca_end
  ${EndIf}
  StrCpy $AgeWarn "This installer's plan was signed on $PlanSigned, $0 days ago (it is meant to be used within $3 days). What it installs may have moved on. A current installer is at $Backend."
  ca_end:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; This machine's clock as text, for messages -> $U_out.
Function NowText
  Push $0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  System::Call '*(&i2, &i2, &i2, &i2, &i2, &i2, &i2, &i2) p .r0'
  ${If} $0 = 0
    StrCpy $U_out "(unreadable)"
  ${Else}
    System::Call 'kernel32::GetSystemTime(p r0)'
    System::Call '*$0(&i2 .R1, &i2 .R2, &i2, &i2 .R3, &i2 .R4, &i2 .R5)'
    System::Free $0
    StrCpy $U_out "$R1-$R2-$R3 $R4:$R5 UTC"
  ${EndIf}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $0
FunctionEnd

; ---- the signed revocation list (format.md section 7)

; Is $U_a one of the SHA-256s this install would download? -> $U_out
Function ShaListed
  Push $0
  Push $1
  StrCpy $U_out 0
  ${IfNot} ${FileExists} "$ShaList"
    Goto sl_end
  ${EndIf}
  FileOpen $0 "$ShaList" r
  ${If} $0 == ""
    Goto sl_end
  ${EndIf}
  ${Do}
    FileRead $0 $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ${If} $1 != ""
      StrCpy $1 $1 64
      ${If} $1 S== $U_a
        StrCpy $U_out 1
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $0
  sl_end:
  Pop $1
  Pop $0
FunctionEnd

; The value of header key $U_b in the UTF-16 document $U_a -> $U_out.
Function DocValue
  Push $0
  StrCpy $U_out ""
  FileOpen $0 $U_a r
  ${If} $0 == ""
    Pop $0
    Return
  ${EndIf}
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== $U_b
      StrCpy $U_out $F1
      ${Break}
    ${EndIf}
  ${Loop}
  FileClose $0
  Pop $0
FunctionEnd

; The `serial` of the UTF-16 revocation list $U_a -> $U_out (0 if none).
Function DocSerial
  Push $0
  StrCpy $U_b "serial"
  Call DocValue
  StrCpy $0 $U_out
  StrCpy $U_a $0
  Call IbIsDigits
  ${If} $U_out = 1
    StrCpy $U_out $0
  ${Else}
    StrCpy $U_out 0
  ${EndIf}
  Pop $0
FunctionEnd

; Fetch, check and apply the revocation list for a plan this installer
; carries. Mode A and fetched plans don't: their fetch is already the
; check (the backend answers 451 for anything on the list), and a request
; that can be dropped is worse than one that cannot (design.md 7).
Function Revocations
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $RevokeNote ""
  ${If} $PlanKind == "fetched"
  ${OrIf} $ModeA = 1
    Goto rv_end
  ${EndIf}
  StrCpy $2 ""                        ; the UTF-16 list to use
  StrCpy $3 "$LOCALAPPDATA\TiddlyInstall\revocations.txt"
  StrCpy $U_a "$Backend/api/revocations"
  StrCpy $U_b "$PLUGINSDIR\revocations.txt"
  ${Log} "Fetching the revocation list: $U_a"
  Call DownloadOptional
  ${If} $U_out == "OK"
    ibsig::checkdoc "$PLUGINSDIR\revocations.txt" "${IB_PLAN_PUBKEY}" "ib-revocations"
    Pop $0
    StrCpy $1 $0 2
    ${If} $1 == "ok"
      StrCpy $U_a "$PLUGINSDIR\revocations.txt"
      StrCpy $U_b "$PLUGINSDIR\revocations.u16"
      Call IbUtf8ToUtf16
      StrCpy $2 "$PLUGINSDIR\revocations.u16"
    ${Else}
      ${Log} "Revocation list from $Backend: $0"
    ${EndIf}
  ${Else}
    ${Log} "Couldn't fetch $Backend/api/revocations ($U_out)."
  ${EndIf}
  ; The last good list this machine saw. A list can only ever deny an
  ; install, so the freshest one is used even when `expires` has passed:
  ; refusing something later un-revoked is the recoverable mistake.
  ${If} ${FileExists} "$3"
    StrCpy $U_a "$3"
    StrCpy $U_b "$PLUGINSDIR\revocations-cache.u16"
    Call IbUtf8ToUtf16
    ${If} $2 == ""
      StrCpy $2 "$PLUGINSDIR\revocations-cache.u16"
      StrCpy $U_a "$2"
      StrCpy $U_b "issued"
      Call DocValue
      StrCpy $RevokeNote "the backend couldn't be reached; the last list this machine saw (issued $U_out) was used"
    ${Else}
      StrCpy $U_a "$PLUGINSDIR\revocations-cache.u16"
      Call DocSerial
      StrCpy $0 $U_out
      StrCpy $U_a "$2"
      Call DocSerial
      ${If} $0 > $U_out
        StrCpy $2 "$PLUGINSDIR\revocations-cache.u16"
        ${Log} "The cached revocation list is newer than the one fetched; using it."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $2 == ""
    StrCpy $RevokeNote "no revocation list could be fetched or found on this machine, so only the plan's own age was checked"
    Goto rv_end
  ${EndIf}
  ${If} $2 == "$PLUGINSDIR\revocations.u16"
    ; CopyFiles wants a folder as its destination, and makes the file
    ; inside it: $3 is that folder's revocations.txt.
    CreateDirectory "$LOCALAPPDATA\TiddlyInstall"
    CopyFiles /SILENT "$PLUGINSDIR\revocations.txt" "$LOCALAPPDATA\TiddlyInstall"
  ${EndIf}
  StrCpy $U_a $2
  Call RevokeScan
  ${If} $Failed = 1
    Goto rv_end
  ${EndIf}
  ${If} $RevokeNote == ""
    StrCpy $U_a $2
    StrCpy $U_b "issued"
    Call DocValue
    StrCpy $RevokeNote "checked against the list issued $U_out"
  ${EndIf}
  ${Log} "Revocation list: $RevokeNote"
  rv_end:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Every `revoke` line of the UTF-16 list $U_a against this install. A kind
; this engine doesn't know is ignored, like any unknown key.
Function RevokeScan
  Push $0
  Push $1
  FileOpen $0 $U_a r
  ${If} $0 == ""
    Pop $1
    Pop $0
    Return
  ${EndIf}
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S!= "revoke"
      ${Continue}
    ${EndIf}
    StrCpy $1 ""
    ${If} $F1 S== "record"
      ${If} $RecHash != ""
      ${AndIf} $F2 S== $RecHash
        StrCpy $1 "record $F2"
      ${EndIf}
    ${ElseIf} $F1 S== "source"
      ${If} $RecSrcKey != ""
      ${AndIf} "$F2 $F3" S== $RecSrcKey
        StrCpy $1 "source $F2 $F3"
      ${EndIf}
    ${ElseIf} $F1 S== "name"
      ${If} $TokRuntime != ""
      ${AndIf} "$F2 $F3" S== "$TokRuntime $TokProject"
        StrCpy $1 "name $F2 $F3"
      ${EndIf}
    ${ElseIf} $F1 S== "sha"
    ${OrIf} $F1 S== "file"
      StrCpy $U_a $F2
      Call ShaListed
      ${If} $U_out = 1
        StrCpy $1 "$F1 $F2"
      ${EndIf}
    ${EndIf}
    ${If} $1 != ""
      FileClose $0
      ${FailWith} "This install has been withdrawn: the revocation list at $Backend names $1. Nothing was installed."
      Pop $1
      Pop $0
      Return
    ${EndIf}
  ${Loop}
  FileClose $0
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- prerequisites

; System-wide prerequisites (format.md "Prerequisites"): each `need` in the
; chosen block, with its ncheck lines (any one passing means present) and,
; to install it, nfile/nurl (an installer, checked by SHA-256) and nrun
; (run with administrator rights; exit codes in nok mean success).

; One check, $F1 kind and $F2.. its fields -> $U_out 1 if it passes.
; Unknown kinds never pass.
Function NeedCheckOne
  Push $R0
  Push $R1
  Push $R2
  StrCpy $U_out 0
  ${If} $F1 S== "reg"
    ; reg <32|64> <HKLM\key|HKCU\key> <DWORD value> [minimum]
    StrCpy $R0 $F3 5
    StrCpy $R1 $F3 "" 5
    ${If} $F2 == "64"
      ${IfNot} ${RunningX64}
        Goto nc_end                    ; 32-bit Windows has no 64-bit view
      ${EndIf}
      SetRegView 64
    ${Else}
      SetRegView 32
    ${EndIf}
    ClearErrors
    ${If} $R0 == "HKLM\"
      ReadRegDWORD $R2 HKLM "$R1" "$F4"
    ${ElseIf} $R0 == "HKCU\"
      ReadRegDWORD $R2 HKCU "$R1" "$F4"
    ${Else}
      SetErrors
    ${EndIf}
    ${IfNot} ${Errors}
      ${If} $F5 == ""
        StrCpy $U_out 1
      ${ElseIf} $R2 >= $F5
        StrCpy $U_out 1
      ${EndIf}
    ${EndIf}
    SetRegView default
    ${Log} "  check $F1 $F2 $F3 $F4 >= $F5: $U_out (read '$R2')"
  ${ElseIf} $F1 S== "file"
    ; file <path>, %VARIABLES% expanded; System32 is the native one
    ExpandEnvStrings $R0 "$F2"
    ${DisableX64FSRedirection}
    ${If} ${FileExists} "$R0"
      StrCpy $U_out 1
    ${EndIf}
    ${EnableX64FSRedirection}
    ${Log} "  check file $R0: $U_out"
  ${Else}
    ${Log} "  check $F1: not a check this installer knows; counts as missing"
  ${EndIf}
  nc_end:
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; Close one need in NeedChecks: $0 its state ("" none, "0", "1"), $1 1 if it
; has nrun, $2 its label, $3 its nhow.
!macro NeedFinish
  ${If} $0 != ""
    StrCpy $NdSat "$NdSat$0"
    ${If} $0 == "0"
      IntOp $NdMissing $NdMissing + 1
      ${If} $NdLabels == ""
        StrCpy $NdLabels "$2"
        StrCpy $NdHow "$3"
      ${Else}
        StrCpy $NdLabels "$NdLabels, $2"
      ${EndIf}
      ${If} $1 = 0
        IntOp $NdManual $NdManual + 1
        ${If} $NdManualMsg == ""
          StrCpy $NdManualMsg "This app needs $2 first, and this installer can't install it. $3"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Check every need of the chosen block: $NdCount, $NdSat, $NdMissing,
; $NdManual, $NdLabels, $NdHow, $NdManualMsg.
Function NeedChecks
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $NdCount 0
  StrCpy $NdSat ""
  StrCpy $NdMissing 0
  StrCpy $NdManual 0
  StrCpy $NdLabels ""
  StrCpy $NdHow ""
  StrCpy $NdManualMsg ""
  StrCpy $0 ""
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "need"
      !insertmacro NeedFinish
      IntOp $NdCount $NdCount + 1
      StrCpy $0 "0"
      StrCpy $1 0
      StrCpy $2 "$F2"
      StrCpy $3 ""
      ${Log} "Prerequisite $F1 ($F2):"
    ${ElseIf} $0 == ""
      ${Continue}
    ${ElseIf} $K S== "ncheck"
      ${If} $0 == "0"
        Call NeedCheckOne
        ${If} $U_out = 1
          StrCpy $0 "1"
        ${EndIf}
      ${EndIf}
    ${ElseIf} $K S== "nrun"
      StrCpy $1 1
    ${ElseIf} $K S== "nhow"
      StrCpy $3 "$F1"
    ${ElseIf} $K S== "file"
      !insertmacro NeedFinish
      StrCpy $0 ""
    ${EndIf}
  ${Loop}
  FileClose $BH
  !insertmacro NeedFinish
  ${If} $NdCount > 0
    ${Log} "Prerequisites: $NdCount, missing $NdMissing ($NdSat)"
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The review page's part (WriteSummary has $SumH open).
Function NeedSummary
  Push $0
  Push $1
  Push $2
  ${Sum} "System-wide prerequisites (checked on this computer; installed for every user and not removed by the uninstaller):"
  StrCpy $0 -1         ; need index
  StrCpy $1 ""         ; this need's state
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
    ${OrIf} $K S== "file"
      ${Break}
    ${ElseIf} $K S== "need"
      IntOp $0 $0 + 1
      StrCpy $1 $NdSat 1 $0
      ${If} $1 == "1"
        ${Sum} "  $F2:  already installed"
      ${Else}
        ${Sum} "  $F2:  MISSING, will be installed (needs administrator rights)"
      ${EndIf}
    ${ElseIf} $K S== "nwhy"
      ${Sum} "      why: $F1"
    ${ElseIf} $1 != "0"
      ${Continue}
    ${ElseIf} $K S== "nfile"
      ${Sum} "      $F1   ($F3 bytes)"
      ${Sum} "      sha256 $F2"
      StrCpy $2 "$DlDir\$F1"
    ${ElseIf} $K S== "nurl"
      ${Sum} "      from $F1"
    ${ElseIf} $K S== "nrun"
      StrCpy $CurFile $2
      StrCpy $U_a $F1
      Call Subst
      StrCpy $CurFile ""
      ${Sum} "      then runs: $U_out"
    ${EndIf}
  ${Loop}
  FileClose $BH
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Install the missing prerequisites (we have administrator rights here),
; then check again. Sets $Failed.
Function NeedInstall
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $R8
  Push $R9
  ${If} $NdMissing = 0
    Goto ni_end
  ${EndIf}
  StrCpy $0 -1         ; need index
  StrCpy $1 ""         ; state of the current need
  StrCpy $2 0          ; nfile line
  StrCpy $3 ""         ; nrun command
  StrCpy $4 "0"        ; nok codes
  StrCpy $5 ""         ; label
  Call OpenBlock
  StrCpy $6 $TgtLine   ; line number, for FetchFile
  ; each need is acted on when the next entry (or the end) is reached
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      StrCpy $K "[end]"
    ${Else}
      IntOp $6 $6 + 1
      Call IbParseLine
    ${EndIf}
    ${If} $K S== "need"
    ${OrIf} $K S== "file"
    ${OrIf} $K S== "[target]"
    ${OrIf} $K S== "[end]"
      ${If} $1 == "0"
        ; install the one just read (FetchFile reads the plan with its own handle)
        ${Log} "Installing $5"
        StrCpy $CurFile ""
        ${If} $2 > 0
          StrCpy $FF_line $2
          StrCpy $FF_sha $R8
          StrCpy $FF_name $R9
          StrCpy $FF_ukey "nurl"
          Call FetchFile
          StrCpy $FF_ukey "url"
          ${If} $Failed = 1
            ${Break}
          ${EndIf}
          StrCpy $CurFile $FF_path
        ${EndIf}
        StrCpy $U_a $3
        Call Subst
        StrCpy $RC_cmd $U_out
        StrCpy $RC_cwd ""
        StrCpy $RC_quiet 0
        Call RunCmd
        ${If} $CurFile != ""
          Delete "$CurFile"
        ${EndIf}
        StrCpy $CurFile ""
        StrCpy $U_a " $4 "
        StrCpy $U_b " $RC_code "
        Call IbContains
        ${If} $U_out = 0
          ${FailWith} "Installing $5 failed (exit code $RC_code). $NdHow"
          ${Break}
        ${EndIf}
        ${If} $RC_code = 3010
          ${Log} "$5 is installed; Windows wants a restart to finish (the app may work before that)"
        ${EndIf}
      ${EndIf}
      StrCpy $1 ""
      ${If} $K S== "need"
        IntOp $0 $0 + 1
        StrCpy $1 $NdSat 1 $0
        StrCpy $2 0
        StrCpy $3 ""
        StrCpy $4 "0"
        StrCpy $5 "$F2"
      ${ElseIf} $K S!= "file"
        ${Break}
      ${EndIf}
    ${ElseIf} $1 != "0"
      ${Continue}
    ${ElseIf} $K S== "nfile"
      StrCpy $2 $6
      StrCpy $R9 $F1
      StrCpy $R8 $F2
    ${ElseIf} $K S== "nrun"
      StrCpy $3 $F1
    ${ElseIf} $K S== "nok"
      StrCpy $4 $F1
    ${EndIf}
  ${Loop}
  FileClose $BH
  ${If} $Failed = 1
    Goto ni_end
  ${EndIf}
  ; installed: every check must pass now
  StrCpy $0 $NdLabels
  Call NeedChecks
  ${If} $NdMissing > 0
    ${FailWith} "$NdLabels is still missing after running its installer. $NdHow"
  ${Else}
    ${Log} "Prerequisites installed: $0"
  ${EndIf}
  ni_end:
  Pop $R9
  Pop $R8
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- init

; /? or /help: the command line, then quit.
Function Usage
  MessageBox MB_OK|MB_ICONINFORMATION "TiddlyInstall ${IB_VERSION}$\r$\n$\r$\n\
/S$\tinstall without asking (exit code 0 installed, 2 couldn't start, 3 failed)$\r$\n\
/log=PATH$\tappend a detailed log to PATH$\r$\n\
/record=PATH$\tuse this ib-record file$\r$\n\
/plan=PATH$\tuse this ib-plan file; it must be signed by the TiddlyInstall key$\r$\n\
/unsigned-plan$\taccept an unsigned /plan= file$\r$\n\
/backend=URL$\twhere to fetch records and plans$\r$\n\
/reinstall$\tinstall again even if this app, with these same settings, is already installed. Otherwise running the installer again starts the app (with /S it only says it is installed)$\r$\n$\r$\n\
A signed installer with no settings of its own takes none of /record=, /plan=, /unsigned-plan and /backend=." /SD IDOK
  SetErrorLevel 0
  Quit
FunctionEnd

; Is this app fully installed in $AppDir with this record? $U_out = 1 if
; its .ib-installed marker (written last by a finished install, format.md
; section 5) names this appid and record, and its .ib-owner this appid.
Function IsInstalled
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  ${If} $RecHash == ""
    Goto ii_end
  ${EndIf}
  ${IfNot} ${FileExists} "$AppDir\.ib-installed"
  ${OrIfNot} ${FileExists} "$AppDir\launch.exe"
  ${OrIfNot} ${FileExists} "$AppDir\launch.txt"
    Goto ii_end
  ${EndIf}
  StrCpy $U_a $AppDir
  Call IbOwnerOf
  ${If} $U_out S!= $AppId
    Goto ii_end
  ${EndIf}
  ClearErrors
  FileOpen $0 "$AppDir\.ib-installed" r
  ${If} ${Errors}
    Goto ii_end
  ${EndIf}
  FileRead $0 $1
  ${IbTrimNL} $1
  ${If} $1 S== "ib-installed$\t1"
    ${Do}
      ClearErrors
      FileRead $0 $1
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${IbTrimNL} $1
      ${If} $1 S== "appid$\t$AppId"
        IntOp $2 $2 | 1
      ${ElseIf} $1 S== "record$\t$RecHash"
        IntOp $2 $2 | 2
      ${EndIf}
    ${Loop}
  ${EndIf}
  FileClose $0
  ii_end:
  ${If} $2 = 3
    StrCpy $U_out 1
  ${Else}
    StrCpy $U_out 0
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The app is fully installed in $AppDir: with /S say so and exit 0, else
; start it through its launcher and quit.
Function InstalledNow
  ${If} ${Silent}
    ${Log} "$AppName is already installed in $AppDir (record $RecHash); nothing was changed. Add /reinstall to install it again."
    SetErrorLevel 0
    Quit
  ${EndIf}
  ${Log} "$AppName is already installed in $AppDir (record $RecHash); starting it with $AppDir\launch.exe"
  ClearErrors
  Exec '"$AppDir\launch.exe"'
  ${If} ${Errors}
    ${FailWith} "$AppName is installed in $AppDir, but its launcher couldn't be started. Run this installer with /reinstall to install it again."
    Call InitFail
  ${EndIf}
  SetErrorLevel 0
  Quit
FunctionEnd

; The install root for root mode $U_a (user, system) and folder name $U_b
; -> $U_out (plan.md 1.6).
Function RootFor
  ${If} $U_a == "system"
  ${OrIf} $WinVer < 600
    StrCpy $U_out "$SysDrv\$U_b"
  ${Else}
    StrCpy $U_out "$LOCALAPPDATA\$U_b"
  ${EndIf}
FunctionEnd

; Is the app of record hash $RecHash fully installed, found before any
; network access? The appid is derived from the record hash alone (the
; resolver writes appid = base32(sha256(<record hash> "/app"))[:12]), so
; with an embedded, given or install.txt record, or the hash in a mode A
; file name, .ib-installed can be checked offline. Looks where the record's
; root and rootname say ($RecRoot, $RecRootName), or with no record read
; yet, in the default folders for one user and for all users. Starts the
; app (or with /S reports it) and quits if so; otherwise returns.
Function OfflineInstalled
  Push $0
  Push $1
  ${If} $Reinstall = 1
    Goto oi_end
  ${EndIf}
  StrCpy $U_a $RecHash
  StrCpy $U_b 26
  Call IbIsB32
  ${If} $U_out = 0
    Goto oi_end
  ${EndIf}
  Delete "$PLUGINSDIR\ah.txt"
  StrCpy $U_a "$PLUGINSDIR\ah.txt"
  StrCpy $U_b "$RecHash/app"
  Call IbAppendUtf8
  StrCpy $U_a "$PLUGINSDIR\ah.txt"
  Call Sha256File
  ${If} $U_out == ""
    Goto oi_end
  ${EndIf}
  StrCpy $U_a $U_out
  StrCpy $U_b 12
  Call IbHexToB32
  StrCpy $AppId $U_out
  StrCpy $1 0                           ; which root is being tried
  ${Do}
    IntOp $1 $1 + 1
    ${If} $RecFile != ""
      ${If} $1 > 1
        ${Break}
      ${EndIf}
      StrCpy $U_a $RecRoot
      StrCpy $U_b $RecRootName
      ${If} $U_b == ""
        StrCpy $U_b "ib"
      ${EndIf}
      StrCpy $0 $U_b
      StrCpy $U_a $0
      Call IsPlainName                  ; (uses $U_a and $U_b)
      ${If} $U_out = 0
        ${Break}
      ${EndIf}
      StrCpy $U_a $RecRoot
      StrCpy $U_b $0
    ${ElseIf} $1 = 1
      StrCpy $U_a "user"
      StrCpy $U_b "ib"
    ${ElseIf} $1 = 2
      StrCpy $U_a "system"
      StrCpy $U_b "ib"
    ${Else}
      ${Break}
    ${EndIf}
    Call RootFor
    StrCpy $AppDir "$U_out\$AppId"
    Call IsInstalled
    ${If} $U_out = 1
      StrCpy $AppName $AppId
      ClearErrors
      FileOpen $0 "$AppDir\manifest.txt" r
      ${IfNot} ${Errors}
        ${Do}
          ClearErrors
          FileRead $0 $U_b
          ${If} ${Errors}
            ${Break}
          ${EndIf}
          ${IbTrimNL} $U_b
          StrCpy $U_a $U_b 5
          ${If} $U_a S== "name$\t"
            StrCpy $AppName $U_b "" 5
            ${Break}
          ${EndIf}
        ${Loop}
        FileClose $0
      ${EndIf}
      ibsig::cleanstr "$AppName"
      Pop $AppName
      ${Log} "Found $AppName fully installed in $AppDir (record $RecHash, appid from the record hash); nothing fetched."
      Call InstalledNow
    ${EndIf}
  ${Loop}
  StrCpy $AppId ""
  StrCpy $AppDir ""
  StrCpy $AppName ""
  oi_end:
  Pop $1
  Pop $0
FunctionEnd

Function InitFail
  ${Log} "ERROR: $FailMsg"
  ibsig::cleanstr "$FailMsg"
  Pop $FailMsg
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "$FailMsg"
  ${EndIf}
  SetErrorLevel 2
  Quit
FunctionEnd

Function .onInit
  InitPluginsDir
  StrCpy $Failed 0
  StrCpy $NdFail 0
  StrCpy $FF_ukey "url"
  ${GetParameters} $Params
  ClearErrors
  ${IbGetOpt} "/log=" $LogPath
  ${If} ${Errors}
    StrCpy $LogPath ""
  ${EndIf}
  ClearErrors
  ${IbGetOpt} "/ib-elevated" $0
  ${If} ${Errors}
    StrCpy $Elevated 0
  ${Else}
    StrCpy $Elevated 1
  ${EndIf}
  ${Log} "TiddlyInstall ${IB_VERSION}: $EXEPATH $Params"
  ClearErrors
  ${IbGetOpt} "/?" $0
  ${IfNot} ${Errors}
    Call Usage
  ${EndIf}
  ClearErrors
  ${IbGetOpt} "/help" $0
  ${IfNot} ${Errors}
    Call Usage
  ${EndIf}
  ClearErrors
  ${IbGetOpt} "/reinstall" $0
  ${If} ${Errors}
    StrCpy $Reinstall 0
  ${Else}
    StrCpy $Reinstall 1
  ${EndIf}

  ; the machine
  ${WinVerGetMajor} $0
  ${WinVerGetMinor} $1
  ${WinVerGetBuild} $WinBuild
  IntOp $WinVer $0 * 100
  IntOp $WinVer $WinVer + $1
  ${If} ${IsNativeARM64}
    StrCpy $Arch "arm64"
  ${ElseIf} ${RunningX64}
    StrCpy $Arch "amd64"
  ${Else}
    StrCpy $Arch "x86"
  ${EndIf}
  StrCpy $SysDrv $WINDIR 2
  ${Log} "Windows $WinVer build $WinBuild, $Arch"

  ClearErrors
  ${IbGetOpt} "/unsigned-plan" $0
  ${If} ${Errors}
    StrCpy $UnsignedOK 0
  ${Else}
    StrCpy $UnsignedOK 1
  ${EndIf}
  StrCpy $PlanRec ""
  StrCpy $PlanReq ""
  StrCpy $PlanReqWant ""
  StrCpy $PlanNonce ""
  StrCpy $PlanNonceGot ""
  StrCpy $PlanSigned ""
  StrCpy $PlanMaxAge ""
  StrCpy $AgeWarn ""
  StrCpy $RevokeNote ""
  StrCpy $ShaList "$PLUGINSDIR\shas.txt"

  StrCpy $Backend "${IB_BACKEND}"
  ClearErrors
  ${IbGetOpt} "/backend=" $OptBackend
  ${If} ${Errors}
    StrCpy $OptBackend ""
  ${Else}
    StrCpy $Backend $OptBackend
  ${EndIf}

  ; record and plan
  Call FindMetadata
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ${If} $RecFile != ""
    Call ReadRecord
    ${If} $Failed = 1
      Call InitFail
    ${EndIf}
    ${If} $RecHash == ""
      StrCpy $U_a $RecFile
      Call RecordHashOf
      StrCpy $RecHash $U_out
    ${EndIf}
    ; installed already? checked before the plan is fetched
    Call OfflineInstalled
  ${EndIf}
  ${If} $PlanFile == ""
    StrCpy $U_a $RecHash
    Call MakeNonce
    StrCpy $U_a "$Backend/api/plan/$RecHash"
    ${If} $PlanNonce != ""
      StrCpy $U_a "$U_a?nonce=$PlanNonce"
    ${EndIf}
    StrCpy $U_b "$PLUGINSDIR\plan.txt"
    ${Log} "Fetching the plan: $U_a"
    Call DownloadQuiet
    ${If} $U_out != "OK"
      Call TakenDownHint
      ${FailWith} "Couldn't fetch the install plan from $Backend/api/plan/$RecHash ($U_out).$U_c Check the internet connection and try again."
      Call InitFail
    ${EndIf}
    StrCpy $PlanFile "$PLUGINSDIR\plan.txt"
    StrCpy $PlanKind "fetched"
    StrCpy $PlanSrc "fetched from $Backend/api/plan/$RecHash"
    StrCpy $0 $Backend 5
    ${If} $0 == "http:"
      StrCpy $PlanSrc "$PlanSrc over plain HTTP"
    ${EndIf}
  ${EndIf}
  ${IfNot} ${FileExists} "$PlanFile"
    ${FailWith} "Can't read the plan $PlanFile."
    Call InitFail
  ${EndIf}
  Call CheckPlan
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  Call ReadPlan
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ; the plan must be for this record (format.md "Plan signature"): a signed plan for
  ; another app can't be replayed
  ${If} $RecHash != ""
    ${If} $PlanRec S!= $RecHash
      ${If} $PlanRec == ""
        StrCpy $PlanRec "none"
      ${EndIf}
      ${FailWith} "The install plan is for record $PlanRec, but this installer's record is $RecHash. Nothing was installed."
      Call InitFail
    ${EndIf}
  ${Else}
    StrCpy $RecHash $PlanRec
  ${EndIf}
  ; a plan by name has no record to check against; it says (signed)
  ; which name it answers
  ${If} $PlanReqWant != ""
  ${AndIf} $PlanReq S!= $PlanReqWant
    ${FailWith} "The plan from $Backend is not the answer for $TokRuntime/$TokProject. Nothing was installed."
    Call InitFail
  ${EndIf}
  ; ...and, for a fetched plan, the answer to *this* request rather than a
  ; replay of an older one (design.md 7.1)
  Call CheckNonce
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ibsig::cleanstr "$AppName"
  Pop $AppName

  ; validate the header
  StrCpy $U_a $AppId
  StrCpy $U_b 12
  Call IbIsB32
  ${If} $U_out = 0
    ${FailWith} "The plan's appid '$AppId' isn't 12 base32 characters."
    Call InitFail
  ${EndIf}
  StrCpy $U_a $RootName
  Call IsPlainName
  ${If} $U_out = 0
    ${FailWith} "The plan's rootname '$RootName' isn't a plain folder name."
    Call InitFail
  ${EndIf}
  ${If} $AppName == ""
    StrCpy $AppName $Project
  ${EndIf}
  StrCpy $U_a $AppName
  Call SafeFileName
  StrCpy $SafeName $U_out
  ${If} $SrcLine > 0
    StrCpy $U_a $SrcName
    Call IsPlainName
    ${If} $U_out = 0
      ${FailWith} "The plan's source file name '$SrcName' isn't a plain file name."
      Call InitFail
    ${EndIf}
  ${EndIf}
  ${If} $TgtLine = 0
    ${FailWith} "This app has no install plan for this version of Windows ($WinVer build $WinBuild, $Arch)."
    Call InitFail
  ${EndIf}

  ; where it goes (plan.md 1.6)
  StrCpy $NeedAdmin 0
  ${If} $RootMode == "system"
    StrCpy $Root "$SysDrv\$RootName"
    StrCpy $NeedAdmin 1
  ${ElseIf} $WinVer < 600
    StrCpy $Root "$SysDrv\$RootName"   ; XP: keep paths short
  ${Else}
    StrCpy $Root "$LOCALAPPDATA\$RootName"
  ${EndIf}
  StrCpy $AppDir "$Root\$AppId"
  StrCpy $DataDir "$AppDir\data"
  StrCpy $TmpDir "$PLUGINSDIR\t"
  StrCpy $DlDir "$PLUGINSDIR\dl"
  StrCpy $INSTDIR $AppDir

  ; Already installed here, with this same record (the same settings)? Only
  ; the marker a finished install writes last counts. Then start the app
  ; through its launcher instead of installing again; a silent install
  ; (/S) never starts it, it only says so and exits 0.
  ; (The fallback for plans by name, whose record hash only the server
  ; knows; the others were checked before anything was fetched.)
  ${If} $Reinstall = 0
    Call IsInstalled
    ${If} $U_out = 1
      Call InstalledNow
    ${EndIf}
  ${EndIf}

  Call ReadTarget
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ${Log} "Plan block $TgtNo matches."
  ; A plan carried in this installer may name something since withdrawn,
  ; or simply be old: the revocation list answers that where there is a
  ; network, and the plan's own `signed`/`maxage` where there is not.
  ; Both run before anything on this machine is changed.
  Call Revocations
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  Call CheckAge
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ${If} $TgtFail != ""
    ${FailWith} "$TgtFail"
    Call InitFail
  ${EndIf}
  ${If} $TgtAdmin == "1"
    StrCpy $NeedAdmin 1
  ${EndIf}

  ; system-wide prerequisites: the checks only read the registry and look
  ; for files, so they run now; a missing one means administrator rights
  Call NeedChecks
  ${If} $NdManual > 0
    ${FailWith} "$NdManualMsg"
    Call InitFail
  ${EndIf}
  ${If} $NdMissing > 0
    StrCpy $NeedAdmin 1
  ${EndIf}

  ; administrator rights, if the plan needs them
  Call IbIsAdmin
  ${If} $NeedAdmin = 1
  ${AndIf} $U_out = 0
  ${AndIf} $NdMissing > 0
  ${AndIf} ${Silent}
    ; no UAC prompt in a silent install
    ${FailWith} "This app needs $NdLabels installed first, for the whole computer, which needs administrator rights, and this silent install (/S) doesn't have them. Run it from an elevated command prompt, or install that first. $NdHow"
    Call InitFail
  ${EndIf}
  ${If} $NeedAdmin = 1
  ${AndIf} $U_out = 0
    ${If} $WinVer < 600
    ${OrIf} $Elevated = 1
      ${FailWith} "This install needs administrator rights. Run the installer as an administrator."
      Call InitFail
    ${EndIf}
    ${Log} "Administrator rights needed; starting again elevated."
    StrCpy $U_a "$Params /ib-elevated"
    Call IbRunElevated
    ${If} $U_out == "error"
      ${FailWith} "This install needs administrator rights, and Windows didn't grant them."
      Call InitFail
    ${EndIf}
    SetErrorLevel $U_out
    Quit
  ${EndIf}

  Call WriteSummary
FunctionEnd

; The transparency text (design.md section 3), one line per row.
Function WriteSummary
  Push $0
  Push $1
  FileOpen $SumH "$PLUGINSDIR\summary.txt" w
  FileWriteWord $SumH 0xFEFF
  ${Sum} "App:  $AppName   (install id $AppId)"
  ${If} $RecSource != ""
    ${Sum} "Source:  $RecSource"
  ${EndIf}
  ${If} $Project != ""
    ${Sum} "Project / package:  $Project"
  ${EndIf}
  ${If} $TgtRuntime != ""
    ${If} $TgtRtArch == ""
      ${Sum} "Runtime:  $TgtRuntime"
    ${Else}
      Call ArchWords
      StrCpy $0 $U_out
      Call ArchNote
      ${Sum} "Runtime:  $TgtRuntime, $0$U_out"
    ${EndIf}
  ${EndIf}
  ${Sum} "This machine:  Windows $WinVer build $WinBuild, $Arch (plan block $TgtNo)"
  ${Sum} ""
  ${If} $NdCount > 0
    Call NeedSummary
    ${Sum} ""
  ${EndIf}
  ${Sum} "Files to download (each is checked by SHA-256 before use):"
  StrCpy $1 ""
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      StrCpy $CurName $F1
      StrCpy $U_a $F1
      Call FolderHash
      StrCpy $CurDir "$Root\$U_out"
      StrCpy $CurFile "$DlDir\$F2"
      ${Sum} "  $F2   ($F4 bytes)"
      ${Sum} "      sha256 $F3"
      StrCpy $1 "first"
      ${Sum} "      into $CurDir"
    ${ElseIf} $K S== "url"
    ${AndIf} $1 == "first"
      ${Sum} "      from $F1"
      StrCpy $1 ""
    ${ElseIf} $K S== "step"
      StrCpy $U_a "$F2"
      ${If} $F3 != ""
        StrCpy $U_a "$F2  $F3"
      ${EndIf}
      ${If} $F4 != ""
        StrCpy $U_a "$U_a  $F4"
      ${EndIf}
      Call Subst
      ${Sum} "      then $F1: $U_out"
    ${EndIf}
  ${Loop}
  FileClose $BH
  ${If} $SrcLine > 0
    ${Sum} "  $SrcName   ($SrcSize bytes, the app's source)"
    ${If} $SrcSha == "-"
      ${Sum} "      no stored SHA-256: identified by its commit, fetched over HTTPS"
    ${Else}
      ${Sum} "      sha256 $SrcSha"
    ${EndIf}
    ${If} $SrcUrl1 != ""
      ${Sum} "      from $SrcUrl1"
    ${EndIf}
  ${EndIf}
  ${If} $PackLen > 0
    ${Sum} "  Files packed inside this installer are used instead of downloading them."
  ${EndIf}
  ${Sum} ""
  ${Sum} "Install folder:  $AppDir"
  StrCpy $CurDir ""
  StrCpy $CurFile ""
  ${If} $TgtInstall != ""
    StrCpy $U_a $TgtInstall
    Call Subst
    ${Sum} "Then runs:  $U_out"
  ${EndIf}
  StrCpy $U_a $TgtLaunch
  Call Subst
  ${Sum} "Launch command:  $U_out"
  ${If} $Menu == "0"
    ${Sum} "Shortcuts:  none in the Start menu (this app asks for no menu entry)"
    ${If} $WantDesktop == "1"
      ${Sum} "            a desktop shortcut '$SafeName'"
    ${EndIf}
    ${Sum} "To start it:  $AppDir\launch.exe, or run this installer again"
  ${Else}
    ${If} $RootMode == "system"
      ${Sum} "Shortcuts:  Start menu folder '$SafeName' for all users, holding '$SafeName' and 'Uninstall $SafeName'"
    ${Else}
      ${Sum} "Shortcuts:  Start menu folder '$SafeName', holding '$SafeName' and 'Uninstall $SafeName'"
    ${EndIf}
    ${If} $WantDesktop == "1"
      ${Sum} "            and a desktop shortcut '$SafeName'"
    ${EndIf}
  ${EndIf}
  ${If} $RootMode == "system"
    ${Sum} "Uninstaller:  $AppDir\uninstall.exe, listed in Add/Remove Programs (HKLM ...\Uninstall\ib-$AppId)"
  ${Else}
    ${Sum} "Uninstaller:  $AppDir\uninstall.exe, listed in Add/Remove Programs (HKCU ...\Uninstall\ib-$AppId)"
  ${EndIf}
  ${Sum} "PATH:  not changed"
  ${If} $NdMissing > 0
    ${Sum} "Administrator rights:  yes, to install $NdLabels for the whole computer"
  ${ElseIf} $NeedAdmin = 1
    ${Sum} "Administrator rights:  yes"
  ${Else}
    ${Sum} "Administrator rights:  not needed"
  ${EndIf}
  ${If} $TgtNote != ""
    ${Sum} "Note:  $TgtNote"
  ${EndIf}
  ${Sum} ""
  ${If} $SignedBy != ""
    ${Sum} "Signed by:  $SignedBy (as the certificate names it; Windows checks the signature)"
  ${Else}
    ${Sum} "Signed by:  nobody (this installer is unsigned)"
  ${EndIf}
  ${If} $ModeA = 1
    ${Sum} "Mode:  signed by TiddlyInstall (mode A): installs only what its file name names, from ${IB_BACKEND}"
  ${EndIf}
  ${Sum} "Settings from:  $MetaSrc"
  ${Sum} "Record:  $RecHash"
  ${Sum} "Plan:  $PlanSrc"
  ${If} $PlanSigned != ""
    ${If} $PlanKind == "fetched"
      ${Sum} "Plan signed:  $PlanSigned (fetched now)"
    ${Else}
      ${Sum} "Plan signed:  $PlanSigned (carried in this installer)"
    ${EndIf}
  ${EndIf}
  ${If} $RevokeNote != ""
    ${Sum} "Revocation list:  $RevokeNote"
  ${EndIf}
  ${If} $PlanWarn != ""
    ${Sum} "WARNING:  $PlanWarn"
  ${EndIf}
  ${If} $AgeWarn != ""
    ${Sum} "WARNING:  $AgeWarn"
  ${EndIf}
  FileClose $SumH
  ; no control or bidi characters on the review page (plan text is shown as is otherwise)
  ibsig::cleanfile "$PLUGINSDIR\summary.txt"
  Pop $0
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- review page

Var ReviewEdit

Function ReviewShow
  !insertmacro MUI_HEADER_TEXT "Review what will be installed" "Nothing has been changed yet. Click Install to go ahead."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  nsDialogs::CreateControl EDIT "${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${WS_HSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOHSCROLL}|${ES_AUTOVSCROLL}" "${WS_EX_CLIENTEDGE}" 0 0 100% 100% ""
  Pop $ReviewEdit
  SendMessage $ReviewEdit ${EM_SETLIMITTEXT} 1000000 0
  FileOpen $0 "$PLUGINSDIR\summary.txt" r
  ${Do}
    ClearErrors
    FileReadUTF16LE $0 $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    SendMessage $ReviewEdit ${EM_SETSEL} -1 -1
    SendMessage $ReviewEdit ${EM_REPLACESEL} 0 "STR:$1"
  ${Loop}
  FileClose $0
  SendMessage $ReviewEdit ${EM_SETSEL} 0 0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:&Install"
  nsDialogs::Show
FunctionEnd

Function ReviewLeave
FunctionEnd

Function FinishPre
  ${If} $Failed = 1
    Abort
  ${EndIf}
  ${If} $Menu != "0"
    StrCpy $FinishText "Find it in the Start menu under $SafeName, which also holds its uninstaller."
  ${Else}
    ${If} $LnkDesk != ""
      StrCpy $FinishText "Start it from the '$SafeName' shortcut on the desktop, or run $AppDir\launch.exe."
    ${Else}
      StrCpy $FinishText "It has no Start menu entry. Start it by running $AppDir\launch.exe."
    ${EndIf}
    StrCpy $FinishText "$FinishText Running this installer again also starts it.$\r$\n$\r$\nTo uninstall it, use Add or Remove Programs, or run $AppDir\uninstall.exe."
  ${EndIf}
FunctionEnd

Function RunApp
  Exec '"$AppDir\launch.exe"'
FunctionEnd

; ---------------------------------------------------------------- engine

; Run $RC_cmd with cmd /c in $RC_cwd; output goes to the log.
; $RC_code = exit code ("error" if it couldn't start).
Function RunCmd
  Push $0
  ${If} $RC_cwd != ""
    CreateDirectory "$RC_cwd"
    SetOutPath "$RC_cwd"
  ${EndIf}
  Delete "$PLUGINSDIR\out.txt"
  ${Log} "Running: $RC_cmd"
  nsExec::Exec '"$SYSDIR\cmd.exe" /s /c "($RC_cmd) >"$PLUGINSDIR\out.txt" 2>&1"'
  Pop $RC_code
  ${If} $RC_quiet != 1
  ${OrIf} $RC_code != 0
    StrCpy $U_a "$PLUGINSDIR\out.txt"
    Call LogFile
  ${EndIf}
  ${If} $RC_code != 0
    ${Log} "Exit code: $RC_code"
  ${EndIf}
  SetOutPath "$TEMP"
  Pop $0
FunctionEnd

; Run the bundled 7za: $U_a = arguments. $U_out = 1 on success.
Function SevenZip
  ${IfNot} ${FileExists} "$PLUGINSDIR\7za.exe"
    File "/oname=$PLUGINSDIR\7za.exe" "tools\7za.exe"
  ${EndIf}
  StrCpy $RC_cmd '"$PLUGINSDIR\7za.exe" $U_a'
  StrCpy $RC_cwd ""
  StrCpy $RC_quiet 1
  Call RunCmd
  StrCpy $U_out 0
  ${If} $RC_code == 0
    StrCpy $U_out 1
  ${EndIf}
FunctionEnd

; ---- unpack excludes (docs/format.md, the `unpack` step's 4th field)
;
; A "|"-separated list of glob patterns, matched against each entry's
; path inside the archive with "/" separators. "*" matches any run of
; characters, "/" included; "?" matches one. An entry is left out when
; its own path or any parent's matches. Matching is case-insensitive
; here, as Windows paths are.
;
; Best effort by design: 7za is told what to skip so it never writes it,
; and ExPrune deletes whatever still landed (nsisunz cannot be told).
; A base that predates the field unpacks everything, so what a recipe
; excludes must be something the app never needs.

; Does $EX_str match the glob $EX_pat? $U_out = 1 if it does.
Function GlobMatch
  Push $0   ; index into $EX_str
  Push $1   ; index into $EX_pat
  Push $2   ; $EX_pat index of the last "*", -1 for none
  Push $3   ; where in $EX_str that "*" started matching
  Push $4   ; pattern character
  Push $5   ; string character
  Push $6   ; length of $EX_str
  StrCpy $0 0
  StrCpy $1 0
  StrCpy $2 -1
  StrCpy $3 0
  StrLen $6 $EX_str
  gm_loop:
    ${If} $0 >= $6
      Goto gm_tail
    ${EndIf}
    StrCpy $4 $EX_pat 1 $1
    StrCpy $5 $EX_str 1 $0
    ${If} $4 == "?"
      IntOp $0 $0 + 1
      IntOp $1 $1 + 1
      Goto gm_loop
    ${EndIf}
    ${If} $4 == "*"
      StrCpy $2 $1
      StrCpy $3 $0
      IntOp $1 $1 + 1
      Goto gm_loop
    ${EndIf}
    ${If} $4 != ""
    ${AndIf} $4 == $5
      IntOp $0 $0 + 1
      IntOp $1 $1 + 1
      Goto gm_loop
    ${EndIf}
    ; No match here: let the last "*" swallow one more character.
    ${If} $2 >= 0
      IntOp $1 $2 + 1
      IntOp $3 $3 + 1
      StrCpy $0 $3
      Goto gm_loop
    ${EndIf}
    StrCpy $U_out 0
    Goto gm_end
  gm_tail:
  ; The string is used up; the pattern matches if only "*" is left.
  ${Do}
    StrCpy $4 $EX_pat 1 $1
    ${If} $4 != "*"
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  StrCpy $4 $EX_pat "" $1
  ${If} $4 == ""
    StrCpy $U_out 1
  ${Else}
    StrCpy $U_out 0
  ${EndIf}
  gm_end:
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Is $EX_str named by one of $UP_excl's patterns? $U_out = 1 if it is.
Function ExMatch
  Push $0   ; what is left of the list
  Push $1   ; one pattern
  Push $2   ; scan position
  Push $3   ; length of $0
  Push $4   ; character
  Push $EX_pat
  StrCpy $U_out 0
  StrCpy $0 $UP_excl
  ${Do}
    ${If} $0 == ""
      ${Break}
    ${EndIf}
    StrLen $3 $0
    StrCpy $2 0
    ${Do}
      ${If} $2 >= $3
        ${Break}
      ${EndIf}
      StrCpy $4 $0 1 $2
      ${If} $4 == "|"
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $1 $0 $2
    ${If} $2 >= $3
      StrCpy $0 ""
    ${Else}
      IntOp $2 $2 + 1
      StrCpy $0 $0 "" $2
    ${EndIf}
    ${If} $1 != ""
      StrCpy $EX_pat $1
      Call GlobMatch
      ${If} $U_out = 1
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
  Pop $EX_pat
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Delete anything under $EX_dir that $UP_excl names. $EX_rel is that
; folder's own path inside the archive: "" at the top, otherwise ending
; in "/". Recursive.
Function ExPrune
  Push $0   ; find handle
  Push $1   ; entry name
  Push $2   ; this folder (saved $EX_dir)
  Push $3   ; saved $EX_rel
  Push $4   ; the entry's path inside the archive
  StrCpy $2 $EX_dir
  StrCpy $3 $EX_rel
  FindFirst $0 $1 "$2\*"
  ep_loop:
    StrCmp $1 "" ep_done
    StrCmp $1 "." ep_next
    StrCmp $1 ".." ep_next
    StrCpy $4 "$3$1"
    StrCpy $EX_str $4
    Call ExMatch
    ${If} $U_out = 1
      ${Log} "  leaving out $4"
      ${If} ${FileExists} "$2\$1\*.*"
        RMDir /r "$2\$1"
      ${Else}
        Delete "$2\$1"
      ${EndIf}
    ${ElseIf} ${FileExists} "$2\$1\*.*"
      StrCpy $EX_dir "$2\$1"
      StrCpy $EX_rel "$4/"
      Call ExPrune
      StrCpy $EX_dir $2
      StrCpy $EX_rel $3
    ${EndIf}
  ep_next:
    FindNext $0 $1
    Goto ep_loop
  ep_done:
  FindClose $0
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 7-Zip's own exclusion switches for $UP_excl, into $U_out (7-Zip wants
; "\" and does not drop an excluded folder's contents by itself, so each
; pattern goes in twice). Empty when there is nothing to exclude.
Function ExSevenZipArgs
  Push $0   ; result
  Push $1   ; what is left of the list
  Push $2   ; scan position
  Push $3   ; length of $1
  Push $4   ; character
  Push $5   ; one pattern
  StrCpy $0 ""
  StrCpy $1 $UP_excl
  ${Do}
    ${If} $1 == ""
      ${Break}
    ${EndIf}
    StrLen $3 $1
    StrCpy $2 0
    ${Do}
      ${If} $2 >= $3
        ${Break}
      ${EndIf}
      StrCpy $4 $1 1 $2
      ${If} $4 == "|"
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $5 $1 $2
    ${If} $2 >= $3
      StrCpy $1 ""
    ${Else}
      IntOp $2 $2 + 1
      StrCpy $1 $1 "" $2
    ${EndIf}
    ${If} $5 != ""
      ${WordReplace} "$5" "/" "\" "+" $5
      StrCpy $0 '$0 "-x!$5" "-x!$5\*"'
    ${EndIf}
  ${Loop}
  StrCpy $U_out $0
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Move what is $SI_level folder levels below $SI_src into $SI_dest,
; merging folders that already exist (format.md: strip 2 turns Rust's
; one-folder-per-component tarball into one tree). Recursive.
Function StripInto
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 $SI_src
  StrCpy $1 $SI_level
  FindFirst $2 $3 "$0\*"
  si_loop:
    StrCmp $3 "" si_done
    StrCmp $3 "." si_next
    StrCmp $3 ".." si_next
    ${If} $1 > 0
      ${If} ${FileExists} "$0\$3\*.*"
        Push $SI_src
        Push $SI_level
        StrCpy $SI_src "$0\$3"
        IntOp $SI_level $1 - 1
        Call StripInto
        Pop $SI_level
        Pop $SI_src
      ${EndIf}
    ${Else}
      ${If} ${FileExists} "$0\$3\*.*"
      ${AndIf} ${FileExists} "$SI_dest\$3\*.*"
        ClearErrors
        CopyFiles /SILENT "$0\$3\*.*" "$SI_dest\$3"
        ${If} ${Errors}
          ${FailWith} "Couldn't merge $3 into $SI_dest."
        ${EndIf}
      ${Else}
        ClearErrors
        Rename "$0\$3" "$SI_dest\$3"
        ${If} ${Errors}
          ClearErrors
          CopyFiles /SILENT "$0\$3" "$SI_dest"
          ${If} ${Errors}
            ${FailWith} "Couldn't move $3 into $SI_dest."
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  si_next:
    FindNext $2 $3
    Goto si_loop
  si_done:
  FindClose $2
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Unpack $UP_file ($UP_fmt) into $UP_dest, dropping $UP_strip folder levels.
Function Unpack
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  CreateDirectory "$UP_dest"
  ; $4 = 1 when we unpack into a staging folder first. Excludes need one
  ; too, so that pruning can never touch anything already in $UP_dest.
  StrCpy $4 0
  ${If} $UP_strip != "0"
  ${AndIf} $UP_strip != ""
    StrCpy $4 1
  ${EndIf}
  ${If} $UP_excl != ""
    StrCpy $4 1
  ${EndIf}
  ${If} $4 = 1
    StrCpy $0 "$TmpDir\ux"
    RMDir /r "$0"
  ${Else}
    StrCpy $0 $UP_dest
  ${EndIf}
  CreateDirectory "$0"
  ${If} $UP_excl != ""
    ${Log} "Unpacking $UP_fmt into $UP_dest (strip $UP_strip, leaving out $UP_excl)"
  ${Else}
    ${Log} "Unpacking $UP_fmt into $UP_dest (strip $UP_strip)"
  ${EndIf}
  Call ExSevenZipArgs
  StrCpy $UP_zargs $U_out
  ${If} $UP_fmt == "zip"
    nsisunz::Unzip "$UP_file" "$0"
    Pop $1
    ${If} $1 != "success"
      ${FailWith} "Couldn't unzip $UP_file: $1"
      Goto up_end
    ${EndIf}
  ${ElseIf} $UP_fmt == "7z"
  ${OrIf} $UP_fmt == "tar"
    StrCpy $U_a 'x -y -bd$UP_zargs "-o$0" "$UP_file"'
    Call SevenZip
    ${If} $U_out = 0
      ${FailWith} "Couldn't unpack $UP_file."
      Goto up_end
    ${EndIf}
  ${ElseIf} $UP_fmt == "tar.gz"
  ${OrIf} $UP_fmt == "tgz"
  ${OrIf} $UP_fmt == "tar.xz"
  ${OrIf} $UP_fmt == "tar.bz2"
    StrCpy $1 "$TmpDir\ut"
    RMDir /r "$1"
    CreateDirectory "$1"
    StrCpy $U_a 'x -y -bd "-o$1" "$UP_file"'
    Call SevenZip
    ${If} $U_out = 0
      ${FailWith} "Couldn't decompress $UP_file."
      Goto up_end
    ${EndIf}
    FindFirst $2 $3 "$1\*"
    ${Do}
      ${If} $3 == ""
        ${Break}
      ${EndIf}
      ${If} $3 != "."
      ${AndIf} $3 != ".."
        ${Break}
      ${EndIf}
      FindNext $2 $3
    ${Loop}
    FindClose $2
    ${If} $3 == ""
      ${FailWith} "Decompressing $UP_file gave no tar file."
      Goto up_end
    ${EndIf}
    StrCpy $U_a 'x -y -bd$UP_zargs "-o$0" "$1\$3"'
    Call SevenZip
    RMDir /r "$1"
    ${If} $U_out = 0
      ${FailWith} "Couldn't unpack $UP_file."
      Goto up_end
    ${EndIf}
  ${Else}
    ${FailWith} "Unknown archive format '$UP_fmt'."
    Goto up_end
  ${EndIf}
  ; Anything the unpacker still wrote, and everything nsisunz wrote,
  ; goes now -- before the move, so $UP_dest never sees it.
  ${If} $UP_excl != ""
    StrCpy $EX_dir $0
    StrCpy $EX_rel ""
    Call ExPrune
  ${EndIf}
  ${If} $4 = 1
    StrCpy $SI_src $0
    ${If} $UP_strip == ""
      StrCpy $SI_level 0
    ${Else}
      StrCpy $SI_level $UP_strip
    ${EndIf}
    StrCpy $SI_dest $UP_dest
    Call StripInto
    RMDir /r "$0"
  ${EndIf}
  up_end:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---- the architecture of what is being installed
;
; The plan's `runtime` line carries it as a 3rd value and each `file`
; line as a 5th field (format.md, "Architecture"), both appended, so a
; plan made before 2026-09-20 has neither and none of this prints.
;
; The transparency screen has always shown the machine's architecture; it
; now shows the build's too, and says when they differ -- a 64-bit machine
; being given a 32-bit runtime because no 64-bit build runs on this
; version of Windows is otherwise only discoverable afterwards.

; $TgtRtArch in words, into $U_out.
Function ArchWords
  ${If} $TgtRtArch == "x86"
    StrCpy $U_out "32-bit (x86)"
  ${ElseIf} $TgtRtArch == "amd64"
    StrCpy $U_out "64-bit (amd64)"
  ${ElseIf} $TgtRtArch == "arm64"
    StrCpy $U_out "64-bit ARM (arm64)"
  ${ElseIf} $TgtRtArch == "universal"
    StrCpy $U_out "universal (several architectures in one build)"
  ${ElseIf} $TgtRtArch == "any"
    StrCpy $U_out "any architecture"
  ${Else}
    StrCpy $U_out $TgtRtArch
  ${EndIf}
FunctionEnd

; Why the build's architecture is not this machine's, into $U_out ("" when
; it is, or when the build fits any machine).
Function ArchNote
  StrCpy $U_out ""
  ${If} $TgtRtArch == ""
  ${OrIf} $TgtRtArch == "any"
  ${OrIf} $TgtRtArch == "universal"
  ${OrIf} $TgtRtArch == $Arch
    Return
  ${EndIf}
  ${If} $TgtRtArch == "x86"
  ${AndIf} $Arch != "x86"
    StrCpy $U_out " -- this machine is 64-bit, but the plan has no 64-bit build of $TgtRtName for this version of Windows"
  ${ElseIf} $Arch == "arm64"
  ${AndIf} $TgtRtArch == "amd64"
    StrCpy $U_out " -- this machine is ARM; this is an Intel/AMD build, which Windows runs under emulation"
  ${Else}
    StrCpy $U_out " -- this machine is $Arch"
  ${EndIf}
FunctionEnd

; Look for $FF_sha in the pack; copy it to $FF_path. $U_out = 1 if found.
Function FromPack
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $U_out 0
  ${If} $PackOff = 0
    Goto fp_end
  ${EndIf}
  FileOpen $0 "$EXEPATH" r
  StrCpy $1 $PackOff
  IntOp $4 $PackOff + $PackLen
  ${Do}
    IntOp $2 $1 + 512
    ${If} $2 > $4
      ${Break}
    ${EndIf}
    FileSeek $0 $1 SET
    FileRead $0 $2 64
    ${If} $2 == ""
      ${Break}
    ${EndIf}
    IntOp $3 $1 + 124
    FileSeek $0 $3 SET
    FileRead $0 $3 11
    IntOp $3 $3 + 0                     ; octal (leading 0)
    ${If} $2 == $FF_sha
      StrCpy $CR_h $0
      IntOp $CR_off $1 + 512
      StrCpy $CR_len $3
      StrCpy $CR_dst $FF_path
      Call CopyRange
      ${Break}
    ${EndIf}
    IntOp $3 $3 + 511
    IntOp $3 $3 / 512
    IntOp $3 $3 * 512
    IntOp $1 $1 + 512
    IntOp $1 $1 + $3
  ${Loop}
  FileClose $0
  fp_end:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Get the file declared at plan line $FF_line (sha $FF_sha, name $FF_name):
; the pack first, then each of its url lines in order. Result in $FF_path.
Function FetchFile
  Push $0
  Push $1
  CreateDirectory "$DlDir"
  StrCpy $FF_path "$DlDir\$FF_name"
  Delete "$FF_path"
  ; $FF_unpinned = 1 allows an empty $FF_sha: the file has no stored
  ; SHA-256 and is identified some other way (format.md, "Sources without
  ; a stored hash" -- a GitHub commit over HTTPS). Only the app's own
  ; source sets it. Anything else with no hash fails closed here rather
  ; than being installed unchecked.
  ${If} $FF_unpinned != 1
    ${If} $FF_sha == ""
    ${OrIf} $FF_sha == "-"
      ${FailWith} "$FF_name has no SHA-256 in the plan; refusing to install it."
      Goto ff_end
    ${EndIf}
  ${EndIf}
  ${If} $PackOff > 0
    Call FromPack
    ${If} $U_out = 1
      StrCpy $U_a $FF_path
      Call Sha256File
      ${If} $U_out == $FF_sha
        ${Log} "$FF_name: taken from this installer's pack, sha256 OK"
        Goto ff_end
      ${EndIf}
      ${Log} "$FF_name: the packed copy failed its SHA-256 check ($U_out)"
      Delete "$FF_path"
    ${EndIf}
  ${EndIf}
  FileOpen $FF_h $PlanU16 r
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $FF_line
      ${Break}
    ${EndIf}
    ${IbRead} $FF_h
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $1 0
  ${Do}
    ${IbRead} $FF_h
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $FF_ukey S== "nurl"
      ; a need's lines: nurl among nwhy, ncheck, nrun...; stop at the next entry
      ${If} $K S== "need"
      ${OrIf} $K S== "file"
      ${OrIf} $K S== "[target]"
        ${Break}
      ${EndIf}
      ${If} $K S!= "nurl"
        ${Continue}
      ${EndIf}
    ${Else}
      ${If} $K S== "step"
        ${Continue}
      ${EndIf}
      ${If} $K S!= "url"
        ${Break}
      ${EndIf}
    ${EndIf}
    ${If} $FF_sha == "-"
      StrCpy $0 $F1 8
      ${If} $0 != "https://"
        ${Log} "  skipping $F1: a file with no SHA-256 must come over HTTPS"
        ${Continue}
      ${EndIf}
    ${EndIf}
    StrCpy $1 1
    ${Log} "Downloading $F1"
    StrCpy $U_a $F1
    StrCpy $U_b $FF_path
    System::Call 'kernel32::GetTickCount() i .r0'
    StrCpy $FF_t $0
    Call Download
    System::Call 'kernel32::GetTickCount() i .r0'
    IntOp $0 $0 - $FF_t
    IntOp $0 $0 / 1000
    ${If} $U_out != "OK"
      ${Log} "  failed after $0 s: $U_out"
      ${Continue}
    ${EndIf}
    ${Log} "  downloaded in $0 s"
    ${If} $FF_sha == "-"
      ${Log} "  no stored SHA-256; identified by its commit over HTTPS"
      FileClose $FF_h
      Goto ff_end
    ${EndIf}
    StrCpy $U_a $FF_path
    Call Sha256File
    ${If} $U_out == $FF_sha
      ${Log} "  sha256 OK"
      FileClose $FF_h
      Goto ff_end
    ${EndIf}
    ${Log} "  SHA-256 mismatch: got $U_out, expected $FF_sha"
    Delete "$FF_path"
  ${Loop}
  FileClose $FF_h
  ${If} $1 = 0
    ${FailWith} "$FF_name isn't packed in this installer and has no download location."
  ${Else}
    ${FailWith} "Couldn't download $FF_name from any of its locations with the right SHA-256."
  ${EndIf}
  ff_end:
  Pop $1
  Pop $0
FunctionEnd

; Run one plan step ($F1 kind, $F2.. fields) for the current file.
Function RunStep
  Push $0
  Push $1
  Push $2
  StrCpy $U_a $F2
  Call Subst
  StrCpy $0 $U_out
  StrCpy $U_a $F3
  Call Subst
  StrCpy $1 $U_out
  StrCpy $2 $F4
  ${If} $F1 S== "unpack"
    ; unpack <format> <dest> <strip> [<exclude>]
    StrCpy $UP_file $CurFile
    StrCpy $UP_fmt $F2
    StrCpy $UP_dest $1
    StrCpy $UP_strip $2
    StrCpy $UP_excl $F5
    StrCpy $U_a "$1\"
    Call InAppFolders
    ${If} $U_out = 0
      ${FailWith} "unpack: $1 is outside this app's folders."
      Goto rs_end
    ${EndIf}
    Call Unpack
  ${ElseIf} $F1 S== "run"
    StrCpy $RC_cmd $0
    StrCpy $RC_cwd $CurDir
    StrCpy $RC_quiet 0
    Call RunCmd
    ${If} $RC_code != 0
      ${FailWith} "A step failed (exit code $RC_code): $0"
    ${EndIf}
  ${ElseIf} $F1 S== "mkdir"
    StrCpy $U_a "$0\"
    Call InAppFolders
    ${If} $U_out = 0
      ${FailWith} "mkdir: $0 is outside this app's folders."
      Goto rs_end
    ${EndIf}
    ${Log} "mkdir $0"
    CreateDirectory "$0"
  ${ElseIf} $F1 S== "write"
    StrCpy $U_a $0
    Call InAppFolders
    ${If} $U_out = 0
      ${FailWith} "write: $0 is outside this app's folders."
      Goto rs_end
    ${EndIf}
    ${Log} "write $0: $1"
    ; start on a new line if the file doesn't end with one
    ClearErrors
    FileOpen $2 "$0" r
    ${IfNot} ${Errors}
      FileSeek $2 0 END $U_out
      ${If} $U_out > 0
        IntOp $U_out $U_out - 1
        FileSeek $2 $U_out SET
        FileReadByte $2 $U_out
        FileClose $2
        ${If} $U_out <> 10
          StrCpy $U_a $0
          StrCpy $U_b "$\r$\n"
          Call IbAppendUtf8
        ${EndIf}
      ${Else}
        FileClose $2
      ${EndIf}
    ${EndIf}
    StrCpy $U_a $0
    StrCpy $U_b "$1$\r$\n"
    Call IbAppendUtf8
  ${ElseIf} $F1 S== "delete"
    StrCpy $U_a $0
    Call InAppFolders
    ${If} $U_out = 0
      ${FailWith} "delete: $0 is outside this app's folders."
      Goto rs_end
    ${EndIf}
    ${Log} "delete $0"
    ${If} ${FileExists} "$0\*.*"
      RMDir /r "$0"
    ${Else}
      Delete "$0"
    ${EndIf}
  ${Else}
    ${FailWith} "Unknown step '$F1' in the plan. Download the installer again."
  ${EndIf}
  rs_end:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The chosen block's files: fetch each, then run its steps.
Function DoFiles
  Call OpenBlock
  StrCpy $CurName ""
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    IntOp $LineNo $LineNo + 1
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      StrCpy $CurName $F1
      StrCpy $CurFname $F2
      StrCpy $CurSha $F3
      StrCpy $U_a $F1
      Call FolderHash
      StrCpy $CurDir "$Root\$U_out"
      ${Log} "File $CurName ($CurFname) -> $CurDir"
      ${If} ${FileExists} "$CurDir\*.*"
        ${FailWith} "$CurDir already exists and doesn't belong to this install. Remove it or uninstall the app that owns it."
        ${Break}
      ${EndIf}
      CreateDirectory "$CurDir"
      StrCpy $U_a "$CurDir\.ib-owner"
      StrCpy $U_b "ib-folder$\t1$\nappid$\t$AppId$\nname$\t$CurName$\nfile$\t$CurFname$\n"
      Call IbAppendUtf8
      StrCpy $FF_line $LineNo
      StrCpy $FF_sha $CurSha
      StrCpy $FF_name $CurFname
      Call FetchFile
      ${If} $Failed = 1
        ${Break}
      ${EndIf}
      StrCpy $CurFile $FF_path
    ${ElseIf} $K S== "step"
      ${If} $CurName == ""
        ${FailWith} "The plan has a step before any file."
        ${Break}
      ${EndIf}
      Call RunStep
      ${If} $Failed = 1
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $BH
  StrCpy $CurDir ""
  StrCpy $CurFile ""
FunctionEnd

; Set the environment for `install` (env, unset, ienv, iunset, path).
Function InstallEnv
  Push $0
  StrCpy $0 ""
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "env"
    ${OrIf} $K S== "ienv"
      StrCpy $U_a $F2
      Call Subst
      StrCpy $U_a $F1
      StrCpy $U_b $U_out
      Call IbSetEnv
    ${ElseIf} $K S== "unset"
    ${OrIf} $K S== "iunset"
      StrCpy $U_a $F1
      Call IbUnsetEnv
    ${ElseIf} $K S== "path"
      StrCpy $U_a $F1
      Call Subst
      ${If} $0 == ""
        StrCpy $0 $U_out
      ${Else}
        StrCpy $0 "$0;$U_out"
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $BH
  StrCpy $U_a $0
  Call IbPrependPath
  StrCpy $U_a "IB_APP_DIR"
  StrCpy $U_b $AppDir
  Call IbSetEnv
  StrCpy $U_a "IB_RUNTIME_DIR"
  StrCpy $U_b $RuntimeDir
  Call IbSetEnv
  StrCpy $U_a "IB_APP_NAME"
  StrCpy $U_b $AppName
  Call IbSetEnv
  Pop $0
FunctionEnd

; launch.txt (format.md section 5).
Function WriteLaunch
  Push $0
  StrCpy $0 "$AppDir\launch.txt"
  Delete $0
  StrCpy $U_a $0
  StrCpy $U_b "ib-launch$\t1$\ncwd$\t$AppDir$\n"
  Call IbAppendUtf8
  Call OpenBlock
  ${Do}
    ${IbRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "env"
      StrCpy $U_a $F2
      Call Subst
      StrCpy $U_b "env$\t$F1$\t$U_out$\n"
      StrCpy $U_a $0
      Call IbAppendUtf8
    ${ElseIf} $K S== "unset"
      StrCpy $U_b "unset$\t$F1$\n"
      StrCpy $U_a $0
      Call IbAppendUtf8
    ${ElseIf} $K S== "path"
      StrCpy $U_a $F1
      Call Subst
      StrCpy $U_b "path$\t$U_out$\n"
      StrCpy $U_a $0
      Call IbAppendUtf8
    ${EndIf}
  ${Loop}
  FileClose $BH
  StrCpy $U_a $TgtLaunch
  Call Subst
  StrCpy $U_b "console$\t$Console$\nexec$\t$U_out$\n"
  StrCpy $U_a $0
  Call IbAppendUtf8
  Pop $0
FunctionEnd

; manifest.txt (format.md section 5). $U_c = 1 to include shortcuts/regkey.
Function WriteManifest
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  StrCpy $7 $U_c
  StrCpy $0 "$AppDir\manifest.txt"
  Delete $0
  ; UTC time
  System::Call '*(&i2, &i2, &i2, &i2, &i2, &i2, &i2, &i2) p .r1'
  System::Call 'kernel32::GetSystemTime(p r1)'
  System::Call '*$1(&i2 .r2, &i2 .r3, &i2, &i2 .r4, &i2 .r5, &i2 .r6, &i2 .r8)'
  System::Free $1
  IntFmt $3 "%02d" $3
  IntFmt $4 "%02d" $4
  IntFmt $5 "%02d" $5
  IntFmt $6 "%02d" $6
  IntFmt $8 "%02d" $8
  StrCpy $InstTime "$2-$3-$4T$5:$6:$8Z"
  StrCpy $U_a $0
  StrCpy $U_b "ib-manifest$\t1$\nname$\t$AppName$\nappid$\t$AppId$\nrecord$\t$RecHash$\ninstalled$\t$InstTime$\n"
  Call IbAppendUtf8
  StrCpy $T_rest $FileMap
  Call IbSplitTab
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call IbSplitTab
    Call IbSplitTab
    StrCpy $U_a $0
    StrCpy $U_b "dir$\t$Root\$T_field$\n"
    Push $T_rest
    Push $T_more
    Call IbAppendUtf8
    Pop $T_more
    Pop $T_rest
  ${Loop}
  ${If} $7 == 1
    StrCpy $U_a $0
    ${If} $LnkApp != ""
      StrCpy $U_b "shortcut$\t$LnkApp$\nshortcut$\t$LnkUn$\n"
      Call IbAppendUtf8
    ${EndIf}
    ${If} $LnkDesk != ""
      StrCpy $U_b "shortcut$\t$LnkDesk$\n"
      Call IbAppendUtf8
    ${EndIf}
    StrCpy $U_b "regkey$\t$RegRootName\$RegKey$\n"
    Call IbAppendUtf8
  ${EndIf}
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; An earlier install of the same app is removed first; anything else in
; the way stops the install (design.md 1.1).
Function ClearOldInstall
  Push $0
  ${IfNot} ${FileExists} "$AppDir\*.*"
    Goto co_end
  ${EndIf}
  ${IfNot} ${FileExists} "$AppDir\manifest.txt"
    ${FailWith} "$AppDir already exists and has no manifest. Refusing to install over it."
    Goto co_end
  ${EndIf}
  StrCpy $U_a "$AppDir\manifest.txt"
  StrCpy $U_b "$PLUGINSDIR\oldman.u16"
  Call IbUtf8ToUtf16
  StrCpy $1 ""
  FileOpen $0 "$PLUGINSDIR\oldman.u16" r
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "appid"
      StrCpy $1 $F1
    ${EndIf}
  ${Loop}
  FileClose $0
  ${If} $1 S!= $AppId
    ${FailWith} "$AppDir belongs to another app ($1). Refusing to install over it."
    Goto co_end
  ${EndIf}
  ${Log} "Removing the earlier install of this app in $AppDir"
  Delete "$AppDir\.ib-installed"          ; first: a half-removed install is never "installed"
  FileOpen $0 "$PLUGINSDIR\oldman.u16" r
  ${Do}
    ${IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call IbParseLine
    ${If} $K S== "dir"
      StrCpy $U_a $F1 "" -12
      StrCpy $U_b 12
      Call IbIsB32
      StrCpy $1 $F1 -13
      ${If} $U_out = 1
      ${AndIf} $1 == $Root
        StrCpy $U_a $F1
        Call IbOwnerOf
        ${If} $U_out S== $AppId
          ${Log} "  remove $F1"
          RMDir /r "$F1"
        ${Else}
          ${Log} "  kept $F1: its .ib-owner doesn't name this app"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $0
  RMDir /r "$AppDir"
  ${If} ${FileExists} "$AppDir\*.*"
    ${FailWith} "Couldn't remove the earlier install in $AppDir (is the app running?)."
  ${EndIf}
  co_end:
  Pop $0
FunctionEnd

; Remove what this run created.
Function Cleanup
  ${Log} "Removing partly installed folders"
  StrCpy $T_rest $FileMap
  Call IbSplitTab
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call IbSplitTab
    Call IbSplitTab
    ${If} ${FileExists} "$Root\$T_field\*.*"
      RMDir /r "$Root\$T_field"
    ${EndIf}
  ${Loop}
  ${If} $Created = 1
    SetOutPath "$TEMP"
    RMDir /r "$AppDir"
    ${If} $LnkApp != ""
      Delete "$LnkApp"
      Delete "$LnkUn"
      RMDir "$LnkDir"
    ${EndIf}
    ${If} $LnkDesk != ""
      Delete "$LnkDesk"
    ${EndIf}
    ${If} $RegRootName == "HKLM"
      DeleteRegKey HKLM "$RegKey"
    ${ElseIf} $RegRootName == "HKCU"
      DeleteRegKey HKCU "$RegKey"
    ${EndIf}
  ${EndIf}
  RMDir "$Root"
FunctionEnd

; root system: only administrators and SYSTEM may change <root> and what
; is in it; users may read and run (an admin-installed runtime must not be
; writable by the users who run it). Owner: Administrators, so a folder a
; user created first can't keep its permissions. Works back to XP.
Function SecureRoot
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $1 0
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "O:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)", i 1, *p .r1, p 0) i .r0'
  ${If} $0 = 0
  ${OrIf} $1 = 0
    ${FailWith} "Couldn't build the permissions for $Root."
    Goto sr_end
  ${EndIf}
  System::Call 'advapi32::GetSecurityDescriptorDacl(p r1, *i .r2, *p .r3, *i .r4) i .r0'
  System::Call 'advapi32::GetSecurityDescriptorOwner(p r1, *p .r5, *i .r4) i .r0'
  ; SE_FILE_OBJECT; OWNER | DACL | PROTECTED_DACL
  System::Call 'advapi32::SetNamedSecurityInfoW(w "$Root", i 1, i 0x80000005, p r5, p 0, p r3, p 0) i .r0'
  System::Call 'kernel32::LocalFree(p r1)'
  ${If} $0 <> 0
    ${FailWith} "Couldn't restrict the permissions of $Root to administrators (error $0). Nothing was installed."
    Goto sr_end
  ${EndIf}
  ${Log} "Permissions of $Root: administrators and SYSTEM full control, users read and run"
  sr_end:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function InstallMain
  StrCpy $Created 0
  StrCpy $LnkApp ""
  StrCpy $LnkDesk ""
  StrCpy $RegRootName ""
  ; the transparency text goes into the log too
  FileOpen $0 "$PLUGINSDIR\summary.txt" r
  ${Do}
    ClearErrors
    FileReadUTF16LE $0 $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ${IbTrimNL} $1
    ${Log} "$1"
  ${Loop}
  FileClose $0
  ${Log} ""
  CreateDirectory "$TmpDir"
  CreateDirectory "$DlDir"

  ; system-wide prerequisites, before anything of the app is touched
  Call NeedInstall
  ${If} $Failed = 1
    StrCpy $NdFail 1
    Return
  ${EndIf}

  Call ClearOldInstall
  ${If} $Failed = 1
    Return
  ${EndIf}
  ClearErrors
  CreateDirectory "$Root"
  ${If} $RootMode == "system"
    Call SecureRoot
    ${If} $Failed = 1
      Return
    ${EndIf}
  ${EndIf}
  CreateDirectory "$AppDir"
  ${IfNot} ${FileExists} "$AppDir\*.*"
    ${FailWith} "Couldn't create $AppDir."
    Return
  ${EndIf}
  StrCpy $Created 1
  StrCpy $U_a "$AppDir\.ib-owner"
  StrCpy $U_b "ib-folder$\t1$\nappid$\t$AppId$\nname$\t(app)$\n"
  Call IbAppendUtf8
  CreateDirectory "$DataDir"
  StrCpy $U_c 0
  Call WriteManifest

  ; runtime and other files
  Call DoFiles
  ${If} $Failed = 1
    Return
  ${EndIf}

  ; the app's source
  ${If} $SrcLine > 0
    ${Log} "Source $SrcName"
    StrCpy $FF_line $SrcLine
    StrCpy $FF_sha $SrcSha
    StrCpy $FF_name $SrcName
    StrCpy $FF_unpinned 1
    Call FetchFile
    StrCpy $FF_unpinned 0
    ${If} $Failed = 1
      Return
    ${EndIf}
    StrCpy $UP_file $FF_path
    StrCpy $UP_fmt $SrcFmt
    StrCpy $UP_dest $AppDir
    StrCpy $UP_strip $SrcStrip
    StrCpy $UP_excl ""
    Call Unpack
    ${If} $Failed = 1
      Return
    ${EndIf}
  ${EndIf}

  ; the project's install command
  ${If} $TgtInstall != ""
    Call InstallEnv
    StrCpy $U_a $TgtInstall
    Call Subst
    StrCpy $RC_cmd $U_out
    StrCpy $RC_cwd $AppDir
    StrCpy $RC_quiet 0
    Call RunCmd
    ${If} $RC_code != 0
      ${FailWith} "The project's install command failed (exit code $RC_code)."
      Return
    ${EndIf}
  ${EndIf}

  ; launcher, uninstaller, shortcuts, Add/Remove Programs
  ${If} $TgtLaunch == ""
    ${FailWith} "The plan has no launch command."
    Return
  ${EndIf}
  Call WriteLaunch
  SetOutPath "$AppDir"
  File "/oname=$AppDir\launch.exe" "out\launcher.exe"
  WriteUninstaller "$AppDir\uninstall.exe"
  ${Log} "Wrote launch.exe, launch.txt and uninstall.exe"

  ${If} $RootMode == "system"
    SetShellVarContext all
    StrCpy $RegRootName "HKLM"
  ${Else}
    SetShellVarContext current
    StrCpy $RegRootName "HKCU"
  ${EndIf}
  StrCpy $RegKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-$AppId"
  ${If} $Menu != "0"
    StrCpy $LnkDir "$SMPROGRAMS\$SafeName"
    StrCpy $LnkApp "$LnkDir\$SafeName.lnk"
    StrCpy $LnkUn "$LnkDir\Uninstall $SafeName.lnk"
    CreateDirectory "$LnkDir"
    ClearErrors
    CreateShortCut "$LnkApp" "$AppDir\launch.exe" "" "$AppDir\launch.exe" 0 SW_SHOWNORMAL "" "$AppName"
    CreateShortCut "$LnkUn" "$AppDir\uninstall.exe" "" "$AppDir\uninstall.exe" 0 SW_SHOWNORMAL "" "Uninstall $AppName"
    ${If} ${Errors}
      ${Log} "Warning: couldn't create the Start menu shortcuts."
    ${EndIf}
    ${Log} "Start menu: $LnkDir"
  ${EndIf}
  ${If} $WantDesktop == "1"
    StrCpy $LnkDesk "$DESKTOP\$SafeName.lnk"
    CreateShortCut "$LnkDesk" "$AppDir\launch.exe" "" "$AppDir\launch.exe" 0 SW_SHOWNORMAL "" "$AppName"
    ${Log} "Desktop: $LnkDesk"
  ${EndIf}
  ${If} $RegRootName == "HKLM"
    SetRegView 32
    WriteRegStr HKLM "$RegKey" "DisplayName" "$AppName"
    WriteRegStr HKLM "$RegKey" "UninstallString" '"$AppDir\uninstall.exe"'
    WriteRegStr HKLM "$RegKey" "QuietUninstallString" '"$AppDir\uninstall.exe" /S'
    WriteRegStr HKLM "$RegKey" "InstallLocation" "$AppDir"
    WriteRegStr HKLM "$RegKey" "DisplayIcon" "$AppDir\launch.exe"
    WriteRegStr HKLM "$RegKey" "Publisher" "TiddlyInstall"
    WriteRegDWORD HKLM "$RegKey" "NoModify" 1
    WriteRegDWORD HKLM "$RegKey" "NoRepair" 1
  ${Else}
    WriteRegStr HKCU "$RegKey" "DisplayName" "$AppName"
    WriteRegStr HKCU "$RegKey" "UninstallString" '"$AppDir\uninstall.exe"'
    WriteRegStr HKCU "$RegKey" "QuietUninstallString" '"$AppDir\uninstall.exe" /S'
    WriteRegStr HKCU "$RegKey" "InstallLocation" "$AppDir"
    WriteRegStr HKCU "$RegKey" "DisplayIcon" "$AppDir\launch.exe"
    WriteRegStr HKCU "$RegKey" "Publisher" "TiddlyInstall"
    WriteRegDWORD HKCU "$RegKey" "NoModify" 1
    WriteRegDWORD HKCU "$RegKey" "NoRepair" 1
  ${EndIf}
  ${Log} "Add/Remove Programs: $RegRootName\$RegKey"
  StrCpy $U_c 1
  Call WriteManifest
  SetShellVarContext current

  ; The "fully installed" marker (format.md section 5): the last thing a
  ; successful install writes, renamed into place so it is never half
  ; written. Running the installer again with this record then starts the
  ; app instead of installing it again.
  Delete "$AppDir\.ib-installed.tmp"
  StrCpy $U_a "$AppDir\.ib-installed.tmp"
  StrCpy $U_b "ib-installed$\t1$\nappid$\t$AppId$\nrecord$\t$RecHash$\ninstalled$\t$InstTime$\n"
  Call IbAppendUtf8
  ClearErrors
  Rename "$AppDir\.ib-installed.tmp" "$AppDir\.ib-installed"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "$AppDir\.ib-installed"
    ${FailWith} "Couldn't write $AppDir\.ib-installed."
    Return
  ${EndIf}
  ${Log} "Wrote $AppDir\.ib-installed (record $RecHash)"
FunctionEnd

Section "Install"
  SetDetailsPrint both
  Call InstallMain
  SetOutPath "$TEMP"
  RMDir /r "$TmpDir"
  RMDir /r "$DlDir"
  ${If} $Failed = 1
    ${Log} "ERROR: $FailMsg"
    ${If} $NdFail != 1
      Call Cleanup
    ${EndIf}
    ${Log} "Install failed."
    SetErrorLevel 3
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "$FailMsg"
    ${EndIf}
    Abort "$FailMsg"
  ${EndIf}
  ${Log} "Installed $AppName into $AppDir"
  SetErrorLevel 0
SectionEnd

; ---------------------------------------------------------------- uninstaller

Function un.onInit
  StrCpy $Failed 0
  ${un.GetParameters} $Params
  ClearErrors
  ${un.GetOptions} $Params "/ib-elevated" $0
  ${If} ${Errors}
    StrCpy $Elevated 0
  ${Else}
    StrCpy $Elevated 1
  ${EndIf}
  ${un.GetParent} "$INSTDIR" $UnRoot
  ${un.GetFileName} "$INSTDIR" $1
  ${IfNot} ${FileExists} "$INSTDIR\manifest.txt"
    MessageBox MB_OK|MB_ICONSTOP "$INSTDIR has no manifest.txt; nothing to uninstall." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $U_a "$INSTDIR\manifest.txt"
  StrCpy $U_b "$PLUGINSDIR\manifest.u16"
  InitPluginsDir
  StrCpy $U_b "$PLUGINSDIR\manifest.u16"
  Call un.IbUtf8ToUtf16
  StrCpy $AppName ""
  StrCpy $AppId ""
  StrCpy $RegRootName ""
  FileOpen $0 "$PLUGINSDIR\manifest.u16" r
  ${un.IbRead} $0
  StrCpy $T_rest $T_line
  Call un.IbSplitTab
  ${If} $T_field S!= "ib-manifest"
    FileClose $0
    MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\manifest.txt isn't an ib-manifest file." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${Do}
    ${un.IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call un.IbParseLine
    ${If} $K S== "name"
      StrCpy $AppName $F1
    ${ElseIf} $K S== "appid"
      StrCpy $AppId $F1
    ${ElseIf} $K S== "regkey"
      StrCpy $RegRootName $F1 4
    ${EndIf}
  ${Loop}
  FileClose $0
  ; the uninstaller must sit in <root>\<appid>
  StrCpy $U_a $AppId
  StrCpy $U_b 12
  Call un.IbIsB32
  ${If} $U_out = 0
  ${OrIf} $1 S!= $AppId
    MessageBox MB_OK|MB_ICONSTOP "This uninstaller isn't in its app's folder ($INSTDIR); refusing to remove anything." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $RegRootName == "HKLM"
    Call un.IbIsAdmin
    ${If} $U_out = 0
      ${WinVerGetMajor} $2
      ${If} $2 < 6
      ${OrIf} $Elevated = 1
        MessageBox MB_OK|MB_ICONSTOP "Uninstalling $AppName needs administrator rights." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      ; strip any _?= and pass it again last
      StrCpy $2 $Params
      StrLen $3 $2
      StrCpy $4 0
      ${Do}
        ${If} $4 >= $3
          ${Break}
        ${EndIf}
        StrCpy $5 $2 3 $4
        ${If} $5 == "_?="
          StrCpy $2 $2 $4
          ${Break}
        ${EndIf}
        IntOp $4 $4 + 1
      ${Loop}
      StrCpy $U_a "$2 /ib-elevated _?=$INSTDIR"
      Call un.IbRunElevated
      ${If} $U_out == "error"
        MessageBox MB_OK|MB_ICONSTOP "Uninstalling $AppName needs administrator rights, and Windows didn't grant them." /SD IDOK
        SetErrorLevel 2
      ${Else}
        SetErrorLevel $U_out
      ${EndIf}
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

; $U_a = a shortcut path from the manifest. $U_out = 1 if it may be deleted.
Function un.ShortcutOK
  Push $0
  StrCpy $0 $U_a
  StrCpy $U_out 0
  StrCpy $U_b $0 4 -4
  ${If} $U_b != ".lnk"
    Goto so_end
  ${EndIf}
  StrCpy $U_b ".."
  Call un.IbContains
  ${If} $U_out = 1
    StrCpy $U_out 0
    Goto so_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$UnSmCur\"
  Call un.IbStartsWith
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnSmAll\"
    Call un.IbStartsWith
  ${EndIf}
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnDeskCur\"
    Call un.IbStartsWith
  ${EndIf}
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnDeskAll\"
    Call un.IbStartsWith
  ${EndIf}
  so_end:
  Pop $0
FunctionEnd

Section "Uninstall"
  SetDetailsPrint both
  SetShellVarContext current
  StrCpy $UnSmCur $SMPROGRAMS
  StrCpy $UnDeskCur $DESKTOP
  SetShellVarContext all
  StrCpy $UnSmAll $SMPROGRAMS
  StrCpy $UnDeskAll $DESKTOP
  SetShellVarContext current
  SetOutPath "$TEMP"
  ; The "fully installed" marker goes first, so an uninstall that stops
  ; half way is never taken for a finished install.
  Delete "$INSTDIR\.ib-installed"
  FileOpen $0 "$PLUGINSDIR\manifest.u16" r
  ${Do}
    ${un.IbRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call un.IbParseLine
    ${If} $K S== "dir"
      ; only <root>\<12 base32 chars>, beside this app's folder
      StrCpy $U_a $F1 "" -12
      StrCpy $U_b 12
      Call un.IbIsB32
      StrCpy $1 $F1 -13
      StrCpy $2 $F1 1 -13
      ${If} $U_out = 1
      ${AndIf} $1 == $UnRoot
      ${AndIf} $2 == "\"
        StrCpy $U_a $F1
        Call un.IbOwnerOf
        ${If} $U_out S== $AppId
          DetailPrint "Remove folder $F1"
          RMDir /r "$F1"
        ${Else}
          DetailPrint "Skipped (its .ib-owner doesn't name this app): $F1"
        ${EndIf}
      ${Else}
        DetailPrint "Skipped (not under $UnRoot): $F1"
      ${EndIf}
    ${ElseIf} $K S== "shortcut"
      StrCpy $U_a $F1
      Call un.ShortcutOK
      ${If} $U_out = 1
        DetailPrint "Remove shortcut $F1"
        Delete "$F1"
        ${un.GetParent} "$F1" $1
        ${If} $1 != $UnSmCur
        ${AndIf} $1 != $UnSmAll
        ${AndIf} $1 != $UnDeskCur
        ${AndIf} $1 != $UnDeskAll
          RMDir "$1"              ; the app's Start menu folder, once empty
        ${EndIf}
      ${Else}
        DetailPrint "Skipped (not a shortcut in the Start menu or on the desktop): $F1"
      ${EndIf}
    ${ElseIf} $K S== "regkey"
      StrCpy $1 "Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-$AppId"
      ${If} $F1 S== "HKCU\$1"
        DetailPrint "Remove $F1"
        DeleteRegKey HKCU "$1"
      ${ElseIf} $F1 S== "HKLM\$1"
        DetailPrint "Remove $F1"
        SetRegView 32
        DeleteRegKey HKLM "$1"
      ${Else}
        DetailPrint "Skipped (not this app's uninstall key): $F1"
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $0
  StrCpy $U_a $INSTDIR
  Call un.IbOwnerOf
  ${If} $U_out S== $AppId
    DetailPrint "Remove folder $INSTDIR"
    SetOutPath "$TEMP"
    ; This runs from the %TEMP% copy; the uninstall.exe it was started as
    ; may not have exited yet, and Windows won't delete a running file.
    ; Retry for up to 15 s, then leave the rest for the next reboot.
    StrCpy $1 0
    ${Do}
      RMDir /r "$INSTDIR"
      ${IfNot} ${FileExists} "$INSTDIR\*.*"
        ${Break}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 30
        DetailPrint "Some files in $INSTDIR are in use; they are removed at the next restart."
        RMDir /r /REBOOTOK "$INSTDIR"
        ${Break}
      ${EndIf}
      Sleep 500
    ${Loop}
  ${Else}
    DetailPrint "Kept $INSTDIR: its .ib-owner doesn't name this app"
  ${EndIf}
  RMDir "$UnRoot"                 ; the install root, if nothing else is in it
  SetErrorLevel 0
SectionEnd
