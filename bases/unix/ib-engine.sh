#!/bin/sh
# TiddlyInstall base engine for Linux and macOS (POSIX sh + awk).
#
# One file, identical in every installer. It is the whole Linux `.run`
# (with a metadata block appended after the final `exit` line) and the
# executable of the macOS `TiddlyInstall.app`. A copy of it is kept in each
# installed app's folder as `uninstall.sh`.
#
# Spec: docs/format.md (records, plans, metadata block, manifest, launch),
# docs/plan.md 1.1-1.7. See bases/unix/README.md.
#
# Nothing in here is per-runtime. Only platform plumbing (downloader,
# sha256 tool, OS version, dialogs, menu entries) branches on the OS.

IB_ENGINE_VERSION=1
IB_DEFAULT_BACKEND=http://10.0.1.76:8080
# The plan signing key (docs/format.md "Plan signature"): base64 of the raw Ed25519
# public key, and its id. make_run.sh / make_app.sh fill these in.
IB_PLAN_PUBKEY=
IB_PLAN_KEYID=
# Our Ed25519 verifiers appended after this script: <arch>:<offset>:<length>
# (make_run.sh fills it; empty in the source and in the macOS .app).
IB_VERIFY_BLOBS=
# When this installer was built (plankey.sh fills both in): RFC 3339 for
# messages, and seconds since the epoch for arithmetic. The real time is
# certainly not earlier than this, which is the only clock floor a machine
# with a wrong RTC gives us (design.md 7.1, "Clocks").
IB_BUILD_TIME=
IB_BUILD_EPOCH=

tab=$(printf '\t')
cr=$(printf '\r')
nl='
'
ifs0=$IFS
set -f
umask 022

# ---------------------------------------------------------------- basics

ib_log() {
	[ -n "$IB_LOG" ] && printf '%s\n' "$*" >> "$IB_LOG"
	return 0
}

# Progress line: log it, and show it when a terminal is watching.
ib_say() {
	ib_log "$*"
	[ "$ib_ui" = tty ] && printf '%s\n' "$*" >&2
	return 0
}

ib_have() { command -v "$1" >/dev/null 2>&1; }

# Run a helper (curl, wget, openssl) with HOME in our temp folder, so it
# can't leave ~/.pki (curl with NSS, CentOS 7), ~/.wget-hsts or ~/.rnd in
# the user's home, and doesn't read their ~/.curlrc or ~/.wgetrc.
ib_nohome() { HOME=${IB_HOME_TMP:-$HOME} "$@"; }

# Text for the screen (stdin -> stdout): C0 controls except tab and
# newline, DEL, C1 controls and the bidi controls (U+200E/F, U+202A-202E,
# U+2066-2069) become '?', so plan text can't hide or reorder what the
# transparency screen shows (an ESC sequence can blank a terminal).
ib_re_c1=$(printf '\302[\200-\237]')
ib_re_bidi1=$(printf '\342\200[\216\217\252-\256]')
ib_re_bidi2=$(printf '\342\201[\246-\251]')
ib_clean() {
	LC_ALL=C tr -d '\000' | LC_ALL=C tr '\001-\010\013-\037\177' '??????????????????????????????' |
		LC_ALL=C sed -e "s/$ib_re_c1/?/g" -e "s/$ib_re_bidi1/?/g" -e "s/$ib_re_bidi2/?/g"
}
ib_cleans() { printf '%s' "$1" | ib_clean; }

# Quote a string for sh.
ib_shq() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

ib_abs() {
	case $1 in
	/*) printf '%s' "$1" ;;
	*) printf '%s/%s' "$PWD" "$1" ;;
	esac
}

ib_fail() {
	ib_rc=${ib_fail_rc:-1}
	ib_progress_stop
	ib_log "FAILED: $*"
	[ -n "$IB_CREATED" ] && [ -f "$IB_CREATED" ] && ib_rollback
	case $ib_ui in
	tty | none | '')
		if [ -n "$IB_LOG" ] && [ -s "$IB_LOG" ]; then
			printf '%s\n' '--- last lines of the log ---' >&2
			tail -n 15 "$IB_LOG" | ib_clean >&2
		fi
		printf 'TiddlyInstall: %s\n' "$(ib_cleans "$*")" >&2
		[ -n "$IB_LOG" ] && printf 'Log: %s\n' "$IB_LOG" >&2
		;;
	zenity)
		ib_clean < "$IB_LOG" > "$IB_LOG.screen" 2>/dev/null
		[ "$opt_yes" = 1 ] || zenity --text-info --title="TiddlyInstall: failed - $(ib_cleans "$*")" --filename="$IB_LOG.screen" --width=780 --height=560 2>/dev/null
		rm -f "$IB_LOG.screen"
		;;
	*)
		[ "$opt_yes" = 1 ] || ib_message error "TiddlyInstall" "$*$nl${nl}Log: $IB_LOG$nl$nl$(tail -n 8 "$IB_LOG" 2>/dev/null)"
		;;
	esac
	exit "$ib_rc"
}

ib_cleanup() {
	[ -n "$IB_WORK" ] && [ -d "$IB_WORK" ] && rm -rf "$IB_WORK"
	[ -n "$ib_progress_pid" ] && kill "$ib_progress_pid" 2>/dev/null
	return 0
}

# ---------------------------------------------------------------- platform plumbing

ib_detect_os() {
	case $(uname -s) in
	Linux) IB_OS=linux ;;
	Darwin) IB_OS=macos ;;
	*) IB_OS=unknown ;;
	esac
	m=$(uname -m)
	case $m in
	x86_64 | amd64) IB_ARCH=amd64 ;;
	i[3-6]86 | x86) IB_ARCH=x86 ;;
	aarch64 | arm64) IB_ARCH=arm64 ;;
	*) IB_ARCH=$m ;;
	esac
	if [ "$IB_OS" = macos ]; then
		# Under Rosetta uname says x86_64; the hardware is what counts.
		[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && IB_ARCH=arm64
		v=$(sw_vers -productVersion 2>/dev/null)
		IB_OSVER=$(printf '%s\n' "$v" | awk -F. '{ printf "%d", $1 * 100 + $2 }')
		IB_OSDESC="macOS $v $IB_ARCH"
	else
		v=$(getconf GNU_LIBC_VERSION 2>/dev/null)
		[ -z "$v" ] && v=$(ldd --version 2>&1 | sed -n 1p)
		IB_OSVER=$(printf '%s\n' "$v" | awk '
			/musl/ { print 0; exit }
			{ for (i = NF; i > 0; i--) if ($i ~ /^[0-9]+\.[0-9]+/) { split($i, p, "."); print p[1] * 100 + p[2]; exit } }
			END { if (NR == 0) print 0 }')
		[ -z "$IB_OSVER" ] && IB_OSVER=0
		IB_OSDESC="Linux, ${v#glibc } ($IB_OSVER), $IB_ARCH"
	fi
}

ib_sha256() { # [file]; reads stdin without an argument
	if ib_have sha256sum; then
		sha256sum ${1:+"$1"} | awk '{ print tolower($1) }'
	elif ib_have shasum; then
		shasum -a 256 ${1:+"$1"} | awk '{ print tolower($1) }'
	elif ib_have openssl; then
		ib_nohome openssl dgst -sha256 ${1:+"$1"} | awk '{ print tolower($NF) }'
	else
		ib_fail "No SHA-256 tool (sha256sum, shasum or openssl) on this machine."
	fi
}

# Lowercase RFC 4648 base32 (no padding) of a hex string, first $2 chars.
ib_b32() {
	awk -v h="$1" -v n="$2" 'BEGIN {
		a = "abcdefghijklmnopqrstuvwxyz234567"; hx = "0123456789abcdef"; b = ""
		for (i = 1; i <= length(h); i++) {
			v = index(hx, substr(h, i, 1)) - 1
			b = b int(v / 8) % 2 int(v / 4) % 2 int(v / 2) % 2 v % 2
		}
		o = ""
		for (i = 0; i < n; i++) {
			v = 0
			for (j = 1; j <= 5; j++) { c = substr(b, i * 5 + j, 1); v = v * 2 + (c == "" ? 0 : c) }
			o = o substr(a, v + 1, 1)
		}
		print o }'
}

ib_download() { # url out
	ib_log "  GET $1"
	ib_http=
	if ib_have curl; then
		ib_http=$(ib_nohome curl -fL -sS --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 2 \
			-w '%{http_code}' -o "$2" "$1" 2>> "$IB_LOG")
	elif ib_have wget; then
		ib_nohome wget -q -T 60 -t 2 -O "$2" "$1" >> "$IB_LOG" 2>&1
	else
		ib_fail "No downloader (curl or wget) on this machine."
	fi
}

# A small document the install can do without (the revocation list): a
# short timeout and no retries, so an offline installer -- which carries
# everything it needs -- isn't held up for a minute by a network that
# isn't there.
ib_download_quick() { # url out
	ib_log "  GET $1 (optional)"
	ib_http=
	if ib_have curl; then
		ib_http=$(ib_nohome curl -fL -sS --connect-timeout 5 --max-time 20 \
			-w '%{http_code}' -o "$2" "$1" 2>> "$IB_LOG")
	elif ib_have wget; then
		ib_nohome wget -q -T 10 -t 1 -O "$2" "$1" >> "$IB_LOG" 2>&1
	else
		return 1
	fi
}

# How the UI talks to the user: tty, zenity, kdialog, osascript, or none.
ib_pick_ui() {
	if [ -t 0 ] && [ -t 2 ]; then
		ib_ui=tty
	elif [ "$IB_OS" = macos ] && ib_have osascript; then
		ib_ui=osascript
	elif [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && ib_have zenity; then
		ib_ui=zenity
	elif [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && ib_have kdialog; then
		ib_ui=kdialog
	else
		ib_ui=none
	fi
}

ib_osa() { # script-on-stdin args...; plan text goes in argv, never into the script
	osascript - "$@"
}

ib_message() { # info|error title text; never a dialog with --yes
	set -- "$1" "$(ib_cleans "$2")" "$(ib_cleans "$3")"
	ui=$ib_ui
	[ "$opt_yes" = 1 ] && ui=none
	case $ui in
	tty | none) printf '%s\n' "$3" >&2 ;;
	zenity) zenity --"$1" --title="$2" --no-markup --text="$3" 2>/dev/null ;;
	kdialog) if [ "$1" = error ]; then kdialog --title "$2" --error "$3"; else kdialog --title "$2" --msgbox "$3"; fi ;;
	osascript)
		ib_osa "$2" "$3" "$1" <<'EOF' >/dev/null 2>&1
on run argv
	activate
	if item 3 of argv is "error" then
		display dialog (item 2 of argv) with title (item 1 of argv) buttons {"OK"} default button "OK" with icon stop
	else
		display dialog (item 2 of argv) with title (item 1 of argv) buttons {"OK"} default button "OK" with icon note
	end if
end run
EOF
		;;
	esac
	return 0
}

# Ask to go ahead. $1 title, $2 full text file, $3 short question.
ib_confirm() {
	[ "$opt_yes" = 1 ] && return 0
	ib_clean < "$2" > "$IB_WORK/confirm.txt"
	[ -f "$IB_WORK/short.txt" ] && { ib_clean < "$IB_WORK/short.txt" > "$IB_WORK/short.clean"; mv "$IB_WORK/short.clean" "$IB_WORK/short.txt"; }
	set -- "$(ib_cleans "$1")" "$IB_WORK/confirm.txt" "$(ib_cleans "$3")"
	case $ib_ui in
	tty)
		# In a terminal the text is longer than the screen, so by the time
		# the question appears the top of it -- what is being installed,
		# and by whom -- has scrolled away. Repeat the short form just
		# above the prompt, where the decision is actually made.
		if ib_want_colour; then ib_paint < "$2" >&2; else cat "$2" >&2; fi
		if [ -f "$IB_WORK/short.txt" ]; then
			printf '\n' >&2
			printf -- '----------------------------------------------------------------------\n' >&2
			if ib_want_colour; then ib_paint < "$IB_WORK/short.txt" >&2; else cat "$IB_WORK/short.txt" >&2; fi
			printf '\n' >&2
		fi
		printf '\n%s [y/N] ' "$3" >&2
		read -r ans || return 1
		case $ans in y | Y | yes | YES | Yes) return 0 ;; esac
		return 1
		;;
	zenity)
		# Monospace, or the columns and the hashes do not line up; a
		# button that says what it does, not "OK". A zenity too old for
		# either answers 255 (a bad option), which a cancel never is.
		ib_dialog_size
		zenity --text-info --title="$1 - $3" --filename="$2" --font="Monospace 10" \
			--width=$ib_dlg_w --height=$ib_dlg_h \
			--ok-label="Install" --cancel-label="Cancel" 2>/dev/null
		rc=$?
		[ $rc = 255 ] && { zenity --text-info --title="$1 - $3" --filename="$2" \
			--width=$ib_dlg_w --height=$ib_dlg_h 2>/dev/null; rc=$?; }
		return $rc
		;;
	kdialog)
		ib_dialog_size
		kdialog --title "$1 - $3" --textbox "$2" $ib_dlg_w $ib_dlg_h &&
			kdialog --title "$1" --yesno "$3"
		;;
	osascript)
		while :; do
			r=$(ib_osa "$1" "$(cat "$IB_WORK/short.txt")" "$3" <<'EOF' 2>/dev/null
on run argv
	activate
	set r to display dialog ((item 2 of argv) & return & return & (item 3 of argv)) with title (item 1 of argv) buttons {"Cancel", "Details...", "Continue"} default button "Continue" cancel button "Cancel" with icon note
	return button returned of r
end run
EOF
)
			case $r in
			Continue) return 0 ;;
			Details*) open -e "$2" ;;
			*) return 1 ;;
			esac
		done
		;;
	*)
		ib_fail "No terminal or dialog tool to ask before installing. Run it in a terminal, or pass --yes to accept without asking."
		;;
	esac
}

ib_progress_start() {
	[ "$ib_ui" = zenity ] && [ "$opt_yes" != 1 ] || return 0
	(while :; do printf '# %s\n' "$1"; sleep 2; done) |
		zenity --progress --pulsate --no-cancel --title="TiddlyInstall" 2>/dev/null &
	ib_progress_pid=$!
}

ib_progress_stop() {
	[ -n "$ib_progress_pid" ] && kill "$ib_progress_pid" 2>/dev/null
	ib_progress_pid=
	return 0
}

# ---------------------------------------------------------------- the review screen's shape
#
# The transparency screen (design.md section 3) has a lot to say, and a
# wall of it is not consent. Three rules hold it together:
#
#   * the answer to "should I run this?" is at the top (IN SHORT), the
#     evidence below it;
#   * a line is never longer than 78 characters unless it is a URL,
#     which is never broken -- half a URL is worse than a long one;
#   * the file itself is always plain text. The log, zenity, kdialog and
#     the macOS dialog all get exactly these bytes; only the terminal
#     path paints them, and only when a terminal is really there.

# 35945651 -> "34.3 MB". Integer arithmetic: there is no bc on a busybox.
ib_hsize() {
	n=${1:-}
	case $n in '' | *[!0-9]*) printf '%s' "$n"; return ;; esac
	if [ "$n" -lt 1024 ]; then printf '%s bytes' "$n"
	elif [ "$n" -lt 1048576 ]; then printf '%s.%s kB' "$((n / 1024))" "$(((n % 1024) * 10 / 1024))"
	elif [ "$n" -lt 1073741824 ]; then printf '%s.%s MB' "$((n / 1048576))" "$(((n % 1048576) * 10 / 1048576))"
	else printf '%s.%s GB' "$((n / 1073741824))" "$(((n % 1073741824) * 10 / 1073741824))"
	fi
}

# "1 file" / "2 files", without a "(s)" anywhere on a consent screen.
ib_plural() { # n singular plural
	[ "$1" = 1 ] && printf '%s' "$2" || printf '%s' "$3"
}

# One command, as one line that cannot run off the screen.
#
# The worst case in the catalogue today is Ruby's relocation step: 831
# characters of shell on one line, then another of 351. Wrapped into the
# body that is eleven lines of `ls | grep | head -1` that nobody can
# review -- and a screen that cannot be reviewed teaches people to click
# through, which is the opposite of what it is for. So a long command is
# shown as its first line's worth, monospaced, with its length and a
# pointer to the log, which always carries every command in full.
ib_cmd_line() { # command
	ib_c=$1
	ib_cn=${#ib_c}
	if [ "$ib_cn" -le 96 ]; then
		printf '     %s\n' "$ib_c"
	else
		printf '     %s...\n' "$(printf '%s' "$ib_c" | cut -c1-93)"
		printf '     (%s characters in all; the whole command is at the end of the log)\n' "$ib_cn"
	fi
}

# A file's size, with the exact byte count only when it adds anything.
ib_size_line() {
	if [ "${1:-0}" -ge 1024 ] 2>/dev/null; then
		printf '     %s (%s bytes)\n' "$(ib_hsize "$1")" "$1"
	else
		printf '     %s\n' "$(ib_hsize "$1")"
	fi
}

# The hosts a list of URLs (stdin) points at, in order, once each. What a
# person wants near the top is "who am I downloading from", not four
# 200-character URLs; the URLs themselves are still in the detail.
ib_hosts() {
	awk '{ u = $0
	       sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", u)
	       sub(/[\/?#].*$/, "", u)
	       sub(/^[^@]*@/, "", u)
	       if (u != "" && !(u in seen)) { seen[u] = 1; out = out (out == "" ? "" : ", ") u } }
	     END { if (out != "") print out }'
}

# Wrap a "key:<padding>value" line (stdin) so the value keeps its column.
# $1 is the width to wrap at, $2 the column the value starts in: the first
# $2 characters are left exactly as they are and every following line is
# indented to match. A token longer than the width is never broken -- half
# a URL is worse than a long one.
ib_wrap() {
	awk -v w="$1" -v ind="$2" '
	{ head = substr($0, 1, ind)
	  if (length($0) <= ind) { print $0; next }
	  pre = ""
	  for (k = 0; k < ind; k++) pre = pre " "        # busybox awk has no %*s
	  rest = substr($0, ind + 1)
	  line = ""; out = 0; n = split(rest, t, " ")
	  for (i = 1; i <= n; i++) {
		if (t[i] == "") continue
		if (line == "") line = t[i]
		else if (ind + length(line) + 1 + length(t[i]) <= w) line = line " " t[i]
		else { print (out++ ? pre : head) line; line = t[i] }
	  }
	  if (line != "") print (out++ ? pre : head) line
	  if (out == 0) print $0 }'
}

# How big the screen is ("W H"), from whatever tool this desktop has.
# Nothing here is required: with no answer the dialog falls back to a
# size that fits 1024x768, which is what the oldest desktops we test on
# actually are.
ib_screen_size() {
	if ib_have xdotool; then
		xdotool getdisplaygeometry 2>/dev/null && return 0
	fi
	if ib_have xdpyinfo; then
		xdpyinfo 2>/dev/null | sed -n 's/^  dimensions: *\([0-9][0-9]*\)x\([0-9][0-9]*\).*/\1 \2/p' | sed -n 1p
		return 0
	fi
	if ib_have xrandr; then
		xrandr 2>/dev/null | sed -n 's/^.* connected[^0-9]*\([0-9][0-9]*\)x\([0-9][0-9]*\)+.*/\1 \2/p' | sed -n 1p
		return 0
	fi
	return 0
}

