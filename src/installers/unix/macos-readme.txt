TiddlyInstall
-------------

WHAT THIS IS

The app beside this file is an installer. It installs one particular
program -- the one it names on its first screen -- and it is not that
program itself.

It installs nothing until you say so. When you open it, it shows you
everything it would do: what it downloads and from where, where it
puts it, and what it runs. Nothing on this machine changes until you
have read that and agreed to it.


HOW TO RUN IT

Double-click the app beside this file.


WHAT WILL PROBABLY HAPPEN THE FIRST TIME

If this arrived in a web browser, macOS will very likely refuse to
open it. On macOS 15 and later the app is killed outright, and the
dialog you get explains nothing and offers no way forward -- there is
no "Open Anyway" button in it. Nothing is damaged and you have done
nothing wrong.

Here is the way through:

  1. Dismiss the dialog.
  2. Open System Settings, then Privacy & Security.
  3. Scroll down to the security section. The app you just tried to
     open is named there, with an "Open Anyway" button beside it.
     Press it, and authenticate if you are asked.
  4. Open the app again.

Control-click, then Open, is the old advice and no longer works:
Apple removed that route in macOS 15.

If you are comfortable in a terminal, one command does the same job:

  xattr -dr com.apple.quarantine /path/to/the.app

and then the app opens normally.


WHY THIS HAPPENS

We do not have an Apple Developer ID, so our installers are unsigned
and not notarized, and Apple's check has nothing to verify. It cannot
tell "built by someone with no Apple account" apart from "tampered
with", so it refuses. That is a fact about us, not a defect in this
file and not something you did.


IT ONLY HAPPENS TO BROWSER DOWNLOADS

macOS marks files that arrive through a web browser, and only those.
A copy that reached you any other way -- curl, scp, a USB stick, an
internal file share -- carries no such mark and simply opens.
