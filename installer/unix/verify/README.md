# tiverify: the Linux and macOS bases' Ed25519 verifier

```
tiverify <public-key-base64> <signature-base64> < message
```

Exit 0: the signature (RFC 8032 pure Ed25519) is valid for the message
and key. 1: it isn't. 2: usage, bad base64 (the key must be 44
characters, the signature 88), or a read error. Base64 is decoded here,
so the engine needs no base64 tool.

It exists because `openssl pkeyutl -rawin` can't check Ed25519 on many
machines the engine supports: CentOS 6 (OpenSSL 1.0.1) and 7 (1.0.2),
Ubuntu 18.04 / 20.04 and Rocky 8 (1.1.1 builds whose `-rawin` check
fails), Alpine (no openssl) and macOS (LibreSSL). Without a verifier
those machines refused every plan fetched over plain HTTP.

The code is the Windows `tisig` plugin's: TweetNaCl 20140427's verifier
with the RFC 8032 S < L check
([../../windows/plugin-src/ed25519_verify.c](../../windows/plugin-src/ed25519_verify.c))
and its strict base64 decoder (`plancheck.c`), plus `tiverify.c` (a
`main` reading the message from stdin).

## Building

```sh
ZIG=/path/to/zig-x86_64-linux-0.15.2/zig ./build.sh
```

Zig 0.11 or later (the runtime store has tarballs: `zig/linux/amd64/`).
`-Os`, stripped; Linux builds are static musl binaries, so they run on
any kernel for the CPU (tested back to CentOS 6's 2.6.32); macOS builds
link only libSystem, and Zig ad-hoc signs the arm64 one (`codesign -dv`:
`flags=0x20002(adhoc,linker-signed)`), which Apple Silicon requires. The
builds are reproducible: rebuilding gives the same bytes.
`build.sh` then runs `selftest.sh` (RFC 8032 vectors 2 and 3, each also
with a changed message) on the host's binary.

| File | Target | SHA-256 |
| --- | --- | --- |
| `bin/tiverify-linux-x86_64` | x86_64-linux-musl | `6e2629f2f55378697bb6eac9b44c70106eb42b4958ed464f8287ec5cf570e9d4` |
| `bin/tiverify-linux-aarch64` | aarch64-linux-musl | `b3a75141dd35f4dc6f558a878f5c7769dca92267408fc3881156f8b070e50061` |
| `bin/tiverify-linux-i386` | x86-linux-musl | `ced3c7072fb5fcb58b60dcbb35fa1e87196d66763b7949b0f047bd556ac9f2db` |
| `bin/tiverify-macos-x86_64` | x86_64-macos | `1cd498383492397ee62b0e2964ea449d92a5279b3ca4f23d46ab9bc112fce6fb` |
| `bin/tiverify-macos-arm64` | aarch64-macos | `c9badcb89b6ee2e1f8314258668f960672ffa111fe27b05bf337490f72359ae2` |

Built with Zig 0.15.2. Tested: `selftest.sh` on this Linux host
(x86_64, i386, and aarch64 under qemu-user) and on macOS 26.2 arm64; the
engine's plan cases (`../test_verify.sh`, and good / fetched over plain
HTTP / tampered / replayed on the machines themselves) on CentOS 6,
CentOS 7, Ubuntu 18.04, Alpine and macOS 26.2 arm64. The macOS x86_64
binary is built but untested (the test Mac has no Rosetta).

## How the bases carry it

- **Linux `.run`:** `make_run.sh` appends the three Linux binaries after
  the script's final `exit $?` line and fills the script's
  `TI_VERIFY_BLOBS=` line with `<arch>:<offset>:<length>` for each,
  offsets from the start of the file, in fixed-width numbers (so the
  script's size is known before they are written). They are part of the
  base: the metadata block the server appends later still goes at the
  very end, and `uninstall.sh` (the base without the block) keeps them.
- **macOS `.app`:** `make_app.sh` copies the two macOS binaries to
  `Contents/Resources/tiverify-x86_64` and `-arm64`, inside the bundle's
  signature.

The engine picks the one for this CPU, checks it on RFC 8032 vector 2
(must accept) and the same with a changed message (must reject), and
only then uses it; otherwise it tries openssl the same way.
