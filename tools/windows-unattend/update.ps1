# Windows Update until nothing is left, through the Windows Update Agent's
# own COM API (no modules from outside Windows). Runs as SYSTEM from the
# ib-update task at every start; reboots when an update asks to; when a
# search finds nothing new it runs quiet.ps1 once and disables the task.
# Progress: C:\ibsetup\wu.log; state: C:\ibsetup\wu-status.txt.
$ErrorActionPreference = 'Continue'
$here = 'C:\ibsetup'
Start-Transcript -Path "$here\wu.log" -Append | Out-Null
function Status($m) { $l = "{0:s} {1}" -f (Get-Date), $m; Write-Output $l; Set-Content "$here\wu-status.txt" $l }
$failFile = "$here\wu-failed.txt"
$failed = @{}
if (Test-Path $failFile) { Get-Content $failFile | ForEach-Object { $failed[$_] = ($failed[$_] + 1) } }

Start-Sleep 60   # let the network and the update services come up
$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'ib-update'
for ($round = 1; $round -le 20; $round++) {
    Status "round $round`: searching"
    try { $res = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'") }
    catch { Status "search failed: $_"; Start-Sleep 300; continue }
    $todo = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $res.Updates) {
        # An update that failed three times is left for a person.
        if ($failed[$u.Identity.UpdateID] -ge 3) { continue }
        if (-not $u.EulaAccepted) { $u.AcceptEula() }
        [void]$todo.Add($u)
    }
    if ($todo.Count -eq 0) {
        $left = ($res.Updates | ForEach-Object { $_.Title }) -join '; '
        Status ("done: nothing left to install" + $(if ($left) { " (gave up on: $left)" } else { '' }))
        Disable-ScheduledTask -TaskName ib-update | Out-Null
        Stop-Transcript | Out-Null
        # quiet.ps1 restarts the machine when it's done.
        if (-not (Test-Path "$here\quiet.done")) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$here\quiet.ps1"
        }
        exit
    }
    Status "round $round`: downloading $($todo.Count): $(($todo | ForEach-Object { $_.Title }) -join '; ')"
    $dl = $session.CreateUpdateDownloader(); $dl.Updates = $todo
    try { [void]$dl.Download() } catch { Write-Output "download: $_" }
    $inst = $session.CreateUpdateInstaller(); $inst.Updates = $todo
    Status "round $round`: installing $($todo.Count)"
    try { $r = $inst.Install() } catch { Status "install failed: $_"; Start-Sleep 300; continue }
    for ($i = 0; $i -lt $todo.Count; $i++) {
        $code = $r.GetUpdateResult($i).ResultCode   # 2 succeeded, 3 with errors, 4 failed, 5 aborted
        Write-Output ("  [{0}] {1}" -f $code, $todo.Item($i).Title)
        if ($code -ge 4) { Add-Content $failFile $todo.Item($i).Identity.UpdateID; $failed[$todo.Item($i).Identity.UpdateID]++ }
    }
    if ($r.RebootRequired) { Status "round $round`: rebooting"; Stop-Transcript | Out-Null; Restart-Computer -Force; exit }
}
Stop-Transcript | Out-Null
