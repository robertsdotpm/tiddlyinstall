# Fidelity check: Nim's standard library HTTP client over TLS, and threads
# (docs/test-results.md, "Real-app fidelity"). config.nims turns on -d:ssl, as real apps do.
import std/[httpclient, json, strutils, typedthreads]

proc check(name: string, fn: proc (): string) =
  try:
    let d = fn()
    echo "FID ok ", name, (if d.len > 0: ": " & d else: "")
  except CatchableError as e:
    echo "FID fail ", name, ": ", e.name, ": ", e.msg.replace("\n", " ")

echo "FID start nim ", NimVersion, " ", hostOS, "/", hostCPU
check("https", proc (): string =
  let c = newHttpClient(timeout = 60_000)
  defer: c.close()
  let r = c.get("https://nim-lang.org/")
  if not r.status.startsWith("200"): raise newException(IOError, "HTTP " & r.status)
  "httpclient over TLS")
check("json", proc (): string =
  let j = parseJson("""{"a": [1, 2]}""")
  if j["a"][1].getInt != 2: raise newException(ValueError, "wrong")
  "std/json")
var counter: int
proc worker(n: int) {.thread.} = atomicInc(counter, n)
check("threads", proc (): string =
  var ts: array[4, Thread[int]]
  for i in 0 ..< 4: createThread(ts[i], worker, 1)
  joinThreads(ts)
  if counter != 4: raise newException(ValueError, "count " & $counter)
  "4 threads")
echo "FID end"