# The dialog size to ask for: as much as the text wants, less than the
# screen has. A review dialog taller than the screen hides its own
# buttons, which is how the old one lost its bottom on a 1024x768 Xfce.
ib_dialog_size() {
	ib_dlg_w=800
	ib_dlg_h=560
	set -- $(ib_screen_size)
	if [ $# -ge 2 ] && [ "$1" -gt 200 ] 2>/dev/null && [ "$2" -gt 200 ] 2>/dev/null; then
		ib_dlg_w=$(($1 - 80))
		ib_dlg_h=$(($2 - 150))
		[ "$ib_dlg_w" -gt 980 ] && ib_dlg_w=980
		[ "$ib_dlg_h" -gt 820 ] && ib_dlg_h=820
		[ "$ib_dlg_w" -lt 640 ] && ib_dlg_w=640
		[ "$ib_dlg_h" -lt 400 ] && ib_dlg_h=400
	fi
}

# Does the terminal we are talking to take ANSI colour? Never into a log,
# a pipe, an unattended run or a terminal that says it is dumb.
ib_want_colour() {
	[ "$opt_yes" = 1 ] && return 1
	[ -n "${NO_COLOR-}" ] && return 1
	[ "${IB_COLOR-}" = 0 ] && return 1
	[ "${IB_COLOR-}" = 1 ] && return 0
	[ -t 2 ] || return 1
	case ${TERM-} in '' | dumb | unknown | emacs) return 1 ;; esac
	if ib_have tput; then
		c=$(tput colors 2>/dev/null)
		case $c in '' | *[!0-9]*) c=0 ;; esac
		[ "$c" -ge 8 ]
		return
	fi
	case $TERM in
	*color* | *-256* | xterm* | screen* | tmux* | rxvt* | linux | ansi | vt100 | \
		cygwin | putty* | alacritty | foot* | kitty | konsole* | st-* | wezterm) return 0 ;;
	esac
	return 1
}

# Paint the review text for a terminal. The text has already been through
# ib_clean, so nothing in it can carry an escape of its own.
ib_paint() {
	awk '
	BEGIN { b = "\033[1m"; o = "\033[0m"; red = "\033[1;31m"
		yel = "\033[33m"; dim = "\033[2m" }
	/^!! /                        { print red $0 o; next }
	/^!  /                        { print yel $0 o; next }
	/^[-=]+$/                     { print dim $0 o; next }
	/^[A-Z][A-Z0-9 ,.:()\/+-]*$/  { print b $0 o; next }
	/^ +(sha256|from|or) /        { print dim $0 o; next }
	/^  [A-Za-z][A-Za-z ]*: /     { k = index($0, ":"); print b substr($0, 1, k) o substr($0, k + 1); next }
	                              { print }'
}

# ---------------------------------------------------------------- text formats

# Check the first line: `<kind><TAB><version>`, refuse a higher major.
ib_check_header() { # file kind
	h=$(awk -F'\t' '{ sub(/\r$/, "") } /^#/ || /^[ \t]*$/ { next } { print $1 "\t" $2; exit }' "$1")
	[ "${h%%"$tab"*}" = "$2" ] || ib_fail "$1 is not an $2 file."
	major=${h#*"$tab"}
	major=${major%%.*}
	case $major in '' | *[!0-9]*) ib_fail "$1: bad $2 version line." ;; esac
	[ "$major" -le 1 ] || ib_fail "$1 is $2 version $major; this installer reads version 1. Download a newer installer."
}

# First value(s) of key in a text file (header part only for plans).
ib_get() { # file key
	awk -F'\t' -v k="$2" '{ sub(/\r$/, "") } $0 == "[target]" { exit }
		$1 == k { s = $2; for (i = 3; i <= NF; i++) s = s "\t" $i; print s; exit }' "$1"
}

# The plan header plus the first matching [target], normalised:
# header `url` -> `srcurl`; `file`, and the `url`/`step` lines after it,
# get the file's index as their first value.
ib_select_target() { # plan > selection
	awk -F'\t' -v os="$IB_OS" -v ver="$IB_OSVER" -v arch="$IB_ARCH" '
	function rest(from,   s, i) { s = $from; for (i = from + 1; i <= NF; i++) s = s "\t" $i; return s }
	{ sub(/\r$/, "") }
	/^#/ || /^[ \t]*$/ { next }
	!head { head = 1; next }
	$0 == "[target]" { t++; n[t] = 0; next }
	t == 0 { if ($1 == "url") print "srcurl\t" rest(2); else print; next }
	{ n[t]++; L[t, n[t]] = $0 }
	$1 == "when" && !chosen && $2 == os && ver + 0 >= $3 + 0 && ver + 0 <= $4 + 0 {
		k = split($5, a, " ")
		for (i = 1; i <= k; i++) if (a[i] == "*" || a[i] == arch) { chosen = t; break }
	}
	END {
		if (!chosen) { print "fail\tThis installer has nothing for this machine (" os " " ver " " arch ")."; exit }
		print "target\t" chosen
		f = 0; nd = 0
		for (i = 1; i <= n[chosen]; i++) {
			$0 = L[chosen, i]
			if ($1 == "file") { f++; print "file\t" f "\t" rest(2) }
			else if ($1 == "url" || $1 == "step") print $1 "\t" f "\t" rest(2)
			# Prerequisites (format.md "Prerequisites"): need, and the n* lines
			# after it, get the need index.
			else if ($1 == "need") { nd++; print "need\t" nd "\t" rest(2) }
			else if ($1 ~ /^n(why|check|file|url|run|ok|pkg|start|how)$/) { if (nd) print $1 "\t" nd "\t" rest(2) }
			else print
		}
	}' "$1"
}

ib_sel() { # key [index] -> every matching line, key (and index) removed
	awk -F'\t' -v k="$1" -v i="$2" '$1 == k && (i == "" || $2 == i) {
		b = (i == "" ? 2 : 3); s = $b
		for (j = b + 1; j <= NF; j++) s = s "\t" $j
		print s }' "$IB_SEL"
}

ib_sel1() { ib_sel "$@" | sed -n 1p; }

# Replace the format.md tokens in $1. Values come in through ENVIRON so
# nothing is re-escaped; unknown `{...}` is left alone.
ib_subst() {
	IB_S=$1 awk 'function rep(s, tok, val,   o, i) {
		o = ""
		while ((i = index(s, tok)) > 0) { o = o substr(s, 1, i - 1) val; s = substr(s, i + length(tok)) }
		return o s }
	BEGIN {
		s = ENVIRON["IB_S"]
		n = split(ENVIRON["IB_DIRMAP"], m, "\n")
		for (k = 1; k <= n; k++) if (split(m[k], kv, "\t") == 2) s = rep(s, "{dir:" kv[1] "}", kv[2])
		s = rep(s, "{app_dir}", ENVIRON["IB_APP_DIR"])
		s = rep(s, "{data_dir}", ENVIRON["IB_DATA_DIR"])
		s = rep(s, "{runtime_dir}", ENVIRON["IB_RUNTIME_DIR"])
		s = rep(s, "{runtime}", ENVIRON["IB_RUNTIME"])
		s = rep(s, "{dir}", ENVIRON["IB_CUR_DIR"])
		s = rep(s, "{file}", ENVIRON["IB_CUR_FILE"])
		s = rep(s, "{tmp}", ENVIRON["IB_TMP"])
		s = rep(s, "{project}", ENVIRON["IB_PROJECT"])
		s = rep(s, "{sep}", "/")
		printf "%s", s }'
}

# ---------------------------------------------------------------- plan signatures

# Why a fetch failed, for messages.
ib_http_why() {
	[ "$ib_http" = 451 ] && printf ' The backend says this installer has been taken down (HTTP 451).'
	return 0
}

# Our own Ed25519 verifier (bases/unix/verify): a static binary per CPU,
# carried in the .run after the script (IB_VERIFY_BLOBS: arch, byte
# offset in this file, length; make_run.sh fills it) or in the .app's
# Resources. Prints its path, or nothing if there is none for this CPU.
ib_verifier_path() {
	if [ -n "$IB_BUNDLE" ]; then
		case $IB_ARCH in amd64) v=x86_64 ;; arm64) v=arm64 ;; *) return 0 ;; esac
		[ -f "$IB_BUNDLE/Contents/Resources/ibverify-$v" ] && printf '%s' "$IB_BUNDLE/Contents/Resources/ibverify-$v"
		return 0
	fi
	[ -n "$IB_VERIFY_BLOBS" ] || return 0
	set -- $(printf '%s\n' $IB_VERIFY_BLOBS | awk -F: -v a="$IB_ARCH" '$1 == a { print $2 + 0, $3 + 0; exit }')
	[ $# = 2 ] && [ "$2" -gt 0 ] || return 0
	tail -c +"$(($1 + 1))" "$IB_SELF" 2>/dev/null | head -c "$2" > "$IB_WORK/ibverify" 2>/dev/null
	[ "$(wc -c < "$IB_WORK/ibverify" | tr -d ' ')" = "$2" ] || return 0
	chmod 755 "$IB_WORK/ibverify"
	printf '%s' "$IB_WORK/ibverify"
}

# Can this machine check Ed25519 signatures? First our own verifier, then
# `openssl pkeyutl -rawin` (OpenSSL 1.1.1 or later; LibreSSL, 1.0.x and
# some 1.1.1 builds can't). Either is trusted only after it accepts RFC
# 8032 test vector 2 and rejects it with a changed message. Sets ib_ed_how
# (ibverify or openssl), or ib_ed_why when neither works. Cached.
ib_ed25519_ready() {
	[ -n "$ib_ed_ok" ] && return "$ib_ed_ok"
	ib_ed_ok=1
	case $IB_PLAN_PUBKEY in
	'' | *[!A-Za-z0-9+/=]*) ib_ed_why="this installer was built without a plan signing key"; return 1 ;;
	esac
	t=$IB_WORK/edtest
	mkdir -p "$t"
	tpk=PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=
	tsig=kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==
	printf 'r' > "$t/good"
	printf 's' > "$t/bad"
	ib_ibv=$(ib_verifier_path)
	if [ -n "$ib_ibv" ] && "$ib_ibv" "$tpk" "$tsig" < "$t/good" > /dev/null 2>&1; then
		"$ib_ibv" "$tpk" "$tsig" < "$t/bad" > /dev/null 2>&1
		if [ $? = 1 ]; then
			ib_ed_how=ibverify ib_ed_ok=0
			return 0
		fi
	fi
	ib_ed_why="no built-in verifier for this CPU ($(uname -m))"
	[ -n "$ib_ibv" ] && ib_ed_why="the built-in verifier doesn't run here"
	ib_have openssl || { ib_ed_why="$ib_ed_why, and no openssl"; return 1; }
	printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$tpk" > "$t/pub.pem"
	printf '%s\n' "$tsig" | ib_nohome openssl base64 -d -A > "$t/sig" 2>/dev/null
	if ib_nohome openssl pkeyutl -verify -pubin -inkey "$t/pub.pem" -rawin -in "$t/good" -sigfile "$t/sig" > /dev/null 2>&1 &&
		! ib_nohome openssl pkeyutl -verify -pubin -inkey "$t/pub.pem" -rawin -in "$t/bad" -sigfile "$t/sig" > /dev/null 2>&1; then
		printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$IB_PLAN_PUBKEY" > "$IB_WORK/plan-key.pem"
		ib_ed_how=openssl ib_ed_ok=0
		return 0
	fi
	ib_ed_why="$ib_ed_why, and $(ib_nohome openssl version 2>/dev/null | sed -n 1p) can't check Ed25519 signatures"
	return 1
}

# The signature of plan $1 (format.md "Plan signature"): prints ok, unsigned,
# bad:<why> or cannot:<why> (no way to check it here).
ib_plan_sig() { ib_doc_sig "$1" ib-plan; }

# The same for any document signed with the plan key: $2 is the header its
# signed bytes must start with, so a plan's signature can't be read as a
# revocation list or the other way round (format.md section 7).
ib_doc_sig() { # file kind
	f=$1
	sig_kind=${2:-ib-plan}
	sig_tmp=$IB_WORK/$sig_kind.check
	case $sig_kind in
	ib-revocations) sig_what="revocation list" ;;
	*) sig_what=plan ;;
	esac
	last=$(tail -n 1 "$f" | tr -d '\r')
	case $last in
	sig"$tab"ed25519"$tab"*) ;;
	sig | sig"$tab"*) echo "bad:unknown signature type"; return 0 ;;
	*) echo unsigned; return 0 ;;
	esac
	b64=${last#sig"$tab"ed25519"$tab"}
	case $b64 in *[!A-Za-z0-9+/=]*) echo "bad:malformed signature"; return 0 ;; esac
	[ ${#b64} -eq 88 ] || { echo "bad:malformed signature"; return 0; }
	n=$(($(wc -c < "$f") - $(tail -n 1 "$f" | wc -c)))
	[ "$n" -gt 0 ] || { echo unsigned; return 0; }
	ib_ed25519_ready || { echo "cannot:$ib_ed_why"; return 0; }
	head -c "$n" "$f" > "$sig_tmp.signed"
	[ "$(head -c $((${#sig_kind} + 1)) "$sig_tmp.signed")" = "$sig_kind$tab" ] || { echo "bad:the signed bytes are not an $sig_kind"; return 0; }
	if [ "$ib_ed_how" = ibverify ]; then
		"$ib_ibv" "$IB_PLAN_PUBKEY" "$b64" < "$sig_tmp.signed" > /dev/null 2>&1
		case $? in
		0) echo "ok:ibverify" ;;
		1) echo "bad:the signature does not match this $sig_what and this installer's key" ;;
		*) echo "bad:malformed signature" ;;
		esac
		return 0
	fi
	printf '%s\n' "$b64" | ib_nohome openssl base64 -d -A > "$sig_tmp.sig" 2>/dev/null
	[ "$(wc -c < "$sig_tmp.sig" | tr -d ' ')" = 64 ] || { echo "bad:malformed signature"; return 0; }
	if ib_nohome openssl pkeyutl -verify -pubin -inkey "$IB_WORK/plan-key.pem" -rawin -in "$sig_tmp.signed" \
		-sigfile "$sig_tmp.sig" > /dev/null 2>&1; then
		echo "ok:openssl"
	else
		echo "bad:the signature does not match this $sig_what and this installer's key"
	fi
}

# Decide whether the plan may be used (format.md "Plan signature"). Fetched plans must
# be signed by the built-in key; when this machine can't check signatures,
# only a plan fetched over HTTPS (curl and wget check the certificate) is
# accepted. --plan / install.txt plans must be signed unless
# --unsigned-plan. Embedded plans are as trustworthy as the installer
# file, so an unsigned one is used with a warning.
ib_check_plan() {
	ib_plan_warn=
	sig=$(ib_plan_sig "$IB_PLAN")
	ib_log "Plan signature: $sig (key ${IB_PLAN_KEYID:-none})"
	why=${sig#*:}
	case $sig in
	ok:*)
		IB_PLAN_FROM="$IB_PLAN_FROM; signed by the TiddlyInstall key $IB_PLAN_KEYID (checked with ${sig#ok:})"
		return 0
		;;
	esac
	case $IB_PLAN_KIND in
	embedded)
		ib_plan_warn="The embedded plan is not signed by the TiddlyInstall key ($why). It is only as trustworthy as this installer file."
		;;
	cmdline)
		[ "$opt_unsigned" = 1 ] || ib_fail "The plan $IB_PLAN is not signed by the TiddlyInstall key ${IB_PLAN_KEYID:-} ($why). Use a plan saved from <backend>/api/plan/<record>, or add --unsigned-plan if you wrote it yourself."
		ib_plan_warn="The plan is not signed ($why); --unsigned-plan was given."
		;;
	*)
		case $sig in
		cannot:*)
			case $IB_PLAN_URL in
			https://*)
				ib_plan_warn="The plan's signature could not be checked ($why); it was accepted because it came over HTTPS from ${IB_PLAN_URL%%/api/*}."
				return 0
				;;
			esac
			ib_fail "The install plan came over plain HTTP and its signature can't be checked here: $why. Install OpenSSL 1.1.1 or later, or use an HTTPS backend (--backend=https://...)."
			;;
		esac
		ib_fail "The install plan from ${IB_PLAN_URL%%/api/*} is not signed by the TiddlyInstall key ${IB_PLAN_KEYID:-} ($why). It may have been changed on the way; nothing was installed."
		;;
	esac
}

# ---------------------------------------------------------------- stale plans (design.md 7.1)
#
# A signed plan we really did sign, replayed later, is the one thing a
# signature does not stop. Three answers, one per population:
#
#   fetched plan  a nonce, echoed into the signed bytes: a replay carries
#                 someone else's nonce (ib_nonce, ib_check_nonce)
#   carried plan, network      the signed revocation list (ib_revocations)
#   carried plan, no network   `signed` and `maxage` (ib_check_age), and
#                 only when this machine's clock is plausible against the
#                 build time baked into this installer. A wrong clock
#                 warns; it never stops an install.

ib_is_nonce() { # value -> 0 if 32 lowercase hex characters
	case $1 in
	????????????????????????????????)
		case $1 in *[!0-9a-f]*) return 1 ;; esac
		return 0
		;;
	esac
	return 1
}

# A nonce for a plan request: 16 random bytes as 32 hex characters.
# /dev/urandom where there is one, else the clock, the pid, this file and
# what is being installed, hashed -- an XP-era machine's entropy is poor,
# and it does not matter much: the nonce only has to be unpredictable to
# someone who prepared a replay in advance, and a repeated one costs
# nothing. IB_NONCE is empty if even that fails; the plan is then asked
# for without one, as an older engine would.
ib_nonce() { # what is being asked for
	IB_NONCE=
	# A fixed nonce, so a test can pre-sign the answer (test_freshness.sh).
	if ib_is_nonce "${IB_TEST_NONCE:-}"; then
		IB_NONCE=$IB_TEST_NONCE
		return 0
	fi
	if [ -r /dev/urandom ]; then
		IB_NONCE=$(dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -v -tx1 2>/dev/null | tr -d ' \t\n' | cut -c1-32)
		ib_is_nonce "$IB_NONCE" || IB_NONCE=
	fi
	if [ -z "$IB_NONCE" ]; then
		IB_NONCE=$(printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y%m%d%H%M%S 2>/dev/null)" "$$" "$IB_SELF" "$1" | ib_sha256 | cut -c1-32)
		ib_is_nonce "$IB_NONCE" || IB_NONCE=
	fi
	[ -n "$IB_NONCE" ] || ib_log "No nonce could be made here; asking for the plan without one."
	return 0
}

# `?nonce=...` for a plan URL, or nothing.
ib_nonce_query() {
	[ -n "$IB_NONCE" ] && printf '?nonce=%s' "$IB_NONCE"
	return 0
}

