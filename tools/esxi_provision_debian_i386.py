#!/usr/bin/env python3
"""Provision the 32-bit Linux test VM on ESXi, installed unattended
(docs/test-vms.md, "The 32-bit Linux VM").

usage: VM_PASSWORD=... GOVC_URL=... GOVC_USERNAME=... GOVC_PASSWORD=... \\
       esxi_provision_debian_i386.py <workdir> <debian-i386-netinst.iso>
       [--datastore DS] [--network NET] [--name NAME] [--memory MB]
       [--iso-only] [--cleanup]

Why an ISO and a preseed rather than a cloud image and cloud-init, which
`tools/esxi_provision.sh` uses for the other ten Linux VMs: Debian
publishes no i386 cloud image. Debian 12 is also the last release with an
i386 installer at all, so 12.15.0 is where this stops.

What it does:

  1. Checks the ISO's SHA-256 against the one recorded below (Debian's
     signed SHA256SUMS), because an installer ISO is the one file here
     nothing else verifies.
  2. Remasters it: `preseed.cfg` at the root and an isolinux default that
     boots it with no keypress. Nothing else in the image is touched.
  3. Creates the VM -- 1 vCPU, 768 MB, a thin 12 GB disk, one vmxnet3 NIC
     on DHCP, BIOS firmware (a 32-bit guest cannot boot 64-bit UEFI, the
     same reason the Windows 10 x86 VM is BIOS) -- attaches the ISO and
     powers it on.
  4. Waits for SSH and prints the address and MAC for docs/test-vms.md.

The preseed makes user `x` with the operator's password and both of the
operator's SSH keys, passwordless sudo (as the other Linux VMs have),
open-vm-tools, and an Xfce desktop that logs `x` in automatically -- the
desktop is the point of this VM: menu entries, desktop entries and the
zenity/kdialog dialogs are exactly what a container cannot show. It also
turns off what would eat a 768 MB machine: the apt timers, unattended
upgrades, sleep and suspend, ModemManager and the tracker daemons.

--iso-only writes the remastered ISO into <workdir> and stops, so the
preseed can be read or booted by hand.
--cleanup ejects and deletes the ISO from the datastore once the install
has finished.
"""
import argparse
import json
import hashlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

NAME = "Linux Debian 12 i386 (32-bit) - installer tests"
HOST = "ti-debian12-i386"
# Debian 12.15.0 i386 netinst, from cdimage.debian.org/cdimage/archive/12.15.0/
# i386/iso-cd/. Its SHA256SUMS is signed by the Debian CD signing key
# (DF9B 9C49 EAA9 2984 3258 9D76 DA87 E80D 6294 BE9B), checked 2026-09-20.
ISO_SHA256 = "71506f6fa501d4ad50d0835666f5102e9c9b090123ca2668b995a911009c0a69"
ISO_SIZE = 687865856

PRESEED = r"""# Debian 12 i386, the 32-bit Linux test machine (docs/test-vms.md).
d-i debian-installer/locale string en_GB.UTF-8
d-i debian-installer/language string en
d-i debian-installer/country string GB
d-i keyboard-configuration/xkb-keymap select gb
d-i console-setup/ask_detect boolean false

d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string {host}
d-i netcfg/get_domain string lan
d-i netcfg/hostname string {host}
d-i hw-detect/load_firmware boolean false

d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i apt-setup/services-select multiselect security, updates
d-i apt-setup/contrib boolean true
d-i apt-setup/non-free-firmware boolean true

d-i clock-setup/utc boolean true
d-i time/zone string Etc/UTC
d-i clock-setup/ntp boolean true

# No root login; `x` is the account, as on the other Linux VMs.
d-i passwd/root-login boolean false
d-i passwd/user-fullname string x
d-i passwd/username string x
d-i passwd/user-password-crypted password {pwhash}

# One ext4 root on the whole disk, plus swap: 768 MB wants some.
d-i partman-auto/method string regular
d-i partman-auto/disk string /dev/sda
d-i partman-auto/choose_recipe select atomic
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true

d-i base-installer/install-recommends boolean true
tasksel tasksel/first multiselect standard, ssh-server, xfce-desktop
# zenity and kdialog are what the .run engine asks a desktop user with
# (installer/unix/ti-engine.sh, ti_ask); xdg-utils and desktop-file-utils are
# what its menu and desktop entries go through.
d-i pkgsel/include string open-vm-tools open-vm-tools-desktop sudo curl wget \
 xz-utils bzip2 unzip p7zip-full file ca-certificates zenity kdialog xdg-utils \
 desktop-file-utils shared-mime-info xterm policykit-1 lsof \
 xdotool wmctrl x11-utils xvfb python3
d-i pkgsel/upgrade select full-upgrade
d-i pkgsel/update-policy select none
popularity-contest/participate boolean false

d-i grub-installer/only_debian boolean true
d-i grub-installer/with_other_os boolean true
d-i grub-installer/bootdev string /dev/sda

d-i finish-install/reboot_in_progress note
d-i preseed/late_command string \
 in-target sh -c 'mkdir -p /home/x/.ssh && chmod 700 /home/x/.ssh'; \
 cp /cdrom/ti-keys.txt /target/home/x/.ssh/authorized_keys; \
 in-target sh -c 'chmod 600 /home/x/.ssh/authorized_keys && chown -R x:x /home/x/.ssh'; \
 in-target sh -c 'echo "x ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-x && chmod 440 /etc/sudoers.d/90-x'; \
 cp /cdrom/ti-settle.sh /target/root/ti-settle.sh; \
 in-target sh /root/ti-settle.sh; \
 in-target rm -f /root/ti-settle.sh
"""

