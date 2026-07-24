# castgorilla — project context for agents

Repo, scope and appId are `castgorilla` / `@castgorilla` / `co.castgorilla.app`; the shipped display name is **Cast Gorilla** (`productName` only — see RELEASE PACKAGING before assuming that moved anything).

macOS media player that casts local video to your TV: browse to a local video file, pick a Chromecast on the LAN, play. Pipeline-first: probe → decide (direct / remux / audio-transcode / video-transcode) → serve over local HTTP (Range direct or Jellyfin-style on-demand HLS VOD) → cast via CASTV2 to the Default Media Receiver. AirPlay is backlog.

> Maintainer-private companion: `NOTES.local.md` (gitignored) holds the device inventory with LAN addresses, the real media files behind the validation tables, and machine-specific reproduction commands. Everything technical is here.

## DISTRIBUTION POLICY
Source is MIT and public. **Official notarized DMGs are sold on Gumroad only** — never attach binaries to GitHub Releases or publish them via public CI artifacts. Customer updates = new Gumroad file versions (re-download); no `electron-updater` / public feed yet. `packages/app/electron-builder.yml` sets `publish: null` to block accidental uploads. Placeholder product URL and full ship checklist: **`docs/DISTRIBUTION.md`**. Phase 0 play + bundled-ffmpeg gate: **passed 2026-07-24 on 1.0.0** (`docs/phase0-1.0.0-hardware.md`); scrub remains a known limitation. **Current shippable artifact is 1.0.1**, which is built and notarized but carries no hardware evidence of its own — see Status.

## Working agreement
- **All implementation code is written by Opus subagents.** The orchestrating session is manager/reviewer only: it briefs agents, reviews diffs, runs verification, commits. It does not patch product code (one-line throwaway diagnostics during live debugging are the only tolerated exception, disclosed and cleaned up).
- `packages/engine/src/types/` is the FROZEN contract layer. Do not modify without explicit orchestrator sign-off.
- Concurrent agents get non-overlapping path scopes; each agent's brief states them. No `npm install` unless the brief allows it (single install, single lockfile write). Agents never `git commit` — the orchestrator commits after review.
- Tests: vitest, files named `<area>-*.test.ts` in `packages/engine/test/` or `packages/app/test/`. Full suite must stay green (`npx vitest run` at root).

## Hardware testing protocol
**Logs cannot tell you whether something played. Only a human watching the TV can.**

When testing playback against a real device, follow this loop, one file at a time:
1. **Run ONE specific file via the CLI**, named by codename, wrapped in a timeout so it can't hang the session: `LOG_LEVEL=debug timeout 45 node packages/cli/bin/castgorilla.js play fixtures/<codename>_<name> --device <name> < /dev/null` (relative paths are safe since BUG #2 was fixed).
2. **Ask the person at the TV what happened, and WAIT for the answer** before running anything else or drawing a conclusion. Ask for what is on screen — video playing / spinner / nothing / screensaver — not just "did it work". **Name the device in the question**: running a test on a different device than the one being watched caused a genuinely confusing exchange on 2026-07-23.
3. Only then interpret the logs, and only then choose the next file.

**Narrow exception, added 2026-07-23:** `playerState` is now a *calibrated* proxy for the crude wedged-vs-playing question only (see "CALIBRATED" below), so a chain of single-variable experiments may be run without a human between each. Final verification of any tier still needs human eyes, because the receiver reports `PLAYING` for green frames, wrong colours, missing audio and stutter alike.

Never batch several files and never infer the on-screen result from the log. This is not ceremony — it is the only way to get the deciding fact:
- 2026-07-23: `delta` fetched **9 MB of segments with zero errors** and the logs looked healthy-ish. The screen showed a screensaver — nothing had rendered at all. The log alone would have sent us hunting a status-channel bug.
- Immediately after, `alpha` (direct play) reached `playing` **from that same screensaver state**, which proved the device was awake and rendering fine and collapsed the hypothesis space to "HLS specifically". One human sentence did what an hour of log reading could not.

Also: the packaged app in `/Applications` is only as fresh as its last `electron-builder` run. After an engine change, either repackage or test via the CLI — an app test against stale code is worse than no test, because it looks like evidence. **Current install:** `/Applications/Cast Gorilla.app` is the signed, notarized **1.0.1** build (installed from the DMG 2026-07-24, replacing 1.0.0). It runs the real engine (`[engine-gate] {"mock":false}`) but **no TV has seen 1.0.1** — the Phase 0 hardware results below were earned by 1.0.0.

## Layout
npm-workspaces monorepo, TS strict ESM (`.js` import extensions).
- `packages/engine` — the library. `types/` (frozen), `probe/` (ffprobe→MediaInfo, keyframe index), `decide/` (pure planner), `devices/` (mDNS discovery + `profiles.ts` capability table), `cast/` (CASTV2 client over `castv2`, typed channels, reconnect), `ffmpeg/` (binary resolve, pure arg builders, process mgr), `hls/` (synthetic VOD playlist + on-demand HlsSession with seek-restart), `server/` (Range/CORS media server), `subtitles/` (sidecar/embedded → WebVTT), `session/` (PlaybackSession state machine + `createEngine()`), `mock/` (MockEngine + canned data).
- `packages/cli` — `castgorilla devices|probe|play` (interactive keys). The debugging workhorse is `probe` (dry-run plan with reasons).
- `packages/app` — Electron app. Real engine by default, `CASTGORILLA_MOCK=1` forces mock. Engine coupling lives ONLY in `src/main/engine-host.ts`. The renderer is vanilla TS over a pure `Store`: `main.ts` is boot + wiring only, all rendering lives in `renderer/views/*.ts`, and **`renderer/index.html` opens with an ELEMENT CONTRACT comment (every id, state class and `data-` attribute) which is the agreed surface between markup and wiring — read it before changing either side.** Packaging inputs live in `packages/app/build/` (`icon.icns`, `entitlements.mac.plist`) and `electron-builder.yml`; `src/main/ffmpeg-paths.ts` points the packaged app at the bundled ffmpeg (see RELEASE PACKAGING).
- `scripts/gen-fixtures.sh` (synthetic test media → `fixtures/`, gitignored), `scripts/build-ffmpeg.sh` (static LGPL ffmpeg/ffprobe → `vendor/ffmpeg/arm64/`, gitignored), `scripts/spikes/` (real-device spike tools + `bake-spike-media.sh`), `docs/G1-hardware-gate.md` (the hardware runbook).

## Status (2026-07-24)
- **PHASE 0 ON 1.0.0 PACKAGED APP — DONE 2026-07-24 (partial).** Full write-up for agents: **`docs/phase0-1.0.0-hardware.md`**. Scorecard: real engine; Local Network TCC needed Allow (CLI still saw devices); **Test A PASS** (Homebrew ffmpeg renamed — bundled ffmpeg proven); **play PASS on SHIELD** (real-library 1080p HEVC MKV → `video-transcode` HLS, human confirmed); **scrub PARTIAL FAIL** (~11 clean seek-restarts → frozen frame + spinner ~50:30; small nudge resumed). Gumroad “plays” gate: yes. Scrub-safe claim: no.
- **Verified playing on TWO real devices via the CLI, each confirmed on screen by a human:**
  - **NVIDIA Shield TV** (`shield`): `alpha` (direct), `delta` (remux), `lima` (audio-transcode), `hotel` (video-transcode).
  - **Chromecast HD** (`gen2`, md "Chromecast HD"): `delta`, `lima`, `hotel` — plus pause/resume exercised by hand.
