# Python 2: the same shape as the Python 3 project, in 2.x syntax.
from __future__ import print_function

import os
import subprocess
import sys
import tempfile


class SkipIt(Exception):
    pass


def say(state, name, detail):
    # Keep every line ASCII: see the Python 3 project for why.
    line = "TOOL " + state + " " + name + ": " + detail
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    print(line.encode("ascii", "replace").decode("ascii"))


def check(name, fn):
    try:
        detail = fn()
    except SkipIt as e:
        say("skip", name, str(e))
    except Exception as e:
        say("fail", name, type(e).__name__ + ": " + str(e)[:200])
    else:
        say("ok", name, detail)


def run(args):
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.communicate()[0].decode("utf-8", "replace")
    if p.returncode != 0:
        raise Exception("exit %d: %s" % (p.returncode, " ".join(out.split())[-200:]))
    return " ".join(out.split())[:120]


def pip_installed():
    import six
    return "six " + getattr(six, "__version__", "?")


def pip_module():
    return run([sys.executable, "-m", "pip", "--version"])


def ensurepip_there():
    import ensurepip
    return "ensurepip " + str(ensurepip.version())


def virtualenv_skip():
    raise SkipIt("Python 2 has no venv module; virtualenv is a package")


def stdlib():
    import json
    import sqlite3
    import ssl
    json.dumps({"a": 1})
    return "sqlite " + sqlite3.sqlite_version + ", " + ssl.OPENSSL_VERSION


def https():
    import urllib2
    return "pypi.org " + str(urllib2.urlopen("https://pypi.org/simple/six/", timeout=60).getcode())


print("TOOL runtime python2 " + sys.version.split()[0])
check("pip-install", pip_installed)
check("pip-module", pip_module)
check("ensurepip", ensurepip_there)
check("venv", virtualenv_skip)
check("stdlib", stdlib)
check("https", https)
print("TOOL end")
