# Working on TiddlyInstall

## Never put anything on the operator's screen

This machine has a person sitting at it, working, while you run. Their
display is not a test environment.

**Never `DISPLAY=:0`, and never leave `DISPLAY` unset where it could
default to it.** The same goes for `WAYLAND_DISPLAY`. If a command could
open a window — an installer, `zenity`, `kdialog`, `xdg-open`, a browser,
a screenshot tool — it gets a display you created, or it runs on a test
machine.

This has happened four times. Each time the agent had been told not to,
and each time it happened by accident rather than by intent, so treat the
rules below as the actual protection:

- **The engine opens a GUI whenever it has a display and no arguments**
  (changed 2026-09-21; it used to need a missing tty as well, and that
  is what the first four accidents were). `sh installer.run` with a
  display in the environment now goes straight to a window, tty or no
  tty — that is what a person at a desktop should get, and it is why
  this is the easiest rule in the file to trip. Piping the output or
  running it under `script` still does it too. **For any local run of
  the engine, use `env -u DISPLAY -u WAYLAND_DISPLAY ./installer.run`**,
  and pass `TI_NO_GUI=1` as a belt if the environment is not yours to
  control. A run with any argument at all (`--yes`, `--log=`, …) prints
  text and opens nothing, so the unattended harness paths are safe.
- **Check the environment the installer will inherit**, not your own
  shell's, and check it before every GUI run rather than once at the
  start.
- **Anything that loops must not be able to reopen a window after it is
  killed.** A respawning dialog is far worse than a single stray one:
  closing it does not work, which is maddening for the person at the
  keyboard.
- **`10.0.1.123` (Windows 11) has a live logged-in console session** and
  counts exactly as `:0` does. No console-session installs, no
  screenshots. Drive it with `/S /log=` instead. `docs/local/test-vms.md` has
  the detail.

Where to run GUI things instead, in order of preference:

1. **A test VM with a desktop** — Debian 12 i386 `x@10.0.1.160` (Xfce,
   zenity, kdialog, xdotool), Fedora `x@10.0.1.224`, GhostBSD
   `x@10.0.1.152`. Take the lock (`tests/arch/vmlock.py`).
2. **Xvfb on a high display number** on this machine (`:77`, `:99`), torn
   down afterwards. Never `:0`.

If you genuinely cannot capture something any other way, ask the operator
first. A missing screenshot is a small cost; interrupting someone's work
every few minutes is not.

## Other standing rules

- **No whole-tree git commands and no history rewriting.** Several agents
  share this checkout. No `git stash`, `git checkout .`, `git reset
  --hard`, `git clean`, or `git commit --amend` — two agents have wiped
  other agents' uncommitted work this way and recovered by luck. Stage
  explicit paths, and run `git diff --cached --stat` before every commit
  to be sure you are committing only your own files.
- **Never commit `prompts/`, `out/`, `node_modules` or data folders.**
- **`pkill -f` and `pgrep -f` with a broad pattern match your own shell**
  and the waiter watching for them. This has cost hours here — once,
  sixteen watcher shells span for eight hours on a pattern that matched
  themselves. Use explicit PIDs, or a bracket (`[p]attern`).
- **The scratchpad is shared between agents.** Work in a subdirectory of
  your own; agents have overwritten each other's scripts.
- **Credentials are never written to a file, a script, a log or a
  commit.** ESXi credentials are deliberately not available to agents.
- **Build `out/` only from committed code**, in a clean worktree, and
  after changing an engine, rebuild the bases — the macOS one **on the
  Mac**, never here, or it loses its ad-hoc signature and moves 48 golden
  observations for no reason.

## What this project is for

Every claim the installer makes on its review screen is the product. If
you cannot verify something, the screen should say so plainly rather than
imply it — a promise that is narrower than it reads is the failure mode
this project exists to avoid, and it has appeared four times already: a
mirror lookup that silently matched nothing, test grids showing verdicts
a later run had replaced, a harness grepping for a line no engine wrote,
and a watcher that could never fire. **A broken measurement and a clean
result look identical.** Check that your check works.
