# G1 Hardware Gate — runbook

> **Read this first — the runbook is partly superseded (2026-07-23).**
>
> It was written when R1 and R2 were open questions. Both are now answered, on
> real hardware, and the answers are recorded in `CLAUDE.md`:
>
> - **R2 (fMP4 vs TS) — SETTLED.** fMP4 HLS does not play on the Google Cast
>   **Default Media Receiver** at all, on any device tested, for any media —
>   including Apple's own reference fMP4 stream. MPEG-TS plays everywhere.
>   `resolveSegmentFormat()` now emits TS unless a profile *positively proves*
>   fMP4 (`hls.fmp4 === true`), and `'untested'` resolves to TS. There is no
>   longer a reason to run the R2 A/B on a new device as though the answer could
>   go either way — run it only to look for a device that *breaks* the rule, and
>   use the Apple reference-stream control (see `CLAUDE.md`) rather than baked
>   fixtures, since it needs no preparation.
> - **R1 (HEVC in HLS) — SETTLED, and negative.** HEVC cannot ride MPEG-TS to
>   this receiver either: the Shield rejected it explicitly with
>   `playerState: IDLE` / `idleReason: ERROR` ~0.6s after LOAD. Combined with
>   R2 there is no HLS segment format that carries HEVC, so **HEVC never
>   stream-copies on an HLS tier**. The R1 procedure below uses `hevc-fmp4`
>   media, which is now known-dead on two counts; it is kept for the record.
>   The only route back to HEVC stream-copy is a custom receiver, which is
>   untested work.
>
> **What is still open, and what this runbook is now good for:** per-device
> codec/level/resolution/frame-rate limits, and the remaining `'untested'`
> fields in `packages/engine/src/devices/profiles.ts`. The four-tier live demo
> below is still the right way to smoke a newly-acquired device end to end.

~30–45 min with your Chromecasts on the same Wi-Fi as this Mac. Run everything from the repo root in Terminal (Terminal's Local Network permission covers the CLI — approve the prompt if macOS asks).

Goal: characterise a device and smoke the real pipeline, then report results back to the orchestrating session so the device profile table gets updated from `'untested'` to real values.

## Prep (once)

```bash
npm run build 2>/dev/null || npx tsc -b
bash scripts/gen-fixtures.sh          # no-op if already generated
bash scripts/spikes/bake-spike-media.sh
node packages/cli/bin/castgorilla.js devices   # note exact device names; confirms discovery + TCC
```

## R1 — HEVC inside HLS (Ultra + Chromecast with Google TV + Streamer)

**Answered — see the header. Kept for the record and for anyone re-testing a device class we do not own.** The expected result is now a failure, not an open question.

Terminal 1:
```bash
node scripts/spikes/static-server.mjs --dir fixtures/spike-hls/hevc-fmp4 --port 8010
```
Terminal 2 (repeat with `--device` = your Ultra, CCwGTV, and Streamer names; the server prints the URL with your LAN IP):
```bash
node scripts/spikes/spike-load.mjs --device "<name>" \
  --url http://<host-lan-ip>:8010/playlist.m3u8 \
  --content-type application/vnd.apple.mpegurl \
  --hls-segment-format FMP4 --hls-video-segment-format FMP4
```
**Record per device:** reaches PLAYING with picture? Or error payload (the script prints `detailedErrorCode`/`reason` verbatim)?

## R2 — fMP4 vs TS segments on the old Chromecasts (gen2/gen3/built-in)

**Answered — see the header.** fMP4 wedges; TS plays. Run this pair only to hunt for a counter-example, and prefer the zero-setup Apple reference-stream control documented in `CLAUDE.md`.

Same pattern, two variants against each old device:
```bash
# variant A: fMP4
node scripts/spikes/static-server.mjs --dir fixtures/spike-hls/h264-fmp4 --port 8010
node scripts/spikes/spike-load.mjs --device "<name>" --url http://<host-lan-ip>:8010/playlist.m3u8 \
  --content-type application/vnd.apple.mpegurl --duration 59.983 \
  --hls-segment-format FMP4 --hls-video-segment-format FMP4

# variant B: TS
node scripts/spikes/static-server.mjs --dir fixtures/spike-hls/h264-ts --port 8010
node scripts/spikes/spike-load.mjs --device "<name>" --url http://<host-lan-ip>:8010/playlist.m3u8 \
  --content-type application/vnd.apple.mpegurl --duration 59.983 \
  --hls-segment-format TS_AAC --hls-video-segment-format MPEG2_TS
```
**Record per device:** which variant(s) reach PLAYING. `--duration` is not optional for fMP4 (no `moov` duration) — omitting it introduces a difference the engine does not have.

The wedge signature to look for: playlist ×2, init ×1, ~3 segments, every request HTTP 200 — then silence, no `BUFFERING`, no `PLAYING`, and a `STOP` that times out after 5000ms.

## Four-tier live demo (any one device, ideally a modern one first)

Still fully current — this is the part of the runbook to use on new hardware.

Interactive keys: space = pause/resume, ←/→ = ±10s, ↑/↓ = volume, m = mute, g = go-to, q = quit.

Fixtures carry NATO codenames (`fixtures/README.md`) — **report results by codename** ("delta played, lima hung"), never by descriptor.
```bash
node packages/cli/bin/castgorilla.js play fixtures/alpha_mp4-h264-aac.mp4  --device "<name>"   # ALPHA   direct
node packages/cli/bin/castgorilla.js play fixtures/delta_mkv-h264-aac.mkv  --device "<name>"   # DELTA   remux
node packages/cli/bin/castgorilla.js play fixtures/echo_mkv-h264-dts.mkv   --device "<name>"   # ECHO    audio-transcode
node packages/cli/bin/castgorilla.js play fixtures/oscar_avi-mpeg4-mp3.avi --device "<name>"   # OSCAR   video-transcode
```
Per tier: does it start, pause/resume, survive a ±10s seek and a far `g` seek, and quit cleanly? For real fun, try a long seek in `fixtures/foxtrot_mkv-h264-dts-45min.mkv` (the seek-restart path).

The two original BUG #1 files are the *other* members of the transcode tiers — `lima_mp4-h264-aac51.mp4` (audio-transcode) and `charlie_mp4-h264-l51-4k.mp4` (video-transcode). Run those too on any device under investigation. Note that `charlie` is no longer a reproducer on profiles that direct-play it.

**Follow the hardware testing protocol in `CLAUDE.md`:** one file at a time, ask the person at the TV what is on screen, wait for the answer before running the next thing. A log cannot tell you whether a picture appeared.

## Electron TCC check (R4, optional)

```bash
cp -R packages/app/release/mac-arm64/castgorilla.app /Applications/
open /Applications/castgorilla.app    # right-click → Open on first launch (ad-hoc signed)
```
Expect one Local Network prompt; after approving, devices should appear in the dropdown.

## Reporting back

Paste into the session, per device: model name (and the exact mDNS `md` string, which is what `resolveProfile` matches on) → codec/level limits observed, tier demo notes, any error codes. The orchestrator turns that into `profiles.ts` values via an agent brief.

Fields still carrying `'untested'` are the target. Note that `hls.fmp4` should only ever move to `true` on positive proof with a human confirming picture on the TV, and that `hevcInHls` is currently read by nothing in `packages/*/src` — decide its fate rather than populating it blindly.