# The values of the first `request` line of kind $2 in a plan's header
# (format.md section 1: a repeated key, first line wins).
ib_plan_req() { # file kind
	awk -F'\t' -v k="$2" '{ sub(/\r$/, "") } $0 == "[target]" { exit }
		$1 == "request" && $2 == k { s = $3; for (i = 4; i <= NF; i++) s = s "\t" $i; print s; exit }' "$1"
}

# The plan must answer *this* request. A backend that echoes no nonce is
# simply an older backend: the plan is used, and the transparency screen
# says a replayed older plan could not be ruled out.
ib_check_nonce() {
	[ -n "$IB_NONCE" ] || return 0
	case $IB_PLAN_KIND in fetched) ;; *) return 0 ;; esac
	got=$(ib_plan_req "$IB_PLAN" nonce)
	if [ -z "$got" ]; then
		ib_log "Nonce $IB_NONCE sent; the plan carries none (an older backend)."
		IB_PLAN_FROM="$IB_PLAN_FROM; no nonce in the answer (an older backend), so an older plan replayed on the way can't be ruled out"
		return 0
	fi
	[ "$got" = "$IB_NONCE" ] ||
		ib_fail "The install plan from ${IB_PLAN_URL%%/api/*} is the answer to another request (it carries nonce $got, not the $IB_NONCE this installer sent). It may be an older plan replayed on the way; nothing was installed."
	ib_log "Nonce $IB_NONCE echoed in the plan."
	IB_PLAN_FROM="$IB_PLAN_FROM; nonce checked"
	return 0
}

# Seconds since the epoch, or '' when this machine won't say.
ib_epoch_now() {
	n=$(date -u +%s 2>/dev/null)
	case $n in '' | *[!0-9]*) n=$(awk 'BEGIN { print systime() }' 2>/dev/null) ;; esac
	case $n in '' | *[!0-9]*) n= ;; esac
	printf '%s' "$n"
}

# An RFC 3339 UTC time (2026-09-20T11:02:07Z) as seconds since the epoch,
# or '' if it isn't one. Days from the civil date in awk, so no date(1)
# extension is needed: `date -d` is GNU and `date -j` is BSD.
ib_epoch_of() { # time
	awk -v s="$1" 'BEGIN {
		if (s !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) exit
		y = substr(s, 1, 4) + 0; m = substr(s, 6, 2) + 0; d = substr(s, 9, 2) + 0
		H = substr(s, 12, 2) + 0; M = substr(s, 15, 2) + 0; S = substr(s, 18, 2) + 0
		if (m < 1 || m > 12 || d < 1 || d > 31 || H > 23 || M > 59 || S > 60) exit
		yy = y - (m <= 2 ? 1 : 0)
		era = int((yy >= 0 ? yy : yy - 399) / 400)
		yoe = yy - era * 400
		doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
		doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
		printf "%d\n", (era * 146097 + doe - 719468) * 86400 + H * 3600 + M * 60 + S
	}' 2>/dev/null
}

# This machine's clock as text, for messages.
ib_clock_says() {
	c=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
	[ -n "$c" ] || c="(unreadable)"
	printf '%s' "$c"
}

# How old a carried plan may be: the plan's `maxage`, never past the hard
# limit of 365 days, and 90 days when it says nothing.
IB_MAXAGE_DEFAULT=7776000
IB_MAXAGE_LIMIT=31536000
# Ten years: past this from the build time the clock is not believable.
IB_CLOCK_SPAN=315576000

# `signed` / `maxage` on a plan this installer carries (format.md section
# 3). A fetched plan was made this minute, so this is for embedded and
# --plan plans only. Sets ib_age_warn, or stops with a refusal.
ib_check_age() { # backend
	ib_age_warn=
	IB_PLAN_SIGNED=$(ib_get "$IB_PLAN" signed)
	IB_PLAN_MAXAGE=$(ib_get "$IB_PLAN" maxage)
	case $IB_PLAN_KIND in fetched) return 0 ;; esac
	[ -n "$IB_PLAN_SIGNED" ] || return 0
	sec=$(ib_epoch_of "$IB_PLAN_SIGNED")
	[ -n "$sec" ] || { ib_log "Plan signed \"$IB_PLAN_SIGNED\": not a time this engine reads; age not checked."; return 0; }
	max=$IB_PLAN_MAXAGE
	case $max in '' | *[!0-9]*) max=$IB_MAXAGE_DEFAULT ;; esac
	[ "$max" -gt "$IB_MAXAGE_LIMIT" ] && max=$IB_MAXAGE_LIMIT
	[ "$max" -lt 1 ] && max=1
	bt=$IB_BUILD_EPOCH
	case $bt in '' | *[!0-9]*) bt=0 ;; esac
	now=$(ib_epoch_now)
	# The real time is certainly not before this installer was built, and
	# ten years after it is as far as a plausible clock goes. That floor
	# owes nothing to the machine's battery-backed clock.
	plausible=0
	if [ -n "$now" ] && [ "$bt" -gt 0 ] && [ "$now" -ge "$bt" ] && [ "$now" -le $((bt + IB_CLOCK_SPAN)) ]; then
		plausible=1
		[ "$now" -lt "$sec" ] && plausible=0   # a plan from the future: don't believe the clock
	fi
	if [ "$plausible" != 1 ]; then
		ib_age_warn="This installer's plan was signed on $IB_PLAN_SIGNED, and this machine's clock says $(ib_clock_says), which can't be right (this installer was built $IB_BUILD_TIME), so how old the plan is can't be told. Nothing is refused for age."
		ib_log "Clock not plausible (now ${now:-unreadable}, built $bt); the plan's age is reported only."
		return 0
	fi
	age=$((now - sec))
	ib_log "Plan signed $IB_PLAN_SIGNED, $((age / 86400)) days ago; maxage $max s."
	[ "$age" -le "$max" ] && return 0
	where=$1
	[ -n "$where" ] || where=$IB_DEFAULT_BACKEND
	if [ "$age" -gt "$IB_MAXAGE_LIMIT" ]; then
		ib_fail "This installer's plan was signed on $IB_PLAN_SIGNED, $((age / 86400)) days ago, past the $((IB_MAXAGE_LIMIT / 86400))-day limit. What it installs may since have been withdrawn or found unsafe. Get a current installer from $where and run that instead; nothing was installed."
	fi
	ib_age_warn="This installer's plan was signed on $IB_PLAN_SIGNED, $((age / 86400)) days ago (it is meant to be used within $((max / 86400)) days). What it installs may have moved on. A current installer is at $where."
	return 0
}

# ---- the signed revocation list (format.md section 7)

# Where the last good list is kept, so an installer that can't reach a
# backend still has the newest one this machine has seen.
ib_revoke_cache() {
	d=
	if [ "$IB_OS" = macos ] && [ -n "$HOME" ]; then
		d=$HOME/Library/Caches/TiddlyInstall
	elif [ -n "${XDG_CACHE_HOME:-}" ]; then
		d=$XDG_CACHE_HOME/tiddlyinstall
	elif [ -n "$HOME" ]; then
		d=$HOME/.cache/tiddlyinstall
	fi
	[ -n "$d" ] && printf '%s/revocations.txt' "$d"
	return 0
}

ib_revoke_serial() { # file
	s=$(ib_get "$1" serial)
	case $s in '' | *[!0-9]*) s=0 ;; esac
	printf '%s' "$s"
}

# The keys this install matches, one per line, as `revoke` line values.
ib_revoke_keys() {
	[ -n "$IB_RECHASH" ] && printf 'record\t%s\n' "$IB_RECHASH"
	[ -n "$IB_PLAN_REQUEST" ] && printf '%s\n' "$IB_PLAN_REQUEST"
	if [ -n "$IB_REC" ]; then
		src=$(ib_get "$IB_REC" source)
		kind=${src%%"$tab"*}
		val=${src#*"$tab"}
		val=${val%%"$tab"*}
		if [ -n "$kind" ] && [ "$kind" != "$src" ]; then
			val=$(printf '%s' "$val" | tr 'A-Z' 'a-z')
			if [ "$kind" = github ]; then
				val=${val#http://}
				val=${val#https://}
				val=${val#github.com/}
				val=${val%/}
				val=${val%.git}
			fi
			printf 'source\t%s\t%s\n' "$kind" "$val"
		fi
	fi
	# Every file this install would download, by its SHA-256: `sha` names
	# one we store (a written source, an icon), `file` the bytes wherever
	# they come from. In the selection (ib_select_target) a `source` line
	# is `name sha size format strip` and a `file` line carries its index
	# first: `n name filename sha size [arch]`.
	awk -F'\t' '$1 == "source" { print $3 } $1 == "file" { print $5 } $1 == "nfile" { print $4 }' "$IB_SEL" |
		while IFS= read -r h; do
			case $h in '' | *[!0-9a-f]*) continue ;; esac
			printf 'sha\t%s\nfile\t%s\n' "$h" "$h"
		done
	return 0
}

# The first entry in list $1 that this install matches, as text, or ''.
ib_revoke_match() { # list keysfile
	awk -F'\t' -v tab="$tab" '
	NR == FNR { sub(/\r$/, ""); if ($0 != "") key[$0] = 1; next }
	{ sub(/\r$/, "") }
	$1 != "revoke" { next }
	{
		k = $2
		for (i = 3; i <= NF; i++) {
			if ((k) in key) break
			k = k tab $i
		}
		if ((k) in key) { print k; exit }
	}' "$2" "$1"
}

# Fetch, check and apply the revocation list for a plan this installer
# carries (design.md 7.1). Mode A and fetched plans don't: their fetch is
# already the check (the backend answers 451), and a request that can be
# dropped is worse than one that can't.
ib_revocations() { # backend
	ib_revoke_note=
	case $IB_PLAN_KIND in fetched) return 0 ;; esac
	[ "$IB_MODE_A" = 1 ] && return 0
	url=$1/api/revocations
	f=$IB_WORK/revocations.txt
	got=
	ib_say "Checking the revocation list"
	if ib_download_quick "$url" "$f" && [ -s "$f" ]; then
		sig=$(ib_doc_sig "$f" ib-revocations)
		case $sig in
		ok:*) got=$f ;;
		*) ib_log "Revocation list from $url: $sig" ;;
		esac
	else
		ib_log "Could not fetch $url.$(ib_http_why)"
	fi
	cache=$(ib_revoke_cache)
	# The freshest list wins, and a list is honoured even when `expires`
	# has passed: it can only ever deny an install, so trusting a stale
	# one is the recoverable mistake (design.md 7.1).
	if [ -n "$cache" ] && [ -f "$cache" ]; then
		if [ -z "$got" ]; then
			got=$cache
			ib_revoke_note="the backend could not be reached; the last list this machine saw (issued $(ib_get "$cache" issued)) was used"
		elif [ "$(ib_revoke_serial "$cache")" -gt "$(ib_revoke_serial "$got")" ]; then
			got=$cache
			ib_log "The cached revocation list is newer than the one fetched; using it."
		fi
	fi
	if [ -z "$got" ]; then
		ib_revoke_note="no revocation list could be fetched or found on this machine, so only the plan's own age was checked"
		return 0
	fi
	if [ "$got" != "$cache" ] && [ -n "$cache" ]; then
		if mkdir -p "$(dirname "$cache")" 2>/dev/null; then
			if [ ! -f "$cache" ] || [ "$(ib_revoke_serial "$got")" -ge "$(ib_revoke_serial "$cache")" ]; then
				cp "$got" "$cache.tmp.$$" 2>/dev/null && mv "$cache.tmp.$$" "$cache" 2>/dev/null
				rm -f "$cache.tmp.$$" 2>/dev/null
			fi
		fi
	fi
	ib_revoke_keys > "$IB_WORK/revoke-keys"
	hit=$(ib_revoke_match "$got" "$IB_WORK/revoke-keys")
	if [ -n "$hit" ]; then
		ib_fail "$(printf 'This install has been withdrawn: the revocation list at %s names %s. Nothing was installed.' "$1" "$(printf '%s' "$hit" | tr '\t' ' ')")"
	fi
	[ -z "$ib_revoke_note" ] && ib_revoke_note="checked against the list issued $(ib_get "$got" issued) (serial $(ib_revoke_serial "$got"))"
	ib_log "Revocation list: $ib_revoke_note"
	return 0
}

# Mode A on macOS: an app bundle signed with an identity (not ad-hoc)
# whose signature verifies and that carries no settings of its own. It
# installs only what its name names, from the built-in backend (design.md
# 3 and 7): its signature must not vouch for anyone's --record or --plan.
# Linux .run files carry no signature, so there is nothing to protect.
# IB_TEST_MODE_A=1 turns the restriction on anywhere (tests).
ib_detect_mode_a() {
	IB_MODE_A=0
	[ "${IB_TEST_MODE_A:-}" = 1 ] && { IB_MODE_A=1; return 0; }
	[ -n "$IB_BUNDLE" ] && ib_have codesign || return 0
	d=$IB_BUNDLE/Contents/Resources/ib
	[ -e "$d/record.txt" ] || [ -e "$d/plan.txt" ] && return 0
	case $(codesign -dvv "$IB_BUNDLE" 2>&1) in *Authority=*) ;; *) return 0 ;; esac
	codesign --verify "$IB_BUNDLE" > /dev/null 2>&1 && IB_MODE_A=1
	return 0
}

# ---------------------------------------------------------------- finding the metadata

# Fill IB_REC / IB_PLAN (files, either may be empty), IB_PACK_TAR or
# IB_PACK_DIR, IB_ORIGIN, IB_ENGINE_LEN.
ib_find_metadata() {
	IB_ENGINE_LEN=$(wc -c < "$IB_SELF" | tr -d ' ')
	# The appended block (Linux .run) or the .app's Resources/ib (macOS).
	if [ -n "$IB_BUNDLE" ]; then
		d=$IB_BUNDLE/Contents/Resources/ib
		[ -f "$d/record.txt" ] && ib_block_rec=$d/record.txt
		[ -f "$d/plan.txt" ] && ib_block_plan=$d/plan.txt
		[ -d "$d/pack" ] && IB_PACK_DIR=$d/pack
		[ -f "$d/pack.tar" ] && IB_PACK_TAR=$d/pack.tar
		ib_block_where="files in $(basename "$IB_BUNDLE")/Contents/Resources/ib"
	else
		foot=$(tail -c 64 "$IB_SELF" 2>/dev/null)
		case $foot in
		"IBMETA1 "*)
			IFS=' '
			set -- $foot
			IFS=$ifs0
			lens=$(printf '%s %s %s\n' "$2" "$3" "$4" | awk '{ printf "%d %d %d", $1, $2, $3 }')
			set -- $lens
			r=$1 p=$2 k=$3
			total=$IB_ENGINE_LEN
			IB_ENGINE_LEN=$((total - 64 - r - p - k))
			[ "$IB_ENGINE_LEN" -gt 0 ] || ib_fail "The metadata block at the end of this installer is damaged."
			off=$((IB_ENGINE_LEN + 1))
			if [ "$r" -gt 0 ]; then
				tail -c +"$off" "$IB_SELF" | head -c "$r" > "$IB_WORK/block-record.txt"
				ib_block_rec=$IB_WORK/block-record.txt
			fi
			off=$((off + r))
			if [ "$p" -gt 0 ]; then
				tail -c +"$off" "$IB_SELF" | head -c "$p" > "$IB_WORK/block-plan.txt"
				ib_block_plan=$IB_WORK/block-plan.txt
			fi
			off=$((off + p))
			if [ "$k" -gt 0 ]; then
				tail -c +"$off" "$IB_SELF" | head -c "$k" > "$IB_WORK/pack.tar"
				IB_PACK_TAR=$IB_WORK/pack.tar
			fi
			ib_block_where="the block appended to $(basename "$IB_SELF")"
			;;
		esac
	fi
	if [ -n "$IB_PACK_TAR" ]; then
		tar -tf "$IB_PACK_TAR" > "$IB_WORK/pack.list" 2>/dev/null || ib_fail "The packed files in this installer are damaged."
	fi

	ib_detect_mode_a
	if [ "$IB_MODE_A" = 1 ]; then
		given=
		[ -n "$opt_record" ] && given="$given --record"
		[ -n "$opt_plan" ] && given="$given --plan"
		[ "$opt_unsigned" = 1 ] && given="$given --unsigned-plan"
		[ -n "$opt_backend" ] && given="$given --backend"
		[ -n "$given" ] && ib_fail "This installer is signed and only installs the app its name names, from $IB_DEFAULT_BACKEND. It doesn't accept$given. For your own settings use an unsigned base or one you sign yourself (modes B and C)."
		ib_log "Signed base with no settings inside: mode A (its name and the built-in backend only)"
	fi
	# 1. Command-line options.
	if [ -n "$opt_record$opt_plan" ]; then
		IB_REC=$opt_record IB_PLAN=$opt_plan IB_PLAN_KIND=cmdline
		IB_ORIGIN=${opt_origin:-command-line options}
		return 0
	fi
	# 2. The embedded block.
	if [ -n "$ib_block_rec$ib_block_plan" ]; then
		IB_REC=$ib_block_rec IB_PLAN=$ib_block_plan IB_PLAN_KIND=embedded
		IB_ORIGIN=$ib_block_where
		return 0
	fi
	# 3. install.txt next to the installer (a record, or a plan: a plan
	# there is treated like --plan). Not in mode A.
	if [ -f "$IB_HOME_DIR/install.txt" ] && [ "$IB_MODE_A" = 1 ]; then
		ib_log "Ignoring $IB_HOME_DIR/install.txt: a signed installer only uses its name."
	elif [ -f "$IB_HOME_DIR/install.txt" ]; then
		case $(sed -n 1p "$IB_HOME_DIR/install.txt") in
		ib-plan*) IB_PLAN=$IB_HOME_DIR/install.txt IB_PLAN_KIND=cmdline ;;
		*) IB_REC=$IB_HOME_DIR/install.txt ;;
		esac
		IB_ORIGIN="install.txt next to the installer"
		return 0
	fi
	# 4. A record hash as the last `_` token of the file name (mode A).
	nm=$IB_NAME
	nm=$(printf '%s' "$nm" | sed -e 's/ - Copy$//' -e 's/ *([0-9]*)$//')
	last=${nm##*_}
	last=$(printf '%s' "$last" | tr 'A-Z' 'a-z')
	case $last in
	*[!a-z2-7]*) ;;
	??????????????????????????)
		# Installed already? Checked before the record is fetched.
		ib_installed_offline "$last"
		backend=${opt_backend:-$IB_DEFAULT_BACKEND}
		IB_REC=$IB_WORK/record.txt
		ib_download "$backend/api/records/$last" "$IB_REC" ||
			ib_fail "Could not fetch this installer's settings from $backend/api/records/$last.$(ib_http_why)"
		got=$(ib_b32 "$(ib_sha256 "$IB_REC")" 26)
		[ "$got" = "$last" ] ||
			ib_fail "The settings fetched from $backend do not match this installer's name (hash $got, expected $last). Not installing."
		IB_ORIGIN="record $last named in the file name, fetched from $backend and checked against its SHA-256"
		return 0
		;;
	esac
	# 5. Plain tokens: install_<runtime>_<package>.
	case $nm in
	install_*_*)
		rt=${nm#install_}
		pk=${rt#*_}
		rt=${rt%%_*}
		case $rt$pk in *[!A-Za-z0-9_.-]*) ib_fail "Unusable installer name: $IB_NAME" ;; esac
		backend=${opt_backend:-$IB_DEFAULT_BACKEND}
		IB_PLAN=$IB_WORK/plan.txt IB_PLAN_KIND=fetched IB_PLAN_URL=$backend/api/plan/name/$rt/$pk
		IB_PLAN_REQUEST="name$tab$rt$tab$pk"
		ib_nonce "$rt/$pk"
		ib_download "$IB_PLAN_URL$(ib_nonce_query)" "$IB_PLAN" ||
			ib_fail "This installer is named for $pk ($rt) but $backend has no plan for that name.$(ib_http_why)"
		IB_ORIGIN="the file name (runtime $rt, package $pk); plan from $backend"
		return 0
		;;
	esac
	ib_fail "This installer carries no settings: no metadata block, no install.txt, and no record hash in its name ($IB_NAME)."
}

