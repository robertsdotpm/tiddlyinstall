#!/bin/sh
# -------------------------------------------------------------------------- #
# This is an installer made with TiddlyInstall.                              #
#                                                                            #
# If you are reading this in a text editor, a double-click opened it as      #
# text instead of running it: a file downloaded over HTTP has no             #
# executable bit, and GNOME's file manager will not run a text file          #
# anyway. Nothing has happened. To install, open a terminal in this          #
# folder and run `sh` followed by this file's name.                          #
#                                                                            #
# It then shows everything it would do -- what it downloads and from         #
# where, where it puts it, what it runs -- and changes nothing until         #
# you say so.                                                                #
# -------------------------------------------------------------------------- #
#
# That box is for whoever double-clicked the file and got a text editor,
# which is what a browser download of a `.run` usually ends in: no
# executable bit, and GNOME will not run a text file anyway.
#
# Its "installer made with TiddlyInstall" line is a **fixed-width slot**:
# src/shared/builder.js overwrites it with "This is an installer for <the
# app>", from the record, whenever the name fits between the `#`s. In
# place and to the same byte length, because the byte offsets of the
# Ed25519 verifiers appended after this script are absolute and baked
# into TI_VERIFY_BLOBS below (make_run.sh). A name too long to fit
# leaves the line as it is, which is still true. The `#` ending each
# line is what makes the slot's width survive an editor that strips
# trailing spaces.
#
# The macOS .app carries this same file as Contents/MacOS/install, where
# nobody ever opens it and where the text is left alone: a .zip opens by
# double-click, and "run `sh` and this file's name" is true there too.
#
# TiddlyInstall base engine for Linux and macOS (POSIX sh + awk).
#
# One file, identical in every installer. It is the whole Linux `.run`
# (with a metadata block appended after the final `exit` line) and the
# executable of the macOS `TiddlyInstall.app`. A copy of it is kept in each
# installed app's folder as `uninstall.sh`.
#
# Spec: docs/format.md (records, plans, metadata block, manifest, launch),
# docs/plan.md 1.1-1.7. See src/installers/unix/README.md.
#
# Nothing in here is per-runtime. Only platform plumbing (downloader,
# sha256 tool, OS version, dialogs, menu entries) branches on the OS.

TI_ENGINE_VERSION=1
TI_DEFAULT_BACKEND=http://10.0.1.76:8080
# Set from the record or --backend when somebody actually chose one;
# empty means nothing was chosen and this engine filled in the address
# above, which is not a reason to go and talk to it (ti_revocations).
ti_backend_given=
# The plan signing key (docs/format.md "Plan signature"): base64 of the raw Ed25519
# public key, and its id. make_run.sh / make_app.sh fill these in.
TI_PLAN_PUBKEY=
TI_PLAN_KEYID=
# Our Ed25519 verifiers appended after this script: <arch>:<offset>:<length>
# (make_run.sh fills it; empty in the source and in the macOS .app).
TI_VERIFY_BLOBS=
# When this installer was built (plankey.sh fills both in): RFC 3339 for
# messages, and seconds since the epoch for arithmetic. The real time is
# certainly not earlier than this, which is the only clock floor a machine
# with a wrong RTC gives us (design.md 7.1, "Clocks").
TI_BUILD_TIME=
TI_BUILD_EPOCH=

tab=$(printf '\t')
cr=$(printf '\r')
nl='
'
ifs0=$IFS
set -f
umask 022

# ---------------------------------------------------------------- basics

ti_log() {
	[ -n "$TI_LOG" ] && printf '%s\n' "$*" >> "$TI_LOG"
	return 0
}

# Progress line: log it, and show it when a terminal is watching.
ti_say() {
	ti_log "$*"
	[ "$ti_ui" = tty ] && printf '%s\n' "$*" >&2
	return 0
}

ti_have() { command -v "$1" >/dev/null 2>&1; }

# Run a helper (curl, wget, openssl) with HOME in our temp folder, so it
# can't leave ~/.pki (curl with NSS, CentOS 7), ~/.wget-hsts or ~/.rnd in
# the user's home, and doesn't read their ~/.curlrc or ~/.wgetrc.
ti_nohome() { HOME=${TI_HOME_TMP:-$HOME} "$@"; }

# Text for the screen (stdin -> stdout): C0 controls except tab and
# newline, DEL, C1 controls and the bidi controls (U+200E/F, U+202A-202E,
# U+2066-2069) become '?', so plan text can't hide or reorder what the
# transparency screen shows (an ESC sequence can blank a terminal).
ti_re_c1=$(printf '\302[\200-\237]')
ti_re_bidi1=$(printf '\342\200[\216\217\252-\256]')
ti_re_bidi2=$(printf '\342\201[\246-\251]')
ti_clean() {
	LC_ALL=C tr -d '\000' | LC_ALL=C tr '\001-\010\013-\037\177' '??????????????????????????????' |
		LC_ALL=C sed -e "s/$ti_re_c1/?/g" -e "s/$ti_re_bidi1/?/g" -e "s/$ti_re_bidi2/?/g"
}
ti_cleans() { printf '%s' "$1" | ti_clean; }

# Quote a string for sh.
ti_shq() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

ti_abs() {
	case $1 in
	/*) printf '%s' "$1" ;;
	*) printf '%s/%s' "$PWD" "$1" ;;
	esac
}

ti_fail() {
	ti_rc=${ti_fail_rc:-1}
	ti_progress_stop
	ti_log "FAILED: $*"
	[ -n "$TI_CREATED" ] && [ -f "$TI_CREATED" ] && ti_rollback
	case $ti_ui in
	tty | none | '')
		if [ -n "$TI_LOG" ] && [ -s "$TI_LOG" ]; then
			printf '%s\n' '--- last lines of the log ---' >&2
			tail -n 15 "$TI_LOG" | ti_clean >&2
		fi
		printf 'TiddlyInstall: %s\n' "$(ti_cleans "$*")" >&2
		[ -n "$TI_LOG" ] && printf 'Log: %s\n' "$TI_LOG" >&2
		;;
	zenity)
		ti_clean < "$TI_LOG" > "$TI_LOG.screen" 2>/dev/null
		[ "$opt_yes" = 1 ] || zenity --text-info --title="TiddlyInstall: failed - $(ti_cleans "$*")" --filename="$TI_LOG.screen" --width=780 --height=560 2>/dev/null
		rm -f "$TI_LOG.screen"
		;;
	*)
		[ "$opt_yes" = 1 ] || ti_message error "TiddlyInstall" "$*$nl${nl}Log: $TI_LOG$nl$nl$(tail -n 8 "$TI_LOG" 2>/dev/null)"
		;;
	esac
	exit "$ti_rc"
}

ti_cleanup() {
	[ -n "$TI_WORK" ] && [ -d "$TI_WORK" ] && rm -rf "$TI_WORK"
	[ -n "$ti_progress_pid" ] && kill "$ti_progress_pid" 2>/dev/null
	return 0
}

# ---------------------------------------------------------------- platform plumbing

ti_detect_os() {
	case $(uname -s) in
	Linux) TI_OS=linux ;;
	Darwin) TI_OS=macos ;;
	*) TI_OS=unknown ;;
	esac
	m=$(uname -m)
	case $m in
	x86_64 | amd64) TI_ARCH=amd64 ;;
	i[3-6]86 | x86) TI_ARCH=x86 ;;
	aarch64 | arm64) TI_ARCH=arm64 ;;
	*) TI_ARCH=$m ;;
	esac
	if [ "$TI_OS" = macos ]; then
		# Under Rosetta uname says x86_64; the hardware is what counts.
		[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && TI_ARCH=arm64
		v=$(sw_vers -productVersion 2>/dev/null)
		TI_OSVER=$(printf '%s\n' "$v" | awk -F. '{ printf "%d", $1 * 100 + $2 }')
		TI_OSDESC="macOS $v $TI_ARCH"
	else
		v=$(getconf GNU_LIBC_VERSION 2>/dev/null)
		[ -z "$v" ] && v=$(ldd --version 2>&1 | sed -n 1p)
		TI_OSVER=$(printf '%s\n' "$v" | awk '
			/musl/ { print 0; exit }
			{ for (i = NF; i > 0; i--) if ($i ~ /^[0-9]+\.[0-9]+/) { split($i, p, "."); print p[1] * 100 + p[2]; exit } }
			END { if (NR == 0) print 0 }')
		[ -z "$TI_OSVER" ] && TI_OSVER=0
		TI_OSDESC="Linux, ${v#glibc } ($TI_OSVER), $TI_ARCH"
	fi
}

ti_sha256() { # [file]; reads stdin without an argument
	if ti_have sha256sum; then
		sha256sum ${1:+"$1"} | awk '{ print tolower($1) }'
	elif ti_have shasum; then
		shasum -a 256 ${1:+"$1"} | awk '{ print tolower($1) }'
	elif ti_have openssl; then
		ti_nohome openssl dgst -sha256 ${1:+"$1"} | awk '{ print tolower($NF) }'
	else
		ti_fail "No SHA-256 tool (sha256sum, shasum or openssl) on this machine."
	fi
}

# Lowercase RFC 4648 base32 (no padding) of a hex string, first $2 chars.
ti_b32() {
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

ti_download() { # url out
	ti_log "  GET $1"
	ti_http=
	if ti_have curl; then
		ti_http=$(ti_nohome curl -fL -sS --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 2 \
			-w '%{http_code}' -o "$2" "$1" 2>> "$TI_LOG")
	elif ti_have wget; then
		ti_nohome wget -q -T 60 -t 2 -O "$2" "$1" >> "$TI_LOG" 2>&1
	else
		ti_fail "No downloader (curl or wget) on this machine."
	fi
}

# A small document the install can do without (the revocation list): a
# short timeout and no retries, so an offline installer -- which carries
# everything it needs -- isn't held up for a minute by a network that
# isn't there.
ti_download_quick() { # url out
	ti_log "  GET $1 (optional)"
	ti_http=
	if ti_have curl; then
		ti_http=$(ti_nohome curl -fL -sS --connect-timeout 5 --max-time 20 \
			-w '%{http_code}' -o "$2" "$1" 2>> "$TI_LOG")
	elif ti_have wget; then
		ti_nohome wget -q -T 10 -t 1 -O "$2" "$1" >> "$TI_LOG" 2>&1
	else
		return 1
	fi
}

# How the UI talks to the user: tty, zenity, kdialog, osascript, or none.
# Is there a display we can actually put a window on? `$DISPLAY` being
# set is not an answer to that. A stale variable, or an X forwarding
# that has gone away, leaves it set and pointing at nothing -- and
# measured on 2026-09-21, **both zenity and kdialog hang** on a display
# that is not there rather than failing: no window, no error, no prompt,
# forever. kdialog is worse than that, because with no display its
# `--yesno` has been seen to exit 0, which the old code read as "the
# person said install".
#
# So the socket is checked before either is started, and only a display
# we can see counts as one we can use:
#
#   Wayland  the socket $WAYLAND_DISPLAY names, under $XDG_RUNTIME_DIR
#   X11      /tmp/.X11-unix/X<n> for a local display
#
# A display on another host (`host:0`, or the `localhost:10.0` an
# `ssh -X` gives, which is a TCP display with no local socket) cannot be
# checked this cheaply, so it never earns the window -- it is only
# tried as a last resort below, where the alternative was an error
# anyway. Anyone reaching a machine over SSH has a terminal, and the
# full text is what they get, which is the ordinary way to install on a
# server.
# `ok` a display we can see, `unknown` one we cannot check from here,
# `no` nothing usable. Only `ok` earns a window; `unknown` is tried as a
# last resort when there is no terminal either, which is no worse than
# what this did before; `no` never starts a dialog at all, because a
# local display whose socket is missing is precisely the one that hangs.
ti_display_state() {
	[ "${TI_NO_GUI-}" = 1 ] && { printf 'no'; return; }
	if [ -n "${WAYLAND_DISPLAY-}" ]; then
		case $WAYLAND_DISPLAY in
		/*) [ -S "$WAYLAND_DISPLAY" ] && { printf 'ok'; return; } ;;
		*) [ -n "${XDG_RUNTIME_DIR-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && { printf 'ok'; return; } ;;
		esac
	fi
	[ -n "${DISPLAY-}" ] || { printf 'no'; return; }
	d=${DISPLAY##*/}            # `unix/:0` and the like
	h=${d%%:*}
	n=${d#*:}
	n=${n%%.*}
	case $n in '' | *[!0-9]*) printf 'no'; return ;; esac
	case $h in
	'' | unix) [ -S "/tmp/.X11-unix/X$n" ] && printf 'ok' || printf 'no' ;;
	*) printf 'unknown' ;;
	esac
}

# A dialog tool that can draw on it.
ti_gui_tool() {
	ti_have zenity && { printf 'zenity'; return 0; }
	ti_have kdialog && { printf 'kdialog'; return 0; }
	return 1
}

# Which of the four ways of asking this run gets.
#
# **A window when there is a screen and nobody passed a flag** (the
# operator, 2026-09-21). `sh installer.run` on a desktop is what the
# box at the top of the file tells people to type, and the answer to it
# should be a real window: scrollable, resizable, formatted, with
# Install and Cancel as buttons. Seventy-five lines dumped into a
# terminal is not that, and paging them was worse (design.md 3).
#
# **The text when the person is driving.** Any argument at all means
# this run is scripted or deliberate -- `--yes`, `--plan=`, `--log=`,
# anything -- and then the whole text goes to the terminal at once, to
# be scrolled back through or captured, exactly as it always has. The
# rule is "any argument" rather than a list of the interesting ones
# because a list is a thing to keep in step with `ti_main`, and because
# there is no flag whose presence suggests somebody wants a dialog.
# The Finder's own `-psn_...` is not an argument anyone passed and does
# not count.
#
# macOS keeps the terminal ahead of its dialog: that dialog is a small
# one with the full text behind "Details...", not a review window, so
# taking a Terminal user out of the terminal would be a downgrade.
ti_pick_ui() {
	ti_disp=$(ti_display_state)
	if [ "${ti_args:-0}" = 0 ] && [ "$TI_OS" != macos ] && [ "$ti_disp" = ok ]; then
		ti_ui=$(ti_gui_tool) && [ -n "$ti_ui" ] && return 0
	fi
	if [ -t 0 ] && [ -t 2 ]; then
		ti_ui=tty
		return 0
	fi
	if [ "$TI_OS" = macos ] && ti_have osascript; then
		ti_ui=osascript
		return 0
	fi
	# No terminal. A display we could see, or one we could not check, is
	# better than refusing outright -- but never one we checked and found
	# missing, which is the case that hangs.
	if [ "$ti_disp" = ok ] || [ "$ti_disp" = unknown ]; then
		ti_ui=$(ti_gui_tool) && [ -n "$ti_ui" ] && return 0
	fi
	ti_ui=none
}

ti_osa() { # script-on-stdin args...; plan text goes in argv, never into the script
	osascript - "$@"
}

ti_message() { # info|error title text; never a dialog with --yes
	set -- "$1" "$(ti_cleans "$2")" "$(ti_cleans "$3")"
	ui=$ti_ui
	[ "$opt_yes" = 1 ] && ui=none
	case $ui in
	tty | none) printf '%s\n' "$3" >&2 ;;
	zenity) zenity --"$1" --title="$2" --no-markup --text="$3" 2>/dev/null ;;
	kdialog) if [ "$1" = error ]; then kdialog --title "$2" --error "$3"; else kdialog --title "$2" --msgbox "$3"; fi ;;
	osascript)
		ti_osa "$2" "$3" "$1" <<'EOF' >/dev/null 2>&1
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
# The whole text, then the question, in the terminal. The text is
# longer than the screen, so by the time the question appears the top
# of it -- what is being installed, and by whom -- has scrolled away;
# one line stands above the prompt, the decision and not a second copy
# of the screen (see "decide.txt", where it is written). Paging it was
# tried on 2026-09-21 and taken out again the same day: design.md 3.
#
# This is also where a dialog lands when the screen turns out not to be
# there, so it has to stay exactly as readable as it is when it is the
# only thing on offer: over SSH with no display this is the ordinary
# way to install a thing, not a consolation prize.
ti_ask_tty() { # review-file question
	if ti_want_colour; then ti_paint < "$1" >&2; else cat "$1" >&2; fi
	if [ -s "$TI_WORK/decide.txt" ]; then
		printf '\n' >&2
		printf -- '----------------------------------------------------------------------\n' >&2
		if ti_want_colour; then ti_paint < "$TI_WORK/decide.txt" >&2; else cat "$TI_WORK/decide.txt" >&2; fi
	fi
	printf '\n%s [y/N] ' "$2" >&2
	read -r ans || return 1
	case $ans in y | Y | yes | YES | Yes) return 0 ;; esac
	return 1
}

# Did that dialog fail because there was no screen, rather than because
# somebody pressed Cancel? ti_display_ok should have caught this before
# either tool was started; this is the second line of defence, and it
# is here because a "no" the person never gave and a "yes" they never
# gave are both wrong, and kdialog has been seen to answer 0 with no
# display at all.
ti_gui_failed() { # stderr-file
	[ -s "$1" ] || return 1
	grep -qiE "cannot open display|could not open (the )?x display|unable to init server|failed to connect to|cannot connect to" "$1"
}

# When it does, the terminal takes over -- with the review and the
# question, never one without the other.
ti_gui_fallback() { # review-file question stderr-file
	ti_log "No window could be opened; asking in the terminal instead. $(tr '\n' ' ' < "$3" | cut -c1-200)"
	if [ -t 0 ] && [ -t 2 ]; then
		ti_ask_tty "$1" "$2"
		return
	fi
	ti_fail "DISPLAY is set but no window could be opened on it, and there is no terminal to ask in. Run it in a terminal, or pass --yes to accept without asking."
}

ti_confirm() {
	[ "$opt_yes" = 1 ] && return 0
	ti_clean < "$2" > "$TI_WORK/confirm.txt"
	for f in short decide; do
		[ -f "$TI_WORK/$f.txt" ] && { ti_clean < "$TI_WORK/$f.txt" > "$TI_WORK/$f.clean"; mv "$TI_WORK/$f.clean" "$TI_WORK/$f.txt"; }
	done
	set -- "$(ti_cleans "$1")" "$TI_WORK/confirm.txt" "$(ti_cleans "$3")"
	case $ti_ui in
	tty)
		ti_ask_tty "$2" "$3"
		return
		;;
	zenity)
		# Monospace, or the columns and the hashes do not line up; a
		# button that says what it does, not "OK". A zenity too old for
		# either answers 255 (a bad option), which a cancel never is.
		#
		# stderr is kept rather than thrown away: on this desktop even a
		# working zenity prints libEGL noise, so it cannot be read as
		# "something went wrong", but it is where a display that is not
		# there says so, and a cancel that never happened must not be
		# read as a cancel.
		ti_dialog_size
		ti_gerr=$TI_WORK/gui.err
		zenity --text-info --title="$1 - $3" --filename="$2" --font="Monospace 10" \
			--width=$ti_dlg_w --height=$ti_dlg_h \
			--ok-label="Install" --cancel-label="Cancel" 2>"$ti_gerr"
		rc=$?
		if [ $rc = 255 ]; then
			zenity --text-info --title="$1 - $3" --filename="$2" \
				--width=$ti_dlg_w --height=$ti_dlg_h 2>"$ti_gerr"
			rc=$?
		fi
		ti_gui_failed "$ti_gerr" && { ti_gui_fallback "$2" "$3" "$ti_gerr"; return; }
		return $rc
		;;
	kdialog)
		# Two dialogs, and the second one is the consent. With no
		# display kdialog has been seen to answer 0 to both, so its
		# stderr decides before its exit code does.
		ti_dialog_size
		ti_gerr=$TI_WORK/gui.err
		kdialog --title "$1 - $3" --textbox "$2" $ti_dlg_w $ti_dlg_h 2>"$ti_gerr"
		rc=$?
		ti_gui_failed "$ti_gerr" && { ti_gui_fallback "$2" "$3" "$ti_gerr"; return; }
		[ $rc = 0 ] || return $rc
		kdialog --title "$1" --yesno "$3" 2>"$ti_gerr"
		rc=$?
		ti_gui_failed "$ti_gerr" && { ti_gui_fallback "$2" "$3" "$ti_gerr"; return; }
		return $rc
		;;
	osascript)
		while :; do
			r=$(ti_osa "$1" "$(cat "$TI_WORK/short.txt")" "$3" <<'EOF' 2>/dev/null
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
		ti_fail "No terminal or dialog tool to ask before installing. Run it in a terminal, or pass --yes to accept without asking."
		;;
	esac
}

ti_progress_start() {
	[ "$ti_ui" = zenity ] && [ "$opt_yes" != 1 ] || return 0
	(while :; do printf '# %s\n' "$1"; sleep 2; done) |
		zenity --progress --pulsate --no-cancel --title="TiddlyInstall" 2>/dev/null &
	ti_progress_pid=$!
}

ti_progress_stop() {
	[ -n "$ti_progress_pid" ] && kill "$ti_progress_pid" 2>/dev/null
	ti_progress_pid=
	return 0
}

# ---------------------------------------------------------------- the review screen's shape
#
# The transparency screen (design.md section 3) has a lot to say, and a
# wall of it is not consent. Four rules hold it together:
#
#   * the answer to "should I run this?" is at the top (IN SHORT), the
#     evidence below it;
#   * a line is never longer than 78 characters unless it is a URL,
#     which is never broken -- half a URL is worse than a long one;
#   * nothing is said twice. A screen that repeats itself is a screen
#     that teaches people it can be skimmed, and the promise this text
#     exists to keep is that it is worth reading. What the log can hold
#     instead of the screen -- every URL, every command in full -- the
#     log holds (2026-09-21);
#   * the file itself is always plain text. The log, zenity, kdialog and
#     the macOS dialog all get exactly these bytes; only the terminal
#     path paints them, and only when a terminal is really there.
#
# Only in a terminal does the text scroll away before the question is
# reached, and only there is anything repeated above the prompt: one
# line, written into decide.txt near the end of ti_install_main.

# 35945651 -> "34.3 MB". Integer arithmetic: there is no bc on a busybox.
ti_hsize() {
	n=${1:-}
	case $n in '' | *[!0-9]*) printf '%s' "$n"; return ;; esac
	if [ "$n" -lt 1024 ]; then printf '%s bytes' "$n"
	elif [ "$n" -lt 1048576 ]; then printf '%s.%s kB' "$((n / 1024))" "$(((n % 1024) * 10 / 1024))"
	elif [ "$n" -lt 1073741824 ]; then printf '%s.%s MB' "$((n / 1048576))" "$(((n % 1048576) * 10 / 1048576))"
	else printf '%s.%s GB' "$((n / 1073741824))" "$(((n % 1073741824) * 10 / 1073741824))"
	fi
}

# "1 file" / "2 files", without a "(s)" anywhere on a consent screen.
ti_plural() { # n singular plural
	[ "$1" = 1 ] && printf '%s' "$2" || printf '%s' "$3"
}

# How many wrapped lines a command may take before it is shortened
# instead. Four is about a fifth of a 24-line terminal.
TI_CMD_LINES=4
TI_CMD_W=74           # wrap here
TI_CMD_IND=5          # the first line starts in column 5
TI_CMD_CONT=9         # and the rest in column 9

# Wrap one command, breaking only at a space that is **outside double
# quotes**. ti_wrap breaks at any space, which is right for prose and
# wrong here: a Windows profile folder often has a space in it, so
#
#     msiexec /a "C:\Users\jörg
#         müller\AppData\Local\Temp\…\core.msi" /qn …
#
# reads as two arguments when it is one path. (German Windows 11 is
# where that showed, but "C:\Users\John Smith" is the ordinary case.)
# A quoted run with no space in it is broken like anything else, and a
# single run longer than the line is never broken at all: half a path
# is worse than a long one.
ti_cmd_wrap() { # text width first-indent continuation-indent
	TI_CW=$1 awk -v w="$2" -v ind="$3" -v cont="$4" 'BEGIN {
		s = ENVIRON["TI_CW"]
		n = length(s)
		pos = 1
		first = 1
		while (pos <= n) {
			k = (first ? ind : cont)
			room = w - k
			pad = ""
			for (i = 0; i < k; i++) pad = pad " "
			if (n - pos + 1 <= room) { print pad substr(s, pos); break }
			# the last space outside quotes that still fits, else the
			# first one after the width
			q = 0; last = 0; nxt = 0
			for (i = pos; i <= n; i++) {
				c = substr(s, i, 1)
				if (c == "\"") { q = 1 - q; continue }
				if (c != " " || q) continue
				if (i - pos < room) last = i
				else if (nxt == 0) nxt = i
			}
			cut = (last ? last : nxt)
			if (cut == 0) { print pad substr(s, pos); break }
			print pad substr(s, pos, cut - pos)
			pos = cut + 1
			first = 0
		}
	}'
}

