# Install Brave and add it to this machine's browsers.json.
# Brave supports Windows 10 and later only; nothing older is attempted.
$ErrorActionPreference = 'Stop'
$root = 'C:\tibrowsers'
if (-not (Test-Path $root)) { Write-Output 'no tibrowsers here'; exit 0 }

$exe = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
if (-not (Test-Path $exe)) {
  $ver = [Environment]::OSVersion.Version
  if ($ver.Major -lt 10) { Write-Output ('skipped: Brave needs Windows 10 or later (this is ' + $ver + ')'); exit 0 }
  $tmp = Join-Path $env:TEMP 'BraveSetup.exe'
  # Brave's own update host, over HTTPS; the installer is Authenticode
  # signed and checked below before anything is added to the manifest.
  Invoke-WebRequest -Uri 'https://laptop-updates.brave.com/latest/winx64' -OutFile $tmp -UseBasicParsing
  $sig = Get-AuthenticodeSignature $tmp
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Brave Software') {
    Write-Output ('refused: installer signature is ' + $sig.Status + ' / ' + $sig.SignerCertificate.Subject); exit 1
  }
  Start-Process -FilePath $tmp -ArgumentList '/silent','/install' -Wait
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
if (-not (Test-Path $exe)) { Write-Output 'install did not produce brave.exe'; exit 1 }

$bv = (Get-Item $exe).VersionInfo.ProductVersion
$major = $bv.Split('.')[0]
$drvDir = Get-ChildItem (Join-Path $root 'drivers') -Directory |
  Where-Object { $_.Name -like ("chromedriver-" + $major + ".*") } |
  Sort-Object Name | Select-Object -Last 1
if (-not $drvDir) { Write-Output ('Brave ' + $bv + ' installed, but no chromedriver for Chromium ' + $major + ' here'); exit 0 }
$drv = Join-Path $drvDir.FullName 'chromedriver.exe'

$p = Join-Path $root 'browsers.json'
$j = Get-Content $p -Raw | ConvertFrom-Json
if ($j.browsers | Where-Object { $_.id -eq 'brave' }) { Write-Output 'already listed'; exit 0 }
Copy-Item $p ($p + '.bak-brave') -Force
$entry = [pscustomobject]@{
  id = 'brave'; name = 'Brave'; version = $bv; binary = $exe
  driverKind = 'chromedriver'; driver = $drv; driverVersion = $drvDir.Name.Replace('chromedriver-','')
  args = @('--headless=new'); headless = $true
  source = 'https://laptop-updates.brave.com/latest/winx64, Authenticode signature checked as Brave Software before installing'
  driverSource = 'the chromedriver already on this machine: Brave is Chromium, and chromedriver drives any Chromium of its own major version'
  notes = 'added by tests/browsers/add-brave.sh. Brave ships behaviour Chrome does not (Shields, storage partitioning, HTTPS-by-Default upgrades), which is why it is tested rather than treated as another Chromium.'
}
$j.browsers += $entry
[IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 8))
Write-Output ('added Brave ' + $bv + ' with chromedriver ' + $drvDir.Name)
