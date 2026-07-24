# Cast Gorilla 1.0.0 — release handoff (2026-07-24, ~00:30)

Written for the agent picking this up cold. Everything below was done in one
session on the night of 2026-07-23. **Nothing has been tested against a TV.**

Read `CLAUDE.md` first — the durable knowledge from this work is already folded
into it (RELEASE PACKAGING section, Commands, Status). This file is the
*operational* handoff: what exists right now, what to do next, in order.

---

## 1. State right now

**Branch `release/1.0.0`, commit `b673572`. NOT merged to main, NOT pushed.**
Deliberate — merging is a decision for a human, and the work is unproven on
hardware.

**The artifact exists and is fully signed:**

```
packages/app/release/Cast Gorilla-1.0.0-arm64.dmg      138 MB
packages/app/release/mac-arm64/Cast Gorilla.app        327 MB
```

Both verified `spctl → accepted, source=Notarized Developer ID`.

Note `packages/app/release/` and `vendor/` are **gitignored**. The DMG is on
disk only. If it is deleted, section 6 rebuilds it.

### What changed, in one line each
- **Version** — `packages/app/package.json` is the single source of truth at `1.0.0`; the renderer reads it via a Vite `define` (`__APP_VERSION__`). The old hardcoded `v1.4` is gone. Sidebar shows `v1.0.0` alone (the `· your Mac` suffix was removed on request at the end of the session).
- **Name** — `productName: Cast Gorilla`. `appId` unchanged (`co.castgorilla.app`) on purpose.
- **Icon** — first one ever: `packages/app/build/icon.icns`, from `~/Desktop/icon/Exported PNG image 1.png`.
- **ffmpeg** — now bundled. Static LGPL 8.1.2 arm64, built by `scripts/build-ffmpeg.sh` into gitignored `vendor/ffmpeg/arm64/`, shipped to `Contents/Resources/ffmpeg/`.
- **Signing** — Developer ID (Intheday Ltd, `29UYFH4USR`), hardened runtime, notarized, stapled. Was previously ad-hoc/unsigned.

---

## 2. DO THIS FIRST — the two tests that actually matter

**DONE 2026-07-24** — see **`docs/phase0-1.0.0-hardware.md`**.

Summary: Test A (Homebrew hidden) **PASS**; cast real HEVC on SHIELD **PASS**;
burst scrub **PARTIAL FAIL** (frozen frame + spinner ~50:30; nudge recovered).
Ship-for-play yes; scrub-safe no.

Everything below is the original procedure (kept for re-runs).

### Test A — ffmpeg independence (~5 min, needs `sudo`, needs a human)

**This is the single most important unproven claim.** Every check passes on this
machine even if bundling silently failed, because Homebrew's ffmpeg is still at
`/opt/homebrew/bin` for the app to fall back on. The argument that it *can't*
fall back is sound — `ffmpeg-paths.ts` sets `CASTGORILLA_FFMPEG` unconditionally
when packaged, with no existence check, so step 1 of the engine's resolution
order always wins — but it is an argument, not an observation.

```bash
sudo mv /opt/homebrew/bin/ffmpeg  /opt/homebrew/bin/ffmpeg.hidden
sudo mv /opt/homebrew/bin/ffprobe /opt/homebrew/bin/ffprobe.hidden

# Install from the DMG (the real user path), launch, open a video, cast it.
open "packages/app/release/Cast Gorilla-1.0.0-arm64.dmg"

# ALWAYS restore, even if the test fails:
sudo mv /opt/homebrew/bin/ffmpeg.hidden  /opt/homebrew/bin/ffmpeg
sudo mv /opt/homebrew/bin/ffprobe.hidden /opt/homebrew/bin/ffprobe
```

Pass = the app probes the file and casts normally. Fail = an error naming
`CASTGORILLA_FFMPEG points at "…" but it is not an executable file`, which would
mean `extraResources` did not copy the binaries.

### Test B — cast a real file, human watching the TV

Per `CLAUDE.md`'s hardware protocol: **logs cannot tell you whether something
played.** Install the DMG, cast ONE real file, and ask the person at the TV what
is on screen — naming the device in the question.

Two things make this more than a smoke test:
- This bundle has **never been cast from**. It is the first signed build and the first with bundled ffmpeg.
- It is also **the first package containing the segment-drift fix** (`d498b13`). Verified by extracting `decide/decision.js` and `ffmpeg/args.js` from the asar: `computeTranscodeBoundaries` and `-hls_time 5.9` are both present. So the pending seek-restart hardware scrub (CLAUDE.md milestone 0) can be done from the app rather than the CLI, in the same session.

**A trap that did not exist before today:** the packaged app now runs **bundled
ffmpeg 8.1.2 (LGPL)** while the CLI runs **Homebrew 8.1.1 (GPL)**. "Verified via
the CLI" no longer implies "verified for the app". Test the app.

---

## 3. Known-unproven / residual risks

| Item | Status |
|---|---|
| Playback from this bundle | **Never tested.** No TV has seen it. |
| ffmpeg independence | **Unproven** — Test A above. |
| DMG staple validated *offline* | **Unproven.** `stapler validate` exits 0 and the DMG mtime (00:25:27) is later than its signature timestamp (00:22:32), which shows stapler wrote the ticket. But true offline validation was never run. If you want certainty: disable Wi-Fi, then `xcrun stapler validate` the DMG. |
| Local-network TCC after signing | **Works** — observed 2 devices discovered from the signed build. The grant is keyed to `appId`, which was deliberately left unchanged. |
| `--surround` on real hardware | Still untested (pre-existing, CLAUDE.md milestone 6). |