# ---------------------------------------------------------------- install helpers

# mkdir -p, remembering each folder it made (for rollback and the manifest).
ib_mkdirs() {
	[ -d "$1" ] && return 0
	ib_mk_missing=
	p=$1
	while [ ! -d "$p" ]; do
		ib_mk_missing="$p$nl$ib_mk_missing"
		p=$(dirname "$p")
	done
	mkdir -p "$1" || return 1
	printf '%s' "$ib_mk_missing" | while IFS= read -r p; do
		[ -n "$p" ] && printf 'e\t%s\n' "$p" >> "$IB_CREATED"
	done
	return 0
}

ib_created() { printf '%s\t%s\n' "$1" "$2" >> "$IB_CREATED"; }

# On failure: remove what this run made, newest first.
ib_rollback() {
	ib_log "Removing what was installed so far"
	awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' "$IB_CREATED" > "$IB_CREATED.rev"
	while IFS="$tab" read -r kind p; do
		case $kind in
		r) rm -rf "$p" && ib_log "  removed $p" ;;
		e) rmdir "$p" 2>/dev/null && ib_log "  removed $p" ;;
		esac
	done < "$IB_CREATED.rev"
	rm -f "$IB_CREATED" "$IB_CREATED.rev"
	IB_CREATED=
}

# Is $1 inside one of the app's own folders (or {tmp})?
ib_inside() {
	case $1 in */../* | */.. | ../*) return 1 ;; esac
	case $1 in
	"$IB_APP_DIR" | "$IB_APP_DIR"/* | "$IB_TMP" | "$IB_TMP"/*) return 0 ;;
	esac
	printf '%s' "$IB_DIRMAP" | while IFS="$tab" read -r n d; do
		[ -n "$d" ] || continue
		case $1 in "$d" | "$d"/*) exit 3 ;; esac
	done
	[ $? = 3 ]
}

# Get a verified file: from the pack, else from each URL in turn.
#
# $5 = "unpinned" allows $1 to be "-", meaning this file has no stored
# SHA-256 and is identified some other way. Only the app's own source may
# ask for that, and only for a GitHub commit over HTTPS (format.md,
# "Sources without a stored hash"): the commit id names the snapshot and
# TLS vouches for the repo, and GitHub's generated archives are not
# byte-stable, so a stored hash goes stale.
#
# "-" and not an empty field: a tab is IFS white space, so `set -- $line`
# collapses a run of tabs and an empty field in the middle of a line
# would shift every field after it left (format.md section 1).
#
# It is an explicit argument rather than "no hash means don't check", so
# a `file` line that somehow arrives without one still fails closed
# instead of being installed unchecked.
ib_obtain() { # sha256 out urls-file label [unpinned]
	if [ -z "$1" ] || [ "$1" = - ]; then
		[ "${5:-}" = unpinned ] || { ib_log "refusing a file with no SHA-256"; return 1; }
		ib_obtain_unpinned "$2" "$3" "$4"
		return $?
	fi
	if [ -n "$IB_PACK_DIR" ] && [ -f "$IB_PACK_DIR/$1" ]; then
		cp "$IB_PACK_DIR/$1" "$2"
		ib_log "  from the pack"
	elif [ -n "$IB_PACK_TAR" ] && grep -qx "$1" "$IB_WORK/pack.list"; then
		(cd "$(dirname "$2")" && tar -xf "$IB_PACK_TAR" "$1" && mv "$1" "$(basename "$2")")
		ib_log "  from the pack"
	fi
	if [ -f "$2" ]; then
		[ "$(ib_sha256 "$2")" = "$1" ] && return 0
		ib_say "  the packed copy of $4 has the wrong SHA-256; trying downloads"
		rm -f "$2"
	fi
	while IFS= read -r u <&4; do
		[ -n "$u" ] || continue
		ib_say "  downloading $u"
		if ib_download "$u" "$2.part"; then
			got=$(ib_sha256 "$2.part")
			if [ "$got" = "$1" ]; then
				mv "$2.part" "$2"
				return 0
			fi
			ib_say "  wrong SHA-256 from $u ($got); trying the next source"
		else
			ib_say "  download failed: $u"
		fi
		rm -f "$2.part"
	done 4< "$3"
	return 1
}

ib_move_into() { # entry dest: move, merging folders that already exist
	b=$(basename "$1")
	if [ -d "$2/$b" ] && [ -d "$1" ] && [ ! -h "$1" ]; then
		cp -RPp "$1/." "$2/$b/" && rm -rf "$1"
	else
		mv -f "$1" "$2/"
	fi
}

# ---- unpack excludes (docs/format.md, the `unpack` step's 4th field)
#
# A "|"-separated list of glob patterns, matched against each entry's
# path inside the archive with any leading "./" removed. "*" matches any
# run of characters, "/" included; "?" matches one character. An entry is
# left out when its own path or any parent's matches.
#
# Best effort by design: where the unpacker can skip the entries it is
# told to (tar --exclude, unzip -x, 7z -x!) nothing is written at all,
# and whatever it still wrote is deleted before the strip/move. An engine
# that does not know the field unpacks everything, so what a recipe
# excludes must be something the app never needs.

# These three expand patterns unquoted, so they insist on the engine's
# `set -f`: with globbing on, a pattern such as */*/share/man would be
# replaced by whatever matches it in the current directory.

# $u_exl: one pattern per line ("" for none).
ib_ex_split() { # "a|b|c"
	set -f
	u_exl=
	[ -n "$1" ] || return 0
	u_ifs=$IFS
	IFS='|'
	for u_p in $1; do
		[ -n "$u_p" ] || continue
		u_exl="$u_exl$u_p$nl"
	done
	IFS=$u_ifs
}

# Does an archive-relative path match one of $u_exl?
ib_ex_match() { # path
	set -f
	[ -n "$u_exl" ] || return 1
	u_ifs=$IFS
	IFS=$nl
	for u_p in $u_exl; do
		IFS=$u_ifs
		# `case` globs the pattern; set -f does not apply to it.
		case $1 in
		$u_p) return 0 ;;
		esac
		IFS=$nl
	done
	IFS=$u_ifs
	return 1
}

# Does this tar take --exclude? (GNU, bsdtar and busybox do; answered once.)
ib_tar_exclude_ok() {
	if [ -z "$ib_tar_ex" ]; then
		ib_tar_ex=no
		rm -rf "$IB_WORK/exprobe"
		if mkdir -p "$IB_WORK/exprobe" 2> /dev/null && : > "$IB_WORK/exprobe/keep"; then
			if (cd "$IB_WORK/exprobe" && tar --exclude=drop -cf probe.tar keep) > /dev/null 2>&1; then
				ib_tar_ex=yes
			fi
		fi
		rm -rf "$IB_WORK/exprobe"
		ib_log "tar --exclude: $ib_tar_ex"
	fi
	[ "$ib_tar_ex" = yes ]
}

# The unpacker's own exclude switches, one per line, in $u_args. The
# caller turns them into arguments with IFS=$nl and `set -- $u_args`,
# which is safe because the engine runs with `set -f` (no globbing) and a
# plan line can hold no newline. Patterns naming a folder are given twice
# (`p` and `p/*`): GNU tar and bsdtar drop a matched folder's contents
# themselves, busybox tar and unzip do not.
ib_ex_args() { # style (tar|unzip|7z)
	set -f
	u_style=$1
	u_args=
	[ -n "$u_exl" ] || return 0
	u_ifs=$IFS
	IFS=$nl
	for u_p in $u_exl; do
		IFS=$u_ifs
		case $u_style in
		tar) u_args="$u_args--exclude=$u_p$nl--exclude=$u_p/*$nl" ;;
		# unzip's -x takes a list of patterns, not one switch each.
		unzip) u_args="$u_args$u_p$nl$u_p/*$nl" ;;
		7z) u_args="$u_args-x!$u_p$nl-x!$u_p/*$nl" ;;
		esac
		IFS=$nl
	done
	IFS=$u_ifs
}

# Delete anything left under $1 that an exclude names. $2 is the path of
# $1 inside the archive, "" at the top, otherwise ending in "/".
ib_ex_prune() { # dir relprefix
	# Globbing goes on only long enough to list the folder: the list is
	# expanded once, before the body runs, so turning it off again in the
	# body is safe and keeps ib_ex_match's patterns literal.
	set +f
	for u_e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
		set -f
		[ -e "$u_e" ] || [ -h "$u_e" ] || continue
		u_rel=$2${u_e##*/}
		if ib_ex_match "$u_rel"; then
			ib_log "  leaving out $u_rel"
			rm -rf "$u_e"
		elif [ -d "$u_e" ] && [ ! -h "$u_e" ]; then
			ib_ex_prune "$u_e" "$u_rel/"
		fi
	done
	set -f
}

ib_unpack() { # format archive dest strip exclude
	u_fmt=$1
	u_arc=$2
	u_dst=$3
	u_str=${4:-0}
	ib_ex_split "${5:-}"
	ib_mkdirs "$u_dst" || return 1
	st=$u_dst/.ib-unpack.$$
	rm -rf "$st"
	mkdir "$st" || return 1
	to=
	[ "$(id -u)" = 0 ] && to=o
	rc=0
	# What the unpacker itself can be told to leave out. Whatever it
	# still writes, ib_ex_prune deletes below.
	u_args=
	case $u_fmt in
	tar | tar.gz | tgz | tar.bz2 | tbz2 | tar.xz | txz)
		if [ -n "$u_exl" ] && ib_tar_exclude_ok; then ib_ex_args tar; fi
		;;
	zip) ib_ex_args unzip ;;
	7z) ib_ex_args 7z ;;
	esac
	u_ifs=$IFS
	IFS=$nl
	set -- $u_args
	IFS=$u_ifs
	case $u_fmt in
	tar) (cd "$st" && tar -x${to}f "$u_arc" "$@") >> "$IB_LOG" 2>&1 || rc=1 ;;
	tar.gz | tgz)
		rm -f "$IB_WORK/pipe.err"
		{ gzip -dc "$u_arc" || : > "$IB_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$IB_LOG" 2>&1 || rc=1
		[ -f "$IB_WORK/pipe.err" ] && rc=1
		;;
	tar.bz2 | tbz2)
		if ib_have bzip2; then
			rm -f "$IB_WORK/pipe.err"
			{ bzip2 -dc "$u_arc" || : > "$IB_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$IB_LOG" 2>&1 || rc=1
			[ -f "$IB_WORK/pipe.err" ] && rc=1
		else
			(cd "$st" && tar -xj${to}f "$u_arc" "$@") >> "$IB_LOG" 2>&1 || rc=1
		fi
		;;
	tar.xz | txz)
		if ib_have xz; then
			rm -f "$IB_WORK/pipe.err"
			{ xz -dc "$u_arc" || : > "$IB_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$IB_LOG" 2>&1 || rc=1
			[ -f "$IB_WORK/pipe.err" ] && rc=1
		else
			# macOS has no xz, but its tar (libarchive) reads .xz itself.
			(cd "$st" && tar -xJ${to}f "$u_arc" "$@") >> "$IB_LOG" 2>&1 || rc=1
		fi
		;;
	zip)
		if ib_have unzip; then
			if [ $# -gt 0 ]; then
				unzip -q -o "$u_arc" -d "$st" -x "$@" >> "$IB_LOG" 2>&1 || rc=1
			else
				unzip -q -o "$u_arc" -d "$st" >> "$IB_LOG" 2>&1 || rc=1
			fi
		elif ib_have ditto; then
			ditto -x -k "$u_arc" "$st" >> "$IB_LOG" 2>&1 || rc=1
		else
			ib_log "no unzip on this machine"
			rc=1
		fi
		;;
	7z)
		z=
		for c in 7zz 7z 7za 7zr; do ib_have $c && z=$c && break; done
		if [ -z "$z" ]; then
			ib_log "This machine has no 7-Zip (7z, 7za, 7zz), which this .7z file needs."
			rc=1
		else
			(cd "$st" && $z x -y "$@" "$u_arc") >> "$IB_LOG" 2>&1 || rc=1
		fi
		;;
	*)
		ib_log "unknown archive format: $u_fmt"
		rc=1
		;;
	esac
	# Whatever the unpacker still wrote, and every format it could not be
	# told about (ditto, an old tar), is dropped here before the move.
	if [ $rc = 0 ] && [ -n "$u_exl" ]; then
		ib_ex_prune "$st" ""
	fi
	set -- "$u_fmt" "$u_arc" "$u_dst" "$u_str"
	if [ $rc = 0 ]; then
		set +f
		# Drop "strip" folder levels. Folders at the last level are merged
		# into dest, so strip 2 on Rust's tarball (one folder per
		# component) combines the components into one tree.
		u_lv=$st
		u_n=${4:-0}
		u_nl='
