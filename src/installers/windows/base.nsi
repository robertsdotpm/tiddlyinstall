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

!ifndef TI_BACKEND
  !define TI_BACKEND "https://tiddlyinstall.warpgate.io"
!endif
!ifndef TI_VERSION
  !define TI_VERSION "0.1.0.0"
!endif
!ifndef TI_OUTFILE
  !define TI_OUTFILE "out\base.exe"
!endif
; The plan signing key (docs/format.md "Plan signature"), base64 of the raw 32-byte
; Ed25519 public key, and its short id. build.sh reads them from a file.
!ifndef TI_PLAN_PUBKEY
  !error "TI_PLAN_PUBKEY is not defined: build with build.sh"
!endif
!ifndef TI_PLAN_KEYID
  !define TI_PLAN_KEYID "?"
!endif
; When this base was built (build.sh passes both): RFC 3339 for messages,
; and whole days since 1970 for arithmetic (seconds would overflow NSIS's
; 32-bit integers in 2038). The real time is certainly not earlier than
; this, which is the only floor a machine with a wrong clock gives us
; (design.md 7.1, "Clocks").
!ifndef TI_BUILD_TIME
  !define TI_BUILD_TIME "1970-01-01T00:00:00Z"
!endif
!ifndef TI_BUILD_DAYS
  !define TI_BUILD_DAYS 0
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
!include "tiutil.nsh"

Name "TiddlyInstall"
Caption "TiddlyInstall: $AppName"
UninstallCaption "TiddlyInstall: uninstall $AppName"
OutFile "${TI_OUTFILE}"
BrandingText "TiddlyInstall ${TI_VERSION}"
ShowInstDetails show
ShowUninstDetails show
InstallDir "$TEMP"        ; replaced once the plan is read

VIProductVersion "${TI_VERSION}"
VIAddVersionKey ProductName "TiddlyInstall"
VIAddVersionKey CompanyName "TiddlyInstall"
VIAddVersionKey FileDescription "TiddlyInstall base installer"
VIAddVersionKey FileVersion "${TI_VERSION}"
VIAddVersionKey ProductVersion "${TI_VERSION}"
VIAddVersionKey LegalCopyright "TiddlyInstall"

; ---------------------------------------------------------------- state

; command line and logging
Var Params
Var LogPath
Var L_msg
Var Elevated         ; 1 when started by our own runas relaunch
Var Reinstall        ; 1: /reinstall (install again even if already installed)
Var InstTime         ; the install's UTC time, for manifest.txt and .ti-installed
Var FinishText       ; the finish page's text: where to find the app
; metadata
Var RecFile          ; record, UTF-8 ("" if none)
Var PlanFile         ; plan, UTF-8
Var RecU16
Var PlanU16
Var RecHash          ; 26-char base32 hash of the record
Var Backend
Var OptBackend
Var BackendGiven     ; 1 when somebody chose one, 0 when this engine
                     ; filled in the address it was compiled with
Var MetaSrc          ; where the record came from, for the transparency page
Var PlanSrc
Var PlanKind         ; fetched, cmdline or embedded
Var PlanSig          ; tisig::check's answer
Var PlanWarn         ; a warning for the review page
Var PlanSigState     ; ok | unsigned | bad | cannot
Var RtState          ; ok | none | bad: is the runtime script one we published
Var RtIssued         ; when the roots document was published
Var RtWhy
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
Var CmdH             ; every command in full, for the log
Var UrlH             ; every download location in full, for the log
Var SumHosts         ; the hosts the review page says files come from
Var SumHostN         ; how many of them there are
Var SumBytes         ; how many bytes it would download
Var SumFiles         ; how many files
Var SumUnsized       ; 1: one of them has no size in the plan, so $SumBytes
                     ; is a floor and every total says "more than"
