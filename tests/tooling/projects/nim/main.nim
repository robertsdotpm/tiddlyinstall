# Nim's toolchain. The site's Nim plans compile main.nim with `nim c`
# (policy install_command), which for a compiled runtime overrides a
# publisher's own install command, so nimble is never reached: see
# docs/test-results.md, "Package managers and tooling".
import json, strutils

proc say(state, name, detail: string) =
  echo "TOOL ", state, " ", name, ": ", detail

say("ok", "nim-compile", "this program was compiled by `nim c` at install time, through the C toolchain")
say("ok", "json", "std/json made " & $(%*{"a": 1}))
say("ok", "stdlib", "NimVersion " & NimVersion & " on " & hostOS & "/" & hostCPU &
    ", strutils " & "ok".toUpperAscii)
echo "TOOL runtime nim ", NimVersion
echo "TOOL end"