# Run inside the installed system at the end of the install. Everything
# here is the Linux version of the Windows VMs' quiet.ps1: nothing may
# wake this machine up and eat its 768 MB while a test run is going.
SETTLE = r"""#!/bin/sh
set -eu
# Xfce, logged in as x, so the XDG menu, the desktop and the dialog tools
# are really there for a test to look at.
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/90-ti-autologin.conf <<'EOF'
[Seat:*]
autologin-user=x
autologin-user-timeout=0
user-session=xfce
EOF

# Nothing scheduled that wakes it up: apt's daily timers, unattended
# upgrades, and the desktop's indexers.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
apt-get -qq purge -y unattended-upgrades popularity-contest 2>/dev/null || true
systemctl disable --now ModemManager avahi-daemon cups cups-browsed 2>/dev/null || true
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null || true
apt-get -qq clean

# No screen blanking or session idle actions; a test run is not "idle".
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-ti-noblank.conf <<'EOF'
Section "ServerFlags"
    Option "BlankTime"   "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime"     "0"
EndSection
EOF
mkdir -p /etc/xdg/autostart
cat > /etc/xdg/autostart/ti-noblank.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=ti no blanking
Exec=/bin/sh -c "xset s off -dpms"
X-GNOME-Autostart-enabled=true
EOF

# A desktop session over SSH: the harness needs DISPLAY=:0 to reach the
# session that lightdm started, so record where its Xauthority is.
cat > /etc/profile.d/ti-display.sh <<'EOF'
# The autologin Xfce session, for a test run arriving over SSH.
[ -z "${DISPLAY:-}" ] && [ -e /tmp/.X11-unix/X0 ] && export DISPLAY=:0
[ -z "${XAUTHORITY:-}" ] && [ -r /home/x/.Xauthority ] && export XAUTHORITY=/home/x/.Xauthority
EOF
echo "ti-settle done"
"""


def run(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd), file=sys.stderr, flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, text=True, **kw)


