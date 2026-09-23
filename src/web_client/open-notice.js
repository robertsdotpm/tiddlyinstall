// What the people who receive an installer see when they open it.
//
// Someone building here is building for other people, and the first they
// usually hear of SmartScreen or Gatekeeper is a confused recipient. So the
// form says it while the signing mode is being chosen (src/web_client/new.js), and the
// downloads say it again beside each file, which is the moment before the
// file is handed over (src/web_client/build.js). Both read this one table, so the two
// screens cannot drift apart.
//
// The facts, and where they come from:
//
//   Linux      no gatekeeping of any kind, in any mode. Worth saying: its
//              absence from the list would read as an oversight.
//   Windows    SmartScreen is reputation, not signature. Microsoft's own
//              page (learn.microsoft.com/windows/apps/package-and-deploy/
//              smartscreen-reputation, read 2026-09-21) puts OV and EV in
//              one row -- "Warning -- app flagged as unrecognized until
//              reputation accumulates; verified publisher name is
//              displayed" -- and says outright that EV certificates no
//              longer bypass SmartScreen, a behaviour Microsoft removed in
//              2024. So signing helps over time; it does not help at once,
//              and paying for EV does not change that.
//   macOS      a browser-downloaded app with no notarization ticket is
//              killed (SIGKILL), not warned about. Measured on this
//              project's own builds: docs/macos-packaging.md section 5,
//              cases A and B, exit 137 both unsigned and ad-hoc signed --
//              "an ad-hoc signature buys nothing over no signature at
//              all". A Developer ID signature without a ticket is in the
//              same position, which is the point people miss. The quarantine
//              flag is what triggers it, and only a browser sets it.
//
// Mode A ("Signed by TiddlyInstall") is disabled in this prototype, so it
// has no text here: there is nothing truthful to say about a file nobody
// can build yet. openNotice() returns '' for it rather than guessing.

export const OPEN_PLATFORMS = ['windows', 'linux', 'macos'];

export const OPEN_PLATFORM_LABEL = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

// Said for both macOS modes: only a browser sets com.apple.quarantine, and
// it is the quarantine flag Gatekeeper acts on. For anyone distributing
// inside a company this is the whole answer, so it is not left out.
const MAC_OTHER_WAYS = ' Sent any other way - curl, scp, a USB stick, an ' +
  'internal share - it is not quarantined, and it simply runs.';

const LINUX = 'Nothing at all: it runs. Linux has no signature check and no warning to get past.';

const TEXT = {
  windows: {
    unsigned: 'SmartScreen shows "Windows protected your PC". More info → Run anyway, ' +
      'in that same box, gets past it.',
    yours: 'SmartScreen still shows "Windows protected your PC", now naming you as the ' +
      'verified publisher, until your certificate has enough clean downloads behind it; ' +
      'More info → Run anyway gets past it meanwhile. Signing helps over time, not at ' +
      'once, and an EV certificate no longer skips this.',
  },
  linux: {
    unsigned: LINUX,
    yours: LINUX,
  },
  macos: {
    unsigned: 'Gatekeeper kills it rather than warning: a browser download will not open at all. ' +
      'To run it they open it once, then go to System Settings → Privacy & Security, press ' +
      'Open Anyway beside the blocked app, and open it again. Control-click → Open no longer ' +
      'works on macOS 15 and later.' + MAC_OTHER_WAYS,
    yours: 'A signature alone is not enough: Apple also wants a notarization ticket, and without ' +
      'one Gatekeeper treats it exactly as an unsigned app, so a browser download will not open. ' +
      'Notarized, it opens with nothing at all; otherwise they need System Settings → Privacy ' +
      '& Security → Open Anyway, then open it again.' + MAC_OTHER_WAYS,
  },
};

