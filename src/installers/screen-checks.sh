# The review screen's assertions, shared by both engines.
#
# Why they are in one file. The screen is written twice -- ti-engine.sh
# prints it on Linux and macOS, base.nsi prints it on Windows -- and the
# whole claim of docs/design.md section 3 is that the two say the same
# thing. Two copies of the checks would drift exactly as the two copies
# of the text do, and it is the text that keeps being wrong: every fault
# found in this screen since 2026-09-21 was in what it *says*, and every
# suite that checks what the engine *does* passed through all of them.
#
# So one fixture (../test-proved.plan, which carries both a windows and
# a linux target) goes through both engines, and both are read here.
#
# The caller provides `ok MSG` and `no MSG [DETAIL]`, and sets $fail.
# Usage: screen_check <rendered-file> <case> <engine>
#   case: proved   the plan is signed and the setup is proved ours
#         unsigned the signature is gone, the proof is not
#         bare     neither, so nothing vouches for the setup

screen_check() {
	sc_f=$1 sc_case=$2 sc_eng=$3
	sc_has() { grep -qF "$1" "$sc_f"; }
	sc_hasnt() { ! grep -qF "$1" "$sc_f"; }
	sc_re() { grep -qE "$1" "$sc_f"; }
	sc_say() { printf '%s/%s: %s' "$sc_eng" "$sc_case" "$1"; }

	# ---- the shape, on every case
	sc_has 'TiddlyInstall - Review before installing "Hello python"' &&
		ok "$(sc_say 'the title names the app, in quotes')" ||
		no "$(sc_say 'the title names the app, in quotes')" "$(head -2 "$sc_f")"
	sc_has 'NOTHING HAS BEEN CHANGED YET.' &&
		ok "$(sc_say 'it says nothing has happened yet')" ||
		no "$(sc_say 'it says nothing has happened yet')"

	# Every section, in the order a reader meets them. Order matters:
	# the sections answer questions in the order somebody asks them.
	sc_order=$(grep -nE '^[A-Z][A-Z ]+$' "$sc_f" | sed 's/^[0-9]*://' |
		grep -E '^(WHAT WILL HAPPEN|BEFORE YOU TRUST IT|DOWNLOADS|WHERE THINGS GO|WHAT RUNS)$' | tr '\n' '/')
	if [ "$sc_order" = 'WHAT WILL HAPPEN/BEFORE YOU TRUST IT/DOWNLOADS/WHERE THINGS GO/WHAT RUNS/' ]; then
		ok "$(sc_say 'five sections, in order')"
	else
		no "$(sc_say 'five sections, in order')" "got: $sc_order"
	fi

	# Nothing from the screen this one replaced. A heading that comes
	# back is a section printed twice, which is how the old shape and
	# the new one ended up on one screen while both engines were being
	# moved over.
	for sc_g in 'INSTALL SUMMARY' 'TRUST AND SECURITY' 'APPLICATION LAUNCH' \
		'FILES AND SYSTEM CHANGES' 'COMMANDS' 'This installer will:' \
		'NO CHANGES HAVE BEEN MADE'; do
		sc_hasnt "$sc_g" && ok "$(sc_say "nothing still says \"$sc_g\"")" ||
			no "$(sc_say "nothing still says \"$sc_g\"")" "$(grep -n "$sc_g" "$sc_f" | head -1)"
	done

	# ---- the marks
	#
	# Two spaces, the mark, and the text at column five, so every
	# wrapped line lines up under it. Windows renders this with a real
	# hanging indent (tisig.c mark_cols) and reads the shape to find it,
	# so a mark in the wrong column is not a cosmetic fault there: the
	# item stops being an item and comes out as a grey monospace block.
	# `!! ` is the WARNINGS block's own mark and not one of these: it is
	# a line the reader is meant to stop on, not an item in a column,
	# and it keeps the shape it had before this screen existed.
	sc_bad=$(grep -nE '^  (!|ok|--)' "$sc_f" | grep -vE '^[0-9]+:  !! ' |
		grep -vE '^[0-9]+:  (!  |ok |-- )[^ ]' || true)
	if [ -n "$sc_bad" ]; then
		no "$(sc_say 'every mark puts its text in column five')" "$(printf '%s' "$sc_bad" | head -3)"
	else
		ok "$(sc_say 'every mark puts its text in column five')"
	fi
	sc_re '^  !  TiddlyInstall did not write or review "Hello python"' &&
		ok "$(sc_say 'the program is disclaimed first, by name')" ||
		no "$(sc_say 'the program is disclaimed first, by name')"
	sc_has 'Verify without running: drop this file on' &&
		ok "$(sc_say 'it points at the Verify page')" ||
		no "$(sc_say 'it points at the Verify page')"

	# ---- our own keys are never shown as things we cannot describe
	#
	# rtroots and rtproof carry the proof. An installer that reports
	# them as unrecognised is telling the reader our own signature is
	# something it cannot account for. Found twice by the operator, once
	# per engine, because each has its own list of keys it knows.
	sc_hasnt 'does not recognise' &&
		ok "$(sc_say 'it does not call our own proof unrecognisable')" ||
		no "$(sc_say 'it does not call our own proof unrecognisable')" "$(grep -n 'does not recognise' "$sc_f" | head -1)"
	sc_hasnt 'rtroots' && sc_hasnt 'rtproof' &&
		ok "$(sc_say 'the proof keys never reach the reader')" ||
		no "$(sc_say 'the proof keys never reach the reader')" "$(grep -n 'rtroot\|rtproof' "$sc_f" | head -1)"

	# ---- wrapping
	#
	# Both engines wrap at 74. A line past 80 is a line that did not
	# wrap, except where a single unbreakable token -- a hash, a
	# Windows path -- is itself that long.
	sc_long=$(awk 'length($0) > 80 { n = split($0, t, " "); m = 0
		for (i = 1; i <= n; i++) if (length(t[i]) > m) m = length(t[i])
		if (m < 60) printf "%d: %s\n", NR, substr($0, 1, 90) }' "$sc_f")
	if [ -n "$sc_long" ]; then
		no "$(sc_say 'every line wraps')" "$(printf '%s' "$sc_long" | head -3)"
	else
		ok "$(sc_say 'every line wraps')"
	fi

	# ---- no heading with nothing under it
	sc_empty=$(awk '/^[A-Z][A-Z ]+$/ { if (prev_head) print NR": "prev" then "$0; prev_head = 1; prev = $0; next }
		{ if (NF) prev_head = 0 }' "$sc_f")
	if [ -n "$sc_empty" ]; then
		no "$(sc_say 'no heading with nothing under it')" "$sc_empty"
	else
		ok "$(sc_say 'no heading with nothing under it')"
	fi

	# ---- what each case must say
	case $sc_case in
	proved | unsigned)
		# The proof does not depend on the plan's own signature, so
		# stripping the signature must not change this line.
		sc_n=$(grep -c '^  ok Runtime setup is signed by TiddlyInstall' "$sc_f" || true)
		[ "$sc_n" = 1 ] && ok "$(sc_say 'a proved setup says so, once')" ||
			no "$(sc_say 'a proved setup says so, once')" "$sc_n occurrences"
		sc_has 'verified offline' && ok "$(sc_say 'and says it was checked with no network')" ||
			no "$(sc_say 'and says it was checked with no network')"
		sc_has 'not the launch command' && ok "$(sc_say 'and what it does not cover')" ||
			no "$(sc_say 'and what it does not cover')"

		# Proved steps are not printed: the signature was added so
		# nobody has to read them, and a screenful of msiexec is how a
		# reader learns to scroll past the whole thing.
		sc_has 'proved above' && ok "$(sc_say 'WHAT RUNS summarises the proved setup')" ||
			no "$(sc_say 'WHAT RUNS summarises the proved setup')" "$(sed -n '/^WHAT RUNS/,$p' "$sc_f" | head -4)"
		sc_runs=$(sed -n '/^WHAT RUNS/,$p' "$sc_f" | grep -c . || true)
		[ "$sc_runs" -le 12 ] && ok "$(sc_say 'and does not list them')" ||
			no "$(sc_say 'and does not list them')" "$sc_runs lines under WHAT RUNS"
		;;
	bare)
		sc_has 'Runtime setup is not signed' &&
			ok "$(sc_say 'an unproved setup says nothing vouches for it')" ||
			no "$(sc_say 'an unproved setup says nothing vouches for it')" "$(sed -n '/BEFORE YOU TRUST/,/^DOWNLOADS/p' "$sc_f" | head -20)"
		sc_hasnt 'Runtime setup is signed by' &&
			ok "$(sc_say 'and is not called signed')" ||
			no "$(sc_say 'and is not called signed')"
		# ...and then the steps ARE printed, because reading them is
		# all a person has left.
		sc_has 'WHAT RUNS' && sc_re '^  Setup +[^ ]' &&
			ok "$(sc_say 'WHAT RUNS lists the setup in full')" ||
			no "$(sc_say 'WHAT RUNS lists the setup in full')"
		;;
	esac

	# ---- the ordinary state of our own output is never an alarm
	#
	# A page holds no key, so every installer built without a server has
	# an unsigned plan. Meeting that with a red WARNINGS block reading
	# "is not signed by the TiddlyInstall key" is the screen calling our
	# own commonest output suspect, and it teaches people that the red
	# block means nothing. The Windows engine did it for months, because
	# its test for "unsigned" was an exact match against a string that
	# carries a reason after it (found by the operator, 2026-09-23).
	case $sc_case in
	proved | unsigned | bare)
		sc_hasnt '!!' && ok "$(sc_say 'nothing is shouted at the reader')" ||
			no "$(sc_say 'nothing is shouted at the reader')" "$(grep -n '!!' "$sc_f" | head -2)"
		sc_hasnt 'WARNINGS' && ok "$(sc_say 'and there is no WARNINGS block')" ||
			no "$(sc_say 'and there is no WARNINGS block')" "$(grep -n -A2 'WARNINGS' "$sc_f" | head -4)"
		;;
	esac
}