'
		while [ "$u_n" -gt 0 ]; do
			u_next=
			u_ifs=$IFS
			IFS=$u_nl
			for u_d in $u_lv; do
				for top in "$u_d"/* "$u_d"/.[!.]* "$u_d"/..?*; do
					[ -d "$top" ] && [ ! -h "$top" ] || continue
					u_next="$u_next$top$u_nl"
				done
			done
			IFS=$u_ifs
			u_lv=$u_next
			u_n=$((u_n - 1))
		done
		u_ents=
		u_ifs=$IFS
		IFS=$u_nl
		for u_d in $u_lv; do
			for e in "$u_d"/* "$u_d"/.[!.]* "$u_d"/..?*; do
				[ -e "$e" ] || [ -h "$e" ] || continue
				u_ents="$u_ents$e$u_nl"
			done
		done
		for e in $u_ents; do
			IFS=$u_ifs
			ib_move_into "$e" "$3" || rc=1
			IFS=$u_nl
		done
		IFS=$u_ifs
		set -f
	fi
	rm -rf "$st"
	return $rc
}

# A source with no stored hash: HTTPS only, because nothing else
# identifies the bytes. There is no pack to look in -- an offline
# installer always carries a hash, since its pack is addressed by one.
ib_obtain_unpinned() { # out urls-file label
	while IFS= read -r u <&4; do
		[ -n "$u" ] || continue
		case $u in
		https://*) ;;
		*)
			ib_say "  skipping $u: a source with no SHA-256 must come over HTTPS"
			continue
			;;
		esac
		ib_say "  downloading $u (no stored SHA-256; identified by its commit over HTTPS)"
		if ib_download "$u" "$1.part"; then
			mv "$1.part" "$1"
			return 0
		fi
		ib_say "  download failed: $u"
		rm -f "$1.part"
	done 4< "$2"
	return 1
}

ib_step() { # type fields...
	s_type=$1
	shift
	case $s_type in
	unpack)
		d=$(ib_subst "$2")
		ib_inside "$d" || ib_fail "Step unpack: $d is outside the app's folders."
		if [ -n "${4:-}" ]; then
			ib_say "  unpack $1 into $d (leaving out $4)"
		else
			ib_say "  unpack $1 into $d"
		fi
		if [ "$1" = 7z ] && ! ib_have 7zz && ! ib_have 7z && ! ib_have 7za && ! ib_have 7zr; then
			ib_fail "$(basename "$IB_CUR_FILE") is a .7z archive, and this machine has no 7-Zip (7z, 7za or 7zz) to unpack it."
		fi
		ib_unpack "$1" "$IB_CUR_FILE" "$d" "${3:-0}" "${4:-}" || ib_fail "Could not unpack $(basename "$IB_CUR_FILE") ($1)."
		;;
	run)
		c=$(ib_subst "$1")
		ib_say "  run: $c"
		(cd "$IB_CUR_DIR" && sh -c "$c") < /dev/null >> "$IB_LOG" 2>&1 || ib_fail "Step failed: $c"
		;;
	mkdir)
		d=$(ib_subst "$1")
		ib_inside "$d" || ib_fail "Step mkdir: $d is outside the app's folders."
		mkdir -p "$d" || ib_fail "Could not create $d"
		;;
	write)
		d=$(ib_subst "$1")
		ib_inside "$d" || ib_fail "Step write: $d is outside the app's folders."
		printf '%s\n' "$(ib_subst "$2")" >> "$d" || ib_fail "Could not write $d"
		;;
	delete)
		d=$(ib_subst "$1")
		ib_inside "$d" || ib_fail "Step delete: $d is outside the app's folders."
		case $d in "$IB_APP_DIR" | "$IB_TMP") ib_fail "Step delete: refusing to delete $d" ;; esac
		rm -rf "$d"
		;;
	*) ib_fail "Unknown step '$s_type' in the plan. Download the installer again." ;;
	esac
}

# Environment for `install` (and, written to launch.txt, for the app).
ib_apply_env() { # with_install_extras(0/1)
	for k in env ienv; do
		[ "$k" = ienv ] && [ "$1" != 1 ] && continue
		ib_sel $k > "$IB_WORK/env.tmp"
		while IFS="$tab" read -r n v; do
			case $n in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
			export "$n=$(ib_subst "$v")"
		done < "$IB_WORK/env.tmp"
	done
	for k in unset iunset; do
		[ "$k" = iunset ] && [ "$1" != 1 ] && continue
		for n in $(ib_sel $k); do
			case $n in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
			unset "$n"
		done
	done
	pre=
	ib_sel path > "$IB_WORK/path.tmp"
	while IFS= read -r p; do
		[ -n "$p" ] && pre=${pre:+$pre:}$(ib_subst "$p")
	done < "$IB_WORK/path.tmp"
	[ -n "$pre" ] && PATH=$pre:$PATH && export PATH
	return 0
}

# ---------------------------------------------------------------- prerequisites

# System-wide prerequisites (format.md "Prerequisites"): `need` entries in
# the chosen block. Their checks only look (ldconfig's cache, the
# library folders, PATH, a file), so they run before the transparency
# screen; anything is installed only after the user agreed.

# Is shared library $1 (a soname) available for this machine's arch?
ib_have_lib() {
	lc=
	for c in ldconfig /sbin/ldconfig /usr/sbin/ldconfig; do
		if command -v "$c" > /dev/null 2>&1; then lc=$c; break; fi
	done
	if [ -n "$lc" ] && "$lc" -p > "$IB_WORK/ldcache" 2> /dev/null && [ -s "$IB_WORK/ldcache" ]; then
		awk -v so="$1" -v arch="$IB_ARCH" '
			$1 == so {
				ok = 1
				if (arch == "amd64" && $0 !~ /x86-64/) ok = 0
				if (arch == "arm64" && $0 !~ /AArch64/) ok = 0
				if (arch == "x86" && ($0 ~ /x86-64/ || $0 ~ /AArch64/)) ok = 0
				if (ok) { found = 1; exit }
			}
			END { exit !found }' "$IB_WORK/ldcache"
		return $?
	fi
	# No ldconfig cache (musl): the usual library folders.
	case $IB_ARCH in
	amd64) tr=x86_64-linux-gnu ;;
	arm64) tr=aarch64-linux-gnu ;;
	*) tr=i386-linux-gnu ;;
	esac
	for d in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib "/lib/$tr" "/usr/lib/$tr"; do
		[ -e "$d/$1" ] && return 0
	done
	return 1
}

# Does need $1 pass any of its checks? Unknown check kinds never pass.
ib_need_present() {
	ib_sel ncheck "$1" > "$IB_WORK/checks.$1"
	while IFS="$tab" read -r k a b; do
		case $k in
		lib) [ "$IB_OS" = linux ] && ib_have_lib "$a" && return 0 ;;
		cmd) command -v "$a" > /dev/null 2>&1 && return 0 ;;
		file) [ -e "$a" ] && return 0 ;;
		esac
	done < "$IB_WORK/checks.$1"
	return 1
}

# The distribution's package manager, first found.
ib_pkg_mgr() {
	for m in apt-get dnf yum zypper apk pacman; do
		for d in '' /usr/bin/ /bin/ /usr/sbin/ /sbin/; do
			if [ -z "$d" ]; then command -v $m > /dev/null 2>&1 && { echo $m; return 0; }
			elif [ -x "$d$m" ]; then echo $m; return 0; fi
		done
	done
	return 1
}

# Commands installing packages $2 with manager $1: what the engine runs as
# root (IB_PKG_RUN), and what the user is told to run (IB_PKG_SAY).
ib_pkg_cmds() {
	case $1 in
	apt-get)
		IB_PKG_RUN="DEBIAN_FRONTEND=noninteractive apt-get install -y $2 || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y $2; }"
		IB_PKG_SAY="sudo apt-get update && sudo apt-get install -y $2"
		;;
	dnf | yum) IB_PKG_RUN="$1 install -y $2" IB_PKG_SAY="sudo $1 install -y $2" ;;
	zypper) IB_PKG_RUN="zypper --non-interactive install $2" IB_PKG_SAY="sudo zypper install $2" ;;
	apk) IB_PKG_RUN="apk add $2" IB_PKG_SAY="sudo apk add $2" ;;
	pacman) IB_PKG_RUN="pacman -S --noconfirm --needed $2" IB_PKG_SAY="sudo pacman -S --needed $2" ;;
	esac
}

# Run command $1 as root. Returns its exit code, or 99 when there is no
# way to become root without asking and asking isn't allowed (--yes), or
# nothing can ask (no terminal, no desktop).
ib_as_root() {
	if [ "$(id -u)" = 0 ]; then
		sh -c "$1" < /dev/null >> "$IB_LOG" 2>&1
		return $?
	fi
	if ib_have sudo && sudo -n true > /dev/null 2>&1; then
		sudo -n sh -c "$1" < /dev/null >> "$IB_LOG" 2>&1
		return $?
	fi
	[ "$opt_yes" = 1 ] && return 99
	if [ "$ib_ui" = tty ] && ib_have sudo; then
		ib_say "  sudo may ask for your password."
		sudo sh -c "$1" < /dev/null >> "$IB_LOG" 2>&1
		return $?
	fi
	if [ "$IB_OS" = linux ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && ib_have pkexec; then
		pkexec /bin/sh -c "$1" < /dev/null >> "$IB_LOG" 2>&1
		return $?
	fi
	return 99
}

# Check every need. Sets ib_need_n, ib_need_missing (indexes), ib_need_manual
# (indexes with no way to install them here), ib_need_pkgs, ib_pm.
ib_needs_eval() {
	ib_need_n=$(ib_sel need | wc -l | tr -d ' ')
	ib_need_missing= ib_need_manual= ib_need_pkgs= ib_pm=
	[ "$ib_need_n" -gt 0 ] || return 0
	[ "$IB_OS" = linux ] && ib_pm=$(ib_pkg_mgr)
	i=1
	while [ "$i" -le "$ib_need_n" ]; do
		if ib_need_present "$i"; then
			ib_log "Prerequisite $i ($(ib_sel need "$i" | cut -f1)): present"
		else
			ib_log "Prerequisite $i ($(ib_sel need "$i" | cut -f1)): missing"
			ib_need_missing="$ib_need_missing $i"
			pk=
			[ -n "$ib_pm" ] && pk=$(ib_sel npkg "$i" | awk -F'\t' -v m="$ib_pm" '$1 == m { print $2; exit }')
			case $pk in *[!A-Za-z0-9.+_:\ -]*) ib_fail "The plan names a package with characters that don't belong in one: $pk" ;; esac
			if [ -n "$pk" ]; then
				ib_need_pkgs="${ib_need_pkgs:+$ib_need_pkgs }$pk"
			else
				ib_need_manual="$ib_need_manual $i"
			fi
		fi
		i=$((i + 1))
	done
	[ -n "$ib_need_pkgs" ] && ib_pkg_cmds "$ib_pm" "$ib_need_pkgs"
	return 0
}

# The transparency screen's part.
ib_needs_summary() {
	[ "$ib_need_n" -gt 0 ] || return 0
	printf '\nSYSTEM-WIDE PREREQUISITES (checked on this machine; installed for every user, not removed by the uninstaller)\n'
	i=1
	while [ "$i" -le "$ib_need_n" ]; do
		lbl=$(ib_sel need "$i" | cut -f2)
		case " $ib_need_missing " in
		*" $i "*)
			case " $ib_need_manual " in
			*" $i "*)
				printf '  %s: MISSING, and this installer can'\''t install it here\n' "$lbl"
				h=$(ib_sel1 nhow "$i")
				[ -n "$h" ] && printf '    what to do: %s\n' "$h"
				[ -z "$h" ] && [ "$IB_OS" = linux ] && printf '    no package is known for %s\n' "${ib_pm:-this distribution (no apt-get, dnf, yum, zypper, apk or pacman found)}"
				;;
			*) printf '  %s: MISSING, will be installed\n' "$lbl" ;;
			esac
			;;
		*) printf '  %s: present\n' "$lbl" ;;
		esac
		w=$(ib_sel1 nwhy "$i")
		[ -n "$w" ] && printf '    why: %s\n' "$w"
		i=$((i + 1))
	done
	if [ -n "$ib_need_pkgs" ]; then
		printf '  Packages: %s (with %s)\n' "$ib_need_pkgs" "$ib_pm"
		printf '  Runs as root: %s\n' "$IB_PKG_RUN"
		if [ "$(id -u)" = 0 ]; then printf '  (this installer is running as root)\n'
		else printf '  NEEDS ROOT for this step only (sudo, or pkexec on a desktop); the app itself installs for you\n'; fi
	fi
	return 0
}

# After the user agreed: install what is missing, then check again.
ib_needs_install() {
	[ -n "$ib_need_missing" ] || return 0
	for i in $ib_need_manual; do
		lbl=$(ib_sel need "$i" | cut -f2)
		h=$(ib_sel1 nhow "$i")
		st=$(ib_sel1 nstart "$i")
		# Start the system's own installer (xcode-select --install) for the
		# user to finish, but never with --yes: it opens a dialog.
		if [ -n "$st" ] && [ "$opt_yes" != 1 ] && [ "$ib_ui" != none ]; then
			ib_say "Starting: $st"
			sh -c "$st" < /dev/null >> "$IB_LOG" 2>&1
		fi
		[ -n "$h" ] || h="Install it, then run this installer again."
		ib_fail_rc=2; ib_fail "$lbl is needed first and this installer can't install it here. $h"
	done
	if [ -n "$ib_need_pkgs" ]; then
		ib_say "Installing system packages ($ib_pm): $ib_need_pkgs"
		ib_log "  as root: $IB_PKG_RUN"
		ib_as_root "$IB_PKG_RUN"
		rc=$?
		if [ $rc = 99 ]; then
			ib_fail_rc=2; ib_fail "This app needs system packages that aren't installed ($ib_need_pkgs), and installing them needs root, which this installer can't ask for here$([ "$opt_yes" = 1 ] && printf ' (--yes)'). Run this, then run the installer again:$nl  $IB_PKG_SAY"
		fi
		[ $rc = 0 ] || ib_fail "Installing $ib_need_pkgs failed ($ib_pm exit code $rc). To try yourself: $IB_PKG_SAY"
	fi
	for i in $ib_need_missing; do
		ib_need_present "$i" || ib_fail "$(ib_sel need "$i" | cut -f2) is still missing after installing $ib_need_pkgs."
	done
	ib_say "Prerequisites installed."
	return 0
}

# The record's launcher icon (format.md section 2, `icon`): the packed PNG,
# copied into the app folder for the .desktop Icon= line. Only from the
# pack; without it the generic icon stays.
ib_install_icon() {
	ib_icon=
	[ "$IB_OS" = linux ] && [ -n "$IB_REC" ] || return 0
	ic=$(ib_get "$IB_REC" icon)
	[ -n "$ic" ] || return 0
	case $ic in *[!0-9a-f]*) ib_log "Ignoring the record's icon: not a sha256"; return 0 ;; esac
	[ ${#ic} = 64 ] || { ib_log "Ignoring the record's icon: not a sha256"; return 0; }
	if ! ib_obtain "$ic" "$IB_APP_DIR/icon.png" /dev/null icon; then
		ib_log "The record's icon $ic is not packed in this installer; using the generic icon"
		rm -f "$IB_APP_DIR/icon.png"
		return 0
	fi
	if [ "$(head -c 8 "$IB_APP_DIR/icon.png" | od -An -tx1 | tr -d ' \n')" != 89504e470d0a1a0a ]; then
		ib_log "The packed icon is not a PNG; using the generic icon"
		rm -f "$IB_APP_DIR/icon.png"
		return 0
	fi
	ib_icon=$IB_APP_DIR/icon.png
	ib_log "Icon: $ib_icon"
}

# ---------------------------------------------------------------- launcher, menus

ib_write_launcher() {
	cat > "$IB_APP_DIR/launch.sh" <<'EOF'
#!/bin/sh
# TiddlyInstall launcher: runs the app described by launch.txt next
# to this file (cwd, env, unset, path, console, exec). Identical for every app.
d=$(dirname "$0")
d=$(cd "$d" 2>/dev/null && pwd) || d=$(dirname "$0")
f=$d/launch.txt
[ -f "$f" ] || { echo "launch.sh: $f is missing" >&2; exit 1; }
tab=$(printf '\t'); cr=$(printf '\r'); pre=; cmd=; cwd=$d; con=1
while IFS= read -r line || [ -n "$line" ]; do
	line=${line%"$cr"}
	case $line in '' | '#'*) continue ;; esac
	key=${line%%"$tab"*}
	rest=${line#*"$tab"}
	[ "$rest" = "$line" ] && rest=
	case $key in
	ib-launch) case ${rest%%.*} in 0 | 1) ;; *) echo "launch.sh: launch.txt is a newer version" >&2; exit 1 ;; esac ;;
	cwd) cwd=$rest ;;
	env) n=${rest%%"$tab"*}; v=${rest#*"$tab"}; [ "$v" = "$rest" ] && v=; export "$n=$v" ;;
	unset) unset "$rest" ;;
	path) pre=${pre:+$pre:}$rest ;;
	console) con=$rest ;;
	exec) cmd=$rest ;;
	esac
done < "$f"
[ -n "$cmd" ] || { echo "launch.sh: no exec line in $f" >&2; exit 1; }
[ -n "$pre" ] && PATH=$pre:$PATH && export PATH
cd "$cwd" || exit 1
# An app without a console (console 0) started from a desktop session, not
# a terminal: its output goes to a log, and if it fails within 10 seconds a
# dialog shows the end of it and where the log is (zenity, kdialog or
# osascript; with none of them, only the log).
gui=
if [ "$con" != 1 ] && [ ! -t 2 ]; then
	case $(uname -s 2>/dev/null) in
	Darwin) [ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ] && gui=1 ;;
	*) [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && gui=1 ;;
	esac
fi
[ -n "$gui" ] || eval "exec $cmd \"\$@\""
log=$d/data/launch.log
{ mkdir -p "$d/data" && : > "$log"; } 2>/dev/null || { log=${TMPDIR:-/tmp}/ib-launch-$(basename "$d").log; : > "$log" 2>/dev/null || log=/dev/null; }
t0=$(date +%s 2>/dev/null) || t0=0
eval "$cmd \"\$@\"" > "$log" 2>&1
rc=$?
t1=$(date +%s 2>/dev/null) || t1=$t0
[ "$rc" = 0 ] || [ $((t1 - t0)) -ge 10 ] || [ "$log" = /dev/null ] && exit "$rc"
name=$(awk -F'\t' '$1 == "name" { print $2; exit }' "$d/manifest.txt" 2>/dev/null)
[ -n "$name" ] || name="The app"
out=$(tail -n 15 "$log" | cut -c1-200)
if [ -n "$out" ]; then
	msg="$name stopped with an error (exit code $rc):

$out

The full output is in:
$log"
else
	msg="$name stopped with an error (exit code $rc) and wrote nothing.

Its output would be in:
$log"
fi
if command -v osascript >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
	osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 with icon stop' -e 'end run' "$msg" "$name" >/dev/null 2>&1
elif command -v zenity >/dev/null 2>&1; then
	zenity --error --width=600 --title="$name" --text="$(printf '%s' "$msg" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')" >/dev/null 2>&1
elif command -v kdialog >/dev/null 2>&1; then
	kdialog --title "$name" --error "$msg" >/dev/null 2>&1
fi
exit "$rc"
EOF
	chmod 755 "$IB_APP_DIR/launch.sh"
}

ib_desktop_exec_arg() { # quote an argument for a .desktop Exec= line
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')"
}

ib_add_shortcut() { printf 'shortcut\t%s\n' "$1" >> "$IB_WORK/shortcuts"; ib_created r "$1"; }

ib_menus_linux() {
	ib_desk_made=
	if [ "$IB_SYSTEM" = 1 ]; then
		apps=/usr/local/share/applications
		dirs=/usr/local/share/desktop-directories
		menus=/etc/xdg/menus/applications-merged
	else
		data=${XDG_DATA_HOME:-$HOME/.local/share}
		apps=$data/applications
		dirs=$data/desktop-directories
		menus=${XDG_CONFIG_HOME:-$HOME/.config}/menus/applications-merged
	fi
	id=ib-$IB_APPID
	term=false
	[ "$IB_CONSOLE" = 1 ] && term=true
	ename=$(printf '%s' "$IB_NAME_DISP" | sed 's/\\/\\\\/g')
	cat > "$IB_WORK/entry.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$ename
Comment=Installed by TiddlyInstall
Exec=$(ib_desktop_exec_arg "$IB_APP_DIR/launch.sh")
Path=$IB_APP_DIR
Terminal=$term
Icon=${ib_icon:-application-x-executable}
Categories=Utility;
EOF
	# menu 0: nothing in the app menu at all (no entry, no uninstaller, no
	# folder). The app starts from launch.sh, the desktop shortcut if asked
	# for, or by running the installer again.
	if [ "$IB_MENU" != 0 ]; then
		ib_mkdirs "$apps" && ib_mkdirs "$dirs" && ib_mkdirs "$menus" || ib_fail "Could not create the menu folders."
		f=$apps/$id.desktop
		cp "$IB_WORK/entry.desktop" "$f" || ib_fail "Could not write $f"
		ib_add_shortcut "$f"
		f=$apps/$id-uninstall.desktop
		cat > "$f" <<EOF
[Desktop Entry]
Type=Application
Name=Uninstall $ename
Comment=Remove $ename and everything its installer added
Exec=/bin/sh $(ib_desktop_exec_arg "$IB_APP_DIR/uninstall.sh") --uninstall
Terminal=true
Icon=edit-delete
NoDisplay=false
Categories=Utility;
EOF
		ib_add_shortcut "$f"
		f=$dirs/$id.directory
		cat > "$f" <<EOF
[Desktop Entry]
Type=Directory
Name=$ename
Icon=folder
EOF
		ib_add_shortcut "$f"
		f=$menus/$id.menu
		cat > "$f" <<EOF
<!DOCTYPE Menu PUBLIC "-//freedesktop//DTD Menu 1.0//EN"
 "http://www.freedesktop.org/standards/menu-spec/1.0/menu.dtd">
<Menu>
  <Name>Applications</Name>
  <Menu>
    <Name>$id</Name>
    <Directory>$id.directory</Directory>
    <Include>
      <Filename>$id.desktop</Filename>
      <Filename>$id-uninstall.desktop</Filename>
    </Include>
  </Menu>
</Menu>
EOF
		ib_add_shortcut "$f"
	fi
	if ib_want_desktop; then
		desk=$(xdg-user-dir DESKTOP 2>/dev/null)
		[ -n "$desk" ] || desk=$HOME/Desktop
		if [ -d "$desk" ]; then
			f=$desk/$id.desktop
			cp "$IB_WORK/entry.desktop" "$f" && chmod 755 "$f" && ib_add_shortcut "$f" && ib_desk_made=$f
			# GNOME asks before running an untrusted desktop file. Mark it, but
			# only where the desktop's metadata store already exists.
			[ -d "${XDG_DATA_HOME:-$HOME/.local/share}/gvfs-metadata" ] && ib_have gio &&
				gio set "$f" metadata::trusted true >/dev/null 2>&1
		fi
	fi
	return 0
}

ib_xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

ib_mac_app() { # bundle-path display-name bundle-id exec-script-body
	mkdir -p "$1/Contents/MacOS" "$1/Contents/Resources" || return 1
	ib_created r "$1"
	cat > "$1/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>run</string>
	<key>CFBundleIdentifier</key><string>$3</string>
	<key>CFBundleName</key><string>$(ib_xml "$2")</string>
	<key>CFBundleDisplayName</key><string>$(ib_xml "$2")</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>NSHumanReadableCopyright</key><string>Installed by TiddlyInstall</string>
</dict>
</plist>
EOF
	printf '#!/bin/sh\n%s\n' "$4" > "$1/Contents/MacOS/run"
	chmod 755 "$1/Contents/MacOS/run"
	printf '%s\n' "$IB_APPID" > "$1/Contents/Resources/ib-appid"
}

# The desktop shortcut is made only for one-user installs, on both systems.
ib_want_desktop() { [ "$IB_DESKTOP" = 1 ] && [ "$IB_SYSTEM" != 1 ]; }

ib_mac_safe_name() {
	safe=$(printf '%s' "$IB_NAME_DISP" | sed -e 's#[/:]#-#g' -e 's/^\.*//')
	[ -n "$safe" ] || safe=$IB_APPID
}

