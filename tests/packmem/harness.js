// The packing measurement harness (docs/browser-packing.md).
//
// A classic script appended to a bundle of the real modules (shared/tifile.js
// and what it imports), built by tests/packmem/build.py. It runs the *real*
// assembly path -- tarWrite, concatBytes, the footer, the PE checksum, the
// SHA-256, the Blob -- over a synthetic pack of a chosen size, and reports
// what happened and when, so an outside sampler can line the peaks up with
// the steps.
//
// It measures; it does not build anything a person would keep. The pack
// members are filler bytes, not runtime files: what matters here is how many
// copies of them exist at once, which does not depend on what is in them.
//
// URL query:
//   steps=32,64,128,256      pack sizes in MB, tried in order
//   members=4                pack members per step (the pack is split evenly)
//   mode=blob|onebuf|opfs|chunk
//                            blob:   today's path (one Uint8Array, then a Blob)
//                            onebuf: the same single file, assembled into one
//                                    buffer allocated up front, hashed with a
//                                    streaming SHA-256: no tar copy, no concat
//                                    copy, no digest copy
//                            opfs:   stream to an OPFS file, one chunk at a
//                                    time (the save-picker shape)
//                            chunk:  like opfs but no file, to price the loop
//   base=6                   base-installer size in MB (the .exe/.run we append to)
//   pause=700                ms of quiet around each sub-step, for the sampler
//   report=http://host:port/ where to POST each event (optional)
//   run=NAME                 a label carried on every event
//   auto=0                   wait for a click instead of starting at once
//
// Every event also goes to the page and to document.title, so a driver with
// no network back to us can still read the result.
(function () {
  'use strict';

  var Q = (function () {
    var q = {}, s = String(location.search || '').replace(/^\?/, '');
    var parts = s ? s.split('&') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      q[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    }
    return q;
  })();
  var num = function (k, d) { var v = parseFloat(Q[k]); return isFinite(v) ? v : d; };
  var MB = 1024 * 1024;

  var STEPS = (Q.steps || '16,32,64,128,192,256,384,512,768,1024').split(',')
    .map(function (x) { return parseFloat(x); }).filter(function (x) { return isFinite(x) && x > 0; });
  var MEMBERS = Math.max(1, num('members', 4));
  var MODE = Q.mode || 'blob';
  var BASE_MB = num('base', 6);
  var PAUSE = num('pause', 700);
  var REPORT = Q.report || '';
  var RUN = Q.run || 'run';
  var AUTO = Q.auto !== '0';

  var out = document.getElementById('out');
  var seq = 0;

  function say(ev) {
    ev.run = RUN;
    ev.t = Date.now();
    ev.seq = ++seq;
    var line = JSON.stringify(ev);
    if (out) {
      var d = document.createElement('div');
      d.appendChild(document.createTextNode(line));
      out.appendChild(d);
    }
    try { document.title = 'packmem ' + (ev.step || '') + ' ' + (ev.what || ''); } catch (e) {}
    if (REPORT) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', REPORT, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(line);
      } catch (e) {}
    }
    if (window.console && console.log) console.log(line);
  }

  // What the page can see of its own memory. Chromium only, and only a
  // number to compare with the sampler's, never instead of it.
  function selfMem() {
    try {
      if (window.performance && performance.memory) {
        return { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit };
      }
    } catch (e) {}
    return null;
  }

  function wait(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  // A mark the sampler lines its RSS readings up with: the page goes quiet
  // for `PAUSE` ms with exactly the allocations of this sub-step alive.
  function mark(step, what, extra) {
    var ev = { step: step, what: what, mem: selfMem() };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) ev[k] = extra[k];
    say(ev);
    return wait(PAUSE);
  }

  /* ---------- the synthetic pack ---------- */

  // Filler with a little structure, so a compressing layer (a zip, a
  // filesystem) cannot make it disappear and flatter the numbers.
  function filler(n, salt) {
    var u = new Uint8Array(n);
    var x = (salt * 2654435761) >>> 0;
    for (var i = 0; i < n; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      u[i] = x >>> 24;
    }
    return u;
  }

  /* ---------- the three paths ---------- */

  // What the page does today (web/local-api.js -> shared/builder.js
  // buildFile -> tifile.writeInstaller -> a Blob and an object URL).
  async function blobPath(step, mb) {
    var each = Math.floor((mb * MB) / MEMBERS);
    var pack = [];
    await mark(step, 'start', { mb: mb, members: MEMBERS, mode: MODE });
    for (var i = 0; i < MEMBERS; i++) {
      // The real path holds every member at once: builder.js fills
      // `pack[]` before it writes anything.
      pack.push({ name: hex64(i), size: each, data: filler(each, i + 1) });
    }
    await mark(step, 'pack-held', { bytes: each * MEMBERS });

    var base = filler(Math.round(BASE_MB * MB), 99);
    var base0 = base.length;
    var record = TI.enc('ti-record 1\nname packmem\n');
    var plan = TI.enc('');
    await mark(step, 'base-held');

    var packBytes = TI.tarWrite(pack);
    await mark(step, 'tar-written', { bytes: packBytes.length });

    var footer = TI.makeFooter(record.length, plan.length, packBytes.length);
    var data = TI.concatBytes([base, record, plan, packBytes, footer]);
    await mark(step, 'concat', { bytes: data.length });

    // Freeing what the real path frees at this point: `pack` and
    // `packBytes` go out of scope when writeInstaller returns, but the
    // caller still holds `data`.
    pack = null; packBytes = null; base = null;
    await mark(step, 'intermediates-dropped');

    var sha = await TI.sha256Hex(data);
    await mark(step, 'hashed', { sha: sha.slice(0, 16) });

    var blob = new Blob([data], { type: 'application/octet-stream' });
    await mark(step, 'blob', { bytes: blob.size });

    var url = URL.createObjectURL(blob);
    await mark(step, 'url');

    // Proof it is not silently short: read the footer back out of the Blob
    // itself, which is what a download would carry.
    var tail = await readTail(blob, 64);
    var f = footerFields(tail);
    var want = packSizeOf(MEMBERS, each);
    var okFooter = !!f && f.pack === want &&
      blob.size === base0 + record.length + plan.length + f.pack + 64;
    await mark(step, 'verified', { blobSize: blob.size, footer: f ? f.pack : -1, want: want, ok: okFooter });

    URL.revokeObjectURL(url);
    return { ok: okFooter, bytes: blob.size };
  }

  // What the page could do instead, with no new browser API: work out the
  // finished length first (it is known -- every member's size is in the
  // record), allocate that one buffer, and write each member into it as it
  // arrives. The tar copy and the concat copy both disappear, and the
  // SHA-256 is taken with web/lib/sha.js's streaming hash rather than
  // crypto.subtle, which cannot digest without a copy.
  async function oneBufPath(step, mb) {
    var each = Math.floor((mb * MB) / MEMBERS);
    var record = TI.enc('ti-record 1\nname packmem\n');
    var baseLen = Math.round(BASE_MB * MB);
    var packLen = packSizeOf(MEMBERS, each);
    var total = baseLen + record.length + packLen + 64;
    await mark(step, 'start', { mb: mb, members: MEMBERS, mode: MODE, total: total });

    var out = new Uint8Array(total);
    var o = 0;
    await mark(step, 'buffer-allocated', { bytes: total });

    // The base: in the real path this is already in the page (it is one of
    // the #base-* blocks), so it is made here rather than counted twice.
    var base = filler(baseLen, 99);
    out.set(base, o); o += baseLen;
    base = null;
    out.set(record, o); o += record.length;
    await mark(step, 'base-copied', { at: o });

    for (var i = 0; i < MEMBERS; i++) {
      var hdr = TI.ustarHeader(hex64(i), each);
      out.set(hdr, o); o += 512;
      // One member at a time: this is where a fetch would write straight
      // into the buffer instead of keeping its own ArrayBuffer.
      var m = filler(each, i + 1);
      out.set(m, o); o += each;
      m = null;
      o += (512 - (each % 512)) % 512;
      await mark(step, 'member-' + i, { at: o });
    }
    o += 1024;
    out.set(TI.makeFooter(record.length, 0, packLen), o); o += 64;
    await mark(step, 'assembled', { at: o, total: total });

    var h = TI.streamHash();
    var STRIDE = 1 << 20;
    for (var p = 0; p < total; p += STRIDE) h.update(out.subarray(p, Math.min(total, p + STRIDE)));
    var sha = h.hex();
    await mark(step, 'hashed', { sha: sha.slice(0, 16) });

    var blob = new Blob([out], { type: 'application/octet-stream' });
    out = null;
    await mark(step, 'blob', { bytes: blob.size });
    var url = URL.createObjectURL(blob);
    var tail = await readTail(blob, 64);
    var f = footerFields(tail);
    var ok = !!f && f.pack === packLen && blob.size === total && o === total;
    await mark(step, 'verified', { blobSize: blob.size, ok: ok });
    URL.revokeObjectURL(url);
    return { ok: ok, bytes: blob.size };
  }

  // The save-picker shape: one chunk in memory at a time, written straight
  // out. Measured against OPFS, whose writable stream is the same
  // FileSystemWritableFileStream showSaveFilePicker() hands back, so the
  // memory shape is the same; only where the file lands differs.
  async function opfsPath(step, mb, sink) {
    var CHUNK = Math.round(num('chunk', 4) * MB);
    var total = Math.round(mb * MB);
    var each = Math.floor(total / MEMBERS);
    await mark(step, 'start', { mb: mb, members: MEMBERS, mode: MODE, chunk: CHUNK });

    var written = 0;
    var h = TI.streamHash();
    var base = filler(Math.round(BASE_MB * MB), 99);
    var base0 = base.length;
    await sink.write(base);
    h.update(base);
    written += base.length;
    base = null;
    var record = TI.enc('ti-record 1\nname packmem\n');
    await sink.write(record); h.update(record); written += record.length;
    await mark(step, 'base-written', { bytes: written });

    var packLen = 0;
    for (var i = 0; i < MEMBERS; i++) {
      var hdr = TI.ustarHeader(hex64(i), each);
      await sink.write(hdr); h.update(hdr); written += hdr.length; packLen += hdr.length;
      var left = each;
      while (left > 0) {
        var n = Math.min(CHUNK, left);
        // The real thing would have fetched this chunk; here it is made.
        var c = filler(n, i + 1);
        await sink.write(c); h.update(c); written += n; packLen += n; left -= n;
        c = null;
      }
      var pad = (512 - (each % 512)) % 512;
      if (pad) { var p = new Uint8Array(pad); await sink.write(p); h.update(p); written += pad; packLen += pad; }
      await mark(step, 'member-' + i, { written: written });
    }
    var end = new Uint8Array(1024);
    await sink.write(end); h.update(end); written += 1024; packLen += 1024;
    var footer = TI.makeFooter(record.length, 0, packLen);
    await sink.write(footer); h.update(footer); written += footer.length;
    var size = await sink.close();
    await mark(step, 'closed', { written: written, onDisk: size, sha: h.hex().slice(0, 16) });
    return { ok: size === written, bytes: written };
  }

  /* ---------- sinks ---------- */

  async function opfsSink(name) {
    var root = await navigator.storage.getDirectory();
    var fh = await root.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    return {
      write: function (b) { return w.write(b); },
      close: async function () {
        await w.close();
        var f = await fh.getFile();
        var size = f.size;
        await root.removeEntry(name);
        return size;
      },
    };
  }

  function nullSink() {
    var n = 0;
    return { write: function (b) { n += b.length; return Promise.resolve(); }, close: function () { return Promise.resolve(n); } };
  }

  /* ---------- small helpers the bundle does not export ---------- */

  function hex64(i) {
    var s = i.toString(16);
    while (s.length < 64) s = '0' + s;
    return s;
  }

  // The footer's own three lengths, read out of the last 64 bytes alone;
  // tifile.parseFooter wants the whole file behind them.
  function footerFields(f) {
    if (f.length !== 64 || f[63] !== 10) return null;
    var magic = 'TIMETA1 ';
    for (var i = 0; i < magic.length; i++) if (f[i] !== magic.charCodeAt(i)) return null;
    var offs = [8, 21, 34], nums = [];
    for (var k = 0; k < 3; k++) {
      var n = 0;
      for (var j = 0; j < 12; j++) {
        var c = f[offs[k] + j];
        if (c < 48 || c > 57) return null;
        n = n * 10 + (c - 48);
      }
      nums.push(n);
    }
    return { record: nums[0], plan: nums[1], pack: nums[2] };
  }

  function packSizeOf(members, each) {
    var n = 1024;
    for (var i = 0; i < members; i++) n += 512 + Math.ceil(each / 512) * 512;
    return n;
  }

  function readTail(blob, n) {
    return new Promise(function (res, rej) {
      var part = blob.slice(blob.size - n);
      if (part.arrayBuffer) { part.arrayBuffer().then(function (b) { res(new Uint8Array(b)); }, rej); return; }
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(r.error); };
      r.readAsArrayBuffer(part);
    });
  }

  /* ---------- the ramp ---------- */

  async function one(step, mb) {
    if (MODE === 'blob') return blobPath(step, mb);
    if (MODE === 'onebuf') return oneBufPath(step, mb);
    var sink = MODE === 'opfs' ? await opfsSink('packmem-' + step + '.bin') : nullSink();
    return opfsPath(step, mb, sink);
  }

  async function ramp() {
    say({ what: 'begin', ua: navigator.userAgent, mode: MODE, members: MEMBERS, base: BASE_MB,
          steps: STEPS.join(','), dm: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0,
          mem: selfMem() });
    for (var i = 0; i < STEPS.length; i++) {
      var mb = STEPS[i];
      var step = String(mb);
      var t0 = Date.now();
      try {
        var r = await one(step, mb);
        say({ step: step, what: 'done', ok: r.ok, bytes: r.bytes, ms: Date.now() - t0, mem: selfMem() });
      } catch (e) {
        say({ step: step, what: 'failed', error: String((e && e.message) || e),
              name: String((e && e.name) || ''), ms: Date.now() - t0, mem: selfMem() });
        say({ what: 'end', lastOk: i ? STEPS[i - 1] : 0, failedAt: mb });
        return;
      }
      // Let the collector settle and give the engine a chance to collect.
      await wait(PAUSE * 2);
      say({ step: step, what: 'after-gc', mem: selfMem() });
    }
    say({ what: 'end', lastOk: STEPS[STEPS.length - 1], failedAt: 0 });
  }

  window.packmemStart = function () { ramp(); };
  if (AUTO) {
    if (document.readyState === 'complete') setTimeout(ramp, 300);
    else window.addEventListener('load', function () { setTimeout(ramp, 300); });
  }
})();