- **Also validated against a real media library** (see REAL-MEDIA VALIDATION below): a 7.9 GB H.264 MKV with 5 subtitle tracks, and a 1080p HEVC file, both tiers, both devices — plus the first hardware verification of **seek-restart** driven from the TV remote.
- BUG #1 and BUG #2 both closed. **661 tests green across 51 files** (there are no CLI test files; re-counted 2026-07-24 at 1.0.1 — the published counts have now been stale twice, "502 across 44" then "653 across 51", so re-count rather than quote). NOTE: the root `npx tsc -b` does NOT cover `packages/app` (its tsconfig is deliberately outside the project-reference graph) — run `npm run typecheck -w packages/app` as well.
- **Renderer redesigned 2026-07-23** into a media-player interface: hero drop zone → device → audio/subs → advanced disclosure, with a fixed full-width player bar. Drag-and-drop uses `webUtils.getPathForFile` in the preload (`File.path` was removed in Electron 32; we are on 43) and is guarded by a capture-phase `preventDefault` on window plus a `will-navigate` backstop in main. That backstop deliberately admits **same-URL** navigations, because Vite reloads via `location.reload()` — which does fire `will-navigate` — and a blanket preventDefault would silently pin the dev window to stale code.
- **seek-restart storm — FIXED IN CODE (`d498b13`); HARDWARE 2026-07-24 DID NOT CLEAR IT.** Burst scrub on the 1.0.0 app (build containing the drift fix) still ended in **frozen frame + spinner** on SHIELD; nudge recovered. Details: **`docs/phase0-1.0.0-hardware.md`**. Prior root-cause write-up: **`docs/segment-numbering-drift.md`**. Symptom/protocol/killed hypotheses: **`docs/seek-restart-storm.md`**. Treat receiver scrub as **OPEN**.
  - **KNOWN-OPEN: the COPY tiers drift the same way** (`docs/segment-numbering-drift.md` §9.4) — product change, separate hardware run.
  - **Do not measure "seeks survived" with `grep -c start_number`**. Honest counts: 22 (run 2), 17 (run 3); Phase 0 app scrub: **11** launches after cold start.
  - Contributing bugs (stranded waiters, abandoned-request restarts) remain fixed and useful; they did not cure seek-storm and must not be recorded as the fix.
- **The ORIGINAL bug report is closed end-to-end through the packaged app**: the packaged app cast real media and scrubbed — `segFmt=ts`, video-transcode seg0 +786ms, audio-transcode seg0 +167ms, session switching clean. (That run predates the project rename; see the TCC caveat below.)
- **FIRST REAL DISTRIBUTABLE, 2026-07-24: `packages/app/release/Cast Gorilla-1.0.0-arm64.dmg`** — Developer ID, notarized, bundled LGPL ffmpeg. **Phase 0 cast from `/Applications/Cast Gorilla.app` on SHIELD; bundled ffmpeg proven with Homebrew hidden.** Ship binaries via Gumroad only (`docs/DISTRIBUTION.md`). Scrub caveat above.
- **1.0.1, 2026-07-24: `packages/app/release/Cast Gorilla-1.0.1-arm64.dmg`** — same pipeline, same identity, all gates re-run clean (`notarization successful`; both fail-open greps 0; DMG signed→notarized→stapled, `spctl` = `accepted / source=Notarized Developer ID`; installed from the DMG; `[engine-gate] {"mock":false}`). Notary submission `c5adefe2-a623-4632-ad05-c3cf93ade728`. Contents: the Home-screen overlap fix (`7e0e62a`) plus a doc correction — **no engine or pipeline change**. **NOT hardware-tested: no TV has seen this binary.** Source pushed to `origin/main` at `52310b2`; the DMG is NOT on GitHub and must not be.
- **RENAME CONSEQUENCES (2026-07-23):** `appId` moved `co.sickstream.app` → `co.castgorilla.app`. Two effects that will look like bugs if you do not expect them: (1) macOS treats this as a **new bundle identity, so the local-network TCC grant does NOT carry over** — the app re-prompts on first discovery, and the old grant in Privacy & Security points at a bundle that no longer exists; (2) the Electron **user-data directory moved**, so prior app settings are orphaned under `~/Library/Application Support/@sickstream/` (harmless, never read, safe to delete).
- **1.0.0 IS NOT A SECOND RENAME — `productName` does NOT move user data (VERIFIED 2026-07-24 by launching the packaged app, not reasoned from config).** Electron derives `userData` from the `name` field of the PACKAGED `package.json` (`@castgorilla/app`), never from `productName`.
- **Local-network TCC after Developer ID (VERIFIED 2026-07-24):** packaged app showed no devices until Local Network was allowed for Cast Gorilla; CLI discovery was fine. Signature change can require a fresh grant.
- **G1 hardware gate is partly OBSOLETE.** `docs/G1-hardware-gate.md` still frames R1/R2 as open; both answered (no HEVC on HLS; fMP4 dead on Default Media Receiver). What remains: per-device codec/level limits.
- **Pending: WS7 hardening.** Distribution model: MIT source + Gumroad-only DMGs (`docs/DISTRIBUTION.md`).

## RESOLVED BUG #1 — fMP4 HLS does not play on the Default Media Receiver, on ANY device (2026-07-23)
**Root cause: the Google Cast Default Media Receiver does not present fMP4 HLS — for any media, including Apple's own reference stream. MPEG-TS HLS plays everywhere.** Fix landed: `resolveSegmentFormat()` (`decide/container-rules.ts`) now emits **TS unless a profile positively proves fMP4** (`hls.fmp4 === true`); `'untested'` resolves to TS, because "untested" is exactly the assumption that broke both devices. fMP4 support is retained in the builders (`hls/playlist.ts`, `ffmpeg/args.ts`) for a future custom receiver — only the *selection* changed.

**Read this before re-opening the question:** the first diagnosis (below) concluded this was Shield-specific and fixed it with a per-profile fallback. That was WRONG — it was a correct fix for a mis-scoped cause, found because only one device was on the LAN. When a second device (Chromecast HD, `gen2`) arrived it reproduced the failure identically. Do not narrow this back to one device without re-running the Apple control.

### The controls that settled it (Chromecast HD, `<device-ip>`)
| Test | Result |
|---|---|
| our fMP4 (muxed a+v) | wedge |
| our fMP4, **video-only** (no audio track) | wedge |
| our fMP4, **without** the `-copyts -start_at_zero -avoid_negative_ts disabled` trio | wedge |
| our fMP4 + **master playlist** with `CODECS="avc1.64001f,mp4a.40.2"` | wedge |
| **Apple reference fMP4** (`.../img_bipbop_adv_example_fmp4/master.m3u8`) | wedge |
| Apple reference fMP4, **no** `hlsSegmentFormat` hints | wedge |
| **Apple reference TS** (`.../bipbop_16x9/bipbop_16x9_variant.m3u8`) | **PLAYS** |
| our TS | **PLAYS** |

