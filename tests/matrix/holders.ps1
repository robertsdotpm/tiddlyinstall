# Which processes are holding files in these folders, and (with -Kill)
# stop them. Used by tests/matrix/run_windows.py and tests/templates/run.py
# before either reports a leftover: a folder that will not delete is
# almost always something still running, and saying what it was is far
# more use than "left: <folder>".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File holders.ps1 `
#       -Path "C:\ib;%LOCALAPPDATA%\ib" [-Kill]
#
# One `-Path` string, folders separated by ";" and %VARIABLES% expanded
# here, because PowerShell 2.0 (Windows XP, Vista) binds command-line
# arguments as plain strings. Folders that don't exist are skipped.
#
# Prints "folder <path>" per folder, then one line per holder
#
#   holder <pid> <name> <why> <detail> [| <why> <detail> ...]
#
# then, with -Kill, "killed <pid> <name>", "kept ..." or "kill-failed ..."
# for each, and always "END" last. Nothing is installed on the VM and no
# setting is changed: it reads, and kills only when asked.
#
# The ways a process can hold a folder, and how each is found:
#   exe      it is running from there          (Process.Path)
#   dll      a library of its is loaded there  (Process.Modules)
#   cwd      its current directory is there    (read out of its PEB)
#   cmdline  the path is on its command line   (Win32_Process)
#   rm       the Restart Manager says it has one of the files open
#
# `cwd` is the one that matters most and the only one Windows exposes
# nowhere: neither Win32_Process nor System.Diagnostics.Process carries a
# process's current directory, and a process sitting in a folder holds it
# open even when the folder is empty. That was the Windows 10 leftover of
# 2026-09-19 (design.md 11, item 19): a bare cmd.exe from an earlier SSH
# session, still in %LOCALAPPDATA%\ib\zzot7274gpvh.
#
# The Restart Manager is the authoritative source where it answers, but
# unelevated it returns ERROR_ACCESS_DENIED for most resources, so it is
# one check among several rather than the only one.
#
# This script never reports or kills itself, the shell that started it,
# anything above that, or anything on the keep list below.
param(
  [string]$Path = '',
  [switch]$Kill
)

$ErrorActionPreference = 'Continue'
$KEEP = @('system', 'idle', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss',
          'explorer', 'sshd', 'dwm', 'fontdrvhost', 'sihost', 'runtimebroker', 'conhost',
          'svchost', 'taskhostw', 'searchindexer', 'bvsshserver', 'bvrun')

$src = @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Text;

