# What money would buy

> **None of the features on this page are implemented, and the reason is
> money rather than work or willingness.** TiddlyInstall is built and
> paid for by one person. Where something below is missing, unsigned,
> untested or unreachable, it is because the certificate, the membership,
> the account or the hardware has not been bought -- not because it was
> overlooked and not because it is hard. Each item says what it costs and
> what it would unlock, so the trade is visible rather than implied.


Things this project cannot do for free, what each costs, and what it
unlocks. Written 2026-09-22, from decisions taken during development;
prices are what they were then and should be checked before spending.

Nothing here is a wish list. Every item is something that is currently
either broken, untested, or unavailable to people outside one LAN, for
a reason that is money rather than work. There is a section at the end
for the opposite case -- the things that are *not* blocked by money,
which is most of them.

---

## 1. An Apple Developer Program membership. $99 a year

**macOS installers are killed on arrival today**, and this is the only
thing that fixes it.

On macOS 15 and later, an app downloaded by a browser that is not
notarized by Apple is not warned about -- it is terminated, with a
dialog that explains nothing. Our installers are unsigned (an ad-hoc
signature, measured, buys nothing over none), so every macOS user meets
this. The way through is System Settings, Privacy & Security, Open
Anyway, then open it again; the `Read Me First.txt` in the zip explains
it, which is the best that can be done without paying.

**What it unlocks**

- **macOS installers that open by double-clicking**, which is the
  entire macOS experience.
- **The `.dmg`**, which is designed ([macos-packaging.md](docs/macos-packaging.md))
  and deliberately unbuilt: a self-contained `.app` with the runtime
  inside, dragged to Applications, which is what a Mac user expects
  instead of a zip that dumps a folder in Downloads. A `.dmg`
  Gatekeeper kills is no better than a `.zip` Gatekeeper kills, so the
  work waits on the membership rather than the other way round.
- **macOS stops being a permanently-red column** in the test matrix.
  Every macOS cell currently reads `known` for this one reason, and a
  platform that is always failing is a platform whose real regressions
  nobody notices.

**What it does not unlock, which matters.** Our Developer ID would let
us notarize installers *we* sign -- mode A. For mode B (the publisher's
own certificate) and mode C (unsigned), which is everything people
would actually build in an alpha, it changes nothing. Those stay blocked
unless the publisher notarizes their own.

---

## 2. A Windows code-signing certificate. ~£200-500 a year, plus a token or a signing service

This is what "Signed by TiddlyInstall" (mode A) needs, and it is
currently disabled in the interface for exactly this reason.

Since June 2023 the private key must live on a hardware token or in a
cloud signing service, so the certificate is not the only cost: budget
for an HSM token or a service such as SSL.com eSigner, DigiCert
KeyLocker or Azure Trusted Signing (~£10 a month, but organisation-only
and identity-checked).

**What it unlocks, and the honest version of it**

Do not buy this expecting warnings to stop. **An EV certificate no
longer bypasses SmartScreen** -- Microsoft removed that behaviour in
2024 and now puts OV and EV in the same row: "flagged as unrecognized
until reputation accumulates". Reputation is also partly per *file
hash*, so every new build starts partly fresh.

The real value is different and better: **reputation accrues on one
certificate across every installer everyone builds**. An individual
publisher signing their own release starts from zero every time and may
never accumulate enough downloads to clear it. A shared certificate that
has signed thousands of installers does. That is something we can offer
that a lone developer cannot buy for themselves, and it is the strongest
argument for mode A existing at all.

Also unlocks: notarized macOS mode A (with item 1), and a reference
implementation for publishers doing mode B.

---

## 3. Verifying the cloud signing integrations. ~£2 a month

Six signing services are supported. **One has been tested against a
real API** -- SSL.com's free sandbox -- and testing it found **three
bugs, every one of which would have failed on a real account**: a
base64/base32 mix-up that rejected the secret outright, a parameter that
returned an empty list instead of an error, and a required field that
was not required. The other five are written from documentation, and
the sane assumption is that a similar crop is waiting in each.