# One command, rendered. It decides how to *show* a command and nothing
# else: whether a command is worth showing at all is the caller's
# question, and is deliberately kept out of here.
#
# It is wrapped, not cut, while it fits. Up to 2026-09-21 anything over
# 96 characters was replaced by its first 93 and "the whole command is
# at the end of the log", which meant a 103-character launch command --
# one wrapped line, and the most useful line on the screen, since it is
# what the menu entry will run -- was hidden behind a pointer to a file.
# The cut is for the case it was written for: the worst command in the
# catalogue is Ruby's relocation step, 831 characters of shell on one
# line, which wrapped is thirteen lines of `ls | grep | head -1` that
# nobody can review -- and a screen that cannot be reviewed teaches
# people to click through, which is the opposite of what it is for.
#
# Continuations are indented past the first line, so a wrapped command
# reads as one command and not as two, and a break never lands inside a
# quoted path (ti_cmd_wrap, above). The log has every command in full
# either way.
ti_cmd_line() { # command
	ti_c=$1
	ti_cn=${#ti_c}
	ti_cw=$(ti_cmd_wrap "$ti_c" "$TI_CMD_W" "$TI_CMD_IND" "$TI_CMD_CONT")
	if [ "$(printf '%s\n' "$ti_cw" | wc -l | tr -d ' ')" -le "$TI_CMD_LINES" ]; then
		printf '%s\n' "$ti_cw"
	else
		printf '     %s...\n' "$(printf '%s' "$ti_c" | cut -c1-93)"
		printf '     (%s characters in all; the whole command is at the end of the log)\n' "$ti_cn"
	fi
}

# A file's size, with the exact byte count only when it adds anything,
# and the file's role when the name line was too long to carry it.
ti_size_line() { # size [role]
	r=
	[ -n "${2:-}" ] && r="  ($2)"
	if [ "${1:-0}" -ge 1024 ] 2>/dev/null; then
		printf '     %s (%s bytes)%s\n' "$(ti_hsize "$1")" "$1" "$r"
	else
		printf '     %s%s\n' "$(ti_hsize "$1")" "$r"
	fi
}

# What a file in the download list *is*, from where it sits in the plan
# and never from its name (2026-09-21). WHAT IT RUNS says whose commands
# are whose; a list of four MSIs called core, exe, lib and tcltk is the
# same puzzle one section up, and the plan can answer it:
#
#   * the `file` whose name is the `runtime` line's id is the runtime;
#   * a file whose folder is put on PATH as `{dir:<name>}` is a
#     companion runtime the recipe requires (git, WinLibs GCC, zig) --
#     a tool the install uses, not the thing being installed. Nothing
#     else in a plan writes that form of `path`;
#   * every other `file` is part of the runtime's own setup: a release
#     part (Windows Python is four MSIs) or an extra file the recipe
#     needs (Composer, get-pip, a CA bundle).
#
# The last one is by elimination, and is sound only because docs/format.md
# section 3 closes the list of what a block's `file` lines may be. It
# says so there as a rule an engine depends on, so that a fifth kind
# cannot be added without this being looked at. A `need`'s `nfile` is
# not in this list at all: it has its own section, whose heading already
# says it is installed for the whole machine and survives the uninstall.
ti_file_role() { # name -> what it is, or nothing
	[ -n "$1" ] || return 0
	if [ -n "$ti_rt_id" ] && [ "$1" = "$ti_rt_id" ]; then printf 'the runtime'; return 0; fi
	case " $ti_comp_names " in
	*" $1 "*) printf 'a tool the install needs' ;;
	*) printf 'part of the runtime' ;;
	esac
}

# The hosts a list of URLs (stdin) points at, in order, once each. What a
# person wants near the top is "who am I downloading from", not four
# 200-character URLs; the URLs themselves are still in the detail.
ti_hosts() {
	awk '{ u = $0
	       sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", u)
	       sub(/[\/?#].*$/, "", u)
	       sub(/^[^@]*@/, "", u)
	       if (u != "" && !(u in seen)) { seen[u] = 1; out = out (out == "" ? "" : ", ") u } }
	     END { if (out != "") print out }'
}

# Which one of a file's URLs (stdin) is the place the file really comes
# from. $1 is the host to treat as ours.
#
# A list of six hosts answers nobody's question. But the shortest true
# answer is not the first URL either: the resolver writes a file's
# locations as [our copy,] the vendor's own URL, other people's mirrors
# of it, [our copy] (src/shared/resolve.js, `mirror_first`), and our copy is
# normally first on purpose -- old machines often cannot complete a TLS
# handshake to python.org, and a mirror we serve over plain HTTP is the
# only way they get the file at all. So URL 1 is usually ours, and "from
# 10.0.1.76:8080" is no more use to a person than the whole list.
#
# Our copy is the one on the host we are talking to, so the first URL
# that is *not* on that host is the vendor's own. That is what the
# screen names, with the rest counted as mirrors of it rather than
# listed -- and never as "this is where it will be fetched from", which
# would be the lie: it says where the file comes from, and the SHA-256
# is what decides whether any given copy is used. With nothing but our
# own host in the list (a file only we have) the first URL is all there
# is, and is what is shown.
ti_origin_url() { # our-host < urls
	awk -v me="$1" '{ h = $0
	       sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", h)
	       sub(/[\/?#].*$/, "", h)
	       sub(/^[^@]*@/, "", h)
	       if (first == "") first = $0
	       if (me == "" || h != me) { print $0; found = 1; exit } }
	     END { if (!found && first != "") print first }'
}

# The host part of one URL.
ti_host_of() { # url
	printf '%s\n' "$1" | ti_hosts
}

# Where one file comes from, for the evidence section: the origin URL,
# and the rest counted rather than listed. Seven URLs stacked one under
# the other is not evidence anybody reads -- it is the same wall of text
# that makes people stop reading the screen at all -- and nothing is
# lost by counting them, because the log carries every URL in the order
# they are tried, exactly as it carries every command in full.
#
# It says nothing about the checksum: the `sha256` line is two lines
# above and the section's own opening sentence has already said a file
# that does not match is not installed. Saying it a third time here is
# the repetition this screen is supposed to be rid of.
ti_from_lines() { # our-host < urls
	awk -v me="$1" '
	{ u[NR] = $0
	  h = $0
	  sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", h)
	  sub(/[\/?#].*$/, "", h)
	  sub(/^[^@]*@/, "", h)
	  hh[NR] = h }
	END {
	  if (NR == 0) exit
	  o = 1
	  for (i = 1; i <= NR; i++) if (me == "" || hh[i] != me) { o = i; break }
	  printf "     from   %s\n", u[o]
	  n = NR - 1
	  if (n > 0)
		printf "     or     %d %s of it, every one of them in the log\n", \
			n, (n == 1 ? "other copy" : "mirrors")
	}'
}

# "a mirror of it" / "a mirror of them": the Sources line reads about
# one origin far more often than several.
ti_itthem() { [ "$1" = 1 ] && printf 'it' || printf 'them'; }

# A name with its case and punctuation taken out, for asking whether two
# lines of the screen are saying the same thing ("test b" / "test_b").
# LC_ALL=C because a name is not always ASCII and macOS's tr stops on a
# byte its locale does not like; here the bytes just pass through.
ti_flatname() { # text
	printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[^a-z0-9]//g'
}

# Wrap a "key:<padding>value" line (stdin) so the value keeps its column.
# $1 is the width to wrap at, $2 the column the value starts in: the first
# $2 characters are left exactly as they are and every following line is
# indented to match. A token longer than the width is never broken -- half
# a URL is worse than a long one.
#
# This is for prose, where any space is a fair break. A command is not
# prose and has ti_cmd_wrap instead.
#
# **Every line of prose on the review screen goes through this**, at 74 for
# the text screen (which is also what zenity and kdialog are shown -- see
# the README: they are handed this same pre-wrapped file, they do not wrap
# anything themselves) and at 68 for the macOS dialog's short form. Those
# two numbers are the only widths that exist; no window size enters into
# it. If you add a section, wrap it.
#
# SYSTEM-WIDE PREREQUISITES was written without this and stayed that way
# until 2026-09-21. It was invisible because a screen that is not wrapped
# still looks like text: the terminal wraps it instead, and a terminal
# breaks mid-word, so a catalogue `nwhy` of 225 characters read "...are
# compiled when t / he app's gems are installed", and zenity re-wrapped it
# flush left and threw the indent away. Nothing failed; it just looked
# like that to whoever installed Ruby.
ti_wrap() {
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
ti_screen_size() {
	if ti_have xdotool; then
		xdotool getdisplaygeometry 2>/dev/null && return 0
	fi
	if ti_have xdpyinfo; then
		xdpyinfo 2>/dev/null | sed -n 's/^  dimensions: *\([0-9][0-9]*\)x\([0-9][0-9]*\).*/\1 \2/p' | sed -n 1p
		return 0
	fi
	if ti_have xrandr; then
		xrandr 2>/dev/null | sed -n 's/^.* connected[^0-9]*\([0-9][0-9]*\)x\([0-9][0-9]*\)+.*/\1 \2/p' | sed -n 1p
		return 0
	fi
	return 0
}

# The dialog size to ask for: as much as the text wants, less than the
# screen has. A review dialog taller than the screen hides its own
# buttons, which is how the old one lost its bottom on a 1024x768 Xfce.
ti_dialog_size() {
	ti_dlg_w=800
	ti_dlg_h=560
	set -- $(ti_screen_size)
	if [ $# -ge 2 ] && [ "$1" -gt 200 ] 2>/dev/null && [ "$2" -gt 200 ] 2>/dev/null; then
		ti_dlg_w=$(($1 - 80))
		ti_dlg_h=$(($2 - 150))
		[ "$ti_dlg_w" -gt 980 ] && ti_dlg_w=980
		[ "$ti_dlg_h" -gt 820 ] && ti_dlg_h=820
		[ "$ti_dlg_w" -lt 640 ] && ti_dlg_w=640
		[ "$ti_dlg_h" -lt 400 ] && ti_dlg_h=400
	fi
}

# Does the terminal we are talking to take ANSI colour? Never into a log,
# a pipe, an unattended run or a terminal that says it is dumb.
ti_want_colour() {
	[ "$opt_yes" = 1 ] && return 1
	[ -n "${NO_COLOR-}" ] && return 1
	[ "${TI_COLOR-}" = 0 ] && return 1
	[ "${TI_COLOR-}" = 1 ] && return 0
	[ -t 2 ] || return 1
	case ${TERM-} in '' | dumb | unknown | emacs) return 1 ;; esac
	if ti_have tput; then
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
# ti_clean, so nothing in it can carry an escape of its own.
ti_paint() {
	awk '
	BEGIN { b = "\033[1m"; o = "\033[0m"; red = "\033[1;31m"
		yel = "\033[33m"; dim = "\033[2m"
		# A heading may contain an apostrophe and this program is
		# inside single quotes, so the pattern is built rather than
		# written. The dash goes last or it starts a range.
		q = sprintf("%c", 39)
		hre = "^[A-Z][A-Z0-9 ,.:()/+" q "-]*$" }
	# How many capitals, which is what tells a heading from a line that
	# merely has no lower case in it. linepaint.c counts them too.
	function caps(s,   t) { t = s; gsub(/[^A-Z]/, "", t); return length(t) }
	# Structure follows a blank line; wrapped prose does not. Without
	# this, any wrapped fragment that happened to look like a heading
	# was bolded -- a line ending "...is not a second" left "opinion:"
	# starting the next one, and it was painted as a label.
	{ pb = lastblank; lastblank = ($0 ~ /^[ \t]*$/) }
	/^!! /                        { print red $0 o; next }
	/^!  /                        { print yel $0 o; next }
	/^[-=]+$/                     { print dim $0 o; next }
	$0 ~ hre && caps($0) >= 3  { print b $0 o; next }
	# A verdict on its own line, indented and shouting: UNSIGNED,
	# SIGNED BY TIDDLYINSTALL, NO SIGNATURE... Anchored at both ends so
	# a summary row like "  PATH   Not changed" is not caught by it.
	/^  [A-Z][A-Z0-9 ,.()\/+-]*$/ && length($0) >= 5 && caps(substr($0, 3)) >= 4 {
		print b $0 o; next }
	/^ +(sha256|from|or) /        { print dim $0 o; next }
	# The key of a summary row, capped at eighteen characters as the
	# RTF side has always been (linepaint.c ti_key_len stops at twenty).
	# Without a cap, a wrapped line of prose that happens to contain a
	# colon is bolded as though it were a label, which is what the line
	# ending "downloaded it:" did as soon as the trust section grew
	# sentences long enough to wrap.
	#
	# The value may be empty: "Uninstaller:" with the path on the line
	# below is a shape this screen uses, and the RTF side has always
	# bolded it. The minimum length keeps the two in step over a
	# one-letter key, which the RTF side is too short to reach.
	#
	# A lone letter before the colon is a drive, not a label:
	# "  All of it in C:" is a path, and the RTF side used to tab the
	# rest of it into the value column, which took the drive off the
	# front of the path. Only Windows has this shape.
	#
	# No apostrophes in here: this awk program is inside single quotes,
	# and one closed it.
	/^  [A-Z][A-Za-z ]{0,17}:( |$)/ && length($0) >= 5 && substr($0, index($0, ":") - 2, 1) != " " {
		k = index($0, ":"); print b substr($0, 1, k) o substr($0, k + 1); next }
	# A sub-heading inside a section: indented two, a few words, no
	# colon, and no column gap -- the gap is what tells a heading from
	# a row like "  Application      requests", which must stay plain.
	/^  [A-Z][A-Za-z0-9 ()-]*$/ && pb && length($0) >= 5 && length($0) <= 42 &&
		substr($0, 3) !~ /  / && $0 !~ / $/ { print b $0 o; next }
	                              { print }'
}

# ---------------------------------------------------------------- text formats

# Check the first line: `<kind><TAB><version>`, refuse a higher major.
ti_check_header() { # file kind
	h=$(awk -F'\t' '{ sub(/\r$/, "") } /^#/ || /^[ \t]*$/ { next } { print $1 "\t" $2; exit }' "$1")
	[ "${h%%"$tab"*}" = "$2" ] || ti_fail "$1 is not a $2 file."
	major=${h#*"$tab"}
	major=${major%%.*}
	case $major in '' | *[!0-9]*) ti_fail "$1: bad $2 version line." ;; esac
	[ "$major" -le 1 ] || ti_fail "$1 is $2 version $major; this installer reads version 1. Download a newer installer."
}

# First value(s) of key in a text file (header part only for plans).
ti_get() { # file key
	awk -F'\t' -v k="$2" '{ sub(/\r$/, "") } $0 == "[target]" { exit }
		$1 == k { s = $2; for (i = 3; i <= NF; i++) s = s "\t" $i; print s; exit }' "$1"
}

# The plan header plus the first matching [target], normalised:
# header `url` -> `srcurl`; `file`, and the `url`/`step` lines after it,
# get the file's index as their first value.
ti_select_target() { # plan > selection
	awk -F'\t' -v os="$TI_OS" -v ver="$TI_OSVER" -v arch="$TI_ARCH" '
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

ti_sel() { # key [index] -> every matching line, key (and index) removed
	awk -F'\t' -v k="$1" -v i="$2" '$1 == k && (i == "" || $2 == i) {
		b = (i == "" ? 2 : 3); s = $b
		for (j = b + 1; j <= NF; j++) s = s "\t" $j
		print s }' "$TI_SEL"
}

ti_sel1() { ti_sel "$@" | sed -n 1p; }

# Replace the format.md tokens in $1. Values come in through ENVIRON so
# nothing is re-escaped; unknown `{...}` is left alone.
ti_subst() {
	TI_S=$1 awk 'function rep(s, tok, val,   o, i) {
		o = ""
		while ((i = index(s, tok)) > 0) { o = o substr(s, 1, i - 1) val; s = substr(s, i + length(tok)) }
		return o s }
	BEGIN {
		s = ENVIRON["TI_S"]
		n = split(ENVIRON["TI_DIRMAP"], m, "\n")
		for (k = 1; k <= n; k++) if (split(m[k], kv, "\t") == 2) s = rep(s, "{dir:" kv[1] "}", kv[2])
		s = rep(s, "{app_dir}", ENVIRON["TI_APP_DIR"])
		s = rep(s, "{data_dir}", ENVIRON["TI_DATA_DIR"])
		s = rep(s, "{runtime_dir}", ENVIRON["TI_RUNTIME_DIR"])
		s = rep(s, "{runtime}", ENVIRON["TI_RUNTIME"])
		s = rep(s, "{dir}", ENVIRON["TI_CUR_DIR"])
		s = rep(s, "{file}", ENVIRON["TI_CUR_FILE"])
		s = rep(s, "{tmp}", ENVIRON["TI_TMP"])
		s = rep(s, "{project}", ENVIRON["TI_PROJECT"])
		s = rep(s, "{sep}", "/")
		printf "%s", s }'
}

# ---------------------------------------------------------------- plan signatures

# Why a fetch failed, for messages.
ti_http_why() {
	[ "$ti_http" = 451 ] && printf ' The backend says this installer has been taken down (HTTP 451).'
	return 0
}

# Our own Ed25519 verifier (src/installers/unix/verify): a static binary per CPU,
# carried in the .run after the script (TI_VERIFY_BLOBS: arch, byte
# offset in this file, length; make_run.sh fills it) or in the .app's
# Resources. Prints its path, or nothing if there is none for this CPU.
ti_verifier_path() {
	if [ -n "$TI_BUNDLE" ]; then
		case $TI_ARCH in amd64) v=x86_64 ;; arm64) v=arm64 ;; *) return 0 ;; esac
		[ -f "$TI_BUNDLE/Contents/Resources/tiverify-$v" ] && printf '%s' "$TI_BUNDLE/Contents/Resources/tiverify-$v"
		return 0
	fi
	[ -n "$TI_VERIFY_BLOBS" ] || return 0
	set -- $(printf '%s\n' $TI_VERIFY_BLOBS | awk -F: -v a="$TI_ARCH" '$1 == a { print $2 + 0, $3 + 0; exit }')
	[ $# = 2 ] && [ "$2" -gt 0 ] || return 0
	tail -c +"$(($1 + 1))" "$TI_SELF" 2>/dev/null | head -c "$2" > "$TI_WORK/tiverify" 2>/dev/null
	[ "$(wc -c < "$TI_WORK/tiverify" | tr -d ' ')" = "$2" ] || return 0
	chmod 755 "$TI_WORK/tiverify"
	printf '%s' "$TI_WORK/tiverify"
}

# Can this machine check Ed25519 signatures? First our own verifier, then
# `openssl pkeyutl -rawin` (OpenSSL 1.1.1 or later; LibreSSL, 1.0.x and
# some 1.1.1 builds can't). Either is trusted only after it accepts RFC
# 8032 test vector 2 and rejects it with a changed message. Sets ti_ed_how
# (tiverify or openssl), or ti_ed_why when neither works. Cached.
ti_ed25519_ready() {
	[ -n "$ti_ed_ok" ] && return "$ti_ed_ok"
	ti_ed_ok=1
	case $TI_PLAN_PUBKEY in
	'' | *[!A-Za-z0-9+/=]*) ti_ed_why="this installer was built without a plan signing key"; return 1 ;;
	esac
	t=$TI_WORK/edtest
	mkdir -p "$t"
	tpk=PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=
	tsig=kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==
	printf 'r' > "$t/good"
	printf 's' > "$t/bad"
	ti_tiv=$(ti_verifier_path)
	if [ -n "$ti_tiv" ] && "$ti_tiv" "$tpk" "$tsig" < "$t/good" > /dev/null 2>&1; then
		"$ti_tiv" "$tpk" "$tsig" < "$t/bad" > /dev/null 2>&1
		if [ $? = 1 ]; then
			ti_ed_how=tiverify ti_ed_ok=0
			return 0
		fi
	fi
	ti_ed_why="no built-in verifier for this CPU ($(uname -m))"
	[ -n "$ti_tiv" ] && ti_ed_why="the built-in verifier doesn't run here"
	ti_have openssl || { ti_ed_why="$ti_ed_why, and no openssl"; return 1; }
	printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$tpk" > "$t/pub.pem"
	printf '%s\n' "$tsig" | ti_nohome openssl base64 -d -A > "$t/sig" 2>/dev/null
	if ti_nohome openssl pkeyutl -verify -pubin -inkey "$t/pub.pem" -rawin -in "$t/good" -sigfile "$t/sig" > /dev/null 2>&1 &&
		! ti_nohome openssl pkeyutl -verify -pubin -inkey "$t/pub.pem" -rawin -in "$t/bad" -sigfile "$t/sig" > /dev/null 2>&1; then
		printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$TI_PLAN_PUBKEY" > "$TI_WORK/plan-key.pem"
		ti_ed_how=openssl ti_ed_ok=0
		return 0
	fi
	ti_ed_why="$ti_ed_why, and $(ti_nohome openssl version 2>/dev/null | sed -n 1p) can't check Ed25519 signatures"
	return 1
}

# The signature of plan $1 (format.md "Plan signature"): prints ok, unsigned,
# bad:<why> or cannot:<why> (no way to check it here).
ti_plan_sig() { ti_doc_sig "$1" ti-plan; }

# The same for any document signed with the plan key: $2 is the header its
# signed bytes must start with, so a plan's signature can't be read as a
# revocation list or the other way round (format.md section 7).
ti_doc_sig() { # file kind
	f=$1
	sig_kind=${2:-ti-plan}
	sig_tmp=$TI_WORK/$sig_kind.check
	case $sig_kind in
	ti-revocations) sig_what="revocation list" ;;
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
	ti_ed25519_ready || { echo "cannot:$ti_ed_why"; return 0; }
	head -c "$n" "$f" > "$sig_tmp.signed"
	[ "$(head -c $((${#sig_kind} + 1)) "$sig_tmp.signed")" = "$sig_kind$tab" ] || { echo "bad:the signed bytes are not a $sig_kind"; return 0; }
	if [ "$ti_ed_how" = tiverify ]; then
		"$ti_tiv" "$TI_PLAN_PUBKEY" "$b64" < "$sig_tmp.signed" > /dev/null 2>&1
		case $? in
		0) echo "ok:tiverify" ;;
		1) echo "bad:the signature does not match this $sig_what and this installer's key" ;;
		*) echo "bad:malformed signature" ;;
		esac
		return 0
	fi
	printf '%s\n' "$b64" | ti_nohome openssl base64 -d -A > "$sig_tmp.sig" 2>/dev/null
	[ "$(wc -c < "$sig_tmp.sig" | tr -d ' ')" = 64 ] || { echo "bad:malformed signature"; return 0; }
	if ti_nohome openssl pkeyutl -verify -pubin -inkey "$TI_WORK/plan-key.pem" -rawin -in "$sig_tmp.signed" \
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
ti_check_plan() {
	ti_plan_warn=
	# ok | unsigned | bad | cannot. Separate from ti_plan_warn, which is
	# now only for the findings that deserve the top of the screen:
	# absence of a signature is the normal state of an installer built in
	# a page, and shouting about the normal case is how people learn to
	# ignore shouting (2026-09-23). A signature that does NOT match is a
	# different finding and keeps the warning.
	ti_plan_sigstate=ok
	sig=$(ti_plan_sig "$TI_PLAN")
	ti_log "Plan signature: $sig (key ${TI_PLAN_KEYID:-none})"
	why=${sig#*:}
	case $sig in
	ok:*)
		# The headline in TRUST AND SECURITY names the key; appending it here
		# as well is where it used to get lost, mid-clause after a semicolon.
		TI_PLAN_FROM="$TI_PLAN_FROM"
		return 0
		;;
	esac
	# An absent signature and a wrong one are different findings, and the
	# sentence used to call both "not signed". Absence is an omission;
	# a signature that does not match is evidence the bytes changed after
	# it was made. Telling a reader the first when the second happened is
	# the opposite of the useful thing, and the parenthetical that gave
	# it away was doing all the work.
	case $sig in
	unsigned) ti_sig_verb='carries no signature by the TiddlyInstall key'; ti_plan_sigstate=unsigned ;;
	bad:*)    ti_sig_verb='has a signature that does NOT match the TiddlyInstall key'; ti_plan_sigstate=bad ;;
	cannot:*) ti_sig_verb='has a signature that could not be checked here'; ti_plan_sigstate=cannot ;;
	*)        ti_sig_verb='is not signed by the TiddlyInstall key'; ti_plan_sigstate=bad ;;
	esac
	case $TI_PLAN_KIND in
	embedded)
		# Only a signature that fails to match reaches WARNINGS: that is
		# evidence the bytes changed after somebody signed them. An
		# absent one is said plainly in TRUST AND SECURITY instead --
		# every installer built in a page has no signature, because a
		# page holds no key, and the screen used to meet that with a red
		# block that read like a virus alert about our own output.
		if [ "$ti_plan_sigstate" != unsigned ]; then
			ti_plan_warn="The runtime install script inside this file $ti_sig_verb ($why)."
		fi
		;;
	cmdline)
		[ "$opt_unsigned" = 1 ] || ti_fail "The runtime install script $TI_PLAN $ti_sig_verb ${TI_PLAN_KEYID:-} ($why). Use one saved from <backend>/api/plan/<record>, or add --unsigned-plan if you wrote it yourself."
		ti_plan_warn="The runtime install script $ti_sig_verb ($why); --unsigned-plan was given."
		;;
	*)
		case $sig in
		cannot:*)
			case $TI_PLAN_URL in
			https://*)
				ti_plan_warn="The runtime install script's signature could not be checked ($why); it was accepted because it came over HTTPS from ${TI_PLAN_URL%%/api/*}."
				return 0
				;;
			esac
			ti_fail "The runtime install script came over plain HTTP and its signature can't be checked here: $why. Install OpenSSL 1.1.1 or later, or use an HTTPS backend (--backend=https://...)."
			;;
		esac
		ti_fail "The runtime install script from ${TI_PLAN_URL%%/api/*} $ti_sig_verb ${TI_PLAN_KEYID:-} ($why). It may have been changed on the way; nothing was installed."
		;;
	esac
}

