// Checks npm and the tools around it, for every Node the catalogue can
// install (0.10 upwards), so ES5 only: no let, const, arrow functions or
// template strings.
var cp = require("child_process");
var path = require("path");
var fs = require("fs");

function say(state, name, detail) {
  console.log("TOOL " + state + " " + name + ": " + detail);
}

function check(name, fn) {
  try {
    say("ok", name, fn());
  } catch (e) {
    say(e && e.skip ? "skip" : "fail", name, String((e && e.message) || e).slice(0, 200));
  }
}

function skip(why) {
  var e = new Error(why);
  e.skip = true;
  return e;
}

function run(cmd, args) {
  var r = cp.spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw r.error;
  var out = ((r.stdout || "") + (r.stderr || "")).split(/\s+/).join(" ").trim();
  if (r.status !== 0) throw new Error("exit " + r.status + ": " + out.slice(-200));
  return out.slice(0, 120);
}

var here = __dirname;
var npmCli = null;
(function () {
  // The private npm that came with this Node, wherever the recipe put it.
  var tries = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (var i = 0; i < tries.length; i++) if (fs.existsSync(tries[i])) { npmCli = tries[i]; return; }
})();

check("npm-install", function () {
  var isNumber = require("is-number");
  if (isNumber(5) !== true) throw new Error("is-number gave the wrong answer");
  return "is-number 7.0.0 from the install step";
});

check("npm-version", function () {
  if (!npmCli) throw skip("no npm beside this node");
  if (!cp.spawnSync) throw skip("spawnSync is Node 0.12 and later");
  return "npm " + run(process.execPath, [npmCli, "--version"]);
});

check("npx", function () {
  if (!cp.spawnSync) throw skip("spawnSync is Node 0.12 and later");
  var npx = path.join(path.dirname(npmCli || ""), "npx-cli.js");
  if (!npmCli || !fs.existsSync(npx)) throw skip("npx came with npm 5.2 (Node 8.2)");
  return "npx " + run(process.execPath, [npx, "--version"]);
});

check("corepack", function () {
  if (!cp.spawnSync) throw skip("spawnSync is Node 0.12 and later");
  var cands = [
    path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "corepack", "dist", "corepack.js"),
  ];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(cands[i])) return "corepack " + run(process.execPath, [cands[i], "--version"]);
  }
  throw skip("corepack came with Node 16.9");
});

check("stdlib", function () {
  var crypto = require("crypto");
  var zlib = require("zlib");
  zlib.gzipSync ? zlib.gzipSync(Buffer.from ? Buffer.from("x") : new Buffer("x")) : null;
  return "openssl " + process.versions.openssl + ", sha256 " +
    crypto.createHash("sha256").update("x").digest("hex").slice(0, 8);
});

console.log("TOOL runtime node " + process.versions.node);
console.log("TOOL end");