Google Cloud KMS and AWS KMS can be verified **without a code-signing
certificate at all** -- a plain asymmetric key is about $1 a month each,
no identity check, and signing a digest is the same API call. That would
move two of the remaining five from "written from documentation" to
"actually called".

Azure Trusted Signing and DigiCert cannot be tested this way; both need
a real, identity-checked account.

*Declined 2026-09-21. Recorded because the reasoning may change once
somebody tries to sign something for real.*

---

## 4. A second mirror. ~£1.50 a month, or free

Everything depends on one host. If ovh1 is down or unreachable from
where a user is, every installer falls back to vendor URLs -- which is
precisely the path that fails on the old machines the mirror exists for.

**Cloudflare R2** was costed at about $1.65 a month for 131 GB with
**zero egress charges**, which is unusual and is the reason it came up.
*Declined 2026-09-21*: the operator did not want pay-as-you-go bandwidth
exposure, which is a fair objection to a class of pricing even where
this particular product does not charge for it.

If it is ever reconsidered, one finding must be checked first and is
recorded as **unverified** in [design.md](docs/design.md) §11.2: whether
a browser-less old machine can reach a Cloudflare host over plain
`http://` at all. If it cannot, R2 is a fast path for modern machines
only and **ovh1 remains the only path for the ones that need a mirror
most** -- so it would be an addition, never a replacement.

The free alternative, already begun: hunting public and institutional
mirrors by hash. That doubled plain-http coverage from 10% to 21% and
found the first ever mirror of the RubyInstaller binaries. It costs time
rather than money.

---

## 5. Mirroring every version, not just the newest. A disk

Our mirror holds the newest build of each runtime. But a publisher can
pin an older version, and the resolver will happily choose a release
nobody mirrored -- and that plan then carries **vendor URLs only**,
which on Windows 7 can mean the download simply fails.

Mirroring every version a plan can name was measured: **8,802 files,
548 GB**. Java is 232 GB of it (Zulu ships a JDK *and* a JRE for every
patch) and Go 189 GB.

**ovh1 is not the constraint** -- 6.6 TB free. **This development
machine is**: a mirror URL only reaches a plan through `LocalIndex`,
which walks the local copies, and `/` here has about 21 GB free at 93%
full. So the cost is either a disk for this machine, or the design
change that decouples the two (teaching `LocalIndex` to trust a
manifest), which is work rather than money.

---

## 6. Test hardware and licences. Tens of pounds, mostly

Small amounts that remove real blind spots.

- **A Mac. The operator owns none.** Every other platform here is a
  machine or a VM on the LAN that can be watched while it installs
  something; macOS is a rented, headless server reached over SSH, and it
  is the only Mac there is. So macOS is not merely under-tested, it is
  tested differently from everything else: the base is built there and
  the automated cells run there, but nobody has ever sat in front of a
  Mac and double-clicked one of these installers. The macOS review
  dialog, Gatekeeper's refusal, the "Open Anyway" walk through System
  Settings, what the `.app` looks like in Finder -- all of it is
  reasoned about rather than seen. Two of today's bugs were found only
  by rendering a screen and looking at it, which is the one thing that
  cannot be done here.
- **A display for the rented Mac. ~£10.** Failing a real Mac, this is
  the cheap half: the server is headless, so the Gatekeeper dialogs and
  Safari have never been photographed or driven. An HDMI dummy plug, or
  enabling auto-login, fixes it.
