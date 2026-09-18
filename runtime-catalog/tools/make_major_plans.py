#!/usr/bin/env python3
"""Build download_plan_majors.json for each runtime: one version per true major.

A "true major" is the part of the catalog's `major` before the first dot:
python 3.14 -> 3, node 0.12 -> 0, go/rust 1.27 -> 1, php 8.5 -> 8, r 4.6 -> 4,
dotnet 3.1 -> 3, llvm 3.9 -> 3 (llvm 18 -> 18), java 21 -> 21.

For each (runtime, true major, os, arch) the highest version present in the
runtime's full download plan is chosen, with every variant published for that
exact version (e.g. Python's installer and embeddable zip). So if the newest
minor dropped a platform, that platform keeps the newest minor that had it.

OS floors (opt-in per runtime folder, see OS_FLOOR_RUNTIMES): for every
(runtime, os, arch, kind) and every OS id in catalog/os_versions.json,
also keep the newest release that still runs on that OS, so old systems get a
compiler/runtime version by version. Which release runs where comes from the
runtime's os_support.json when it exists, else from the `os_support` section
of catalog/compilers_min_os.json. A release no rule covers is never picked as
a floor (unknown is not "runs"). Rules with "kind": "source" may pull a source
tarball from releases.json, relabelled with the target os. Entries of
opted-in runtimes carry "reason": why the entry is in the plan.

The full catalog (releases.json, limitations.json) is unaffected.

usage: make_major_plans.py [<runtime folder> ...] [--check]
  --check  compute only; print what would change, write nothing.
"""
import copy
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
FULL_PLAN = {"python": "download_plan.json", "node": "download_plan.json", "java": "download_plan.json",
             "dotnet": "download_plan.json", "go": "download_plan.json", "rust": "download_plan.json",
             "php": "download_plan.json", "r": "download_plan.json", "ruby": "download_plan.json",
             "nim": "download_plan.json", "zig": "download_plan.json",
             "cc": "download_plan.json", "cmake": "download_plan.json", "meson": "download_plan.json",
             "ninja": "download_plan.json"}

# Runtime folders that also keep the newest release per OS floor. Others keep
# the plain one-per-major behaviour until their os_support.json is reviewed.
OS_FLOOR_RUNTIMES = ["go", "rust", "zig", "nim", "cc", "python"]


def vkey(v):
    return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in re.split(r"[.\-+_]", str(v))]


# Pre-1.0 languages break compatibility on every 0.x minor release, so each
# 0.x line counts as its own major for them.
PRE1_MINOR_IS_MAJOR = {"zig"}


def true_major(e):
    major = str(e["major"])
    if e["runtime"] in PRE1_MINOR_IS_MAJOR and major.startswith("0."):
        return major
    return major.split(".")[0]


# --------------------------------------------------------------------------
# OS floors
# --------------------------------------------------------------------------
def num(v):
    """Leading dotted number of a version: '11.5.0posix-12.0.0-ucrt-r1' -> (11, 5, 0)."""
    m = re.match(r"\d+(?:\.\d+)*", str(v))
    return tuple(int(x) for x in m.group(0).split(".")) if m else ()


def cmp_ver(a, b):
    a, b = list(a), list(b)
    n = max(len(a), len(b))
    a += [0] * (n - len(a))
    b += [0] * (n - len(b))
    return (a > b) - (a < b)