The Apple TS row is the load-bearing control: same device, same CDN, same session — so the device had working internet and the fMP4 failures were real. Hypotheses refuted: muxed a+v; non-conformant fragmentation (`tfhd` has `default-base-is-moof` set; boxes are `styp/sidx/moof(mfhd,traf(tfhd,tfdt,trun))/mdat`); `copyts` timestamps (fMP4 seg0 starts at 0.046s, normal); missing `CODECS`; the LOAD segment-format hints.

**HEVC cannot ride MPEG-TS either.** ffmpeg muxes HEVC into mpegts happily, but the Shield rejected it explicitly — `playerState: IDLE`, `idleReason: ERROR`, ~0.6s after LOAD, media session then invalid. So the planner's `HEVC cannot ride MPEG-TS HLS; transcoding to H.264` rule is CORRECT and must stay. Consequence: **HEVC never stream-copies on any HLS tier**; HEVC-in-MP4 direct play is the only HEVC copy path.

### The original (mis-scoped) experiment, kept because the method was right
Same source (`delta_mkv-h264-aac.mkv`, pre-baked to `fixtures/spike-hls/h264-fmp4` and `h264-ts`), same throwaway server (`scripts/spikes/static-server.mjs`), same LOAD (`spike-load.mjs --duration 59.983`) — **only the segment container differed**:

| | fMP4 | TS |
|---|---|---|
| Player state | `IDLE` → stuck `LOADING` for the full 20s; never BUFFERING/PLAYING; no error, no `idleReason` | `IDLE` → `BUFFERING` (+0.54s) → `PLAYING` (+0.63s) |
| Segment fetches | playlist×2, init×1, seg0–2, all 200 in <160ms, 0 errors — **then silence** | paced in real time: seg0 +0.3s, seg1 +0.7s, seg2 +1.0s, seg3 +6.4s, seg4 +14.9s |
| `STOP` | **timed out after 5000ms** (receiver wedged) | clean `IDLE`/`CANCELLED` |
| **On screen (human report)** | **"no video playback, just the loading state"** | **"i saw the clip"** |

