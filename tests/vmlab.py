"""Where the test machines are, which is not in this repository.

The addresses, the usernames, the ESXi host and the rented Mac are the
operator's own infrastructure. They are not part of the software, they
are of no use to anybody else, and this repository is going public. So
the harnesses live here and the address book does not.

    tests/vms.json          the real one, gitignored
    tests/vms.example.json  the shape, committed
    $TI_VMS                 a different file, anywhere

Four harnesses used to carry their own copy of the same map -- matrix,
fidelity, templates and tooling -- so an address that changed had to be
changed four times and was not. They all read this instead.

tests/browsers/remote.mjs reaches the same data through tests/matrix/run.py,
which reads it from here, so the browser harness needs no change.
"""
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT = HERE / 'vms.json'


def _load():
    p = pathlib.Path(os.environ.get('TI_VMS') or DEFAULT)
    if not p.exists():
        raise SystemExit(
            'No test machines configured.\n'
            '  cp %s %s   and fill it in,\n'
            '  or set TI_VMS to a file like it.\n'
            'It is gitignored on purpose: the addresses are local and this repo is public.'
            % (HERE / 'vms.example.json', DEFAULT))
    try:
        j = json.loads(p.read_text())
    except ValueError as e:
        raise SystemExit('%s: not JSON (%s)' % (p, e))
    return j


_J = None


def _j():
    global _J
    if _J is None:
        _J = _load()
    return _J


def windows():
    """{name: (ssh, shell)} -- the shell is 'cmd' or 'powershell'."""
    return {k: tuple(v) for k, v in _j().get('windows', {}).items()}


def linux():
    """{name: ssh}"""
    return dict(_j().get('linux', {}))


def mac():
    """ssh, or '' where none is configured."""
    return _j().get('mac', '') or ''


def console():
    """Machines somebody is logged in to at the keyboard.

    Anything that would put a window on a screen, or photograph one,
    refuses these: it is somebody's desktop, and a full-screen grab takes
    whatever else is on it. The addresses used to be written into the
    guards themselves, which put the one address that must not be shared
    into two scripts and a test.
    """
    return list(_j().get('console', []))


def is_console(ssh):
    """Does `ssh` name a machine somebody is sitting in front of?"""
    host = str(ssh or '').rsplit('@', 1)[-1]
    return any(str(c).rsplit('@', 1)[-1] == host for c in console())