Var SumRuns          ; how many commands it would run
Var SumMirrors       ; download locations that are not a file's origin
Var BackendHost      ; the host our own copies are served from
Var CurU1            ; this file's first URL, and the first that is not ours
Var CurOrigin
Var CurMirrors       ; and how many of its locations are left over
Var WinDX            ; how much wider the window was made at GUI init
Var WinDY
Var PackOff          ; offset of the pack in $EXEPATH (0 = none)
Var PackLen
Var TokRuntime       ; plain file-name tokens
Var TokProject
; record fields shown on the transparency page
Var RecSource
Var RecLaunch
Var RecInstall       ; the record's `install`: "" / default / default:<rule> = ours, anything else the publisher's
Var HasRecord        ; 1: a record was read, so RecInstall means something
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
Var AsciiTmp          ; an ASCII temp folder for the install command, "" to change nothing
Var TmpSaved          ; TMP and TEMP as this machine had them, put back after
Var TempSaved
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
; what this install can do that an ordinary one cannot (CapScan, below)
Var CapN             ; how many findings
Var Cap1
Var Cap2
Var Cap3
Var Cap4
Var Cap5
Var Cap6
Var Cap7
Var CapUnknown       ; plan keys and step kinds this engine does not know, ", " joined
Var CapInd1          ; SumPara: the first line's indent
Var CapInd2          ; and every following line's
Var PendRow          ; a DOWNLOADS row, held until its origin is known
Var PendSha          ; and that row's SHA-256
Var CompDirs         ; ", name, " for each `path {dir:<name>}`: the companion runtimes
Var FileRole         ; what the file being printed is
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
Var CmdLabel         ; a label written over a command's first indent
Var CmdCont          ; and what its wrapped lines are indented by
Var ReviewOut        ; /ti-review=<file>: write the review text there and install nothing
; function parameters
Var FF_line
Var FF_sha
Var FF_unpinned      ; this one file may have no SHA-256 (the app's source)
Var FF_name
Var FF_path
Var FF_h
Var FF_t
Var FF_k             ; FetchFile: which vendor to try first (FfSpreadK)
Var FF_nv            ; FetchFile: how many vendors this file has
Var FF_phase         ; FetchFile: 0 = vendors from $FF_k on, 1 = the rest
Var FF_vi            ; FetchFile: which vendor this line is
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

!insertmacro TI_UTIL ""
!insertmacro TI_UTIL "un."

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

!macro SumCmd MSG
  FileWriteUTF16LE $CmdH "${MSG}$\r$\n"
!macroend
!define SumCmd "!insertmacro SumCmd"

; The review page names where each file comes from and counts the rest;
; this is where every URL is written down, in the order they are tried,
; and it goes into the log with the commands (design.md section 3).
!macro SumUrl MSG
  FileWriteUTF16LE $UrlH "${MSG}$\r$\n"
!macroend
!define SumUrl "!insertmacro SumUrl"

; ---------------------------------------------------------------- pages

!define MUI_CUSTOMFUNCTION_GUIINIT TiGuiInit
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
    Call TiAppendUtf8
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
      ${TiTrimNL} $1
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
    Call TiHexToB32
  ${EndIf}
FunctionEnd

; Folder hash (12 chars) for plan file $U_a: base32(sha256(appid + name)).
Function FolderHash
  Push $0
  StrCpy $0 $U_a
  Delete "$PLUGINSDIR\fh.txt"
  StrCpy $U_a "$PLUGINSDIR\fh.txt"
  StrCpy $U_b "$AppId$0"
  Call TiAppendUtf8
  StrCpy $U_a "$PLUGINSDIR\fh.txt"
  Call Sha256File
  StrCpy $U_a $U_out
  StrCpy $U_b 12
  Call TiHexToB32
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
    Call TiContains
    ${If} $U_out = 0
      StrCpy $U_a $0
      StrCpy $U_b "/"
      Call TiContains
      ${If} $U_out = 0
        StrCpy $U_a $0
        StrCpy $U_b ":"
        Call TiContains
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
  Call TiSplitTab                        ; leading empty field
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call TiSplitTab
    StrCpy $1 $T_field
    Call TiSplitTab
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
Function TiGetOpt
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
!macro TiGetOpt OPT OUT
  StrCpy $U_a "${OPT}"
  Call TiGetOpt
  StrCpy ${OUT} $U_out
!macroend
!define TiGetOpt "!insertmacro TiGetOpt"

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
  Call TiContains
  ${If} $U_out = 1
    StrCpy $U_out 0
    Goto iaf_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$AppDir\"
  Call TiStartsWith
  ${If} $U_out = 1
    Goto iaf_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$TmpDir\"
  Call TiStartsWith
  ${If} $U_out = 1
    Goto iaf_end
  ${EndIf}
  StrCpy $T_rest $FileMap
  Call TiSplitTab
  ${Do}
    ${If} $T_more = 0
      StrCpy $U_out 0
      ${Break}
    ${EndIf}
    Call TiSplitTab
    Call TiSplitTab
    StrCpy $1 $T_field
    StrCpy $U_a $0
    StrCpy $U_b "$Root\$1\"
    Call TiStartsWith
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
  ${If} $5 S!= "TIMETA1 "
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
; Nothing here verifies it. CryptQueryObject parses the embedded
; PKCS#7 and CertGetNameStringW reads the subject name out of it; no
; digest is recomputed and no chain is built. Windows checks the
; signature in Properties and on a file carrying a mark of the web,
; neither of which happens on the path this installer takes
; (RequestExecutionLevel user, so there is no UAC publisher line).
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
    Call TiIsB32
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
; owner/repo, exactly as the server's sourceKey does (src/build_server/server.js).
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
  Call TiUtf8ToUtf16
  FileOpen $0 $RecU16 r
  ${TiRead} $0
  StrCpy $T_rest $T_line
  Call TiSplitTab
  ${If} $T_field S!= "ti-record"
    FileClose $0
    ${FailWith} "The record is not a ti-record file."
    Goto rr_end
  ${EndIf}
  Call TiSplitTab
  IntOp $T_field $T_field + 0
  ${If} $T_field > 1
    FileClose $0
    ${FailWith} "The record's format version is newer than this installer understands. Download the installer again."
    Goto rr_end
  ${EndIf}
  ${Do}
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "backend"
    ${AndIf} $OptBackend == ""
    ${AndIf} $ModeA = 0
      ${If} $F1 != ""
        StrCpy $Backend $F1
        StrCpy $BackendGiven 1
      ${EndIf}
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
    ${ElseIf} $K S== "install"
      ; Who wrote the command that installs the project (format.md
      ; section 2): absent, `default` or `default:<rule>` is the
      ; catalogue's, anything else is the publisher's own. The plan
      ; carries only the resolved string, but the plan's `record` line
      ; is checked against this file's hash, so the record is exactly
      ; as trustworthy as the plan and answers it without a new key.
      StrCpy $RecInstall $F1
    ${ElseIf} $K S== "root"
      StrCpy $RecRoot $F1
    ${ElseIf} $K S== "rootname"
      StrCpy $RecRootName $F1
    ${EndIf}
  ${Loop}
  FileClose $0
  StrCpy $HasRecord 1
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
  Call TiUtf8ToUtf16
  FileOpen $0 $PlanU16 r
  ${TiRead} $0
  StrCpy $T_rest $T_line
  Call TiSplitTab
  ${If} $T_field S!= "ti-plan"
    FileClose $0
    ${FailWith} "The install plan is not a ti-plan file."
    Goto rp_end
  ${EndIf}
  Call TiSplitTab
  IntOp $T_field $T_field + 0
  ${If} $T_field > 1
    FileClose $0
    ${FailWith} "The install plan's format version is newer than this installer understands. Download the installer again."
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
  StrCpy $RootName "ti"
  ${Do}
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    IntOp $LineNo $LineNo + 1
    Call TiParseLine
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
        ${If} $SrcLine > 0
        ${AndIf} $SrcUrl1 == ""
          StrCpy $SrcUrl1 $F1
        ${EndIf}
      ${ElseIf} $K S== "sig"
      ${ElseIf} $K S== "rtroots"
        ; ours (docs/format.md section 6b): the signed roots document the
        ; runtime-script proofs are checked against. It is a *header*
        ; key -- ti_get and this scan both stop at the first [target] --
        ; and the block scan's list of our own keys, further down, does
        ; not cover it. Missing here, it was reported to the reader as
        ; something the installer could not describe, with 700 bytes of
        ; base64 printed as its name (Windows 10, 2026-09-23).
      ${ElseIf} $K S== "runtime"
        ; the header's bare `runtime <id>`; the chosen block's line has
        ; the version and the architecture, and ReadTarget reads it
      ${Else}
        ; A key this engine does not know is not passed over quietly:
        ; the review page says so, because a summary that silently
        ; describes part of a plan as though it were the whole of it is
        ; worse than no summary (CapScan, below).
        StrCpy $U_a $K
        Call CapUnknownAdd
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
          Call TiContains
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
    ${TiRead} $BH
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
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $CompDirs ""
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
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
    ${ElseIf} $K S== "step"
      StrCpy $U_a " unpack run mkdir write delete "
      StrCpy $U_b " $F1 "
      Call StrHas
      ${If} $U_out = 0
        StrCpy $U_a "step $F1"
        Call CapUnknownAdd
      ${EndIf}
    ${ElseIf} $K S== "when"
    ${ElseIf} $K S== "minbuild"
    ${ElseIf} $K S== "covers"
    ${ElseIf} $K S== "url"
    ${ElseIf} $K S== "env"
    ${ElseIf} $K S== "unset"
    ${ElseIf} $K S== "path"
      ; A companion runtime the recipe requires is put on PATH as
      ; `{dir:<id>}...`, and nothing else in a plan is. That is what
      ; tells a tool the install needs from the runtime being installed
      ; (WriteSummary's file list, and ti_file_role in the other engine).
      StrCpy $0 $F1 5
      ${If} $0 S== "{dir:"
        StrCpy $1 $F1 "" 5
        StrLen $3 $1
        StrCpy $2 0
        ${Do}
          ${If} $2 >= $3
            ${Break}
          ${EndIf}
          StrCpy $4 $1 1 $2
          ${If} $4 S== "}"
            ${Break}
          ${EndIf}
          IntOp $2 $2 + 1
        ${Loop}
        StrCpy $1 $1 $2
        ${If} $1 != ""
          ${If} $CompDirs == ""
            StrCpy $CompDirs ", "
          ${EndIf}
          StrCpy $CompDirs "$CompDirs$1, "
        ${EndIf}
      ${EndIf}
    ${ElseIf} $K S== "ienv"
    ${ElseIf} $K S== "iunset"
    ${ElseIf} $K S== "need"
    ${ElseIf} $K S== "nwhy"
    ${ElseIf} $K S== "ncheck"
    ${ElseIf} $K S== "nurl"
    ${ElseIf} $K S== "nrun"
    ${ElseIf} $K S== "nok"
    ${ElseIf} $K S== "npkg"
    ${ElseIf} $K S== "nstart"
    ${ElseIf} $K S== "nhow"
    ${ElseIf} $K S== "rtroots"
    ${ElseIf} $K S== "rtproof"
      ; ours (docs/format.md section 6b): the runtime-script proof, read
      ; by tisig::rtverify. Named here so the capability scan does not
      ; report our own proof as something it cannot describe.
    ${ElseIf} $K S== "sig"
      ; the plan's signature line sits after the last block, so it is
      ; read here when the last block is the chosen one
    ${ElseIf} $K S== "file"
      StrCpy $0 $F3
      StrCpy $U_a $0
      Call AppendSha
      StrCpy $0 $F1
      StrCpy $U_a $F2
      Call IsPlainName
      ${If} $U_out = 0
        ${FailWith} "The runtime setup names a file with a path in it: $U_a"
        ${Break}
      ${EndIf}
      StrCpy $U_a $0
      Call FolderHash
      StrCpy $FileMap "$FileMap$\t$0$\t$U_out"
      ${If} $RuntimeDir == ""
        StrCpy $RuntimeDir "$Root\$U_out"
      ${EndIf}
    ${Else}
      StrCpy $U_a $K
      Call CapUnknownAdd
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
  Pop $4
  Pop $3
  Pop $2
  Pop $1
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
    ${Log} "An installer program signed by $SignedBy, with no settings inside: mode A (its file name and the built-in backend only)"
  ${EndIf}
  ; 1. command line (not in mode A)
  StrCpy $1 ""
  ClearErrors
  ${TiGetOpt} "/record=" $0
  ${IfNot} ${Errors}
    StrCpy $1 "/record="
  ${EndIf}
  ClearErrors
  ${TiGetOpt} "/plan=" $2
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
    ${FailWith} "$SignedBy's signature is on this installer program, and it covers no settings, so this copy installs only the app its own file name names, from ${TI_BACKEND}. It doesn't accept $1. For your own settings use a base nobody has signed, or one you sign yourself (modes B and C)."
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
  ${TiGetOpt} "/record=" $0
  ${IfNot} ${Errors}
    StrCpy $RecFile $0
    StrCpy $MetaSrc "the command line (/record=$0)"
    ${IfNot} ${FileExists} "$RecFile"
      ${FailWith} "Can't read $RecFile."
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${TiGetOpt} "/plan=" $0
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
      StrCpy $MetaSrc "the block appended to this installer"
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
      ${Log} "Ignoring $EXEDIR\install.txt: an installer we signed takes its settings only from its file name."
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
      ${FailWith} "Couldn't fetch an install plan for $TokRuntime/$TokProject from $Backend ($U_out)."
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
  Call TiContains
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
  tisig::check "$PlanFile" "${TI_PLAN_PUBKEY}"
  Pop $PlanSig
  ${Log} "Plan signature: $PlanSig (key ${TI_PLAN_KEYID})"
  StrCpy $PlanWarn ""
  StrCpy $0 $PlanSig 2
  ${If} $0 == "ok"
    ; The line in BEFORE YOU TRUST IT says who signed it; this used
    ; to append it here too, which is where it got lost mid-clause.
    StrCpy $PlanSrc "$PlanSrc"
    Return
  ${EndIf}
  ; An absent signature and a wrong one are different findings, and this
  ; called both "isn't signed" while printing a parenthetical that said
  ; otherwise -- "isn't signed by the TiddlyInstall key (bad:the
  ; signature does not match this plan and this installer's key)". A
  ; missing signature is an omission; one that does not match is evidence
  ; the bytes changed after it was made, which is the more serious
  ; finding and was the one being hidden. Same classes the Unix engine
  ; uses: unsigned / bad: / cannot:.
  StrCpy $0 $PlanSig 4
  StrCpy $1 $PlanSig 7
  ; A prefix, not the whole string. ti_plan_sig answers "unsigned" on
  ; its own here and "unsigned: no signature line" there, and an exact
  ; match sent every page-built installer -- which is every installer
  ; built with no server, so the common case -- down the ${Else} arm and
  ; called it "bad". That put a red !! WARNINGS block reading "is not
  ; signed by the TiddlyInstall key" on the ordinary state of our own
  ; output, which is the one thing this screen is not allowed to do.
  ; The Unix engine matches the bare word and never showed it, so no
  ; fixture with an unsigned embedded plan ever reached this arm
  ; (found by the operator on Windows, 2026-09-23).
  StrCpy $3 $PlanSig 8
  ${If} $3 == "unsigned"
    StrCpy $2 "carries no signature by the TiddlyInstall key"
    StrCpy $PlanSigState "unsigned"
  ${ElseIf} $0 == "bad:"
    StrCpy $2 "has a signature that does NOT match the TiddlyInstall key"
    StrCpy $PlanSigState "bad"
  ${ElseIf} $1 == "cannot:"
    StrCpy $2 "has a signature that could not be checked here"
    StrCpy $PlanSigState "cannot"
  ${Else}
    StrCpy $2 "is not signed by the TiddlyInstall key"
    StrCpy $PlanSigState "bad"
  ${EndIf}
  ${If} $PlanKind == "embedded"
    ; Only a signature that fails to match reaches WARNINGS: that is
    ; evidence the bytes changed after somebody signed them. An absent
    ; one is said plainly in BEFORE YOU TRUST IT instead -- every
    ; installer built in a page has none, because a page holds no key,
    ; and a red block about the ordinary case teaches people to ignore
    ; red blocks (2026-09-23).
    ${If} $PlanSigState != "unsigned"
      StrCpy $PlanWarn "The install plan inside this file $2 ($PlanSig)."
    ${EndIf}
    Return
  ${EndIf}
  ${If} $PlanKind == "cmdline"
  ${AndIf} $UnsignedOK = 1
    StrCpy $PlanWarn "The install plan from the command line $2 ($PlanSig); /unsigned-plan was given."
    Return
  ${EndIf}
  ${If} $PlanKind == "cmdline"
    ${FailWith} "The install plan $PlanFile $2 ${TI_PLAN_KEYID} ($PlanSig). Use one saved from <backend>/api/plan/<record>, or add /unsigned-plan if you wrote it yourself."
  ${Else}
    ${FailWith} "The install plan from $Backend $2 ${TI_PLAN_KEYID} ($PlanSig). It may have been changed on the way; nothing was installed."
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- stale plans (design.md 7.1)

!define TI_MAXAGE_DEFAULT_DAYS 90     ; the plan's `maxage` when it says nothing
!define TI_MAXAGE_LIMIT_DAYS 365      ; past this a carried plan is refused
!define TI_CLOCK_SPAN_DAYS 3653       ; ten years: past this the clock isn't believable

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
  Call TiAppendUtf8
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
  Call TiIsDigits
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

; $U_out = 1 if $U_a is one or more ASCII digits (TiIsB32's shape: a
; comparison per character, because NSIS's < and > are numeric).
Function TiIsDigits
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
  StrCpy $3 ${TI_MAXAGE_DEFAULT_DAYS}
  ${If} $PlanMaxAge != ""
    StrCpy $U_a $PlanMaxAge
    Call TiIsDigits
    ${If} $U_out = 1
      IntOp $3 $PlanMaxAge / 86400
    ${EndIf}
  ${EndIf}
  ${If} $3 > ${TI_MAXAGE_LIMIT_DAYS}
    StrCpy $3 ${TI_MAXAGE_LIMIT_DAYS}
  ${EndIf}
  ; Is the clock believable at all?
  StrCpy $0 0
  ${If} $2 != ""
  ${AndIf} ${TI_BUILD_DAYS} > 0
  ${AndIf} $2 >= ${TI_BUILD_DAYS}
    IntOp $0 $2 - ${TI_BUILD_DAYS}
    ${If} $0 <= ${TI_CLOCK_SPAN_DAYS}
    ${AndIf} $2 >= $1
      StrCpy $0 1
    ${Else}
      StrCpy $0 0
    ${EndIf}
  ${EndIf}
  ${If} $0 <> 1
    Call NowText
    StrCpy $AgeWarn "This installer's plan was signed on $PlanSigned, and this machine's clock says $U_out, which can't be right (this installer was built ${TI_BUILD_TIME}), so how old the plan is can't be told. Nothing is refused for age."
    ${Log} "Clock not plausible; the plan's age is reported only."
    Goto ca_end
  ${EndIf}
  IntOp $0 $2 - $1                    ; age in days
  ${Log} "Plan signed $PlanSigned, $0 days ago; maxage $3 days."
  ${If} $0 <= $3
    Goto ca_end
  ${EndIf}
  ${If} $0 > ${TI_MAXAGE_LIMIT_DAYS}
    ${FailWith} "This installer's install plan was signed on $PlanSigned, $0 days ago, past the ${TI_MAXAGE_LIMIT_DAYS}-day limit. What it installs may since have been withdrawn or found unsafe. Get a current installer from $Backend and run that instead; nothing was installed."
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
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
  Call TiIsDigits
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
  ; Built with no server: it carries the plan the page worked out, from
  ; the list that page carried, and asks nobody. It used to fall through
  ; to the address this engine was compiled with and ask that -- a host
  ; the builder never picked and the person running it never agreed to
  ; (2026-09-23). Said rather than done quietly: a file withdrawn after
  ; this installer was made cannot reach it.
  ${If} $BackendGiven = 0
    ; When, where the plan says: "anything withdrawn since" is a date a
    ; person can act on, and "since this installer was made" is not.
    StrCpy $0 ""
    ${If} $PlanSigned != ""
      StrCpy $0 " after $PlanSigned"
    ${EndIf}
    StrCpy $RevokeNote "not checked: built offline, so anything withdrawn$0 is unknown here"
    Goto rv_end
  ${EndIf}
  StrCpy $2 ""                        ; the UTF-16 list to use
  StrCpy $3 "$LOCALAPPDATA\TiddlyInstall\revocations.txt"
  StrCpy $U_a "$Backend/api/revocations"
  StrCpy $U_b "$PLUGINSDIR\revocations.txt"
  ${Log} "Fetching the revocation list: $U_a"
  Call DownloadOptional
  ${If} $U_out == "OK"
    tisig::checkdoc "$PLUGINSDIR\revocations.txt" "${TI_PLAN_PUBKEY}" "ti-revocations"
    Pop $0
    StrCpy $1 $0 2
    ${If} $1 == "ok"
      StrCpy $U_a "$PLUGINSDIR\revocations.txt"
      StrCpy $U_b "$PLUGINSDIR\revocations.u16"
      Call TiUtf8ToUtf16
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
    ; The cache is a file on this machine, which anything on this machine
    ; could have written. It is checked exactly as the fetched list is.
    ; Until 2026-09-24 it was not checked at all, and the serial
    ; comparison below let an unverified file displace a list that had
    ; just been fetched and verified. Forging one installs nothing, but
    ; it denies every install on the machine while the screen says the
    ; check was done. An unverified cache is deleted rather than kept, or
    ; it would go on refusing every genuine list that followed it.
    tisig::checkdoc "$3" "${TI_PLAN_PUBKEY}" "ti-revocations"
    Pop $0
    StrCpy $1 $0 2
    ${If} $1 != "ok"
      ${Log} "The cached revocation list at $3: $0; ignoring it."
      Delete "$3"
      Goto rv_nocache
    ${EndIf}
    StrCpy $U_a "$3"
    StrCpy $U_b "$PLUGINSDIR\revocations-cache.u16"
    Call TiUtf8ToUtf16
    ${If} $2 == ""
      StrCpy $2 "$PLUGINSDIR\revocations-cache.u16"
      StrCpy $U_a "$2"
      StrCpy $U_b "issued"
      Call DocValue
      StrCpy $RevokeNote "not fetched: the backend couldn't be reached; the last list this machine saw (issued $U_out) was used"
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
  rv_nocache:
  ${If} $2 == ""
    StrCpy $RevokeNote "not checked: no list could be fetched or found on this machine, so only the plan's own age was checked"
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
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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

; Is $U_a made only of printable ASCII? -> $U_out 1 or 0. The characters
; are compared against a literal set because NSIS cannot turn a character
; into a number.
Function IsAsciiStr
  Push $0
  Push $1
  Push $2
  Push $3
  StrLen $0 "$U_a"
  StrCpy $U_out 1
  StrCpy $1 0
  ${Do}
    ${If} $1 >= $0
      ${Break}
    ${EndIf}
    StrCpy $3 $U_a 1 $1
    StrCpy $2 0
    ${Do}
      ${If} $2 >= ${ASCII_PRINTABLE_LEN}
        StrCpy $U_out 0                    ; not in the set: not ASCII
        ${Break}
      ${EndIf}
      StrCpy $U_b "${ASCII_PRINTABLE}" 1 $2
      ${If} $3 S== $U_b
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    ${If} $U_out = 0
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; A temporary folder the project's install command can read, or "" to
; leave TMP and TEMP alone -> $U_out.
;
; Python 2's pip joins %TEMP% as a byte string with file names as text and
; dies on any byte over 0x7f, so on an account whose name is not ASCII it
; can install nothing (docs/test-results.md, "Where the two refusals
; fire"). The 8.3 short name of that same folder is ASCII where the volume
; makes one -- C:\Users\JRGMLL~1\AppData\Local\Temp -- and is the same
; folder, so nothing moves and nothing is created.
;
; "" means "change nothing", for both reasons it can happen: %TEMP% is
; already ASCII (the usual case, and no machine should have its
; environment altered for nothing), or this volume has 8.3 names switched
; off and there is no ASCII spelling to use, which the `ascii` prerequisite
; has already refused before anything was installed.
Function AsciiTemp
  Push $0
  Push $1
  ReadEnvStr $0 "TEMP"
  StrCpy $U_a $0
  Call IsAsciiStr
  ${If} $U_out = 1
    StrCpy $U_out ""
    Goto at_done
  ${EndIf}
  ClearErrors
  GetFullPathName /SHORT $1 "$0"
  ${If} ${Errors}
  ${OrIf} $1 == ""
  ${OrIf} $1 S== $0
  ${OrIfNot} ${FileExists} "$1\*.*"
    StrCpy $U_out ""                       ; no other spelling of this folder
    Goto at_done
  ${EndIf}
  StrCpy $U_a $1
  Call IsAsciiStr
  ${If} $U_out = 1
    StrCpy $U_out $1
  ${Else}
    StrCpy $U_out ""
  ${EndIf}
  at_done:
  Pop $1
  Pop $0
FunctionEnd

; One check, $F1 kind and $F2.. its fields -> $U_out 1 if it passes.
; Unknown kinds never pass.
Function NeedCheckOne
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
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
  ${ElseIf} $F1 S== "ascii"
    ; ascii <path>, %VARIABLES% expanded: passes when the path can be
    ; handed to a program as plain ASCII. Not something to install -- it
    ; is how a `need` says a property of this machine has to hold
    ; (Python 2's pip and a non-ASCII %TEMP%, format.md "Prerequisites").
    ; The 8.3 short name counts, because where the volume makes one the
    ; engine hands *that* to the install command instead (AsciiTemp): the
    ; same folder, spelt in ASCII. A volume with 8.3 names switched off
    ; has no such spelling, and then the need really is missing.
    ExpandEnvStrings $R0 "$F2"
    StrCpy $U_a $R0
    Call IsAsciiStr
    StrCpy $R2 "as it is"
    ${If} $U_out = 0
      ClearErrors
      GetFullPathName /SHORT $R1 "$R0"
      ; It must be a real folder, spelt differently. GetShortPathName
      ; fails on a path that does not exist (measured: it returns nothing
      ; and ERROR_FILE_NOT_FOUND), and a caller must not be told a folder
      ; has an ASCII name because the lookup fell back to the long one.
      ${IfNot} ${Errors}
      ${AndIf} $R1 != ""
      ${AndIf} $R1 S!= $R0
      ${AndIf} ${FileExists} "$R1\*.*"
        StrCpy $U_a $R1
        Call IsAsciiStr
        StrCpy $R2 "as its 8.3 short name, $R1"
      ${EndIf}
    ${EndIf}
    ${Log} "  check ascii $F2 ($R2): $U_out"
  ${Else}
    ${Log} "  check $F1: not a check this installer knows; counts as missing"
  ${EndIf}
  nc_end:
  Pop $R5
  Pop $R4
  Pop $R3
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
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
      ; A catalogue `nwhy` is a sentence, not a label -- Ruby's is 225
      ; characters -- and at indent 6 the review page sets it in Courier
      ; New 8pt (tisig.c: indent >= 4 is monospace), where 225 characters
      ; are about 1500 px in a control near 730. Left to the control it
      ; broke into three lines ending on "minimal image."; wrapped at 74
      ; like the rest of the page, it ends on nine words. Same words, and
      ; the same wrap the Unix engine gives it.
      StrCpy $CapInd1 "      why: "
      StrCpy $CapInd2 "           "
      StrCpy $U_a $F1
      Call SumPara
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
    ${TiRead} $BH
    ${If} ${Errors}
      StrCpy $K "[end]"
    ${Else}
      IntOp $6 $6 + 1
      Call TiParseLine
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
        Call TiContains
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
  MessageBox MB_OK|MB_ICONINFORMATION "TiddlyInstall ${TI_VERSION}$\r$\n$\r$\n\
/S$\tinstall without asking (exit code 0 installed, 2 couldn't start, 3 failed)$\r$\n\
/log=PATH$\tappend a detailed log to PATH$\r$\n\
/record=PATH$\tuse this ti-record file$\r$\n\
/plan=PATH$\tuse this ti-plan file; it must be signed by the TiddlyInstall key$\r$\n\
/unsigned-plan$\taccept an unsigned /plan= file$\r$\n\
/backend=URL$\twhere to fetch records and plans$\r$\n\
/reinstall$\tinstall again even if this app, with these same settings, is already installed. Otherwise running the installer again starts the app (with /S it only says it is installed)$\r$\n$\r$\n\
A signed installer with no settings of its own takes none of /record=, /plan=, /unsigned-plan and /backend=: the signature is on the installer program, and must not be read as covering settings someone else supplies." /SD IDOK
  SetErrorLevel 0
  Quit
FunctionEnd

; Is this app fully installed in $AppDir with this record? $U_out = 1 if
; its .ti-installed marker (written last by a finished install, format.md
; section 5) names this appid and record, and its .ti-owner this appid.
Function IsInstalled
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  ${If} $RecHash == ""
    Goto ii_end
  ${EndIf}
  ${IfNot} ${FileExists} "$AppDir\.ti-installed"
  ${OrIfNot} ${FileExists} "$AppDir\launch.exe"
  ${OrIfNot} ${FileExists} "$AppDir\launch.txt"
    Goto ii_end
  ${EndIf}
  StrCpy $U_a $AppDir
  Call TiOwnerOf
  ${If} $U_out S!= $AppId
    Goto ii_end
  ${EndIf}
  ClearErrors
  FileOpen $0 "$AppDir\.ti-installed" r
  ${If} ${Errors}
    Goto ii_end
  ${EndIf}
  FileRead $0 $1
  ${TiTrimNL} $1
  ${If} $1 S== "ti-installed$\t1"
    ${Do}
      ClearErrors
      FileRead $0 $1
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${TiTrimNL} $1
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
; file name, .ti-installed can be checked offline. Looks where the record's
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
  Call TiIsB32
  ${If} $U_out = 0
    Goto oi_end
  ${EndIf}
  Delete "$PLUGINSDIR\ah.txt"
  StrCpy $U_a "$PLUGINSDIR\ah.txt"
  StrCpy $U_b "$RecHash/app"
  Call TiAppendUtf8
  StrCpy $U_a "$PLUGINSDIR\ah.txt"
  Call Sha256File
  ${If} $U_out == ""
    Goto oi_end
  ${EndIf}
  StrCpy $U_a $U_out
  StrCpy $U_b 12
  Call TiHexToB32
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
        StrCpy $U_b "ti"
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
      StrCpy $U_b "ti"
    ${ElseIf} $1 = 2
      StrCpy $U_a "system"
      StrCpy $U_b "ti"
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
          ${TiTrimNL} $U_b
          StrCpy $U_a $U_b 5
          ${If} $U_a S== "name$\t"
            StrCpy $AppName $U_b "" 5
            ${Break}
          ${EndIf}
        ${Loop}
        FileClose $0
      ${EndIf}
      tisig::cleanstr "$AppName"
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
  tisig::cleanstr "$FailMsg"
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
  ${TiGetOpt} "/log=" $LogPath
  ${If} ${Errors}
    StrCpy $LogPath ""
  ${EndIf}
  ClearErrors
  ; Write the review text to a file and install nothing. The screen is
  ; the one part of this engine no test could read: every suite checks
  ; what it *does*, and three faults shipped on what it *says* before
  ; anyone rendered it (tools/shot_windows_review.sh). This is how
  ; test_screen_windows.sh gets the text, and it is the same file the
  ; review page shows and the log keeps, so a test cannot pass against
  ; text nobody sees.
  ;
  ; Safe to ship: it reads the plan and writes what the review page
  ; would have said. It installs nothing, changes nothing and needs no
  ; rights the review page does not.
  ${TiGetOpt} "/ti-review=" $ReviewOut
  ${If} ${Errors}
    StrCpy $ReviewOut ""
  ${EndIf}
  ClearErrors
  ${TiGetOpt} "/ti-elevated" $0
  ${If} ${Errors}
    StrCpy $Elevated 0
  ${Else}
    StrCpy $Elevated 1
  ${EndIf}
  ${Log} "TiddlyInstall ${TI_VERSION}: $EXEPATH $Params"
  ClearErrors
  ${TiGetOpt} "/?" $0
  ${IfNot} ${Errors}
    Call Usage
  ${EndIf}
  ClearErrors
  ${TiGetOpt} "/help" $0
  ${IfNot} ${Errors}
    Call Usage
  ${EndIf}
  ClearErrors
  ${TiGetOpt} "/reinstall" $0
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
  ${TiGetOpt} "/unsigned-plan" $0
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
  StrCpy $PlanSigState "ok"
  StrCpy $RtState "none"
  StrCpy $RtIssued ""
  StrCpy $RtWhy ""
  StrCpy $PlanMaxAge ""
  StrCpy $AgeWarn ""
  StrCpy $RevokeNote ""
  StrCpy $ShaList "$PLUGINSDIR\shas.txt"

  StrCpy $Backend "${TI_BACKEND}"
  StrCpy $BackendGiven 0
  ClearErrors
  ${TiGetOpt} "/backend=" $OptBackend
  ${If} ${Errors}
    StrCpy $OptBackend ""
  ${Else}
    StrCpy $Backend $OptBackend
    StrCpy $BackendGiven 1
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
    ${FailWith} "Can't read the install plan $PlanFile."
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
    ${FailWith} "The install plan from $Backend is not the answer for $TokRuntime/$TokProject. Nothing was installed."
    Call InitFail
  ${EndIf}
  ; ...and, for a fetched plan, the answer to *this* request rather than a
  ; replay of an older one (design.md 7.1)
  Call CheckNonce
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  tisig::cleanstr "$AppName"
  Pop $AppName

  ; validate the header
  StrCpy $U_a $AppId
  StrCpy $U_b 12
  Call TiIsB32
  ${If} $U_out = 0
    ${FailWith} "The install plan's appid '$AppId' isn't 12 base32 characters."
    Call InitFail
  ${EndIf}
  StrCpy $U_a $RootName
  Call IsPlainName
  ${If} $U_out = 0
    ${FailWith} "The install plan's rootname '$RootName' isn't a plain folder name."
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
      ${FailWith} "The install plan's source file name '$SrcName' isn't a plain file name."
      Call InitFail
    ${EndIf}
  ${EndIf}
  ${If} $TgtLine = 0
    ${FailWith} "This app has no runtime setup for this version of Windows ($WinVer build $WinBuild, $Arch)."
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
  ; The review page used to open with "Machine: Windows 10 build 19045,
  ; amd64 (plan block 1)", which told a person what they already knew.
  ; It is still worth writing down, so it is written here, where the
  ; other engine has always written it (ti_log "Running as ... on ...").
  ${Log} "This machine: Windows $WinVer build $WinBuild, $Arch."
  ${Log} "Plan block $TgtNo matches."
  ; A plan carried in this installer may name something since withdrawn,
  ; or simply be old: the revocation list answers that where there is a
  ; network, and the plan's own `signed`/`maxage` where there is not.
  ; Both run before anything on this machine is changed.
  ; Is the runtime install script one we published? Decided from the
  ; plan and the key this installer carries -- no network, no catalogue
  ; (plugin-src/rtcheck.c, src/shared/rtscript.js). It changes nothing
  ; about the install; it decides what the screen may claim.
  tisig::rtverify "$PlanFile" "${TI_PLAN_PUBKEY}" "$TgtNo"
  Pop $0
  Pop $RtIssued
  StrCpy $1 $0 3
  ${If} $1 == "ok"
    StrCpy $RtState "ok"
  ${Else}
    StrCpy $1 $0 4
    ${If} $1 == "bad"
      StrCpy $RtState "bad"
    ${Else}
      StrCpy $RtState "none"
    ${EndIf}
    StrCpy $RtWhy $0 1024 5
  ${EndIf}
  ${Log} "Runtime script: $0"

  Call Revocations
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  Call CheckAge
  ${If} $Failed = 1
    Call InitFail
  ${EndIf}
  ${If} $TgtFail != ""
    ; A combination the catalogue knows cannot work. Nothing of the app
    ; has been touched, and the plan's own words say why; the marker is
    ; what the test harnesses read to tell a refusal from a broken
    ; install (tests/*/run.py, plan_fails).
    ${Log} "Refused before installing: $TgtFail"
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
    ${Log} "Refused before installing: $NdManualMsg"
    ${FailWith} "$NdManualMsg"
    Call InitFail
  ${EndIf}
  ${If} $NdMissing > 0
    StrCpy $NeedAdmin 1
  ${EndIf}

  ; administrator rights, if the plan needs them
  Call TiIsAdmin
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
    StrCpy $U_a "$Params /ti-elevated"
    Call TiRunElevated
    ${If} $U_out == "error"
      ${FailWith} "This install needs administrator rights, and Windows didn't grant them."
      Call InitFail
    ${EndIf}
    SetErrorLevel $U_out
    Quit
  ${EndIf}

  Call CapScan
  Call WriteSummary
  ${If} $ReviewOut != ""
    FileClose $SumH
    System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\summary.txt", w "$ReviewOut", i 0)i.r0'
    ${If} $0 = 0
      ${FailWith} "Could not write the review text to $ReviewOut."
      Call InitFail
    ${EndIf}
    Quit
  ${EndIf}
FunctionEnd

; "1 file" / "2 files": no "(s)" on a screen someone is asked to consent to.
; $U_a is the count, $U_b the singular noun; $U_out is the noun.
Function Plural
  ${If} $U_a = 1
    StrCpy $U_out $U_b
  ${Else}
    Push $0
    StrCpy $0 "s"
    StrCpy $U_out "$U_b$0"
    Pop $0
  ${EndIf}
FunctionEnd

; One command in $U_a, rendered onto the review page. It decides how to
; *show* a command and nothing else: whether a command is worth showing
; at all is the caller's question, and is deliberately kept out of here.
;
; It is wrapped, not cut, while it fits. Up to 2026-09-21 anything over
; 96 characters was replaced by its first 93 and "the whole command is
; at the end of the log", which meant a 103-character launch command --
; one wrapped line, and the most useful line on the page, since it is
; what the shortcut will run -- was hidden behind a pointer to a file.
; The cut is for the case it was written for: the worst command in the
; catalogue is Ruby's relocation step, 831 characters of shell on one
; line, which wrapped is thirteen lines of `ls | grep | head -1` that
; nobody can review -- and a page that cannot be reviewed teaches
; people to click through, which is the opposite of what it is for.
;
; ${TI_CMD_W} and ${TI_CMD_LINES} are the same numbers the other engine
; uses (src/installers/unix/ti-engine.sh, ti_cmd_line), so the two pages and
; the two logs break a command in the same places. These lines are
; indented four or more spaces, so tisig::richtext sets them in Courier
; New and the breaks hold; continuations are indented past the first
; line, so a wrapped command reads as one command and not as two; and a
; break never lands inside a quoted path, which matters here more than
; on the other engine because a Windows profile folder usually has a
; space in it. A run longer than the width is never broken, as
; everywhere else here: half a path is worse than a long one. The log
; has every command in full either way.
!define TI_CMD_W 74           ; wrap here
!define TI_CMD_IND 5          ; the first line starts in column 5
!define TI_CMD_CONT 9         ; and the rest in column 9
!define TI_CMD_LINES 4        ; more wrapped lines than this: shorten it
Function CmdLine
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $U_b
  Push $U_c
  ${SumCmd} "  $U_a"
  ; A label written over this command's first indent, so WHAT RUNS reads
  ; "Launch   <command>" rather than a sentence introducing one.
  StrCpy $7 "     "
  StrCpy $CmdCont "         "
  ${If} $CmdLabel != ""
    StrCpy $7 $CmdLabel
    StrCpy $CmdLabel ""
    StrCpy $CmdCont "           "
  ${EndIf}
  StrLen $0 $U_a
  ; The longest that still fits: the first line's room plus the rest's,
  ; and one space joining each pair of lines.
  IntOp $2 ${TI_CMD_W} - ${TI_CMD_CONT}
  IntOp $2 $2 * ${TI_CMD_LINES}
  IntOp $2 $2 + ${TI_CMD_CONT}
  IntOp $2 $2 - ${TI_CMD_IND}
  ${If} $0 > $2
    StrCpy $1 $U_a 93
    ${Sum} "$7$1..."
    ${Sum} "     ($0 characters in all; the whole command is at the end of the log)"
  ${Else}
    StrCpy $2 $U_a                         ; what is left to print
    StrCpy $3 $7                           ; this line's indent
    IntOp $4 ${TI_CMD_W} - ${TI_CMD_IND}   ; and its room
    ${Do}
      StrLen $0 $2
      ${If} $0 <= $4
        ${Sum} "$3$2"
        ${Break}
      ${EndIf}
      ; One scan of what is left: $5 is the last space outside quotes
      ; that still fits, $6 the first one after the width, $U_c the
      ; quote parity. Breaking at any space is what ti_wrap does and is
      ; wrong for a command: a Windows profile folder usually has a
      ; space in it, and
      ;
      ;   msiexec /a "C:\Users\John
      ;       Smith\AppData\Local\Temp\...\core.msi" /qn ...
      ;
      ; reads as two arguments when it is one path.
      StrCpy $5 0
      StrCpy $6 0
      StrCpy $U_c 0
      StrCpy $1 0
      ${Do}
        ${If} $1 >= $0
          ${Break}
        ${EndIf}
        StrCpy $U_b $2 1 $1
        ${If} $U_b S== "$\""
          IntOp $U_c $U_c !
        ${ElseIf} $U_b S== " "
        ${AndIf} $U_c = 0
          ${If} $1 < $4
            StrCpy $5 $1
          ${ElseIf} $6 = 0
            StrCpy $6 $1
          ${EndIf}
        ${EndIf}
        IntOp $1 $1 + 1
      ${Loop}
      ${If} $5 > 0
        StrCpy $1 $5
      ${ElseIf} $6 > 0
        ; a run longer than the line is never broken: half a path is
        ; worse than a long one
        StrCpy $1 $6
      ${Else}
        ${Sum} "$3$2"
        ${Break}
      ${EndIf}
      StrCpy $7 $2 $1
      ${Sum} "$3$7"
      IntOp $1 $1 + 1
      StrCpy $2 $2 "" $1
      StrCpy $3 $CmdCont
      IntOp $4 ${TI_CMD_W} - ${TI_CMD_CONT}
    ${Loop}
  ${EndIf}
  Pop $U_c
  Pop $U_b
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 35945651 -> "34.2 MB". Integer arithmetic, like everything else here.
Function HumanSize
  Push $0
  Push $1
  Call DecNum
  StrCpy $0 $U_out
  ${If} $0 < 1024
    StrCpy $U_out "$0 bytes"
  ${ElseIf} $0 < 1048576
    IntOp $1 $0 % 1024
    IntOp $1 $1 * 10
    IntOp $1 $1 / 1024
    IntOp $0 $0 / 1024
    StrCpy $U_out "$0.$1 kB"
  ${ElseIf} $0 < 1073741824
    IntOp $1 $0 % 1048576
    IntOp $1 $1 * 10
    IntOp $1 $1 / 1048576
    IntOp $0 $0 / 1048576
    StrCpy $U_out "$0.$1 MB"
  ${Else}
    IntOp $1 $0 % 1073741824
    IntOp $1 $1 * 10
    IntOp $1 $1 / 1073741824
    IntOp $0 $0 / 1073741824
    StrCpy $U_out "$0.$1 GB"
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; The host part of the URL in $U_a -> $U_out ("" if it has none). What a
; person wants near the top of the review page is who they are about to
; download from, not four 200-character URLs.
Function HostOf
  Push $0
  Push $1
  Push $2
  StrCpy $U_out ""
  StrCpy $0 0
  StrLen $2 $U_a
  ${Do}
    ${If} $0 >= $2
      Goto host_done
    ${EndIf}
    StrCpy $1 $U_a 3 $0
    ${If} $1 == "://"
      IntOp $0 $0 + 3
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $U_out $U_a "" $0
  StrCpy $0 0
  StrLen $2 $U_out
  ${Do}
    ${If} $0 >= $2
      ${Break}
    ${EndIf}
    StrCpy $1 $U_out 1 $0
    ${If} $1 == "/"
    ${OrIf} $1 == "?"
    ${OrIf} $1 == "#"
      StrCpy $U_out $U_out $0
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  ; user@host
  StrCpy $0 0
  StrLen $2 $U_out
  ${Do}
    ${If} $0 >= $2
      ${Break}
    ${EndIf}
    StrCpy $1 $U_out 1 $0
    ${If} $1 == "@"
      IntOp $0 $0 + 1
      StrCpy $U_out $U_out "" $0
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
host_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Is $U_b somewhere in $U_a? $U_out = 1 or 0.
Function StrHas
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out 0
  StrLen $2 $U_a
  StrLen $3 $U_b
  StrCpy $0 0
  ${Do}
    IntOp $1 $0 + $3
    ${If} $1 > $2
      ${Break}
    ${EndIf}
    StrCpy $1 $U_a $3 $0
    ${If} $1 S== $U_b
      StrCpy $U_out 1
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Add the host of the URL in $U_a to $SumHosts, once. $SumHosts is kept
; as ", a, b, " so a membership test is a plain substring search.
Function AddHost
  Push $0
  Push $1
  Call HostOf
  StrCpy $0 $U_out
  ${If} $0 != ""
    ${If} $SumHosts == ""
      StrCpy $SumHosts ", "
    ${EndIf}
    StrCpy $1 $U_a
    StrCpy $U_a $SumHosts
    StrCpy $U_b ", $0, "
    Call StrHas
    StrCpy $U_a $1
    ${If} $U_out == 0
      StrCpy $SumHosts "$SumHosts$0, "
      IntOp $SumHostN $SumHostN + 1
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; ", a, b, " -> "a, b"
Function HostList
  StrLen $U_out $SumHosts
  ${If} $U_out < 4
    StrCpy $U_out ""
  ${Else}
    IntOp $U_out $U_out - 4
    StrCpy $U_out $SumHosts $U_out 2
  ${EndIf}
FunctionEnd

; Which of the URLs collected in $CurU1/$CurOrigin is the place the
; current file really comes from. Same rule as the other engine's
; ti_origin_url, and the same reason (src/installers/unix/ti-engine.sh):
; the resolver writes a file's locations as [our copy,] the vendor's
; own URL, other people's mirrors of it, [our copy], and our copy is
; normally first on purpose, because plenty of old machines cannot
; complete a TLS handshake to the vendor and a mirror we serve over
; plain HTTP is the only way they get the file at all. So URL 1 is
; usually ours, and naming it answers nobody's question. Ours is the
; one on the host we are talking to; the first URL that is not on that
; host is the vendor's own, and that is the one the page names.
;
; With nothing but our own host in the list (a file only we have) the
; first URL is all there is, and it stops being counted as a mirror.
; A value padded on the right to $U_b characters, for the columns on the
; review screen. A value longer than its column is left alone: the row
; grows, rather than the value being cut to fit.
Function PadTo
  Push $0
  Push $1
  StrCpy $0 $U_a
  ${Do}
    StrLen $1 $0
    ${If} $1 >= $U_b
      ${Break}
    ${EndIf}
    StrCpy $0 "$0 "
  ${Loop}
  StrCpy $U_out $0
  Pop $1
  Pop $0
FunctionEnd

; A word with its first letter raised: a plan's `file` names are
; catalogue ids ("python"), and WHERE THINGS GO reads them as headings.
Function Cap1
  Push $0
  Push $1
  StrCpy $0 $U_a 1
  StrCpy $1 $U_a "" 1
  ${StrFilter} "$0" "+" "" "" $0
  StrCpy $U_out "$0$1"
  Pop $1
  Pop $0
FunctionEnd

; Does $U_a start with $U_b? Decides which mark a revocation note gets,
; and nothing else.
Function StrStarts
  Push $0
  StrLen $0 $U_b
  StrCpy $0 $U_a $0
  ${If} $0 S== $U_b
    StrCpy $U_out 1
  ${Else}
    StrCpy $U_out 0
  ${EndIf}
  Pop $0
FunctionEnd

; The repository in a github.com URL: the path segment after the owner.
; github.com hosts everybody, so the host on its own does not say whose
; release a file is; the repository does.
Function GhRepo
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $U_out ""
  StrCpy $0 $U_a
  StrLen $2 $0
  StrCpy $1 0
  ${Do}
    ${If} $1 >= $2
      Goto gh_done
    ${EndIf}
    StrCpy $3 $0 11 $1
    ${If} $3 S== "github.com/"
      IntOp $1 $1 + 11
      StrCpy $0 $0 "" $1
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  StrLen $2 $0
  StrCpy $1 0
  ${Do}
    ${If} $1 >= $2
      Goto gh_done
    ${EndIf}
    StrCpy $3 $0 1 $1
    ${If} $3 == "/"
      IntOp $1 $1 + 1
      StrCpy $0 $0 "" $1
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  StrLen $2 $0
  StrCpy $1 0
  ${Do}
    ${If} $1 >= $2
      ${Break}
    ${EndIf}
    StrCpy $3 $0 1 $1
    ${If} $3 == "/"
      StrCpy $0 $0 $1
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  StrCpy $U_out $0
  gh_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; A held DOWNLOADS row, printed once its origin is known. It cannot be
; printed when its `file` line is read, because the `url` lines that say
; where it comes from follow it. Where a file comes from is a host and a
; count of the other copies; the log keeps every URL in the order they
; are tried, so nothing here is the only record of anything.
Function FlushRow
  Push $0
  Push $1
  Call PickOrigin
  StrCpy $0 ""
  ${If} $CurOrigin != ""
    StrCpy $U_a $CurOrigin
    Call HostOf
    StrCpy $0 $U_out
    ${If} $0 S== "github.com"
      StrCpy $U_a $CurOrigin
      Call GhRepo
      ${If} $U_out != ""
        StrCpy $0 "$0 ($U_out)"
      ${EndIf}
    ${EndIf}
    ${If} $CurMirrors = 1
      StrCpy $0 "$0 or 1 mirror"
    ${ElseIf} $CurMirrors > 1
      StrCpy $0 "$0 or $CurMirrors mirrors"
    ${EndIf}
  ${ElseIf} $PackLen > 0
    StrCpy $0 "packed inside this installer"
  ${EndIf}
  ${If} $PendRow != ""
    StrLen $1 "$PendRow$0"
    ${If} $1 <= 74
      ${Sum} "$PendRow$0"
    ${Else}
      ${Sum} "$PendRow"
      StrCpy $CapInd1 "     "
      StrCpy $CapInd2 "     "
      StrCpy $U_a "$0"
      Call SumPara
    ${EndIf}
    ${If} $PendSha != ""
      ${Sum} "     SHA-256 $PendSha"
    ${EndIf}
  ${EndIf}
  StrCpy $PendRow ""
  StrCpy $PendSha ""
  StrCpy $CurU1 ""
  StrCpy $CurOrigin ""
  StrCpy $CurMirrors 0
  Pop $1
  Pop $0
FunctionEnd

Function PickOrigin
  ${If} $CurU1 != ""
  ${AndIf} $CurOrigin == ""
    StrCpy $CurOrigin $CurU1
    IntOp $CurMirrors $CurMirrors - 1
  ${EndIf}
FunctionEnd

; Close off the file whose URLs have just been read (second pass): the
; page gets the one place the file comes from, and a count of the other
; places that hold a copy of it. Seven URLs stacked one under the other
; is not evidence anybody reads -- it is the same wall of text that
; makes people stop reading the page at all -- and nothing is lost by
; counting them, because the log carries every URL in the order they
; are tried, exactly as it carries every command in full.
Function WriteFrom
  Call PickOrigin
  ${If} $CurOrigin != ""
    ${Sum} "     from   $CurOrigin"
    ${If} $CurMirrors = 1
      ${Sum} "     or     1 other copy of it, in the log"
    ${ElseIf} $CurMirrors > 1
      ${Sum} "     or     $CurMirrors mirrors of it, every one of them in the log"
    ${EndIf}
  ${EndIf}
  StrCpy $CurU1 ""
  StrCpy $CurOrigin ""
  StrCpy $CurMirrors 0
FunctionEnd

; Close off the file whose URLs have just been read (first pass): its
; origin goes in the host list, the rest into the mirror count.
Function SumOneFile
  Call PickOrigin
  ${If} $CurOrigin != ""
    StrCpy $U_a $CurOrigin
    Call AddHost
  ${EndIf}
  IntOp $SumMirrors $SumMirrors + $CurMirrors
  StrCpy $CurU1 ""
  StrCpy $CurOrigin ""
  StrCpy $CurMirrors 0
FunctionEnd

; Count one URL towards the current file: remember the first, and the
; first that is not on our own host.
Function CountUrl   ; $U_a = the URL
  Push $0
  Push $1
  StrCpy $1 $U_a
  ${If} $CurU1 == ""
    StrCpy $CurU1 $1
  ${EndIf}
  StrCpy $0 0
  ${If} $CurOrigin == ""
    Call HostOf
    ${If} $U_out S!= $BackendHost
      StrCpy $CurOrigin $1
      StrCpy $0 1
    ${EndIf}
  ${EndIf}
  ${If} $0 = 0
    IntOp $CurMirrors $CurMirrors + 1
  ${EndIf}
  StrCpy $U_a $1
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- what this install can do
;
; design.md 11.3 ("classify by capability, not by form"),
; docs/launch-shapes.md section 8, and the same code in the other engine
; (src/installers/unix/ti-engine.sh, "what this install can do"), where the
; reasoning is written out in full. In short: not "is this a standard
; installer?" -- any classification creates pressure to be classified as
; safe -- but "what can this installation do that an ordinary one
; cannot?". Every finding is read off the plan, or off the record the
; plan's `record` line is bound to by hash; anything this engine does
; not recognise is itself a finding; and no absence is ever claimed for
; a plan nothing vouches for.

; Add one word to $CapUnknown, once. $U_a is the word.
Function CapUnknownAdd
  Push $0
  ${If} $U_a != ""
    StrCpy $0 $U_a
    StrCpy $U_a ", $CapUnknown, "
    StrCpy $U_b ", $0, "
    Call StrHas
    ${If} $U_out = 0
      ${If} $CapUnknown == ""
        StrCpy $CapUnknown "$0"
      ${Else}
        StrCpy $CapUnknown "$CapUnknown, $0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; What an ordinary install *is*. This is the only place on the page the
; SHA-256 promise is made (2026-09-21): WHAT IT DOWNLOADS used to make
; it again and the `Sources:` line a third time, which is how a page
; teaches people to skim. It opens both branches rather than living in
; the "nothing found" one, because the findings branch is the common
; one -- an ordinary Python app trips one finding -- and a promise that
; only appears when nothing is found is one most people never see.
; Every file still prints its own `sha256` below.
!define TI_CAP_ORDINARY "An ordinary install unpacks the files it names, each one checked against a SHA-256 in it, into folders of its own, for you alone, and runs nothing but the runtime setup we wrote."

; Add one finding. $U_a is the sentence.
Function CapAdd
  ${If} $CapN = 0
    StrCpy $Cap1 $U_a
  ${ElseIf} $CapN = 1
    StrCpy $Cap2 $U_a
  ${ElseIf} $CapN = 2
    StrCpy $Cap3 $U_a
  ${ElseIf} $CapN = 3
    StrCpy $Cap4 $U_a
  ${ElseIf} $CapN = 4
    StrCpy $Cap5 $U_a
  ${ElseIf} $CapN = 5
    StrCpy $Cap6 $U_a
  ${ElseIf} $CapN = 6
    StrCpy $Cap7 $U_a
  ${Else}
    Return                     ; more than seven: the count still counts them
  ${EndIf}
  IntOp $CapN $CapN + 1
FunctionEnd

; Wrap prose onto the review page. $U_a is the text, $CapInd1 the first
; line's indent and $CapInd2 every following line's. A word longer than
; the line is left long rather than broken, as ti_wrap does.
!define TI_SUM_W 74
Function SumPara
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $5 $U_a
  StrCpy $6 $CapInd1
  ${Do}
    StrLen $0 $6
    IntOp $1 ${TI_SUM_W} - $0     ; room on this line
    StrLen $2 $5
    ${If} $2 <= $1
      ${Sum} "$6$5"
      ${Break}
    ${EndIf}
    StrCpy $3 0                   ; where to break
    StrCpy $4 0
    ${Do}
      ${If} $4 >= $2
        ${Break}
      ${EndIf}
      StrCpy $0 $5 1 $4
      ${If} $0 S== " "
        ${If} $4 <= $1
          StrCpy $3 $4
        ${ElseIf} $3 = 0
          StrCpy $3 $4            ; one word longer than the line
          ${Break}
        ${Else}
          ${Break}
        ${EndIf}
      ${EndIf}
      IntOp $4 $4 + 1
    ${Loop}
    ${If} $3 = 0
      ${Sum} "$6$5"
      ${Break}
    ${EndIf}
    StrCpy $0 $5 $3
    ${Sum} "$6$0"
    IntOp $3 $3 + 1
    StrCpy $5 $5 "" $3
    StrCpy $6 $CapInd2
  ${Loop}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Everything the findings are read from is in hand by the time this
; runs: the chosen block, the prerequisites this computer actually
; needs, the source line, and the record.
Function CapScan
  Push $0
  Push $1
  Push $2
  StrCpy $CapN 0
  ${If} $CapUnknown != ""
    StrCpy $U_a "it asks for things this installer does not recognise ($CapUnknown). We cannot tell you what they do, and a script we cannot read all of is not one we can describe."
    Call CapAdd
  ${EndIf}
  StrCpy $0 0                     ; has administrator rights been accounted for?
  ${If} $RootMode == "system"
    StrCpy $U_a "it installs for every user on this computer, into $Root, and needs administrator rights to do it."
    Call CapAdd
    StrCpy $0 1
  ${EndIf}
  ${If} $NdMissing > 0
    StrCpy $U_a "it installs $NdLabels for the whole computer, as administrator. That stays behind when this app is uninstalled."
    Call CapAdd
    StrCpy $0 1
  ${EndIf}
  ${If} $NeedAdmin = 1
  ${AndIf} $0 = 0
    StrCpy $U_a "it needs administrator rights: this script's block asks for them."
    Call CapAdd
  ${EndIf}
  ; The app's own source is the one download allowed to go unpinned
  ; (format.md, "Sources without a stored hash").
  ${If} $SrcLine > 0
  ${AndIf} $SrcSha == "-"
    StrCpy $U_a "the project's own files carry no checksum in this script: they are named by a commit id and fetched over HTTPS, and that is the whole of the check on them."
    Call CapAdd
  ${EndIf}
  ${If} $TgtInstall != ""
    ; Whose command it is. The record says: absent, `default` or
    ; `default:<rule>` is the catalogue's, anything else the
    ; publisher's; with no record at all we cannot say, and say that.
    StrCpy $1 0                   ; 1: the command is ours
    ${If} $HasRecord = 1
      ${If} $RecInstall == ""
      ${OrIf} $RecInstall == "default"
        StrCpy $1 1
      ${Else}
        StrCpy $U_a $RecInstall
        StrCpy $U_b "default:"
        Call TiStartsWith
        ${If} $U_out = 1
          StrCpy $1 1
        ${EndIf}
      ${EndIf}
      ${If} $1 = 0
        StrCpy $U_a "one of the commands that runs while installing was written by whoever published this app, not by us. What it does is not something we can tell you; the command itself is in the log, in full, before anything is fetched."
        Call CapAdd
      ${EndIf}
    ${Else}
      StrCpy $U_a "nothing here says who wrote the command that installs the project, so we cannot tell you whether it is ours or the publisher's. Treat it as the publisher's and read it."
      Call CapAdd
    ${EndIf}
    ; launch-shapes.md recommendation 7: an `install` line hands a
    ; package manager the job of choosing what else to download and
    ; run, a few lines under "each one is checked against the SHA-256
    ; below". It is the largest unpinned thing we do, and until
    ; 2026-09-21 the page said nothing about it. Naming the manager is
    ; not an analysis of shell: the record has already said the command
    ; is ours. Anything unrecognised gets the wording that admits we do
    ; not know, never the wording that says there is nothing to know.
    StrCpy $2 ""
    ${If} $1 = 1
      StrCpy $U_a $TgtInstall
      StrCpy $U_b "-m pip "
      Call StrHas
      ${If} $U_out = 1
        StrCpy $2 "pip"
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "npm"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "npm"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "bundle"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "bundler"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "gem"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "RubyGems"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "composer"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "Composer"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "cargo"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "cargo"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "\go.exe"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "Go's module fetcher"
        ${EndIf}
      ${EndIf}
      ${If} $2 == ""
        StrCpy $U_a $TgtInstall
        StrCpy $U_b "dotnet"
        Call StrHas
        ${If} $U_out = 1
          StrCpy $2 "the .NET SDK, which restores NuGet packages"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $2 != ""
      StrCpy $U_a "installing the project runs $2, which works out what the project depends on, downloads it and runs its code. The runtime setup names none of that, and no SHA-256 in it covers any of it."
    ${Else}
      StrCpy $U_a "what the command that installs the project reaches for, we cannot say. Anything it downloads is decided while you install: this script does not name it and no SHA-256 here covers it."
    ${EndIf}
    Call CapAdd
  ${EndIf}
  ${Log} "What this install can do that an ordinary one cannot: $CapN found."
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The section, both claims, one code path. The capability sentence and
; the provenance sentence are different claims -- one about the
; installation, one about the program -- and they are written together
; so that no later change can render one without the other
; (launch-shapes.md section 8, "Placement").
Function CapFindings
  ; Just the findings. The paragraph that used to lead them is now the
  ; generated bullet list above, and the two claims that used to trail
  ; them -- that nothing vouches for an unsigned recipe, and that we did
  ; not write the program -- are in BEFORE YOU TRUST IT, which is where a
  ; reader looking for either would go.
  Push $0
  StrCpy $CapInd1 "  ! "
  StrCpy $CapInd2 "    "
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $CapN
      ${Break}
    ${EndIf}
    ${If} $0 = 0
      StrCpy $U_a $Cap1
    ${ElseIf} $0 = 1
      StrCpy $U_a $Cap2
    ${ElseIf} $0 = 2
      StrCpy $U_a $Cap3
    ${ElseIf} $0 = 3
      StrCpy $U_a $Cap4
    ${ElseIf} $0 = 4
      StrCpy $U_a $Cap5
    ${ElseIf} $0 = 5
      StrCpy $U_a $Cap6
    ${Else}
      StrCpy $U_a $Cap7
    ${EndIf}
    Call SumPara
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $CapInd1 "  "
  StrCpy $CapInd2 "  "
  Pop $0
FunctionEnd

; "One", "Two", ... for a count a sentence begins with.
Function CapNumber
  ${If} $U_a = 1
    StrCpy $U_out "One"
  ${ElseIf} $U_a = 2
    StrCpy $U_out "Two"
  ${ElseIf} $U_a = 3
    StrCpy $U_out "Three"
  ${ElseIf} $U_a = 4
    StrCpy $U_out "Four"
  ${ElseIf} $U_a = 5
    StrCpy $U_out "Five"
  ${ElseIf} $U_a = 6
    StrCpy $U_out "Six"
  ${ElseIf} $U_a = 7
    StrCpy $U_out "Seven"
  ${Else}
    StrCpy $U_out $U_a
  ${EndIf}
FunctionEnd

; The transparency text (design.md section 3). Same shape as the other
; engine's (src/installers/unix/ti-engine.sh, "the review screen's shape"): what
; someone needs to decide with at the top, the evidence below it. The
; file is plain text -- it is what goes in the log -- and tisig::richtext
; marks it up for the rich edit on the review page.
Function WriteSummary
  Push $0
  Push $1
  Push $2

  ; First pass: how much would be downloaded, from where, and how many
  ; commands would run. None of it is printed until it can be summed up.
  ;
  ; "From where" is one host per file, not every host that keeps a copy
  ; (PickOrigin, above): four of them on one line is the kind of detail
  ; that gets a screen skimmed instead of read. $SumMirrors is what is
  ; left over, and the page owns up to it rather than listing it.
  StrCpy $U_a $Backend
  Call HostOf
  StrCpy $BackendHost $U_out
  StrCpy $SumHosts ""
  StrCpy $SumHostN 0
  StrCpy $SumBytes 0
  StrCpy $SumFiles 0
  StrCpy $SumUnsized 0
  StrCpy $SumRuns 0
  StrCpy $SumMirrors 0
  StrCpy $CurU1 ""
  StrCpy $CurOrigin ""
  StrCpy $CurMirrors 0
  Call OpenBlock
  ${Do}
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      Call SumOneFile
      IntOp $SumFiles $SumFiles + 1
      StrCpy $U_a $F4
      Call DecNum
      IntOp $SumBytes $SumBytes + $U_out
    ${ElseIf} $K S== "url"
      StrCpy $U_a $F1
      Call CountUrl
    ${ElseIf} $K S== "step"
      ${If} $F1 S== "run"
        IntOp $SumRuns $SumRuns + 1
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $BH
  Call SumOneFile
  ${If} $SrcLine > 0
    IntOp $SumFiles $SumFiles + 1
    StrCpy $U_a $SrcSize
    Call DecNum
    IntOp $SumBytes $SumBytes + $U_out
    ; A source with no stored SHA-256 has no size either, and its `0` is
    ; not a measurement: GitHub makes the archive when it is asked for
    ; it, so nobody writing the plan could know how big it is (format.md,
    ; "Sources without a stored hash"). Every total then says "more
    ; than", because a confident total that leaves a file out is the same
    ; lie as a confident "0 bytes" for the file itself.
    ${If} $SrcSha == "-"
    ${OrIf} $SrcSha == ""
      StrCpy $SumUnsized 1
    ${EndIf}
    ${If} $SrcUrl1 != ""
      StrCpy $U_a $SrcUrl1
      Call AddHost
    ${EndIf}
  ${EndIf}

  FileOpen $SumH "$PLUGINSDIR\summary.txt" w
  FileWriteWord $SumH 0xFEFF
  FileOpen $CmdH "$PLUGINSDIR\commands.txt" w
  FileWriteWord $CmdH 0xFEFF
  ${SumCmd} "Every command in full:"
  FileOpen $UrlH "$PLUGINSDIR\urls.txt" w
  FileWriteWord $UrlH 0xFEFF
  ${SumUrl} "Every download location, in the order they are tried:"
  ; the second pass fills in the rest; the counters start again for it
  StrCpy $CurU1 ""
  StrCpy $CurOrigin ""
  StrCpy $CurMirrors 0
  ; The screen's shape. Five sections, each answering one question a
  ; person deciding actually has: what will happen, what to be careful
  ; of, what is fetched, where it lands, what runs. Settled with the
  ; operator on 2026-09-23 against a rendered screen and not a diff,
  ; which is the only way anyone has ever found a fault in this text.
  ; ti-engine.sh prints the same sections, in the same order, in the
  ; same words: two engines saying it differently is two chances to say
  ; it wrong.
  ;
  ; What went: INSTALL SUMMARY, a table that repeated the four sections
  ; around it, and the paragraphs under TRUST AND SECURITY, which made
  ; the same point at three lengths. Nothing it held was dropped -- the
  ; source, the mirror count, the install record and the reason
  ; administrator rights are wanted are folded into the sections below,
  ; each one now next to the thing it qualifies.
  StrCpy $CapInd1 ""
  StrCpy $CapInd2 ""
  StrCpy $U_a 'TiddlyInstall - Review before installing "$AppName"'
  Call SumPara
  ${Sum} "NOTHING HAS BEEN CHANGED YET."
  ${If} $CapN > 0
    ${Sum} ""
    ${Sum} "BEYOND AN ORDINARY INSTALL"
    Call CapFindings
  ${EndIf}

  ; Anything unusual, first, where the decision is made. Every one of
  ; these is also said again, in full, in its own section below.
  ;
  ; The architecture note is worked out BEFORE the heading, and the
  ; heading is guarded on the note rather than on $TgtRtArch. They are
  ; not the same condition: $TgtRtArch is set on every plan made since
  ; 2026-09-20, the ordinary matching-architecture case included, and
  ; ArchNote is empty there. Guarding the heading on $TgtRtArch alone
  ; printed a bare "BEFORE YOU SAY YES" with nothing under it on the
  ; commonest install there is (seen on Windows 8.1, 2026-09-21). A
  ; warning block that is routinely empty teaches the reader that the
  ; block means nothing, and this is the block that carries an unsigned
  ; plan, a withdrawn build and a prerequisite that will stop the
  ; install. A heading and its content get one condition, never two.
  StrCpy $1 ""
  ${If} $TgtRtArch != ""
    Call ArchNote
    StrCpy $1 $U_out
  ${EndIf}
  StrCpy $0 0
  ${If} $PlanWarn != ""
    ${Sum} ""
    ${Sum} "WARNINGS"
    StrCpy $0 1
    ${Sum} "!! $PlanWarn"
  ${EndIf}
  ${If} $AgeWarn != ""
    ${If} $0 = 0
      ${Sum} ""
      ${Sum} "WARNINGS"
      StrCpy $0 1
    ${EndIf}
    ${Sum} "!! $AgeWarn"
  ${EndIf}
  ; Administrator rights and an unpinned source left this block on
  ; 2026-09-21: they are capabilities, not alarms, and WHAT THIS INSTALL
  ; CAN DO now carries them with their consequence attached. Saying them
  ; twice would be the page repeating itself, which is the one thing its
  ; shape rules forbid. What is left is what a capability statement
  ; cannot hold: nobody can be named for this file, or the build is not
  ; this computer's architecture.
  ; Not the unsigned case any more. BEFORE YOU TRUST IT says it with the
  ; file's SHA-256 and the one comparison worth making, and a warning
  ; that repeats a line three inches below it teaches the reader to skip
  ; both. It is also the commonest state there is, and a WARNINGS
  ; heading that is nearly always present is a heading that means
  ; nothing by the time something real goes under it.
  ${If} $1 != ""
    ${If} $0 = 0
      ${Sum} ""
      ${Sum} "WARNINGS"
      StrCpy $0 1
    ${EndIf}
  ${EndIf}
  ${If} $1 != ""
    ${Sum} "!  The runtime being installed is not this machine's architecture$1"
  ${EndIf}

  ; ---- WHAT WILL HAPPEN. Generated, never fixed: a reassuring list
  ; that does not change when the install does would be the most
  ; misleading thing on this screen.
  ${Sum} ""
  ${Sum} "WHAT WILL HAPPEN"
  ${If} $SumFiles > 0
    StrCpy $U_a $SumBytes
    Call HumanSize
    StrCpy $0 $U_out
    ${If} $SumUnsized = 1
      StrCpy $0 "more than $0"
    ${EndIf}
    StrCpy $U_a $SumFiles
    StrCpy $U_b "file"
    Call Plural
    StrCpy $CapInd1 "  Download   "
    StrCpy $CapInd2 "             "
    ${If} $PackLen > 0
      StrCpy $U_a "up to $SumFiles $U_out, $0, each checked against a SHA-256; files packed inside this installer are used instead of downloading them"
    ${Else}
      StrCpy $U_a "$SumFiles $U_out, $0, each checked against a SHA-256"
    ${EndIf}
    Call SumPara
  ${EndIf}
  ${If} $RootMode == "system"
    StrCpy $3 "for every user on this machine"
  ${Else}
    StrCpy $3 "for your user only"
  ${EndIf}
  ${If} $NdMissing > 0
    StrCpy $3 "$3; needs admin rights, to install $NdLabels for the whole computer"
  ${ElseIf} $NeedAdmin = 1
    StrCpy $3 "$3; needs admin rights"
  ${Else}
    StrCpy $3 "$3; no admin rights"
  ${EndIf}
  StrCpy $CapInd1 "  Install    "
  StrCpy $CapInd2 "             "
  StrCpy $U_a "$3; PATH unchanged"
  Call SumPara
  ${If} $TgtRuntime != ""
    StrCpy $CapInd1 "  Runtime    "
    StrCpy $CapInd2 "             "
    ${If} $TgtRtArch == ""
      StrCpy $U_a $TgtRuntime
      Call Cap1
      StrCpy $U_a "$U_out, in its own folder"
    ${Else}
      Call ArchWords
      StrCpy $0 $U_out
      Call ArchNote
      StrCpy $4 "$0$U_out"
      StrCpy $U_a $TgtRuntime
      Call Cap1
      StrCpy $U_a "$U_out, $4, in its own folder"
    ${EndIf}
    Call SumPara
  ${EndIf}
  ${If} $RecSource != ""
    StrCpy $CapInd1 "  Source     "
    StrCpy $CapInd2 "             "
    StrCpy $U_a "$RecSource"
    Call SumPara
  ${EndIf}
  ; "Installs: test b" over "Project: test_b" is two lines saying one
  ; thing. The project name earns a line of its own only when the screen
  ; does not already carry it, and it usually does: it is either the
  ; app's name with the punctuation changed, or the package `Source`
  ; names in full. Both are compared with the case and the punctuation
  ; taken out, which is the whole of the difference in practice.
  ${If} $Project != ""
    ${StrFilter} "$Project" "12-" "" "" $0
    ${StrFilter} "$AppName" "12-" "" "" $1
    ${If} $0 != ""
    ${AndIf} $0 S!= $1
      ${StrFilter} "$RecSource" "12-" "" "" $2
      StrCpy $U_a $2
      StrCpy $U_b $0
      Call StrHas
      ${If} $U_out = 0
        ${Sum} "  Project    $Project"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $Menu == "0"
    StrCpy $4 ""
  ${Else}
    StrCpy $4 "a Start menu entry"
  ${EndIf}
  ${If} $WantDesktop == "1"
    ${If} $4 == ""
      StrCpy $4 "a desktop shortcut"
    ${Else}
      StrCpy $4 "$4, a desktop shortcut"
    ${EndIf}
  ${EndIf}
  ${If} $4 == ""
    StrCpy $4 "an uninstaller"
  ${Else}
    StrCpy $4 "$4 and an uninstaller"
  ${EndIf}
  StrCpy $CapInd1 "  Adds       "
  StrCpy $CapInd2 "             "
  StrCpy $U_a "$4"
  Call SumPara

  ; ---- BEFORE YOU TRUST IT. One item per claim, each marked with how
  ; much it is worth, and none of them said twice. The marks are three
  ; wide so every continuation lands in the same column: `!` worth
  ; stopping on, `ok` a claim that held, `--` something nobody here
  ; could check. ASCII, because the line painters measure in characters
  ; and an old console does not have the glyphs.
  ${Sum} ""
  ${Sum} "BEFORE YOU TRUST IT"
  ; The mark hangs in the margin and the text starts at column five, as
  ; it does in the other engine. The spaces are for a terminal; here
  ; they collapse, so tisig.c's mark_cols reads this shape and asks
  ; RichEdit for a real hanging indent instead.

  ; Whose program this is. Always first and always present: a reader who
  ; gets through the rest of this section -- every file checked against
  ; a SHA-256, who signed what, where it all goes -- can reasonably come
  ; away thinking we vetted the program. We have never looked at it.
  StrCpy $CapInd1 "  !  "
  StrCpy $CapInd2 "     "
  StrCpy $U_a 'TiddlyInstall did not write or review "$AppName". Install it only if you trust its publisher.'
  Call SumPara

  ; The installer file itself. A signature on it is not a word about the
  ; program in it, and "Signed by TiddlyInstall" invites exactly that
  ; reading -- most of all in mode A, where the name on the certificate
  ; is ours. So where there is a signer, the line says what it covers.
  ${Sum} ""
  ${If} $SignedBy != ""
    ; `--` and not `ok`: the legend above says `ok` is a claim that held,
    ; and nothing here held it. FindBlock sets $SignedBy from the PE
    ; certificate table having a non-zero offset and size, and GetSigner
    ; reads the subject name out of that table -- no digest, no chain, no
    ; WinVerifyTrust anywhere in this tree. The name is whatever the
    ; certificate says, which is whatever whoever attached it chose.
    StrCpy $CapInd1 "  -- "
    StrCpy $CapInd2 "     "
    StrCpy $U_a "This file carries a certificate naming $SignedBy. Nothing here checked that signature: Windows checks it in the file's Properties, under Digital Signatures, and when the file carries a mark of the web. If it holds, it covers this installer file, not the program it installs. Either way, compare its SHA-256 with the one shown where you downloaded it:"
    Call SumPara
  ${Else}
    StrCpy $CapInd1 "  !  "
    StrCpy $CapInd2 "     "
    StrCpy $U_a "This installer is unsigned, so Windows cannot tell you who made it. Compare its SHA-256 with the one shown where you downloaded it:"
    Call SumPara
  ${EndIf}
  ; The hash prints either way. It is the one check on this screen a
  ; reader can act on, and it does not depend on anything here having
  ; verified anything -- so a certificate nobody checked must not be able
  ; to delete it, which is what it did while the branch above owned it.
  StrCpy $U_a "$EXEPATH"
  Call Sha256File
  ${If} $U_out != ""
    ${Sum} "     $U_out"
  ${EndIf}

  ; The runtime install script. A signature is worth something only when
  ; the thing checking it is not the thing being vouched for, so the
  ; three cases do not share a headline:
  ;
  ;   proved   -- the steps are ours, proved against a signed Merkle
  ;               root by this file with the key it carries. No network,
  ;               no catalogue, and nothing here had to trust the page
  ;               that built it.
  ;   fetched  -- this engine is intact and the network is not, so a
  ;               script altered on the way is refused.
  ;   embedded -- the script, the key and the code doing the checking are
  ;               one file. Whoever could change one could change all
  ;               three, so it is not a second opinion and gets no ok.
  ;
  ; Guarded on the key id: TI_PLAN_KEYID is "?" when a base is built
  ; without a signing key, and an unguarded line would name a key nobody
  ; has.
  ${Sum} ""
  StrCpy $CapInd1 "  -- "
  StrCpy $CapInd2 "     "
  ${If} $RtState == "ok"
    ${If} "${TI_PLAN_KEYID}" != "?"
      StrCpy $U_a "Runtime setup is signed by TiddlyInstall (key ${TI_PLAN_KEYID}), verified offline. Covers the downloads, their hashes and setup commands - not the launch command, which the builder wrote."
    ${Else}
      StrCpy $U_a "Runtime setup is signed by TiddlyInstall, verified offline. Covers the downloads, their hashes and setup commands - not the launch command, which the builder wrote."
    ${EndIf}
    Call SumPara
    ${If} $RtIssued != ""
      ${Sum} "     Published $RtIssued."
    ${EndIf}
  ${ElseIf} $RtState == "bad"
    StrCpy $CapInd1 "  !  "
    StrCpy $U_a "Runtime setup claims to be ours and the claim does not hold: $RtWhy. Treat this file as altered."
    Call SumPara
  ${ElseIf} $PlanSigState == "ok"
  ${AndIf} "${TI_PLAN_KEYID}" != "?"
  ${AndIf} $PlanKind == "fetched"
    StrCpy $U_a "Runtime setup is signed by TiddlyInstall (key ${TI_PLAN_KEYID}), fetched and checked here before any of it was read, so a script altered on the way would have been refused."
    Call SumPara
  ${ElseIf} $PlanSigState == "ok"
  ${AndIf} "${TI_PLAN_KEYID}" != "?"
    StrCpy $CapInd1 "  -- "
    StrCpy $U_a "Runtime setup carries a TiddlyInstall signature (key ${TI_PLAN_KEYID}), checked by this file against a key inside this file. It is worth what the file is worth, so it is not a second opinion: the SHA-256 above is."
    Call SumPara
  ${ElseIf} $PlanSigState == "unsigned"
    ; The ordinary state of an installer built in a page, which has no
    ; key to sign with. Said once, plainly.
    StrCpy $CapInd1 "  -- "
    StrCpy $U_a "Runtime setup is not signed: only our build server holds the key, and a page building in a browser cannot reach it. What it does is under WHAT RUNS in full, and every file is checked against the SHA-256 beside it - but those hashes are the setup script's own."
    Call SumPara
  ${ElseIf} $PlanWarn != ""
    StrCpy $CapInd1 "  -- "
    StrCpy $U_a "Nothing vouches for the runtime setup, so what this screen says is only what the setup itself says. See WARNINGS."
    Call SumPara
  ${ElseIf} $PlanKind != "embedded"
    StrCpy $CapInd1 "  -- "
    StrCpy $U_a "Runtime setup came from $PlanSrc, and nothing here can say who wrote it."
    Call SumPara
  ${EndIf}
  ${If} $PlanSigned != ""
  ${AndIf} $PlanSigState != "ok"
  ${AndIf} $RtState != "ok"
    StrCpy $CapInd1 "     "
    StrCpy $U_a "Written $PlanSigned, by whoever built this installer."
    Call SumPara
  ${EndIf}

  ; What was withdrawn since. The note says which of the two happened;
  ; the mark says whether anybody checked.
  ${If} $RevokeNote != ""
    ${Sum} ""
    StrCpy $U_a $RevokeNote
    StrCpy $U_b "checked"
    Call StrStarts
    ${If} $U_out = 1
      StrCpy $CapInd1 "  ok "
    ${Else}
      StrCpy $CapInd1 "  -- "
    ${EndIf}
    StrCpy $CapInd2 "     "
    StrCpy $U_a "Revocations $RevokeNote"
    Call SumPara
  ${EndIf}
  ${If} $ModeA = 1
    ${Sum} ""
    StrCpy $CapInd1 "  ok "
    StrCpy $CapInd2 "     "
    StrCpy $U_a "Mode A: this installer carries no choices of its own and installs only the app its file name names, from ${TI_BACKEND}."
    Call SumPara
  ${EndIf}

  ${Sum} ""
  StrCpy $CapInd1 "  "
  StrCpy $CapInd2 "  "
  StrCpy $U_a "Choices came from $MetaSrc -- what was picked in the web client. The setup under WHAT RUNS is what carries them out."
  Call SumPara
  ; Everything here can be read without running the file, which is worth
  ; saying on the screen you only reach by running it.
  ${Sum} ""
  StrCpy $U_a "Verify without running: drop this file on ${TI_BACKEND}/#verify"
  Call SumPara
  ${If} $NdCount > 0
    ${Sum} ""
    Call NeedSummary
  ${EndIf}

  ; ---- DOWNLOADS. One line per file and one for its hash. A row cannot
  ; be printed when its `file` line is read, because the `url` lines that
  ; say where it comes from follow it: the row is held in $PendRow and
  ; flushed by FlushRow once the origin is known.
  ${Sum} ""
  ${Sum} "DOWNLOADS"
  ${If} $SumFiles = 0
    ${Sum} "  Nothing to download."
  ${ElseIf} $TgtInstall != ""
    ; What the SHA-256 check does *not* reach: an `install` line hands a
    ; package manager the job of choosing and running more code.
    StrCpy $CapInd1 "  "
    StrCpy $CapInd2 "  "
    StrCpy $U_a "Installing the project downloads more than these, and nothing in this list covers those: see BEYOND AN ORDINARY INSTALL, at the top."
    Call SumPara
  ${EndIf}
  StrCpy $1 ""
  StrCpy $2 0
  StrCpy $PendRow ""
  StrCpy $PendSha ""
  Call OpenBlock
  ${Do}
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      Call FlushRow
      StrCpy $CurName $F1
      StrCpy $U_a $F1
      Call FolderHash
      StrCpy $CurDir "$Root\$U_out"
      StrCpy $CurFile "$DlDir\$F2"
      IntOp $2 $2 + 1
      ; What this file *is*, from where it sits in the plan and never
      ; from its name: the `file` whose name is the runtime's id is the
      ; runtime; one whose folder goes on PATH is a companion the recipe
      ; requires; every other one is part of the runtime's own setup.
      ${If} $F1 S== $TgtRtName
        StrCpy $U_a $F1
        Call Cap1
        StrCpy $FileRole "$U_out runtime"
      ${Else}
        StrCpy $U_a $CompDirs
        StrCpy $U_b ", $F1, "
        Call StrHas
        ${If} $U_out = 1
          StrCpy $FileRole "a tool the install needs"
        ${Else}
          StrCpy $FileRole "runtime part"
        ${EndIf}
      ${EndIf}
      StrCpy $U_a "$FileRole"
      StrCpy $U_b 17
      Call PadTo
      StrCpy $PendRow "  $2. $U_out "
      StrCpy $U_a $F4
      Call HumanSize
      StrCpy $U_a $U_out
      StrCpy $U_b 10
      Call PadTo
      StrCpy $PendRow "$PendRow$U_out "
      StrCpy $PendSha $F3
      ${SumUrl} "  $F2"
    ${ElseIf} $K S== "url"
      StrCpy $U_a $F1
      Call CountUrl
      ${SumUrl} "    $F1"
    ${EndIf}
  ${Loop}
  FileClose $BH
  Call FlushRow
  ${If} $SrcLine > 0
    IntOp $2 $2 + 1
    StrCpy $U_a "Application"
    StrCpy $U_b 17
    Call PadTo
    StrCpy $PendRow "  $2. $U_out "
    ${If} $SrcSha == "-"
      ; No stored hash means no size either, and "0 bytes" is a
      ; measurement nobody took (format.md, "Sources without a stored
      ; hash").
      StrCpy $U_a "size unknown"
      StrCpy $PendSha ""
    ${Else}
      StrCpy $U_a $SrcSize
      Call HumanSize
      StrCpy $U_a $U_out          ; HumanSize answers in $U_out; PadTo reads $U_a
      StrCpy $PendSha $SrcSha
    ${EndIf}
    StrCpy $U_b 10
    Call PadTo
    StrCpy $PendRow "$PendRow$U_out "
    StrCpy $CurU1 $SrcUrl1
    StrCpy $CurMirrors 1
    ${If} $SrcUrl1 != ""
      ${SumUrl} "  $SrcName"
      ${SumUrl} "    $SrcUrl1"
    ${EndIf}
    Call FlushRow
    ${If} $SrcSha == "-"
      ${Sum} "     no stored SHA-256: identified by its commit, fetched over HTTPS"
    ${EndIf}
  ${EndIf}
  ${If} $PackLen > 0
    ${Sum} ""
    ${Sum} "  Files packed inside this installer are used instead of downloading them."
  ${EndIf}

  ; ---- WHERE THINGS GO.
  ${Sum} ""
  ${Sum} "WHERE THINGS GO"
  ${Sum} "  App         $AppDir"
  Call OpenBlock
  ${Do}
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      StrCpy $1 $F1
      StrCpy $U_a $F1
      Call Cap1
      StrCpy $U_a $U_out
      StrCpy $U_b 12
      Call PadTo
      StrCpy $3 $U_out
      StrCpy $U_a $F1
      Call FolderHash
      ${Sum} "  $3$Root\$U_out"
    ${EndIf}
  ${Loop}
  FileClose $BH
  StrCpy $CapInd1 "  Shortcuts   "
  StrCpy $CapInd2 "              "
  ${If} $Menu == "0"
    StrCpy $U_a "none in the Start menu: this app asks for no entry"
    ${If} $WantDesktop == "1"
      StrCpy $U_a "$U_a, but a desktop shortcut '$SafeName'"
    ${EndIf}
    Call SumPara
    StrCpy $CapInd1 "  Start it     "
    StrCpy $U_a "$AppDir\launch.exe, or run this installer again"
    Call SumPara
  ${Else}
    ${If} $RootMode == "system"
      StrCpy $U_a "Start menu folder '$SafeName' for all users, holding '$SafeName' and 'Uninstall $SafeName'"
    ${Else}
      StrCpy $U_a "Start menu folder '$SafeName', holding '$SafeName' and 'Uninstall $SafeName'"
    ${EndIf}
    ${If} $WantDesktop == "1"
      StrCpy $U_a "$U_a, and a desktop shortcut '$SafeName'"
    ${EndIf}
    Call SumPara
  ${EndIf}
  StrCpy $CapInd1 "  Uninstall   "
  StrCpy $CapInd2 "              "
  ${If} $RootMode == "system"
    StrCpy $U_a "$AppDir\uninstall.exe, listed in Add/Remove Programs (HKLM ...\Uninstall\ti-$AppId)"
  ${Else}
    StrCpy $U_a "$AppDir\uninstall.exe, listed in Add/Remove Programs (HKCU ...\Uninstall\ti-$AppId)"
  ${EndIf}
  Call SumPara
  ${Sum} "  Record      $RecHash"
  ${If} $LogPath != ""
    ${Sum} "  Log         $LogPath"
  ${EndIf}
  ; Why two folders and not one, which is the question this section
  ; otherwise leaves a reader holding.
  StrCpy $CapInd1 "  "
  StrCpy $CapInd2 "  "
  ${Sum} ""
  StrCpy $U_a "The runtime has its own folder beside the app rather than inside it, to keep the paths inside it short: Windows still breaks on long ones."
  Call SumPara

  ; ---- WHAT RUNS. A second pass over the same block: the `step` lines
  ; sit under the `file` they belong to, and Subst needs that file's
  ; folder, so the walk is the same one DOWNLOADS makes.
  ${Sum} ""
  ${Sum} "WHAT RUNS"
  ; The setup steps are the one thing on this screen that is proved
  ; ours. Printing them in full as well asks the reader to audit by eye
  ; the thing the signature was added so they would not have to -- and
  ; twenty lines of msiexec is how a screen teaches somebody to scroll
  ; past it. So: where they are proved, one line; where nothing vouches
  ; for them, every one of them, because then reading is all a person
  ; has. Either way the log and the Verify page carry them in full.
  ${If} $RtState == "ok"
  ${AndIf} $SumRuns > 0
    StrCpy $U_a $SumRuns
    StrCpy $U_b "command"
    Call Plural
    StrCpy $CapInd1 "  Setup    "
    StrCpy $CapInd2 "           "
    StrCpy $U_a "$SumRuns $U_out that set up the $TgtRuntime runtime, published by us and proved above. In the log in full, and at ${TI_BACKEND}/#verify."
    Call SumPara
    StrCpy $2 $SumRuns
  ${Else}
  StrCpy $2 0
  Call OpenBlock
  ${Do}
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "file"
      StrCpy $CurName $F1
      StrCpy $U_a $F1
      Call FolderHash
      StrCpy $CurDir "$Root\$U_out"
      StrCpy $CurFile "$DlDir\$F2"
    ${ElseIf} $K S== "step"
    ${AndIf} $F1 S== "run"
      IntOp $2 $2 + 1
      ; a `run` step may carry its own description as a second value
      ; (format.md "Steps"); it is what a person can actually judge, so
      ; it is the row and the command goes under it.
      ${If} $2 = 1
        StrCpy $CapInd1 "  Setup    "
      ${Else}
        StrCpy $CapInd1 "           "
      ${EndIf}
      StrCpy $CapInd2 "           "
      ${If} $F3 != ""
        StrCpy $U_a "$F3"
        Call SumPara
      ${ElseIf} $2 = 1
        StrCpy $CmdLabel "  Setup    "
      ${EndIf}
      StrCpy $U_a "$F2"
      Call Subst
      StrCpy $U_a $U_out
      Call CmdLine
    ${EndIf}
  ${Loop}
  FileClose $BH
  ${EndIf}
  StrCpy $CurDir ""
  StrCpy $CurFile ""
  ${If} $TgtInstall != ""
    StrCpy $CmdLabel "  Install  "
    StrCpy $U_a $TgtInstall
    Call Subst
    StrCpy $U_a $U_out
    Call CmdLine
  ${EndIf}
  ${If} $2 = 0
  ${AndIf} $TgtInstall == ""
    ${Sum} "  Setup    nothing; no commands are run on this machine"
  ${EndIf}
  StrCpy $CmdLabel "  Launch   "
  StrCpy $U_a $TgtLaunch
  Call Subst
  StrCpy $U_a $U_out
  Call CmdLine
  ${If} $2 > 0
  ${AndIf} $RtState != "ok"
    StrCpy $CapInd1 "  "
    StrCpy $CapInd2 "  "
    ${Sum} ""
    StrCpy $U_a "These are the runtime setup: written by us, not the project's own code."
    Call SumPara
  ${EndIf}
  ${If} $TgtNote != ""
    ${Sum} ""
    ${Sum} "NOTE"
    ${Sum} "  $TgtNote"
  ${EndIf}

  ${Sum} ""
  StrCpy $CapInd1 ""
  StrCpy $CapInd2 ""
  StrCpy $U_a 'Ready to install "$AppName". Nothing has been changed yet.'
  Call SumPara
  FileClose $SumH
  FileClose $CmdH
  FileClose $UrlH
  ; no control or bidi characters on the review page (plan text is shown as is otherwise)
  tisig::cleanfile "$PLUGINSDIR\summary.txt"
  tisig::cleanfile "$PLUGINSDIR\commands.txt"
  tisig::cleanfile "$PLUGINSDIR\urls.txt"
  Pop $0
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- a window you can read
;
; MUI's window is 300x140 dialog units, about 500x360 pixels, and the
; review page (design.md section 3) has to fit everything an install will
; do into it. It cannot: on Windows 11 it was a 503-pixel box with a
; horizontal *and* a vertical scroll bar, and on XP the same. There is no
; wider MUI resource to switch to, so the window and the controls MUI put
; in it are resized once, in MUI's GUI-init hook, before any page is
; built -- nsDialogs takes the child rectangle's size when the page is
; created, so the review page gets the new size with no work of its own.
;
; The size asked for is scaled by the screen's DPI and then clamped to the
; work area, so an 800x600 XP machine keeps a window that fits on it.

!define TI_WANT_W 780         ; at 96 dpi; scaled below, and clamped to the screen
!define TI_WANT_H 600

Var MvId
Var MvDX
Var MvDY
Var MvDW
Var MvDH

; Move and/or resize one control of $HWNDPARENT by the deltas in $Mv*.
Function TiMoveCtl
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  GetDlgItem $0 $HWNDPARENT $MvId
  ${If} $0 <> 0
    System::Call '*(i,i,i,i)p.r1'
    System::Call 'user32::GetWindowRect(p r0, p r1)i'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)i'
    System::Call '*$1(i.r2, i.r3, i.r4, i.r5)'
    System::Free $1
    IntOp $4 $4 - $2          ; width
    IntOp $5 $5 - $3          ; height
    IntOp $2 $2 + $MvDX
    IntOp $3 $3 + $MvDY
    IntOp $4 $4 + $MvDW
    IntOp $5 $5 + $MvDH
    ; SWP_NOZORDER|SWP_NOACTIVATE
    System::Call 'user32::SetWindowPos(p r0, p 0, i r2, i r3, i r4, i r5, i 0x14)i'
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro TiMove ID DX DY DW DH
  StrCpy $MvId ${ID}
  IntOp $MvDX ${DX} + 0
  IntOp $MvDY ${DY} + 0
  IntOp $MvDW ${DW} + 0
  IntOp $MvDH ${DH} + 0
  Call TiMoveCtl
!macroend
!define TiMove "!insertmacro TiMove"

Function TiGuiInit
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7

  ; how big we would like to be, at this screen's DPI
  System::Call 'user32::GetDC(p 0)p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88)i.r1'    ; LOGPIXELSX
  System::Call 'user32::ReleaseDC(p 0, p r0)i'
  ${If} $1 < 96
    StrCpy $1 96
  ${EndIf}
  IntOp $2 ${TI_WANT_W} * $1
  IntOp $2 $2 / 96
  IntOp $3 ${TI_WANT_H} * $1
  IntOp $3 $3 / 96

  ; never bigger than the work area, less a margin
  System::Call '*(i,i,i,i)p.r4'
  System::Call 'user32::SystemParametersInfoW(i 0x30, i 0, p r4, i 0)i.r0'   ; SPI_GETWORKAREA
  ${If} $0 <> 0
    System::Call '*$4(i.r5, i.r6, i.r7, i.r0)'
    IntOp $7 $7 - $5
    IntOp $0 $0 - $6
    IntOp $7 $7 - 40
    IntOp $0 $0 - 40
    ${If} $2 > $7
      StrCpy $2 $7
    ${EndIf}
    ${If} $3 > $0
      StrCpy $3 $0
    ${EndIf}
  ${EndIf}
  System::Free $4

  ; what we have now, and the difference
  System::Call '*(i,i,i,i)p.r4'
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r4)i'
  System::Call '*$4(i.r5, i.r6, i.r7, i.r0)'
  System::Free $4
  IntOp $7 $7 - $5            ; current width
  IntOp $0 $0 - $6            ; current height
  IntOp $WinDX $2 - $7
  IntOp $WinDY $3 - $0
  ${If} $WinDX < 0
    StrCpy $WinDX 0
  ${EndIf}
  ${If} $WinDY < 0
    StrCpy $WinDY 0
  ${EndIf}
  ${If} $WinDX = 0
  ${AndIf} $WinDY = 0
    Goto gui_done
  ${EndIf}

  ; the window itself, still centred on the work area
  IntOp $7 $7 + $WinDX
  IntOp $0 $0 + $WinDY
  IntOp $5 $5 - $WinDX
  IntOp $5 $5 / 2
  IntOp $6 $6 - $WinDY
  IntOp $6 $6 / 2
  ${If} $5 < 0
    StrCpy $5 0
  ${EndIf}
  ${If} $6 < 0
    StrCpy $6 0
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r5, i r6, i r7, i r0, i 0x14)i'

  ; The ids are modern.exe's, read off a running installer rather than
  ; guessed: 1018 is where the page goes, 1034/1037/1038/1039 are the
  ; header's background, title, subtitle and icon, 1036 and 1035 the
  ; rules under the header and above the buttons, 1028/1256 the branding
  ; text, and 1044/1045 the panel behind the page.
  ${TiMove} 1018 0 0 $WinDX $WinDY        ; where the page is built
  ${TiMove} 1044 0 0 $WinDX $WinDY        ; the panel behind it
  ${TiMove} 1034 0 0 $WinDX 0             ; header background
  ${TiMove} 1037 0 0 $WinDX 0             ; header title
  ${TiMove} 1038 0 0 $WinDX 0             ; header subtitle
  ${TiMove} 1039 $WinDX 0 0 0             ; header icon
  ${TiMove} 1036 0 0 $WinDX 0             ; the rule under the header
  ${TiMove} 1035 0 $WinDY $WinDX 0        ; the rule above the buttons
  ${TiMove} 1045 0 $WinDY $WinDX 0
  ${TiMove} 1256 0 $WinDY $WinDX 0        ; branding text
  ${TiMove} 1028 0 $WinDY $WinDX 0
  ${TiMove} 1 $WinDX $WinDY 0 0           ; Install
  ${TiMove} 2 $WinDX $WinDY 0 0           ; Cancel
  ${TiMove} 3 $WinDX $WinDY 0 0           ; Back
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)i'

gui_done:
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------- review page

Var ReviewEdit
Var ReviewRich

!define TI_EM_EXLIMITTEXT 0x435
!define TI_EM_AUTOURLDETECT 0x45B

; The review page: one control filling the (now much larger) window.
;
; A rich edit, when there is one -- every Windows from XP SP1 has
; msftedit.dll, and every Windows has riched20.dll -- so the headings,
; the warnings and the quiet detail can be told apart without reading
; every line. tisig::richtext turns the plain summary into RTF by the
; same rules the other engine paints a terminal with; if anything about
; that fails, the plain EDIT below does the job as it always did.
;
; Neither control gets WS_HSCROLL or ES_AUTOHSCROLL any more: a long URL
; now wraps onto the next line instead of running off the right-hand
; edge behind a horizontal scroll bar nobody notices.
Function ReviewShow
  !insertmacro MUI_HEADER_TEXT "Review what will be installed" "Nothing has been changed yet. Click Install to go ahead."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  StrCpy $ReviewRich ""
  System::Call 'kernel32::LoadLibraryW(w "msftedit.dll")p.r0'
  ${If} $0 P<> 0
    StrCpy $ReviewRich "RICHEDIT50W"
  ${Else}
    System::Call 'kernel32::LoadLibraryW(w "riched20.dll")p.r0'
    ${If} $0 P<> 0
      StrCpy $ReviewRich "RichEdit20W"
    ${EndIf}
  ${EndIf}
  StrCpy $ReviewEdit 0
  ${If} $ReviewRich != ""
    nsDialogs::CreateControl $ReviewRich "${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" "${WS_EX_CLIENTEDGE}" 0 0 100% 100% ""
    Pop $ReviewEdit
    ${If} $ReviewEdit <> 0
      SendMessage $ReviewEdit ${TI_EM_EXLIMITTEXT} 0 4194304
      ; no automatic links: a URL that looks clickable and is not is worse
      ; than one that does not, and the colour is not ours to give away
      SendMessage $ReviewEdit ${TI_EM_AUTOURLDETECT} 0 0
      tisig::richtext "$ReviewEdit" "$PLUGINSDIR\summary.txt"
      Pop $1
      ${If} $1 != "ok"
        ${Log} "The review page's rich text did not load ($1); showing it as plain text."
        System::Call 'user32::DestroyWindow(p $ReviewEdit)i'
        StrCpy $ReviewEdit 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $ReviewEdit = 0
    nsDialogs::CreateControl EDIT "${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" "${WS_EX_CLIENTEDGE}" 0 0 100% 100% ""
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
  ${EndIf}
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

; The offset into a file's vendor list, from the file's own SHA-256.
; Same rule as ti_spread in the unix engine: fold every hex digit,
; reducing as it goes, then take it modulo the number of vendors. The
; whole hash and not a prefix, because k = h % n would otherwise turn on
; the low bits of the first few digits and two files sharing them would
; share a vendor. In: $FF_sha, $FF_nv. Out: $FF_k.
Function FfSpreadK
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $FF_k 0
  ${If} $FF_nv <= 1
    Goto sk_end
  ${EndIf}
  StrLen $2 $FF_sha
  StrCpy $3 0
  StrCpy $1 0
  ${Do}
    ${If} $3 >= $2
      ${Break}
    ${EndIf}
    StrCpy $0 $FF_sha 1 $3
    ; hex digit -> value; anything else counts as 0, which is harmless
    StrCpy $0 "0x$0"
    IntOp $0 $0 + 0
    IntOp $1 $1 * 16
    IntOp $1 $1 + $0
    IntOp $1 $1 % 1000003
    IntOp $3 $3 + 1
  ${Loop}
  IntOp $FF_k $1 % $FF_nv
  sk_end:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

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
  ; Spread the load across the vendors this file is listed at, the way
  ; ti_spread does in the unix engine: count them, pick a starting one
  ; from the file's own SHA-256, and try the rest first. Our own mirror
  ; is a fallback rather than a vendor, so anything with /mirror/ in it
  ; is not counted and is left where it is, at the end. Reordering is
  ; safe because every source is checked against the same SHA-256 before
  ; it is used: the order decides who serves the bytes, never which
  ; bytes are accepted.
  StrCpy $FF_nv 0
  FileOpen $FF_h $PlanU16 r
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $FF_line
      ${Break}
    ${EndIf}
    ${TiRead} $FF_h
    IntOp $0 $0 + 1
  ${Loop}
  ${Do}
    ${TiRead} $FF_h
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $FF_ukey S== "nurl"
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
    StrCpy $U_a $F1
    StrCpy $U_b "/mirror/"
    Call TiContains
    ${If} $U_out = 0
      IntOp $FF_nv $FF_nv + 1
    ${EndIf}
  ${Loop}
  FileClose $FF_h
  Call FfSpreadK

  ; Two passes: the vendors from $FF_k on, then the ones before it. The
  ; mirror lines sit at the end of the list and are only reached on the
  ; second, so every vendor is tried before we serve it ourselves.
  StrCpy $FF_phase 0
  ff_pass:
  StrCpy $FF_vi 0
  FileOpen $FF_h $PlanU16 r
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $FF_line
      ${Break}
    ${EndIf}
    ${TiRead} $FF_h
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $1 0
  ${Do}
    ${TiRead} $FF_h
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
    StrCpy $U_a $F1
    StrCpy $U_b "/mirror/"
    Call TiContains
    ${If} $U_out = 0
      ; a vendor: in on this pass only if it is on the right side of $FF_k
      ${If} $FF_phase = 0
        ${If} $FF_vi < $FF_k
          IntOp $FF_vi $FF_vi + 1
          ${Continue}
        ${EndIf}
      ${Else}
        ${If} $FF_vi >= $FF_k
          IntOp $FF_vi $FF_vi + 1
          ${Continue}
        ${EndIf}
      ${EndIf}
      IntOp $FF_vi $FF_vi + 1
    ${ElseIf} $FF_phase = 0
      ${If} $FF_k > 0
        ; ours, and vendors are not exhausted yet
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
  ${If} $FF_phase = 0
    ${If} $FF_k > 0
      StrCpy $FF_phase 1
      Goto ff_pass
    ${EndIf}
  ${EndIf}
  ${If} $1 = 0
    ${FailWith} "$FF_name isn't packed in this installer and has no download location."
  ${ElseIf} $FF_sha == "-"
    ; There is no SHA-256 to have been wrong, so saying one was is a
    ; reason nobody could act on. This file is fetched over HTTPS only
    ; (format.md, "Sources without a stored hash"), which is the other
    ; thing that can have failed, so say both.
    ${FailWith} "Couldn't download $FF_name over HTTPS from any of its locations."
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
          Call TiAppendUtf8
        ${EndIf}
      ${Else}
        FileClose $2
      ${EndIf}
    ${EndIf}
    StrCpy $U_a $0
    StrCpy $U_b "$1$\r$\n"
    Call TiAppendUtf8
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
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    IntOp $LineNo $LineNo + 1
    Call TiParseLine
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
      StrCpy $U_a "$CurDir\.ti-owner"
      StrCpy $U_b "ti-folder$\t1$\nappid$\t$AppId$\nname$\t$CurName$\nfile$\t$CurFname$\n"
      Call TiAppendUtf8
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
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "env"
    ${OrIf} $K S== "ienv"
      StrCpy $U_a $F2
      Call Subst
      StrCpy $U_a $F1
      StrCpy $U_b $U_out
      Call TiSetEnv
    ${ElseIf} $K S== "unset"
    ${OrIf} $K S== "iunset"
      StrCpy $U_a $F1
      Call TiUnsetEnv
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
  Call TiPrependPath
  StrCpy $U_a "TI_APP_DIR"
  StrCpy $U_b $AppDir
  Call TiSetEnv
  StrCpy $U_a "TI_RUNTIME_DIR"
  StrCpy $U_b $RuntimeDir
  Call TiSetEnv
  StrCpy $U_a "TI_APP_NAME"
  StrCpy $U_b $AppName
  Call TiSetEnv
  Pop $0
FunctionEnd

; launch.txt (format.md section 5).
Function WriteLaunch
  Push $0
  StrCpy $0 "$AppDir\launch.txt"
  Delete $0
  StrCpy $U_a $0
  StrCpy $U_b "ti-launch$\t1$\ncwd$\t$AppDir$\n"
  Call TiAppendUtf8
  Call OpenBlock
  ${Do}
    ${TiRead} $BH
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "[target]"
      ${Break}
    ${ElseIf} $K S== "env"
      StrCpy $U_a $F2
      Call Subst
      StrCpy $U_b "env$\t$F1$\t$U_out$\n"
      StrCpy $U_a $0
      Call TiAppendUtf8
    ${ElseIf} $K S== "unset"
      StrCpy $U_b "unset$\t$F1$\n"
      StrCpy $U_a $0
      Call TiAppendUtf8
    ${ElseIf} $K S== "path"
      StrCpy $U_a $F1
      Call Subst
      StrCpy $U_b "path$\t$U_out$\n"
      StrCpy $U_a $0
      Call TiAppendUtf8
    ${EndIf}
  ${Loop}
  FileClose $BH
  StrCpy $U_a $TgtLaunch
  Call Subst
  StrCpy $U_b "console$\t$Console$\nexec$\t$U_out$\n"
  StrCpy $U_a $0
  Call TiAppendUtf8
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
  StrCpy $U_b "ti-manifest$\t1$\nname$\t$AppName$\nappid$\t$AppId$\nrecord$\t$RecHash$\ninstalled$\t$InstTime$\n"
  Call TiAppendUtf8
  StrCpy $T_rest $FileMap
  Call TiSplitTab
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call TiSplitTab
    Call TiSplitTab
    StrCpy $U_a $0
    StrCpy $U_b "dir$\t$Root\$T_field$\n"
    Push $T_rest
    Push $T_more
    Call TiAppendUtf8
    Pop $T_more
    Pop $T_rest
  ${Loop}
  ${If} $7 == 1
    StrCpy $U_a $0
    ${If} $LnkApp != ""
      StrCpy $U_b "shortcut$\t$LnkApp$\nshortcut$\t$LnkUn$\n"
      Call TiAppendUtf8
    ${EndIf}
    ${If} $LnkDesk != ""
      StrCpy $U_b "shortcut$\t$LnkDesk$\n"
      Call TiAppendUtf8
    ${EndIf}
    StrCpy $U_b "regkey$\t$RegRootName\$RegKey$\n"
    Call TiAppendUtf8
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
  Call TiUtf8ToUtf16
  StrCpy $1 ""
  FileOpen $0 "$PLUGINSDIR\oldman.u16" r
  ${Do}
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
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
  Delete "$AppDir\.ti-installed"          ; first: a half-removed install is never "installed"
  FileOpen $0 "$PLUGINSDIR\oldman.u16" r
  ${Do}
    ${TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call TiParseLine
    ${If} $K S== "dir"
      StrCpy $U_a $F1 "" -12
      StrCpy $U_b 12
      Call TiIsB32
      StrCpy $1 $F1 -13
      ${If} $U_out = 1
      ${AndIf} $1 == $Root
        StrCpy $U_a $F1
        Call TiOwnerOf
        ${If} $U_out S== $AppId
          ${Log} "  remove $F1"
          RMDir /r "$F1"
        ${Else}
          ${Log} "  kept $F1: its .ti-owner doesn't name this app"
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
  Call TiSplitTab
  ${Do}
    ${If} $T_more = 0
      ${Break}
    ${EndIf}
    Call TiSplitTab
    Call TiSplitTab
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
    ${TiTrimNL} $1
    ${Log} "$1"
  ${Loop}
  FileClose $0
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\commands.txt" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $0 $1
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${TiTrimNL} $1
      ${Log} "$1"
    ${Loop}
    FileClose $0
  ${EndIf}
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\urls.txt" r
  ${IfNot} ${Errors}
    ${Log} ""
    ${Do}
      ClearErrors
      FileReadUTF16LE $0 $1
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${TiTrimNL} $1
      ${Log} "$1"
    ${Loop}
    FileClose $0
  ${EndIf}
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
  StrCpy $U_a "$AppDir\.ti-owner"
  StrCpy $U_b "ti-folder$\t1$\nappid$\t$AppId$\nname$\t(app)$\n"
  Call TiAppendUtf8
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
    ; Hand it a temporary folder it can read. On an account whose name is
    ; not ASCII this is the 8.3 short name of the very same %TEMP%, which
    ; is what lets Python 2's pip work there at all (AsciiTemp). Set for
    ; this one command and put back straight after, so the app's first
    ; run -- which this installer starts -- inherits the machine's own
    ; TMP and TEMP and not ours.
    Call AsciiTemp
    StrCpy $AsciiTmp $U_out
    ${If} $AsciiTmp != ""
      ReadEnvStr $TmpSaved "TMP"
      ReadEnvStr $TempSaved "TEMP"
      ${Log} "Install: TMP and TEMP -> $AsciiTmp (the same folder as $TempSaved, spelt in ASCII)"
      StrCpy $U_a "TMP"
      StrCpy $U_b $AsciiTmp
      Call TiSetEnv
      StrCpy $U_a "TEMP"
      StrCpy $U_b $AsciiTmp
      Call TiSetEnv
    ${EndIf}
    StrCpy $U_a $TgtInstall
    Call Subst
    StrCpy $RC_cmd $U_out
    StrCpy $RC_cwd $AppDir
    StrCpy $RC_quiet 0
    Call RunCmd
    ${If} $AsciiTmp != ""
      StrCpy $U_a "TMP"
      StrCpy $U_b $TmpSaved
      ${If} $TmpSaved == ""
        Call TiUnsetEnv                    ; it had none; leave it with none
      ${Else}
        Call TiSetEnv
      ${EndIf}
      StrCpy $U_a "TEMP"
      StrCpy $U_b $TempSaved
      ${If} $TempSaved == ""
        Call TiUnsetEnv
      ${Else}
        Call TiSetEnv
      ${EndIf}
      StrCpy $AsciiTmp ""
    ${EndIf}
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
  StrCpy $RegKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\ti-$AppId"
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
  Delete "$AppDir\.ti-installed.tmp"
  StrCpy $U_a "$AppDir\.ti-installed.tmp"
  StrCpy $U_b "ti-installed$\t1$\nappid$\t$AppId$\nrecord$\t$RecHash$\ninstalled$\t$InstTime$\n"
  Call TiAppendUtf8
  ClearErrors
  Rename "$AppDir\.ti-installed.tmp" "$AppDir\.ti-installed"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "$AppDir\.ti-installed"
    ${FailWith} "Couldn't write $AppDir\.ti-installed."
    Return
  ${EndIf}
  ${Log} "Wrote $AppDir\.ti-installed (record $RecHash)"
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
  ${un.GetOptions} $Params "/ti-elevated" $0
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
  Call un.TiUtf8ToUtf16
  StrCpy $AppName ""
  StrCpy $AppId ""
  StrCpy $RegRootName ""
  FileOpen $0 "$PLUGINSDIR\manifest.u16" r
  ${un.TiRead} $0
  StrCpy $T_rest $T_line
  Call un.TiSplitTab
  ${If} $T_field S!= "ti-manifest"
    FileClose $0
    MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\manifest.txt isn't a ti-manifest file." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${Do}
    ${un.TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call un.TiParseLine
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
  Call un.TiIsB32
  ${If} $U_out = 0
  ${OrIf} $1 S!= $AppId
    MessageBox MB_OK|MB_ICONSTOP "This uninstaller isn't in its app's folder ($INSTDIR); refusing to remove anything." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $RegRootName == "HKLM"
    Call un.TiIsAdmin
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
      StrCpy $U_a "$2 /ti-elevated _?=$INSTDIR"
      Call un.TiRunElevated
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
  Call un.TiContains
  ${If} $U_out = 1
    StrCpy $U_out 0
    Goto so_end
  ${EndIf}
  StrCpy $U_a $0
  StrCpy $U_b "$UnSmCur\"
  Call un.TiStartsWith
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnSmAll\"
    Call un.TiStartsWith
  ${EndIf}
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnDeskCur\"
    Call un.TiStartsWith
  ${EndIf}
  ${If} $U_out = 0
    StrCpy $U_a $0
    StrCpy $U_b "$UnDeskAll\"
    Call un.TiStartsWith
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
  Delete "$INSTDIR\.ti-installed"
  FileOpen $0 "$PLUGINSDIR\manifest.u16" r
  ${Do}
    ${un.TiRead} $0
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    Call un.TiParseLine
    ${If} $K S== "dir"
      ; only <root>\<12 base32 chars>, beside this app's folder
      StrCpy $U_a $F1 "" -12
      StrCpy $U_b 12
      Call un.TiIsB32
      StrCpy $1 $F1 -13
      StrCpy $2 $F1 1 -13
      ${If} $U_out = 1
      ${AndIf} $1 == $UnRoot
      ${AndIf} $2 == "\"
        StrCpy $U_a $F1
        Call un.TiOwnerOf
        ${If} $U_out S== $AppId
          DetailPrint "Remove folder $F1"
          RMDir /r "$F1"
        ${Else}
          DetailPrint "Skipped (its .ti-owner doesn't name this app): $F1"
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
      StrCpy $1 "Software\Microsoft\Windows\CurrentVersion\Uninstall\ti-$AppId"
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
  Call un.TiOwnerOf
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
    DetailPrint "Kept $INSTDIR: its .ti-owner doesn't name this app"
  ${EndIf}
  RMDir "$UnRoot"                 ; the install root, if nothing else is in it
  SetErrorLevel 0
SectionEnd