# ---------------------------------------------------------------- stale plans (design.md 7.1)
#
# A signed plan we really did sign, replayed later, is the one thing a
# signature does not stop. Three answers, one per population:
#
#   fetched plan  a nonce, echoed into the signed bytes: a replay carries
#                 someone else's nonce (ti_nonce, ti_check_nonce)
#   carried plan, network      the signed revocation list (ti_revocations)
#   carried plan, no network   `signed` and `maxage` (ti_check_age), and
#                 only when this machine's clock is plausible against the
#                 build time baked into this installer. A wrong clock
#                 warns; it never stops an install.

ti_is_nonce() { # value -> 0 if 32 lowercase hex characters
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
# nothing. TI_NONCE is empty if even that fails; the plan is then asked
# for without one, as an older engine would.
ti_nonce() { # what is being asked for
	TI_NONCE=
	# A fixed nonce, so a test can pre-sign the answer (test_freshness.sh).
	if ti_is_nonce "${TI_TEST_NONCE:-}"; then
		TI_NONCE=$TI_TEST_NONCE
		return 0
	fi
	if [ -r /dev/urandom ]; then
		TI_NONCE=$(dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -v -tx1 2>/dev/null | tr -d ' \t\n' | cut -c1-32)
		ti_is_nonce "$TI_NONCE" || TI_NONCE=
	fi
	if [ -z "$TI_NONCE" ]; then
		TI_NONCE=$(printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y%m%d%H%M%S 2>/dev/null)" "$$" "$TI_SELF" "$1" | ti_sha256 | cut -c1-32)
		ti_is_nonce "$TI_NONCE" || TI_NONCE=
	fi
	[ -n "$TI_NONCE" ] || ti_log "No nonce could be made here; asking for the plan without one."
	return 0
}

# `?nonce=...` for a plan URL, or nothing.
ti_nonce_query() {
	[ -n "$TI_NONCE" ] && printf '?nonce=%s' "$TI_NONCE"
	return 0
}

# The values of the first `request` line of kind $2 in a plan's header
# (format.md section 1: a repeated key, first line wins).
ti_plan_req() { # file kind
	awk -F'\t' -v k="$2" '{ sub(/\r$/, "") } $0 == "[target]" { exit }
		$1 == "request" && $2 == k { s = $3; for (i = 4; i <= NF; i++) s = s "\t" $i; print s; exit }' "$1"
}

# The plan must answer *this* request. A backend that echoes no nonce is
# simply an older backend: the plan is used, and the transparency screen
# says a replayed older plan could not be ruled out.
ti_check_nonce() {
	[ -n "$TI_NONCE" ] || return 0
	case $TI_PLAN_KIND in fetched) ;; *) return 0 ;; esac
	got=$(ti_plan_req "$TI_PLAN" nonce)
	if [ -z "$got" ]; then
		ti_log "Nonce $TI_NONCE sent; the plan carries none (an older backend)."
		TI_PLAN_FROM="$TI_PLAN_FROM; no nonce in the answer (an older backend), so an older plan replayed on the way can't be ruled out"
		return 0
	fi
	[ "$got" = "$TI_NONCE" ] ||
		ti_fail "The install plan from ${TI_PLAN_URL%%/api/*} is the answer to another request (it carries nonce $got, not the $TI_NONCE this installer sent). It may be an older plan replayed on the way; nothing was installed."
	ti_log "Nonce $TI_NONCE echoed in the plan."
	TI_PLAN_FROM="$TI_PLAN_FROM; nonce checked"
	return 0
}

# Seconds since the epoch, or '' when this machine won't say.
ti_epoch_now() {
	n=$(date -u +%s 2>/dev/null)
	case $n in '' | *[!0-9]*) n=$(awk 'BEGIN { print systime() }' 2>/dev/null) ;; esac
	case $n in '' | *[!0-9]*) n= ;; esac
	printf '%s' "$n"
}

# An RFC 3339 UTC time (2026-09-20T11:02:07Z) as seconds since the epoch,
# or '' if it isn't one. Days from the civil date in awk, so no date(1)
# extension is needed: `date -d` is GNU and `date -j` is BSD.
ti_epoch_of() { # time
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
ti_clock_says() {
	c=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
	[ -n "$c" ] || c="(unreadable)"
	printf '%s' "$c"
}

# How old a carried plan may be: the plan's `maxage`, never past the hard
# limit of 365 days, and 90 days when it says nothing.
TI_MAXAGE_DEFAULT=7776000
TI_MAXAGE_LIMIT=31536000
# Ten years: past this from the build time the clock is not believable.
TI_CLOCK_SPAN=315576000

# `signed` / `maxage` on a plan this installer carries (format.md section
# 3). A fetched plan was made this minute, so this is for embedded and
# --plan plans only. Sets ti_age_warn, or stops with a refusal.
ti_check_age() { # backend
	ti_age_warn=
	TI_PLAN_SIGNED=$(ti_get "$TI_PLAN" signed)
	TI_PLAN_MAXAGE=$(ti_get "$TI_PLAN" maxage)
	case $TI_PLAN_KIND in fetched) return 0 ;; esac
	[ -n "$TI_PLAN_SIGNED" ] || return 0
	sec=$(ti_epoch_of "$TI_PLAN_SIGNED")
	[ -n "$sec" ] || { ti_log "Plan signed \"$TI_PLAN_SIGNED\": not a time this engine reads; age not checked."; return 0; }
	max=$TI_PLAN_MAXAGE
	case $max in '' | *[!0-9]*) max=$TI_MAXAGE_DEFAULT ;; esac
	[ "$max" -gt "$TI_MAXAGE_LIMIT" ] && max=$TI_MAXAGE_LIMIT
	[ "$max" -lt 1 ] && max=1
	bt=$TI_BUILD_EPOCH
	case $bt in '' | *[!0-9]*) bt=0 ;; esac
	now=$(ti_epoch_now)
	# The real time is certainly not before this installer was built, and
	# ten years after it is as far as a plausible clock goes. That floor
	# owes nothing to the machine's battery-backed clock.
	plausible=0
	if [ -n "$now" ] && [ "$bt" -gt 0 ] && [ "$now" -ge "$bt" ] && [ "$now" -le $((bt + TI_CLOCK_SPAN)) ]; then
		plausible=1
		[ "$now" -lt "$sec" ] && plausible=0   # a plan from the future: don't believe the clock
	fi
	if [ "$plausible" != 1 ]; then
		ti_age_warn="This installer's runtime install script was signed on $TI_PLAN_SIGNED, and this machine's clock says $(ti_clock_says), which can't be right (this installer was built $TI_BUILD_TIME), so how old the plan is can't be told. Nothing is refused for age."
		ti_log "Clock not plausible (now ${now:-unreadable}, built $bt); the plan's age is reported only."
		return 0
	fi
	age=$((now - sec))
	ti_log "Plan signed $TI_PLAN_SIGNED, $((age / 86400)) days ago; maxage $max s."
	[ "$age" -le "$max" ] && return 0
	where=$1
	[ -n "$where" ] || where=$TI_DEFAULT_BACKEND
	if [ "$age" -gt "$TI_MAXAGE_LIMIT" ]; then
		ti_fail "This installer's runtime install script was signed on $TI_PLAN_SIGNED, $((age / 86400)) days ago, past the $((TI_MAXAGE_LIMIT / 86400))-day limit. What it installs may since have been withdrawn or found unsafe. Get a current installer from $where and run that instead; nothing was installed."
	fi
	ti_age_warn="This installer's runtime install script was signed on $TI_PLAN_SIGNED, $((age / 86400)) days ago (it is meant to be used within $((max / 86400)) days). What it installs may have moved on. A current installer is at $where."
	return 0
}

# ---- the signed runtime install script (docs/format.md, rtscript)

# Base64 decode with nothing but awk. openssl is exactly what this engine
# cannot assume -- tiverify exists because the machines without it are
# the ones we care about -- and `base64` is -d on GNU and -D on BSD.
ti_b64d() {
	awk '
	BEGIN {
		AB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
		for (i = 1; i <= 64; i++) V[substr(AB, i, 1)] = i - 1
		for (i = 0; i < 256; i++) C[i] = sprintf("%c", i)
	}
	{ s = s $0 }
	END {
		gsub(/[^A-Za-z0-9+\/=]/, "", s)
		n = length(s); out = ""
		for (i = 1; i <= n; i += 4) {
			c1 = substr(s, i, 1); c2 = substr(s, i+1, 1)
			c3 = substr(s, i+2, 1); c4 = substr(s, i+3, 1)
			x = V[c1] * 262144 + V[c2] * 4096 + (c3 == "=" ? 0 : V[c3]) * 64 + (c4 == "=" ? 0 : V[c4])
			out = out C[int(x / 65536)]
			if (c3 != "=") out = out C[int((x % 65536) / 256)]
			if (c4 != "=") out = out C[x % 256]
			if (length(out) > 4000) { printf "%s", out; out = "" }
		}
		printf "%s", out
	}'
}

# The Nth [target] block of the plan as it was written, minus the lines
# that are not part of what was signed (src/shared/rtscript.js
# NOT_SIGNED). This is the text whose SHA-256 is a leaf of the tree, so
# it has to match what the resolver hashed to the byte.
ti_target_canon() { # n
	awk -v want="$1" -F'\t' '
		$0 == "[target]" { n++; next }
		n == want {
			if ($0 == "") next
			k = $1
			if (k == "launch" || k == "rtproof" || k == "rtroots" || k == "rtsig" || k == "sig") next
			print
		}' "$TI_PLAN"
}

ti_target_proof() { # n -> one step per line
	awk -v want="$1" -F'\t' '
		$0 == "[target]" { n++; next }
		n == want && $1 == "rtproof" {
			for (i = 2; i <= NF; i++) if ($i != "-") print $i
			exit
		}' "$TI_PLAN"
}

# Walk a proof from a leaf to the root it reaches. Two forks a step: the
# side and the sibling come off the string with parameter expansion, not
# cut. On a 2003 machine every fork is worth removing.
ti_merkle_walk() { # leaf < steps
	h=$1
	while IFS= read -r step; do
		[ -n "$step" ] || continue
		sib=${step#?}
		side=${step%"$sib"}
		case $sib in *[!0-9a-f]* | "") printf ''; return 0 ;; esac
		[ ${#sib} -eq 64 ] || { printf ''; return 0; }
		if [ "$side" = R ]; then pair=$h$sib; else pair=$sib$h; fi
		h=$(printf 'ti-node\n%s' "$pair" | ti_sha256)
	done
	printf '%s' "$h"
}

# Is the runtime install script in this plan one we published?
#
# The whole point: this can be answered with no network and no
# catalogue. The plan carries the signed roots document and a proof;
# this engine already carries the public key. An installer built in
# somebody's browser, with no key of its own and no server to ask, still
# gets to show that the downloads and the commands came from us.
#
# Sets ti_rt_state (ok | none | bad | nokey), ti_rt_issued and
# ti_rt_why. It never fails the install: what it changes is what the
# screen is allowed to claim.
ti_check_rtscript() { # target-index
	ti_rt_state=none ti_rt_issued= ti_rt_why=
	[ -n "$TI_PLAN" ] || return 0
	b64=$(ti_get "$TI_PLAN" rtroots)
	[ -n "$b64" ] || { ti_rt_why='this plan carries no runtime-script roots'; return 0; }
	f=$TI_WORK/rtroots.txt
	printf '%s' "$b64" | ti_b64d > "$f" 2>/dev/null || true
	[ -s "$f" ] || { ti_rt_state=bad; ti_rt_why='the roots document could not be decoded'; return 0; }
	sig=$(ti_doc_sig "$f" ti-rtscripts)
	case $sig in
	ok:*) ;;
	cannot:*) ti_rt_state=nokey; ti_rt_why="the roots document could not be checked here (${sig#*:})"; return 0 ;;
	*) ti_rt_state=bad; ti_rt_why="the roots document ${sig%%:*} (${sig#*:})"; return 0 ;;
	esac
	ti_rt_issued=$(ti_get "$f" issued)
	rtname=$(ti_get "$TI_PLAN" runtime)
	want=$(awk -F'\t' -v rt="$rtname" '$1 == "root" && $2 == rt { print $3; exit }' "$f")
	case $want in '' | *[!0-9a-f]*) ti_rt_state=none; ti_rt_why="the roots document names no root for $rtname"; return 0 ;; esac
	leaf=$(ti_target_canon "$1" | ti_sha256)
	got=$(ti_target_proof "$1" | ti_merkle_walk "$leaf")
	if [ "$got" = "$want" ]; then
		ti_rt_state=ok
	else
		ti_rt_state=bad
		ti_rt_why='the proof in this plan does not lead to the signed root'
	fi
	return 0
}

# ---- the signed revocation list (format.md section 7)

# Where the last good list is kept, so an installer that can't reach a
# backend still has the newest one this machine has seen.
ti_revoke_cache() {
	d=
	if [ "$TI_OS" = macos ] && [ -n "$HOME" ]; then
		d=$HOME/Library/Caches/TiddlyInstall
	elif [ -n "${XDG_CACHE_HOME:-}" ]; then
		d=$XDG_CACHE_HOME/tiddlyinstall
	elif [ -n "$HOME" ]; then
		d=$HOME/.cache/tiddlyinstall
	fi
	[ -n "$d" ] && printf '%s/revocations.txt' "$d"
	return 0
}

ti_revoke_serial() { # file
	s=$(ti_get "$1" serial)
	case $s in '' | *[!0-9]*) s=0 ;; esac
	printf '%s' "$s"
}

# The keys this install matches, one per line, as `revoke` line values.
ti_revoke_keys() {
	[ -n "$TI_RECHASH" ] && printf 'record\t%s\n' "$TI_RECHASH"
	[ -n "$TI_PLAN_REQUEST" ] && printf '%s\n' "$TI_PLAN_REQUEST"
	if [ -n "$TI_REC" ]; then
		src=$(ti_get "$TI_REC" source)
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
	# they come from. In the selection (ti_select_target) a `source` line
	# is `name sha size format strip` and a `file` line carries its index
	# first: `n name filename sha size [arch]`.
	awk -F'\t' '$1 == "source" { print $3 } $1 == "file" { print $5 } $1 == "nfile" { print $4 }' "$TI_SEL" |
		while IFS= read -r h; do
			case $h in '' | *[!0-9a-f]*) continue ;; esac
			printf 'sha\t%s\nfile\t%s\n' "$h" "$h"
		done
	return 0
}

# The first entry in list $1 that this install matches, as text, or ''.
ti_revoke_match() { # list keysfile
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
ti_revocations() { # backend
	ti_revoke_note=
	case $TI_PLAN_KIND in fetched) return 0 ;; esac
	[ "$TI_MODE_A" = 1 ] && return 0
	# Built with no server: it carries the plan the page worked out, from
	# the list that page carried, and asks nobody. Said rather than done
	# quietly, because what it costs is real -- a file withdrawn after
	# this installer was made cannot reach it.
	if [ -z "$ti_backend_given" ]; then
		ti_revoke_note='this installer was built without a server, so no revocation list was fetched: what it installs was checked against the list the builder had, and anything withdrawn since is not known here'
		return 0
	fi
	url=$1/api/revocations
	f=$TI_WORK/revocations.txt
	got=
	ti_say "Checking the revocation list"
	if ti_download_quick "$url" "$f" && [ -s "$f" ]; then
		sig=$(ti_doc_sig "$f" ti-revocations)
		case $sig in
		ok:*) got=$f ;;
		*) ti_log "Revocation list from $url: $sig" ;;
		esac
	else
		ti_log "Could not fetch $url.$(ti_http_why)"
	fi
	cache=$(ti_revoke_cache)
	# The freshest list wins, and a list is honoured even when `expires`
	# has passed: it can only ever deny an install, so trusting a stale
	# one is the recoverable mistake (design.md 7.1).
	if [ -n "$cache" ] && [ -f "$cache" ]; then
		if [ -z "$got" ]; then
			got=$cache
			ti_revoke_note="the backend could not be reached; the last list this machine saw (issued $(ti_get "$cache" issued)) was used"
		elif [ "$(ti_revoke_serial "$cache")" -gt "$(ti_revoke_serial "$got")" ]; then
			got=$cache
			ti_log "The cached revocation list is newer than the one fetched; using it."
		fi
	fi
	if [ -z "$got" ]; then
		ti_revoke_note="no revocation list could be fetched or found on this machine, so only the script's own age was checked"
		return 0
	fi
	if [ "$got" != "$cache" ] && [ -n "$cache" ]; then
		if mkdir -p "$(dirname "$cache")" 2>/dev/null; then
			if [ ! -f "$cache" ] || [ "$(ti_revoke_serial "$got")" -ge "$(ti_revoke_serial "$cache")" ]; then
				cp "$got" "$cache.tmp.$$" 2>/dev/null && mv "$cache.tmp.$$" "$cache" 2>/dev/null
				rm -f "$cache.tmp.$$" 2>/dev/null
			fi
		fi
	fi
	ti_revoke_keys > "$TI_WORK/revoke-keys"
	hit=$(ti_revoke_match "$got" "$TI_WORK/revoke-keys")
	if [ -n "$hit" ]; then
		ti_fail "$(printf 'This install has been withdrawn: the revocation list at %s names %s. Nothing was installed.' "$1" "$(printf '%s' "$hit" | tr '\t' ' ')")"
	fi
	[ -z "$ti_revoke_note" ] && ti_revoke_note="checked against the list issued $(ti_get "$got" issued) (serial $(ti_revoke_serial "$got"))"
	ti_log "Revocation list: $ti_revoke_note"
	return 0
}

# Mode A on macOS: an app bundle signed with an identity (not ad-hoc)
# whose signature verifies and that carries no settings of its own. It
# installs only what its name names, from the built-in backend (design.md
# 3 and 7): its signature must not vouch for anyone's --record or --plan.
# Linux .run files carry no signature, so there is nothing to protect.
# TI_TEST_MODE_A=1 turns the restriction on anywhere (tests).
ti_detect_mode_a() {
	TI_MODE_A=0
	[ "${TI_TEST_MODE_A:-}" = 1 ] && { TI_MODE_A=1; return 0; }
	[ -n "$TI_BUNDLE" ] && ti_have codesign || return 0
	d=$TI_BUNDLE/Contents/Resources/ti
	[ -e "$d/record.txt" ] || [ -e "$d/plan.txt" ] && return 0
	case $(codesign -dvv "$TI_BUNDLE" 2>&1) in *Authority=*) ;; *) return 0 ;; esac
	codesign --verify "$TI_BUNDLE" > /dev/null 2>&1 && TI_MODE_A=1
	return 0
}

# ---------------------------------------------------------------- finding the metadata