def out(cmd):
    return subprocess.run([str(c) for c in cmd], check=True, text=True, capture_output=True).stdout


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def remaster(work, iso, password):
    """The netinst ISO with preseed.cfg at its root and a boot entry that
    takes it without a keypress. BIOS/isolinux only: this guest is 32-bit,
    so it never boots by UEFI."""
    d = work / "iso"
    shutil.rmtree(d, ignore_errors=True)
    run(["xorriso", "-osirrox", "on", "-indev", iso, "-extract", "/", d],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(["chmod", "-R", "u+w", d], stdout=subprocess.DEVNULL)

    # openssl, not crypt: Python 3.13 dropped the module, and
    # tools/esxi_provision.sh hashes the same way.
    pwhash = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password,
                            capture_output=True, text=True, check=True).stdout.strip()
    (d / "preseed.cfg").write_text(PRESEED.format(host=HOST, pwhash=pwhash))
    (d / "ti-settle.sh").write_text(SETTLE)
    keys = "".join(k.read_text().strip() + "\n" for k in sorted(Path.home().glob(".ssh/*.pub")))
    if not keys.strip():
        sys.exit("no ~/.ssh/*.pub to put on the VM")
    (d / "ti-keys.txt").write_text(keys)

    # Boot straight into the preseeded install. `auto=true priority=critical`
    # stops d-i asking anything the preseed already answers.
    params = ("auto=true priority=critical preseed/file=/cdrom/preseed.cfg "
              "debian-installer/language=en debian-installer/country=GB "
              "debian-installer/locale=en_GB.UTF-8 keymap=gb --- quiet")
    # One label and no `include menu.cfg`: Debian's menu declares labels of
    # its own, and two definitions of the same name make isolinux complain.
    (d / "isolinux" / "isolinux.cfg").write_text(
        "path \ndefault tiauto\nprompt 0\ntimeout 1\n\n"
        "label tiauto\n  kernel /install.386/vmlinuz\n"
        f"  append vga=788 initrd=/install.386/initrd.gz {params}\n")

    (d / "md5sum.txt").write_text("")     # the checksums no longer match, and d-i need not check
    iso_out = work / f"{HOST}.iso"
    run(["xorriso", "-as", "mkisofs", "-quiet", "-r", "-J", "-V", "TI_DEBIAN12_I386",
         "-b", "isolinux/isolinux.bin", "-c", "isolinux/boot.cat",
         "-no-emul-boot", "-boot-load-size", "4", "-boot-info-table",
         "-o", iso_out, d])
    shutil.rmtree(d)
    return iso_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("iso", nargs="?")
    ap.add_argument("--datastore", default="SATA 2")
    ap.add_argument("--network", default="VM Network")
    ap.add_argument("--name", default=NAME)
    ap.add_argument("--memory", type=int, default=768,
                    help="MB (the ESXi host is short of memory: ask before raising this)")
    ap.add_argument("--disk", type=int, default=12, help="GB, thin")
    ap.add_argument("--iso-only", action="store_true")
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--skip-hash", action="store_true", help="a different Debian i386 ISO")
    a = ap.parse_args()
    name, ds = a.name, a.datastore

    if a.cleanup:
        for dev in out(["govc", "device.ls", "-vm", name]).splitlines():
            if dev.startswith("cdrom-"):
                subprocess.run(["govc", "device.cdrom.eject", "-vm", name, "-device", dev.split()[0]],
                               capture_output=True)
        left = [l for l in out(["govc", "device.info", "-vm", name, "cdrom-*"]).splitlines() if "ISO [" in l]
        if left:
            sys.exit("still attached: " + "; ".join(l.strip() for l in left))
        run(["govc", "datastore.rm", "-ds", ds, f"{name}/{HOST}.iso"])
        print("ISO removed")
        return

    if not a.iso:
        sys.exit("give the Debian i386 netinst ISO (or --cleanup)")
    password = os.environ.get("VM_PASSWORD")
    if not password:
        sys.exit("set VM_PASSWORD (the operator's password for the `x` account, as on the other VMs)")
    got = sha256(a.iso)
    if not a.skip_hash and got != ISO_SHA256:
        sys.exit(f"{a.iso}: SHA-256 {got}\n  expected {ISO_SHA256} (Debian 12.15.0 i386 netinst)")
    print(f"ISO ok: {Path(a.iso).name}, {Path(a.iso).stat().st_size} bytes, SHA-256 {got}")

    work = Path(a.work) / HOST
    work.mkdir(parents=True, exist_ok=True)
    iso = remaster(work, a.iso, password)
    print(f"remastered: {iso} ({iso.stat().st_size} bytes)")
    if a.iso_only:
        return

    # debian12Guest is the 32-bit guest id; debian12_64Guest is the other one.
    run(["govc", "vm.create", "-g", "debian12Guest", "-c", "1", "-m", str(a.memory),
         "-on=false", "-ds", ds, "-net", a.network, "-net.adapter", "vmxnet3",
         "-disk", f"{a.disk}GB", "-disk.controller", "lsilogic", "-firmware", "bios", name])
    run(["govc", "vm.change", "-vm", name, "-e", "tools.syncTime=FALSE"])
    run(["govc", "datastore.upload", "-ds", ds, iso, f"{name}/{HOST}.iso"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # `datastore.ls -l` prints a human size ("771.2MB"), never the byte
    # count, so comparing bytes to it always failed. Ask for the bytes.
    want = iso.stat().st_size
    got = out(["govc", "datastore.ls", "-json", "-l", "-ds", ds, f"{name}/{HOST}.iso"])
    try:
        d = json.loads(got)
        # `-json` gives a list of results, one per datastore path.
        rows = (d[0] if isinstance(d, list) else d)["file"] or []
        size = int(rows[0]["fileSize"])
    except Exception:
        sys.exit(f"cannot read the uploaded size of {iso}: {got[:400]}")
    if size != want:
        sys.exit(f"upload of {iso} is {size} bytes on the datastore, expected {want}")
    dev = run(["govc", "device.cdrom.add", "-vm", name], capture_output=True).stdout.strip()
    run(["govc", "device.cdrom.insert", "-vm", name, "-device", dev, "-ds", ds, f"{name}/{HOST}.iso"])
    run(["govc", "device.connect", "-vm", name, dev])
    run(["govc", "vm.power", "-on", name])
    mac = ""
    for line in out(["govc", "device.info", "-vm", name, "ethernet-*"]).splitlines():
        if "MAC Address:" in line:
            mac = line.split(":", 1)[1].strip()
    print(f"created {name} on {ds}: 1 vCPU, {a.memory} MB, {a.disk} GB thin, MAC {mac}")
    print("the install takes about 20 minutes; then find it by its MAC and add it to "
          "docs/test-vms.md, tests/arch/machines.py and the harnesses' LINUX_VMS")

    deadline = time.time() + 60 * 60
    while time.time() < deadline:
        ip = subprocess.run(["govc", "vm.ip", "-v4", "-wait", "5m", name],
                            capture_output=True, text=True).stdout.strip()
        if ip:
            print(f"address: {ip}")
            return
        time.sleep(30)
    print("no address yet; look at the console", file=sys.stderr)


if __name__ == "__main__":
    main()