ib_menus_macos() {
	ib_desk_made=
	if [ "$IB_SYSTEM" = 1 ]; then base=/Applications; else base=$HOME/Applications; fi
	ib_mac_safe_name
	q=$(ib_shq "$IB_APP_DIR/launch.sh")
	if [ "$IB_CONSOLE" = 1 ]; then
		body="if [ -t 1 ] || [ -n \"\$IB_NO_TERMINAL\" ]; then exec $q \"\$@\"; fi
exec open -a Terminal $q"
	else
		body="exec $q \"\$@\""
	fi
	if [ "$IB_MENU" = 0 ]; then
		# No folder and no uninstaller app. A desktop shortcut still needs a
		# launcher app to point at: just <App>.app in Applications.
		ib_want_desktop && [ -d "$HOME/Desktop" ] && [ ! -e "$HOME/Desktop/$safe" ] || return 0
		[ -e "$base/$safe.app" ] && ib_fail "$base/$safe.app already exists; not overwriting it."
		ib_mkdirs "$base" || ib_fail "Could not create $base"
		ib_mac_app "$base/$safe.app" "$IB_NAME_DISP" "pm.ib.app.$IB_APPID" "$body" || ib_fail "Could not create $base/$safe.app"
		printf 'shortcut\t%s\n' "$base/$safe.app" >> "$IB_WORK/shortcuts"
		ln -s "$base/$safe.app" "$HOME/Desktop/$safe" && ib_add_shortcut "$HOME/Desktop/$safe" && ib_desk_made=$HOME/Desktop/$safe
		return 0
	fi
	folder=$base/$safe
	[ -e "$folder" ] && ib_fail "$folder already exists; not overwriting it."
	ib_mkdirs "$folder" || ib_fail "Could not create $folder"
	ib_mac_app "$folder/$safe.app" "$IB_NAME_DISP" "pm.ib.app.$IB_APPID" "$body" || ib_fail "Could not create $folder/$safe.app"
	printf 'shortcut\t%s\n' "$folder/$safe.app" >> "$IB_WORK/shortcuts"
	ib_mac_app "$folder/Uninstall $safe.app" "Uninstall $IB_NAME_DISP" "pm.ib.uninstall.$IB_APPID" \
		"exec /bin/sh $(ib_shq "$IB_APP_DIR/uninstall.sh") --uninstall \"\$@\"" || ib_fail "Could not create the uninstaller app"
	printf 'shortcut\t%s\n' "$folder/Uninstall $safe.app" >> "$IB_WORK/shortcuts"
	if ib_want_desktop && [ -d "$HOME/Desktop" ] && [ ! -e "$HOME/Desktop/$safe" ]; then
		ln -s "$folder/$safe.app" "$HOME/Desktop/$safe" && ib_add_shortcut "$HOME/Desktop/$safe" && ib_desk_made=$HOME/Desktop/$safe
	fi
	return 0
}

# ---------------------------------------------------------------- uninstall

ib_uninstall() {
	app=$(cd "$(dirname "$IB_SELF")" && pwd)
	man=$app/manifest.txt
	[ -f "$man" ] || ib_fail "No manifest.txt next to the uninstaller ($app)."
	ib_check_header "$man" ib-manifest
	appid=$(ib_get "$man" appid)
	name=$(ib_get "$man" name)
	[ "$(basename "$app")" = "$appid" ] || ib_fail "The manifest in $app is for a different app ($appid); not removing anything."
	root=$(dirname "$app")
	if [ ! -w "$root" ] && [ "$(id -u)" != 0 ]; then
		ib_elevate --uninstall
		exit $?
	fi
	{
		printf 'Remove %s?\n\nThis deletes:\n  %s\n' "$name" "$app"
		awk -F'\t' '$1 == "dir" || $1 == "shortcut" { print "  " $2 }' "$man"
	} > "$IB_WORK/uninstall.txt"
	cp "$IB_WORK/uninstall.txt" "$IB_WORK/short.txt"
	ib_confirm "Uninstall $name" "$IB_WORK/uninstall.txt" "Remove $name?" || { ib_say "Nothing removed."; [ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG"; exit 1; }
	ib_log "Uninstalling $name ($appid) from $root"
	ib_remove_app "$app" "$appid"
	if [ $bad = 0 ]; then
		[ "$opt_yes" = 1 ] || [ "$ib_ui" = tty ] || ib_message info "TiddlyInstall" "$name has been removed."
		ib_say "$name has been removed."
	else
		ib_message error "TiddlyInstall" "$name was removed, but some listed items were refused (see above)."
		exit 1
	fi
}

# Remove app folder $1 (appid $2) and what its manifest lists: shortcuts,
# then dependency folders, then the app's folder. Sets bad=1 if anything
# listed was refused. Used by the uninstaller and by a reinstall.
ib_remove_app() {
	app=$1 appid=$2
	man=$app/manifest.txt
	root=$(dirname "$app")
	bad=0
	# The "fully installed" marker goes first, so an uninstall that stops
	# half way is never taken for a finished install.
	rm -f "$app/.ib-installed"
	: > "$IB_WORK/items"
	[ -f "$man" ] && awk -F'\t' '{ sub(/\r$/, "") } $1 == "dir" || $1 == "shortcut" { print $1 "\t" $2 }' "$man" > "$IB_WORK/items"
	# Shortcut files and launcher apps first.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = shortcut ] || continue
		case $p in /*) ;; *) ib_say "refusing relative path $p"; bad=1; continue ;; esac
		case $p in */../* | */./* | */.. | */.) ib_say "refusing $p"; bad=1; continue ;; esac
		if [ -h "$p" ]; then
			rm -f "$p" && ib_say "removed $p"
		elif [ -d "$p" ]; then
			case $p in
			*.app)
				if [ "$(cat "$p/Contents/Resources/ib-appid" 2>/dev/null)" = "$appid" ]; then
					rm -rf "$p" && ib_say "removed $p"
				else
					ib_say "refusing $p: not one of this app's launchers"; bad=1
				fi
				;;
			esac
		elif [ -f "$p" ]; then
			case $(basename "$p") in
			"ib-$appid".* | "ib-$appid"-*) rm -f "$p" && ib_say "removed $p" ;;
			*) ib_say "refusing $p: not named for this app"; bad=1 ;;
			esac
		fi
	done < "$IB_WORK/items"
	# Dependency folders: only <root>/<12 base32 chars>.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = dir ] || continue
		b=$(basename "$p")
		pd=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)
		if [ "$pd" != "$(cd "$root" && pwd -P)" ] || [ "$b" = "$appid" ]; then
			ib_say "refusing $p: not in $root"; bad=1; continue
		fi
		case $b in
		*[!a-z2-7]*) ib_say "refusing $p: not an install folder"; bad=1; continue ;;
		????????????) ;;
		*) ib_say "refusing $p: not an install folder"; bad=1; continue ;;
		esac
		[ -e "$p" ] || continue
		o=$(ib_get "$p/.ib-owner" appid 2>/dev/null)
		if [ "$o" != "$appid" ]; then
			ib_say "refusing $p: its .ib-owner doesn't name this app (${o:-none})"; bad=1; continue
		fi
		rm -rf "$p" && ib_say "removed $p"
	done < "$IB_WORK/items"
	o=$(ib_get "$app/.ib-owner" appid 2>/dev/null)
	if [ "$o" = "$appid" ]; then
		cd / && rm -rf "$app" && ib_say "removed $app"
	else
		ib_say "refusing $app: its .ib-owner doesn't name this app (${o:-none})"; bad=1
	fi
	rmdir "$root" 2>/dev/null
	# Folders the installer created for shortcuts: removed only if empty.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = shortcut ] && [ -d "$p" ] && [ ! -h "$p" ] || continue
		case $p in *.app) continue ;; esac
		rmdir "$p" 2>/dev/null && ib_say "removed $p"
	done < "$IB_WORK/items"
	return 0
}

# ---------------------------------------------------------------- elevation

ib_elevate() { # extra args...
	set -- "$@" --yes --log="$IB_LOG"
	if [ "$IB_MODE_A" != 1 ]; then
		# The root copy checks the plan again; one this run accepted
		# without a signature (embedded, or --unsigned-plan) stays accepted.
		[ -n "$IB_REC" ] && set -- "$@" --record="$IB_REC"
		[ -n "$IB_PLAN" ] && set -- "$@" --plan="$IB_PLAN"
		[ -n "$IB_PLAN" ] && [ -n "$ib_plan_warn" ] && set -- "$@" --unsigned-plan
	fi
	[ -n "$IB_ORIGIN" ] && set -- "$@" --ib-origin="$IB_ORIGIN"
	[ -n "$opt_backend" ] && set -- "$@" --backend="$opt_backend"
	[ "$opt_reinstall" = 1 ] && set -- "$@" --reinstall
	ib_log "Asking for administrator rights"
	if [ "$opt_yes" = 1 ] && [ "$ib_ui" != tty ]; then
		# --yes with no terminal: no password dialog either.
		if ib_have sudo && sudo -n true 2> /dev/null; then
			sudo -n /bin/sh "$IB_SELF" "$@"
			return $?
		fi
		ib_fail "This needs administrator rights, and with --yes and no terminal nothing may ask for them. Run it as root, or in a terminal."
	fi
	if [ "$IB_OS" = macos ] && [ "$ib_ui" != tty ]; then
		c="/bin/sh $(ib_shq "$IB_SELF")"
		for a in "$@"; do c="$c $(ib_shq "$a")"; done
		ib_osa "$c" <<'EOF' >> "$IB_LOG" 2>&1
on run argv
	do shell script (item 1 of argv) with administrator privileges
end run
EOF
	elif [ "$ib_ui" = tty ] && ib_have sudo; then
		sudo /bin/sh "$IB_SELF" "$@"
	elif ib_have pkexec && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
		pkexec /bin/sh "$IB_SELF" "$@"
	else
		ib_fail "This install needs administrator rights. Run it in a terminal (it will use sudo)."
	fi
}

# ---------------------------------------------------------------- installed already

# Is this app fully installed where this installer would put it, with this
# same record? Only the marker a finished install writes last counts
# (.ib-installed, docs/format.md section 5), and it must name this appid
# and record; the folder's .ib-owner must name the app too.
ib_is_installed() { # [app dir, appid, record hash]; default: this install's
	i_d=${1:-$IB_APP_DIR} i_id=${2:-$IB_APPID} i_h=${3:-$IB_RECHASH}
	m=$i_d/.ib-installed
	[ -n "$i_h" ] && [ -n "$i_id" ] && [ -f "$m" ] && [ -f "$i_d/launch.sh" ] && [ -f "$i_d/launch.txt" ] || return 1
	[ "$(sed -n 1p "$m" | tr -d '\r')" = "ib-installed${tab}1" ] || return 1
	[ "$(ib_get "$m" appid)" = "$i_id" ] && [ "$(ib_get "$m" record)" = "$i_h" ] || return 1
	[ "$(ib_get "$i_d/.ib-owner" appid 2>/dev/null)" = "$i_id" ]
}

# The install root for root mode $1 (user, system) and folder name $2.
# ---- the architecture of what is being installed
#
# The plan's `runtime` line carries it as a 3rd value and each `file`
# line as a 5th field (format.md, "Architecture"). Both are appended, so
# an older plan simply has neither and nothing below prints.
#
# The transparency screen has always shown the *machine's* architecture;
# from 2026-09-20 it also shows the build's, and says when they differ.
# That is the case a person can otherwise only discover after installing:
# a 64-bit machine being given a 32-bit runtime because no 64-bit build
# runs on this system.
ib_arch_words() { # arch
	case $1 in
	x86) printf '32-bit (x86)' ;;
	amd64) printf '64-bit (amd64)' ;;
	arm64) printf '64-bit ARM (arm64)' ;;
	universal) printf 'universal (several architectures in one build)' ;;
	any) printf 'any architecture' ;;
	*) printf '%s' "$1" ;;
	esac
}

# Why the build's architecture is not this machine's, when it is not.
ib_arch_note() { # build-arch runtime-name
	[ -n "$1" ] || return 0
	case $1 in any | universal | "$IB_ARCH") return 0 ;; esac
	case $IB_ARCH:$1 in
	amd64:x86 | arm64:x86)
		printf ' -- this machine is 64-bit, but the plan has no 64-bit build of %s for this system' "$2" ;;
	arm64:amd64)
		printf ' -- this machine is ARM; this is an Intel/AMD build' ;;
	*)
		printf ' -- this machine is %s' "$IB_ARCH" ;;
	esac
}

ib_root_path() {
	if [ "$IB_OS" = macos ]; then
		if [ "$1" = system ]; then printf '%s' "/Library/$2"; else printf '%s' "$HOME/Library/$2"; fi
	else
		if [ "$1" = system ]; then printf '%s' "/opt/$2"; else printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/$2"; fi
	fi
}

# A root this engine no longer installs into but must still find apps in.
# Up to 2026-09-20 macOS installs went to ~/Library/Application Support/
# <rootname> (and /Library/Application Support/<rootname> for all users);
# the space in the path broke build systems that don't quote (design.md
# 11, item 16). Apps already there keep working: their own uninstall.sh
# and manifest hold absolute paths, and this engine looks there too.
# Empty when there is no earlier root for this OS.
ib_root_legacy() { # rootmode rootname
	[ "$IB_OS" = macos ] || return 0
	if [ "$1" = system ]; then printf '%s' "/Library/Application Support/$2"; else printf '%s' "$HOME/Library/Application Support/$2"; fi
}