# Fill TI_REC / TI_PLAN (files, either may be empty), TI_PACK_TAR or
# TI_PACK_DIR, TI_ORIGIN, TI_ENGINE_LEN.
ti_find_metadata() {
	TI_ENGINE_LEN=$(wc -c < "$TI_SELF" | tr -d ' ')
	# The appended block (Linux .run) or the .app's Resources/ti (macOS).
	if [ -n "$TI_BUNDLE" ]; then
		d=$TI_BUNDLE/Contents/Resources/ti
		[ -f "$d/record.txt" ] && ti_block_rec=$d/record.txt
		[ -f "$d/plan.txt" ] && ti_block_plan=$d/plan.txt
		[ -d "$d/pack" ] && TI_PACK_DIR=$d/pack
		[ -f "$d/pack.tar" ] && TI_PACK_TAR=$d/pack.tar
		ti_block_where="files in $(basename "$TI_BUNDLE")/Contents/Resources/ti"
	else
		foot=$(tail -c 64 "$TI_SELF" 2>/dev/null)
		case $foot in
		"TIMETA1 "*)
			IFS=' '
			set -- $foot
			IFS=$ifs0
			lens=$(printf '%s %s %s\n' "$2" "$3" "$4" | awk '{ printf "%d %d %d", $1, $2, $3 }')
			set -- $lens
			r=$1 p=$2 k=$3
			total=$TI_ENGINE_LEN
			TI_ENGINE_LEN=$((total - 64 - r - p - k))
			[ "$TI_ENGINE_LEN" -gt 0 ] || ti_fail "The metadata block at the end of this installer is damaged."
			off=$((TI_ENGINE_LEN + 1))
			if [ "$r" -gt 0 ]; then
				tail -c +"$off" "$TI_SELF" | head -c "$r" > "$TI_WORK/block-record.txt"
				ti_block_rec=$TI_WORK/block-record.txt
			fi
			off=$((off + r))
			if [ "$p" -gt 0 ]; then
				tail -c +"$off" "$TI_SELF" | head -c "$p" > "$TI_WORK/block-plan.txt"
				ti_block_plan=$TI_WORK/block-plan.txt
			fi
			off=$((off + p))
			if [ "$k" -gt 0 ]; then
				tail -c +"$off" "$TI_SELF" | head -c "$k" > "$TI_WORK/pack.tar"
				TI_PACK_TAR=$TI_WORK/pack.tar
			fi
			ti_block_where="the block appended to $(basename "$TI_SELF")"
			;;
		esac
	fi
	if [ -n "$TI_PACK_TAR" ]; then
		tar -tf "$TI_PACK_TAR" > "$TI_WORK/pack.list" 2>/dev/null || ti_fail "The packed files in this installer are damaged."
	fi

	ti_detect_mode_a
	if [ "$TI_MODE_A" = 1 ]; then
		given=
		[ -n "$opt_record" ] && given="$given --record"
		[ -n "$opt_plan" ] && given="$given --plan"
		[ "$opt_unsigned" = 1 ] && given="$given --unsigned-plan"
		[ -n "$opt_backend" ] && given="$given --backend"
		# "Our signature" is an assumption this code cannot check: on a
		# .run mode A is only ever reached through TI_TEST_MODE_A, where
		# there is no signature at all, and on macOS the signature is
		# whichever Authority verified. Say what is true of every mode A
		# copy -- it is signed and carries no settings -- and leave
		# naming the signer to the review screen, which reads it.
		[ -n "$given" ] && ti_fail "This installer program is signed and carries no settings of its own, so this copy installs only the app its own file name names, from $TI_DEFAULT_BACKEND. It doesn't accept$given. For your own settings use a base nobody has signed, or one you sign yourself (modes B and C)."
		ti_log "A signed installer program with no settings inside: mode A (its file name and the built-in backend only)"
	fi
	# 1. Command-line options.
	if [ -n "$opt_record$opt_plan" ]; then
		TI_REC=$opt_record TI_PLAN=$opt_plan TI_PLAN_KIND=cmdline
		TI_ORIGIN=${opt_origin:-command-line options}
		return 0
	fi
	# 2. The embedded block.
	if [ -n "$ti_block_rec$ti_block_plan" ]; then
		TI_REC=$ti_block_rec TI_PLAN=$ti_block_plan TI_PLAN_KIND=embedded
		TI_ORIGIN=$ti_block_where
		return 0
	fi
	# 3. install.txt next to the installer (a record, or a plan: a plan
	# there is treated like --plan). Not in mode A.
	if [ -f "$TI_HOME_DIR/install.txt" ] && [ "$TI_MODE_A" = 1 ]; then
		ti_log "Ignoring $TI_HOME_DIR/install.txt: an installer we signed takes its settings only from its file name."
	elif [ -f "$TI_HOME_DIR/install.txt" ]; then
		case $(sed -n 1p "$TI_HOME_DIR/install.txt") in
		ti-plan*) TI_PLAN=$TI_HOME_DIR/install.txt TI_PLAN_KIND=cmdline ;;
		*) TI_REC=$TI_HOME_DIR/install.txt ;;
		esac
		TI_ORIGIN="install.txt next to the installer"
		return 0
	fi
	# 4. A record hash as the last `_` token of the file name (mode A).
	nm=$TI_NAME
	nm=$(printf '%s' "$nm" | sed -e 's/ - Copy$//' -e 's/ *([0-9]*)$//')
	last=${nm##*_}
	last=$(printf '%s' "$last" | tr 'A-Z' 'a-z')
	case $last in
	*[!a-z2-7]*) ;;
	??????????????????????????)
		# Installed already? Checked before the record is fetched.
		ti_installed_offline "$last"
		backend=${opt_backend:-$TI_DEFAULT_BACKEND}
		TI_REC=$TI_WORK/record.txt
		ti_download "$backend/api/records/$last" "$TI_REC" ||
			ti_fail "Could not fetch this installer's settings from $backend/api/records/$last.$(ti_http_why)"
		got=$(ti_b32 "$(ti_sha256 "$TI_REC")" 26)
		[ "$got" = "$last" ] ||
			ti_fail "The settings fetched from $backend do not match this installer's name (hash $got, expected $last). Not installing."
		TI_ORIGIN="record $last named in the file name, fetched from $backend and checked against its SHA-256"
		return 0
		;;
	esac
	# 5. Plain tokens: install_<runtime>_<package>.
	case $nm in
	install_*_*)
		rt=${nm#install_}
		pk=${rt#*_}
		rt=${rt%%_*}
		case $rt$pk in *[!A-Za-z0-9_.-]*) ti_fail "Unusable installer name: $TI_NAME" ;; esac
		backend=${opt_backend:-$TI_DEFAULT_BACKEND}
		TI_PLAN=$TI_WORK/plan.txt TI_PLAN_KIND=fetched TI_PLAN_URL=$backend/api/plan/name/$rt/$pk
		TI_PLAN_REQUEST="name$tab$rt$tab$pk"
		ti_nonce "$rt/$pk"
		ti_download "$TI_PLAN_URL$(ti_nonce_query)" "$TI_PLAN" ||
			ti_fail "This installer is named for $pk ($rt) but $backend has no plan for that name.$(ti_http_why)"
		TI_ORIGIN="the file name (runtime $rt, package $pk); plan from $backend"
		return 0
		;;
	esac
	ti_fail "This installer carries no settings: no metadata block, no install.txt, and no record hash in its name ($TI_NAME)."
}

# ---------------------------------------------------------------- install helpers

# mkdir -p, remembering each folder it made (for rollback and the manifest).
ti_mkdirs() {
	[ -d "$1" ] && return 0
	ti_mk_missing=
	p=$1
	while [ ! -d "$p" ]; do
		ti_mk_missing="$p$nl$ti_mk_missing"
		p=$(dirname "$p")
	done
	mkdir -p "$1" || return 1
	printf '%s' "$ti_mk_missing" | while IFS= read -r p; do
		[ -n "$p" ] && printf 'e\t%s\n' "$p" >> "$TI_CREATED"
	done
	return 0
}

ti_created() { printf '%s\t%s\n' "$1" "$2" >> "$TI_CREATED"; }

# On failure: remove what this run made, newest first.
ti_rollback() {
	ti_log "Removing what was installed so far"
	awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' "$TI_CREATED" > "$TI_CREATED.rev"
	while IFS="$tab" read -r kind p; do
		case $kind in
		r) rm -rf "$p" && ti_log "  removed $p" ;;
		e) rmdir "$p" 2>/dev/null && ti_log "  removed $p" ;;
		esac
	done < "$TI_CREATED.rev"
	rm -f "$TI_CREATED" "$TI_CREATED.rev"
	TI_CREATED=
}

# Is $1 inside one of the app's own folders (or {tmp})?
ti_inside() {
	case $1 in */../* | */.. | ../*) return 1 ;; esac
	case $1 in
	"$TI_APP_DIR" | "$TI_APP_DIR"/* | "$TI_TMP" | "$TI_TMP"/*) return 0 ;;
	esac
	printf '%s' "$TI_DIRMAP" | while IFS="$tab" read -r n d; do
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
ti_obtain() { # sha256 out urls-file label [unpinned]
	if [ -z "$1" ] || [ "$1" = - ]; then
		[ "${5:-}" = unpinned ] || { ti_log "refusing a file with no SHA-256"; return 1; }
		ti_obtain_unpinned "$2" "$3" "$4"
		return $?
	fi
	if [ -n "$TI_PACK_DIR" ] && [ -f "$TI_PACK_DIR/$1" ]; then
		cp "$TI_PACK_DIR/$1" "$2"
		ti_log "  from the pack"
	elif [ -n "$TI_PACK_TAR" ] && grep -qx "$1" "$TI_WORK/pack.list"; then
		(cd "$(dirname "$2")" && tar -xf "$TI_PACK_TAR" "$1" && mv "$1" "$(basename "$2")")
		ti_log "  from the pack"
	fi
	if [ -f "$2" ]; then
		[ "$(ti_sha256 "$2")" = "$1" ] && return 0
		ti_say "  the packed copy of $4 has the wrong SHA-256; trying downloads"
		rm -f "$2"
	fi
	while IFS= read -r u <&4; do
		[ -n "$u" ] || continue
		ti_say "  downloading $u"
		if ti_download "$u" "$2.part"; then
			got=$(ti_sha256 "$2.part")
			if [ "$got" = "$1" ]; then
				mv "$2.part" "$2"
				return 0
			fi
			ti_say "  wrong SHA-256 from $u ($got); trying the next source"
		else
			ti_say "  download failed: $u"
		fi
		rm -f "$2.part"
	done 4< "$3"
	return 1
}

ti_move_into() { # entry dest: move, merging folders that already exist
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
ti_ex_split() { # "a|b|c"
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
ti_ex_match() { # path
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
ti_tar_exclude_ok() {
	if [ -z "$ti_tar_ex" ]; then
		ti_tar_ex=no
		rm -rf "$TI_WORK/exprobe"
		if mkdir -p "$TI_WORK/exprobe" 2> /dev/null && : > "$TI_WORK/exprobe/keep"; then
			if (cd "$TI_WORK/exprobe" && tar --exclude=drop -cf probe.tar keep) > /dev/null 2>&1; then
				ti_tar_ex=yes
			fi
		fi
		rm -rf "$TI_WORK/exprobe"
		ti_log "tar --exclude: $ti_tar_ex"
	fi
	[ "$ti_tar_ex" = yes ]
}

# The unpacker's own exclude switches, one per line, in $u_args. The
# caller turns them into arguments with IFS=$nl and `set -- $u_args`,
# which is safe because the engine runs with `set -f` (no globbing) and a
# plan line can hold no newline. Patterns naming a folder are given twice
# (`p` and `p/*`): GNU tar and bsdtar drop a matched folder's contents
# themselves, busybox tar and unzip do not.
ti_ex_args() { # style (tar|unzip|7z)
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
ti_ex_prune() { # dir relprefix
	# Globbing goes on only long enough to list the folder: the list is
	# expanded once, before the body runs, so turning it off again in the
	# body is safe and keeps ti_ex_match's patterns literal.
	set +f
	for u_e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
		set -f
		[ -e "$u_e" ] || [ -h "$u_e" ] || continue
		u_rel=$2${u_e##*/}
		if ti_ex_match "$u_rel"; then
			ti_log "  leaving out $u_rel"
			rm -rf "$u_e"
		elif [ -d "$u_e" ] && [ ! -h "$u_e" ]; then
			ti_ex_prune "$u_e" "$u_rel/"
		fi
	done
	set -f
}

ti_unpack() { # format archive dest strip exclude
	u_fmt=$1
	u_arc=$2
	u_dst=$3
	u_str=${4:-0}
	ti_ex_split "${5:-}"
	ti_mkdirs "$u_dst" || return 1
	st=$u_dst/.ti-unpack.$$
	rm -rf "$st"
	mkdir "$st" || return 1
	to=
	[ "$(id -u)" = 0 ] && to=o
	rc=0
	# What the unpacker itself can be told to leave out. Whatever it
	# still writes, ti_ex_prune deletes below.
	u_args=
	case $u_fmt in
	tar | tar.gz | tgz | tar.bz2 | tbz2 | tar.xz | txz)
		if [ -n "$u_exl" ] && ti_tar_exclude_ok; then ti_ex_args tar; fi
		;;
	zip) ti_ex_args unzip ;;
	7z) ti_ex_args 7z ;;
	esac
	u_ifs=$IFS
	IFS=$nl
	set -- $u_args
	IFS=$u_ifs
	case $u_fmt in
	tar) (cd "$st" && tar -x${to}f "$u_arc" "$@") >> "$TI_LOG" 2>&1 || rc=1 ;;
	tar.gz | tgz)
		rm -f "$TI_WORK/pipe.err"
		{ gzip -dc "$u_arc" || : > "$TI_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$TI_LOG" 2>&1 || rc=1
		[ -f "$TI_WORK/pipe.err" ] && rc=1
		;;
	tar.bz2 | tbz2)
		if ti_have bzip2; then
			rm -f "$TI_WORK/pipe.err"
			{ bzip2 -dc "$u_arc" || : > "$TI_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$TI_LOG" 2>&1 || rc=1
			[ -f "$TI_WORK/pipe.err" ] && rc=1
		else
			(cd "$st" && tar -xj${to}f "$u_arc" "$@") >> "$TI_LOG" 2>&1 || rc=1
		fi
		;;
	tar.xz | txz)
		if ti_have xz; then
			rm -f "$TI_WORK/pipe.err"
			{ xz -dc "$u_arc" || : > "$TI_WORK/pipe.err"; } | (cd "$st" && tar -x${to}f - "$@") >> "$TI_LOG" 2>&1 || rc=1
			[ -f "$TI_WORK/pipe.err" ] && rc=1
		else
			# macOS has no xz, but its tar (libarchive) reads .xz itself.
			(cd "$st" && tar -xJ${to}f "$u_arc" "$@") >> "$TI_LOG" 2>&1 || rc=1
		fi
		;;
	zip)
		if ti_have unzip; then
			if [ $# -gt 0 ]; then
				unzip -q -o "$u_arc" -d "$st" -x "$@" >> "$TI_LOG" 2>&1 || rc=1
			else
				unzip -q -o "$u_arc" -d "$st" >> "$TI_LOG" 2>&1 || rc=1
			fi
		elif ti_have ditto; then
			ditto -x -k "$u_arc" "$st" >> "$TI_LOG" 2>&1 || rc=1
		else
			ti_log "no unzip on this machine"
			rc=1
		fi
		;;
	7z)
		z=
		for c in 7zz 7z 7za 7zr; do ti_have $c && z=$c && break; done
		if [ -z "$z" ]; then
			ti_log "This machine has no 7-Zip (7z, 7za, 7zz), which this .7z file needs."
			rc=1
		else
			(cd "$st" && $z x -y "$@" "$u_arc") >> "$TI_LOG" 2>&1 || rc=1
		fi
		;;
	*)
		ti_log "unknown archive format: $u_fmt"
		rc=1
		;;
	esac
	# Whatever the unpacker still wrote, and every format it could not be
	# told about (ditto, an old tar), is dropped here before the move.
	if [ $rc = 0 ] && [ -n "$u_exl" ]; then
		ti_ex_prune "$st" ""
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
			ti_move_into "$e" "$3" || rc=1
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
ti_obtain_unpinned() { # out urls-file label
	while IFS= read -r u <&4; do
		[ -n "$u" ] || continue
		case $u in
		https://*) ;;
		*)
			ti_say "  skipping $u: a source with no SHA-256 must come over HTTPS"
			continue
			;;
		esac
		ti_say "  downloading $u (no stored SHA-256; identified by its commit over HTTPS)"
		if ti_download "$u" "$1.part"; then
			mv "$1.part" "$1"
			return 0
		fi
		ti_say "  download failed: $u"
		rm -f "$1.part"
	done 4< "$2"
	return 1
}

ti_step() { # type fields...
	s_type=$1
	shift
	case $s_type in
	unpack)
		d=$(ti_subst "$2")
		ti_inside "$d" || ti_fail "Step unpack: $d is outside the app's folders."
		if [ -n "${4:-}" ]; then
			ti_say "  unpack $1 into $d (leaving out $4)"
		else
			ti_say "  unpack $1 into $d"
		fi
		if [ "$1" = 7z ] && ! ti_have 7zz && ! ti_have 7z && ! ti_have 7za && ! ti_have 7zr; then
			ti_fail "$(basename "$TI_CUR_FILE") is a .7z archive, and this machine has no 7-Zip (7z, 7za or 7zz) to unpack it."
		fi
		ti_unpack "$1" "$TI_CUR_FILE" "$d" "${3:-0}" "${4:-}" || ti_fail "Could not unpack $(basename "$TI_CUR_FILE") ($1)."
		;;
	run)
		c=$(ti_subst "$1")
		ti_say "  run: $c"
		(cd "$TI_CUR_DIR" && sh -c "$c") < /dev/null >> "$TI_LOG" 2>&1 || ti_fail "Step failed: $c"
		;;
	mkdir)
		d=$(ti_subst "$1")
		ti_inside "$d" || ti_fail "Step mkdir: $d is outside the app's folders."
		mkdir -p "$d" || ti_fail "Could not create $d"
		;;
	write)
		d=$(ti_subst "$1")
		ti_inside "$d" || ti_fail "Step write: $d is outside the app's folders."
		printf '%s\n' "$(ti_subst "$2")" >> "$d" || ti_fail "Could not write $d"
		;;
	delete)
		d=$(ti_subst "$1")
		ti_inside "$d" || ti_fail "Step delete: $d is outside the app's folders."
		case $d in "$TI_APP_DIR" | "$TI_TMP") ti_fail "Step delete: refusing to delete $d" ;; esac
		rm -rf "$d"
		;;
	*) ti_fail "Unknown step '$s_type' in the runtime install script. Download the installer again." ;;
	esac
}

# Environment for `install` (and, written to launch.txt, for the app).
ti_apply_env() { # with_install_extras(0/1)
	for k in env ienv; do
		[ "$k" = ienv ] && [ "$1" != 1 ] && continue
		ti_sel $k > "$TI_WORK/env.tmp"
		while IFS="$tab" read -r n v; do
			case $n in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
			export "$n=$(ti_subst "$v")"
		done < "$TI_WORK/env.tmp"
	done
	for k in unset iunset; do
		[ "$k" = iunset ] && [ "$1" != 1 ] && continue
		for n in $(ti_sel $k); do
			case $n in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
			unset "$n"
		done
	done
	pre=
	ti_sel path > "$TI_WORK/path.tmp"
	while IFS= read -r p; do
		[ -n "$p" ] && pre=${pre:+$pre:}$(ti_subst "$p")
	done < "$TI_WORK/path.tmp"
	[ -n "$pre" ] && PATH=$pre:$PATH && export PATH
	return 0
}

# ---------------------------------------------------------------- prerequisites

# System-wide prerequisites (format.md "Prerequisites"): `need` entries in
# the chosen block. Their checks only look (ldconfig's cache, the
# library folders, PATH, a file), so they run before the transparency
# screen; anything is installed only after the user agreed.

# Is shared library $1 (a soname) available for this machine's arch?
ti_have_lib() {
	lc=
	for c in ldconfig /sbin/ldconfig /usr/sbin/ldconfig; do
		if command -v "$c" > /dev/null 2>&1; then lc=$c; break; fi
	done
	if [ -n "$lc" ] && "$lc" -p > "$TI_WORK/ldcache" 2> /dev/null && [ -s "$TI_WORK/ldcache" ]; then
		awk -v so="$1" -v arch="$TI_ARCH" '
			$1 == so {
				ok = 1
				if (arch == "amd64" && $0 !~ /x86-64/) ok = 0
				if (arch == "arm64" && $0 !~ /AArch64/) ok = 0
				if (arch == "x86" && ($0 ~ /x86-64/ || $0 ~ /AArch64/)) ok = 0
				if (ok) { found = 1; exit }
			}
			END { exit !found }' "$TI_WORK/ldcache"
		return $?
	fi
	# No ldconfig cache (musl): the usual library folders.
	case $TI_ARCH in
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
ti_need_present() {
	ti_sel ncheck "$1" > "$TI_WORK/checks.$1"
	while IFS="$tab" read -r k a b; do
		case $k in
		lib) [ "$TI_OS" = linux ] && ti_have_lib "$a" && return 0 ;;
		cmd) command -v "$a" > /dev/null 2>&1 && return 0 ;;
		file) [ -e "$a" ] && return 0 ;;
		esac
	done < "$TI_WORK/checks.$1"
	return 1
}

# The distribution's package manager, first found.
ti_pkg_mgr() {
	for m in apt-get dnf yum zypper apk pacman; do
		for d in '' /usr/bin/ /bin/ /usr/sbin/ /sbin/; do
			if [ -z "$d" ]; then command -v $m > /dev/null 2>&1 && { echo $m; return 0; }
			elif [ -x "$d$m" ]; then echo $m; return 0; fi
		done
	done
	return 1
}

# Commands installing packages $2 with manager $1: what the engine runs as
# root (TI_PKG_RUN), and what the user is told to run (TI_PKG_SAY).
ti_pkg_cmds() {
	case $1 in
	apt-get)
		TI_PKG_RUN="DEBIAN_FRONTEND=noninteractive apt-get install -y $2 || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y $2; }"
		TI_PKG_SAY="sudo apt-get update && sudo apt-get install -y $2"
		;;
	dnf | yum) TI_PKG_RUN="$1 install -y $2" TI_PKG_SAY="sudo $1 install -y $2" ;;
	zypper) TI_PKG_RUN="zypper --non-interactive install $2" TI_PKG_SAY="sudo zypper install $2" ;;
	apk) TI_PKG_RUN="apk add $2" TI_PKG_SAY="sudo apk add $2" ;;
	pacman) TI_PKG_RUN="pacman -S --noconfirm --needed $2" TI_PKG_SAY="sudo pacman -S --needed $2" ;;
	esac
}

# Run command $1 as root. Returns its exit code, or 99 when there is no
# way to become root without asking and asking isn't allowed (--yes), or
# nothing can ask (no terminal, no desktop).
ti_as_root() {
	if [ "$(id -u)" = 0 ]; then
		sh -c "$1" < /dev/null >> "$TI_LOG" 2>&1
		return $?
	fi
	if ti_have sudo && sudo -n true > /dev/null 2>&1; then
		sudo -n sh -c "$1" < /dev/null >> "$TI_LOG" 2>&1
		return $?
	fi
	[ "$opt_yes" = 1 ] && return 99
	if [ "$ti_ui" = tty ] && ti_have sudo; then
		ti_say "  sudo may ask for your password."
		sudo sh -c "$1" < /dev/null >> "$TI_LOG" 2>&1
		return $?
	fi
	if [ "$TI_OS" = linux ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && ti_have pkexec; then
		pkexec /bin/sh -c "$1" < /dev/null >> "$TI_LOG" 2>&1
		return $?
	fi
	return 99
}

# Check every need. Sets ti_need_n, ti_need_missing (indexes), ti_need_manual
# (indexes with no way to install them here), ti_need_pkgs, ti_pm.
ti_needs_eval() {
	ti_need_n=$(ti_sel need | wc -l | tr -d ' ')
	ti_need_missing= ti_need_manual= ti_need_pkgs= ti_pm=
	[ "$ti_need_n" -gt 0 ] || return 0
	[ "$TI_OS" = linux ] && ti_pm=$(ti_pkg_mgr)
	i=1
	while [ "$i" -le "$ti_need_n" ]; do
		if ti_need_present "$i"; then
			ti_log "Prerequisite $i ($(ti_sel need "$i" | cut -f1)): present"
		else
			ti_log "Prerequisite $i ($(ti_sel need "$i" | cut -f1)): missing"
			ti_need_missing="$ti_need_missing $i"
			pk=
			[ -n "$ti_pm" ] && pk=$(ti_sel npkg "$i" | awk -F'\t' -v m="$ti_pm" '$1 == m { print $2; exit }')
			case $pk in *[!A-Za-z0-9.+_:\ -]*) ti_fail "The runtime install script names a package with characters that don't belong in one: $pk" ;; esac
			if [ -n "$pk" ]; then
				ti_need_pkgs="${ti_need_pkgs:+$ti_need_pkgs }$pk"
			else
				ti_need_manual="$ti_need_manual $i"
			fi
		fi
		i=$((i + 1))
	done
	[ -n "$ti_need_pkgs" ] && ti_pkg_cmds "$ti_pm" "$ti_need_pkgs"
	return 0
}

# The transparency screen's part.
ti_needs_summary() {
	[ "$ti_need_n" -gt 0 ] || return 0
	# Every other section on this screen wraps at 74 and this one did not,
	# so it was the only part of the review a terminal had to break itself
	# -- and a terminal breaks mid-word. A catalogue `nwhy` is a sentence,
	# not a label: Ruby's is 225 characters, which came out as "...are
	# compiled when t / he app's gems are installed". Same words, wrapped
	# the way the rest of the screen is. The heading keeps its gloss, on
	# the line below, because a 109-column heading is not a heading.
	printf '\nSYSTEM-WIDE PREREQUISITES\n'
	printf '  %s\n' "These are installed for every user, and the uninstaller does not remove them. Checked on this machine." | ti_wrap 74 2
	i=1
	while [ "$i" -le "$ti_need_n" ]; do
		lbl=$(ti_sel need "$i" | cut -f2)
		case " $ti_need_missing " in
		*" $i "*)
			case " $ti_need_manual " in
			*" $i "*)
				printf '  %s: MISSING, and this installer can'\''t install it here\n' "$lbl" | ti_wrap 74 2
				h=$(ti_sel1 nhow "$i")
				[ -n "$h" ] && printf '    what to do: %s\n' "$h" | ti_wrap 74 16
				[ -z "$h" ] && [ "$TI_OS" = linux ] && printf '    no package is known for %s\n' "${ti_pm:-this distribution (no apt-get, dnf, yum, zypper, apk or pacman found)}" | ti_wrap 74 4
				;;
			*) printf '  %s: MISSING, will be installed\n' "$lbl" | ti_wrap 74 2 ;;
			esac
			;;
		*) printf '  %s: present\n' "$lbl" | ti_wrap 74 2 ;;
		esac
		w=$(ti_sel1 nwhy "$i")
		[ -n "$w" ] && printf '    why: %s\n' "$w" | ti_wrap 74 9
		i=$((i + 1))
	done
	if [ -n "$ti_need_pkgs" ]; then
		printf '  Packages: %s (with %s)\n' "$ti_need_pkgs" "$ti_pm" | ti_wrap 74 2
		# Not ti_wrap: this is a command, and ti_wrap breaks at any space
		# (see ti_cmd_wrap). A half-quoted package list is worse than a
		# long line.
		printf '  Runs as root: %s\n' "$TI_PKG_RUN"
		if [ "$(id -u)" = 0 ]; then printf '  (this installer is running as root)\n'
		else printf '  NEEDS ROOT for this step only (sudo, or pkexec on a desktop); the app itself installs for you\n' | ti_wrap 74 2; fi
	fi
	return 0
}

