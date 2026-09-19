# Fidelity check: what real Python apps rely on (docs/test-results.md, "Real-app fidelity").
# Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
# Written for Python 3.5 and later (no f-strings).
import os
import subprocess
import sys
import tempfile


class Skip(Exception):
    pass


def check(name, fn):
    try:
        detail = fn()
        print("FID ok %s%s" % (name, ": %s" % detail if detail else ""))
    except Skip as e:
        print("FID skip %s: %s" % (name, e))
    except BaseException as e:  # noqa: B902 - SystemExit from a broken module counts too
        msg = str(e).replace("\n", " ").replace("\r", " ")[:300]
        print("FID fail %s: %s: %s" % (name, type(e).__name__, msg))
    sys.stdout.flush()


def ssl_https():
    import ssl
    import urllib.request
    with urllib.request.urlopen("https://pypi.org/simple/pip/", timeout=60) as r:
        r.read(64)
    return ssl.OPENSSL_VERSION


def sqlite():
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.execute("create table t (a text)")
    db.execute("insert into t values ('x')")
    assert db.execute("select count(*) from t").fetchone()[0] == 1
    try:
        db.execute("select json('[1]')")
        json1 = "with JSON1"
    except sqlite3.OperationalError:
        json1 = "no JSON1 (built without it, as python.org's older Windows builds are)"
    return "%s, %s" % (sqlite3.sqlite_version, json1)


def ctypes_call():
    import ctypes
    import ctypes.util
    if os.name == "nt":
        n = ctypes.windll.kernel32.GetTickCount()
        return "GetTickCount %d" % n
    libc = ctypes.CDLL(ctypes.util.find_library("c") or None)
    return "getpid %d" % libc.getpid()


def venv():
    d = tempfile.mkdtemp(prefix="fidvenv")
    subprocess.check_call([sys.executable, "-m", "venv", d], stdout=subprocess.DEVNULL)
    py = os.path.join(d, "Scripts", "python.exe") if os.name == "nt" else os.path.join(d, "bin", "python")
    out = subprocess.check_output([py, "-m", "pip", "--version"]).decode()
    return out.split(" from ")[0].strip()


def pip():
    out = subprocess.check_output([sys.executable, "-m", "pip", "--version"]).decode()
    return out.split(" from ")[0].strip()


def wheel_yaml():
    import yaml
    assert yaml.safe_load("a: [1, 2]") == {"a": [1, 2]}
    return "PyYAML %s, libyaml %s" % (yaml.__version__, "yes" if yaml.__with_libyaml__ else "no")


def wheel_cffi():
    import cffi
    ffi = cffi.FFI()
    p = ffi.new("int[4]")
    p[3] = 7
    assert p[3] == 7
    return "cffi %s" % cffi.__version__


def tcl():
    import tkinter
    t = tkinter.Tcl()
    return "Tcl %s" % t.eval("info patchlevel")


def tk_window():
    import tkinter
    if os.environ.get("FID_NO_DISPLAY"):
        raise Skip(os.environ["FID_NO_DISPLAY"])
    if os.name != "nt" and sys.platform != "darwin" and not os.environ.get("DISPLAY"):
        raise Skip("no display")
    try:
        root = tkinter.Tk()
    except tkinter.TclError as e:
        if "display" in str(e).lower():
            raise Skip(str(e))
        raise
    root.withdraw()
    v = root.tk.call("info", "patchlevel")
    root.destroy()
    return "Tk %s" % v


def stdlib():
    missing = []
    mods = ["zlib", "bz2", "lzma", "hashlib", "_hashlib", "_decimal", "_ctypes", "_ssl", "_sqlite3",
            "pyexpat", "_elementtree", "_json", "_socket", "select", "_multiprocessing", "uuid", "unicodedata",
            "_queue", "_asyncio", "_contextvars"]
    if os.name != "nt":
        mods += ["_uuid", "readline", "_curses", "termios", "grp", "fcntl", "resource"]
    for m in mods:
        try:
            __import__(m)
        except ImportError as e:
            missing.append("%s (%s)" % (m, e))
    if missing:
        raise RuntimeError("missing: " + ", ".join(missing))
    import hashlib
    hashlib.sha3_256(b"x").hexdigest()
    return "%d modules" % len(mods)


def _square(x):
    return x * x


def multiprocessing_pool():
    import multiprocessing
    with multiprocessing.Pool(2) as p:
        got = p.map(_square, [1, 2, 3])
    assert got == [1, 4, 9], got
    return "pool of 2"


if __name__ == "__main__":
    print("FID start python %s" % sys.version.split()[0])
    for name, fn in [("ssl-https", ssl_https), ("sqlite3", sqlite), ("ctypes", ctypes_call), ("stdlib", stdlib),
                     ("pip", pip), ("venv", venv), ("wheel-pyyaml", wheel_yaml), ("wheel-cffi", wheel_cffi),
                     ("tkinter-tcl", tcl), ("tkinter-tk", tk_window), ("multiprocessing", multiprocessing_pool)]:
        check(name, fn)
    print("FID end")