- **ARM64 hardware. ~£80 once, or about £4 a month.** A Raspberry Pi, or
  a small cloud ARM instance (Hetzner's CAX11 is the cheapest; ARM
  capacity is often sold out). *Windows on ARM was ruled out of scope.*

  This one got narrower on 2026-09-25 rather than going away. arm64 Linux
  is now tested under emulation: `qemu-aarch64-static` with a binfmt_misc
  entry, inside the existing sandbox machinery, which gives a real aarch64
  *userland*. Five cells ran (python, go, java, node) and the very first
  one found a real bug -- `RUNS_ON` claimed arm64 could run amd64, which
  is true on macOS through Rosetta and false on Linux, so the one guard
  meant to catch an arm64 machine being handed an amd64 build would have
  passed it.

  What emulation still cannot answer: it is an amd64 kernel with 4 KB
  pages and qemu's instruction behaviour, so page-size assumptions,
  kernel-specific behaviour and genuine silicon differences are untested.
  5,118 arm64 Linux releases are offered on that basis. Separately,
  **4,582 armv7 and armv6 entries are in the catalogue and the resolver
  never offers them**, so older 32-bit ARM hardware is told there is
  nothing for it -- a Pi covers both arches at once.
- **Windows licences.** Measured again on 2026-09-25, mid-test-run: the
  LTSC 2021 machine powers itself off about every 60 minutes because its
  evaluation licence has expired. `wlms.exe` logs it plainly ("The license
  period for this installation of Windows has expired"), and the event log
  rules out every other explanation -- zero Kernel-Power 41, zero 6008,
  zero BugCheck. It got 9 of 36 cells through one window and then died, so
  those cells had to be thrown away. An Enterprise *Evaluation* edition
  cannot be converted in place (`DISM`: "cannot be upgraded to any target
  editions"), and Windows 10 LTSC 2021 is no longer sold, so the fix is a
  rebuild from a current evaluation image -- of the *template*, since this
  VM inherited a clock that had already run out. A real key would stop the
  clock instead. LTSC 2024 is licensed and unaffected.
- **More RAM for the ESXi host.** It was at 98% memory allocation before
  seven test VMs were right-sized; it is the reason new test machines
  have to be justified rather than simply added.

---

## 7. Free, but needs an account

- **A GitHub API token for the build server.** Unauthenticated
  `api.github.com` allows 60 requests an hour *per address*. From a
  browser that is the user's own address and fine; from a shared build
  server it is 60 an hour for everybody, and it will run out. A token in
  the server's environment raises it to 5,000. Costs nothing; belongs in
  the server's environment and never in the form.
- **Asking GitHub to garbage-collect** after the `prompts/` history
  purge. Unreachable commits stay addressable by SHA through their API
  for a while. The repo is private, so the exposure is nil, but it is a
  free support request.

---

## What is *not* blocked by money

Most of what is left. Recorded here so this document is not read as
"everything waits on funding":

- **Making it reachable at all**, which is the single most valuable
  thing outstanding and costs nothing: the domain is owned, ovh1 is
  paid for, and Let's Encrypt is free. What is missing is a vhost
  serving the mirror tree, a certificate, and `policy.mirror_base`
  repointed from `http://10.0.1.76:8080/mirror` to the public URL.
  Until that is done every installer built carries an unroutable
  address as its first download location, the 131 GB mirror on ovh1
  serves nobody, and the page runs without WebCrypto because browsers
  withhold it from plain http. **This is work, not a purchase**, and it
  outranks everything on the list above.

- The capability statement, the review screen, the transparency work.
- Browser-side packing, which is built and proven on machines down to a
  744 MB 32-bit VM.
- GitHub sources with no build server, built and proven.
- The "standard installer" classification and the structured launch
  shapes ([launch-shapes.md](docs/launch-shapes.md)) -- designed, and
  waiting on a decision rather than a payment.
- Revocation and expiry, built.
- The admin system for takedowns and metadata.
- An abuse process, which is a policy and a habit rather than a purchase
  -- and which should exist *before* strangers can build installers,
  because the moment they can, someone will try.

---

## If only one thing

**Item 1, the Apple membership, at $99.** It is the only item here that
takes something from *broken* to *working*: macOS installers are killed
on arrival today, for every user, and nothing else on this list changes
that. Everything else improves something that already works, or removes
a warning, or covers a blind spot.

But note that the most valuable outstanding thing is not on this list at
all -- deploying publicly costs nothing now that the domain is owned,
and it is what turns a tool one person can use on one network into one
anybody can try.