Because both runs used pre-baked media and a server sharing no code with the engine, this **exonerated our whole HLS pipeline** — playlist synthesis, on-demand ffmpeg, segment latency, the media server — and killed `pickLanIp` as a suspect (the device's own IP is on every request log line). The fMP4 failure mode is worse than a refusal: the receiver consumes segments, emits no error code, and then stops answering the media channel entirely. That silence is exactly why this read as our bug for so long.

Two lessons, both paid for:
- **Human eyes settled what no log could.** Both runs looked similar on the Mac until the screen was described.
- **One device is not a population.** The evidence was real; the generalisation was not. `spike-hls-selftest.mjs` passing gave false confidence here too — a clean ffmpeg decode proves media is *decodable*, never that a receiver will *present* it. That harness cannot catch this class of fault.

### CALIBRATED: `playerState` is a valid proxy for wedged-vs-playing
Across 10+ paired runs on 2026-07-23, every LOAD that emitted `BUFFERING` → `PLAYING` was confirmed on screen by a human, and every LOAD that stayed `IDLE`/`LOADING` and ended in a `STOP` timeout showed no video. **So for the crude "did it wedge" question, the log is now trustworthy** and single-variable experiments can be chained without a human in the loop.

This does NOT extend to anything subtler. The receiver reports `PLAYING` for green frames, wrong colours, missing audio, stutter and HDR washout alike. **Final verification of any tier still requires human eyes.** And when you do ask, name the device — running a test on a different device than the one being watched produced a genuinely confusing exchange.

### Historical detail (the original report, kept for context)
Originally reported against the packaged app on an **NVIDIA Shield TV** (Android TV with Chromecast built-in — NOT one of our profiled devices at the time; its mDNS `md` resolved to the conservative `unknown` profile, 1080p30 H.264; the `shield` profile was added later in `b0320ed`).

| Fixture | Plan on `unknown` profile | Result |
|---|---|---|
| `lima_mp4-h264-aac51.mp4` | HLS fmp4, tier=audio-transcode (video copy, aac_at 192k stereo), keyframe segments | **hangs "loading" forever** |
| `charlie_mp4-h264-l51-4k.mp4` | HLS fmp4, tier=video-transcode (h264_videotoolbox q50 → 1920x1080), fixed 6s segments | **hangs "loading" forever** |
| `alpha_mp4-h264-aac.mp4` | direct play (video/mp4, Range) | works |
| one other fixture (UNCONFIRMED which) | — | works |

That unidentified fourth file is exactly why fixtures now carry NATO codenames (`fixtures/README.md`): `mp4-h264-aac.mp4` and `mp4-h264-aac51.mp4` are indistinguishable when read aloud, so a verbal report could not pin down which file worked. Report by codename from here on — "alpha played, lima hung".

### DISCRIMINATOR RESOLVED (2026-07-23, CLI against the real device, `shield` profile)
**Direct play works; ALL HLS fails — including the remux tier with no encoder involved.** So this is not about transcoding, encoder failure, or first-segment latency. It is HLS itself on this receiver.

| Test | Result |
|---|---|
| `alpha` (direct) | reaches `playing`, renders on screen — **from a screensaver state**, so the device is awake and rendering fine |
| `delta` (HLS remux, video copy, no encoder) | device fetches playlist×2, init×1, **3 segments, 9,099,991 bytes, 0 errors** — then never reports a player state. **Nothing renders on screen at all.** Byte-identical across runs, so deterministic |

The device consumes our stream happily and refuses to present it. `spike-hls-selftest.mjs` independently proves the bytes are valid (playlist, init stability, EXTINF-vs-actual drift, and a clean 20s ffmpeg decode pass on every tier), so the fault is receiver-side, not ours. *(Correct as far as it goes — but at this point we still wrongly believed the fault was specific to the Shield. See the correction above.)*

### How to REPRODUCE the fMP4 finding
The decisive variants are baked into `fixtures/` (gitignored, so they will not travel — re-bake them):

```bash
bash scripts/bake-spike-media.sh          # h264-fmp4, h264-ts, hevc-fmp4
node scripts/spikes/static-server.mjs --dir "$(pwd)/fixtures/spike-hls/h264-fmp4" --port 8010
node scripts/spikes/spike-load.mjs --device "<name>" \
  --url http://<host-lan-ip>:8010/playlist.m3u8 \
  --content-type application/vnd.apple.mpegurl --duration 59.983 \
  --hls-segment-format FMP4 --hls-video-segment-format FMP4     # wedges
#   ...and the same against h264-ts with TS_AAC / MPEG2_TS      # plays
```
`--duration` is NOT optional for fMP4 (no `moov` duration) — omitting it introduces a difference the engine does not have and risks a false negative.

**The load-bearing control needs no baking at all** — run these two against any device and the answer falls out in 60 seconds:
```bash
# fMP4 — wedges on every device tested
--url "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"
# TS — plays (also proves the device's internet works, so the fMP4 result is real)
--url "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8"
```
`static-server.mjs` logs one line per request (method, path, range, status, elapsed, remote address) in the same format as the engine's `MediaServer`, so spike and engine output can be read side by side. The wedge signature is always: playlist ×2, init ×1, ~3 segments, all 200 — then silence.

### Still open around this fix
- **The only route back to fMP4 (and to HEVC stream-copy) is a CUSTOM RECEIVER.** Everything above is the *Default* Media Receiver (CC1AD845). Whether a custom/styled receiver presents fMP4 is untested and is a real piece of work; do not assume either way.
- `hevcInHls` is read by NOTHING in `packages/*/src`. It is decorative — the real HEVC gate is now the segment format in `decide/decision.ts`. Either wire it up or delete it.
- `charlie` is not a reproducer — on the `shield` profile it direct-plays. Use `lima` (HLS audio-transcode) and `delta` (HLS remux).
- **Two latent bugs surfaced while making this change, both deliberately left unfixed and asserted-as-is in tests:**
  1. **`hdrOutcome` now lies more often.** It is computed in `video-rules.ts` `hdrGate()` during step 1 of `buildPlaybackPlan`, before the segment format is known; the TS-driven `forceH264` demotion happens later in `decision.ts` and never revisits it. So `hotel` on `ultra` reports `hdrOutcome: 'preserved'` while planning an 8-bit SDR H.264 encode. Previously this only bit `shield`; with TS universal it affects every HDR-source-on-HEVC-device plan.
  2. **Stale user-facing advice** at `session/playback-session.ts:584` — the LOAD-stall diagnosis still ends "try the TS variant against this device", but TS is now always what we send.

## Empirical gotchas (hard-won; verified on a macOS Apple Silicon machine — do not "simplify" away)
- ffmpeg 8.1.1 (Homebrew, Apple Silicon) is what the CLI and dev-mode app resolve. No x265, no libvorbis, no zscale/libplacebo → **no tone-mapping possible**; HDR-on-SDR = warn or block. DTS/TrueHD/native-vorbis encoders need `-strict -2` (fixtures only).
- **The packaged app and the CLI now run DIFFERENT ffmpeg binaries** — the app gets bundled static LGPL 8.1.2, the CLI gets Homebrew 8.1.1 (see RELEASE PACKAGING). The encoder set the engine actually uses is identical, but this breaks a transitive assumption that held all through the hardware campaign: **a tier verified via the CLI is no longer automatically verified for the packaged app.** Where the binary could matter, test the app.
- **`-ss` keyframe seek on Matroska lands one GOP early when the target is exactly a keyframe** → all seek-restarts add `SEEK_EPSILON_SEC = 0.25` (`ffmpeg/args.ts`).
- **VideoToolbox drops HDR color tags set as output options** → HDR transcodes need `-vf setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le`.
- `delay_moov` is required for AC-3/E-AC-3 only in *progressive* fMP4; the HLS muxer needs no extra flags.
- HLS muxer on this build rejects absolute `-hls_fmp4_init_filename` → ffmpeg runs with `cwd=workDir`, relative outputs.
- **Corollary — FIXED 2026-07-23 (was OPEN BUG #2): a RELATIVE input path broke every HLS tier.** Because ffmpeg's cwd is the temp `workDir`, a relative `-i` resolved against that temp dir and died instantly (`code 254: No such file or directory`); the segment waiters then sat until the 30s timeout and the device got 500s, presenting as "loading forever". Direct play was unaffected (the media server resolves against the process cwd), which is why it hid so long. Fixed in two layers: `probe()` (`probe/ffprobe.ts`) resolves to absolute so `MediaInfo.path` is absolute by construction, and `HlsSession`'s constructor re-resolves `input` to cover any caller that bypasses `probe()`. **Relative CLI paths are now safe on every tier** (verified on hardware). Keep both layers — `buildHlsArgs` stays a pure argv builder and does NOT resolve.
- Never put `-t` on a `-copyts` run (instant-stop artifact); kill after N segments instead.
- Multichannel AAC is downmixed by Chromecast → never copy >2ch AAC. Opus not supported on video Chromecasts. `5.1(side)` → aac_at needs `channelmap=channel_layout=5.1` (PCE trap).
- **LOAD segment-format hints — CORRECTED 2026-07-23.** The old claim ("must set `hlsSegmentFormat`/`hlsVideoSegmentFormat` to FMP4 or fMP4 HLS fails") was never the operative constraint: Apple's reference fMP4 stream wedges *with and without* the hints. We now always send `TS_AAC`/`MPEG2_TS`, which `buildLoadMedia()` derives from `plan.segmentFormat`. **`duration` must still always be set** — genuinely load-bearing for fMP4, and harmless for TS.
- `castv2` npm pkg: async protobuf schema load (await `castv2-ready.ts`) and requires **asarUnpack** in Electron (`electron-builder.yml`).
- macOS Sequoia local-network TCC: CLI inherits Terminal's grant; the packaged app needs its own grant (prompt on first discovery). Dev-mode `electron .` discovery may be silently blocked — packaged-in-/Applications is the TCC test path.
- The engine-gate outcome (`real` vs `mock` + reason) is logged by the app main process with prefix `[engine-gate]`.
- **`MediaChannel.unwrap` hides an EMPTY `status: []` by resolving to the stale `_lastStatus`.** That is why a resync after reconnect silently kept a dead `mediaSessionId`. Harmless now that recovery always re-LOADs, but a command issued in the gap still gets `INVALID_MEDIA_SESSION_ID`. Changing the empty-status semantics would break several existing tests — do it deliberately or not at all.
- **A leaked power assertion is worse than the bug it fixes.** `SleepBlocker` (`app/src/main/power.ts`) is idempotent in both directions and released in a `finally`, because `session.stop()` REJECTS against a dead receiver — the exact case that would otherwise keep the Mac awake forever.
- **A superseded segment is NOT an error — do not "restore" it to one.** Scrubbing makes the receiver fire off dozens of in-flight segment requests that the seek-storm logic deliberately abandons in favour of the final target. `HlsSession` rejects those with `SupersededError`; `MediaServer` logs them at **debug** and keeps them out of `RouteStats.errors`. Observed before the fix: one short session produced **75 ERROR lines, all of them superseded, zero genuine faults** — which buries real errors and makes a healthy session read as broken. The `errors` counter matters beyond the log: `diagnoseStall()` quotes it to the user as "N error response(s)". The wire status is still **500**, deliberately unchanged — 404 is arguably more correct but we have no hardware evidence for how a receiver reacts to each status mid-scrub, so that needs an A/B, not a guess.
- **Verifying WHICH engine a packaged app bundles: grep the right copy.** The bundle contains engine code twice. `Contents/Resources/app.asar` → `dist/main/index.cjs` statically inlines part of the engine (incl. `profiles.ts`) because `engine-host.ts` imports `createMockEngine` by relative path so the mock fallback always works — grepping THAT file for engine behaviour gives a misleading answer. The REAL engine is a dynamic `await import('@castgorilla/engine')` resolved at runtime from `node_modules/@castgorilla/engine` **inside** the asar. To check a bundle is fresh: `node_modules/.bin/asar extract-file /Applications/castgorilla.app/Contents/Resources/app.asar node_modules/@castgorilla/engine/dist/<file>.js` (writes to CWD, not stdout — run it from a scratch dir or it dirties the repo). `Info.plist` version is now real (from `packages/app/package.json`; `1.0.1` as of 2026-07-24), but it only moves when the version does — **within a version the bundle mtime is still the only freshness signal**.

## RELEASE PACKAGING (2026-07-24) — first signed, notarized, self-contained build
`packages/app/release/Cast Gorilla-1.0.0-arm64.dmg`. Everything before this was `electron-builder --dir` output carrying Electron's ad-hoc linker signature (`Identifier=Electron`, `TeamIdentifier=not set`) and silently depending on the maintainer's Homebrew. **Verified against the built bundle, not inferred from config:** the `.app` reports `Identifier=co.castgorilla.app`, `flags=0x10000(runtime)`, `Authority=Developer ID Application: Intheday Ltd (29UYFH4USR)`, `TeamIdentifier=29UYFH4USR`, and a stapled ticket; the DMG carries the same authority and `spctl -a -t open` returns `accepted / source=Notarized Developer ID`. **Verified by LAUNCHING it:** it logs `[engine-gate] {"mock":false}` — the signed, notarized, hardened bundle runs the REAL engine, which is the check that matters most here because a bundle that silently falls back to the mock looks perfectly healthy.

**Version was fake in three places; it is now derived in one.** `src/renderer/index.html` hardcoded `v1.4`, `package.json` said `0.0.0`, the packaged `Info.plist` carried `0.0.0` — three values, none agreeing, none true. `packages/app/package.json` (`1.0.0`) is now the single source: `vite.config.ts` `readAppVersion()` injects `__APP_VERSION__` (declared in `src/renderer/env.d.ts`) into a new `#app-version` element, **added to the ELEMENT CONTRACT**. `readAppVersion()` **THROWS on a missing or malformed version instead of defaulting** — a silent `0.0.0` fallback is precisely the bug being fixed and would have camouflaged its own return.

**Name and icon.** `productName: castgorilla` → `Cast Gorilla`. **`appId` is deliberately UNCHANGED (`co.castgorilla.app`)** — the appId is the macOS bundle identity the TCC grant hangs off, so changing it would cost the grant again while the display name costs nothing. Note the three names are independent and are owned by different fields: **`appId` = bundle identity/TCC, `name` (`@castgorilla/app`) = Electron `userData` path, `productName` = display only.** Only `productName` moved here. There was previously **no app icon at all**: no `build/` dir existed, so `CFBundleIconFile` was the stock `electron.icns`. Now `packages/app/build/icon.icns`, full 10-slot ladder. Legible at 32px; **at 16px the face is mush** — only the squircle silhouette and the green gradient carry identity. That is inherent to artwork this detailed and needs a separate simplified 16px variant, not a re-export.

### Bundled ffmpeg — the app is standalone for the first time
Before this the app **required the user to have Homebrew ffmpeg**, and worse: a Finder-launched app gets a minimal `PATH` without `/opt/homebrew/bin`, so only the engine's hardcoded step-3 Homebrew fallback made it work at all — on this machine only. It also failed **lazily**, so the app looked healthy right up until the user opened a file.

`scripts/build-ffmpeg.sh` (new, idempotent) builds **static LGPL ffmpeg/ffprobe 8.1.2, arm64** into gitignored `vendor/ffmpeg/arm64/`. `src/main/ffmpeg-paths.ts` sets `CASTGORILLA_FFMPEG`/`CASTGORILLA_FFPROBE` to the bundled paths when `app.isPackaged`, **only if unset** so an explicit override still wins, and is imported FIRST in `src/main/index.ts`. **No engine change was needed** — this hooks step 1 of the engine's existing resolution order. Verified in the shipped bundle: ffmpeg 8.1.2; all four required encoders present (`h264_videotoolbox`, `hevc_videotoolbox`, `aac_at`, `eac3`); `otool -L` shows **only** `/usr/lib` + `/System/Library` (zero Homebrew); arm64; signed with our Developer ID.

**LGPL is sufficient and GPL is not needed:** the engine only ever emits `-c:v copy` or VideoToolbox encoders, so every encoder and decoder it needs is LGPL or Apple-framework. Dropping x264/x265/vpx/svtav1/dav1d makes the build smaller **and** removes the redistribution obligations that come with GPL components. `ffmpeg -L` self-reports LGPL v2.1.

Traps found building it — all load-bearing, do not "simplify" any of them away:
- **`--disable-lzma` is LOAD-BEARING.** macOS ships no system liblzma but Homebrew does, so ffmpeg autodetects it and links `/opt/homebrew/lib/liblzma.dylib` — a silently non-portable binary that works here and fails on every user machine. Same reasoning for `--disable-sdl2/xlib/libxcb`. Configure also runs with `PKG_CONFIG_LIBDIR` pointed at an empty dir and `CFLAGS`/`LDFLAGS` cleared, so nothing else can leak in the same way.
- **Do NOT collapse that to `--disable-autodetect`.** It also disables `THREADS_LIST`, i.e. pthreads, yielding a single-threaded ffmpeg. The leaks are disabled surgically for exactly this reason.
- **LGPL compliance ships in the bundle:** `COPYING.LGPLv2.1` and `LICENSE.md` (both verbatim from the built tarball) plus a generated `README.castgorilla.txt` corresponding-source notice, in `Contents/Resources/ffmpeg/`. Licence presence is a **hard gate assertion** in the build. The notice's configure line is generated from the same array the build uses and was cross-checked against the binary's own `-buildconf`. `--prefix` is redacted in the notice because it embedded the maintainer's home directory.

### Signing and notarization — new, and full of fail-open traps
- **`mac.identity` must NOT include the `"Developer ID Application:"` prefix.** `checkPrefix()` (`app-builder-lib/out/codeSign/macCodeSign.js:279-281`) throws `InvalidConfigurationError` for any of the four `appleCertificatePrefixes`. electron-builder derives the certificate TYPE itself; the string is a substring QUALIFIER handed to `_findIdentity()`. Correct value: `"Intheday Ltd (29UYFH4USR)"` — keep the team ID, it is what disambiguates.
- **`notarize: true` FAILS OPEN.** With no credentials in the environment, electron-builder logs `skipped macOS notarization` at **warn** and ships an un-notarized bundle that installs fine here and is refused by Gatekeeper on a clean Mac. **Grep the build log for that string before shipping** — the build's exit code will not tell you.
- **A missing `extraResources` source ALSO fails open** — `file source doesn't exist` at warn, then it packages an app with no ffmpeg at all. `vendor/` is gitignored, so this WILL happen the first time anyone packages without running `build-ffmpeg.sh`. Same remedy: grep the log.
- **electron-builder does NOT sign or notarize the DMG — only the `.app` inside it.** `dmg.sign` defaults false. Straight out of the build the DMG was `code object is not signed at all` and `spctl` **rejected** it (`no usable signature`). The fix is a manual post-build step, and **the order is load-bearing — signing invalidates an existing ticket**: `codesign --sign … --timestamp --force <dmg>` → `xcrun notarytool submit … --wait` → `xcrun stapler staple <dmg>`. That sequence moved it to `accepted / source=Notarized Developer ID`. **Stapling alone is NOT sufficient** — the first attempt notarized and stapled the DMG *without signing it first* and `spctl` still rejected it. **This silently recurs every release** — a required release step, not a footnote. See Commands.
- **`stapler validate` and `spctl` fall back to an ONLINE ticket lookup, so on a networked build machine they pass whether or not a ticket is embedded — the exit code proves *notarized*, never *stapled*.** Observed 2026-07-24 on the shipped DMG: the first `xcrun stapler validate` printed `does not have a ticket stapled to it`; a following `-v` run **downloaded** the ticket (`Downloaded ticket has been stored at …`) and reported success, and every plain run since reports success from that cache — so the check is not repeatable once the cache is warm. A raw byte scan of the DMG finds no ticket markers (`signedTicket`/`bplist00`) either. **The `.app` staple IS confirmed by artifact** (`Contents/CodeResources`, written at 23:59, after the 23:56 signature); **the DMG's own staple is not** — the only environment where the difference shows is a clean, offline Mac, so check it there before calling a release stapled. Mitigating fact: the `.app` inside the DMG is stapled, so an app copied out of it is fine offline regardless.

**Entitlements** (`packages/app/build/entitlements.mac.plist`) — only TWO keys, `allow-jit` and `allow-unsigned-executable-memory`, each justified in the file itself. The rest of the usual Electron default set was deliberately REMOVED, with the evidence recorded inline. **The trimmed set is VERIFIED, not just argued: the signed bundle launches and runs the real engine under the hardened runtime with only those two.** The reasoning behind each removal, kept because it is what you need to re-derive the decision:
- `allow-dyld-environment-variables` governs `DYLD_*` **only**. Ordinary environment variables like `CASTGORILLA_FFMPEG` are untouched by the hardened runtime, so `ffmpeg-paths.ts` works without it. Nothing in the repo uses `DYLD_`.
- `disable-library-validation` — castv2 ships **zero** Mach-O files (JS + `.proto` + `.desc`); its `asarUnpack` is about protobufjs needing a real on-disk path and is unrelated to library validation. The whole production tree is pure JS, and the bundled ffmpeg/ffprobe are spawned as **child processes**, never `dlopen`'d. **Re-add it the moment a native module or third-party dylib enters the production tree** — the symptom is a library-load failure at `require()` time.
- App Sandbox is deliberately absent: it would break the local HTTP media server and Bonjour discovery, and Developer ID distribution does not require it.

**Apple-account trap.** Notarization first failed with `HTTP 403 — A required agreement is missing or has expired` while the Developer ID certificate was still valid to Feb 2027 — the certificate's validity tells you nothing about the account's. Fixed by accepting the updated agreement in the developer portal. The signing Apple ID may be on **more than one team**, and **agreements are per-team** — use the portal team switcher for Intheday Ltd (`29UYFH4USR`). Credentials live in a notarytool keychain profile named `castgorilla`; builds pass `APPLE_KEYCHAIN_PROFILE=castgorilla`.

### NOT proven — do not let the green checks imply otherwise
*Written for 1.0.0 at first signing. Phase 0 (2026-07-24, `docs/phase0-1.0.0-hardware.md`) then settled items 1, 2 and 4 **for 1.0.0**. Item 1 is OPEN AGAIN for 1.0.1 — a rebuild is a new binary and inherits none of the previous build's hardware evidence. Kept in full because the reasoning is what you need when you next cut a release.*
- **The bundle has never been cast from.** It launches and runs the real engine; no TV has seen it. Per the hardware protocol, only a human watching the screen settles that. — *1.0.0: SETTLED, play PASS on SHIELD. **1.0.1: OPEN**, no TV has seen it.*
- **ffmpeg independence is UNPROVEN, and this is the sharpest trap in this section.** Every check above passes on this machine *even if bundling silently failed*, because Homebrew ffmpeg is still sitting at `/opt/homebrew/bin` as a working fallback. The real test is launching the installed app with `/opt/homebrew/bin/ffmpeg` and `ffprobe` **temporarily renamed** — anything short of that is measuring the wrong machine. — *1.0.0: SETTLED by Test A with Homebrew renamed. 1.0.1: the rename test was NOT re-run; what IS verified by artifact is that the installed 1.0.1 ships ffmpeg 8.1.2 arm64 at `Contents/Resources/ffmpeg/` with `otool -L` showing zero non-system dylibs, all four required encoders, and the LGPL licence files. Same vendored binaries, same packaging step — but that is inspection, not the rename test.*
- **The DMG's own notarization ticket may not be stapled** (above). The `.app` inside it is. — *Unchanged for 1.0.1: `stapler staple` reported success on the DMG, but a `strings` scan finds no ticket markers. That scan is weak evidence either way (the DMG is compressed UDZO), so it neither confirms nor refutes. Only a clean offline Mac settles it, and the stapled `.app` inside makes it moot for anyone who copies the app out.*
- ~~The DMG is **not installed**~~ — *superseded. `/Applications/Cast Gorilla.app` is the 1.0.1 build, installed from the 1.0.1 DMG. The predicted "fresh TCC prompt on install" did NOT occur across 1.0.0 → 1.0.1: both devices were discovered immediately, because `appId` is unchanged and the signing identity is the same. User data does NOT move (verified at 1.0.0).*

## Commands
```bash
npx tsc -b && npm run typecheck -w packages/app && npx vitest run   # the FULL gate
# ^ tsc -b alone does NOT cover packages/app (its tsconfig is outside the
#   project-reference graph), so the app typecheck is a separate, required step.
bash scripts/gen-fixtures.sh          # regenerate fixtures (idempotent)
node packages/cli/bin/castgorilla.js devices|probe <file>|play <file> --device <name>
npm run build -w packages/app && (cd packages/app && npx electron-builder --dir)  # unsigned .app only
```

### Release build (signed + notarized DMG)
```bash
# 0. Bump packages/app/package.json — it is the SINGLE source of the version and
#    feeds Info.plist, the DMG filename and the in-app #app-version element.
bash scripts/build-ffmpeg.sh          # static LGPL ffmpeg/ffprobe -> vendor/ffmpeg/arm64 (idempotent, slow, REQUIRED)
# ^ skippable ONLY if vendor/ffmpeg/arm64 already holds a verified build: check
#   `./ffmpeg -version`, `otool -L ffmpeg` (want zero non-/usr/lib,/System paths),
#   the four encoders, and that COPYING.LGPLv2.1 + LICENSE.md are present.
cd packages/app && APPLE_KEYCHAIN_PROFILE=castgorilla npm run dist:dmg 2>&1 | tee /tmp/build.log
# ^ MUST grep the log: "skipped macOS notarization" and "file source doesn't exist"
#   BOTH fail open at warn level and both ship a broken artifact (see RELEASE PACKAGING).
#   Want zero hits and one "notarization successful":
grep -c "skipped macOS notarization" /tmp/build.log   # want 0
grep -c "file source doesn't exist"  /tmp/build.log   # want 0
grep    "notarization successful"    /tmp/build.log   # want 1 line

# electron-builder signs the .app but NOT the .dmg. Order is load-bearing —
# signing invalidates an existing ticket, so sign FIRST, then notarize, then staple.
# Derive the name so this snippet cannot rot against the version again:
DMG="release/Cast Gorilla-$(node -p "require('./package.json').version")-arm64.dmg"
# NB: raw codesign wants the FULL identity string, prefix included — the opposite
# of electron-builder's `mac.identity`, which throws if you include the prefix.
codesign --sign "Developer ID Application: Intheday Ltd (29UYFH4USR)" --timestamp --force "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile castgorilla --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -v "$DMG"   # want: accepted / Notarized Developer ID
```
`spctl` and `stapler validate` both fall back to an ONLINE lookup — green here does not prove a stapled ticket.

**Install — prefer mounting the DMG** (`hdiutil attach`, copy the `.app`, `hdiutil detach`) over copying from `release/mac-arm64/`: it exercises the artifact a customer actually receives, not just the directory it was built from. Two traps, both hit on 2026-07-24:
- **The old app is probably still running even when the user says they closed it** — macOS keeps an Electron app alive with no windows. Deleting a running bundle is asking for trouble. `pgrep -f "/Applications/Cast Gorilla.app"` first, and **before quitting check `pmset -g assertions | grep -i "cast gorilla"`: a live cast session holds a power assertion**, so an empty result is your evidence nothing is mid-playback. Then `osascript -e 'tell application "Cast Gorilla" to quit'`.
- **A same-identity upgrade does NOT re-prompt for Local Network TCC.** 1.0.0 → 1.0.1 discovered both devices immediately. The grant hangs off `appId` + signing identity, neither of which moved. Expect a fresh prompt only when one of those changes (as at the `co.sickstream.app` → `co.castgorilla.app` rename).

**Ship destination:** after Phase 0 (`docs/release-1.0.0-handoff.md`), upload the DMG to **Gumroad only**. Never attach it to GitHub Releases. Protocol: `docs/DISTRIBUTION.md`.

## REAL-MEDIA VALIDATION (2026-07-23) — first run against a real library
Everything before this was synthetic fixtures. These are real files off disk, played via the CLI, confirmed on screen by a human. **Never commit titles, release-group tags, or absolute paths** — characteristics only (codec, resolution, duration, audio layout, tier). Private inventory stays in gitignored `NOTES.local.md`.

| File (characteristics only) | Plan on `shield` | Result |
|---|---|---|
| a **7.9 GB 1080p H.264 MKV**, 1:50:28, h264 High 1920x1040 23.976, E-AC-3 5.1, **5 subtitle tracks** | HLS (ts), **audio-transcode** — video copy, eac3 6ch → aac 2ch, keyframe segments | **plays**; seg0 +103ms; all sidecar VTTs converted and pulled by the device |
| a **1080p HEVC Main 10 MKV**, 965 MB, 49:07, 1920x960 23.976, AC-3 5.1 | HLS (ts), **video-transcode** — HEVC → h264_videotoolbox, ac3 6ch → aac 2ch, fixed segments | **plays**; **seg0 +804ms**; encoder runs AHEAD of playback (seg4 served in 3ms, later segments fetched at ~6s real-time intervals) |

Both also verified on the **Chromecast HD** (`gen2`): the H.264 file's audio-transcode (seg0 +105ms), the HEVC file's video-transcode (seg0 +831ms). Note the planner's reason for transcoding the HEVC file differs correctly by device — `HEVC cannot ride MPEG-TS HLS` on `shield` (which decodes HEVC) vs `device cannot decode HEVC` on `gen2`.

### SEEK-RESTART VERIFIED ON HARDWARE (first time)
Seeks were driven from the TV remote on both tiers, both devices. The transcode-tier seek is fully evidenced in the log:

```
seek to 9:34 →  -ss 570.25 -noaccurate_seek … -start_number 95
                   ↑ 570 + SEEK_EPSILON_SEC        ↑ 570/6 = seg95
seg95 ready +834ms   (cold start on the same file was +831ms)
```

So: `SEEK_EPSILON_SEC` behaves as documented against a real Matroska; `-start_number` lands on the right boundary; and **a seek-restart costs no more than a cold start**. A copy-tier seek on the H.264 file (0:07 → 15:47) also succeeded. Transport controls (play/pause/seek) from the device remote work on both devices.

Facts this established that fixtures could not:
- The keyframe indexer and the subtitle pipeline both survive a real 7.9 GB multi-track MKV.
- A 1080p HEVC→H.264 VideoToolbox transcode starts fast enough (**804ms to seg0**) and sustains ahead of real-time playback. First-segment latency is not a problem on this class of content.
- **The maintainer's library is overwhelmingly HEVC.** So the "HEVC never stream-copies" cost is not academic — it applies to most of what actually gets watched, meaning a full re-encode (CPU + generational quality loss) on nearly every play. **This makes the custom-receiver fMP4 spike the single biggest quality lever in the product**, not a nice-to-have.
- **Surround is silently lost by default.** Both files carry 5.1 (`ac3` / `eac3`) and both were downmixed to 2ch AAC because `prefs.surround` defaults to false. The Shield is a home-theatre device with passthrough, and its profile says so. The `--surround` path is still UNTESTED on real hardware.

## RESOLVED — Mac sleep killed playback, and "reconnect never fired" was WRONG (2026-07-23)
A 49-minute episode cast from the packaged app died twice. Correlating the app log (UTC) with `pmset -g log` (local time) gave an exact match — `Idle Sleep` on battery at 12:31:53 and 12:34:49, each wake immediately followed by `connection lost (heartbeat-timeout)`. **The host Mac IS the media server** (HTTP server + on-demand ffmpeg), so sleep kills playback outright. `pmset -g assertions` filtered to the app returned nothing: it held no power assertion at all.

**The instructive part.** `grep -iE "reconnect|session-lost|resum"` over the whole log returned NOTHING, which looked like the reconnect machinery never fired. **That inference was wrong.** Investigation proved the transport reconnected *successfully*, twice, in complete silence:
- `handleConnectionLost` is not terminal — it emits `reconnecting` and runs the reconnect loop (defaults: 8 attempts, 250ms→4s backoff).
- The **success** path had no log statement anywhere, and `setState()` logged nothing either, so a full drop→recover cycle wrote zero lines. Every **failure** path *does* log (`reconnect attempt N/M failed`, `receiver app gone after reconnect`), and none appeared — which is the positive proof that nothing failed.
- Clincher: `handleConnectionLost` returns early unless `phase === 'connected'`, and `phase` only returns to `connected` in the reconnect success branch. The **second** heartbeat timeout on the same client therefore proves the first reconnect completed end to end.

**Why it was useless anyway — the real bug.** `resyncSession` found the receiver app still running and called `getStatus()`. A receiver that keeps the app but has discarded the *media* session answers with an empty `status: []`, and `MediaChannel.unwrap` resolves that to the **stale** `_lastStatus` — so `_mediaSessionId` kept a dead value and every later PLAY/PAUSE/SEEK returned `INVALID_REQUEST / INVALID_MEDIA_SESSION_ID`. **Restoring the transport is not restoring playback.** Recovery must issue a fresh LOAD.

**Fixed:** the app holds a `powerSaveBlocker('prevent-app-suspension')` for the life of a session (released on all eight exit paths); reconnect is narrated at info; and `reconnected` now triggers `resumeAfterReconnect()` — a fresh `doLoad()` at the **last observed `currentTime`** (never the interpolated position, which would add the whole sleep), bounded to 3 attempts, guarded against user-stopped/cleaned/re-entrant cases.

**Limits, stated honestly:** this prevents *idle* sleep only — closing the lid on battery still sleeps the Mac and still kills playback, and no version of this app can stream while the host is asleep. What it gets you is recovery a few seconds after wake instead of silent death.

**VERIFIED ON HARDWARE 2026-07-23 13:07** — forced `pmset sleepnow` mid-playback on the Shield, woken 28s later. Confirmed playing on screen by a human ("It works."):
```
13:07:17 Sleep 'Software Sleep'   /   13:07:45 Wake
12:07:45.258Z WARN  connection lost (heartbeat-timeout)
12:07:45.258Z INFO  reconnecting to <device-ip>:8009 (up to 8 attempts)
12:07:45.259Z INFO  dropped while playing - recovering, last known position 35:58
12:07:45.502Z INFO  reconnect attempt 1/8 (after 242ms backoff)
12:07:46.362Z INFO  reconnected after 1 attempt(s) in 1103ms
12:07:46.362Z INFO  resuming playback on "<device>" at 36:47 (attempt 1/3)
12:07:46.930Z INFO  resume LOAD accepted at 36:47
```
**1.67s from drop to resumed LOAD, first attempt.** The same event earlier that day produced one `connection lost` line and then silence forever.

Also verified live: `pmset -g assertions` shows `pid N(castgorilla) ... NoIdleSleepAssertion named: "Electron"` while a session is live (that is how Electron's `prevent-app-suspension` presents), and the app log shows balanced `[power] acquired`/`released` pairs across sessions — no leak. The forced sleep still slept the Mac, correctly: assertions block IDLE sleep only.

**Unexplained, worth confirming before relying on it:** the drop logged `last known position 35:58` but resumed at `36:47` — 49s later, in 1.1s of wall clock. Most likely the receiver kept playing from its OWN buffer during the sleep and the resync picked up its true position (which would be better than resuming at 35:58). That would also mean the receiver had NOT discarded the media session in this instance — a milder case than the `INVALID_MEDIA_SESSION_ID` that started this. Do not assume the discard case is fixed by this one run; it is covered by tests, not by hardware.

**Left for sign-off:** a session that was PAUSED before the drop resumes *playing* (`doLoad` is always `autoplay: true`).

## KNOWN COST of TS-everywhere — HEVC never stream-copies on an HLS tier
Because the receiver takes neither HEVC-in-fMP4 nor HEVC-in-TS, any HEVC file that cannot direct-play (anything not in a Cast-legal MP4 — `kilo`, `hotel`) is **fully re-encoded to H.264** on every device. Planner reason to look for: `video: HEVC cannot ride MPEG-TS HLS; transcoding to H.264`. HEVC-in-MP4 still direct-plays untouched, so this bites the HLS tiers only.

This is not a limitation of our muxing — ffmpeg muxes HEVC into mpegts fine, and the Shield explicitly rejected the result (`idleReason: ERROR`). Tested, not assumed.

## Next milestones
0. ~~Verify the 1.0.0 release bundle~~ **DONE 2026-07-24** for play + bundled ffmpeg — see `docs/phase0-1.0.0-hardware.md`. **1.0.1 is now built, notarized and installed but NOT hardware-tested** — one cast to SHIELD with a human watching is the outstanding gate (`docs/DISTRIBUTION.md` step 1: re-run Tests A/B whenever the DMG is rebuilt). Also remaining: optional offline DMG staple check; Gumroad upload; `v1.0.1` tag (source only, no binary assets).
1. **Seek/scrub on video-transcode — STILL OPEN after `d498b13`.** Hardware 2026-07-24: burst scrub → frozen frame + spinner ~50:30 on SHIELD; nudge recovered. Start at **`docs/phase0-1.0.0-hardware.md`**, then `docs/segment-numbering-drift.md` / `docs/seek-restart-storm.md`. Next run needs `LOG_LEVEL=debug`. COPY-tier drift §9.4 still open separately.
2. Fix the known latent bugs, none of which are hard:
   - **`hdrOutcome` lies** — computed before the segment format is known, so it reports `'preserved'` while planning an 8-bit SDR H.264 encode. Affects every HDR-source-on-HEVC-device plan now that TS is universal.
   - **Stale watchdog advice** at `session/playback-session.ts` — the LOAD-stall diagnosis still says "try the TS variant against this device", but TS is now all we send.
   - **Duplicate `ipcMain.handle` registration** — on macOS, closing the window and re-activating re-runs `attachEngine()` and throws "Attempted to register a second handler". Pre-existing; the `win.once('closed')` change made the path easier to reach.
   - **A PAUSED session resumes PLAYING** after a reconnect (`doLoad` is always `autoplay: true`). Needs a product decision on the desired behaviour before fixing.
   - **`MediaChannel.unwrap` hides an empty `status: []`** behind the stale `_lastStatus`, so a dead `mediaSessionId` survives a resync. Harmless now recovery always re-LOADs, but a command issued in the gap still fails.
   - Decide `hevcInHls`'s fate — nothing reads it (wire up or delete).
3. **`play` fails hard on a single 5s discovery window.** Observed repeatedly: a device in screensaver/ambient state misses the window and the CLI exits `device "X" not found`, while an immediate retry succeeds. Retry or widen the window — this will read as "the app doesn't see my TV".
4. Add a `ccgtv`-class profile for md **"Chromecast HD"** — it currently prefix-matches bare `"Chromecast"` → `gen2` (H.264 L4.1 1080p30, no HEVC/VP9). Safe but under-serves 2022 Google TV hardware.
5. **Custom-receiver fMP4 spike — the biggest quality lever available.** The only known route back to HEVC stream-copy, and the maintainer's library is overwhelmingly HEVC, so today every one of those files is fully re-encoded on every play. Deserves its own session.
6. **Test `--surround` on real hardware.** Both real files carried 5.1 and both were silently downmixed to stereo (`prefs.surround` defaults false) on a Shield that advertises AC-3/E-AC-3 passthrough. The passthrough path has never run on a device. Cheap, high value.
7. G1 hardware gate: R1/R2 are answered (see Status). What remains is per-device codec/level limits.
8. WS7: device-matrix hardening, reconnect edges, README/TROUBLESHOOTING, remove remaining `'untested'` fields.
9. Backlog: AirPlay, tone-mapping, PGS/VobSub OCR, scrub thumbnails, a simplified 16px icon variant, an x64/universal build (the release is arm64-only because the bundled ffmpeg is). ~~bundled LGPL ffmpeg~~ **shipped and hardware-proven independent of Homebrew 2026-07-24**.
