// The bits of the real bundle the harness calls, under one name.
//
// Everything here but `ustarHeader` is the shipping code: `tarWrite`,
// `concatBytes`, `makeFooter`, `parseFooter` and `sha256Hex` come straight
// out of shared/tifile.js, and `sha256Stream` out of web/lib/sha.js, which
// is what a streaming build in the page would have to use (WebCrypto has no
// incremental digest). `ustarHeader` is the server's one-member header
// (server/lib/files.js) written out here because the browser bundle has no
// equivalent -- it is 512 bytes of format, and none of what is measured.
var TI = (function () {
  var enc = new TextEncoder();

  function octal(n, width) {
    var s = n.toString(8);
    while (s.length < width - 1) s = '0' + s;
    return s;
  }
  function field(h, off, len, str) {
    for (var i = 0; i < str.length && i < len; i++) h[off + i] = str.charCodeAt(i);
  }
  function ustarHeader(name, size) {
    var h = new Uint8Array(512);
    var nb = enc.encode(name);
    h.set(nb, 0);
    field(h, 100, 8, octal(0x1a4, 8) + '\0');
    field(h, 108, 8, octal(0, 8) + '\0');
    field(h, 116, 8, octal(0, 8) + '\0');
    field(h, 124, 12, octal(size, 12) + '\0');
    field(h, 136, 12, octal(0, 12) + '\0');
    field(h, 148, 8, '        ');
    h[156] = 0x30;
    field(h, 257, 6, 'ustar\0');
    field(h, 263, 2, '00');
    field(h, 329, 8, octal(0, 8) + '\0');
    field(h, 337, 8, octal(0, 8) + '\0');
    var sum = 0;
    for (var i = 0; i < 512; i++) sum += h[i];
    var s = sum.toString(8);
    while (s.length < 6) s = '0' + s;
    field(h, 148, 8, s + '\0 ');
    return h;
  }

  function streamHash() {
    var s = __ti_sha.sha256Stream();
    return {
      update: function (b) { s.update(b); },
      hex: function () { return __ti_tifile.bytesToHex(s.digest()); },
    };
  }

  return {
    enc: function (s) { return enc.encode(s); },
    tarWrite: __ti_tifile.tarWrite,
    concatBytes: __ti_tifile.concatBytes,
    makeFooter: __ti_tifile.makeFooter,
    parseFooter: __ti_tifile.parseFooter,
    sha256Hex: __ti_tifile.sha256Hex,
    peChecksum: __ti_tifile.peChecksum,
    bytesToHex: __ti_tifile.bytesToHex,
    ustarHeader: ustarHeader,
    streamHash: streamHash,
    // The shipping one-buffer assembler (mode=ship), so the path the page
    // really runs is measured rather than a copy of it kept in step by hand.
    writeInstallerLayout: __ti_tifile.writeInstallerLayout,
  };
})();
