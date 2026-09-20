# After the first full Windows Update (update.ps1 runs this as SYSTEM):
# turn off what keeps a slow test VM busy. Only for the installer-test VMs
# made by tools/esxi_provision_windows.py; the older Windows VMs keep
# Defender and updates on, as real users have them (docs/test-vms.md).
# Every step logs what it did and what Windows refused: C:\tisetup\quiet.log.
$ErrorActionPreference = 'Continue'
$here = 'C:\tisetup'
Start-Transcript -Path "$here\quiet.log" -Append | Out-Null
function Step($m) { Write-Output ("== {0:s} {1}" -f (Get-Date), $m) }
function Reg($path, $name, $value) {
    if (-not (Test-Path $path)) { New-Item $path -Force | Out-Null }
    try { New-ItemProperty $path $name -Value $value -PropertyType DWord -Force -ErrorAction Stop | Out-Null; Write-Output "  set $path $name=$value" }
    catch { Write-Output "  REFUSED $path $name=$value`: $($_.Exception.Message)" }
}
function Tasks($folder) {
    foreach ($t in Get-ScheduledTask -TaskPath $folder -ErrorAction SilentlyContinue) {
        # (In a catch block $_ is the error, so the task is named through $t.)
        try { Disable-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null; Write-Output "  disabled $($t.TaskPath)$($t.TaskName)" }
        catch { Write-Output "  REFUSED $($t.TaskPath)$($t.TaskName): $($_.Exception.Message)" }
    }
}
function Svc($name) {
    $s = Get-Service $name -ErrorAction SilentlyContinue
    if (-not $s) { Write-Output "  no service $name"; return }
    try { Stop-Service $name -Force -ErrorAction Stop; Set-Service $name -StartupType Disabled -ErrorAction Stop; Write-Output "  disabled service $name" }
    catch { Write-Output "  REFUSED service $name`: $($_.Exception.Message)" }
}
$server = (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1

Step 'Windows Update: no automatic updates (manual updates still work)'
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoUpdate 1
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' SetDisableUXWUAccess 0
Tasks '\Microsoft\Windows\UpdateOrchestrator\'
Tasks '\Microsoft\Windows\WaaSMedic\'
Tasks '\Microsoft\Windows\WindowsUpdate\'
Step 'Delivery Optimization off (99: simple mode, no peering, no DO cloud)'
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' DODownloadMode 99

Step 'Defender'
if ($server) {
    # Server: remove the feature; takes effect after a restart.
    $f = Get-WindowsFeature Windows-Defender
    if ($f.Installed) { Uninstall-WindowsFeature Windows-Defender | Format-List | Out-String | Write-Output }
    else { Write-Output '  Windows-Defender feature not installed' }
} else {
    $st = Get-MpComputerStatus
    Write-Output "  tamper protection before: $($st.IsTamperProtected)"
    Add-MpPreference -ExclusionPath 'C:\Users', 'C:\ti', 'C:\ti*', 'C:\titest', 'C:\tibtest', 'C:\tibrowsers', 'C:\tisetup'
    Set-MpPreference -DisableRealtimeMonitoring $true -DisableBehaviorMonitoring $true -DisableIOAVProtection $true `
        -DisableScriptScanning $true -ScanScheduleDay 8 -DisableCatchupFullScan $true -DisableCatchupQuickScan $true `
        -SignatureScheduleDay 8 -MAPSReporting 0 -SubmitSamplesConsent 2
    $d = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender'
    Reg "$d\Real-Time Protection" DisableRealtimeMonitoring 1
    Reg "$d\Real-Time Protection" DisableBehaviorMonitoring 1
    Reg "$d\Real-Time Protection" DisableOnAccessProtection 1
    Reg "$d\Real-Time Protection" DisableScanOnRealtimeEnable 1
    Reg "$d\Real-Time Protection" DisableIOAVProtection 1
    Reg "$d\Scan" ScheduleDay 8
    Reg "$d\Scan" DisableCatchupFullScan 1
    Reg "$d\Scan" DisableCatchupQuickScan 1
    Reg "$d\Spynet" SpynetReporting 0
    Reg "$d\Spynet" SubmitSamplesConsent 2
    Tasks '\Microsoft\Windows\Windows Defender\'
}

Step 'Other background load'
Svc WSearch
Svc SysMain
Svc DiagTrack
Svc dmwappushservice
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' AllowTelemetry 0
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' DisableWindowsConsumerFeatures 1
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' DisableCloudOptimizedContent 1
Reg 'HKLM:\SOFTWARE\Policies\Microsoft\SQMClient\Windows' CEIPEnable 0
foreach ($f in '\Microsoft\Windows\Application Experience\', '\Microsoft\Windows\Customer Experience Improvement Program\',
    '\Microsoft\Windows\Feedback\Siuf\', '\Microsoft\Windows\Autochk\', '\Microsoft\Windows\DiskDiagnostic\',
    '\Microsoft\Windows\CloudExperienceHost\', '\Microsoft\Windows\Maps\', '\Microsoft\Windows\Flighting\FeatureConfig\',
    '\Microsoft\Windows\Flighting\OneSettings\') { Tasks $f }

New-Item "$here\quiet.done" -ItemType File -Force | Out-Null
Step 'quiet done; restarting'
Stop-Transcript | Out-Null
Restart-Computer -Force
