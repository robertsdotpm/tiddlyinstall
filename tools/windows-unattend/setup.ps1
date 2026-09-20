# First logon of a Windows test VM (tools/esxi_provision_windows.py): runs
# once, elevated, as the account the answer file logs on automatically.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
# Settings come from config.json (UTF-8) beside this script.
$ErrorActionPreference = 'Continue'
$here = 'C:\tisetup'
Start-Transcript -Path "$here\setup.log" -Append | Out-Null
$cfg = Get-Content -Raw -Encoding UTF8 "$here\config.json" | ConvertFrom-Json

function Step($m) { Write-Output ("== {0:s} {1}" -f (Get-Date), $m) }

Step 'power: never sleep (a sleeping VM drops off the network)'
powercfg.exe /change standby-timeout-ac 0
powercfg.exe /change hibernate-timeout-ac 0
powercfg.exe /change monitor-timeout-ac 0
powercfg.exe /hibernate off

Step 'network: private profile'
Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private

foreach ($u in $cfg.later_admins) {
    # Accounts whose names Windows Setup can't create (non-ASCII letters).
    Step "account $u"
    $sec = ConvertTo-SecureString ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($cfg.pw))) -AsPlainText -Force
    New-LocalUser -Name $u -Password $sec -PasswordNeverExpires -AccountNeverExpires | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $u
    if ($cfg.rdp) { Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $u }
}
$cfg.PSObject.Properties.Remove('pw')
[IO.File]::WriteAllText("$here\config.json", ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

Step 'OpenSSH Server'
for ($i = 1; $i -le 10; $i++) {
    $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
    if ($cap.State -eq 'Installed') { break }
    Write-Output "try $i`: $($cap.Name) is $($cap.State)"
    try { Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null } catch { Write-Output $_; Start-Sleep 30 }
}
Set-Service sshd -StartupType Automatic
Start-Service sshd
# The capability adds OpenSSH-Server-In-TCP; this one is ours: port 22, from the LAN.
Remove-NetFirewallRule -Name ti-sshd -ErrorAction SilentlyContinue
New-NetFirewallRule -Name ti-sshd -DisplayName 'OpenSSH Server (installer tests, LAN)' -Direction Inbound `
    -Protocol TCP -LocalPort 22 -RemoteAddress LocalSubnet -Profile Any -Action Allow | Out-Null

Step 'SSH keys'
# Every account here is an administrator, and sshd reads administrators'
# keys from this one file (owned by SYSTEM/Administrators only, or ignored).
$ak = "$env:ProgramData\ssh\administrators_authorized_keys"
Copy-Item "$here\keys.txt" $ak -Force
icacls.exe $ak /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
Restart-Service sshd

if ($cfg.rdp) {
    Step 'Remote Desktop'
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' fDenyTSConnections 0
    Get-NetFirewallRule -Group '@FirewallAPI.dll,-28752' | Enable-NetFirewallRule
}

Step 'VMware Tools'
# The Tools CD's installer, not Windows Setup's setup.exe on the install CD.
$want = if ([Environment]::Is64BitOperatingSystem) { 'setup64.exe' } else { 'setup.exe' }
$tools = Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root $want } |
    Where-Object { (Test-Path $_) -and (Get-Item $_).VersionInfo.ProductName -like '*VMware Tools*' } | Select-Object -First 1
if ($tools) {
    $p = Start-Process $tools -ArgumentList '/S /v"/qn REBOOT=R"' -Wait -PassThru
    Write-Output "$tools exit $($p.ExitCode)"
} else { Write-Output 'no VMware Tools CD for this architecture' }

Step 'autologon off, answer-file copies removed'
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $wl AutoAdminLogon 0
Remove-ItemProperty $wl DefaultPassword -ErrorAction SilentlyContinue
Remove-ItemProperty $wl AutoLogonCount -ErrorAction SilentlyContinue
Remove-Item "$env:WINDIR\Panther\unattend*.xml", "$env:WINDIR\Panther\autounattend*.xml", "$env:WINDIR\System32\Sysprep\unattend.xml" -Force -ErrorAction SilentlyContinue

Step 'Windows Update, in the background (update.ps1, as SYSTEM, at every start until done)'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $here\update.ps1"
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ti-update -Action $a -Trigger $t -Settings $s -User SYSTEM -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName ti-update
Step 'setup done'
Stop-Transcript | Out-Null
