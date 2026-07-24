# castgorilla

Cast a local video file from a Mac to a Chromecast-class device, without first
converting it.

Point it at a file, pick a device on your network, press play. If the device can
already decode the file, castgorilla streams the original bytes untouched. If it
cannot, castgorilla works out the *smallest* change that would make it playable
— repackage the container, re-encode only the audio, or (last resort) re-encode
the video — and does that on the fly while you watch.

This is a working project with real hardware verification behind it, not a
finished product. Read [Status](#status) before you rely on it.

## Official builds

Source is **MIT** and free to clone, build, and modify.

The official macOS app — **Cast Gorilla**, Developer ID signed, notarized, with
bundled LGPL ffmpeg — is sold on **Gumroad only**. We do **not** publish DMGs or
other binaries on GitHub Releases.

- Buy / download: `YOUR_GUMROAD_PRODUCT_URL` (replace when the product is live)
- Distribution rules: [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)

Updates for customers are new Gumroad file versions (re-download from your
library). There is no in-app auto-updater yet.

## The problem

A Chromecast is fussy. It plays a narrow set of codec/container combinations and
gives you almost nothing when it refuses — the TV sits on a spinner and no error
reaches you. Most local media does not fit: MKV containers, DTS or TrueHD audio,
5.1 tracks, HEVC, subtitle formats the receiver has never heard of.

The usual answers are to transcode the whole file in advance, or to run a full
media server. castgorilla does neither. It probes the file, decides the cheapest
legal delivery for the specific device in front of it, and streams that.

## The four-tier pipeline

Every play goes through the same four stages:

1. **Probe** — `ffprobe` produces a typed `MediaInfo`: container, video and audio
   streams, subtitle tracks, HDR metadata. For copy tiers a keyframe index is
   extracted too, so segments can be cut on real keyframes.
2. **Decide** — a *pure* function, `buildPlaybackPlan(media, profile, prefs)`, with
   no I/O. It picks a tier and records a human-readable `reasons[]` trail for
   every branch it took.
3. **Serve** — a local HTTP server on the LAN interface that faces the device.
   Direct play is served with byte-Range support; HLS tiers are served as a
   synthesised VOD playlist backed by an on-demand ffmpeg process.
4. **Cast** — a CASTV2 client (over the `castv2` package) launches the Google Cast
   **Default Media Receiver** and drives it with typed LOAD / PLAY / PAUSE / SEEK
   messages, with heartbeat and reconnect handling.

The four tiers the planner chooses between, cheapest first:

| Tier | What happens | Typical trigger |
|---|---|---|
| **direct** | Original file streamed as-is over HTTP Range | H.264 or HEVC in MP4 with AAC/MP3/AC-3/E-AC-3 audio |
| **remux** | Both streams copied, repackaged into HLS segments | H.264 + AAC inside an MKV |
| **audio-transcode** | Video copied, audio re-encoded (`aac_at`) | DTS/TrueHD/FLAC audio, or >2ch AAC |
| **video-transcode** | Video re-encoded (`h264_videotoolbox`), audio as needed | HEVC on an HLS tier, an unsupported profile/level, or a resolution above the device's ceiling |

The tiers exist so the expensive one is rare. Re-encoding video costs CPU and
throws away quality; the planner will do it, but only after copy paths have been
ruled out for a stated reason. `castgorilla probe <file>` prints the plan and its
reasons without casting anything, which is the fastest way to understand a
decision.

Device capabilities come from a table in
`packages/engine/src/devices/profiles.ts`, keyed by the mDNS `md` model string:
`gen1`, `gen2`, `gen3`, `ultra`, `ccgtv`, `gtv-streamer`, `shield`, and a
conservative `unknown` fallback for anything unrecognised.

## Two constraints worth knowing before you fork this

Both were expensive to find. Neither is obvious from the Cast documentation.

### HLS segments are MPEG-TS, never fMP4

fMP4 (CMAF) is the modern choice and it does **not** work. The Google Cast
Default Media Receiver accepts the LOAD, fetches the playlist twice, the init
segment once and roughly three media segments — every request HTTP 200, zero
errors — and then goes silent. It never emits `BUFFERING` or `PLAYING`, nothing
renders on screen, and a follow-up `STOP` times out after 5 seconds. The
receiver is wedged, with no error code anywhere.

The control that settles it uses **Apple's own reference streams**, with none of
our code in the loop:

- fMP4 — `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8` → wedges
- MPEG-TS — `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8` → plays

Same device, same session, same network. The TS row proves the device's internet
worked, so the fMP4 failure is real; and if Apple's reference fMP4 cannot play,
no fMP4 anyone muxes will either. Reproduced identically on an NVIDIA Shield TV
and a Chromecast HD.

So `resolveSegmentFormat()` emits TS unless a device profile *positively proves*
fMP4 support. An untested profile gets TS — "untested" is not "probably fine".
The fMP4 code paths are still there, for a future custom receiver.

### HEVC never stream-copies on an HLS tier

HEVC cannot ride MPEG-TS to this receiver either. ffmpeg muxes HEVC into mpegts
happily, and the Shield rejected the result explicitly — `playerState: IDLE`,
`idleReason: ERROR`, about 0.6s after LOAD. Combined with the constraint above,
there is no HLS segment format that will carry HEVC.

The consequence: **any HEVC file that cannot direct-play is fully re-encoded to
H.264.** HEVC inside a Cast-legal MP4 still direct-plays untouched, so this bites
the HLS tiers only — but for an HEVC-heavy library that is most of it. A custom
Cast receiver is the only known route back to HEVC stream-copy, and it is
untested.

## Status

**Working and verified on real hardware** (macOS, Apple Silicon, ffmpeg 8.1.1
from Homebrew), each result confirmed by a human watching the TV rather than
inferred from a log:

- All four tiers play on an **NVIDIA Shield TV** and on a **Chromecast HD**.
- Real-world media, not just synthetic fixtures: a 7.9 GB 1080p H.264 MKV
  (1h50m, E-AC-3 5.1, 5 subtitle tracks) on the audio-transcode tier, and a
  1080p HEVC Main 10 MKV (49 min, AC-3 5.1) on the video-transcode tier.
- Seek-restart on the transcode tier, driven from the TV remote — a mid-file
  seek costs about the same as a cold start.
- Sidecar and embedded subtitles converted to WebVTT and pulled by the device.
- Recovery after the host Mac sleeps: the session reconnects and re-LOADs at the
  last observed position.

**Not done, or not verified:**

- **macOS only.** The pipeline depends on VideoToolbox (`h264_videotoolbox`) and
  AudioToolbox (`aac_at`) encoders. Only Apple Silicon has been tested.
- **AirPlay is not implemented** — Chromecast-class devices only.
- **No tone-mapping.** The reference ffmpeg build has no `zscale`/`libplacebo`,
  so HDR-to-SDR conversion is impossible. HDR content on an SDR path is either
  warned about or blocked, by policy (`--hdr warn|block`).
- **Surround passthrough (`--surround`) has never run on real hardware.** The
  default downmixes 5.1 to stereo.
- **Image-based subtitles (PGS, VobSub) are unsupported** — no OCR.
- **Device profiles are incomplete.** Several capability fields are still
  `'untested'`, and per-device codec/level limits have not been characterised.
  See `docs/G1-hardware-gate.md`.
- **Official DMG (1.0.0)** is Developer ID signed and notarized (arm64), with
  bundled LGPL ffmpeg. It is distributed via Gumroad after a hardware
  verification gate — not via GitHub Releases. See
  [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) and
  `docs/release-1.0.0-handoff.md`.
- **No in-app auto-update** yet; Gumroad buyers re-download new versions.
- Sustained seek-scrub on the video-transcode tier is fixed in code and awaits
  final hardware confirmation from the packaged app.
- Known open issues are tracked in `CLAUDE.md` under "Next milestones".

## Requirements

- **macOS.** Verified on Apple Silicon (macOS Sequoia).
- **Node.js >= 24** (for building from source / CLI).
- **ffmpeg** — depends on how you run it:
  - **Official Cast Gorilla app (Gumroad DMG):** ships a bundled static LGPL
    ffmpeg/ffprobe. No Homebrew required on the user's machine.
  - **CLI and contributor builds:** need **ffmpeg >= 8 on your PATH**, built
    with VideoToolbox and AudioToolbox — the engine requires
    `h264_videotoolbox`, `hevc_videotoolbox`, `aac_at` and `eac3` and fails with
    a single clear message if any is missing. `brew install ffmpeg` provides
    these.
- A Chromecast-class device on the same LAN as the Mac.

Binary resolution order is: `CASTGORILLA_FFMPEG` / `CASTGORILLA_FFPROBE`
environment overrides, then `PATH`, then `/opt/homebrew/bin`. The packaged app
sets the env overrides to the bundled binaries when `app.isPackaged`.

macOS Sequoia gates local-network access per application. A CLI run from
Terminal inherits Terminal's grant; the packaged app prompts for its own on
first device discovery.

## Build and run

```bash
git clone <repo-url> castgorilla
cd castgorilla
npm install
npx tsc -b            # build the engine + CLI
```

### CLI

The workspaces are unpublished, so run the CLI through its bin script:

```bash
node packages/cli/bin/castgorilla.js devices
node packages/cli/bin/castgorilla.js probe <file>
node packages/cli/bin/castgorilla.js play  <file> --device <name>
```

```
castgorilla devices [--json] [--timeout <sec>]
castgorilla probe <file> [--device <name>] [--surround] [--hdr warn|block] [--json]
castgorilla play  <file> --device <name|host> [--surround] [--hdr warn|block]
                        [--audio <idx>] [--start <mm:ss|sec>] [--volume <0..1>]
                        [--sub <auto|none|trackId|path>]
```

During `play`: `space` pause/resume, `←`/`→` ±10s, `↑`/`↓` volume ±5%, `m` mute,
`g` seek to a timecode, `s` subtitle track, `a` audio track, `q` quit.
`--device` also accepts a bare IPv4 address, which casts directly using the
conservative `unknown` profile.

Exit codes: `0` clean, `1` error, `2` the planner refused (`PlanRefusedError`).

### Desktop app

**End users:** install the official **Cast Gorilla** DMG from Gumroad
(`YOUR_GUMROAD_PRODUCT_URL`). That build is signed, notarized, and includes
ffmpeg. Approve the local-network prompt on first launch or discovery will find
nothing.

**Contributors** (local unsigned / ad-hoc packaging):

```bash
bash scripts/build-ffmpeg.sh                      # static LGPL → vendor/ (required for a real packaged app)
npm run build -w packages/app
cd packages/app && npx electron-builder --dir     # → release/mac-arm64/Cast Gorilla.app
```

Copy into `/Applications` if you need a realistic TCC path. Without your own
Developer ID + notarization, Gatekeeper will treat it as an unsigned local
build. Official shipping steps: [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)
and `CLAUDE.md` → RELEASE PACKAGING.

`CASTGORILLA_MOCK=1` forces a canned mock engine — useful for UI work with no
devices or media around. The app falls back to the mock (with a visible MOCK MODE
badge) rather than crashing if the real engine cannot load.

### A short session

```console
$ node packages/cli/bin/castgorilla.js devices
NAME            MODEL          PROFILE  HOST
Example TV      Chromecast HD  gen2     192.168.1.50:8009

$ node packages/cli/bin/castgorilla.js probe ~/Movies/example.mkv --device "Example TV"
File:      example.mkv
Container: mkv   Duration: 1:42:11
Video [0]: h264 High 1920x1080 23.976fps 8-bit
Audio [1]: eac3 5.1 (6ch)  *default
Sub   [2]: subrip text — eng

Plan:  HLS (ts)   tier=audio-transcode
  video:   copy  [stream 0]
  audio:   transcode aac_at 192k 2ch  [stream 1]
  segments: keyframe @ 6s
  content-type: application/vnd.apple.mpegurl
  HDR: none
  reasons:
    - ...
    - method: HLS (ts, audio-transcode)

$ node packages/cli/bin/castgorilla.js play ~/Movies/example.mkv --device "Example TV"
```

The layout above is the real output shape; the values are a plausible file, not
a captured transcript. `probe --json` emits the same information in a stable
machine-readable form.

## Repo layout

npm workspaces, TypeScript strict ESM (`.js` import extensions throughout).

```
packages/engine   the whole product as a library, zero UI dependencies
  types/          frozen contract layer
  probe/          ffprobe -> MediaInfo, keyframe index
  decide/         the pure planner (video/audio/container rules)
  devices/        mDNS discovery + the device capability table
  cast/           CASTV2 client, typed channels, heartbeat, reconnect
  ffmpeg/         binary resolution, pure argv builders, process management
  hls/            synthetic VOD playlist + on-demand segment session
  server/         Range/CORS media server
  subtitles/      sidecar + embedded subtitles -> WebVTT
  session/        PlaybackSession state machine, createEngine()
  mock/           MockEngine with canned data
packages/cli      devices / probe / play, with interactive playback keys
packages/app      Electron shell; engine coupling lives only in
                  src/main/engine-host.ts
scripts/          fixture generation and real-device spike tools
docs/             hardware runbook, distribution protocol (DISTRIBUTION.md)
```

The engine has three runtime dependencies (`castv2`, `bonjour-service`, `zod`)
and exports everything through a single entry point — the CLI and app never
reach into subpaths.

`CLAUDE.md` is the project's engineering log: the working agreement, the hardware
testing protocol, the full debugging narrative behind the two constraints above,
and a list of hard-won ffmpeg and Cast behaviours that should not be
"simplified" away.

## Tests

```bash
npx vitest run                        # 37 test files across engine + app
npx tsc -b                            # typecheck engine + cli
npm run typecheck -w packages/app     # the app is outside the project-reference graph
```

Vitest. No Chromecast is required — the cast transport, mDNS discovery and
ffmpeg process management are all tested against fakes. A few suites do need a
real ffmpeg: `ffmpeg.test.ts` asserts the encoder set on your machine, and
`fixtures.test.ts` runs `scripts/gen-fixtures.sh` and ffprobes the results, which
is slow on a cold run. Test files are named `<area>-*.test.ts` and live in
`packages/engine/test/` and `packages/app/test/`.

Synthetic test media (`fixtures/`, gitignored) is regenerated with
`bash scripts/gen-fixtures.sh`. Fixtures carry NATO codenames — `alpha`, `delta`,
`lima` — because filenames like `mp4-h264-aac.mp4` and `mp4-h264-aac51.mp4` are
indistinguishable when read aloud, which once cost a whole debugging session.

## Licence

MIT. See [LICENSE](LICENSE).

The **official** Cast Gorilla DMG ships a static **LGPL** ffmpeg/ffprobe with
licence notices inside the bundle (`Contents/Resources/ffmpeg/`). Contributor /
CLI builds that shell out to Homebrew (or another) ffmpeg are your
responsibility for that binary's licence.

**Cast Gorilla** (name and icon) identifies the official product. MIT covers the
software; it does not grant trademark rights to the name or branding. See
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).
