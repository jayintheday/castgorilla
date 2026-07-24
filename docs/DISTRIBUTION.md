# Cast Gorilla — distribution protocol

Canonical policy for how this project is published. Packaging *how-to* lives in
`CLAUDE.md` (RELEASE PACKAGING) and `docs/release-1.0.0-handoff.md`. This file is
only **where** binaries go, and what stays free.

## Model

| What | Where | Cost |
|---|---|---|
| Source (engine, CLI, app) | Public GitHub, MIT | Free |
| Official macOS DMG (Developer ID signed, notarized, bundled LGPL ffmpeg) | **Gumroad only** | Paid |
| Self-build from source | Your machine | Free (you supply ffmpeg / signing) |

Replace this placeholder when the product is live:

```
YOUR_GUMROAD_PRODUCT_URL
```

## Hard rules

1. **Never** attach DMGs, `.app` zips, or other binaries to GitHub Releases.
2. **Never** publish release artifacts via public GitHub Actions (or any public
   CDN that undercuts Gumroad).
3. **Allowed:** `git tag vX.Y.Z` for source milestones. Tags may have **zero**
   release assets. Prefer tags without a GitHub “Release” UI entry if that UI
   tempts uploading files.
4. `packages/app/electron-builder.yml` sets `publish: null` so accidental
   `electron-builder --publish` / token-driven uploads cannot target GitHub.
5. Notary / Apple credentials stay in the local keychain profile `castgorilla`
   (or env vars on the build machine). Never commit Apple IDs, app-specific
   passwords, or API keys. Delete any leftover plaintext password files on disk.
6. **Never commit real media titles, release-group tags, or absolute library
   paths** in docs or issues. Characteristics only (codec, resolution, duration,
   tier). Private inventory stays in gitignored `NOTES.local.md`.

## Customer updates

Until an in-app updater exists (explicitly deferred):

- Upload each new DMG as a **new file version** on the same Gumroad product.
- Buyers re-download from their Gumroad library.
- Optional: email customers that a new version is available.

Do **not** wire `electron-updater` to a public GitHub Releases feed.

## Ship checklist (maintainer)

1. **Phase 0 hardware gate** — **DONE 2026-07-24** for play + bundled ffmpeg on SHIELD; scrub burst still fails (frozen frame + spinner, nudge recovers). Details: `docs/phase0-1.0.0-hardware.md`. Re-run Tests A/B from `docs/release-1.0.0-handoff.md` only if the DMG is rebuilt.
2. Merge / tag source when you choose (`vX.Y.Z` = source only, no binary assets).
3. Build, sign, notarize, staple the DMG (`CLAUDE.md` Commands → Release build) — skip if uploading the already-tested 1.0.0 artifact.
4. Upload the DMG to Gumroad (new product version). Honest release note: scrub under heavy seeking can stall; a small seek often recovers.
5. When the Gumroad URL is final, replace `YOUR_GUMROAD_PRODUCT_URL` in
   `README.md` and this file.

## Trademark

**Cast Gorilla** (name and app icon) identifies the official product. The MIT
license grants rights to the *software*; it does **not** grant rights to use the
Cast Gorilla name or icon as if your build were the official app. Third-party
builds should use a different name and branding.

## LGPL ffmpeg (official DMG)

The official app ships a static LGPL ffmpeg/ffprobe under
`Contents/Resources/ffmpeg/`, with `COPYING.LGPLv2.1`, `LICENSE.md`, and
`README.castgorilla.txt`. That satisfies redistribution for the paid binary.
Details and build traps: `CLAUDE.md` → RELEASE PACKAGING.

## Build from source (free)

See the root `README.md` for CLI and contributor builds. Summary:

- **CLI / dev:** needs a system ffmpeg with VideoToolbox + AudioToolbox encoders
  (typically Homebrew). No notarized installer.
- **Packaged app:** requires `scripts/build-ffmpeg.sh`, Apple Developer ID, and
  notarization credentials. A self-built unsigned `.app` is fine for local
  hacking; it is not a substitute for the Gumroad DMG on a clean Mac.

## Landing page (other repo / directory)

Official marketing CTA must link **Gumroad**, not GitHub Releases. Wording for
OSS vs paid should match the root `README.md` “Official builds” section and this
file. Landing-page copy is owned outside this repository.
