#!/usr/bin/env python3
"""Fill `launch` and `project_install` into every recipe of <runtime>/install.json.

usage: add_launch.py <runtime> [<runtime> ...]

The values come from what the install-recipe research found per runtime
(the recipe notes and top-level notes cite the evidence); this script only
applies them uniformly so the fields are consistent. Re-running overwrites
the two fields and nothing else. See SCHEMA.md "Launch and project install".
"""
import json
import sys
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]


def sep(r):
    return "\\" if r["match"].get("os") == "windows" else "/"


def exe_path(r):
    exe = (r.get("executable") or "").split("  ")[0].strip()
    if not exe:
        return None
    if exe.startswith("/") or exe[1:3] == ":\\":
        return exe
    return "{runtime_dir}" + sep(r) + exe


def j(r, *parts):
    return "{runtime_dir}" + sep(r) + sep(r).join(parts)


def devnull(r):
    return "nul" if r["match"].get("os") == "windows" else "/dev/null"


def python(r):
    prog = exe_path(r)
    env = {"PIP_CONFIG_FILE": devnull(r), "PIP_CACHE_DIR": "{data_dir}" + sep(r) + "pip-cache"}
    return (
        {"program": prog, "args": ["-E", "-s"], "env": {},
         "notes": "-s drops the per-user site-packages every copy of X.Y shares (top-level user_site_leak); -E ignores PYTHON* variables from the user's environment."},
        {"command": f'"{prog}" -E -s -m pip install --no-warn-script-location .', "env": env, "cwd": "{app_dir}",
         "notes": "PIP_CONFIG_FILE=devnull stops pip reading the user's pip.conf. Python <2.7.9 and 3.0-3.3 have no bundled pip."},
    )


def java(r):
    prog = exe_path(r)
    home = prog.rsplit(sep(r) + "bin" + sep(r), 1)[0]
    clear = {"JAVA_TOOL_OPTIONS": None, "_JAVA_OPTIONS": None, "JDK_JAVA_OPTIONS": None, "CLASSPATH": None}
    return (
        {"program": prog, "args": [], "env": {"JAVA_HOME": home, **clear},
         "notes": "java finds its runtime from its own path; JAVA_HOME is for build tools and wrapper scripts. The cleared variables would inject a user's global JVM options."},
        None,
    )


def node(r):
    prog = exe_path(r)
    binv = j(r, "bin") if sep(r) == "/" else "{runtime_dir}"
    npmcli = j(r, "lib", "node_modules", "npm", "bin", "npm-cli.js") if sep(r) == "/" else j(r, "node_modules", "npm", "bin", "npm-cli.js")
    env = {"npm_config_userconfig": j(r, "etc", "npmrc-user")}
    return (
        {"program": prog, "args": [], "env": env, "path_prepend": [binv],
         "notes": "Scripts installed by npm start with '#!/usr/bin/env node', so the runtime's folder goes first on PATH for the app's own process only."},
        {"command": f'"{prog}" "{npmcli}" install', "env": env, "path_prepend": [binv], "cwd": "{app_dir}",
         "notes": "Add --omit=dev (npm 7+) or --production (older npm) to skip dev dependencies; use `ci` when the project has package-lock.json."},
    )


def php(r):
    prog = exe_path(r)
    ini = j(r, "php.ini")
    env = {"PHP_INI_SCAN_DIR": ""}
    pm = r.get("package_manager")
    comp_env = {**env, "COMPOSER_HOME": "{data_dir}" + sep(r) + "composer-home", "COMPOSER_CACHE_DIR": "{data_dir}" + sep(r) + "composer-cache"}
    pi = None
    if pm:
        phar = j(r, "composer.phar")
        pi = {"command": f'"{prog}" -c "{ini}" "{phar}" install --no-dev --no-interaction', "env": comp_env, "cwd": "{app_dir}",
              "notes": "Composer is not in the download plan yet; composer.phar must be added to the runtime folder."}
    return (
        {"program": prog, "args": ["-c", ini], "env": env,
         "notes": "-c pins the app's php.ini (a PHPRC or registry path from another PHP install would otherwise win); an empty PHP_INI_SCAN_DIR stops extra .ini folders being read."},
        pi,
    )


def dotnet(r):
    prog = exe_path(r)
    if not prog:
        return ({"program": None, "args": [], "env": {}, "notes": ".NET Framework is part of Windows; apps start directly."}, None)
    env = {"DOTNET_ROOT": "{runtime_dir}"}
    if r["match"].get("os") == "windows":
        env["DOTNET_MULTILEVEL_LOOKUP"] = "0"
    return (
        {"program": prog, "args": [], "env": env,
         "notes": "Start the app as `dotnet <app>.dll` through this private dotnet, which only uses its own folder. DOTNET_ROOT is for an app's own .exe launcher; DOTNET_MULTILEVEL_LOOKUP=0 stops Windows 1.x-6.0 preferring a newer global install. 2.2/3.1 on new Linux distros may need CLR_ICU_VERSION_OVERRIDE (see recipe notes)."},
        None,
    )


