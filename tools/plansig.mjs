// Signs and checks plan files with the server's plan signing key
// (docs/format.md "Plan signature"), with the build server's own code
// (server/lib/plansig.js). For tests and for operators; the server signs
// plans itself.
//
//   node tools/plansig.mjs -data DIR sign plan.txt > signed.txt   (makes the key if DIR has none)
//   node tools/plansig.mjs -pub FILE verify signed.txt [record]   (FILE: plan-signing-key.pub)
//
// -kind KIND signs or checks another document the plan key signs, today
// only the revocation list (docs/format.md section 7):
//
//   node tools/plansig.mjs -data DIR -kind ib-revocations sign list.txt
import fs from 'node:fs';
import { loadOrCreate, verify, verifyFor, keyID, recordOf } from '../server/lib/plansig.js';

function fail(msg) {
  process.stderr.write('plansig: ' + msg + '\n');
  process.exit(1);
}

const flags = { data: '', pub: '', kind: 'ib-plan' };
const args = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--?(data|pub|kind)(?:=(.*))?$/.exec(argv[i]);
  if (m) flags[m[1]] = m[2] !== undefined ? m[2] : argv[++i] ?? '';
  else args.push(argv[i]);
}
if (args.length < 2) {
  process.stderr.write('usage: plansig.mjs -data DIR sign PLAN | plansig.mjs -pub FILE verify PLAN [RECORD]\n');
  process.exit(2);
}
let doc;
try { doc = fs.readFileSync(args[1]); } catch (e) { fail(e.message); }
try {
  switch (args[0]) {
    case 'sign': {
      const { signer } = loadOrCreate(flags.data, (s) => process.stderr.write(s + '\n'));
      process.stdout.write(signer.signAs(flags.kind, doc));
      break;
    }
    case 'verify': {
      const pub = Buffer.from(fs.readFileSync(flags.pub, 'utf8').trim(), 'base64');
      if (pub.length !== 32) fail(`${flags.pub}: not a base64 Ed25519 public key`);
      if (args.length > 2) verifyFor(pub, doc, args[2]); else verify(pub, doc, flags.kind);
      process.stdout.write(`ok (key ${keyID(pub)}${flags.kind === 'ib-plan' ? ', record ' + recordOf(doc) : ', ' + flags.kind})\n`);
      break;
    }
    default:
      fail(`unknown command ${JSON.stringify(args[0])}`);
  }
} catch (e) {
  fail(e.message);
}