// What to do when Windows will not open it, which depends on the Windows.
//
// The line above says what the box looks like; this says how to get past
// it, and the two are not the same answer on every version. On Windows 11
// the "Run anyway" button is not always there: Smart App Control, which is
// on by default on some clean installs, blocks an unrecognised app with no
// way past in that box at all, and a managed machine can be set the same
// way. What is left then is the mark itself. Windows puts a Zone.Identifier
// on anything a browser downloaded and acts on that mark rather than on the
// file, so clearing it -- Properties, Unblock -- is what makes the file
// open. That step is missing from every version of this text we have shown
// anyone, and it is the one the operator needed on Windows 11 (2026-09-23).
//
// All four are always rendered: most people building here are building for
// somebody else, on a Windows we cannot see. Where we can tell which one
// the reader is on, that row is marked, and the rest stay.
export const WINDOWS_OPEN_STEPS = [
  { id: '11', label: 'Windows 11',
    text: 'SmartScreen shows "Windows protected your PC": More info \u2192 Run anyway. ' +
      'Where that button is not there -- Smart App Control, or a machine someone else ' +
      'manages -- right-click the file \u2192 Properties \u2192 General \u2192 tick Unblock \u2192 OK, ' +
      'and open it again.' },
  { id: '10', label: 'Windows 10',
    text: 'The same "Windows protected your PC" box: More info \u2192 Run anyway. If it will not ' +
      'start at all, right-click \u2192 Properties \u2192 General \u2192 Unblock \u2192 OK, then open it again.' },
  { id: '8', label: 'Windows 8 and 8.1',
    text: '"Windows SmartScreen prevented an unrecognized app from starting": More info \u2192 ' +
      'Run anyway, or Properties \u2192 General \u2192 Unblock first.' },
  { id: '7', label: 'Windows 7 and earlier',
    text: 'No SmartScreen for a downloaded file: an "Open File - Security Warning" box saying ' +
      'the publisher could not be verified. Press Run, or Properties \u2192 General \u2192 Unblock ' +
      'to stop it asking.' },
];

// Which Windows the person reading this is on, as one of those ids, or ''
// when we cannot tell. Asynchronous because 11 cannot be told from 10 any
// other way: both say "Windows NT 10.0" in the user agent, and only client
// hints carry the real version -- which only Chromium-based browsers have.
// Everyone else gets '' and nothing is marked, which is the honest answer
// rather than a guess of 10.
export function detectWindows(cb) {
  const ua = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '';
  const m = /Windows NT ([\d.]+)/.exec(ua);
  if (!m) { cb(''); return; }
  const nt = parseFloat(m[1]);
  if (nt < 6.2) { cb('7'); return; }        // 6.0 Vista, 6.1 Windows 7
  if (nt < 10) { cb('8'); return; }         // 6.2 Windows 8, 6.3 Windows 8.1
  const ch = navigator.userAgentData;
  if (!ch || !ch.getHighEntropyValues) { cb(''); return; }
  // The same rule browser-check.js uses: platformVersion's major is 13 or
  // more on Windows 11, and 1..12 on Windows 10.
  ch.getHighEntropyValues(['platformVersion']).then(function (h) {
    const major = parseInt(h && h.platformVersion, 10);
    cb(major >= 13 ? '11' : major > 0 ? '10' : '');
  }, function () { cb(''); });
}

// One platform, one mode ('yours' or 'unsigned'). '' where there is nothing
// honest to say -- an unknown platform, or mode A.
export function openNotice(platform, mode) {
  const row = TEXT[platform];
  if (!row || (mode !== 'yours' && mode !== 'unsigned')) return '';
  return row[mode];
}

// The same, for a set of platforms, in a fixed order: [{platform, label, text}].
export function openNotices(platforms, mode) {
  const out = [];
  for (let i = 0; i < OPEN_PLATFORMS.length; i++) {
    const p = OPEN_PLATFORMS[i];
    if (platforms.indexOf(p) < 0) continue;
    const text = openNotice(p, mode);
    if (text) out.push({ platform: p, label: OPEN_PLATFORM_LABEL[p], text });
  }
  return out;
}