# Already installed, found before any network access? The appid is
# derived from the record hash alone (the resolver writes
# appid = base32(sha256(<record hash> "/app"))[:12]), so when the record
# hash is known before the plan is fetched (an embedded, given or
# install.txt record; the hash in a mode A file name) the marker can be
# checked offline. $1 the record hash, $2 the record file if there is one
# (its root and rootname say where to look; without it, the default
# folders for one user and for all users). Starts the app, or with --yes
# says it is installed, and doesn't come back; returns if not installed.
ib_installed_offline() {
	[ "$opt_reinstall" = 1 ] && return 0
	e_h=$1
	case $e_h in *[!a-z2-7]* | '') return 0 ;; ??????????????????????????) ;; *) return 0 ;; esac
	e_id=$(ib_b32 "$(printf '%s/app' "$e_h" | ib_sha256)" 12)
	if [ -n "$2" ]; then
		e_rm=$(ib_get "$2" root)
		e_rn=$(ib_get "$2" rootname)
		[ -n "$e_rn" ] || e_rn=ib
		case $e_rn in . | .. | */* | *[!A-Za-z0-9._-]*) return 0 ;; esac
		set -- "$(ib_root_path "${e_rm:-user}" "$e_rn")" "$(ib_root_legacy "${e_rm:-user}" "$e_rn")"
	else
		set -- "$(ib_root_path user ib)" "$(ib_root_path system ib)" \
			"$(ib_root_legacy user ib)" "$(ib_root_legacy system ib)"
	fi
	for e_root in "$@"; do
		[ -n "$e_root" ] || continue
		ib_is_installed "$e_root/$e_id" "$e_id" "$e_h" || continue
		IB_APP_DIR=$e_root/$e_id IB_APPID=$e_id IB_RECHASH=$e_h
		IB_NAME_DISP=$(ib_get "$IB_APP_DIR/manifest.txt" name 2>/dev/null)
		[ -n "$IB_NAME_DISP" ] || IB_NAME_DISP=$e_id
		IB_CONSOLE=$(ib_get "$IB_APP_DIR/launch.txt" console 2>/dev/null)
		ib_log "Found $IB_NAME_DISP fully installed in $IB_APP_DIR (record $e_h, appid from the record hash); nothing fetched."
		ib_installed_now
	done
	return 0
}

# The app is fully installed: with --yes say so and exit 0, else start it.
ib_installed_now() {
	if [ "$opt_yes" = 1 ]; then
		# Unattended: never start the app (scripts, CI, the test matrix).
		ib_log "$IB_NAME_DISP is already installed in $IB_APP_DIR (record $IB_RECHASH); nothing to do."
		printf 'TiddlyInstall: %s is already installed in %s. Nothing was changed; add --reinstall to install it again.\n' "$(ib_cleans "$IB_NAME_DISP")" "$IB_APP_DIR" >&2
		[ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG"
		exit 0
	fi
	ib_launch_installed
}

# Start the installed app the way its shortcuts do (launch.sh), and don't
# come back. A console app started from a desktop (no terminal) gets a
# terminal window, as its menu entry would (Terminal=true, or Terminal.app
# on macOS; IB_NO_TERMINAL=1 keeps it in this process, as the launcher
# app's does).
ib_launch_installed() {
	l=$IB_APP_DIR/launch.sh
	ib_log "$IB_NAME_DISP is already installed in $IB_APP_DIR (record $IB_RECHASH); starting it with $l"
	ib_say "$IB_NAME_DISP is already installed; starting it. (To install it again, run this installer with --reinstall.)"
	ib_cleanup
	trap - EXIT INT TERM HUP
	[ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG"
	if [ "$IB_CONSOLE" = 1 ] && [ ! -t 1 ] && [ -z "${IB_NO_TERMINAL:-}" ]; then
		case $ib_ui in
		osascript) exec open -a Terminal "$l" ;;
		zenity | kdialog)
			if ib_have x-terminal-emulator; then exec x-terminal-emulator -e /bin/sh "$l"
			elif ib_have gnome-terminal; then exec gnome-terminal -- /bin/sh "$l"
			elif ib_have konsole; then exec konsole -e /bin/sh "$l"
			elif ib_have xfce4-terminal; then exec xfce4-terminal -x /bin/sh "$l"
			elif ib_have xterm; then exec xterm -e /bin/sh "$l"
			fi
			;;
		esac
	fi
	exec /bin/sh "$l"
}

# How to start and uninstall the app, one line each, for the final message.
ib_start_hint() {
	if [ "$IB_MENU" != 0 ]; then
		if [ "$IB_OS" = macos ]; then
			printf 'Start it from Applications > %s, which also holds its uninstaller.' "$IB_NAME_DISP"
		else
			printf 'Start it from the app menu (the folder "%s"), which also holds its uninstaller.' "$IB_NAME_DISP"
		fi
		return 0
	fi
	if [ -n "$ib_desk_made" ]; then
		printf 'Start it from its desktop shortcut, or run: %s\n' "$(ib_shq "$IB_APP_DIR/launch.sh")"
	else
		printf 'Start it by running: %s\n' "$(ib_shq "$IB_APP_DIR/launch.sh")"
	fi
	printf 'Running this installer again also starts it.\n'
	printf 'To uninstall it, run: sh %s' "$(ib_shq "$IB_APP_DIR/uninstall.sh")"
}

# ---------------------------------------------------------------- main install

ib_describe_source() {
	s=
	[ -n "$IB_REC" ] && s=$(ib_get "$IB_REC" source)
	[ -n "$s" ] || { printf 'not given'; return; }
	IFS=$tab
	set -- $s
	IFS=$ifs0
	case $1 in
	github)
		# Since 2026-09-20 a GitHub source carries no stored hash: the
		# commit id names the snapshot and HTTPS vouches for the repo
		# (design.md 11.2). Say which it is, rather than leaving someone
		# to assume a hash was checked.
		if [ -n "${4:-}" ]; then
			printf 'GitHub %s, commit %s (sha256 %s)' "$2" "$3" "$4"
		else
			printf 'GitHub %s, commit %s (no stored hash: identified by the commit, fetched over HTTPS)' "$2" "$3"
		fi
		;;
	package) printf 'package %s, version %s' "$2" "$3" ;;
	url) printf '%s (sha256 %s)' "$2" "$3" ;;
	inline) printf 'code written on the site (sha256 %s)' "$2" ;;
	*) printf '%s' "$s" ;;
	esac
}

ib_signer() {
	if [ -n "$IB_BUNDLE" ]; then
		if ! ib_have codesign; then printf 'unknown (no codesign tool)'; return; fi
		info=$(codesign -dvv "$IB_BUNDLE" 2>&1)
		case $info in
		*"not signed"*) printf 'nobody (the app is not signed)' ;;
		*Authority=*) printf '%s' "$(printf '%s\n' "$info" | sed -n 's/^Authority=//p' | sed -n 1p)" ;;
		*adhoc*) printf 'nobody (ad-hoc signature, no identity)' ;;
		*) printf 'unknown' ;;
		esac
		case $info in *"not signed"*) ;; *)
			codesign --verify "$IB_BUNDLE" >/dev/null 2>&1 ||
				printf '; the signature does NOT verify (the app was changed after signing)' ;;
		esac
	else
		[ -n "$ib_self_sha" ] || ib_self_sha=$(ib_sha256 "$IB_SELF")
		printf 'nobody (.run files carry no signature); this file has sha256 %s' "$ib_self_sha"
	fi
}

ib_install_main() {
	ib_find_metadata
	[ -n "$IB_REC" ] && ib_check_header "$IB_REC" ib-record
	IB_RECHASH=
	[ -n "$IB_REC" ] && IB_RECHASH=$(ib_b32 "$(ib_sha256 "$IB_REC")" 26)
	# Installed already? Checked here, before the plan is fetched.
	[ -n "$IB_RECHASH" ] && ib_installed_offline "$IB_RECHASH" "$IB_REC"
	backend=$opt_backend
	[ -z "$backend" ] && [ -n "$IB_REC" ] && [ "$IB_MODE_A" != 1 ] && backend=$(ib_get "$IB_REC" backend)
	[ -z "$backend" ] && backend=$IB_DEFAULT_BACKEND
	backend=${backend%/}
	case $IB_PLAN_KIND in
	embedded) IB_PLAN_FROM=embedded ;;
	cmdline) IB_PLAN_FROM="given: $IB_PLAN" ;;
	*) IB_PLAN_FROM=$IB_PLAN_URL ;;
	esac
	if [ -z "$IB_PLAN" ]; then
		IB_PLAN=$IB_WORK/plan.txt IB_PLAN_KIND=fetched IB_PLAN_URL=$backend/api/plan/$IB_RECHASH
		ib_say "Fetching the install plan from $backend"
		ib_nonce "$IB_RECHASH"
		ib_download "$IB_PLAN_URL$(ib_nonce_query)" "$IB_PLAN" ||
			ib_fail "Could not fetch the install plan from $IB_PLAN_URL.$(ib_http_why)"
		IB_PLAN_FROM=$IB_PLAN_URL
	fi
	ib_check_header "$IB_PLAN" ib-plan
	ib_check_plan
	# The plan must be for this record (format.md "Plan signature"): a signed plan for
	# another app can't be replayed.
	prec=$(ib_get "$IB_PLAN" record)
	if [ -n "$IB_RECHASH" ] && [ "$prec" != "$IB_RECHASH" ]; then
		ib_fail "The install plan is for record ${prec:-none}, but this installer's record is $IB_RECHASH. Nothing was installed."
	fi
	[ -z "$IB_RECHASH" ] && IB_RECHASH=$prec
	# A plan by name has no record to check against; it says (signed)
	# which name it answers.
	if [ -n "$IB_PLAN_REQUEST" ] && [ "$(ib_get "$IB_PLAN" request)" != "$IB_PLAN_REQUEST" ]; then
		ib_fail "The plan from $backend is not the answer for $(printf '%s' "$IB_PLAN_REQUEST" | tr '\t' ' '). Nothing was installed."
	fi
	# ...and, for a fetched plan, the answer to *this* request and not a
	# replay of an older one (design.md 7.1).
	ib_check_nonce

	IB_SEL=$IB_WORK/selection.txt
	ib_select_target "$IB_PLAN" > "$IB_SEL"
	f=$(ib_sel1 fail)
	[ -n "$f" ] && ib_fail "$f"
	# A plan carried in this installer may be old, or name something since
	# withdrawn: the revocation list answers that where there is a network,
	# and the plan's own `signed`/`maxage` where there is not. Both run
	# before anything on this machine is changed.
	ib_revocations "$backend"
	ib_check_age "$backend"

	IB_NAME_DISP=$(ib_get "$IB_PLAN" name)
	IB_PROJECT=$(ib_get "$IB_PLAN" project)
	IB_APPID=$(ib_get "$IB_PLAN" appid)
	IB_CONSOLE=$(ib_get "$IB_PLAN" console)
	IB_MENU=$(ib_get "$IB_PLAN" menu)
	IB_DESKTOP=$(ib_get "$IB_PLAN" desktop)
	rootmode=$(ib_get "$IB_PLAN" root)
	rootname=$(ib_get "$IB_PLAN" rootname)
	[ -n "$rootname" ] || rootname=ib
	[ -n "$IB_NAME_DISP" ] || IB_NAME_DISP=$IB_PROJECT
	case $IB_APPID in
	*[!a-z2-7]* | '') ib_fail "The plan's appid ($IB_APPID) is not 12 base32 characters." ;;
	????????????) ;;
	*) ib_fail "The plan's appid ($IB_APPID) is not 12 base32 characters." ;;
	esac
	case $rootname in '' | . | .. | */* | *[!A-Za-z0-9._-]*) ib_fail "Bad rootname: $rootname" ;; esac

	IB_SYSTEM=0
	[ "$rootmode" = system ] && IB_SYSTEM=1
	rmode=user
	[ $IB_SYSTEM = 1 ] && rmode=system
	IB_ROOT=$(ib_root_path "$rmode" "$rootname")
	# An app an older base put under the root of the day stays where it
	# is: installing it again replaces that copy instead of orphaning it
	# in the old folder, and the runtimes it shares with its neighbours
	# are found beside it. Only this app's own folder is looked for.
	oldroot=$(ib_root_legacy "$rmode" "$rootname")
	if [ -n "$oldroot" ] && [ ! -e "$IB_ROOT/$IB_APPID" ] && [ -e "$oldroot/$IB_APPID" ]; then
		ib_log "Keeping this app in the folder an earlier installer made: $oldroot/$IB_APPID"
		IB_ROOT=$oldroot
	fi
	case $IB_ROOT in
	*[\"\$\`\\]* | *"$nl"*) ib_fail "The install folder $IB_ROOT contains characters (\" \$ \` \\) that commands can't quote." ;;
	/*) ;;
	*) ib_fail "HOME is not set to an absolute path." ;;
	esac
	need_root=$IB_SYSTEM
	[ "$(ib_sel1 admin)" = 1 ] && need_root=1

	export IB_APP_DIR="$IB_ROOT/$IB_APPID"
	export IB_DATA_DIR="$IB_APP_DIR/data"
	export IB_TMP="$IB_WORK/tmp"
	export IB_PROJECT
	export IB_APP_NAME="$IB_NAME_DISP"

	# ---- already installed? Only the marker a finished install writes
	# last counts, for this appid and this exact record (the same settings).
	# (The fallback for plans by name, whose record hash only the server
	# knows; the others were checked before anything was fetched.)
	if [ "$opt_reinstall" != 1 ] && ib_is_installed; then
		ib_installed_now
	fi
	nfiles=$(ib_sel file | wc -l | tr -d ' ')
	IB_DIRMAP=
	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ib_sel file "$i")
		IFS=$ifs0
		h=$(ib_b32 "$(printf '%s%s' "$IB_APPID" "$1" | ib_sha256)" 12)
		IB_DIRMAP="$IB_DIRMAP$1$tab$IB_ROOT/$h$nl"
		[ "$i" = 1 ] && IB_RUNTIME_DIR=$IB_ROOT/$h
		i=$((i + 1))
	done
	export IB_DIRMAP IB_RUNTIME_DIR
	exe=$(ib_sel1 exe)
	IB_RUNTIME=
	[ -n "$exe" ] && [ -n "$IB_RUNTIME_DIR" ] && IB_RUNTIME=$IB_RUNTIME_DIR/$exe
	export IB_RUNTIME
	ib_needs_eval

	# ---- transparency (design.md section 3; the shape is set out at
	# "the review screen's shape", above)
	sum=$IB_WORK/summary.txt
	ib_signed_by=$(ib_signer)
	# The .run's own sha256 belongs on a line of its own, not glued to the
	# end of "Signed by:" where it pushes the answer off the screen.
	ib_signed_short=$(printf '%s' "$ib_signed_by" | sed 's/; this file has sha256 .*//')

	# What the totals are, before anything is printed: a person deciding
	# wants "2 files, 34.3 MB, from these three hosts" before they want
	# four 200-character URLs.
	ib_tot=0
	ib_urls=$IB_WORK/urls.txt
	: > "$ib_urls"
	ib_packed_all=1
	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ib_sel file "$i")
		IFS=$ifs0
		case ${4:-} in '' | *[!0-9]*) ;; *) ib_tot=$((ib_tot + $4)) ;; esac
		if { [ -n "$IB_PACK_DIR" ] && [ -f "$IB_PACK_DIR/$3" ]; } ||
			{ [ -n "$IB_PACK_TAR" ] && grep -qx "$3" "$IB_WORK/pack.list"; }; then :; else
			ib_packed_all=0
			ib_sel url "$i" >> "$ib_urls"
		fi
		i=$((i + 1))
	done
	src=$(ib_sel1 source)
	if [ -n "$src" ]; then
		IFS=$tab
		set -- $src
		IFS=$ifs0
		case ${3:-} in '' | *[!0-9]*) ;; *) ib_tot=$((ib_tot + $3)) ;; esac
		if { [ -n "$IB_PACK_DIR" ] && [ -f "$IB_PACK_DIR/$2" ]; } ||
			{ [ -n "$IB_PACK_TAR" ] && grep -qx "$2" "$IB_WORK/pack.list"; }; then :; else
			ib_packed_all=0
			ib_sel srcurl >> "$ib_urls"
		fi
	fi
	ib_nall=$nfiles
	[ -n "$src" ] && ib_nall=$((ib_nall + 1))
	ib_hostlist=$(ib_hosts < "$ib_urls")
	ib_nrun=$(ib_sel step | awk -F"$tab" '$2 == "run"' | wc -l | tr -d ' ')

	# The runtime, from the *last* runtime line: the selection carries the
	# plan's header (`runtime <id>` alone) before the chosen block's
	# (`runtime <id> <version> <arch>`), so ib_sel1 was showing the bare
	# id and never the version -- which is also why format.md's claim
	# that this engine already showed the architecture was wrong.
	ib_rt_line=
	ib_rt_note=
	rt=$(ib_sel runtime | sed -n '$p')
	if [ -n "$rt" ]; then
		IFS=$tab
		set -- $rt
		IFS=$ifs0
		a_name=$1 a_ver=${2:-} a_arch=${3:-}
		if [ -n "$a_arch" ]; then
			ib_rt_note=$(ib_arch_note "$a_arch" "$a_name")
			ib_rt_line="$a_name $a_ver, $(ib_arch_words "$a_arch")$ib_rt_note"
		else
			ib_rt_line=$(printf '%s' "$rt" | tr '\t' ' ')
		fi
	fi

	# Anything unusual, at the top, where a decision is made. `!!` is
	# "you would want to know this before saying yes"; `!` is "worth
	# noticing". Everything here is also stated again in its own section.
	ib_warn=$IB_WORK/warnings.txt
	: > "$ib_warn"
	[ -n "$ib_plan_warn" ] && printf '!! %s\n' "$ib_plan_warn" >> "$ib_warn"
	[ -n "$ib_age_warn" ] && printf '!! %s\n' "$ib_age_warn" >> "$ib_warn"
	[ -n "$ib_need_manual" ] &&
		printf '!! Something this app needs is missing and this installer cannot install it here; see SYSTEM-WIDE PREREQUISITES below.\n' >> "$ib_warn"
	case $ib_signed_by in
	*'does NOT verify'*) printf '!! The signature on this installer does not verify: it was changed after it was signed.\n' >> "$ib_warn" ;;
	esac
	if [ $need_root = 1 ]; then
		if [ -n "$ib_need_pkgs" ]; then
			printf '!  Part of this install runs as root: %s installs the system packages %s. The app itself installs for you.\n' \
				"$ib_pm" "$ib_need_pkgs" >> "$ib_warn"
		elif [ "$IB_SYSTEM" = 1 ]; then
			printf '!  This installs for every user on the machine, so it needs administrator rights.\n' >> "$ib_warn"
		else
			printf '!  This install needs administrator rights.\n' >> "$ib_warn"
		fi
	fi
	[ -n "$ib_rt_note" ] &&
		printf '!  The runtime being installed is not this machine%s architecture%s.\n' "'s" "$ib_rt_note" >> "$ib_warn"
	case $(ib_describe_source) in
	*'no stored hash'*) printf '!  The project is not pinned by a checksum: it is identified by its commit and fetched over HTTPS.\n' >> "$ib_warn" ;;
	esac

	{
		printf '======================================================================\n'
		printf '  TiddlyInstall will install:  %s\n' "$IB_NAME_DISP"
		printf '  Nothing has been changed yet.\n'
		printf '======================================================================\n'
		if [ -s "$ib_warn" ]; then
			printf '\nBEFORE YOU SAY YES\n'
			while IFS= read -r w; do
				printf '%s\n' "$w" | ib_wrap 74 5
			done < "$ib_warn"
		fi
		printf '\nIN SHORT\n'
		printf '  %-14s%s\n' 'Installs:' "$IB_NAME_DISP"
		printf '  %-14s%s\n' 'Project:' "$IB_PROJECT"
		printf '  %-14s%s\n' 'From:' "$(ib_describe_source)" | ib_wrap 74 16
		[ -n "$ib_rt_line" ] && printf '  Runtime:      %s\n' "$ib_rt_line" | ib_wrap 74 16
		printf '  %-14s%s\n' 'Machine:' "$IB_OSDESC"
		if [ "$ib_nall" -gt 0 ]; then
			if [ "$ib_packed_all" = 1 ]; then
				printf '  %-14snothing: all %s %s packed inside this installer\n' \
					'Download:' "$ib_nall" "$(ib_plural "$ib_nall" 'file is' 'files are')"
			else
				printf '  %-14s%s %s, %s in total, each checked against its SHA-256\n' \
					'Download:' "$ib_nall" "$(ib_plural "$ib_nall" file files)" "$(ib_hsize $ib_tot)" | ib_wrap 74 16
				[ -n "$ib_hostlist" ] && printf '  %-14s%s\n' 'Sources:' "$ib_hostlist" | ib_wrap 74 16
			fi
		fi
		printf '  %-14s%s\n' 'Into:' "$IB_APP_DIR"
		printf '  %-14s(plus one folder per dependency beside it; nothing else on this machine is changed)\n' '' | ib_wrap 74 16
		[ "$ib_nrun" -gt 0 ] && printf '  %-14s%s %s on this machine (listed below)\n' \
			'Then runs:' "$ib_nrun" "$(ib_plural "$ib_nrun" command commands)"
		if [ $need_root = 1 ]; then
			printf '  %-14syes%s\n' 'Admin rights:' "$([ -n "$ib_need_pkgs" ] && printf ', for the system packages only' || printf '')"
		else
			printf '  %-14snot needed\n' 'Admin rights:'
		fi
		printf '  %-14s%s\n' 'Signed by:' "$ib_signed_short" | ib_wrap 74 16
		[ -n "$ib_self_sha" ] && printf '  %-14sthis file has sha256 %s\n' '' "$ib_self_sha"
		printf '  %-14s%s\n' 'Record:' "${IB_RECHASH:-none}"

		printf '\nWHAT IT DOWNLOADS\n'
		if [ "$ib_nall" = 0 ]; then
			printf '  Nothing.\n'
		else
			printf '  %s %s, %s in total. Each one is checked against the SHA-256\n' \
				"$ib_nall" "$(ib_plural "$ib_nall" file files)" "$(ib_hsize $ib_tot)"
			printf '  below before it is used; a file that does not match is not installed.\n'
		fi
		i=1
		while [ "$i" -le "$nfiles" ]; do
			IFS=$tab
			set -- $(ib_sel file "$i")
			IFS=$ifs0
			printf '\n  %s. %s\n' "$i" "$2"
			ib_size_line "$4"
			printf '     sha256 %s\n' "$3"
			if { [ -n "$IB_PACK_DIR" ] && [ -f "$IB_PACK_DIR/$3" ]; } || { [ -n "$IB_PACK_TAR" ] && grep -qx "$3" "$IB_WORK/pack.list"; }; then
				printf '     from   the copy packed inside this installer\n'
			fi
			ib_sel url "$i" | awk 'NR == 1 { print "     from   " $0; next } { print "     or     " $0 }'
			i=$((i + 1))
		done
		if [ -n "$src" ]; then
			IFS=$tab
			set -- $src
			IFS=$ifs0
			printf '\n  %s. %s  (the project itself)\n' "$ib_nall" "$1"
			ib_size_line "$3"
			printf '     sha256 %s\n' "$2"
			if { [ -n "$IB_PACK_DIR" ] && [ -f "$IB_PACK_DIR/$2" ]; } || { [ -n "$IB_PACK_TAR" ] && grep -qx "$2" "$IB_WORK/pack.list"; }; then
				printf '     from   the copy packed inside this installer\n'
			fi
			ib_sel srcurl | awk 'NR == 1 { print "     from   " $0; next } { print "     or     " $0 }'
		fi

		printf '\nWHAT IT RUNS ON THIS MACHINE\n'
		# A step's own description, when the plan carries one (format.md
		# "Steps": an optional value appended to a `run` step), is what a
		# person can actually judge -- "make Ruby work from the folder it
		# is installed in" rather than 831 characters of shell. The
		# command is still shown, and always in full in the log.
		ib_stepn=0
		ib_sel step | awk -F"$tab" '$2 == "run" { print $3 "\t" $4 }' |
			while IFS="$tab" read -r c d; do
				ib_stepn=$((ib_stepn + 1))
				if [ -n "$d" ]; then
					printf '  %s. %s\n' "$ib_stepn" "$d" | ib_wrap 74 5
				else
					printf '  %s. a shell command:\n' "$ib_stepn"
				fi
				ib_cmd_line "$(ib_subst "$c")"
			done
		ins=$(ib_sel1 install)
		if [ -n "$ins" ]; then
			printf '  Then installs the project with:\n'
			ib_cmd_line "$(ib_subst "$ins")"
		fi
		printf '  Starts the app with (this is what the menu entry and launch.sh run):\n'
		ib_cmd_line "$(ib_subst "$(ib_sel1 launch)")"

		printf '\nWHERE FILES GO\n'
		printf '  App:      %s\n' "$IB_APP_DIR"
		printf '%s' "$IB_DIRMAP" | while IFS="$tab" read -r n d; do [ -n "$n" ] && printf '  %-9s %s\n' "$n:" "$d"; done

		printf '\nSHORTCUTS AND UNINSTALLER\n'
		if [ "$IB_MENU" != 0 ]; then
			if [ "$IB_OS" = macos ]; then
				printf '  Folder %s/%s with %s and Uninstall %s\n' "$([ $IB_SYSTEM = 1 ] && echo /Applications || echo "$HOME/Applications")" "$IB_NAME_DISP" "$IB_NAME_DISP" "$IB_NAME_DISP"
			else
				printf '  App menu folder "%s" with "%s" and "Uninstall %s" (ib-%s.* in the XDG menu folders)\n' "$IB_NAME_DISP" "$IB_NAME_DISP" "$IB_NAME_DISP" "$IB_APPID"
			fi
		else
			printf '  Nothing in the %s (this app asks for no menu entry)\n' "$([ "$IB_OS" = macos ] && echo "Applications folder" || echo "app menu")"
			if [ "$IB_OS" = macos ] && ib_want_desktop; then
				ib_mac_safe_name
				printf '  %s/Applications/%s.app, for the desktop shortcut to open\n' "$HOME" "$safe"
			fi
		fi
		ib_want_desktop && printf '  A desktop shortcut\n'
		ic=
		[ -n "$IB_REC" ] && [ "$IB_OS" = linux ] && ic=$(ib_get "$IB_REC" icon)
		[ -n "$ic" ] && printf '  Menu icon: the PNG packed in this installer (sha256 %s), copied to %s/icon.png\n' "$ic" "$IB_APP_DIR"
		printf '  Uninstaller: %s/uninstall.sh\n' "$IB_APP_DIR"
		[ "$IB_MENU" = 0 ] && printf '  To start it: %s/launch.sh, or run this installer again\n' "$IB_APP_DIR"
		printf '  PATH: not changed\n'
		ib_sel note | sed 's/^/\nNOTE: /'
		ib_needs_summary

		printf '\nWHERE THIS INSTALLER AND ITS SETTINGS CAME FROM\n'
		printf '  Signed by:  %s\n' "$ib_signed_short"
		[ -n "$ib_self_sha" ] && printf '              this file has sha256 %s\n' "$ib_self_sha"
		printf '  Settings:   %s\n' "$IB_ORIGIN"
		[ "$IB_MODE_A" = 1 ] && printf '              mode A: a signed installer; only what its name names, from %s\n' "$IB_DEFAULT_BACKEND"
		printf '  Plan:       %s\n' "$IB_PLAN_FROM"
		[ -n "$IB_PLAN_SIGNED" ] && printf '  Plan signed: %s%s\n' "$IB_PLAN_SIGNED" \
			"$(case $IB_PLAN_KIND in fetched) printf ' (fetched now)' ;; *) printf ' (carried in this installer)' ;; esac)"
		[ -n "$ib_revoke_note" ] && printf '  Revocations: %s\n' "$ib_revoke_note"
		[ -n "$ib_plan_warn" ] && printf '  WARNING: %s\n' "$ib_plan_warn"
		[ -n "$ib_age_warn" ] && printf '  WARNING: %s\n' "$ib_age_warn"
		printf '  Log:        %s\n' "$IB_LOG"
	} > "$sum"
	cat "$sum" >> "$IB_LOG"
	# The screen shortens a long command; the log never does.
	if [ "$ib_nrun" -gt 0 ]; then
		{
			printf '\nEvery command in full:\n'
			ib_sel step | awk -F"$tab" '$2 == "run" { print $3 }' |
				while IFS= read -r c; do printf '  %s\n' "$(ib_subst "$c")"; done
			ins=$(ib_sel1 install)
			[ -n "$ins" ] && printf '  install: %s\n' "$(ib_subst "$ins")"
			printf '  launch:  %s\n' "$(ib_subst "$(ib_sel1 launch)")"
		} >> "$IB_LOG"
	fi

	# The short form: the macOS dialog shows this and keeps the full text
	# behind "Details...", and the terminal repeats it just above the
	# question, where the full text has long since scrolled away.
	{
		printf 'Install %s?\n\n' "$IB_NAME_DISP"
		printf '  From:      %s\n' "$(ib_describe_source)"
		[ -n "$ib_rt_line" ] && printf '  Runtime:   %s\n' "$ib_rt_line"
		if [ "$ib_nall" -gt 0 ] && [ "$ib_packed_all" != 1 ]; then
			printf '  Download:  %s %s, %s, each checked against its SHA-256\n' \
				"$ib_nall" "$(ib_plural "$ib_nall" file files)" "$(ib_hsize $ib_tot)"
			[ -n "$ib_hostlist" ] && printf '  Sources:   %s\n' "$ib_hostlist" | ib_wrap 68 13
		fi
		printf '  Into:      %s\n' "$IB_APP_DIR"
		printf '  Signed by: %s\n' "$ib_signed_short" | ib_wrap 68 13
		[ $need_root = 1 ] && printf '  Admin:     yes%s\n' "$([ -n "$ib_need_pkgs" ] && printf ', for system packages only' || printf '')"
		[ -s "$ib_warn" ] && sed 's/^!! /  ! /; s/^!  /  ! /' "$ib_warn" | ib_wrap 68 6
		printf '\nNothing has been changed yet.'
	} > "$IB_WORK/short.txt"
	ib_confirm "TiddlyInstall" "$sum" "Install $IB_NAME_DISP?" || { ib_say "Cancelled; nothing was installed."; [ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG"; exit 1; }

	if [ $need_root = 1 ] && [ "$(id -u)" != 0 ]; then
		ib_elevate
		rc=$?
		ib_want_desktop && ib_desk_made=1
		[ $rc = 0 ] && [ "$opt_yes" != 1 ] && [ "$ib_ui" != tty ] && ib_message info "TiddlyInstall" "$IB_NAME_DISP is installed.${nl}${nl}$(ib_start_hint)"
		[ $rc = 0 ] || ib_fail "The administrator install did not finish."
		exit $rc
	fi

	# ---- install
	ib_needs_install
	ib_progress_start "Installing $IB_NAME_DISP…"
	: > "$IB_WORK/shortcuts"
	# An earlier install of this app (--reinstall, an older engine's install
	# with no marker, or one that was interrupted) is removed first, as its
	# uninstaller would; anything else in the way stops the install.
	if [ -e "$IB_APP_DIR" ]; then
		o=$(ib_get "$IB_APP_DIR/.ib-owner" appid 2>/dev/null)
		m=$(ib_get "$IB_APP_DIR/manifest.txt" appid 2>/dev/null)
		if [ "$o" = "$IB_APPID" ] && { [ -z "$m" ] || [ "$m" = "$IB_APPID" ]; }; then
			ib_say "Removing the earlier install in $IB_APP_DIR"
			ib_remove_app "$IB_APP_DIR" "$IB_APPID"
			[ -e "$IB_APP_DIR" ] && ib_fail "Could not remove the earlier install in $IB_APP_DIR."
		elif [ -n "$m" ] && [ "$m" != "$IB_APPID" ]; then
			ib_fail "$IB_APP_DIR belongs to another app ($m). Not installing."
		else
			ib_fail "$IB_APP_DIR already exists and is not this app's (a leftover?). Remove it, then try again."
		fi
	fi
	IB_CREATED=$IB_WORK/created
	: > "$IB_CREATED"
	ib_mkdirs "$IB_ROOT" || ib_fail "Could not create $IB_ROOT"
	mkdir "$IB_APP_DIR" || ib_fail "Could not create $IB_APP_DIR"
	ib_created r "$IB_APP_DIR"
	printf 'ib-folder\t1\nappid\t%s\nname\t(app)\n' "$IB_APPID" > "$IB_APP_DIR/.ib-owner" || ib_fail "Could not write $IB_APP_DIR/.ib-owner"
	mkdir -p "$IB_DATA_DIR" "$IB_TMP/dl"

	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ib_sel file "$i")
		IFS=$ifs0
		f_name=$1 f_file=$2 f_sha=$3
		d=$(printf '%s' "$IB_DIRMAP" | awk -F'\t' -v n="$f_name" '$1 == n { print $2; exit }')
		if [ -e "$d" ]; then
			o=$(ib_get "$d/.ib-owner" appid 2>/dev/null)
			[ "$o" = "$IB_APPID" ] || ib_fail "$d already exists and is not this app's; not installing."
			rm -rf "$d"
		fi
		mkdir "$d" || ib_fail "Could not create $d"
		ib_created r "$d"
		printf 'ib-folder\t1\nappid\t%s\nname\t%s\nfile\t%s\n' "$IB_APPID" "$f_name" "$f_file" > "$d/.ib-owner"
		mkdir -p "$IB_TMP/dl/$i"
		export IB_CUR_DIR="$d" IB_CUR_FILE="$IB_TMP/dl/$i/$f_file"
		ib_say "Getting $f_file"
		ib_sel url "$i" > "$IB_WORK/urls"
		ib_obtain "$f_sha" "$IB_CUR_FILE" "$IB_WORK/urls" "$f_file" ||
			ib_fail "Could not get $f_file with the expected SHA-256 from any source."
		ib_sel step "$i" > "$IB_WORK/steps.$i"
		if [ ! -s "$IB_WORK/steps.$i" ]; then
			cp "$IB_CUR_FILE" "$d/" || ib_fail "Could not copy $f_file into $d"
		fi
		while IFS= read -r st <&5; do
			IFS=$tab
			set -- $st
			IFS=$ifs0
			ib_step "$@"
		done 5< "$IB_WORK/steps.$i"
		rm -f "$IB_CUR_FILE"
		i=$((i + 1))
	done
	export IB_CUR_DIR="$IB_APP_DIR" IB_CUR_FILE=

	if [ -n "$src" ]; then
		IFS=$tab
		set -- $src
		IFS=$ifs0
		s_file=$1 s_sha=$2 s_fmt=$4 s_strip=${5:-0}
		ib_say "Getting the project ($s_file)"
		ib_sel srcurl > "$IB_WORK/urls"
		mkdir -p "$IB_TMP/dl/src"
		# The app's own source is the one file allowed to have no stored
		# hash (format.md, "Sources without a stored hash").
		ib_obtain "$s_sha" "$IB_TMP/dl/src/$s_file" "$IB_WORK/urls" "$s_file" unpinned ||
			if [ -z "$s_sha" ] || [ "$s_sha" = - ]; then
				ib_fail "Could not download the project ($s_file) over HTTPS from any source."
			else
				ib_fail "Could not get the project ($s_file) with the expected SHA-256 from any source."
			fi
		ib_unpack "$s_fmt" "$IB_TMP/dl/src/$s_file" "$IB_APP_DIR" "$s_strip" ||
			ib_fail "Could not unpack the project ($s_file)."
	fi

	ins=$(ib_sel1 install)
	if [ -n "$ins" ]; then
		c=$(ib_subst "$ins")
		ib_say "Installing the project: $c"
		(ib_apply_env 1 && cd "$IB_APP_DIR" && sh -c "$c") < /dev/null >> "$IB_LOG" 2>&1 ||
			ib_fail "The project's install command failed: $c"
	fi

	# ---- launch.txt, launcher, uninstaller
	l=$(ib_sel1 launch)
	[ -n "$l" ] || ib_fail "The plan has no launch command."
	{
		printf 'ib-launch\t1\n'
		printf 'cwd\t%s\n' "$IB_APP_DIR"
		ib_sel env | while IFS="$tab" read -r n v; do printf 'env\t%s\t%s\n' "$n" "$(ib_subst "$v")"; done
		ib_sel unset | while IFS= read -r n; do printf 'unset\t%s\n' "$n"; done
		ib_sel path | while IFS= read -r p; do printf 'path\t%s\n' "$(ib_subst "$p")"; done
		printf 'console\t%s\n' "${IB_CONSOLE:-0}"
		printf 'exec\t%s\n' "$(ib_subst "$l")"
	} > "$IB_APP_DIR/launch.txt"
	ib_write_launcher
	head -c "$IB_ENGINE_LEN" "$IB_SELF" > "$IB_APP_DIR/uninstall.sh" && chmod 755 "$IB_APP_DIR/uninstall.sh" ||
		ib_fail "Could not write the uninstaller."

	ib_install_icon
	if [ "$IB_OS" = macos ]; then ib_menus_macos; else ib_menus_linux; fi

	{
		printf 'ib-manifest\t1\n'
		printf 'name\t%s\n' "$IB_NAME_DISP"
		printf 'appid\t%s\n' "$IB_APPID"
		printf 'record\t%s\n' "$IB_RECHASH"
		printf 'installed\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf '%s' "$IB_DIRMAP" | while IFS="$tab" read -r n d; do [ -n "$d" ] && printf 'dir\t%s\n' "$d"; done
		cat "$IB_WORK/shortcuts"
		# Folders this install created outside the root, deepest first;
		# the uninstaller removes them only if they are empty.
		awk -F'\t' -v root="$IB_ROOT" '$1 == "e" && $2 != root && index($2, root "/") != 1 {
				if (index(root "/", $2 "/") == 1) b[++m] = $2; else a[++n] = $2 }
			END { for (i = n; i > 0; i--) print "shortcut\t" a[i]; for (i = m; i > 0; i--) print "shortcut\t" b[i] }' "$IB_CREATED"
	} > "$IB_APP_DIR/manifest.txt" || ib_fail "Could not write the manifest."

	# ---- the "fully installed" marker: the last thing a successful install
	# writes (docs/format.md section 5), renamed into place so it is never
	# half written. Running the installer again with the same record then
	# starts the app instead of installing it again.
	printf 'ib-installed\t1\nappid\t%s\nrecord\t%s\ninstalled\t%s\n' "$IB_APPID" "$IB_RECHASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		> "$IB_APP_DIR/.ib-installed.tmp" && mv -f "$IB_APP_DIR/.ib-installed.tmp" "$IB_APP_DIR/.ib-installed" ||
		ib_fail "Could not write $IB_APP_DIR/.ib-installed"

	ib_progress_stop
	IB_CREATED=
	ib_say "Installed $IB_NAME_DISP in $IB_APP_DIR"
	ib_log "Launcher: $IB_APP_DIR/launch.sh"
	hint=$(ib_start_hint)
	printf '%s\n' "$hint" | while IFS= read -r h; do ib_say "$h"; done
	cp "$IB_LOG" "$IB_APP_DIR/install.log" 2>/dev/null
	if [ "$opt_yes" != 1 ] && [ "$ib_ui" != tty ]; then
		ib_message info "TiddlyInstall" "$IB_NAME_DISP is installed.${nl}${nl}$hint${nl}${nl}Log: $IB_APP_DIR/install.log"
	fi
	[ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG" && IB_LOG=
	return 0
}

