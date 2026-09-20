# Checks the runtime's own package manager and tooling, for every Python
# the catalogue can install: 3.0 upwards, so no f-strings, no argparse
# niceties, nothing newer than 3.0 syntax.
import os
import subprocess
import sys
import tempfile


def say(state, name, detail):
    print("TOOL " + state + " " + name + ": " + detail)


def check(name, fn):
    try:
        detail = fn()
    except SkipIt:
        e = sys.exc_info()[1]
        say("skip", name, str(e))
    except Exception:
        e = sys.exc_info()[1]
        say("fail", name, type(e).__name__ + ": " + str(e)[:200])
    else:
        say("ok", name, detail)


class SkipIt(Exception):
    pass


def run(args):
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.communicate()[0].decode("utf-8", "replace")
    if p.returncode != 0:
        raise Exception("exit " + str(p.returncode) + ": " + " ".join(out.split())[-200:])
    return " ".join(out.split())[:120]


def pip_installed():
    # The install step ran `pip install -r requirements.txt`.
    import six
    return "six " + getattr(six, "__version__", "?")


def pip_module():
    if sys.version_info[:2] < (3, 4) and not _has("pip"):
        raise SkipIt("no pip module in this build")
    return run([sys.executable, "-m", "pip", "--version"])


def _has(mod):
    try:
        __import__(mod)
        return True
    except ImportError:
        return False


def ensurepip_there():
    if not _has("ensurepip"):
        raise SkipIt("ensurepip is 3.4 and later")
    import ensurepip
    return "ensurepip " + str(ensurepip.version())


def venv_works():
    if not _has("venv"):
        raise SkipIt("venv is 3.3 and later")
    d = tempfile.mkdtemp(prefix="toolvenv")
    run([sys.executable, "-m", "venv", d])
    py = os.path.join(d, "Scripts", "python.exe")
    if not os.path.exists(py):
        py = os.path.join(d, "bin", "python")
    out = run([py, "-c", "import sys; print(sys.prefix)"])
    if os.path.normcase(d) not in os.path.normcase(out):
        raise Exception("venv prefix is " + out)
    return "venv at " + os.path.basename(d)


def venv_pip():
    if not _has("venv"):
        raise SkipIt("venv is 3.3 and later")
    d = tempfile.mkdtemp(prefix="toolvenv2")
    run([sys.executable, "-m", "venv", d])
    py = os.path.join(d, "Scripts", "python.exe")
    if not os.path.exists(py):
        py = os.path.join(d, "bin", "python")
    return run([py, "-m", "pip", "--version"])


def stdlib():
    import json
    import ssl
    json.dumps({"a": 1})
    return ssl.OPENSSL_VERSION


print("TOOL runtime python " + sys.version.split()[0])
check("pip-install", pip_installed)
check("pip-module", pip_module)
check("ensurepip", ensurepip_there)
check("venv", venv_works)
check("venv-pip", venv_pip)
check("stdlib", stdlib)
print("TOOL end")
