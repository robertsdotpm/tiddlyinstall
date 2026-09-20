#!/usr/bin/env python3
"""Provision a Windows test VM on ESXi from a Microsoft evaluation ISO,
installed unattended (docs/test-vms.md, "Windows test VMs").

usage: VM_PASSWORD=... ESX_SSH="ssh root@esxi" GOVC_URL=... GOVC_USERNAME=... GOVC_PASSWORD=... \\
       esxi_provision_windows.py <workdir> <profile> <install.iso> [--datastore DS] [--name NAME]

<profile> is one of PROFILES below. The VM gets 4 vCPUs, 4 GB, a thin
disk, one e1000e NIC on NETWORK (default "VM Network", DHCP) and three CD
drives: the install ISO, a small ISO with autounattend.xml and the
first-logon scripts (tools/windows-unattend/), and VMware Tools.

The answer file makes the accounts (password from VM_PASSWORD, in the
answer file's own encoding, which is base64 and not a hash: the format
allows nothing else, so that ISO is deleted from the datastore once the
install is done: --cleanup) and logs on once as `x`, which runs
setup.ps1: OpenSSH Server with the keys in ~/.ssh/*.pub, RDP on clients,
VMware Tools, then update.ps1 in the background (Windows Update until
nothing is left), then quiet.ps1 (Defender and automatic updates off).

Partly borrowed from dockur/windows's answer files (MIT licence,
https://github.com/dockur/windows, assets/*.xml): the disk layout and the
Windows 11 hardware-check bypass.

--cleanup NAME: remove the answer-file ISO and the install and Tools ISOs
from the VM's folder and CD drives once setup has finished.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE / "windows-unattend"

PROFILES = {
    "win10-x86": dict(
        name="Windows 10 22H2 x86 (32-bit) - installer tests", host="ib-win10-x86",
        arch="x86", firmware="bios", guest="windows9Guest", lang="en-US",
        admins=["x"], admin_group="Administrators", disk=64, rdp=True, image=None),
    "win10-ltsc2021": dict(
        name="Windows 10 LTSC 2021 (64-bit) - installer tests", host="ib-win10-ltsc",
        arch="amd64", firmware="efi", guest="windows9_64Guest", lang="en-US",
        admins=["x"], admin_group="Administrators", disk=64, rdp=True,
        image="Windows 10 Enterprise LTSC 2021 Evaluation"),   # the ISO also has an N edition
    "win11-ltsc2024": dict(
        name="Windows 11 IoT Enterprise LTSC 2024 (64-bit) - installer tests", host="ib-win11-ltsc",
        arch="amd64", firmware="efi", guest="windows11_64Guest", lang="en-US",
        admins=["x"], admin_group="Administrators", disk=64, rdp=True,
        # The evaluation ISO carries exactly one image, and this is its name
        # (read out of sources/install.wim's XML resource). No vTPM on a
        # standalone host, so setup's hardware checks are bypassed.
        image="Windows 11 IoT Enterprise LTSC 2024 Evaluation", bypass=True),
    "win11-de": dict(
        name="Windows 11 25H2 German (Jörg Müller) - installer tests", host="ib-win11-de",
        arch="amd64", firmware="efi", guest="windows11_64Guest", lang="de-DE",
        # Setup's own account creation turns "ö" into "?" and fails (0x8007089A,
        # invalid user name), so setup.ps1 makes this one (later_admins).
        admins=["x"], later_admins=["Jörg Müller"], admin_group="Administratoren", disk=64, rdp=True,
        image=None, bypass=True),
    "server2025-core": dict(
        name="Windows Server 2025 Core - installer tests", host="ib-srv2025core",
        arch="amd64", firmware="efi", guest="windows2019srvNext_64Guest", lang="en-US",
        admins=["x"], admin_group="Administrators", disk=40, rdp=False,
        image="Windows Server 2025 SERVERSTANDARDCORE"),   # Standard, no Desktop Experience
}
LOCALE_ID = {"en-US": "0409:00000409", "de-DE": "0407:00000407"}


def pw(value, suffix):
    """The answer file's <PlainText>false</PlainText> encoding."""
    return base64.b64encode((value + suffix).encode("utf-16-le")).decode()


def comp(name, arch, body):
    return (f'    <component name="{name}" processorArchitecture="{arch}" publicKeyToken="31bf3856ad364e35" '
            f'language="neutral" versionScope="nonSxS">\n{body}    </component>\n')