# After the user agreed: install what is missing, then check again.
ti_needs_install() {
	[ -n "$ti_need_missing" ] || return 0
	for i in $ti_need_manual; do
		lbl=$(ti_sel need "$i" | cut -f2)
		h=$(ti_sel1 nhow "$i")
		st=$(ti_sel1 nstart "$i")
		# Start the system's own installer (xcode-select --install) for the
		# user to finish, but never with --yes: it opens a dialog.
		if [ -n "$st" ] && [ "$opt_yes" != 1 ] && [ "$ti_ui" != none ]; then
			ti_say "Starting: $st"
			sh -c "$st" < /dev/null >> "$TI_LOG" 2>&1
		fi
		[ -n "$h" ] || h="Install it, then run this installer again."
		ti_fail_rc=2; ti_fail "$lbl is needed first and this installer can't install it here. $h"
	done
	if [ -n "$ti_need_pkgs" ]; then
		ti_say "Installing system packages ($ti_pm): $ti_need_pkgs"
		ti_log "  as root: $TI_PKG_RUN"
		ti_as_root "$TI_PKG_RUN"
		rc=$?
		if [ $rc = 99 ]; then
			ti_fail_rc=2; ti_fail "This app needs system packages that aren't installed ($ti_need_pkgs), and installing them needs root, which this installer can't ask for here$([ "$opt_yes" = 1 ] && printf ' (--yes)'). Run this, then run the installer again:$nl  $TI_PKG_SAY"
		fi
		[ $rc = 0 ] || ti_fail "Installing $ti_need_pkgs failed ($ti_pm exit code $rc). To try yourself: $TI_PKG_SAY"
	fi
	for i in $ti_need_missing; do
		ti_need_present "$i" || ti_fail "$(ti_sel need "$i" | cut -f2) is still missing after installing $ti_need_pkgs."
	done
	ti_say "Prerequisites installed."
	return 0
}

# The record's launcher icon (format.md section 2, `icon`): the packed PNG,
# copied into the app folder for the .desktop Icon= line. Only from the
# pack; without it the generic icon stays.
ti_install_icon() {
	ti_icon=
	[ "$TI_OS" = linux ] && [ -n "$TI_REC" ] || return 0
	ic=$(ti_get "$TI_REC" icon)
	[ -n "$ic" ] || return 0
	case $ic in *[!0-9a-f]*) ti_log "Ignoring the record's icon: not a sha256"; return 0 ;; esac
	[ ${#ic} = 64 ] || { ti_log "Ignoring the record's icon: not a sha256"; return 0; }
	if ! ti_obtain "$ic" "$TI_APP_DIR/icon.png" /dev/null icon; then
		ti_log "The record's icon $ic is not packed in this installer; using the generic icon"
		rm -f "$TI_APP_DIR/icon.png"
		return 0
	fi
	if [ "$(head -c 8 "$TI_APP_DIR/icon.png" | od -An -tx1 | tr -d ' \n')" != 89504e470d0a1a0a ]; then
		ti_log "The packed icon is not a PNG; using the generic icon"
		rm -f "$TI_APP_DIR/icon.png"
		return 0
	fi
	ti_icon=$TI_APP_DIR/icon.png
	ti_log "Icon: $ti_icon"
}

# ---------------------------------------------------------------- launcher, menus

ti_write_launcher() {
	cat > "$TI_APP_DIR/launch.sh" <<'EOF'
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
	ti-launch) case ${rest%%.*} in 0 | 1) ;; *) echo "launch.sh: launch.txt is a newer version" >&2; exit 1 ;; esac ;;
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
{ mkdir -p "$d/data" && : > "$log"; } 2>/dev/null || { log=${TMPDIR:-/tmp}/ti-launch-$(basename "$d").log; : > "$log" 2>/dev/null || log=/dev/null; }
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
	chmod 755 "$TI_APP_DIR/launch.sh"
}

ti_desktop_exec_arg() { # quote an argument for a .desktop Exec= line
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')"
}

ti_add_shortcut() { printf 'shortcut\t%s\n' "$1" >> "$TI_WORK/shortcuts"; ti_created r "$1"; }

ti_menus_linux() {
	ti_desk_made=
	if [ "$TI_SYSTEM" = 1 ]; then
		apps=/usr/local/share/applications
		dirs=/usr/local/share/desktop-directories
		menus=/etc/xdg/menus/applications-merged
	else
		data=${XDG_DATA_HOME:-$HOME/.local/share}
		apps=$data/applications
		dirs=$data/desktop-directories
		menus=${XDG_CONFIG_HOME:-$HOME/.config}/menus/applications-merged
	fi
	id=ti-$TI_APPID
	term=false
	[ "$TI_CONSOLE" = 1 ] && term=true
	ename=$(printf '%s' "$TI_NAME_DISP" | sed 's/\\/\\\\/g')
	cat > "$TI_WORK/entry.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$ename
Comment=Installed by TiddlyInstall
Exec=$(ti_desktop_exec_arg "$TI_APP_DIR/launch.sh")
Path=$TI_APP_DIR
Terminal=$term
Icon=${ti_icon:-application-x-executable}
Categories=Utility;
EOF
	# menu 0: nothing in the app menu at all (no entry, no uninstaller, no
	# folder). The app starts from launch.sh, the desktop shortcut if asked
	# for, or by running the installer again.
	if [ "$TI_MENU" != 0 ]; then
		ti_mkdirs "$apps" && ti_mkdirs "$dirs" && ti_mkdirs "$menus" || ti_fail "Could not create the menu folders."
		f=$apps/$id.desktop
		cp "$TI_WORK/entry.desktop" "$f" || ti_fail "Could not write $f"
		ti_add_shortcut "$f"
		f=$apps/$id-uninstall.desktop
		cat > "$f" <<EOF
[Desktop Entry]
Type=Application
Name=Uninstall $ename
Comment=Remove $ename and everything its installer added
Exec=/bin/sh $(ti_desktop_exec_arg "$TI_APP_DIR/uninstall.sh") --uninstall
Terminal=true
Icon=edit-delete
NoDisplay=false
Categories=Utility;
EOF
		ti_add_shortcut "$f"
		f=$dirs/$id.directory
		cat > "$f" <<EOF
[Desktop Entry]
Type=Directory
Name=$ename
Icon=folder
EOF
		ti_add_shortcut "$f"
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
		ti_add_shortcut "$f"
	fi
	if ti_want_desktop; then
		desk=$(xdg-user-dir DESKTOP 2>/dev/null)
		[ -n "$desk" ] || desk=$HOME/Desktop
		if [ -d "$desk" ]; then
			f=$desk/$id.desktop
			cp "$TI_WORK/entry.desktop" "$f" && chmod 755 "$f" && ti_add_shortcut "$f" && ti_desk_made=$f
			# GNOME asks before running an untrusted desktop file. Mark it, but
			# only where the desktop's metadata store already exists.
			[ -d "${XDG_DATA_HOME:-$HOME/.local/share}/gvfs-metadata" ] && ti_have gio &&
				gio set "$f" metadata::trusted true >/dev/null 2>&1
		fi
	fi
	return 0
}

ti_xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

ti_mac_app() { # bundle-path display-name bundle-id exec-script-body
	mkdir -p "$1/Contents/MacOS" "$1/Contents/Resources" || return 1
	ti_created r "$1"
	cat > "$1/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>run</string>
	<key>CFBundleIdentifier</key><string>$3</string>
	<key>CFBundleName</key><string>$(ti_xml "$2")</string>
	<key>CFBundleDisplayName</key><string>$(ti_xml "$2")</string>
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
	printf '%s\n' "$TI_APPID" > "$1/Contents/Resources/ti-appid"
}

# The desktop shortcut is made only for one-user installs, on both systems.
ti_want_desktop() { [ "$TI_DESKTOP" = 1 ] && [ "$TI_SYSTEM" != 1 ]; }

ti_mac_safe_name() {
	safe=$(printf '%s' "$TI_NAME_DISP" | sed -e 's#[/:]#-#g' -e 's/^\.*//')
	[ -n "$safe" ] || safe=$TI_APPID
}

ti_menus_macos() {
	ti_desk_made=
	if [ "$TI_SYSTEM" = 1 ]; then base=/Applications; else base=$HOME/Applications; fi
	ti_mac_safe_name
	q=$(ti_shq "$TI_APP_DIR/launch.sh")
	if [ "$TI_CONSOLE" = 1 ]; then
		body="if [ -t 1 ] || [ -n \"\$TI_NO_TERMINAL\" ]; then exec $q \"\$@\"; fi
exec open -a Terminal $q"
	else
		body="exec $q \"\$@\""
	fi
	if [ "$TI_MENU" = 0 ]; then
		# No folder and no uninstaller app. A desktop shortcut still needs a
		# launcher app to point at: just <App>.app in Applications.
		ti_want_desktop && [ -d "$HOME/Desktop" ] && [ ! -e "$HOME/Desktop/$safe" ] || return 0
		[ -e "$base/$safe.app" ] && ti_fail "$base/$safe.app already exists; not overwriting it."
		ti_mkdirs "$base" || ti_fail "Could not create $base"
		ti_mac_app "$base/$safe.app" "$TI_NAME_DISP" "pm.ti.app.$TI_APPID" "$body" || ti_fail "Could not create $base/$safe.app"
		printf 'shortcut\t%s\n' "$base/$safe.app" >> "$TI_WORK/shortcuts"
		ln -s "$base/$safe.app" "$HOME/Desktop/$safe" && ti_add_shortcut "$HOME/Desktop/$safe" && ti_desk_made=$HOME/Desktop/$safe
		return 0
	fi
	folder=$base/$safe
	[ -e "$folder" ] && ti_fail "$folder already exists; not overwriting it."
	ti_mkdirs "$folder" || ti_fail "Could not create $folder"
	ti_mac_app "$folder/$safe.app" "$TI_NAME_DISP" "pm.ti.app.$TI_APPID" "$body" || ti_fail "Could not create $folder/$safe.app"
	printf 'shortcut\t%s\n' "$folder/$safe.app" >> "$TI_WORK/shortcuts"
	ti_mac_app "$folder/Uninstall $safe.app" "Uninstall $TI_NAME_DISP" "pm.ti.uninstall.$TI_APPID" \
		"exec /bin/sh $(ti_shq "$TI_APP_DIR/uninstall.sh") --uninstall \"\$@\"" || ti_fail "Could not create the uninstaller app"
	printf 'shortcut\t%s\n' "$folder/Uninstall $safe.app" >> "$TI_WORK/shortcuts"
	if ti_want_desktop && [ -d "$HOME/Desktop" ] && [ ! -e "$HOME/Desktop/$safe" ]; then
		ln -s "$folder/$safe.app" "$HOME/Desktop/$safe" && ti_add_shortcut "$HOME/Desktop/$safe" && ti_desk_made=$HOME/Desktop/$safe
	fi
	return 0
}

# ---------------------------------------------------------------- uninstall

ti_uninstall() {
	app=$(cd "$(dirname "$TI_SELF")" && pwd)
	man=$app/manifest.txt
	[ -f "$man" ] || ti_fail "No manifest.txt next to the uninstaller ($app)."
	ti_check_header "$man" ti-manifest
	appid=$(ti_get "$man" appid)
	name=$(ti_get "$man" name)
	[ "$(basename "$app")" = "$appid" ] || ti_fail "The manifest in $app is for a different app ($appid); not removing anything."
	root=$(dirname "$app")
	if [ ! -w "$root" ] && [ "$(id -u)" != 0 ]; then
		ti_elevate --uninstall
		exit $?
	fi
	{
		printf 'Remove %s?\n\nThis deletes:\n  %s\n' "$name" "$app"
		awk -F'\t' '$1 == "dir" || $1 == "shortcut" { print "  " $2 }' "$man"
	} > "$TI_WORK/uninstall.txt"
	cp "$TI_WORK/uninstall.txt" "$TI_WORK/short.txt"
	ti_confirm "Uninstall $name" "$TI_WORK/uninstall.txt" "Remove $name?" || { ti_say "Nothing removed."; [ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG"; exit 1; }
	ti_log "Uninstalling $name ($appid) from $root"
	ti_remove_app "$app" "$appid"
	if [ $bad = 0 ]; then
		[ "$opt_yes" = 1 ] || [ "$ti_ui" = tty ] || ti_message info "TiddlyInstall" "$name has been removed."
		ti_say "$name has been removed."
	else
		ti_message error "TiddlyInstall" "$name was removed, but some listed items were refused (see above)."
		exit 1
	fi
}

# Remove app folder $1 (appid $2) and what its manifest lists: shortcuts,
# then dependency folders, then the app's folder. Sets bad=1 if anything
# listed was refused. Used by the uninstaller and by a reinstall.
ti_remove_app() {
	app=$1 appid=$2
	man=$app/manifest.txt
	root=$(dirname "$app")
	bad=0
	# The "fully installed" marker goes first, so an uninstall that stops
	# half way is never taken for a finished install.
	rm -f "$app/.ti-installed"
	: > "$TI_WORK/items"
	[ -f "$man" ] && awk -F'\t' '{ sub(/\r$/, "") } $1 == "dir" || $1 == "shortcut" { print $1 "\t" $2 }' "$man" > "$TI_WORK/items"
	# Shortcut files and launcher apps first.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = shortcut ] || continue
		case $p in /*) ;; *) ti_say "refusing relative path $p"; bad=1; continue ;; esac
		case $p in */../* | */./* | */.. | */.) ti_say "refusing $p"; bad=1; continue ;; esac
		if [ -h "$p" ]; then
			rm -f "$p" && ti_say "removed $p"
		elif [ -d "$p" ]; then
			case $p in
			*.app)
				if [ "$(cat "$p/Contents/Resources/ti-appid" 2>/dev/null)" = "$appid" ]; then
					rm -rf "$p" && ti_say "removed $p"
				else
					ti_say "refusing $p: not one of this app's launchers"; bad=1
				fi
				;;
			esac
		elif [ -f "$p" ]; then
			case $(basename "$p") in
			"ti-$appid".* | "ti-$appid"-*) rm -f "$p" && ti_say "removed $p" ;;
			*) ti_say "refusing $p: not named for this app"; bad=1 ;;
			esac
		fi
	done < "$TI_WORK/items"
	# Dependency folders: only <root>/<12 base32 chars>.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = dir ] || continue
		b=$(basename "$p")
		pd=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)
		if [ "$pd" != "$(cd "$root" && pwd -P)" ] || [ "$b" = "$appid" ]; then
			ti_say "refusing $p: not in $root"; bad=1; continue
		fi
		case $b in
		*[!a-z2-7]*) ti_say "refusing $p: not an install folder"; bad=1; continue ;;
		????????????) ;;
		*) ti_say "refusing $p: not an install folder"; bad=1; continue ;;
		esac
		[ -e "$p" ] || continue
		o=$(ti_get "$p/.ti-owner" appid 2>/dev/null)
		if [ "$o" != "$appid" ]; then
			ti_say "refusing $p: its .ti-owner doesn't name this app (${o:-none})"; bad=1; continue
		fi
		rm -rf "$p" && ti_say "removed $p"
	done < "$TI_WORK/items"
	o=$(ti_get "$app/.ti-owner" appid 2>/dev/null)
	if [ "$o" = "$appid" ]; then
		cd / && rm -rf "$app" && ti_say "removed $app"
	else
		ti_say "refusing $app: its .ti-owner doesn't name this app (${o:-none})"; bad=1
	fi
	rmdir "$root" 2>/dev/null
	# Folders the installer created for shortcuts: removed only if empty.
	while IFS="$tab" read -r kind p; do
		[ "$kind" = shortcut ] && [ -d "$p" ] && [ ! -h "$p" ] || continue
		case $p in *.app) continue ;; esac
		rmdir "$p" 2>/dev/null && ti_say "removed $p"
	done < "$TI_WORK/items"
	return 0
}

# ---------------------------------------------------------------- elevation

ti_elevate() { # extra args...
	set -- "$@" --yes --log="$TI_LOG"
	if [ "$TI_MODE_A" != 1 ]; then
		# The root copy checks the plan again; one this run accepted
		# without a signature (embedded, or --unsigned-plan) stays accepted.
		[ -n "$TI_REC" ] && set -- "$@" --record="$TI_REC"
		[ -n "$TI_PLAN" ] && set -- "$@" --plan="$TI_PLAN"
		[ -n "$TI_PLAN" ] && [ "$ti_plan_sigstate" != ok ] && set -- "$@" --unsigned-plan
	fi
	[ -n "$TI_ORIGIN" ] && set -- "$@" --ti-origin="$TI_ORIGIN"
	[ -n "$opt_backend" ] && set -- "$@" --backend="$opt_backend"
	[ "$opt_reinstall" = 1 ] && set -- "$@" --reinstall
	ti_log "Asking for administrator rights"
	if [ "$opt_yes" = 1 ] && [ "$ti_ui" != tty ]; then
		# --yes with no terminal: no password dialog either.
		if ti_have sudo && sudo -n true 2> /dev/null; then
			sudo -n /bin/sh "$TI_SELF" "$@"
			return $?
		fi
		ti_fail "This needs administrator rights, and with --yes and no terminal nothing may ask for them. Run it as root, or in a terminal."
	fi
	if [ "$TI_OS" = macos ] && [ "$ti_ui" != tty ]; then
		c="/bin/sh $(ti_shq "$TI_SELF")"
		for a in "$@"; do c="$c $(ti_shq "$a")"; done
		ti_osa "$c" <<'EOF' >> "$TI_LOG" 2>&1
on run argv
	do shell script (item 1 of argv) with administrator privileges
end run
EOF
	elif [ "$ti_ui" = tty ] && ti_have sudo; then
		sudo /bin/sh "$TI_SELF" "$@"
	elif ti_have pkexec && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
		pkexec /bin/sh "$TI_SELF" "$@"
	else
		ti_fail "This install needs administrator rights. Run it in a terminal (it will use sudo)."
	fi
}

# ---------------------------------------------------------------- installed already

# Is this app fully installed where this installer would put it, with this
# same record? Only the marker a finished install writes last counts
# (.ti-installed, docs/format.md section 5), and it must name this appid
# and record; the folder's .ti-owner must name the app too.
ti_is_installed() { # [app dir, appid, record hash]; default: this install's
	i_d=${1:-$TI_APP_DIR} i_id=${2:-$TI_APPID} i_h=${3:-$TI_RECHASH}
	m=$i_d/.ti-installed
	[ -n "$i_h" ] && [ -n "$i_id" ] && [ -f "$m" ] && [ -f "$i_d/launch.sh" ] && [ -f "$i_d/launch.txt" ] || return 1
	[ "$(sed -n 1p "$m" | tr -d '\r')" = "ti-installed${tab}1" ] || return 1
	[ "$(ti_get "$m" appid)" = "$i_id" ] && [ "$(ti_get "$m" record)" = "$i_h" ] || return 1
	[ "$(ti_get "$i_d/.ti-owner" appid 2>/dev/null)" = "$i_id" ]
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
ti_arch_words() { # arch
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
ti_arch_note() { # build-arch runtime-name
	[ -n "$1" ] || return 0
	case $1 in any | universal | "$TI_ARCH") return 0 ;; esac
	case $TI_ARCH:$1 in
	amd64:x86 | arm64:x86)
		printf ' -- this machine is 64-bit, but the runtime install script has no 64-bit build of %s for this system' "$2" ;;
	arm64:amd64)
		printf ' -- this machine is ARM; this is an Intel/AMD build' ;;
	*)
		printf ' -- this machine is %s' "$TI_ARCH" ;;
	esac
}

