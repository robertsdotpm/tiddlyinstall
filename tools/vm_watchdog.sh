#!/bin/sh
# Keep a test VM answering: check it over SSH, and reset it through ESXi
# when it stops.
#
#   GOVC_URL=... GOVC_USERNAME=... GOVC_PASSWORD=... \
#     tools/vm_watchdog.sh [-n NAME] [-s user@host] [-i SECONDS] [-1]
#
# Written for Windows 10 LTSC 2021, which wedges often enough during a
# long matrix run that a sweep can lose a whole machine's cells and
# report them as failures of the product. Any VM works: -n is the name
# ESXi knows it by, -s the address the harness reaches it on.
#
#   -i  seconds between checks (default 300)
#   -1  check once and exit, for cron
#
# The credentials are read from the environment and never written
# anywhere -- no file, no log, no command line -- which is why they are
# not defaulted here. govc reads GOVC_* itself; this script never sees
# the values.
#
# What it does NOT do: it never powers a VM on that is deliberately off,
# because it only resets a machine it has first seen fail a check it
# used to pass. A machine that was never up is left alone and reported.
set -u

name=${TI_WATCH_VM:-"Windows 10 LTSC 2021"}
ssh_to=${TI_WATCH_SSH:-x@10.0.1.86}
every=300
once=0
while [ $# -gt 0 ]; do
	case $1 in
	-n) name=$2; shift 2 ;;
	-s) ssh_to=$2; shift 2 ;;
	-i) every=$2; shift 2 ;;
	-1) once=1; shift ;;
	*) echo "usage: $0 [-n NAME] [-s user@host] [-i SECONDS] [-1]" >&2; exit 2 ;;
	esac
done

: "${GOVC_URL:?set GOVC_URL, GOVC_USERNAME and GOVC_PASSWORD in the environment}"
: "${GOVC_USERNAME:?set GOVC_USERNAME}"
: "${GOVC_PASSWORD:?set GOVC_PASSWORD}"
command -v govc >/dev/null || { echo "govc is not on PATH" >&2; exit 1; }

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

alive() {
	ssh -o ConnectTimeout=20 -o BatchMode=yes -o StrictHostKeyChecking=no \
		"$ssh_to" 'exit 0' >/dev/null 2>&1
}

# Two checks a minute apart before resetting anything: a single missed
# SSH during a reboot the harness itself asked for is not a wedge, and
# resetting a machine mid-install would create exactly the failures this
# exists to prevent.
confirmed_down() {
	alive && return 1
	say "$name did not answer; waiting 60 s and asking again"
	sleep 60
	alive && return 1
	return 0
}

reset_vm() {
	state=$(govc vm.info -json "$name" 2>/dev/null |
		sed -n 's/.*"powerState":[ ]*"\([^"]*\)".*/\1/p' | head -1)
	case $state in
	poweredOff)
		say "$name is powered off in ESXi; powering on"
		govc vm.power -on "$name" >/dev/null 2>&1 || say "  power on failed"
		;;
	poweredOn|"")
		say "$name is powered on but not answering; resetting"
		govc vm.power -reset "$name" >/dev/null 2>&1 || say "  reset failed"
		;;
	*)
		say "$name is in state '$state'; leaving it alone"
		return
		;;
	esac
	# Give it a few minutes to come back, and say whether it did.
	i=0
	while [ "$i" -lt 20 ]; do
		sleep 30
		if alive; then say "$name is answering again"; return; fi
		i=$((i + 1))
	done
	say "$name did not come back within 10 minutes"
}

seen_up=0
while :; do
	if alive; then
		[ "$seen_up" = 0 ] && say "$name is up"
		seen_up=1
	elif [ "$seen_up" = 0 ]; then
		say "$name has not answered since this started; not touching it (it may be off on purpose)"
	elif confirmed_down; then
		reset_vm
	fi
	[ "$once" = 1 ] && break
	sleep "$every"
done
