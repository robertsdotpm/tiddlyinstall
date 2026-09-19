// The test machines, as tests/matrix/run.py lists them (WINDOWS, LINUX_VMS,
// MAC), and what the browser harness does on them over SSH: read the
// browser manifest, copy files, start a WebDriver driver bound to
// 127.0.0.1 there and reach it through `ssh -L`, clean up.
//
// On each machine (docs/test-vms.md, "Browsers"):
//   Windows      C:\ibbrowsers\browsers.json, drivers\, work\
//   Linux, Mac   ~/ibbrowsers/browsers.json, drivers/, work/
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

export class Remote {
  constructor(m) {
    Object.assign(this, m);
    this.win = m.os === 'windows';
    this.home = null;          // Unix: $HOME, from readManifest()
  }

  sh(cmd, { input, timeout = 120000 } = {}) {
    const r = spawnSync('ssh', [...SSH_OPTS, this.ssh, cmd], { input, timeout, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { code: r.status === null ? 124 : r.status, out: (r.stdout || '').replace(/\r/g, ''), err: (r.stderr || '').replace(/\r/g, '') + (r.error ? String(r.error) : '') };
  }

  // Folder under the harness root, as a path on the machine.
  dir(...parts) {
    return this.win ? ['C:\\ibbrowsers', ...parts].join('\\') : [this.home + '/ibbrowsers', ...parts].join('/');
  }

  fileUrl(p) { return this.win ? 'file:///' + p.replace(/\\/g, '/') : 'file://' + p; }

  // Reads browsers.json (and $HOME on Unix). Returns the parsed manifest.
  readManifest() {
    const r = this.win
      ? this.sh('type C:\\ibbrowsers\\browsers.json')
      : this.sh('echo "@HOME $HOME"; cat ~/ibbrowsers/browsers.json');
    let text = r.out;
    if (!this.win) {
      const m = /^@HOME (.*)$/m.exec(text);
      if (m) this.home = m[1].trim();
      text = text.replace(/^@HOME .*\n/m, '');
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
    const p = spawn('ssh', [...SSH_OPTS, '-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`, this.ssh, cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (log) { p.stdout.on('data', (d) => log(d)); p.stderr.on('data', (d) => log(d)); }
    return p;
  }

  // The machine's 127.0.0.1:remotePort reaches `to` (host:port) from here,
  // on a connection of its own. Resolves to the ssh process, or to null
  // with the reason when the SSH server refuses remote forwarding.
  async startReverse(remotePort, to) {
    const p = spawn('ssh', [...SSH_OPTS, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `${remotePort}:${to}`, this.ssh], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const exited = await new Promise((res) => { p.once('exit', () => res(true)); setTimeout(() => res(false), 6000); });
    if (exited) return { proc: null, why: (err.trim() || 'ssh exited').split('\n').pop() };
    return { proc: p };
  }

  // Stops any of the harness's drivers (and the browsers they started) on
  // the machine. Only the harness runs these drivers from these folders.
  stopDrivers(entry) {
    if (this.win) {
      const exe = path.win32.basename(entry.driver || '');
      if (exe) this.sh(`taskkill /F /T /IM ${exe}`);
    } else {
      // [i] so the pattern doesn't match this shell's own command line.
      this.sh(`pkill -u "$(id -u)" -f '[i]bbrowsers/' ; true`);
    }
  }
}
