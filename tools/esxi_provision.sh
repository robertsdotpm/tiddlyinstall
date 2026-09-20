#!/bin/sh
# Provision Linux test VMs on ESXi from distro cloud images, with cloud-init.
#
# usage: VM_PASSWORD=... ESX_SSH="ssh root@esxi" GOVC_URL=... GOVC_USERNAME=... GOVC_PASSWORD=... \
#        esxi_provision.sh <workdir> <name> <image.qcow2> <guest-id> <hostname> <family>
#
# <family> picks the sudo group and base packages: rhel6, rhel7, rhel, debian, alpine.
# MEM sets the memory in MB (default 4096).
# The VM gets 2 vCPUs, 4 GB RAM, a thin 40 GB disk on DATASTORE (default
# "SATA 2") that cloud-init grows the root partition into, and one vmxnet3
# NIC on NETWORK (default "VM Network", DHCP). The account `x` gets the
# password (hashed here; the plain text is never written) and the SSH keys
# in ~/.ssh/*.pub. First boot upgrades every package.
set -eu
work=$1 name=$2 img=$3 guest=$4 host=$5 family=$6
ds=${DATASTORE:-SATA 2}
net=${NETWORK:-VM Network}
: "${VM_PASSWORD:?set VM_PASSWORD}"
cd "$work"
d=$host
rm -rf "$d" && mkdir "$d"

hash=$(printf '%s' "$VM_PASSWORD" | openssl passwd -6 -stdin)
keys=$(for k in "$HOME"/.ssh/id_*.pub; do printf '      - %s\n' "$(cat "$k")"; done)
case $family in
rhel6 | rhel7)  group=wheel; shell=/bin/bash
	# End-of-life CentOS: point yum at the vault's final release.
	vault=7.9.2009; [ "$family" = rhel6 ] && vault=6.10
	boot="bootcmd:
  - sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#baseurl=http://mirror.centos.org/centos/\$releasever|baseurl=http://vault.centos.org/$vault|' /etc/yum.repos.d/CentOS-*.repo" ;;
rhel)   group=wheel; shell=/bin/bash; boot= ;;
debian) group=sudo; shell=/bin/bash; boot= ;;
alpine) group=wheel; shell=/bin/sh; boot= ;;
esac
pkgs="open-vm-tools"
[ "$family" = alpine ] && pkgs="open-vm-tools sudo"

cat > "$d/user-data" <<EOF
#cloud-config
hostname: $host
fqdn: $host.lan
preserve_hostname: false
users:
  - name: x
    groups: [$group]
    shell: $shell
    sudo: "ALL=(ALL) ALL"
    lock_passwd: false
    passwd: "$hash"
    ssh_authorized_keys:
$keys
ssh_pwauth: false
$boot
growpart:
  mode: auto
  devices: ["/"]
resize_rootfs: true
package_update: true
package_upgrade: true
package_reboot_if_required: true
packages: [$(echo $pkgs | sed 's/ /, /g')]
runcmd:
  - [sh, -c, "command -v rc-update >/dev/null && rc-update add open-vm-tools default && rc-service open-vm-tools start; command -v systemctl >/dev/null && systemctl enable --now vmtoolsd; true"]
final_message: "ti-test provisioned after \$UPTIME seconds"
EOF
printf 'instance-id: %s\nlocal-hostname: %s\n' "$host-1" "$host" > "$d/meta-data"
genisoimage -quiet -output "$d/seed.iso" -volid cidata -joliet -rock "$d/user-data" "$d/meta-data"
rm -f "$d/user-data"   # holds the password hash; the ISO is what's used

qemu-img convert -O vmdk -o subformat=monolithicSparse,adapter_type=lsilogic "$img" "$d/$host-src.vmdk"

# The VM, its disk (LSI Logic SCSI, which every kernel here supports) and seed CD.
govc vm.create -g "$guest" -c 2 -m "${MEM:-4096}" -on=false -ds "$ds" -net "$net" -net.adapter vmxnet3 \
	-disk.controller lsilogic -firmware bios "$name"
# Upload the sparse disk and convert it to a thin VMFS disk on the host
# (ESX_SSH runs a command on the ESXi host). govc import.vmdk would leave a
# temporary VM registered behind.
govc datastore.upload -ds "$ds" "$d/$host-src.vmdk" "$name/$host-src.vmdk" 2>&1 | tr '\r' '\n' | grep -v Uploading || true
vmfs=$($ESX_SSH "esxcli storage filesystem list" | awk -v n="$ds" '$0 ~ n {print $1; exit}')
# Parallel uploads have been cut short without an error, leaving disks
# whose filesystem is missing files (GRUB "normal.mod not found"): check.
want=$(stat -c%s "$d/$host-src.vmdk")
got=$($ESX_SSH "stat -c%s '$vmfs/$name/$host-src.vmdk'" | tr -d '\r')
[ "$want" = "$got" ] || { echo "upload truncated: $got of $want bytes" >&2; exit 1; }
$ESX_SSH "cd '$vmfs/$name' && vmkfstools -i '$host-src.vmdk' -d thin '$host.vmdk' >/dev/null && rm -f '$host-src.vmdk'"
ctrl=$(govc device.ls -vm "$name" | awk '/LsiLogic/{print $1; exit}')
govc vm.disk.attach -vm "$name" -ds "$ds" -disk "$name/$host.vmdk" -link=false -controller "$ctrl"
govc vm.disk.change -vm "$name" -size 40G
govc datastore.upload -ds "$ds" "$d/seed.iso" "$name/seed.iso" 2>/dev/null
govc device.cdrom.add -vm "$name" >/dev/null
govc device.cdrom.insert -vm "$name" -ds "$ds" "$name/seed.iso"
govc vm.power -on "$name"
echo "created $name"