public static class IBHold {
  // ---- Restart Manager -------------------------------------------------
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps,
    RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] arr, ref uint reasons);

  // pid -> app name; key 0 carries an "rm-error ..." line instead.
  public static Hashtable Who(string[] files) {
    var res = new Hashtable();
    if (files.Length == 0) return res;
    uint h;
    int rc;
    try { rc = RmStartSession(out h, 0, Guid.NewGuid().ToString()); }
    catch (Exception e) { res[0] = "rm-error no Restart Manager: " + e.Message; return res; }
    if (rc != 0) { res[0] = "rm-error RmStartSession " + rc; return res; }
    try {
      rc = RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null);
      if (rc != 0) { res[0] = "rm-error RmRegisterResources " + rc; return res; }
      uint count = 0, needed = 0, reasons = 0;
      rc = RmGetList(h, out needed, ref count, null, ref reasons);
      if (rc == 234 && needed > 0) {           // ERROR_MORE_DATA
        var arr = new RM_PROCESS_INFO[needed];
        count = needed;
        rc = RmGetList(h, out needed, ref count, arr, ref reasons);
        if (rc == 0) { for (int i = 0; i < count; i++) res[arr[i].Process.dwProcessId] = arr[i].strAppName; }
        else res[0] = "rm-error RmGetList " + rc;
      } else if (rc != 0) res[0] = "rm-error RmGetList " + rc;
    } finally { RmEndSession(h); }
    return res;
  }

  // ---- a process's current directory, out of its PEB --------------------
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsWow64Process(IntPtr h, out bool wow64);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);

  const int PROCESS_QUERY_INFORMATION = 0x0400;
  const int PROCESS_VM_READ = 0x0010;

  static bool Read(IntPtr h, IntPtr addr, byte[] buf) {
    IntPtr got;
    return ReadProcessMemory(h, addr, buf, (IntPtr)buf.Length, out got) && (long)got == buf.Length;
  }
  static IntPtr Ptr(byte[] b, int off) {
    return IntPtr.Size == 8 ? (IntPtr)BitConverter.ToInt64(b, off) : (IntPtr)BitConverter.ToInt32(b, off);
  }

  public static string CurrentDirectory(int pid) {
    IntPtr h = IntPtr.Zero;
    try { h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid); }
    catch { return null; }
    if (h == IntPtr.Zero) return null;
    try {
      // A 64-bit reader cannot walk a 32-bit process's PEB with these
      // offsets (it has a second, WOW64 one); skip rather than guess.
      bool wow64;
      if (IntPtr.Size == 8 && IsWow64Process(h, out wow64) && wow64) return null;
      var pbi = new byte[IntPtr.Size == 8 ? 48 : 24];
      int ret;
      if (NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret) != 0) return null;
      IntPtr peb = Ptr(pbi, IntPtr.Size == 8 ? 8 : 4);
      if (peb == IntPtr.Zero) return null;
      var p = new byte[IntPtr.Size];                                   // PEB -> ProcessParameters
      if (!Read(h, (IntPtr)((long)peb + (IntPtr.Size == 8 ? 0x20 : 0x10)), p)) return null;
      IntPtr pp = Ptr(p, 0);
      if (pp == IntPtr.Zero) return null;
      int cdOff = IntPtr.Size == 8 ? 0x38 : 0x24;                      // -> CurrentDirectory.DosPath
      var us = new byte[IntPtr.Size == 8 ? 16 : 8];                    //    a UNICODE_STRING
      if (!Read(h, (IntPtr)((long)pp + cdOff), us)) return null;
      int len = BitConverter.ToUInt16(us, 0);
      if (len <= 0 || len > 4096) return null;
      IntPtr buf = Ptr(us, IntPtr.Size == 8 ? 8 : 4);
      if (buf == IntPtr.Zero) return null;
      var s = new byte[len];
      if (!Read(h, buf, s)) return null;
      return Encoding.Unicode.GetString(s);
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
$haveNative = $true
try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null }
catch { $haveNative = $false; Write-Output ("no-native-checks " + $_.Exception.Message) }