def answer_file(p, password):
    a, lang, loc = p["arch"], p["lang"], LOCALE_ID[p["lang"]]
    intl = (f"      <InputLocale>{loc}</InputLocale>\n      <SystemLocale>{lang}</SystemLocale>\n"
            f"      <UILanguage>{lang}</UILanguage>\n      <UserLocale>{lang}</UserLocale>\n")
    if p["firmware"] == "efi":
        parts = """          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
"""
        winpart = 3
    else:
        parts = """          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System Reserved</Label><Format>NTFS</Format><Active>true</Active></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
"""
        winpart = 2
    image = ""
    if p["image"]:
        image = (f"          <InstallFrom><MetaData wcm:action=\"add\"><Key>/IMAGE/NAME</Key>"
                 f"<Value>{escape(p['image'])}</Value></MetaData></InstallFrom>\n")
    bypass = ""
    if p.get("bypass"):
        # No vTPM without a key provider on a standalone ESXi host.
        cmds = [r'reg.exe add "HKLM\SYSTEM\Setup\LabConfig" /v %s /t REG_DWORD /d 1 /f' % v
                for v in ("BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck")]
        bypass = "      <RunSynchronous>\n" + "".join(
            f'        <RunSynchronousCommand wcm:action="add"><Order>{i}</Order><Path>{escape(c)}</Path></RunSynchronousCommand>\n'
            for i, c in enumerate(cmds, 1)) + "      </RunSynchronous>\n"
    pe = comp("Microsoft-Windows-International-Core-WinPE", a,
              f"      <SetupUILanguage><UILanguage>{lang}</UILanguage></SetupUILanguage>\n" + intl)
    pe += comp("Microsoft-Windows-Setup", a, f"""      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
{parts}        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
{image}          <InstallTo><DiskID>0</DiskID><PartitionID>{winpart}</PartitionID></InstallTo>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
          <WillShowUI>OnError</WillShowUI>
        </OSImage>
      </ImageInstall>
      <DynamicUpdate><Enable>false</Enable><WillShowUI>Never</WillShowUI></DynamicUpdate>
      <UserData><AcceptEula>true</AcceptEula><FullName>x</FullName><Organization>installer tests</Organization></UserData>
{bypass}""")
    spec = comp("Microsoft-Windows-Shell-Setup", a, f"      <ComputerName>{p['host']}</ComputerName>\n")
    spec += comp("Microsoft-Windows-International-Core", a, intl)
    spec += comp("Microsoft-Windows-Security-SPP-UX", a, "      <SkipAutoActivation>true</SkipAutoActivation>\n")
    spec += comp("Microsoft-Windows-ErrorReportingCore", a, "      <DisableWER>1</DisableWER>\n")
    if p["rdp"]:
        spec += comp("Microsoft-Windows-TerminalServices-LocalSessionManager", a,
                     "      <fDenyTSConnections>false</fDenyTSConnections>\n")
    if p["guest"].endswith("srvNext_64Guest"):
        spec += comp("Microsoft-Windows-ServerManager-SvrMgrNc", a,
                     "      <DoNotOpenServerManagerAtLogon>true</DoNotOpenServerManagerAtLogon>\n")
    else:
        # Tamper Protection off before Defender first starts, so quiet.ps1 can
        # later turn scanning off; scanning itself stays on until then.
        spec += comp("Microsoft-Windows-Deployment", a, """      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Features" /v TamperProtection /t REG_DWORD /d 4 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
""")
    accounts = "".join(f"""          <LocalAccount wcm:action="add">
            <Name>{escape(u)}</Name>
            <Group>{escape(p['admin_group'])}</Group>
            <Password><Value>{pw(password, 'Password')}</Value><PlainText>false</PlainText></Password>
          </LocalAccount>
""" for u in p["admins"])
    first = [
        r"cmd.exe /c for %d in (D E F G H I J K) do @if exist %d:\ibsetup\setup.ps1 xcopy /e /i /y %d:\ibsetup C:\ibsetup",
        r"powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ibsetup\setup.ps1",
    ]
    oobe = comp("Microsoft-Windows-International-Core", a, intl)
    oobe += comp("Microsoft-Windows-Shell-Setup", a, f"""      <UserAccounts>
        <AdministratorPassword><Value>{pw(password, 'AdministratorPassword')}</Value><PlainText>false</PlainText></AdministratorPassword>
        <LocalAccounts>
{accounts}        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Username>x</Username>
        <Enabled>true</Enabled>
        <LogonCount>1</LogonCount>
        <Password><Value>{pw(password, 'Password')}</Value><PlainText>false</PlainText></Password>
      </AutoLogon>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipUserOOBE>true</SkipUserOOBE>
        <SkipMachineOOBE>true</SkipMachineOOBE>
      </OOBE>
      <FirstLogonCommands>
""" + "".join(f'        <SynchronousCommand wcm:action="add"><Order>{i}</Order><CommandLine>{escape(c)}</CommandLine></SynchronousCommand>\n'
              for i, c in enumerate(first, 1)) + "      </FirstLogonCommands>\n")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\n'
            f'  <settings pass="windowsPE">\n{pe}  </settings>\n'
            f'  <settings pass="specialize">\n{spec}  </settings>\n'
            f'  <settings pass="oobeSystem">\n{oobe}  </settings>\n'
            '</unattend>\n')


def run(cmd, **kw):
    print("+", " ".join(cmd) if isinstance(cmd, list) else cmd, file=sys.stderr, flush=True)
    return subprocess.run(cmd, check=True, text=True, **kw)


def out(cmd):
    return subprocess.run(cmd, check=True, text=True, capture_output=True).stdout


def esx(cmd):
    return out(os.environ["ESX_SSH"].split() + [cmd]).replace("\r", "")


