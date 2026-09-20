# Tested Python on old Windows

**Read this before changing which Python goes on which Windows version.**

The table below comes from
[robertsdotpm/win-auto-py3](https://github.com/robertsdotpm/win-auto-py3)
(commit `4773a6c`). Each Python build was found and tested by trial and
error. On each Windows version listed, **Python installs and `asyncio`
works**. Many builds that claim to support these systems fail at one of
those two things.

Treat the exact files as known-good. Don't swap in a later patch release
(e.g. 3.8.10 for 3.8.0) or a 64-bit build without re-testing `asyncio` on
that Windows version.

## Known-good builds

| Windows | NT version | Python | File | SHA-256 | Installed before it |
| --- | --- | --- | --- | --- | --- |
| XP | 5.1+ | 3.5, XP backport (custom) | `python_3_5_x86.zip` | `95E2208F84F493382E7C6C3B776C1E942CDFF45F22FF8168232910B7B47ED619` | VC++ AIO redist |
| Vista | 6.0 | 3.7.0 x86 | `python-3.7.0.exe` | `559E56D293E05FF6159C3676DA2B5A93081EFAD7A8ACC74C12BB757E2B93DABA` | VC++ AIO redist |
| 7 | 6.1 | 3.8.0 x86 | `python-3.8.0.exe` | `B471908DE5E10D8FB5C3351A5AFFB1172DA7790C533E0C9FFBAEEC9C11611B15` | |
| 8 and 8.1 | 6.2, 6.3 | 3.8.0 x86 | `python-3.8.0.exe` | (same as 7) | |
| 10 and 11 | 10.0 | 3.13.0 x86 | `python-3.13.0.exe` | `A9BE7082CCD3D0B947D14A87BCEADB1A3551382A68FCB64D245A2EBCC779B272` | |

Visual C++ redistributable, all-in-one:
`VisualCppRedist_AIO_x86_x64.exe` v0.35.0, SHA-256
`04D6878F25E0BB6CE8FE2DE7E0E7603EDEF7DBD6E9270789C819ED678211D2F6`.

All tested builds are **32-bit (x86)**, including on 64-bit Windows.

Not tested: Windows Server editions, and anything older than XP.

## Where the files come from

| File | Source | Backup |
| --- | --- | --- |
| XP zip | Python 3.5 runtime backported to XP, [msfn.org thread](https://msfn.org/board/topic/176131-python-35-runtime-redistributable-backported-to-xp/). Files extracted from that installer, then pip added and changes made so `asyncio` works. **It won't match the upstream installer**; the SHA-256 above is for the modified zip | Original installer, before the changes: [archive.org/details/python-35-win-xp](https://archive.org/details/python-35-win-xp) |
| 3.7.0 | https://www.python.org/ftp/python/3.7.0/python-3.7.0.exe | |
| 3.8.0 | https://www.python.org/ftp/python/3.8.0/python-3.8.0.exe | |
| 3.13.0 | https://www.python.org/ftp/python/3.13.0/python-3.13.0.exe | |
| VC++ AIO | [abbodi1406/vcredist v0.35.0](https://github.com/abbodi1406/vcredist/releases/tag/v0.35.0), inside `VisualCppRedist_AIO_x86_x64_35.zip` | [archive.org/details/visual-cpp-redist-aio-x-86-x-64-35](https://archive.org/details/visual-cpp-redist-aio-x-86-x-64-35) |

The python.org files also match python.org's own MD5s.

## Install steps that matter

From `installer.nsi`:

1. **Order on XP and Vista:** install the VC++ AIO redistributable first,
   silently: `VisualCppRedist_AIO_x86_x64.exe /ai`.
2. **XP has no installer.** Unzip `python_3_5_x86.zip` directly into
   `%SystemDrive%\py3` (with the `nsisunz` plugin).
3. **Vista, 7, 8, 10, 11** run the python.org installer with:

   ```
   AppendPath=0 InstallAllUsers=1 DefaultAllUsersTargetDir="C:\py3" TargetDir="C:\py3" /passive
   ```

   `AppendPath=0` leaves PATH alone; `/passive` shows progress without
   prompts.
4. **Verify before running:** every download's SHA-256 is checked
   (`HashInfo` plugin) before it's executed or unzipped.
5. **Install the package:** `python.exe -m pip install <package>`.

## Detecting an existing Python

The script reuses a Python that's already installed, in this order:

1. `python3` on PATH (empty 0-byte files are skipped)
2. `python` on PATH, rejected if `--version` reports Python 2
3. Registry `HKLM\Software\Python\PythonCore\<version>\InstallPath`, value
   `ExecutablePath`, taking the highest 3.x version
4. The same under `HKCU`
5. `%SystemDrive%\py3\python.exe`

The script's to-do reads "use existing python if it exists because
conflicts ruin everything": a second Python registered on PATH or in the
registry conflicts with the first. Installer Builder's per-app copies
(design doc section 1.1) must therefore stay private: never on PATH,
never registered under `PythonCore`. The `AppendPath=0` argument above
matters for the same reason. Check whether the python.org installers'
`InstallAllUsers=1` still writes registry entries, and suppress them if
so.

## Other lessons in the script

- **"Using fixed IPs for download URLs = highly recommended. DNS is often
  broken on old hosts."** The mirror base was a bare IP
  (`http://88.99.211.216/win-auto-py3`). Mirror lists for old systems
  should include IP-addressed, plain-HTTP entries, because old systems
  may also lack current TLS and root certificates.
- **Mirror base patchable after build:** the base URL is stored in the
  exe's `FileDescription` version field and read at run time (`MoreInfo`
  plugin), so the mirror can be changed without recompiling.
- **Retargeting by file name:** `install_<package>.exe` installs
  `<package>`; the name is parsed from `$EXEFILE`.
- **`CRCCheck off`**, so the installer's icon can be changed with a
  resource editor after building.
- **ANSI build** with ANSI plugin variants.
- **`RequestExecutionLevel admin`**, needed to write to the drive root.
- **Shortcuts** run
  `cmd.exe /k cd "%USERPROFILE%" && "<python>" -m <package> /polyinstall`,
  using the installer exe as the icon. Existing shortcuts are deleted
  first, because they can point to an old Python.
- **Running as the original user:** the first run uses
  `ExecShell open cmd.exe`. The script's comment says this runs Python
  under the original user account rather than the elevated installer's.
- **Entry point convention:** packages handle `/polyinstall` as the last
  argument.

## Plugins used

| Plugin | Purpose | SHA-256 (ANSI / Unicode) |
| --- | --- | --- |
| [inetc](https://nsis.sourceforge.io/Inetc_plug-in) | Download | `2D5D8902…612F` / `85E03805…CCB9` |
| [HashInfo](https://www.pawelporwisz.pl/nsis/plugins/HashInfo/HashInfo.php) | SHA-256 | `6ED33858…68CE` (both) |
| [MoreInfo](https://nsis.sourceforge.io/MoreInfo_plug-in) | Read the file description | `569D6234…CF99` / `227A4FC9…B026` |
| [nsisunz](https://nsis.sourceforge.io/Nsisunz_plug-in) | Unzip | `6E87ECB7…F61D` / `C31B590C…A922` |

Full hashes are in `file_meta.txt`. A copy of it and of `installer.nsi`
is kept in the runtimes folder under
`reference/win-auto-py3@4773a6c/`.