def go(r):
    prog = exe_path(r)
    s = sep(r)
    osn = r["match"].get("os")
    env = {"GOROOT": "{runtime_dir}", "GOPATH": "{data_dir}" + s + "gopath", "GOBIN": None}
    if r["match"].get("versions") != "==1.4.*":
        env.update({"GOMODCACHE": "{data_dir}" + s + "gopath" + s + "pkg" + s + "mod", "GOCACHE": "{data_dir}" + s + "go-cache",
                    "GOENV": "off", "GOTOOLCHAIN": "local", "GOFLAGS": "-modcacherw"})
        env[{"linux": "XDG_CONFIG_HOME", "macos": "HOME", "windows": "APPDATA"}[osn]] = "{data_dir}" + s + "config"
    return (
        {"program": None, "args": [], "env": {},
         "notes": "The app is the program built by project_install and runs directly; it needs no runtime environment."},
        {"command": f'"{prog}" build -o "{{app_dir}}{s}{{project}}" .', "env": env, "cwd": "{app_dir}",
         "notes": "Builds the app on the user's machine at install time (installer-builder design.md 1.8). The config-folder variable keeps Go telemetry (1.23+) out of the user's home. cgo projects also need a C compiler."},
    )


def rust(r):
    s = sep(r)
    ext = ".exe" if s == "\\" else ""
    env = {"CARGO_HOME": "{data_dir}" + s + "cargo-home", "RUSTC": j(r, "bin", "rustc" + ext), "RUSTDOC": j(r, "bin", "rustdoc" + ext),
           "RUSTFLAGS": None, "RUSTDOCFLAGS": None, "CARGO_ENCODED_RUSTFLAGS": None, "RUSTC_WRAPPER": None, "CARGO_TARGET_DIR": None}
    return (
        {"program": None, "args": [], "env": {}, "notes": "The app is the program built by project_install and runs directly."},
        {"command": f'"{j(r, "bin", "cargo" + ext)}" build --release --locked', "env": env, "cwd": "{app_dir}",
         "notes": "Builds the app on the user's machine at install time (installer-builder design.md 1.8). Without RUSTC cargo can't find rustc (tested). Needs the system linker (see prerequisites)."},
    )


def nim(r):
    s = sep(r)
    ext = ".exe" if s == "\\" else ""
    nimble_dir = "{data_dir}" + s + "nimble"
    return (
        {"program": None, "args": [], "env": {}, "notes": "The app is the program built by project_install and runs directly."},
        {"command": f'"{j(r, "bin", "nimble" + ext)}" --nimbleDir:"{nimble_dir}" -y build', "env": {"NIMBLE_DIR": nimble_dir}, "cwd": "{app_dir}",
         "notes": "Builds the app on the user's machine at install time (installer-builder design.md 1.8). Needs a C compiler. nimble 2.2 fails in paths with spaces; see the recipe notes for the symlink workaround."},
    )


def ruby(r):
    prog = exe_path(r)
    s = sep(r)
    env = {"RUBYOPT": None, "RUBYLIB": None, "GEM_HOME": None, "GEM_PATH": None,
           "BUNDLE_USER_HOME": "{data_dir}" + s + "bundle", "BUNDLE_APP_CONFIG": "{app_dir}" + s + ".bundle"}
    if s == "\\":
        bundle = j(r, "bin", "bundle.bat") if r["match"].get("versions") != "<2.4" else None
    else:
        bundle = j(r, "bin", "bundle")
    pi = None
    if bundle:
        cmd = f'"{bundle}" install' if s == "\\" else f'"{prog}" "{bundle}" install'
        pi = {"command": cmd, "env": env, "cwd": "{app_dir}", "notes": "When the project has a Gemfile; otherwise `gem install` the app's gem."}
    return (
        {"program": prog, "args": [], "env": env,
         "notes": "Clearing GEM_HOME/GEM_PATH makes gems resolve to the runtime's own folder; RUBYOPT/RUBYLIB would inject a user's settings."},
        pi,
    )