ti_root_path() {
	if [ "$TI_OS" = macos ]; then
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
ti_root_legacy() { # rootmode rootname
	[ "$TI_OS" = macos ] || return 0
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
ti_installed_offline() {
	[ "$opt_reinstall" = 1 ] && return 0
	e_h=$1
	case $e_h in *[!a-z2-7]* | '') return 0 ;; ??????????????????????????) ;; *) return 0 ;; esac
	e_id=$(ti_b32 "$(printf '%s/app' "$e_h" | ti_sha256)" 12)
	if [ -n "$2" ]; then
		e_rm=$(ti_get "$2" root)
		e_rn=$(ti_get "$2" rootname)
		[ -n "$e_rn" ] || e_rn=ti
		case $e_rn in . | .. | */* | *[!A-Za-z0-9._-]*) return 0 ;; esac
		set -- "$(ti_root_path "${e_rm:-user}" "$e_rn")" "$(ti_root_legacy "${e_rm:-user}" "$e_rn")"
	else
		set -- "$(ti_root_path user ti)" "$(ti_root_path system ti)" \
			"$(ti_root_legacy user ti)" "$(ti_root_legacy system ti)"
	fi
	for e_root in "$@"; do
		[ -n "$e_root" ] || continue
		ti_is_installed "$e_root/$e_id" "$e_id" "$e_h" || continue
		TI_APP_DIR=$e_root/$e_id TI_APPID=$e_id TI_RECHASH=$e_h
		TI_NAME_DISP=$(ti_get "$TI_APP_DIR/manifest.txt" name 2>/dev/null)
		[ -n "$TI_NAME_DISP" ] || TI_NAME_DISP=$e_id
		TI_CONSOLE=$(ti_get "$TI_APP_DIR/launch.txt" console 2>/dev/null)
		ti_log "Found $TI_NAME_DISP fully installed in $TI_APP_DIR (record $e_h, appid from the record hash); nothing fetched."
		ti_installed_now
	done
	return 0
}

# The app is fully installed: with --yes say so and exit 0, else start it.
ti_installed_now() {
	if [ "$opt_yes" = 1 ]; then
		# Unattended: never start the app (scripts, CI, the test matrix).
		ti_log "$TI_NAME_DISP is already installed in $TI_APP_DIR (record $TI_RECHASH); nothing to do."
		printf 'TiddlyInstall: %s is already installed in %s. Nothing was changed; add --reinstall to install it again.\n' "$(ti_cleans "$TI_NAME_DISP")" "$TI_APP_DIR" >&2
		[ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG"
		exit 0
	fi
	ti_launch_installed
}

# Start the installed app the way its shortcuts do (launch.sh), and don't
# come back. A console app started from a desktop (no terminal) gets a
# terminal window, as its menu entry would (Terminal=true, or Terminal.app
# on macOS; TI_NO_TERMINAL=1 keeps it in this process, as the launcher
# app's does).
ti_launch_installed() {
	l=$TI_APP_DIR/launch.sh
	ti_log "$TI_NAME_DISP is already installed in $TI_APP_DIR (record $TI_RECHASH); starting it with $l"
	ti_say "$TI_NAME_DISP is already installed; starting it. (To install it again, run this installer with --reinstall.)"
	ti_cleanup
	trap - EXIT INT TERM HUP
	[ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG"
	if [ "$TI_CONSOLE" = 1 ] && [ ! -t 1 ] && [ -z "${TI_NO_TERMINAL:-}" ]; then
		case $ti_ui in
		osascript) exec open -a Terminal "$l" ;;
		zenity | kdialog)
			if ti_have x-terminal-emulator; then exec x-terminal-emulator -e /bin/sh "$l"
			elif ti_have gnome-terminal; then exec gnome-terminal -- /bin/sh "$l"
			elif ti_have konsole; then exec konsole -e /bin/sh "$l"
			elif ti_have xfce4-terminal; then exec xfce4-terminal -x /bin/sh "$l"
			elif ti_have xterm; then exec xterm -e /bin/sh "$l"
			fi
			;;
		esac
	fi
	exec /bin/sh "$l"
}

# Start a command detached, so this process can finish its own work and
# exit without taking the app with it.
ti_spawn() {
	if ti_have setsid; then
		(setsid "$@" >/dev/null 2>&1 &) 2>/dev/null && return 0
	fi
	(nohup "$@" >/dev/null 2>&1 &) 2>/dev/null
	return 0
}

# Start the installed app from the finish dialog, and come back.
# ti_launch_installed replaces this process, because there starting the
# app was the whole job; here the install has just finished and still has
# a log to copy and a temp tree to remove, so the app is detached instead.
ti_start_detached() {
	l=$TI_APP_DIR/launch.sh
	ti_log "Starting $TI_NAME_DISP from the finish dialog: $l"
	if [ "$TI_CONSOLE" = 1 ] && [ -z "${TI_NO_TERMINAL:-}" ]; then
		# A console app started from a desktop has nowhere to print, so
		# it gets a terminal window, as its menu entry would.
		case $ti_ui in
		osascript) ti_spawn open -a Terminal "$l"; return 0 ;;
		zenity | kdialog)
			if ti_have x-terminal-emulator; then ti_spawn x-terminal-emulator -e /bin/sh "$l"; return 0
			elif ti_have gnome-terminal; then ti_spawn gnome-terminal -- /bin/sh "$l"; return 0
			elif ti_have konsole; then ti_spawn konsole -e /bin/sh "$l"; return 0
			elif ti_have xfce4-terminal; then ti_spawn xfce4-terminal -x /bin/sh "$l"; return 0
			elif ti_have xterm; then ti_spawn xterm -e /bin/sh "$l"; return 0
			fi
			;;
		esac
	fi
	ti_spawn /bin/sh "$l"
	return 0
}

# The app's name, cleaned and short enough to be a dialog button. The
# name comes from the plan, so it is a stranger's string: ti_cleans takes
# the control characters out and this takes the length out, or a long
# name pushes the other button off the dialog.
ti_btn_name() {
	n=$(ti_cleans "$TI_NAME_DISP")
	[ -n "$n" ] || n="the app"
	if [ "${#n}" -gt 40 ]; then
		n="$(printf '%s' "$n" | cut -c1-37)..."
	fi
	printf '%s' "$n"
}

# The final dialog: the message, plus an offer to start what was just
# installed. Windows has offered this on its finish page from the
# beginning (base.nsi, MUI_FINISHPAGE_RUN "Run $AppName now"); Linux and
# macOS had the text alone until 2026-09-22. Returns 0 to start it.
#
# Never reached with --yes or on a tty: the caller checks both, and an
# unattended install must not start anything by itself.
ti_finish_dialog() { # text
	fd_t=$(ti_cleans "$1")
	fd_b="Start $(ti_btn_name)"
	case $ti_ui in
	zenity)
		# --question, not --info: only a question has two buttons. The
		# icon is set back to the informational one, because nothing is
		# being asked that has a wrong answer.
		zenity --question --title="TiddlyInstall" --no-markup --text="$fd_t" \
			--icon-name=dialog-information --ok-label="$fd_b" --cancel-label="Close" 2>/dev/null
		return $?
		;;
	kdialog)
		kdialog --title "TiddlyInstall" --yesno "$fd_t" --yes-label "$fd_b" --no-label "Close"
		return $?
		;;
	osascript)
		fd_r=$(ti_osa "TiddlyInstall" "$fd_t" "$fd_b" <<'EOF' 2>/dev/null
on run argv
	activate
	set d to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Close", (item 3 of argv)} default button (item 3 of argv) with icon note
	if button returned of d is (item 3 of argv) then
		return "start"
	end if
	return "close"
end run
EOF
		)
		[ "$fd_r" = start ] && return 0
		return 1
		;;
	esac
	ti_message info "TiddlyInstall" "$fd_t"
	return 1
}

# How to start and uninstall the app, one line each, for the final message.
ti_start_hint() {
	if [ "$TI_MENU" != 0 ]; then
		if [ "$TI_OS" = macos ]; then
			printf 'Start it from Applications > %s, which also holds its uninstaller.' "$TI_NAME_DISP"
		else
			printf 'Start it from the app menu (the folder "%s"), which also holds its uninstaller.' "$TI_NAME_DISP"
		fi
		return 0
	fi
	if [ -n "$ti_desk_made" ]; then
		printf 'Start it from its desktop shortcut, or run: %s\n' "$(ti_shq "$TI_APP_DIR/launch.sh")"
	else
		printf 'Start it by running: %s\n' "$(ti_shq "$TI_APP_DIR/launch.sh")"
	fi
	printf 'Running this installer again also starts it.\n'
	printf 'To uninstall it, run: sh %s' "$(ti_shq "$TI_APP_DIR/uninstall.sh")"
}

# ---------------------------------------------------------------- main install

ti_describe_source() {
	s=
	[ -n "$TI_REC" ] && s=$(ti_get "$TI_REC" source)
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
	package) if [ -n "$3" ]; then printf 'package %s, version %s' "$2" "$3"; else printf 'package %s (newest)' "$2"; fi ;;
	url) printf '%s (sha256 %s)' "$2" "$3" ;;
	inline) printf 'code written on the site (sha256 %s)' "$2" ;;
	*) printf '%s' "$s" ;;
	esac
}

ti_signer() {
	if [ -n "$TI_BUNDLE" ]; then
		if ! ti_have codesign; then printf 'unknown (no codesign tool)'; return; fi
		info=$(codesign -dvv "$TI_BUNDLE" 2>&1)
		case $info in
		*"not signed"*) printf 'nobody (the app is not signed)' ;;
		*Authority=*) printf '%s' "$(printf '%s\n' "$info" | sed -n 's/^Authority=//p' | sed -n 1p)" ;;
		*adhoc*) printf 'nobody (ad-hoc signature, no identity)' ;;
		*) printf 'unknown' ;;
		esac
		case $info in *"not signed"*) ;; *)
			codesign --verify "$TI_BUNDLE" >/dev/null 2>&1 ||
				printf '; the signature does NOT verify (the app was changed after signing)' ;;
		esac
	else
		[ -n "$ti_self_sha" ] || ti_self_sha=$(ti_sha256 "$TI_SELF")
		# Not "nobody", which reads as "nobody vouches for any of this" --
		# and reads it three lines above a "Plan:" line saying the plan IS
		# signed by our key. Nothing signs a .run because Linux checks
		# nothing when it runs one: there is no mechanism to have used,
		# which is a different statement from having skipped one.
		printf 'nothing - Linux checks no signature when it runs a .run file; this file has sha256 %s' "$ti_self_sha"
	fi
}

# ---------------------------------------------------------------- what this install can do
#
# design.md 11.3 ("classify by capability, not by form"),
# docs/launch-shapes.md section 8. Not "is this a standard installer?":
# any classification creates pressure to be classified as safe, and
# `binary run.sh` satisfies every form rule there is. The question a
# person can act on is the shorter one -- **what can this installation
# do that an ordinary one cannot?** An ordinary one unpacks pinned files
# into folders under one root, runs our recipe there, installs the
# project, and leaves a menu entry and an uninstaller.
#
# Four rules, and the statement is theatre without any of them:
#
#   * **Derived.** Every finding is read off the plan, or off the record
#     the plan's `record` line is bound to by hash. Nothing a publisher
#     asserts is believed, because an unsigned installer can assert
#     whatever it likes.
#   * **Fail closed.** It is a list of things *found*, so the failure
#     mode of a bug is a missing line rather than an invented one -- and
#     anything this engine does not recognise is itself a finding. A
#     plan we cannot read in full is not a plan we can describe.
#   * **No claim at all on a plan nothing vouches for.** "Nothing
#     unusual" about a document anybody could have written says nothing.
#   * **It never describes what a command does.** We know our own recipe
#     steps because we wrote them; what a publisher's command touches is
#     not decidable from its text. So the honest sentence about one is
#     that we do not know what it does -- which is also the more useful
#     sentence than the command.
#
# It applies to ordinary installs too, and that is the point: a
# completely standard Python install that wants administrator rights is
# exactly what a form-based badge would wave through.

# The plan keys and step kinds this engine knows (docs/format.md 3). A
# key that is not here is not ignored quietly: it is reported, because
# the alternative is a summary that describes part of a plan as though
# it were the whole of it. `srcurl` and `target` are ti_select_target's
# own; `sig` survives into the selection when the chosen block is the
# last one in the plan.
TI_KNOWN_KEYS='target|record|name|project|appid|console|menu|desktop|root|rootname|signed|maxage|source|srcurl|request|sig|when|minbuild|covers|runtime|file|url|step|exe|env|unset|path|ienv|iunset|install|launch|admin|note|fail|need|nwhy|ncheck|nfile|nurl|nrun|nok|npkg|nstart|nhow|rtroots|rtproof'
TI_KNOWN_STEPS='unpack|run|mkdir|write|delete'

ti_unknown_bits() { # -> "key, step foo" for everything in the selection we do not know
	awk -F'\t' -v keys="^($TI_KNOWN_KEYS)\$" -v steps="^($TI_KNOWN_STEPS)\$" '
	function note(w) { if (!(w in seen)) { seen[w] = 1; out = out (out == "" ? "" : ", ") w } }
	$1 == "step" && $3 !~ steps { note("step " $3); next }
	$1 !~ keys { note($1) }
	END { if (out != "") print out }' "$TI_SEL"
}

# The package manager an install command we wrote runs, named only when
# the text says so plainly. This is not an analysis of shell: the record
# has already said the command is ours, so recognising it is recognising
# our own catalogue's work. Anything unrecognised gets the wording that
# admits we do not know, never the wording that says there is nothing to
# know.
ti_fetcher_of() { # command
	case " $1 " in
	*' -m pip '* | *'pip install'*) printf 'pip' ;;
	*'npm-cli.js'* | *'npm install'* | *'npm ci'*) printf 'npm' ;;
	*bundle*) printf 'bundler' ;;
	*'gem" install'* | *'gem install'*) printf 'RubyGems' ;;
	*composer*) printf 'Composer' ;;
	*cargo*) printf 'cargo' ;;
	*'/go" '* | *'\go.exe"'*) printf "Go's module fetcher" ;;
	*dotnet*) printf 'the .NET SDK, which restores NuGet packages' ;;
	esac
}

ti_cap_number() { # n -> "One", "Two", ...
	case $1 in
	1) printf 'One' ;; 2) printf 'Two' ;; 3) printf 'Three' ;; 4) printf 'Four' ;;
	5) printf 'Five' ;; 6) printf 'Six' ;; 7) printf 'Seven' ;; *) printf '%s' "$1" ;;
	esac
}

# One finding per line, in the order a person would want them. Called
# from ti_install_main, where everything it reads has been computed.
ti_capabilities() {
	u=$(ti_unknown_bits)
	[ -n "$u" ] &&
		printf '%s\n' "it asks for things this installer does not recognise ($u). We cannot tell you what they do, and a script we cannot read all of is not one we can describe."
	said_admin=0
	if [ "$TI_SYSTEM" = 1 ]; then
		printf '%s\n' "it installs for every user on this machine, into $TI_ROOT, and needs administrator rights to do it."
		said_admin=1
	fi
	if [ -n "$ti_need_pkgs" ]; then
		printf '%s\n' "it installs the system packages $ti_need_pkgs for every user on this machine, as root, with $ti_pm. They stay behind when this app is uninstalled."
		said_admin=1
	fi
	[ "$need_root" = 1 ] && [ "$said_admin" = 0 ] &&
		printf '%s\n' "it needs administrator rights: this script's block asks for them."
	# The app's own source is the one download allowed to go unpinned
	# (format.md, "Sources without a stored hash").
	case ${ti_src_sha:-} in
	'' | -) [ -n "$ti_src_name" ] &&
		printf '%s\n' "the project's own files carry no checksum in this script: they are named by a commit id and fetched over HTTPS, and that is the whole of the check on them." ;;
	esac
	if [ -n "$ti_ins_cmd" ]; then
		case $ti_ins_who in
		publisher) printf '%s\n' "one of the commands that runs while installing was written by whoever published this app, not by us. What it does is not something we can tell you; the command itself is in the log, in full, before anything is fetched." ;;
		unknown) printf '%s\n' "nothing here says who wrote the command that installs the project, so we cannot tell you whether it is ours or the publisher's. Treat it as the publisher's and read it." ;;
		esac
		# design.md 11.3 / launch-shapes.md recommendation 7: every
		# `install` line hands a package manager the job of deciding
		# what else to download, a few lines under "each one is checked
		# against its SHA-256". It is the largest unpinned thing we do
		# and until now the screen said nothing about it.
		f=
		[ "$ti_ins_who" = ours ] && f=$(ti_fetcher_of "$ti_ins_cmd")
		if [ -n "$f" ]; then
			printf '%s\n' "installing the project runs $f, which works out what the project depends on, downloads it and runs its code. The runtime install script names none of that, and no SHA-256 in it covers any of it."
		else
			printf '%s\n' "what the command that installs the project reaches for, we cannot say. Anything it downloads is decided while you install: this script does not name it and no SHA-256 here covers it."
		fi
	fi
	return 0
}

# The section, both claims, one code path. The capability sentence and
# the provenance sentence are different claims -- one about the
# installation, one about the program -- and they are emitted together
# so that no later change can render one without the other.
#
# It opens by saying what an ordinary install *is*, and that sentence is
# the only place on the screen the SHA-256 promise is made (2026-09-21):

# What an ordinary install is, for the short screen behind "Details..."
# (the full screen says it as a list of bullets instead). Still needed
# here: that screen has no room for the list.
TI_CAP_ORDINARY="An ordinary install unpacks the files it names, each one checked against its SHA-256, into folders of its own, for you alone, and runs only the setup steps we wrote for the runtime."

ti_install_main() {
	ti_find_metadata
	[ -n "$TI_REC" ] && ti_check_header "$TI_REC" ti-record
	TI_RECHASH=
	[ -n "$TI_REC" ] && TI_RECHASH=$(ti_b32 "$(ti_sha256 "$TI_REC")" 26)
	# Installed already? Checked here, before the plan is fetched.
	[ -n "$TI_RECHASH" ] && ti_installed_offline "$TI_RECHASH" "$TI_REC"
	backend=$opt_backend
	[ -z "$backend" ] && [ -n "$TI_REC" ] && [ "$TI_MODE_A" != 1 ] && backend=$(ti_get "$TI_REC" backend)
	# Whether anybody actually chose one, as against this engine filling
	# in the address it was compiled with. An installer built with no
	# server used to fall through to that address and then ask it for a
	# revocation list at install time -- a host the builder never picked
	# and the person running it never agreed to (2026-09-23). The
	# fallback stays for what genuinely has nowhere else to go: an
	# installer that carries no plan has to fetch one from somewhere.
	ti_backend_given=$backend
	[ -z "$backend" ] && backend=$TI_DEFAULT_BACKEND
	backend=${backend%/}
	case $TI_PLAN_KIND in
	embedded) TI_PLAN_FROM=embedded ;;
	cmdline) TI_PLAN_FROM="given: $TI_PLAN" ;;
	*) TI_PLAN_FROM=$TI_PLAN_URL ;;
	esac
	if [ -z "$TI_PLAN" ]; then
		TI_PLAN=$TI_WORK/plan.txt TI_PLAN_KIND=fetched TI_PLAN_URL=$backend/api/plan/$TI_RECHASH
		ti_say "Fetching the install plan from $backend"
		ti_nonce "$TI_RECHASH"
		ti_download "$TI_PLAN_URL$(ti_nonce_query)" "$TI_PLAN" ||
			ti_fail "Could not fetch the install plan from $TI_PLAN_URL.$(ti_http_why)"
		TI_PLAN_FROM=$TI_PLAN_URL
	fi
	ti_check_header "$TI_PLAN" ti-plan
	ti_check_plan
	# The plan must be for this record (format.md "Plan signature"): a signed plan for
	# another app can't be replayed.
	prec=$(ti_get "$TI_PLAN" record)
	if [ -n "$TI_RECHASH" ] && [ "$prec" != "$TI_RECHASH" ]; then
		ti_fail "The install plan is for record ${prec:-none}, but this installer's record is $TI_RECHASH. Nothing was installed."
	fi
	[ -z "$TI_RECHASH" ] && TI_RECHASH=$prec
	# A plan by name has no record to check against; it says (signed)
	# which name it answers.
	if [ -n "$TI_PLAN_REQUEST" ] && [ "$(ti_get "$TI_PLAN" request)" != "$TI_PLAN_REQUEST" ]; then
		ti_fail "The plan from $backend is not the answer for $(printf '%s' "$TI_PLAN_REQUEST" | tr '\t' ' '). Nothing was installed."
	fi
	# ...and, for a fetched plan, the answer to *this* request and not a
	# replay of an older one (design.md 7.1).
	ti_check_nonce

	TI_SEL=$TI_WORK/selection.txt
	ti_select_target "$TI_PLAN" > "$TI_SEL"
	f=$(ti_sel1 fail)
	[ -n "$f" ] && ti_fail "$f"
	# A plan carried in this installer may be old, or name something since
	# withdrawn: the revocation list answers that where there is a network,
	# and the plan's own `signed`/`maxage` where there is not. Both run
	# before anything on this machine is changed.
	# Is the runtime install script one we published? Answered here, from
	# the plan and the key this engine carries -- no network, no
	# catalogue. It changes nothing about the install; it decides what
	# the screen is allowed to claim.
	ti_check_rtscript "$(ti_sel1 target)"
	ti_revocations "$backend"
	ti_check_age "$backend"

	TI_NAME_DISP=$(ti_get "$TI_PLAN" name)
	TI_PROJECT=$(ti_get "$TI_PLAN" project)
	TI_APPID=$(ti_get "$TI_PLAN" appid)
	TI_CONSOLE=$(ti_get "$TI_PLAN" console)
	TI_MENU=$(ti_get "$TI_PLAN" menu)
	TI_DESKTOP=$(ti_get "$TI_PLAN" desktop)
	rootmode=$(ti_get "$TI_PLAN" root)
	rootname=$(ti_get "$TI_PLAN" rootname)
	[ -n "$rootname" ] || rootname=ti
	[ -n "$TI_NAME_DISP" ] || TI_NAME_DISP=$TI_PROJECT
	case $TI_APPID in
	*[!a-z2-7]* | '') ti_fail "The plan's appid ($TI_APPID) is not 12 base32 characters." ;;
	????????????) ;;
	*) ti_fail "The plan's appid ($TI_APPID) is not 12 base32 characters." ;;
	esac
	case $rootname in '' | . | .. | */* | *[!A-Za-z0-9._-]*) ti_fail "Bad rootname: $rootname" ;; esac

	TI_SYSTEM=0
	[ "$rootmode" = system ] && TI_SYSTEM=1
	rmode=user
	[ $TI_SYSTEM = 1 ] && rmode=system
	TI_ROOT=$(ti_root_path "$rmode" "$rootname")
	# An app an older base put under the root of the day stays where it
	# is: installing it again replaces that copy instead of orphaning it
	# in the old folder, and the runtimes it shares with its neighbours
	# are found beside it. Only this app's own folder is looked for.
	oldroot=$(ti_root_legacy "$rmode" "$rootname")
	if [ -n "$oldroot" ] && [ ! -e "$TI_ROOT/$TI_APPID" ] && [ -e "$oldroot/$TI_APPID" ]; then
		ti_log "Keeping this app in the folder an earlier installer made: $oldroot/$TI_APPID"
		TI_ROOT=$oldroot
	fi
	case $TI_ROOT in
	*[\"\$\`\\]* | *"$nl"*) ti_fail "The install folder $TI_ROOT contains characters (\" \$ \` \\) that commands can't quote." ;;
	/*) ;;
	*) ti_fail "HOME is not set to an absolute path." ;;
	esac
	need_root=$TI_SYSTEM
	[ "$(ti_sel1 admin)" = 1 ] && need_root=1

	export TI_APP_DIR="$TI_ROOT/$TI_APPID"
	export TI_DATA_DIR="$TI_APP_DIR/data"
	export TI_TMP="$TI_WORK/tmp"
	export TI_PROJECT
	export TI_APP_NAME="$TI_NAME_DISP"

	# ---- already installed? Only the marker a finished install writes
	# last counts, for this appid and this exact record (the same settings).
	# (The fallback for plans by name, whose record hash only the server
	# knows; the others were checked before anything was fetched.)
	if [ "$opt_reinstall" != 1 ] && ti_is_installed; then
		ti_installed_now
	fi
	nfiles=$(ti_sel file | wc -l | tr -d ' ')
	TI_DIRMAP=
	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ti_sel file "$i")
		IFS=$ifs0
		h=$(ti_b32 "$(printf '%s%s' "$TI_APPID" "$1" | ti_sha256)" 12)
		TI_DIRMAP="$TI_DIRMAP$1$tab$TI_ROOT/$h$nl"
		[ "$i" = 1 ] && TI_RUNTIME_DIR=$TI_ROOT/$h
		i=$((i + 1))
	done
	export TI_DIRMAP TI_RUNTIME_DIR
	exe=$(ti_sel1 exe)
	TI_RUNTIME=
	[ -n "$exe" ] && [ -n "$TI_RUNTIME_DIR" ] && TI_RUNTIME=$TI_RUNTIME_DIR/$exe
	export TI_RUNTIME
	ti_needs_eval

	# ---- transparency (design.md section 3; the shape is set out at
	# "the review screen's shape", above)
	sum=$TI_WORK/summary.txt
	# ti_signer runs in a command substitution, so every variable it sets
	# dies with that subshell. ti_self_sha was assigned only in there, so
	# the "this file has sha256" line below -- and the one on the short
	# screen -- has never printed on any .run install. Found 2026-09-22
	# by writing a line that pointed at it. Compute it out here.
	[ -n "$TI_BUNDLE" ] || [ -n "$ti_self_sha" ] || ti_self_sha=$(ti_sha256 "$TI_SELF")
	ti_signed_by=$(ti_signer)
	# The .run's own sha256 belongs on a line of its own, not glued to the
	# end of "Signed by:" where it pushes the answer off the screen.
	ti_signed_short=$(printf '%s' "$ti_signed_by" | sed 's/; this file has sha256 .*//')
	# A signature on the installer is not a word about the program in it,
	# and "Signed by: TiddlyInstall" invites exactly that reading -- most
	# of all in mode A, where the name on the certificate is ours. So
	# where there is a signer, the line says what the signature covers.
	#
	# On its own line, not glued to the end of the signer's name: the two
	# together run past 74 and leave "installs)" alone on the next line on
	# every surface at once, and only ever on a signed installer, which is
	# the one a person downloads. Same treatment as the sha256 line
	# directly below, and the same shape the Windows engine already prints
	# (base.nsi, "It covers this installer file, not the program it
	# installs."). The words are not the ones to change: they were settled
	# on 2026-09-21, and any shorter way of saying it says less.
	ti_signed_scope=
	case $ti_signed_short in
	# The .run case. A signature over a file that carries its own
	# verifier proves nothing -- whoever changed the payload changed the
	# check with it -- so the honest pointer is not to a signature we
	# could add, but to the one comparison that happens outside the file.
	nothing*) ti_signed_scope= ;;
	nobody* | unknown*) ;;
	# Was "It covers this installer file, not the program it installs."
	# -- the third copy of what IMPORTANT says at the foot of the same
	# section. What is worth saying here instead is the part IMPORTANT
	# does not: which artifact this signature is over.
	*) ti_signed_scope='It covers this file, and was made before the settings below were chosen.' ;;
	esac
	# The signature as a heading and a reason, rather than one long
	# sentence in a value column: "UNSIGNED" is the thing to see first,
	# and why it is unsigned is a different sentence.
	case $ti_signed_short in
	nothing*)
		# Not "UNSIGNED", which is what Windows says and means something
		# else there: that somebody could have signed this and did not.
		# A .run has nowhere to put a signature and Linux would not look
		# at one, so the absence is a fact about the format, not a
		# finding about this file. The same word for both taught the
		# reader to discount it in the case where it does mean
		# something.
		ti_signed_label='NO SIGNATURE, AND NOTHING WOULD CHECK ONE'
		ti_signed_why='Linux runs a .run file without looking for a signature, so these do not carry one. On Windows or macOS an unsigned file is a choice; here there is no choice to make.'
		;;
	nobody*)
		ti_signed_label='UNSIGNED'
		ti_signed_why=$ti_signed_short
		;;
	unknown*)
		ti_signed_label='SIGNED, BUT THIS MACHINE CANNOT IDENTIFY THE SIGNER'
		ti_signed_why=$ti_signed_short
		;;
	*)
		ti_signed_label="Signed by $ti_signed_short"
		ti_signed_why=
		;;
	esac

	# What the totals are, before anything is printed: a person deciding
	# wants "2 files, 34.3 MB, and here is who they are from" before they
	# want six 200-character URLs.
	#
	# Two lists are kept, not one: every URL (which goes in the log, so
	# nothing is lost) and one origin URL per file (ti_origin_url, above),
	# which is what the screen names. ti_nmirror is how many locations
	# are left over once the origins are taken out -- the "or a mirror of
	# it" the screen owns up to without spelling out.
	ti_ourhost=$(ti_host_of "$backend")
	ti_tot=0
	ti_urls=$TI_WORK/urls.txt
	ti_origins=$TI_WORK/origins.txt
	ti_ufile=$TI_WORK/file-urls.txt
	: > "$ti_urls"
	: > "$ti_origins"
	ti_packed_all=1
	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ti_sel file "$i")
		IFS=$ifs0
		case ${4:-} in '' | *[!0-9]*) ;; *) ti_tot=$((ti_tot + $4)) ;; esac
		if { [ -n "$TI_PACK_DIR" ] && [ -f "$TI_PACK_DIR/$3" ]; } ||
			{ [ -n "$TI_PACK_TAR" ] && grep -qx "$3" "$TI_WORK/pack.list"; }; then :; else
			ti_packed_all=0
			ti_sel url "$i" > "$ti_ufile"
			cat "$ti_ufile" >> "$ti_urls"
			ti_origin_url "$ti_ourhost" < "$ti_ufile" >> "$ti_origins"
		fi
		i=$((i + 1))
	done
	src=$(ti_sel1 source)
	# A source with no stored SHA-256 has no size either, and its `0` is
	# not a measurement: GitHub makes the archive when it is asked for
	# it, so nobody writing the plan could know how big it is (format.md,
	# "Sources without a stored hash"). The total then has to say "more
	# than", because a confident total that leaves a file out is the same
	# lie as a confident "0 bytes" for the file itself.
	ti_src_unsized=0
	if [ -n "$src" ]; then
		IFS=$tab
		set -- $src
		IFS=$ifs0
		case ${2:-} in '' | -) ti_src_unsized=1 ;; esac
		case ${3:-} in '' | *[!0-9]*) ;; *) ti_tot=$((ti_tot + $3)) ;; esac
		if { [ -n "$TI_PACK_DIR" ] && [ -f "$TI_PACK_DIR/$2" ]; } ||
			{ [ -n "$TI_PACK_TAR" ] && grep -qx "$2" "$TI_WORK/pack.list"; }; then :; else
			ti_packed_all=0
			ti_sel srcurl > "$ti_ufile"
			cat "$ti_ufile" >> "$ti_urls"
			ti_origin_url "$ti_ourhost" < "$ti_ufile" >> "$ti_origins"
		fi
	fi
	ti_nall=$nfiles
	[ -n "$src" ] && ti_nall=$((ti_nall + 1))
	# Prefixes every printed total, so the three places that print one
	# cannot drift apart.
	ti_tot_pre=
	[ "$ti_src_unsized" = 1 ] && ti_tot_pre='more than '
	ti_hostlist=$(ti_hosts < "$ti_origins")
	ti_norigin=$(wc -l < "$ti_origins" | tr -d ' ')
	ti_nmirror=$(($(wc -l < "$ti_urls" | tr -d ' ') - ti_norigin))
	ti_nhost=$(printf '%s' "$ti_hostlist" | awk -F', ' '{ print NF }')
	[ -n "$ti_hostlist" ] || ti_nhost=0
	ti_nrun=$(ti_sel step | awk -F"$tab" '$2 == "run"' | wc -l | tr -d ' ')

	# The runtime, from the *last* runtime line: the selection carries the
	# plan's header (`runtime <id>` alone) before the chosen block's
	# (`runtime <id> <version> <arch>`), so ti_sel1 was showing the bare
	# id and never the version -- which is also why format.md's claim
	# that this engine already showed the architecture was wrong.
	ti_rt_line=
	ti_rt_note=
	ti_rt_id=
	# Which folders the plan puts on PATH as `{dir:<name>}`: the
	# companion runtimes a recipe requires, and nothing else
	# (ti_file_role, above).
	ti_comp_names=$(ti_sel path | sed -n 's/^{dir:\([^}]*\)}.*$/\1/p' | sort -u | tr '\n' ' ')
	rt=$(ti_sel runtime | sed -n '$p')
	if [ -n "$rt" ]; then
		IFS=$tab
		set -- $rt
		IFS=$ifs0
		a_name=$1 a_ver=${2:-} a_arch=${3:-}
		ti_rt_id=$1
		if [ -n "$a_arch" ]; then
			ti_rt_note=$(ti_arch_note "$a_arch" "$a_name")
			ti_rt_line="$a_name $a_ver, $(ti_arch_words "$a_arch")$ti_rt_note"
		else
			ti_rt_line=$(printf '%s' "$rt" | tr '\t' ' ')
		fi
	fi

	# Where the project comes from, and whether its name has to be said
	# twice. "Installs: test b" over "Project: test_b" is two lines
	# saying one thing: the project name earns a line of its own only
	# when the screen does not already carry it, and it usually does --
	# it is either the app's name with the punctuation changed, or the
	# package that `From:` names in full.
	ti_from_txt=$(ti_describe_source)
	ti_show_project=0
	if [ -n "$TI_PROJECT" ]; then
		ti_pj=$(ti_flatname "$TI_PROJECT")
		if [ -n "$ti_pj" ] && [ "$ti_pj" != "$(ti_flatname "$TI_NAME_DISP")" ]; then
			case $(ti_flatname "$ti_from_txt") in *"$ti_pj"*) ;; *) ti_show_project=1 ;; esac
		fi
	fi

	# Anything unusual, at the top, where a decision is made. `!!` is
	# "you would want to know this before saying yes"; `!` is "worth
	# noticing". Everything here is also stated again in its own section.
	#
	# Two of the `!` lines left on 2026-09-21: administrator rights and
	# an unpinned source are capabilities, not alarms, and WHAT THIS
	# INSTALL CAN DO now carries them with their consequence attached.
	# Saying them in both places would be the screen repeating itself,
	# which is the one thing its shape rules forbid. What is left here
	# is what a capability statement cannot hold: the plan cannot be
	# trusted, the install is going to stop, or the build is not this
	# machine's architecture -- none of which is a thing the install
	# *can do*.
	ti_warn=$TI_WORK/warnings.txt
	: > "$ti_warn"
	[ -n "$ti_plan_warn" ] && printf '!! %s\n' "$ti_plan_warn" >> "$ti_warn"
	[ -n "$ti_age_warn" ] && printf '!! %s\n' "$ti_age_warn" >> "$ti_warn"
	[ -n "$ti_need_manual" ] &&
		printf '!! Something this app needs is missing and this installer cannot install it here; see SYSTEM-WIDE PREREQUISITES below.\n' >> "$ti_warn"
	case $ti_signed_by in
	*'does NOT verify'*) printf '!! The signature on this installer does not verify: it was changed after it was signed.\n' >> "$ti_warn" ;;
	esac
	[ -n "$ti_rt_note" ] &&
		printf '!  The runtime being installed is not this machine%s architecture%s.\n' "'s" "$ti_rt_note" >> "$ti_warn"

	# ---- what this installation can do that an ordinary one cannot
	# (the block comment above ti_capabilities). Everything it reads is
	# in hand by now: the chosen block, the prerequisites this machine
	# actually needs, the source line, and the record -- whose `install`
	# field is what says whose command installs the project. The plan's
	# `record` line has been checked against that record's hash, so the
	# record is exactly as trustworthy as the plan and no new plan key
	# is needed to carry the answer.
	ti_src_name= ti_src_sha=
	if [ -n "$src" ]; then
		IFS=$tab
		set -- $src
		IFS=$ifs0
		ti_src_name=$1 ti_src_sha=${2:-}
	fi
	ti_ins_cmd=$(ti_sel1 install)
	ti_ins_who=unknown
	if [ -n "$TI_REC" ]; then
		case $(ti_get "$TI_REC" install) in
		'' | default | default:*) ti_ins_who=ours ;;
		*) ti_ins_who=publisher ;;
		esac
	fi
	ti_caps=$TI_WORK/capabilities.txt
	ti_capabilities > "$ti_caps"
	ti_cap_n=$(wc -l < "$ti_caps" | tr -d ' ')
	{
		printf 'What this install can do that an ordinary one cannot: %s found' "$ti_cap_n"
		[ "$ti_plan_sigstate" != ok ] && printf ', and nothing vouches for the plan they were read from'
		printf '.\n'
		sed 's/^/  - /' "$ti_caps"
	} >> "$TI_LOG"

	# What this screen is *not* saying (design.md section 3, "What we do
	# not vouch for"). Everything else here is about our side of it --
	# every file checked against its SHA-256, where things go, who signed
	# the installer -- and someone who reads all that care can reasonably
	# come away thinking the program has been vetted. It has not: we have
	# never looked at it.
	#
	# It sits with the capability statement and not in the heading from
	# 2026-09-21, and the two are written by one code path on purpose
	# (launch-shapes.md section 8, "Placement"): they are two different
	# claims -- one about the installation, one about the program -- and
	# a conditional that can render one without the other is a
	# conditional that will eventually do it.
	ti_vouch="That is about the install. The program itself is another matter: we did not write \"$TI_NAME_DISP\" and have not checked what its code does. Install it only if you trust whoever publishes it."

	{
		printf '======================================================================\n'
		printf 'TiddlyInstall - Review before installing\n'
		printf '======================================================================\n'
		printf '\n%s\n' "$TI_NAME_DISP"
		printf '\nNO CHANGES HAVE BEEN MADE YET.\n'

		# What happens to this machine, as a list, before any detail.
		# Generated, never fixed: a reassuring list of seven bullets
		# that does not change when the install does would be the most
		# misleading thing on the screen.
		printf '\nThis installer will:\n\n'
		if [ "$ti_nall" -gt 0 ]; then
			if [ "$ti_packed_all" = 1 ]; then
				printf '  * Unpack %s %s carried inside it, checking each against a SHA-256\n' \
					"$ti_nall" "$(ti_plural "$ti_nall" file files)" | ti_wrap 74 4
			else
				printf '  * Download %s %s, %s%s, checking each against a SHA-256\n' \
					"$ti_nall" "$(ti_plural "$ti_nall" file files)" "$ti_tot_pre" "$(ti_hsize $ti_tot)" | ti_wrap 74 4
			fi
		fi
		if [ "$TI_SYSTEM" = 1 ]; then
			printf '  * Install for every user on this machine\n'
		else
			printf '  * Install for your user account only\n'
		fi
		[ -n "$a_name" ] && printf '  * Set up the %s runtime in a folder of its own\n' \
			"$(printf '%s' "${ti_rt_line:-$a_name}" | sed 's/,.*//')" | ti_wrap 74 4
		if [ "$TI_MENU" != 0 ]; then
			printf '  * Add an application menu entry and an uninstaller\n'
		else
			printf '  * Add an uninstaller, and no menu entry\n'
		fi
		ti_want_desktop && printf '  * Add a desktop shortcut\n'
		printf '  * Make no changes to PATH\n'
		if [ $need_root = 1 ]; then
			printf '  * Require administrator rights%s\n' "$([ -n "$ti_need_pkgs" ] && printf ', for the system packages only' || printf '')" | ti_wrap 74 4
		else
			printf '  * Require no administrator rights\n'
		fi
		# The findings, in the same list, marked apart. These are the
		# whole point of the screen and must never be summarised away.
		if [ "$ti_cap_n" -gt 0 ]; then
			printf '\nBeyond an ordinary install:\n\n'
			while IFS= read -r c; do
				printf '  ! %s\n' "$c" | ti_wrap 74 4
			done < "$ti_caps"
		fi
		if [ -s "$ti_warn" ]; then
			printf '\nWARNINGS\n\n'
			while IFS= read -r w; do
				printf '%s\n' "$w" | ti_wrap 74 5
			done < "$ti_warn"
		fi

		printf '\nINSTALL SUMMARY\n\n'
		printf '  %-17s%s\n' 'Application' "$TI_NAME_DISP" | ti_wrap 74 19
		[ "$ti_show_project" = 1 ] && printf '  %-17s%s\n' 'Project' "$TI_PROJECT" | ti_wrap 74 19
		printf '  %-17s%s\n' 'Source' "$ti_from_txt" | ti_wrap 74 19
		[ -n "$ti_rt_line" ] && printf '  %-17s%s\n' 'Runtime' "$ti_rt_line" | ti_wrap 74 19
		if [ "$ti_nall" -gt 0 ]; then
			if [ "$ti_packed_all" = 1 ]; then
				printf '  %-17snothing: all %s %s packed inside this installer\n' \
					'Download' "$ti_nall" "$(ti_plural "$ti_nall" 'file is' 'files are')" | ti_wrap 74 19
			else
				printf '  %-17s%s %s, %s%s total\n' \
					'Download' "$ti_nall" "$(ti_plural "$ti_nall" file files)" "$ti_tot_pre" "$(ti_hsize $ti_tot)"
				if [ -n "$ti_hostlist" ] && [ "$ti_nmirror" -gt 0 ]; then
					printf '  %-17s%s, or a mirror of %s\n' 'Sources' "$ti_hostlist" "$(ti_itthem "$ti_nhost")" | ti_wrap 74 19
				elif [ -n "$ti_hostlist" ]; then
					printf '  %-17s%s\n' 'Sources' "$ti_hostlist" | ti_wrap 74 19
				fi
			fi
		fi
		printf '  %-17s%s\n' 'Installs into' "$TI_APP_DIR" | ti_wrap 74 19
		printf '%s' "$TI_DIRMAP" | while IFS="$tab" read -r n d; do
			[ -n "$n" ] && printf '  %-17s%s\n' "$n" "$d" | ti_wrap 74 19
		done
		if [ $need_root = 1 ]; then
			printf '  %-17sRequired%s\n' 'Admin rights' "$([ -n "$ti_need_pkgs" ] && printf ', for the system packages only' || printf '')" | ti_wrap 74 19
		else
			printf '  %-17sNot needed\n' 'Admin rights'
		fi
		printf '  %-17sNot changed\n' 'PATH'
		printf '  %-17s%s\n' 'Install record' "${TI_RECHASH:-none}"

		printf '\nTRUST AND SECURITY\n'
		printf '\n  Installer signature\n'
		printf '  %s\n' "$ti_signed_label"
		[ -n "$ti_signed_why" ] && printf '  %s\n' "$ti_signed_why" | ti_wrap 74 2
		[ -n "$ti_signed_scope" ] && printf '  %s\n' "$ti_signed_scope" | ti_wrap 74 2
		if [ -n "$ti_self_sha" ]; then
			printf '\n  Installer SHA-256\n'
			printf '    %s\n' "$ti_self_sha"
			# Matches both spellings: "UNSIGNED" where signing was
			# possible and skipped, and "NO SIGNATURE..." where the
			# format has nowhere to put one. Either way nothing on this
			# machine vouches for the file, which is what this says.
			case $ti_signed_label in
			UNSIGNED* | 'NO SIGNATURE'*)
				# With no signature on the file, this is the only check
				# left that happens anywhere but inside the file, so it
				# is the one that counts and it says so.
				printf '  %s\n' 'Nothing on this machine can vouch for this file. Compare this with the value shown where you downloaded it: that comparison happens outside the file, which is what makes it worth anything.' | ti_wrap 74 2
				;;
			*)
				printf '  %s\n' 'You can compare this with the value shown by the place you downloaded it from.' | ti_wrap 74 2
				;;
			esac
		fi
		printf '\n  Runtime install script\n'
		# A signature is worth something only when the thing checking it
		# is not the thing being vouched for.
		#
		#   fetched  -- this engine is intact and the network is not, so
		#               a script changed on the way is refused. Real, and
		#               the reason the signature exists at all.
		#   embedded -- the script, the key it is checked against and
		#               the code doing the checking are the same file.
		#               Whoever could change one could change all three,
		#               so the check proves nothing a reader did not
		#               already have to assume. Said plainly rather than
		#               shouted as a verdict.
		#
		# It used to print the same headline for both, which put the
		# loudest claim on the screen in the case where it means least.
		if [ "$ti_rt_state" = ok ] || { [ "$ti_plan_sigstate" = ok ] && [ -n "$TI_PLAN_KEYID" ] && [ "$TI_PLAN_KIND" = fetched ]; }; then
			printf '  SIGNED BY TIDDLYINSTALL\n'
			[ -n "$TI_PLAN_KEYID" ] && printf '    key %s\n' "$TI_PLAN_KEYID"
		fi
		if [ "$ti_plan_sigstate" = ok ] && [ -n "$TI_PLAN_KEYID" ]; then
			if [ "$TI_PLAN_KIND" = fetched ]; then
				printf '  %s\n' 'Fetched over the network and checked here before anything was read, so a script altered on the way would have been refused.' | ti_wrap 74 2
			else
				printf '  %s\n' "Carried inside this file, signed by the TiddlyInstall key $TI_PLAN_KEYID, which says our server produced it." | ti_wrap 74 2
				printf '  %s\n' 'That signature is checked by this file, against a key inside this file. It is worth exactly as much as the file itself, so it is not a second opinion: use the SHA-256 above for that.' | ti_wrap 74 2
			fi
		fi
		if [ "$ti_rt_state" = ok ]; then
			# The steps themselves are ours, proved against a signed
			# root by this file with the key it carries -- no network,
			# no catalogue, and nothing here had to trust the page that
			# built it. This is the claim worth making, and it is a
			# narrower one than "the plan is signed": what is proved is
			# the part we wrote. The headline for it is printed above,
			# once, because a fetched plan earns the same one.
			printf '  %s\n' 'The downloads, their SHA-256s and every command run against them were published by us, and are proved so by this file against a key it carries. Checked here, with no network.' | ti_wrap 74 2
			[ -n "$ti_rt_issued" ] && printf '  %s\n' "Published $ti_rt_issued." | ti_wrap 74 2
			printf '  %s\n' 'Not covered: how it is started, which is the line whoever built this installer wrote.' | ti_wrap 74 2
		elif [ "$ti_rt_state" = bad ]; then
			printf '  %s\n' "The runtime steps claim to be ours and the claim does not hold: $ti_rt_why. Treat this file as altered." | ti_wrap 74 2
		elif [ "$ti_plan_sigstate" = unsigned ]; then
			# Not a warning: the ordinary state of an installer built in
			# a page, which has no key to sign with. What it costs is
			# said once, plainly, and the sentence that used to be here
			# -- "anybody can write one" -- is gone: it was true of every
			# installer ever made, and aimed at our own output.
			printf '  %s\n' 'Not signed. Only our build server holds the key, and a page building in a browser has no way to reach it, so nothing here can say where this script came from.' | ti_wrap 74 2
			printf '  %s\n' 'What it does is listed below in full, and every file it names is checked against the SHA-256 beside it -- though those hashes come from the script itself, so they show a download arrived unchanged and say nothing about what it is.' | ti_wrap 74 2
		elif [ -n "$ti_plan_warn" ]; then
			# The !! line is already under WARNINGS; this is the part
			# that is not a warning but a limit on everything above.
			printf '  %s\n' "See WARNINGS. Nothing vouches for this script, so what this screen says is only what the script itself says. Each file is still checked against the SHA-256 beside it, but those hashes are the script's own: they show a download arrived unchanged, and say nothing about what it is." | ti_wrap 74 2
		elif [ "$TI_PLAN_FROM" != embedded ]; then
			# Where it came from, unless that is "embedded" and the two
			# lines above have just said so at length.
			printf '  %s\n' "$TI_PLAN_FROM" | ti_wrap 74 2
		fi
		[ -n "$ti_age_warn" ] && printf '  %s\n' "$ti_age_warn" | ti_wrap 74 2
		if [ -n "$TI_PLAN_SIGNED" ] && [ "$ti_plan_sigstate" = ok ]; then
			# "(carried in this installer)" is already the whole of the
			# paragraph above in the embedded case; only the fetched
			# case adds anything by saying when.
			ti_pk=
			[ "$TI_PLAN_KIND" = fetched ] && ti_pk=' (fetched now)'
			printf '  Signed on %s%s\n' "$TI_PLAN_SIGNED" "$ti_pk" | ti_wrap 74 2
		fi
		if [ -n "$TI_PLAN_SIGNED" ] && [ "$ti_plan_sigstate" != ok ]; then
			printf '  %s\n' "Written $TI_PLAN_SIGNED, by whoever built this installer." | ti_wrap 74 2
		fi
		[ -n "$ti_revoke_note" ] && printf '  Revocations: %s\n' "$ti_revoke_note" | ti_wrap 74 2
		if [ "$TI_MODE_A" = 1 ]; then
			printf '  %s\n' "Mode A (signed, and carrying no choices of its own): it installs only the app its file name names, from $TI_DEFAULT_BACKEND" | ti_wrap 74 2
		fi
		printf '\n  Choices\n'
		printf '  %s\n' "$TI_ORIGIN" | ti_wrap 74 2
		printf '  %s\n' '(what was picked in the web client; the script above is what carries it out)' | ti_wrap 74 2
		printf '\n  IMPORTANT\n'
		# One statement of this, not three. The scope line under the
		# installer signature ("It covers this installer file, not the
		# program it installs") and the sentence that used to lead this
		# block ("It does not check that the application itself is
		# safe") were the same fact in other words, on a screen whose
		# own rule is that nothing is said twice. This one names the
		# program and says what to do about it, so it is the one kept.
		printf '  %s\n' "$ti_vouch" | ti_wrap 74 2
		# Everything on this screen can be read without running the
		# file, which is worth saying on the screen you only reach by
		# running it.
		printf '\n  %s\n' "You can read all of this without running the installer: open $TI_DEFAULT_BACKEND/#verify and drop this file on it." | ti_wrap 74 2

		printf '\nDOWNLOADS\n'
		if [ "$ti_nall" = 0 ]; then
			printf '\n  Nothing to download.\n'
		else
			printf '\n  %s %s, %s%s total.\n' \
				"$ti_nall" "$(ti_plural "$ti_nall" file files)" "$ti_tot_pre" "$(ti_hsize $ti_tot)"
			[ -n "$ti_ins_cmd" ] &&
				printf '  %s\n' "Installing the project downloads more than these, and nothing in this list covers those: see the findings at the top." | ti_wrap 74 2
		fi
		i=1
		while [ "$i" -le "$nfiles" ]; do
			IFS=$tab
			set -- $(ti_sel file "$i")
			IFS=$ifs0
			d_name=$1 d_file=$2 d_sha=$3 d_size=${4:-}
			d_role=$(ti_file_role "$d_name")
			printf '\n  %s. %s\n' "$i" "${d_role:-$d_name}"
			printf '     File:    %s\n' "$d_file" | ti_wrap 74 14
			ti_size_line "$d_size"
			printf '     SHA-256: %s\n' "$d_sha"
			if { [ -n "$TI_PACK_DIR" ] && [ -f "$TI_PACK_DIR/$d_sha" ]; } || { [ -n "$TI_PACK_TAR" ] && grep -qx "$d_sha" "$TI_WORK/pack.list"; }; then
				printf '     from   the copy packed inside this installer\n'
			fi
			ti_sel url "$i" | ti_from_lines "$ti_ourhost" | ti_wrap 74 12
			i=$((i + 1))
		done
		if [ -n "$src" ]; then
			IFS=$tab
			set -- $src
			IFS=$ifs0
			printf '\n  %s. The application itself\n' "$ti_nall"
			printf '     File:    %s\n' "$1" | ti_wrap 74 14
			case ${2:-} in
			'' | -)
				printf '     size not known in advance: the archive is made when it is fetched\n'
				printf '     no stored SHA-256: identified by its commit, fetched over HTTPS\n'
				;;
			*)
				ti_size_line "$3"
				printf '     SHA-256: %s\n' "$2"
				;;
			esac
			if { [ -n "$TI_PACK_DIR" ] && [ -f "$TI_PACK_DIR/$2" ]; } || { [ -n "$TI_PACK_TAR" ] && grep -qx "$2" "$TI_WORK/pack.list"; }; then
				printf '     from   the copy packed inside this installer\n'
			fi
			ti_sel srcurl | ti_from_lines "$ti_ourhost" | ti_wrap 74 12
		fi

		printf '\nCOMMANDS\n'
		if [ "$ti_nrun" -gt 0 ]; then
			printf '\n  %s\n' "Setting up ${a_name:-the runtime}. These are the runtime install script, written by us, not the project's code." | ti_wrap 74 2
		fi
		ti_stepn=0
		ti_sel step | awk -F"$tab" '$2 == "run" { print $3 "\t" $4 }' |
			while IFS="$tab" read -r c d; do
				ti_stepn=$((ti_stepn + 1))
				if [ -n "$d" ]; then
					printf '\n  %s. %s\n' "$ti_stepn" "$d" | ti_wrap 74 5
				else
					printf '\n  %s. a shell command:\n' "$ti_stepn"
				fi
				ti_cmd_line "$(ti_subst "$c")"
			done
		ins=$(ti_sel1 install)
		if [ -n "$ins" ]; then
			printf '\n  Installing the project:\n'
			ti_cmd_line "$(ti_subst "$ins")"
		fi
		[ "$ti_nrun" = 0 ] && [ -z "$ins" ] && printf '\n  No commands are run on this machine.\n'

		printf '\nAPPLICATION LAUNCH\n'
		printf '\n  %s\n' "When you start \"$TI_NAME_DISP\", its menu entry and launch.sh run:" | ti_wrap 74 2
		ti_cmd_line "$(ti_subst "$(ti_sel1 launch)")"

		printf '\nFILES AND SYSTEM CHANGES\n'
		printf '\n  Everything is stored under %s:\n' "$TI_ROOT"
		printf '    %-14s the app\n' "${TI_APP_DIR##*/}"
		printf '%s' "$TI_DIRMAP" | while IFS="$tab" read -r n d; do [ -n "$n" ] && printf '    %-14s %s\n' "${d##*/}" "$n"; done
		printf '  %s\n' 'The runtime is stored beside the application rather than inside it, so paths within the runtime stay short.' | ti_wrap 74 2
		printf '\n'
		if [ "$TI_MENU" != 0 ]; then
			if [ "$TI_OS" = macos ]; then
				printf '  Folder %s/%s with %s and Uninstall %s\n' "$([ $TI_SYSTEM = 1 ] && echo /Applications || echo "$HOME/Applications")" "$TI_NAME_DISP" "$TI_NAME_DISP" "$TI_NAME_DISP" | ti_wrap 74 2
			else
				printf '  App menu folder "%s" with "%s" and "Uninstall %s" (ti-%s.* in the XDG menu folders)\n' "$TI_NAME_DISP" "$TI_NAME_DISP" "$TI_NAME_DISP" "$TI_APPID" | ti_wrap 74 2
			fi
		else
			printf '  Nothing in the %s (this app asks for no menu entry)\n' "$([ "$TI_OS" = macos ] && echo "Applications folder" || echo "app menu")" | ti_wrap 74 2
			if [ "$TI_OS" = macos ] && ti_want_desktop; then
				ti_mac_safe_name
				printf '  %s/Applications/%s.app, for the desktop shortcut to open\n' "$HOME" "$safe" | ti_wrap 74 2
			fi
		fi
		ti_want_desktop && printf '  A desktop shortcut\n'
		ic=
		[ -n "$TI_REC" ] && [ "$TI_OS" = linux ] && ic=$(ti_get "$TI_REC" icon)
		[ -n "$ic" ] && printf '  Menu icon: the PNG packed in this installer (sha256 %s), copied to %s/icon.png\n' "$ic" "$TI_APP_DIR" | ti_wrap 74 2
		printf '  Uninstaller: %s/uninstall.sh\n' "$TI_APP_DIR" | ti_wrap 74 2
		[ "$TI_MENU" = 0 ] && printf '  To start it: %s/launch.sh\n               or run this installer again\n' "$TI_APP_DIR"
		printf '  PATH: not changed\n'
		printf '  Install log: %s\n' "$TI_LOG" | ti_wrap 74 2
		ti_sel note | sed 's/^/\nNOTE: /' | ti_wrap 74 6
		ti_needs_summary

		printf '\n======================================================================\n'
		printf 'Ready to install "%s".\n' "$TI_NAME_DISP"
		printf 'Nothing has been changed yet.\n'
		printf '======================================================================\n'
	} > "$sum"
	cat "$sum" >> "$TI_LOG"
	# The screen shortens a long command; the log never does.
	if [ "$ti_nrun" -gt 0 ]; then
		{
			printf '\nEvery command in full:\n'
			ti_sel step | awk -F"$tab" '$2 == "run" { print $3 }' |
				while IFS= read -r c; do printf '  %s\n' "$(ti_subst "$c")"; done
			ins=$(ti_sel1 install)
			[ -n "$ins" ] && printf '  install: %s\n' "$(ti_subst "$ins")"
			printf '  launch:  %s\n' "$(ti_subst "$(ti_sel1 launch)")"
		} >> "$TI_LOG"
	fi
	# The screen names where each file comes from and counts the mirrors;
	# the log lists every one, in the order they are tried, so "every URL"
	# is still written down before anything is fetched (design.md 3).
	if [ -s "$ti_urls" ]; then
		{
			printf '\nEvery download location, in the order they are tried:\n'
			i=1
			while [ "$i" -le "$nfiles" ]; do
				IFS=$tab
				set -- $(ti_sel file "$i")
				IFS=$ifs0
				printf '  %s\n' "$2"
				ti_sel url "$i" | sed 's/^/    /'
				i=$((i + 1))
			done
			if [ -n "$src" ]; then
				IFS=$tab
				set -- $src
				IFS=$ifs0
				printf '  %s\n' "$1"
				ti_sel srcurl | sed 's/^/    /'
			fi
		} >> "$TI_LOG"
	fi

	# The short form. This is the **whole** of the macOS dialog, which
	# keeps the full text behind "Details..." -- so on macOS it is not a
	# repeat of anything and stays as it is. It is not printed in a
	# terminal any more: see "decide.txt" below.
	{
		printf 'Install %s?\n\n' "$TI_NAME_DISP"
		# This dialog is the whole of what macOS shows, so the two
		# claims that decide the question have to be in it and not only
		# behind "Details...": what this install can do that an
		# ordinary one cannot, and that the program is not ours. Same
		# order as the screen, and the same strings.
		if [ -n "$ti_plan_warn" ]; then
			printf '%s\n\n' "Nothing vouches for this runtime install script, so what follows is only what the script itself says. Each file is still checked against the SHA-256 beside it, but those hashes are the script's own." | ti_wrap 68 0
		fi
		if [ "$ti_cap_n" = 0 ] && [ -z "$ti_plan_warn" ]; then
			printf '%s\n\n' "$TI_CAP_ORDINARY Nothing here goes beyond that." | ti_wrap 68 0
		else
			if [ "$ti_cap_n" -gt 0 ]; then
				# With no baseline sentence above it (an unsigned plan),
				# "goes beyond that" has nothing to point at, so the
				# lead is the screen's own wording for that case.
				if [ -n "$ti_plan_warn" ]; then
					printf '%s\n' "What it says it does:" | ti_wrap 68 0
				else
					printf '%s\n' "$TI_CAP_ORDINARY $(ti_cap_number "$ti_cap_n") thing$([ "$ti_cap_n" = 1 ] || printf 's') here go$([ "$ti_cap_n" = 1 ] && printf 'es') beyond that:" | ti_wrap 68 0
				fi
				while IFS= read -r c; do
					printf '  - %s\n' "$c" | ti_wrap 68 4
				done < "$ti_caps"
				printf '\n'
			fi
		fi
		printf '%s\n\n' "$ti_vouch" | ti_wrap 68 0
		printf '  From:      %s\n' "$ti_from_txt"
		[ -n "$ti_rt_line" ] && printf '  Runtime:   %s\n' "$ti_rt_line"
		if [ "$ti_nall" -gt 0 ] && [ "$ti_packed_all" != 1 ]; then
			printf '  Download:  %s %s, %s%s\n' \
				"$ti_nall" "$(ti_plural "$ti_nall" file files)" "$ti_tot_pre" "$(ti_hsize $ti_tot)"
			if [ -n "$ti_hostlist" ] && [ "$ti_nmirror" -gt 0 ]; then
				printf '  Sources:   %s, or a mirror of %s\n' \
					"$ti_hostlist" "$(ti_itthem "$ti_nhost")" | ti_wrap 68 13
			elif [ -n "$ti_hostlist" ]; then
				printf '  Sources:   %s\n' "$ti_hostlist" | ti_wrap 68 13
			fi
		fi
		printf '  Into:      %s\n' "$TI_APP_DIR"
		printf '  Signed by: %s\n' "$ti_signed_short" | ti_wrap 68 13
		[ -n "$ti_signed_scope" ] && printf '             %s\n' "$ti_signed_scope" | ti_wrap 68 13
		[ $need_root = 1 ] && printf '  Admin:     yes%s\n' "$([ -n "$ti_need_pkgs" ] && printf ', for system packages only' || printf '')"
		[ -s "$ti_warn" ] && sed 's/^!! /  ! /; s/^!  /  ! /' "$ti_warn" | ti_wrap 68 6
		printf '\nNothing has been changed yet.'
	} > "$TI_WORK/short.txt"

	# What goes above the prompt in a terminal (design.md 3, "How it is
	# shown matters"). The text really is longer than a screen -- around
	# sixty lines for a typical app, against a terminal's twenty-four --
	# so what is being installed and who signed it have scrolled off by
	# the time the question is asked, and something has to stand there.
	#
	# Until now that something was the short form above, reprinted in
	# full: seven lines that say again what the screen said, which is
	# how you teach someone that the screen is not worth reading. What
	# stands there now is the decision and nothing else -- the app, who
	# signed it, whose code it is, where it is going -- on one wrapped
	# line above the question.
	#
	# The `!!` warnings are the exception and are repeated: a plan that
	# is unsigned, stale or withdrawn is the one thing on this screen
	# that should stop somebody, and it is normally not there at all.
	case $ti_signed_short in
	nothing* | nobody*) ti_signed_brief=unsigned ;;
	unknown*) ti_signed_brief='signed by someone this machine cannot identify' ;;
	*) ti_signed_brief="installer signed by $ti_signed_short" ;;
	esac
	{
		grep '^!! ' "$ti_warn" 2>/dev/null | ti_wrap 74 3
		printf '%s: %s%s, into %s. Its code is its publisher%s, not ours. Nothing has been changed yet.\n' \
			"$TI_NAME_DISP" "$ti_signed_brief" \
			"$([ $need_root = 1 ] && printf ', needs administrator rights' || printf '')" \
			"$TI_APP_DIR" "'s" | ti_wrap 74 0
	} > "$TI_WORK/decide.txt"
	ti_confirm "TiddlyInstall" "$sum" "Install $TI_NAME_DISP?" || { ti_say "Cancelled; nothing was installed."; [ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG"; exit 1; }

	if [ $need_root = 1 ] && [ "$(id -u)" != 0 ]; then
		ti_elevate
		rc=$?
		ti_want_desktop && ti_desk_made=1
		[ $rc = 0 ] && [ "$opt_yes" != 1 ] && [ "$ti_ui" != tty ] && ti_message info "TiddlyInstall" "$TI_NAME_DISP is installed.${nl}${nl}$(ti_start_hint)"
		[ $rc = 0 ] || ti_fail "The administrator install did not finish."
		exit $rc
	fi

	# ---- install
	ti_needs_install
	ti_progress_start "Installing $TI_NAME_DISP…"
	: > "$TI_WORK/shortcuts"
	# An earlier install of this app (--reinstall, an older engine's install
	# with no marker, or one that was interrupted) is removed first, as its
	# uninstaller would; anything else in the way stops the install.
	if [ -e "$TI_APP_DIR" ]; then
		o=$(ti_get "$TI_APP_DIR/.ti-owner" appid 2>/dev/null)
		m=$(ti_get "$TI_APP_DIR/manifest.txt" appid 2>/dev/null)
		if [ "$o" = "$TI_APPID" ] && { [ -z "$m" ] || [ "$m" = "$TI_APPID" ]; }; then
			ti_say "Removing the earlier install in $TI_APP_DIR"
			ti_remove_app "$TI_APP_DIR" "$TI_APPID"
			[ -e "$TI_APP_DIR" ] && ti_fail "Could not remove the earlier install in $TI_APP_DIR."
		elif [ -n "$m" ] && [ "$m" != "$TI_APPID" ]; then
			ti_fail "$TI_APP_DIR belongs to another app ($m). Not installing."
		else
			ti_fail "$TI_APP_DIR already exists and is not this app's (a leftover?). Remove it, then try again."
		fi
	fi
	TI_CREATED=$TI_WORK/created
	: > "$TI_CREATED"
	ti_mkdirs "$TI_ROOT" || ti_fail "Could not create $TI_ROOT"
	mkdir "$TI_APP_DIR" || ti_fail "Could not create $TI_APP_DIR"
	ti_created r "$TI_APP_DIR"
	printf 'ti-folder\t1\nappid\t%s\nname\t(app)\n' "$TI_APPID" > "$TI_APP_DIR/.ti-owner" || ti_fail "Could not write $TI_APP_DIR/.ti-owner"
	mkdir -p "$TI_DATA_DIR" "$TI_TMP/dl"

	i=1
	while [ "$i" -le "$nfiles" ]; do
		IFS=$tab
		set -- $(ti_sel file "$i")
		IFS=$ifs0
		f_name=$1 f_file=$2 f_sha=$3
		d=$(printf '%s' "$TI_DIRMAP" | awk -F'\t' -v n="$f_name" '$1 == n { print $2; exit }')
		if [ -e "$d" ]; then
			o=$(ti_get "$d/.ti-owner" appid 2>/dev/null)
			[ "$o" = "$TI_APPID" ] || ti_fail "$d already exists and is not this app's; not installing."
			rm -rf "$d"
		fi
		mkdir "$d" || ti_fail "Could not create $d"
		ti_created r "$d"
		printf 'ti-folder\t1\nappid\t%s\nname\t%s\nfile\t%s\n' "$TI_APPID" "$f_name" "$f_file" > "$d/.ti-owner"
		mkdir -p "$TI_TMP/dl/$i"
		export TI_CUR_DIR="$d" TI_CUR_FILE="$TI_TMP/dl/$i/$f_file"
		ti_say "Getting $f_file"
		ti_sel url "$i" > "$TI_WORK/urls"
		ti_obtain "$f_sha" "$TI_CUR_FILE" "$TI_WORK/urls" "$f_file" ||
			ti_fail "Could not get $f_file with the expected SHA-256 from any source."
		ti_sel step "$i" > "$TI_WORK/steps.$i"
		if [ ! -s "$TI_WORK/steps.$i" ]; then
			cp "$TI_CUR_FILE" "$d/" || ti_fail "Could not copy $f_file into $d"
		fi
		while IFS= read -r st <&5; do
			IFS=$tab
			set -- $st
			IFS=$ifs0
			ti_step "$@"
		done 5< "$TI_WORK/steps.$i"
		rm -f "$TI_CUR_FILE"
		i=$((i + 1))
	done
	export TI_CUR_DIR="$TI_APP_DIR" TI_CUR_FILE=

	if [ -n "$src" ]; then
		IFS=$tab
		set -- $src
		IFS=$ifs0
		s_file=$1 s_sha=$2 s_fmt=$4 s_strip=${5:-0}
		ti_say "Getting the project ($s_file)"
		ti_sel srcurl > "$TI_WORK/urls"
		mkdir -p "$TI_TMP/dl/src"
		# The app's own source is the one file allowed to have no stored
		# hash (format.md, "Sources without a stored hash").
		ti_obtain "$s_sha" "$TI_TMP/dl/src/$s_file" "$TI_WORK/urls" "$s_file" unpinned ||
			if [ -z "$s_sha" ] || [ "$s_sha" = - ]; then
				ti_fail "Could not download the project ($s_file) over HTTPS from any source."
			else
				ti_fail "Could not get the project ($s_file) with the expected SHA-256 from any source."
			fi
		ti_unpack "$s_fmt" "$TI_TMP/dl/src/$s_file" "$TI_APP_DIR" "$s_strip" ||
			ti_fail "Could not unpack the project ($s_file)."
	fi

	ins=$(ti_sel1 install)
	if [ -n "$ins" ]; then
		c=$(ti_subst "$ins")
		ti_say "Installing the project: $c"
		(ti_apply_env 1 && cd "$TI_APP_DIR" && sh -c "$c") < /dev/null >> "$TI_LOG" 2>&1 ||
			ti_fail "The project's install command failed: $c"
	fi

	# ---- launch.txt, launcher, uninstaller
	l=$(ti_sel1 launch)
	[ -n "$l" ] || ti_fail "The plan has no launch command."
	{
		printf 'ti-launch\t1\n'
		printf 'cwd\t%s\n' "$TI_APP_DIR"
		ti_sel env | while IFS="$tab" read -r n v; do printf 'env\t%s\t%s\n' "$n" "$(ti_subst "$v")"; done
		ti_sel unset | while IFS= read -r n; do printf 'unset\t%s\n' "$n"; done
		ti_sel path | while IFS= read -r p; do printf 'path\t%s\n' "$(ti_subst "$p")"; done
		printf 'console\t%s\n' "${TI_CONSOLE:-0}"
		printf 'exec\t%s\n' "$(ti_subst "$l")"
	} > "$TI_APP_DIR/launch.txt"
	ti_write_launcher
	head -c "$TI_ENGINE_LEN" "$TI_SELF" > "$TI_APP_DIR/uninstall.sh" && chmod 755 "$TI_APP_DIR/uninstall.sh" ||
		ti_fail "Could not write the uninstaller."

	ti_install_icon
	if [ "$TI_OS" = macos ]; then ti_menus_macos; else ti_menus_linux; fi

	{
		printf 'ti-manifest\t1\n'
		printf 'name\t%s\n' "$TI_NAME_DISP"
		printf 'appid\t%s\n' "$TI_APPID"
		printf 'record\t%s\n' "$TI_RECHASH"
		printf 'installed\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf '%s' "$TI_DIRMAP" | while IFS="$tab" read -r n d; do [ -n "$d" ] && printf 'dir\t%s\n' "$d"; done
		cat "$TI_WORK/shortcuts"
		# Folders this install created outside the root, deepest first;
		# the uninstaller removes them only if they are empty.
		awk -F'\t' -v root="$TI_ROOT" '$1 == "e" && $2 != root && index($2, root "/") != 1 {
				if (index(root "/", $2 "/") == 1) b[++m] = $2; else a[++n] = $2 }
			END { for (i = n; i > 0; i--) print "shortcut\t" a[i]; for (i = m; i > 0; i--) print "shortcut\t" b[i] }' "$TI_CREATED"
	} > "$TI_APP_DIR/manifest.txt" || ti_fail "Could not write the manifest."

	# ---- the "fully installed" marker: the last thing a successful install
	# writes (docs/format.md section 5), renamed into place so it is never
	# half written. Running the installer again with the same record then
	# starts the app instead of installing it again.
	printf 'ti-installed\t1\nappid\t%s\nrecord\t%s\ninstalled\t%s\n' "$TI_APPID" "$TI_RECHASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		> "$TI_APP_DIR/.ti-installed.tmp" && mv -f "$TI_APP_DIR/.ti-installed.tmp" "$TI_APP_DIR/.ti-installed" ||
		ti_fail "Could not write $TI_APP_DIR/.ti-installed"

	ti_progress_stop
	TI_CREATED=
	ti_say "Installed $TI_NAME_DISP in $TI_APP_DIR"
	ti_log "Launcher: $TI_APP_DIR/launch.sh"
	hint=$(ti_start_hint)
	printf '%s\n' "$hint" | while IFS= read -r h; do ti_say "$h"; done
	cp "$TI_LOG" "$TI_APP_DIR/install.log" 2>/dev/null
	if [ "$opt_yes" != 1 ] && [ "$ti_ui" != tty ]; then
		if ti_finish_dialog "$TI_NAME_DISP is installed.${nl}${nl}$hint${nl}${nl}Log: $TI_APP_DIR/install.log"; then
			ti_start_detached
			# install.log was copied before the dialog, so that the path
			# the dialog names exists while it is on screen. Copy it
			# again now, or the log of this install is the only one that
			# does not say the app was started from it.
			cp "$TI_LOG" "$TI_APP_DIR/install.log" 2>/dev/null
		fi
	fi
	[ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG" && TI_LOG=
	return 0
}

ti_usage() {
	cat <<'EOF'
TiddlyInstall (Linux and macOS)

  --yes               install (or uninstall) without asking
  --log=PATH          write the log to PATH
  --record=PATH       use this ti-record file
  --plan=PATH         use this ti-plan file (else the plan is fetched); it
                      must be signed by the TiddlyInstall key
  --unsigned-plan     accept an unsigned --plan or install.txt plan
  --reinstall         install again even if this app, with these same
                      settings, is already installed (otherwise running the
                      installer again starts the app, or with --yes just
                      says it is installed)
  --backend=URL       where to fetch records and plans
  --uninstall         remove the app this uninstall.sh belongs to

With no arguments and a screen to draw on, the review is shown in a
window; with any argument it is printed here instead. TI_NO_GUI=1
forces the text either way.
EOF
}

ti_main() {
	# Any argument at all means this run is being driven rather than
	# double-clicked, and the review goes to the terminal as text
	# (ti_pick_ui). The Finder's own -psn_... is not one anybody typed.
	ti_args=0
	for a in "$@"; do
		case $a in -psn_*) ;; *) ti_args=$((ti_args + 1)) ;; esac
	done
	for a in "$@"; do
		case $a in
		--record=*) opt_record=$(ti_abs "${a#*=}") ;;
		--plan=*) opt_plan=$(ti_abs "${a#*=}") ;;
		--unsigned-plan) opt_unsigned=1 ;;
		--backend=*) opt_backend=${a#*=} ;;
		--log=*) opt_log=$(ti_abs "${a#*=}") ;;
		--yes | -y) opt_yes=1 ;;
		--reinstall) opt_reinstall=1 ;;
		--uninstall) opt_uninstall=1 ;;
		--ti-origin=*) opt_origin=${a#*=} ;;
		--help | -h) ti_usage; exit 0 ;;
		-psn_*) ;; # old macOS Finder launch argument
		*) printf 'Unknown option: %s\n' "$a" >&2; ti_usage >&2; exit 2 ;;
		esac
	done
	ti_detect_os
	ti_pick_ui
	TI_WORK=$(mktemp -d "${TMPDIR:-/tmp}/ti.XXXXXX") || { echo "mktemp failed" >&2; exit 1; }
	TI_HOME_TMP=$TI_WORK/home
	mkdir "$TI_HOME_TMP" || { echo "mktemp failed" >&2; exit 1; }
	trap ti_cleanup EXIT
	trap 'ti_fail "Interrupted."' INT TERM HUP
	if [ -n "$opt_log" ]; then
		TI_LOG=$opt_log
		: >> "$TI_LOG" || { echo "Can't write $TI_LOG" >&2; exit 1; }
	else
		TI_LOG=${TMPDIR:-/tmp}/ti-$(date +%Y%m%d-%H%M%S)-$$.log
		: > "$TI_LOG"
		ti_log_is_temp=1
	fi
	ti_log "TiddlyInstall engine $TI_ENGINE_VERSION, $(date -u +%Y-%m-%dT%H:%M:%SZ)"

	s=$0
	# `sh file.run` gives a bare name; a file here wins over a PATH lookup.
	case $s in */*) ;; *) [ -f "$s" ] || s=$(command -v "$s") ;; esac
	TI_SELF=$(ti_abs "$s")
	TI_BUNDLE=
	case $TI_SELF in
	*.app/Contents/MacOS/*) TI_BUNDLE=${TI_SELF%/Contents/MacOS/*} ;;
	esac
	if [ -n "$TI_BUNDLE" ]; then
		TI_NAME=$(basename "$TI_BUNDLE" .app)
		TI_HOME_DIR=$(dirname "$TI_BUNDLE")
	else
		TI_NAME=$(basename "$TI_SELF")
		TI_NAME=${TI_NAME%.run}
		TI_NAME=${TI_NAME%.sh}
		TI_HOME_DIR=$(dirname "$TI_SELF")
	fi
	ti_log "Running as $TI_SELF on $TI_OSDESC"

	if [ "$opt_uninstall" = 1 ] ||
		{ [ "$(basename "$TI_SELF")" = uninstall.sh ] && [ -f "$(dirname "$TI_SELF")/manifest.txt" ]; }; then
		ti_uninstall
		[ "$ti_log_is_temp" = 1 ] && rm -f "$TI_LOG"
		exit 0
	fi
	ti_install_main
}

ti_main "$@"
exit $?