ib_usage() {
	cat <<'EOF'
TiddlyInstall (Linux and macOS)

  --yes               install (or uninstall) without asking
  --log=PATH          write the log to PATH
  --record=PATH       use this ib-record file
  --plan=PATH         use this ib-plan file (else the plan is fetched); it
                      must be signed by the TiddlyInstall key
  --unsigned-plan     accept an unsigned --plan or install.txt plan
  --reinstall         install again even if this app, with these same
                      settings, is already installed (otherwise running the
                      installer again starts the app, or with --yes just
                      says it is installed)
  --backend=URL       where to fetch records and plans
  --uninstall         remove the app this uninstall.sh belongs to
EOF
}

ib_main() {
	for a in "$@"; do
		case $a in
		--record=*) opt_record=$(ib_abs "${a#*=}") ;;
		--plan=*) opt_plan=$(ib_abs "${a#*=}") ;;
		--unsigned-plan) opt_unsigned=1 ;;
		--backend=*) opt_backend=${a#*=} ;;
		--log=*) opt_log=$(ib_abs "${a#*=}") ;;
		--yes | -y) opt_yes=1 ;;
		--reinstall) opt_reinstall=1 ;;
		--uninstall) opt_uninstall=1 ;;
		--ib-origin=*) opt_origin=${a#*=} ;;
		--help | -h) ib_usage; exit 0 ;;
		-psn_*) ;; # old macOS Finder launch argument
		*) printf 'Unknown option: %s\n' "$a" >&2; ib_usage >&2; exit 2 ;;
		esac
	done
	ib_detect_os
	ib_pick_ui
	IB_WORK=$(mktemp -d "${TMPDIR:-/tmp}/ib.XXXXXX") || { echo "mktemp failed" >&2; exit 1; }
	IB_HOME_TMP=$IB_WORK/home
	mkdir "$IB_HOME_TMP" || { echo "mktemp failed" >&2; exit 1; }
	trap ib_cleanup EXIT
	trap 'ib_fail "Interrupted."' INT TERM HUP
	if [ -n "$opt_log" ]; then
		IB_LOG=$opt_log
		: >> "$IB_LOG" || { echo "Can't write $IB_LOG" >&2; exit 1; }
	else
		IB_LOG=${TMPDIR:-/tmp}/ib-$(date +%Y%m%d-%H%M%S)-$$.log
		: > "$IB_LOG"
		ib_log_is_temp=1
	fi
	ib_log "TiddlyInstall engine $IB_ENGINE_VERSION, $(date -u +%Y-%m-%dT%H:%M:%SZ)"

	s=$0
	# `sh file.run` gives a bare name; a file here wins over a PATH lookup.
	case $s in */*) ;; *) [ -f "$s" ] || s=$(command -v "$s") ;; esac
	IB_SELF=$(ib_abs "$s")
	IB_BUNDLE=
	case $IB_SELF in
	*.app/Contents/MacOS/*) IB_BUNDLE=${IB_SELF%/Contents/MacOS/*} ;;
	esac
	if [ -n "$IB_BUNDLE" ]; then
		IB_NAME=$(basename "$IB_BUNDLE" .app)
		IB_HOME_DIR=$(dirname "$IB_BUNDLE")
	else
		IB_NAME=$(basename "$IB_SELF")
		IB_NAME=${IB_NAME%.run}
		IB_NAME=${IB_NAME%.sh}
		IB_HOME_DIR=$(dirname "$IB_SELF")
	fi
	ib_log "Running as $IB_SELF on $IB_OSDESC"

	if [ "$opt_uninstall" = 1 ] ||
		{ [ "$(basename "$IB_SELF")" = uninstall.sh ] && [ -f "$(dirname "$IB_SELF")/manifest.txt" ]; }; then
		ib_uninstall
		[ "$ib_log_is_temp" = 1 ] && rm -f "$IB_LOG"
		exit 0
	fi
	ib_install_main
}

ib_main "$@"
exit $?