def r_lang(r):
    prog = exe_path(r)
    s = sep(r)
    if r["match"].get("versions") == "<2.0":
        cmd = f'"{j(r, "bin", "Rcmd.exe")}" INSTALL .'
    elif s == "\\":
        cmd = f'"{j(r, "bin", "Rcmd.exe")}" INSTALL .'
    elif prog.startswith("/Library"):
        cmd = f'"{prog.rsplit("/", 1)[0]}/R" CMD INSTALL .'
    else:
        cmd = f'"{prog.rsplit(s, 1)[0]}{s}R" CMD INSTALL .'
    env = {"R_LIBS": None, "R_LIBS_USER": None,
           "R_ENVIRON_USER": "{data_dir}" + s + "Renviron", "R_PROFILE_USER": "{data_dir}" + s + "Rprofile"}
    return (
        {"program": prog, "args": [], "env": env,
         "notes": "R_ENVIRON_USER/R_PROFILE_USER point at files that don't exist, so the user's ~/.Renviron and ~/.Rprofile aren't read, while the recipe's Renviron.site (which points R_LIBS_USER inside the runtime folder) still is. Not --no-environ: that would skip Renviron.site too."},
        {"command": cmd, "env": env, "cwd": "{app_dir}", "notes": "For an R package project; a script-only app installs its packages with install.packages (see package_manager)."},
    )


def zig(r):
    s = sep(r)
    v = r["match"].get("versions") or ""
    env = {}
    if v.startswith(">=0.8") or v == ">=0.11":
        env["ZIG_GLOBAL_CACHE_DIR"] = "{data_dir}" + s + "zig-cache"
    elif v == ">=0.6,<0.8" and s == "/" or v == ">=0.7,<0.8":
        env["XDG_CACHE_HOME"] = "{data_dir}" + s + "cache"
    return (
        {"program": None, "args": [], "env": {}, "notes": "The app is the program built by project_install and runs directly."},
        {"command": f'"{exe_path(r)}" build -Doptimize=ReleaseSafe --prefix "{{app_dir}}"', "env": env, "cwd": "{app_dir}",
         "notes": "Builds the app on the user's machine at install time (installer-builder design.md 1.8). `zig build` exists from 0.3; older versions compile with `zig build-exe`. "
                  "Before 0.6 (0.7 on macOS, 0.8 on Windows) the global cache can't be moved and lands in the user's folder (isolation: leaks). "
                  "The same environment applies when zig is used as a C compiler (`zig cc`)."},
    )


def cc(r):
    s = sep(r)
    m = r["match"]
    prog = exe_path(r)
    if m.get("runtime") == "msvc-redist":
        if m.get("variant") == "buildtools":
            return (
                {"program": None, "args": [], "env": {}, "notes": "The app is the program built by project_install."},
                {"command": f'call "{prog}" x64 && cmake -S . -B build -G Ninja && cmake --build build --config Release', "env": {}, "cwd": "{app_dir}",
                 "notes": "Build Tools are installed system-wide; vcvarsall.bat sets up the compiler for this one command. CMake/Ninja come from the catalogue (catalog/cmake, catalog/ninja) and must be on PATH."},
            )
        return ({"program": None, "args": [], "env": {}, "notes": "A system-wide prerequisite; nothing to launch."}, None)
    ext = ".exe" if s == "\\" else ""
    if m.get("runtime") == "gcc":
        cc_, cxx = j(r, "bin", "gcc" + ext), j(r, "bin", "g++" + ext)
    else:
        cc_, cxx = j(r, "bin", "clang" + ext), j(r, "bin", "clang++" + ext)
    return (
        {"program": None, "args": [], "env": {}, "notes": "The app is the program built by project_install and runs directly."},
        {"command": "cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build",
         "env": {"CC": cc_, "CXX": cxx, "CFLAGS": None, "CXXFLAGS": None, "LDFLAGS": None, "CPATH": None, "LIBRARY_PATH": None},
         "path_prepend": [j(r, "bin")], "cwd": "{app_dir}",
         "notes": "Builds the app on the user's machine (installer-builder design.md 1.8). The default command assumes CMake and Ninja from the catalogue (catalog/cmake, catalog/ninja); the publisher's Build command replaces it (Meson: `meson setup build && meson compile -C build`; make: `make`). "
                  "The cleared variables would inject a user's global compiler settings. See the recipe's prerequisites for what the system must still provide (headers, linker, SDK)."},
    )


FILL = {"python": python, "java": java, "node": node, "php": php, "dotnet": dotnet, "go": go,
        "rust": rust, "nim": nim, "zig": zig, "cc": cc, "ruby": ruby, "r": r_lang}


def main():
    for rt in sys.argv[1:]:
        p = CATALOG / rt / "install.json"
        d = json.loads(p.read_text())
        for r in d["recipes"]:
            r["launch"], r["project_install"] = FILL[rt](r)
        p.write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")
        print(f"{rt}: {len(d['recipes'])} recipes")


if __name__ == "__main__":
    main()
