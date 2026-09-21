# Build browser_c/index.html: one sample URL per host (all yes/partial-candidates, plus some no controls).
import json, sys
from collections import defaultdict
from urllib.parse import quote
d = defaultdict(list)
for l in open("probe_c.jsonl"):
    r = json.loads(l)
    if r["url"]: d[r["host"]].append(r)
tests = []  # (label, url)
for h, rs in d.items():
    if any(r["ok"] for r in rs):
        # one URL per distinct first-two path segments, ok and not-ok
        seen = set()
        for r in rs:
            key = (tuple(r["url"].split("/")[3:5]), r["ok"])
            if key not in seen:
                seen.add(key); tests.append((f"{h}#{len(seen)}", r["url"]))
for h in sys.argv[1:]:
    tests.append((f"{h}#ctl", d[h][0]["url"]))
json.dump(tests, open("browser_c/tests.json", "w"), indent=0)
html = """<!doctype html><meta charset=utf-8><title>cors c</title><script>
(async () => {
  const tests = await (await fetch('tests.json')).json();
  await Promise.all(tests.map(async ([label, url]) => {
    let res;
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 45000);
      const r = await fetch(url, {headers: {Range: 'bytes=0-0'}, signal: ctl.signal});
      res = 'ok ' + r.status;
      ctl.abort();
    } catch (e) { res = 'error ' + e.name; }
    await fetch('/__RESULT/' + encodeURIComponent(label + '|' + res)).catch(() => {});
  }));
  await fetch('/__RESULT/' + encodeURIComponent('__DONE__|' + tests.length)).catch(() => {});
})();
</script>"""
open("browser_c/index.html", "w").write(html)
print(len(tests), "tests")
