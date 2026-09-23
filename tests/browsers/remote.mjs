// The test machines, as tests/matrix/run.py lists them (WINDOWS, LINUX_VMS,
// MAC), and what the browser harness does on them over SSH: read the
// browser manifest, copy files, start a WebDriver driver bound to
// 127.0.0.1 there and reach it through `ssh -L`, clean up.
//
// On each machine (docs/local/test-vms.md, "Browsers"):
//   Windows      C:\tibrowsers\browsers.json, drivers\, work\
//   Linux, Mac   ~/tibrowsers/browsers.json, drivers/, work/
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MATRIX = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'matrix');

export function loadMachines() {
  const out = execFileSync('python3', ['-c',
    'import json, run; print(json.dumps({"windows": run.WINDOWS, "linux": run.LINUX_VMS, "mac": run.MAC}))'],
  { cwd: MATRIX, encoding: 'utf8' });
  const j = JSON.parse(out);
  const list = [];
  for (const [name, [ssh, shell]] of Object.entries(j.windows)) list.push({ name, ssh, os: 'windows', shell });
  for (const [name, ssh] of Object.entries(j.linux)) list.push({ name, ssh, os: 'linux' });
  list.push({ name: 'mac', ssh: j.mac, os: 'mac' });
  return list;
}

// "win7" and "7" both name run.py's Windows 7 VM.
export function findMachine(machines, name) {
  return machines.find((m) => m.name === name || (m.os === 'windows' && 'win' + m.name === name));
}

// Ports this process has already handed out. freePort() asks the kernel
// for a free one and then closes the socket, so between the answer and
// the `ssh -L` that binds it there is a window -- and with --jobs 4 four
// of these are open at once. Two jobs getting the same number means
// ExitOnForwardFailure kills the second ssh before its driver ever
// starts, and the run reports "driver not ready: connection refused",
// which reads as a broken machine and is not one. Seen across every
// machine and browser on 2026-09-23; the same command by hand worked
// every time, which is what a race looks like.
const handedOut = new Set();

export function freePort() {
  return new Promise((res, rej) => {
    const tryOne = (left) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => {
          if (!handedOut.has(p)) { handedOut.add(p); return res(p); }
          if (left <= 0) return rej(new Error('no free port that this run has not already used'));
          tryOne(left - 1);
        });
      });
    };
    tryOne(20);
  });
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

export class Remote {
  constructor(m) {
    Object.assign(this, m);
    this.win = m.os === 'windows';
    this.home = null;          // Unix: $HOME, from readManifest()
  }