def version_matches(version, spec):
    """PEP 440-style subset: comma-separated >=, <=, >, <, ==, != clauses; '==X.Y.*' wildcards."""
    if spec in (None, "", "*"):
        return True
    v = num(version)
    for clause in spec.split(","):
        clause = clause.strip()
        m = re.match(r"(>=|<=|==|!=|>|<)\s*(\S+)$", clause)
        if not m:
            raise ValueError(f"bad version clause {clause!r}")
        op, target = m.groups()
        if target.endswith(".*"):
            prefix = num(target[:-2])
            hit = v[:len(prefix)] == prefix
            if (op == "==" and not hit) or (op == "!=" and hit):
                return False
            continue
        c = cmp_ver(v, num(target))
        if not {">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "==": c == 0, "!=": c != 0}[op]:
            return False
    return True


def os_ids():
    """{os: [(id, sort key)]} from os_versions.json; linux uses the glibc ids."""
    d = json.loads((CATALOG / "os_versions.json").read_text())
    ids = {
        "windows": [(w["id"], num(w["nt"])) for w in d["windows"]],
        "macos": [(m["id"], num(m["id"])) for m in d["macos"]],
        "linux": [(g["id"], num(g["id"].split("-", 1)[1])) for g in d["linux_glibc"]],
    }
    return ids


def load_rules(folder, runtimes):
    """{runtime: [rules]}: <folder>/os_support.json if present (one runtime per
    file), else compilers_min_os.json's os_support section."""
    rules = {}
    own = CATALOG / folder / "os_support.json"
    if own.exists():
        d = json.loads(own.read_text())
        rules[d["runtime"]] = d["rules"]
    shared = CATALOG / "compilers_min_os.json"
    if shared.exists():
        sec = json.loads(shared.read_text()).get("os_support", {})
        for rt in runtimes:
            if rt not in rules and rt in sec:
                rules[rt] = sec[rt]["rules"]
    return rules


def rule_applies(rule, e):
    if rule["os"] != e["os"]:
        return False
    if rule.get("arch") and e["arch"] not in rule["arch"]:
        return False
    if rule.get("variant") and e.get("variant") not in rule["variant"]:
        return False
    if rule.get("format") and e.get("format") not in rule["format"]:
        return False
    kind = rule.get("kind")
    if kind and e["kind"] != kind:
        return False
    if not kind and e["kind"] == "source":
        return False
    return version_matches(e["version"], rule.get("versions"))


def runs_on(e, os_id_key, rules, keys):
    """True/False when rules cover e, None when none apply. Every applying rule must allow it."""
    # Rules with no min_os (e.g. musl-only or source-only lines) don't place a
    # release on this OS scale; they're ignored here.
    hits = [r for r in rules if rule_applies(r, e) and r.get("min_os") is not None]
    if not hits:
        return None
    for r in hits:
        if r.get("plan_floor") is False:
            return None
        if os_id_key < keys[r["min_os"]]:
            return False
        if r.get("max_os") and os_id_key > keys[r["max_os"]]:
            return False
    return True


def source_candidates(folder, rules, plan):
    """Source tarballs for rules with kind 'source', from releases.json, relabelled
    with the rule's os when the release lists them under another os."""
    need = [(rt, r) for rt, rs in rules.items() for r in rs if r.get("kind") == "source"]
    if not need:
        return []
    releases = json.loads((CATALOG / folder / "releases.json").read_text())
    in_plan = {(e["url"], e["os"]) for e in plan}
    out = []
    for rt, r in need:
        for e in releases:
            if e["runtime"] != rt or e["kind"] != "source":
                continue
            c = e
            if e["os"] != r["os"]:
                c = copy.deepcopy(e)
                c["os"] = r["os"]
                c["notes"] = (f"Source tarball (published without an os; listed under {e['os']} in releases.json), "
                              f"relabelled for {r['os']} where no binary runs.")
            if (c["url"], c["os"]) not in in_plan and rule_applies(r, c):
                out.append(c)
    # one format per version: prefer the smaller file (tar.xz over tar.gz)
    best = {}
    for c in out:
        k = (c["runtime"], c["version"], c["os"], c["arch"])
        if k not in best or (c.get("size") or 1 << 62) < (best[k].get("size") or 1 << 62):
            best[k] = c
    return list(best.values())


def floor_entries(folder, plan):
    """{entry key: (entry, [reasons])} for the newest release per OS id."""
    runtimes = sorted({e["runtime"] for e in plan})
    rules = load_rules(folder, runtimes)
    ids = os_ids()
    pool = plan + source_candidates(folder, rules, plan)
    groups = defaultdict(list)
    for e in pool:
        if e["runtime"] in rules and e["os"] in ids:
            groups[(e["runtime"], e["os"], e["arch"], e["kind"])].append(e)
    # Newest = highest (major, version): variants of one runtime can number
    # their versions differently (w64devkit 2.10.0 bundles GCC major 16).
    # Every variant of the winning release that runs there is kept.
    newest = lambda e: (vkey(e["major"]), vkey(e["version"]))
    picked = {}
    for (rt, os_, arch, kind), es in groups.items():
        keys = dict(ids[os_])
        for os_id, k in ids[os_]:
            ok = [e for e in es if runs_on(e, k, rules[rt], keys)]
            if not ok:
                continue
            best = newest(max(ok, key=newest))
            for e in ok:
                if newest(e) == best:
                    key = (e["url"], e["os"], e["arch"])
                    picked.setdefault(key, (e, []))[1].append(f"{os_} {os_id}")
    return picked


def join_reasons(reasons):
    by_os = defaultdict(list)
    for r in reasons:
        o, i = r.split(" ", 1)
        by_os[o].append(i)
    return "; ".join(f"newest for {o} {', '.join(v)}" for o, v in by_os.items())


# --------------------------------------------------------------------------
def build(folder, name):
    plan = json.loads((CATALOG / folder / name).read_text())
    groups = defaultdict(list)
    for e in plan:
        groups[(e["runtime"], true_major(e), e["os"], e["arch"])].append(e)
    # Source tarballs are only worth keeping where no prebuilt binary exists
    # for that runtime, true major and OS.
    has_binary = {(r, m, o) for (r, m, o, a), es in groups.items() if any(e["kind"] != "source" for e in es)}
    groups = {k: v for k, v in groups.items()
              if not (all(e["kind"] == "source" for e in v) and (k[0], k[1], k[2]) in has_binary)}
    chosen = []
    for key, es in groups.items():
        best = max((e["version"] for e in es), key=vkey)
        chosen += [e for e in es if e["version"] == best]
    added = []
    if folder in OS_FLOOR_RUNTIMES:
        chosen = [dict(e, reason=f"newest in major {true_major(e)}") for e in chosen]
        index = {(e["url"], e["os"], e["arch"]): e for e in chosen}
        for key, (e, reasons) in floor_entries(folder, plan).items():
            why = join_reasons(reasons)
            if key in index:
                index[key]["reason"] += "; " + why
            else:
                n = dict(e, reason=why)
                chosen.append(n)
                index[key] = n
                added.append(n)
    chosen.sort(key=lambda e: (e["runtime"], vkey(e["version"]), e["os"], e["arch"], e.get("variant") or ""))
    return plan, chosen, added


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check = "--check" in sys.argv
    total = 0
    only = set(args)  # optional: limit to these runtime folders
    for folder, name in FULL_PLAN.items():
        if only and folder not in only:
            continue
        if not (CATALOG / folder / name).exists():
            print(f"{folder:7} skipped: no {name} yet")
            continue
        plan, chosen, added = build(folder, name)
        out = CATALOG / folder / "download_plan_majors.json"
        text = json.dumps(chosen, indent=1)
        if check:
            same = out.exists() and out.read_text() == text
            print(f"{folder:7} {'unchanged' if same else 'WOULD CHANGE'}")
            continue
        out.write_text(text)
        gb = sum(e.get("size") or 0 for e in chosen) / 1e9
        total += gb
        versions = sorted({f"{e['runtime']} {e['version']}" for e in chosen}, key=lambda s: (s.split()[0], vkey(s.split()[1])))
        print(f"{folder:7} {len(plan):5} -> {len(chosen):4} files  {gb:6.1f} GB   versions: {', '.join(versions)[:230]}")
        if added:
            print(f"        + {len(added)} for OS floors ({sum(e.get('size') or 0 for e in added) / 1e9:.1f} GB)")
    if not check:
        print(f"total {total:.1f} GB")


if __name__ == "__main__":
    main()
