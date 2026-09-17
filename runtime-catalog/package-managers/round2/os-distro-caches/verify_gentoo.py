import json, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"

def head(url, expect_size, timeout=15):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cl = resp.headers.get("Content-Length")
            ok = (cl is not None and int(cl) == expect_size)
            return (ok, resp.status, cl)
    except Exception as ex:
        return (False, None, str(ex))

updates = [json.loads(l) for l in open("/tmp/mirrorhunt/gentoo_updates.jsonl")]
mirror_updates = [u for u in updates if "mirror" in u]
corrob_updates = [u for u in updates if "checksum_corroboration" in u]

# We need expected size per mirror URL; derive from the filename via re-deriving manifest size.
# Simpler: re-run the analyze step but keep expected size attached.
