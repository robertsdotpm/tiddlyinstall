// Withdrawing something, without editing a file by hand.
//
//   node tools/takedown.mjs list
//   node tools/takedown.mjs add    record a3tnrikjwrpke5bhhvxfxctvbf
//   node tools/takedown.mjs add    source github owner/repo
//   node tools/takedown.mjs add    file 0123...64 hex...
//   node tools/takedown.mjs remove record a3tnrikjwrpke5bhhvxfxctvbf
//   node tools/takedown.mjs check  [-server URL]          # what a server has in force
//
//   -data DIR    the server's data folder (default src/build_server/data)
//   -server URL  ask this server afterwards (default http://127.0.0.1:8080)
//   -n           print what would change and write nothing
//
// Why this exists. The mechanism is one line appended to takedown.txt and
// it is good: read per request, in force immediately, nothing to restart,
// reversible by deleting the line. The danger is not the file, it is that
// a line which is *nearly* right does nothing at all and looks exactly
// like one that works. The server compares whole lines
// (`takedownList().includes(entry)`), so `record  a3tn...` with two
// spaces, `records a3tn...`, a capitalised hash or a trailing character
// is silently not a withdrawal -- and the thing you were withdrawing goes
// on being served while the file says you withdrew it.
//
// So every entry here is checked against the form docs/format.md section
// 7 gives before it is written, the file is written atomically, and the
// server is asked afterwards whether the entry is actually in force.
// Nothing here can withdraw something the format cannot express.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function die(msg, code = 1) {
  process.stderr.write('takedown: ' + msg + '\n');
  process.exit(code);
}

const argv = process.argv.slice(2);
const flags = { data: path.join(REPO, 'src/build_server/data'), server: 'http://127.0.0.1:8080', n: false };
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-n' || a === '--dry-run') { flags.n = true; continue; }
  const m = /^--?(data|server)(?:=(.*))?$/.exec(a);
  if (m) { flags[m[1]] = m[2] !== undefined ? m[2] : argv[++i] ?? ''; continue; }
  args.push(a);
}

// The forms docs/format.md section 7 gives, and nothing else. Each one
// says what it is for, because the message a person needs when an entry
// is refused is which kind they meant.
const KINDS = [
  { re: /^record [0-9a-z]{26}$/, hint: 'record <26 lowercase base32 characters>: one build\'s exact settings' },
  { re: /^source github [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, hint: 'source github <owner/repo>: anything built from that repository' },
  { re: /^source package [A-Za-z0-9._@\/-]+$/, hint: 'source package <name>: anything built from that package' },
  { re: /^sha [0-9a-f]{64}$/, hint: 'sha <64 lowercase hex>: a file we store (a written source, an icon)' },
  { re: /^file [0-9a-f]{64}$/, hint: 'file <64 lowercase hex>: those bytes wherever they come from' },
];

function entryOf(parts) {
  const entry = parts.join(' ');
  if (KINDS.some((k) => k.re.test(entry))) return entry;
  // The near-misses worth naming, because they are what people actually
  // type and what silently does nothing.
  const why = [];
  if (/[A-F]/.test(entry) && /^(sha|file) /.test(entry)) why.push('the hash has capitals; the server compares whole lines, so it must be lowercase');
  if (/^records? /.test(entry) && !/^record /.test(entry)) why.push('the kind is "record", not "records"');
  die('not an entry this list can hold: ' + JSON.stringify(entry) +
    (why.length ? '\n  ' + why.join('\n  ') : '') +
    '\n\n  the kinds are:\n' + KINDS.map((k) => '    ' + k.hint).join('\n'));
}

const file = path.join(flags.data, 'takedown.txt');
const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const entries = (text) => text.split('\n').map((l) => l.replace(/^[\s\u0085 ]+|[\s\u0085 ]+$/g, ''))
  .filter((l) => l !== '' && !l.startsWith('#'));

// Written to a temporary file in the same folder and renamed, so a server
// reading it per request never sees a half-written list.
function write(text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

async function ask() {
  const url = flags.server.replace(/\/+$/, '') + '/api/takedown';
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { err: 'answered ' + r.status };
    const j = await r.json();
    return { entries: j.entries || [] };
  } catch (e) {
    return { err: (e && e.message) || String(e) };
  }
}

// Saying what the file holds is not the same as saying what is in force:
// the point of asking is that a server reading a different data folder,
// or not running at all, is exactly the failure this tool exists to make
// visible.
async function report(want) {
  const a = await ask();
  if (a.err) {
    process.stderr.write(`\n  could not ask ${flags.server}: ${a.err}\n` +
      '  The file is written. Whether it is in force depends on a server reading\n' +
      '  this folder; -server names a different one.\n');
    return;
  }
  if (want === null) {
    process.stdout.write(`\n${flags.server} has ${a.entries.length} in force\n`);
    for (const e of a.entries) process.stdout.write('  ' + e + '\n');
    return;
  }
  const inForce = a.entries.includes(want.entry);
  const good = want.adding ? inForce : !inForce;
  process.stdout.write(`\n${good ? 'ok  ' : 'FAIL'}  ${flags.server} ${inForce ? 'has' : 'does not have'} ${JSON.stringify(want.entry)}` +
    ` (${want.adding ? 'added' : 'removed'})\n`);
  if (!good) {
    process.stderr.write('  That server is not reading this folder, or is not the one you meant.\n');
    process.exit(1);
  }
}

const cmd = args[0] || '';
if (cmd === 'list') {
  const list = entries(read());
  process.stdout.write(`${file}: ${list.length} entr${list.length === 1 ? 'y' : 'ies'}\n`);
  for (const e of list) process.stdout.write('  ' + e + '\n');
  await report(null);
} else if (cmd === 'check') {
  await report(null);
} else if (cmd === 'add' || cmd === 'remove') {
  if (args.length < 2) die(`usage: takedown.mjs ${cmd} <kind> <value...>`, 2);
  const entry = entryOf(args.slice(1));
  const text = read();
  const has = entries(text).includes(entry);
  if (cmd === 'add') {
    if (has) { process.stdout.write(`already withdrawn: ${entry}\n`); await report({ entry, adding: true }); process.exit(0); }
    const next = (text === '' || text.endsWith('\n') ? text : text + '\n') + entry + '\n';
    if (flags.n) { process.stdout.write(`would add to ${file}:\n  ${entry}\n`); process.exit(0); }
    write(next);
    process.stdout.write(`withdrew: ${entry}\n`);
    await report({ entry, adding: true });
  } else {
    if (!has) { process.stdout.write(`not withdrawn, nothing to do: ${entry}\n`); process.exit(0); }
    const kept = text.split('\n').filter((l) => l.replace(/^\s+|\s+$/g, '') !== entry);
    if (flags.n) { process.stdout.write(`would remove from ${file}:\n  ${entry}\n`); process.exit(0); }
    write(kept.join('\n').replace(/\n+$/, '\n'));
    process.stdout.write(`put back: ${entry}\n`);
    await report({ entry, adding: false });
  }
} else {
  process.stderr.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter((l) => l.startsWith('//')).slice(0, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(2);
}
