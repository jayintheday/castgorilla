# Test fixtures

Synthetic media used by the engine's integration tests. **These files are
git-ignored** (they are large and reproducible) — everything here except this
README is generated on demand.

## Codenames

Every fixture carries a **spoken-word NATO codename prefix**. The descriptors
alone are near-identical by design (`mp4-h264-aac.mp4` vs `mp4-h264-aac51.mp4`),
which is fine on screen and useless out loud. During a hardware test session you
report results by codename — *"delta played, lima hung"* — with no ambiguity
about which file you meant.

| Codename    | File                                 | What it proves                                                |
| ----------- | ------------------------------------ | ------------------------------------------------------------- |
| **alpha**   | `alpha_mp4-h264-aac.mp4`             | **direct play** (video/mp4 over Range) — the no-ffmpeg path   |
| bravo       | `bravo_mp4-h264-aac-nofaststart.mp4` | same, moov at END (no faststart) — progressive-download case   |
| **charlie** | `charlie_mp4-h264-l51-4k.mp4`        | **HLS video-transcode** — 4K H.264 (L5.1) downscaled to 1080p |
| **delta**   | `delta_mkv-h264-aac.mkv`             | **HLS remux** — mkv is never direct; copy+copy into fMP4      |
| echo        | `echo_mkv-h264-dts.mkv`              | DTS (DCA) 5.1 — never decoded by Cast; forces audio transcode  |
| foxtrot     | `foxtrot_mkv-h264-dts-45min.mkv`     | 45-min variant of echo (long-content + seek-restart path)      |
| golf        | `golf_mkv-h264-ac3.mkv`              | AC-3 5.1 (passthrough-eligible)                                |
| hotel       | `hotel_mkv-hevc10-truehd.mkv`        | HEVC Main10 (BT.2020/PQ HDR10) + TrueHD 5.1                    |
| india       | `india_webm-vp9-opus.webm`           | VP9 + Opus (Opus NOT decoded by video Chromecasts)             |
| juliett     | `juliett_webm-vp8-vorbis.webm`       | VP8 + Vorbis (stereo)                                          |
| kilo        | `kilo_mkv-hevc8-aac.mkv`             | HEVC 8-bit (Main) + AAC                                        |
| **lima**    | `lima_mp4-h264-aac51.mp4`            | **HLS audio-transcode** — multichannel AAC (never copied)     |
| mike        | `mike_mkv-h264-subs.mkv`             | embedded SRT + ASS subtitle streams (+ two sidecars)           |
| november    | `november_mkv-h264-longgop.mkv`      | H.264 with 10s GOPs (keyframe-segmentation stress)             |
| oscar       | `oscar_avi-mpeg4-mp3.avi`            | MPEG-4 Part 2 + MP3 in AVI (video-transcode, fixed grid)       |
| quebec      | `quebec_mkv-h264-23976fps.mkv`       | **fractional frame rate** (24000/1001) — boundary quantisation |

`mike` also ships two sidecar subtitle files. They **must** keep tracking the
video's basename — sidecar discovery matches on it:

| File                        | What it proves                     |
| --------------------------- | ---------------------------------- |
| `mike_mkv-h264-subs.srt`    | sidecar subtitle (no language tag) |
| `mike_mkv-h264-subs.en.srt` | sidecar subtitle (English)         |

### The four tiers, one file each

The planner has four outcomes. These are the files to reach for when you want to
exercise each one end-to-end on real hardware — `lima` and `charlie` are the two
that hang on the NVIDIA Shield (OPEN BUG #1 in `CLAUDE.md`), so this set puts a
known-good and a known-bad on either side of the transcode boundary:

| Tier                | Codename    | Also covered by     |
| ------------------- | ----------- | ------------------- |
| direct play         | **alpha**   | bravo               |
| HLS remux           | **delta**   | —                   |
| HLS audio-transcode | **lima**    | echo, golf, foxtrot |
| HLS video-transcode | **charlie** | oscar, india        |

## Generating

```sh
bash scripts/gen-fixtures.sh      # or: npm run fixtures
```

The script is **idempotent**: it skips any fixture that already exists, prints a
summary table, and exits non-zero if any generation fails. Delete a file (or the
whole `fixtures/` directory) to force regeneration.

It also carries a **legacy-rename shim** that migrates pre-codename fixtures
(`mp4-h264-aac.mp4` → `alpha_mp4-h264-aac.mp4`) in place, so an existing
`fixtures/` directory keeps its exact bytes instead of re-encoding ~1.4 GB. The
shim is marked removable after one migration cycle.

Source: everything is built from ffmpeg `testsrc2` video + a `sine` tone. Audio
channel counts / layouts and video color metadata are forced to match what each
fixture is meant to prove. Durations are 60s unless noted.

## Known gaps / notes

- **Dolby Vision profile 8 (`dv-p8`) is intentionally absent.** There is no
  free/synthetic way to mint a real DoVi RPU-bearing sample with the Homebrew
  toolchain — it must be an *acquired real sample*. Drop a real
  `papa_dv-p8.<ext>` here when one is available (next free codename: **papa**)
  and wire it into the DoVi tests then.

- **`quebec` is the only fixture at a non-integer frame rate, and that is the
  whole point.** Everything else runs at 30fps, where a 6s segment boundary
  always coincides with a frame — which silently hid a real effect for the
  entire segment-numbering-drift investigation. At 24000/1001 *no* multiple of 6
  lands on a frame, so a boundary taken from a fixed grid is not reachable and
  ffmpeg emits the first frame after it instead. `-g 96` (4.004s) with scene
  detection off makes the keyframe grid exactly `4.004·k`, so a test can assert
  boundary times to the millisecond. See `docs/segment-numbering-drift.md` §9.5
  — and do not use a 30fps fixture to check any claim about boundary exactness.

- **`lima` AAC layout:** AAC in MP4 normalizes multichannel to plain `5.1` (rear),
  so `channel_layout` reads `5.1`, not `5.1(side)`. The `5.1(side)` tag does not
  survive the AAC/MP4 round-trip on ffmpeg 8.1.1; the fixture is generated as
  standard `5.1`. (DTS/TrueHD in Matroska *do* keep `5.1(side)`.)

- **No x265 / no libvorbis in Homebrew ffmpeg 8.1.1.** HEVC fixtures are encoded
  with `hevc_videotoolbox` (hardware); Vorbis uses the native experimental
  encoder (`-strict -2`, stereo only). DTS/TrueHD also require `-strict -2`.