  sh(cmd, { input = '', timeout = 120000 } = {}) {
    const r = spawnSync('ssh', [...SSH_OPTS, this.ssh, cmd], { input, timeout, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { code: r.status === null ? 124 : r.status, out: (r.stdout || '').replace(/\r/g, ''), err: (r.stderr || '').replace(/\r/g, '') + (r.error ? String(r.error) : '') };
  }

  // Folder under the harness root, as a path on the machine.
  dir(...parts) {
    return this.win ? ['C:\\tibrowsers', ...parts].join('\\') : [this.home + '/tibrowsers', ...parts].join('/');
  }

  fileUrl(p) { return this.win ? 'file:///' + p.replace(/\\/g, '/') : 'file://' + p; }

  // A static HTTP server on the machine, serving `root`, for a browser
  // that will not be driven to a file:// URL.
  //
  // Safari is the one: safaridriver refuses to navigate to file://
  // outright -- the page never loads, location.protocol stays
  // "safari-resource:", and what the harness sees is "the page did not
  // start", which for nine runs read like a browser that could not run
  // the page. It runs it fine (2026-09-23: isSecureContext true,
  // crypto.subtle present, over http on the same machine).
  //
  // Returns the ssh child process; kill it to stop the server.
  startStaticServer(root, port, log) {
    const cmd = `sh -c 'cd ${root} && python3 -m http.server ${port} --bind 127.0.0.1 </dev/null >/dev/null 2>&1 & p=$!; read x; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null'`;
    const p = spawn('ssh', [...SSH_OPTS, this.ssh, cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (log) { p.stdout.on('data', (d) => log(d)); p.stderr.on('data', (d) => log(d)); }
    return p;
  }

  // Reads browsers.json (and $HOME on Unix). Returns the parsed manifest.
  readManifest() {
    const r = this.win
      ? this.sh('type C:\\tibrowsers\\browsers.json')
      : this.sh('echo "@HOME $HOME"; echo "@FWD $(grep -i "^[[:space:]]*AllowTcpForwarding" /etc/ssh/sshd_config 2>/dev/null | tail -1)"; cat ~/tibrowsers/browsers.json');
    let text = r.out;
    if (!this.win) {
      const m = /^@HOME (.*)$/m.exec(text);
      if (m) this.home = m[1].trim();
      // An SSH server that forbids forwarding (Alpine's): tunnel through nc.
      this.ncForward = /^@FWD .*\bno\b/im.test(text);
      text = text.replace(/^@HOME .*\n/m, '').replace(/^@FWD .*\n/m, '');
    }
    if (r.code !== 0 && !text.trim()) throw new Error(`${this.name}: no browsers.json (${(r.err || '').trim().slice(0, 200)})`);
    // Windows `type` may add a BOM.
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  }

  mkdir(p) {
    return this.win ? this.sh(`cmd /c if not exist ${p} mkdir ${p}`) : this.sh(`mkdir -p '${p}'`);
  }

  list(p) {
    const r = this.win ? this.sh(`cmd /c dir /b ${p}`) : this.sh(`ls -1 '${p}'`);
    return r.code === 0 ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  }

  remove(p) {
    return this.win ? this.sh(`cmd /c if exist ${p} rd /s /q ${p}`) : this.sh(`rm -rf '${p}'`);
  }

  removeFile(p) {
    return this.win ? this.sh(`cmd /c del /q ${p}`) : this.sh(`rm -f '${p}'`);
  }

  // Copies a local file to a path on the machine.
  put(local, remotePath) {
    const dest = this.win ? remotePath.replace(/\\/g, '/') : remotePath;
    const r = spawnSync('scp', [...SSH_OPTS, '-q', local, `${this.ssh}:${dest}`], { timeout: 900000, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`scp to ${this.name}: ${(r.stderr || String(r.error)).trim().slice(0, 300)}`);
  }

  // Runs `cmd` on the machine with its 127.0.0.1:port reachable here on the
  // same port: ssh -L, or where the server forbids forwarding, a local
  // listener that pipes each connection through `ssh host nc 127.0.0.1 port`.
  // Returns the ssh process running `cmd` (killing it closes the listener).
  runForwarded(cmd, port, log) {
    const fwd = this.ncForward ? [] : ['-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`];
    const p = spawn('ssh', [...SSH_OPTS, ...fwd, this.ssh, cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (log) { p.stdout.on('data', (d) => log(d)); p.stderr.on('data', (d) => log(d)); }
    if (this.ncForward) {
      const server = net.createServer((sock) => {
        const c = spawn('ssh', [...SSH_OPTS, this.ssh, `nc 127.0.0.1 ${port}`], { stdio: ['pipe', 'pipe', 'ignore'] });
        sock.pipe(c.stdin);
        c.stdout.pipe(sock);
        const end = () => { sock.destroy(); c.kill(); };
        sock.on('close', end); sock.on('error', end); c.on('exit', end); c.stdin.on('error', end);
      });
      server.on('error', (e) => log && log('nc proxy: ' + e.message + '\n'));
      server.listen(port, '127.0.0.1');
      p.on('exit', () => server.close());
      const kill = p.kill.bind(p);
      p.kill = (sig) => { server.close(); return kill(sig); };
    }
    return p;
  }

  // Starts the browser's driver on the machine on `port`, forwarded to the
  // same port here (geckodriver refuses a Host header naming another port).
  // Returns the ssh child process; its output goes to `log`.
  startDriver(entry, { port, log }) {
    if (/\s/.test(entry.driver)) throw new Error('driver path has spaces: ' + entry.driver);
    const args = entry.driverKind === 'geckodriver' ? `--host 127.0.0.1 --port ${port}`
      : entry.driverKind === 'safaridriver' ? `-p ${port}`
        : `--port=${port}`;
    const extra = (entry.driverArgs || []).join(' ');
    // Unix: the driver dies when this connection closes (read sees EOF).
    const cmd = this.win ? `${entry.driver} ${args} ${extra}`
      : `sh -c '${entry.driver} ${args} ${extra} </dev/null & p=$!; read x; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null'`;
    return this.runForwarded(cmd, port, log);
  }

  // For a Chromium with no usable driver on this OS: starts the browser
  // itself, headless, with its DevTools port on `port` there, forwarded to
  // the same port here, and its profile in work/<profile>.
  startCdpBrowser(entry, { port, profile, log }) {
    const args = [...(entry.args || []), `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
      `--user-data-dir=${this.dir('work', profile)}`, '--no-first-run', '--no-default-browser-check', 'about:blank'].join(' ');
    const cmd = this.win ? `"${entry.binary}" ${args}`
      : `sh -c '"${entry.binary}" ${args} </dev/null & p=$!; read x; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null'`;
    return this.runForwarded(cmd, port, log);
  }

  // For a Firefox with no geckodriver that runs on this OS (52 on XP):
  // starts it with Marionette on `port` there, forwarded to the same port
  // here, and a fresh profile in work/<profile> whose user.js sets that port
  // and `prefs`. `tmp` is a local folder for writing user.js.
  startMarionetteBrowser(entry, { port, profile, prefs = {}, tmp, log }) {
    const all = { 'marionette.defaultPrefs.port': port, 'marionette.port': port, ...prefs };
    const userJs = Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\r\n') + '\r\n';
    const local = path.join(tmp, 'user.js');
    fs.writeFileSync(local, userJs);
    const dir = this.dir('work', profile);
    this.mkdir(dir);
    this.put(local, this.win ? dir + '\\user.js' : dir + '/user.js');
    const args = [...(entry.args || []), '-marionette', '-no-remote', '-profile', dir, 'about:blank'].join(' ');
    const cmd = this.win ? `"${entry.binary}" ${args}`
      : `sh -c '"${entry.binary}" ${args} </dev/null & p=$!; read x; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null'`;
    return this.runForwarded(cmd, port, log);
  }

  // Stops the browser startCdpBrowser() or startMarionetteBrowser()
  // started: the process listening on its DevTools or Marionette port, and
  // its children.
  stopCdpBrowser(port) {
    if (this.win) {
      const r = this.sh('netstat -ano');
      const pids = new Set(r.out.split('\n').filter((l) => new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING`).test(l)).map((l) => l.trim().split(/\s+/).pop()));
      for (const pid of pids) if (/^\d+$/.test(pid)) this.sh(`taskkill /F /T /PID ${pid}`);
    } else {
      this.sh(`pkill -u "$(id -u)" -f '[r]emote-debugging-port=${port}' ; true`);
    }
  }

  // The machine's 127.0.0.1:remotePort reaches `to` (host:port) from here,
  // on a connection of its own. Resolves to {proc, port}, or to null with
  // the reason when the SSH server refuses remote forwarding.
  //
  // Pass 0 and the remote sshd picks the port, which is the only side
  // that knows what is free there. The caller used to pick a random
  // number in 30000-39000 and hope: nothing checked it against the
  // remote machine at all, and with four jobs at once two of them
  // choosing the same number is ordinary. What that cost was invisible
  // -- "no reverse tunnel" is a note, not a failure, so the run went
  // ahead and simply never opened the served page, which is the half
  // that exercises talking to a build server (2026-09-23).
  async startReverse(remotePort, to) {
    // -v: ssh says "remote forward success" or "...failed" once the server answers.
    const p = spawn('ssh', [...SSH_OPTS, '-v', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `${remotePort}:${to}`, this.ssh], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', allocated = 0;
    const verdict = await new Promise((res) => {
      const t = setTimeout(() => res('no answer from the SSH server in 45 s'), 45000);
      p.stderr.on('data', (d) => {
        err += d;
        if (/remote forward success/i.test(err)) { clearTimeout(t); res(null); }
        // With -R 0: the server says which port it took.
        const a = /Allocated port (\d+) for remote forward/i.exec(err);
        if (a) allocated = Number(a[1]);
        const m = /^.*(remote port forwarding failed|forwarding failed).*$/im.exec(err);
        if (m) { clearTimeout(t); res(m[0].trim()); }
      });
      p.once('exit', () => { clearTimeout(t); res((err.trim().split('\n').filter((l) => !/^debug/.test(l)).pop()) || 'ssh exited'); });
    });
    if (verdict) { p.kill(); return { proc: null, why: verdict }; }
    const port = remotePort || allocated;
    if (!port) { p.kill(); return { proc: null, why: 'the SSH server did not say which port it took' }; }
    return { proc: p, port };
  }

  // A reverse tunnel, letting the far end choose the port where it can.
  //
  // Not every sshd will: Windows Server 2022's refuses `-R 0:` outright
  // ("remote port forwarding failed for listen port 0"), so asking it to
  // choose is worse than guessing there. Ask first, because only that
  // side knows what is free; fall back to picking a number and trying a
  // few, which is all we could ever do on those machines.
  async reverse(to, tries = 4) {
    const first = await this.startReverse(0, to);
    if (first.proc) return first;
    if (!/listen port 0/i.test(first.why || '')) return first;
    let last = first;
    for (let i = 0; i < tries; i++) {
      last = await this.startReverse(30000 + Math.floor(Math.random() * 9000), to);
      if (last.proc) return last;
    }
    return last;
  }

  // Stops any of the harness's drivers (and the browsers they started) on
  // the machine. Only the harness runs these drivers from these folders.
  stopDrivers(entry) {
    if (this.win) {
      // By the driver's own exe: a .cmd wrapper runs <driverKind>.exe.
      if (entry.driver) this.sh(`taskkill /F /T /IM ${entry.driverKind}.exe`);
    } else {
      // Everything this harness put on the machine lives under
      // ~/tibrowsers, so that is what a leftover looks like.
      //
      // This said `[i]bbrowsers/` until 2026-09-23 -- the directory's
      // name before the ib/ti rename -- so it matched nothing and
      // cleaned nothing, for as long as the rename has been in. Drivers
      // and browsers from earlier runs stayed up, and a later run on
      // that machine would sometimes die with "session deleted as the
      // browser has closed the connection". Nothing said so, because a
      // pkill that matches nothing exits quietly.
      //
      // The brackets stop the pattern matching the shell running it,
      // which is the same trap in a different place: `[t]ibrowsers`
      // matches `tibrowsers` and not itself.
      this.sh(`pkill -u "$(id -u)" -f '[t]ibrowsers/' ; true`);
    }
  }
}
