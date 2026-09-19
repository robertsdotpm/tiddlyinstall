// Fidelity check: what real Node.js apps rely on (docs/test-results.md, "Real-app fidelity").
// Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
// Written for Node.js 4 and later (no async/await, no arrow functions in checks that old Node parses).
'use strict';
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var checks = [];
function check(name, fn) { checks.push([name, fn]); }
function line(s) { process.stdout.write(s + '\n'); }
function clean(e) { return String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300); }

check('native-addon', function (done) {
  var Database = require('better-sqlite3');
  var db = new Database(':memory:');
  db.exec('create table t (a int)');
  db.prepare('insert into t values (?)').run(42);
  var v = db.prepare('select sqlite_version() as v').get().v;
  var pkg = require('better-sqlite3/package.json');
  done(null, 'better-sqlite3 ' + pkg.version + ', sqlite ' + v);
});

check('https', function (done) {
  require('https').get('https://registry.npmjs.org/-/ping', function (res) {
    res.resume();
    res.on('end', function () { done(res.statusCode === 200 ? null : 'HTTP ' + res.statusCode, 'OpenSSL ' + process.versions.openssl); });
  }).on('error', done);
});

check('crypto-zlib', function (done) {
  var h = require('crypto').createHash('sha256').update('x').digest('hex');
  var z = require('zlib');
  var back = z.gunzipSync(z.gzipSync(Buffer.from ? Buffer.from('hello') : new Buffer('hello'))).toString();
  done(back === 'hello' && h.length === 64 ? null : 'round trip', 'ok');
});

check('npm', function (done) {
  var dir = path.dirname(process.execPath);
  var cands = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  var cli = cands.filter(function (p) { return fs.existsSync(p); })[0];
  if (!cli) return done('npm-cli.js not found next to ' + process.execPath);
  cp.execFile(process.execPath, [cli, '--version'], function (err, out) { done(err, 'npm ' + String(out).trim()); });
});

check('child-process', function (done) {
  cp.execFile(process.execPath, ['-e', 'console.log(1+1)'], function (err, out) { done(err || (String(out).trim() === '2' ? null : 'got ' + out), 'ok'); });
});

check('intl', function (done) {
  var s = new Intl.NumberFormat('de-DE').format(1234.5);
  done(s === '1.234,5' ? null : 'de-DE gave ' + s + ' (small-icu?)', 'ICU ' + process.versions.icu);
});

line('FID start node ' + process.version + ' ' + process.platform + ' ' + process.arch);
(function next(i) {
  if (i >= checks.length) return line('FID end');
  var name = checks[i][0], finished = false;
  var done = function (err, detail) {
    if (finished) return;
    finished = true;
    line(err ? 'FID fail ' + name + ': ' + clean(err) : 'FID ok ' + name + (detail ? ': ' + detail : ''));
    next(i + 1);
  };
  try { checks[i][1](done); } catch (e) { done(e); }
})(0);