**Do not repeat this dead end:** `xcrun stapler validate -v` prints an
`NSHTTPURLResponse` from Apple's CloudKit ticket-delivery endpoint and
`Downloaded ticket has been stored at …` **even for an item that is definitely
stapled**. It was checked against the `.app` as a control and behaves
identically. That output is NOT evidence the item lacks a ticket.

---

## 4. Small things left on the table

- **16px icon is mush.** Legible at 32px and up; at 16px (Finder list rows, menu bar) only the squircle silhouette and green gradient carry identity. Fixing it needs a separately-drawn simplified 16px variant, i.e. artwork, not code.
- **Icon palette mismatch.** The icon is green; the in-app Warm Native system is charcoal + coral (`#FF7A6B`). Deliberate user choice. There are 12 other exports in `~/Desktop/icon/` if a warmer variant is ever wanted — swapping it is a one-file change plus a rebuild.
- **`NSLocalNetworkUsageDescription`** now reads "Cast Gorilla …" (was lowercase). This is the sentence macOS shows in the permission prompt.
- The pre-existing latent bugs in CLAUDE.md milestone 2 (`hdrOutcome` lies, stale watchdog advice, duplicate `ipcMain.handle`, paused-session-resumes-playing, `MediaChannel.unwrap`) were **not touched**.

---

## 5. Uploading

Nothing has been uploaded anywhere. Before distributing:

1. Run Tests A and B (Phase 0). Do not ship an untested bundle.
2. Decide whether to merge `release/1.0.0` → `main` and tag `v1.0.0` (**source only** — no binary assets on the tag / GitHub Release).
3. Upload the DMG to **Gumroad only** as the product file (new version on later releases). Do **not** attach it to GitHub Releases, S3-as-public-latest, or any host that undercuts paid customers. Full protocol: [`docs/DISTRIBUTION.md`](DISTRIBUTION.md).
4. **LGPL obligation is already satisfied inside the bundle** — `Contents/Resources/ffmpeg/` ships `COPYING.LGPLv2.1`, `LICENSE.md` and a generated `README.castgorilla.txt` naming the exact version, tarball URL and configure line. If a download page is made, mirroring that notice there is good practice but the bundle itself is compliant.
5. There is **no auto-update mechanism**. Gumroad buyers re-download new file versions from their library. `electron-updater` is not wired up (and must not point at public GitHub Releases).

---

## 6. Rebuilding from scratch

```bash
# 1. ffmpeg binaries (only if vendor/ is missing — idempotent, ~30-45 min cold,
#    ~0.3s when already built). Hard-fails if any required encoder is absent.
bash scripts/build-ffmpeg.sh

# 2. Full gate — must be green before packaging
npx tsc -b && npm run typecheck -w packages/app && npx vitest run   # 653 tests / 51 files

# 3. Build + sign + notarize the .app, and produce the DMG
#    NOTE: run `npm run build -w packages/app` from the REPO ROOT, not from
#    packages/app — from inside the package npm reports "No workspaces found"
#    and silently leaves dist/ stale. This bit twice tonight.
npm run build -w packages/app
(cd packages/app && APPLE_KEYCHAIN_PROFILE=castgorilla npx electron-builder)

# 4. The DMG — electron-builder does NOT sign or notarize it, only the .app
#    inside. Order matters: signing invalidates an existing ticket.
cd packages/app
D="release/Cast Gorilla-1.0.0-arm64.dmg"
codesign --sign "Developer ID Application: Intheday Ltd (29UYFH4USR)" --timestamp --force "$D"
xcrun notarytool submit "$D" --keychain-profile "castgorilla" --wait
xcrun stapler staple "$D"
```

### Verify the result
```bash
spctl -a -vvv -t install "release/mac-arm64/Cast Gorilla.app"
spctl -a -vvv -t open --context context:primary-signature "$D"
# both must say: accepted / source=Notarized Developer ID
```

### Two silent failure modes to grep the build log for
Neither fails the build; both produce a broken artifact that looks fine here:
- `skipped macOS notarization` — credentials missing from the environment. Ships un-notarized; refused by Gatekeeper on a clean Mac.
- `file source doesn't exist` — `vendor/ffmpeg/arm64` missing. Ships an app with **no ffmpeg**. Likely if you package before running `build-ffmpeg.sh`, since `vendor/` is gitignored.

### Credentials
Stored as notarytool keychain profile **`castgorilla`** (Developer team
`29UYFH4USR` / Intheday Ltd). No Apple ID, app-specific password, or API key
belongs in the repo — only the local keychain profile (or env vars on the build
machine). Delete any leftover plaintext password files on disk; builds use the
keychain copy.

If notarization ever returns `HTTP 403 — A required agreement is missing or has
expired`: the signing Apple ID may be on **more than one developer team**, and
agreements are **per-team**. Accept the agreement with the portal switched to
**Intheday Ltd** (`29UYFH4USR`). Propagation can take several minutes — retry
rather than assuming the credentials are wrong.
