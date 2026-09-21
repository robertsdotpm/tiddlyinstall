# Samples a browser's whole process tree on Windows, from outside it.
#
#   powershell -ExecutionPolicy Bypass -File sample.ps1 -Name chrome -Out C:\tipackmem\s.txt [-Ms 250]
#
# One line per sample: <epoch_ms> <ws_kb> <commit_kb> <procs> <max_ws_kb>
# <max_commit_kb>, summed over every process whose name starts with <Name>.
# WorkingSet is resident; the private commit (PagedMemorySize) is what a
# 32-bit process runs out of address space on, and it is the number to read
# on the 32-bit machines.
#
# `Get-Process -Name` is not used: on Windows XP's PowerShell 2.0 it
# returned nothing for a running chrome.exe, so the filter is done in the
# pipeline instead.
param([string]$Name = "chrome", [string]$Out = "s.txt", [int]$Ms = 250)
$epoch = [datetime]'1970-01-01Z'
"" | Set-Content -Path $Out
while ($true) {
  $t = [int64]((Get-Date).ToUniversalTime() - $epoch).TotalMilliseconds
  $ws = 0; $cm = 0; $n = 0; $mw = 0; $mc = 0
  foreach ($q in (Get-Process -ErrorAction SilentlyContinue)) {
    if ($q.ProcessName -notlike "$Name*") { continue }
    $n++
    $w = 0; $c = 0
    try { $w = $q.WorkingSet64; $c = $q.PagedMemorySize64 } catch { }
    $ws += $w; $cm += $c
    if ($w -gt $mw) { $mw = $w }
    if ($c -gt $mc) { $mc = $c }
  }
  "$t $([int64]($ws/1024)) $([int64]($cm/1024)) $n $([int64]($mw/1024)) $([int64]($mc/1024))" | Add-Content -Path $Out
  Start-Sleep -Milliseconds $Ms
}