def vmfs_path(ds):
    for line in esx("esxcli storage filesystem list").splitlines():
        cols = line.split()
        if cols and cols[0].startswith("/vmfs/volumes/") and f"  {ds}  " in line:
            return cols[0]
    raise SystemExit(f"no datastore {ds}")


def upload(ds, local, remote):
    """One upload at a time, then check the size (docs/test-vms.md: parallel
    uploads were cut short without an error)."""
    run(["govc", "datastore.upload", "-ds", ds, str(local), remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    want = Path(local).stat().st_size
    got = esx(f"stat -c%s '{vmfs_path(ds)}/{remote}'").strip()
    if str(want) != got:
        raise SystemExit(f"upload of {local} truncated: {got} of {want} bytes")


def build_seed(work, p, password):
    d = work / "seed"
    shutil.rmtree(d, ignore_errors=True)
    (d / "ibsetup").mkdir(parents=True)
    for f in ("setup.ps1", "update.ps1", "quiet.ps1"):
        (d / "ibsetup" / f).write_bytes((SCRIPTS / f).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    keys = "".join(k.read_text().strip() + "\r\n" for k in sorted(Path.home().glob(".ssh/*.pub")))
    (d / "ibsetup" / "keys.txt").write_text(keys, newline="")
    cfg = {"host": p["host"], "rdp": p["rdp"], "users": p["admins"], "later_admins": p.get("later_admins", [])}
    if cfg["later_admins"]:
        # The same encoding as the answer file's; setup.ps1 deletes it once used.
        cfg["pw"] = pw(password, "")
    (d / "ibsetup" / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    (d / "autounattend.xml").write_text(answer_file(p, password), encoding="utf-8")
    iso = work / "unattend.iso"
    run(["genisoimage", "-quiet", "-output", str(iso), "-volid", "IBSETUP", "-joliet", "-rock", str(d)])
    shutil.rmtree(d)   # the answer file holds the password; only the ISO is kept, until it's uploaded
    return iso


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("profile", choices=PROFILES)
    ap.add_argument("iso", nargs="?")
    ap.add_argument("--datastore", default="SATA 2")
    ap.add_argument("--network", default="VM Network")
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--seed-only", action="store_true", help="build unattend.iso in <work> and stop")
    a = ap.parse_args()
    p = PROFILES[a.profile]
    name, ds = p["name"], a.datastore
    folder = f"{vmfs_path(ds)}/{name}" if not a.seed_only else None

    if a.cleanup:
        for dev in out(["govc", "device.ls", "-vm", name]).splitlines():
            if dev.startswith("cdrom-"):
                # govc exits 1 here although the drive is ejected; checked below.
                subprocess.run(["govc", "device.cdrom.eject", "-vm", name, "-device", dev.split()[0]], capture_output=True)
        left = [l for l in out(["govc", "device.info", "-vm", name, "cdrom-*"]).splitlines() if "ISO [" in l]
        if left:
            raise SystemExit("still attached: " + "; ".join(l.strip() for l in left))
        esx(f"rm -f '{folder}/unattend.iso' '{folder}/install.iso' '{folder}/vmware-tools.iso'")
        print(esx(f"ls -la '{folder}'"))
        return

    password = os.environ.get("VM_PASSWORD") or sys.exit("set VM_PASSWORD")
    work = Path(a.work) / p["host"]
    work.mkdir(parents=True, exist_ok=True)
    seed = build_seed(work, p, password)
    if a.seed_only:
        print(seed)
        return

    run(["govc", "vm.create", "-g", p["guest"], "-c", "4", "-m", "4096", "-on=false", "-ds", ds,
         "-net", a.network, "-net.adapter", "e1000e", "-disk", f"{p['disk']}GB",
         "-disk.controller", "lsilogic-sas", "-firmware", p["firmware"], name])
    if p["firmware"] == "efi":
        run(["govc", "device.boot", "-vm", name, "-secure=true"])
    run(["govc", "vm.change", "-vm", name, "-e", "tools.syncTime=FALSE"])
    upload(ds, a.iso, f"{name}/install.iso")
    upload(ds, seed, f"{name}/unattend.iso")
    seed.unlink()
    esx(f"cp /vmimages/tools-isoimages/windows.iso '{folder}/vmware-tools.iso'")
    devs = []
    for iso in ("install.iso", "unattend.iso", "vmware-tools.iso"):
        dev = run(["govc", "device.cdrom.add", "-vm", name], capture_output=True).stdout.strip()
        run(["govc", "device.cdrom.insert", "-vm", name, "-device", dev, "-ds", ds, f"{name}/{iso}"])
        devs.append(dev)
    # Inserted but not connected at power-on otherwise ("No Media").
    run(["govc", "device.connect", "-vm", name] + devs)
    run(["govc", "vm.power", "-on", name])
    # "Press any key to boot from CD or DVD" (EFI): press Enter for a while.
    for _ in range(25):
        subprocess.run(["govc", "vm.keystrokes", "-vm", name, "-c", "KEY_ENTER"], capture_output=True)
        time.sleep(1)
    print(f"created {name} on {ds}")


if __name__ == "__main__":
    main()