# The folders, as they exist, lower-cased and ending in "\".
$roots = @()
foreach ($p in ($Path -split ';')) {
  $p = [System.Environment]::ExpandEnvironmentVariables($p.Trim())
  if (-not $p -or $p.StartsWith('%')) { continue }        # an unset variable
  try { $roots += (Resolve-Path -LiteralPath $p -ErrorAction Stop).Path } catch { }
}
if ($roots.Count -eq 0) { Write-Output 'END'; exit 0 }
$pfx = @()
foreach ($r in $roots) { Write-Output ("folder " + $r); $pfx += ($r.TrimEnd('\').ToLower() + '\') }

function Under($p) {
  if (-not $p) { return $false }
  $l = $p.ToLower()
  foreach ($x in $pfx) { if ($l.StartsWith($x) -or ($l.TrimEnd('\') + '\') -eq $x) { return $true } }
  return $false
}

# Every process, by pid. Get-CimInstance is PowerShell 3.0 and later.
$procs = @{}
$all = $null
try { $all = Get-CimInstance Win32_Process -ErrorAction Stop } catch { }
if (-not $all) { try { $all = Get-WmiObject Win32_Process -ErrorAction Stop } catch { } }
foreach ($p in $all) { $procs[[int]$p.ProcessId] = $p }

# This process, the shell that ran it, and everything above it.
$mine = @{}
$cur = $PID
for ($i = 0; $i -lt 24 -and $cur -gt 0; $i++) {
  $mine[$cur] = $true
  if (-not $procs.ContainsKey($cur)) { break }
  $next = [int]$procs[$cur].ParentProcessId
  if ($next -eq $cur) { break }
  $cur = $next
}
# ...and anything they started (a conhost, a child shell).
foreach ($k in @($procs.Keys)) {
  $c = [int]$k
  for ($i = 0; $i -lt 24; $i++) {
    if (-not $procs.ContainsKey($c)) { break }
    $p = [int]$procs[$c].ParentProcessId
    if ($mine.ContainsKey($p)) { $mine[[int]$k] = $true; break }
    if ($p -eq $c -or $p -le 0) { break }
    $c = $p
  }
}

$found = @{}
function Note($procId, $why, $detail) {
  $procId = [int]$procId
  if ($procId -le 4 -or $mine.ContainsKey($procId)) { return }
  if (-not $found.ContainsKey($procId)) { $found[$procId] = @() }
  $found[$procId] += ($why + ' ' + $detail)
}

# The Restart Manager, over the folders and up to 400 files in them.
if ($haveNative) {
  $files = New-Object System.Collections.ArrayList
  foreach ($r in $roots) {
    [void]$files.Add($r)
    Get-ChildItem -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer } | Select-Object -First 400 |
      ForEach-Object { [void]$files.Add($_.FullName) }
  }
  try {
    $rm = [IBHold]::Who([string[]]$files.ToArray([string]))
    foreach ($k in $rm.Keys) {
      if ([int]$k -eq 0) {
        # "RmGetList 5" is ERROR_ACCESS_DENIED, which is what an unelevated
        # session gets for a resource it may not ask about; the checks below
        # cover those cases. Anything else is worth saying out loud.
        if ($rm[$k] -notmatch 'RmGetList 5$') { Write-Output ($rm[$k]) }
      } else { Note $k 'rm' $rm[$k] }
    }
  } catch { Write-Output ("rm-error " + $_.Exception.Message) }
}

# Running from there, or with a library loaded from there.
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $pr = $_
  $exe = $null; try { $exe = $pr.Path } catch { }
  if (Under $exe) { Note $pr.Id 'exe' $exe }
  try { $pr.Modules | ForEach-Object { if (Under $_.FileName) { Note $pr.Id 'dll' $_.FileName } } } catch { }
}

# Sitting in the folder, or with it on the command line.
foreach ($k in @($procs.Keys)) {
  $p = $procs[$k]
  if ($mine.ContainsKey([int]$k)) { continue }
  if ($haveNative) {
    $cd = $null
    try { $cd = [IBHold]::CurrentDirectory([int]$k) } catch { }
    if (Under $cd) { Note $k 'cwd' ($p.Name + ' in ' + $cd) }
  }
  if ($p.CommandLine) {
    $cl = $p.CommandLine.ToLower()
    foreach ($x in $pfx) { if ($cl.Contains($x.TrimEnd('\'))) { Note $k 'cmdline' $p.CommandLine; break } }
  }
}

foreach ($k in ($found.Keys | Sort-Object)) {
  $n = '?'
  if ($procs.ContainsKey([int]$k)) { $n = $procs[[int]$k].Name }
  Write-Output ("holder $k $n " + ($found[$k] -join ' | '))
}

if ($Kill) {
  foreach ($k in ($found.Keys | Sort-Object)) {
    $n = '?'
    if ($procs.ContainsKey([int]$k)) { $n = $procs[[int]$k].Name }
    $base = [System.IO.Path]::GetFileNameWithoutExtension($n).ToLower()
    if ($KEEP -contains $base) { Write-Output ("kept $k $n (on the keep list)"); continue }
    try {
      Stop-Process -Id ([int]$k) -Force -ErrorAction Stop
      Write-Output ("killed $k $n")
    } catch {
      Write-Output ("kill-failed $k $n " + $_.Exception.Message)
    }
  }
  Start-Sleep -Milliseconds 1500
}
Write-Output 'END'
