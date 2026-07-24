# Cast hardware spikes (G1 gate)

Throwaway scripts for validating the cast stack against **real** Chromecast
hardware. They are not part of the shipped engine — they drive the compiled
engine (`packages/engine/dist`) directly. A human runs these on a Mac that is on
the **same LAN/VLAN** as the target device.

> Build first — the spikes import the compiled engine:
> ```
> npm run build
> ```
> All three scripts support `--help` and run standalone via `node` (no tsx / no
> extra deps).

## The scripts

| Script | What it does |
| --- | --- |
| `static-server.mjs` | Throwaway HTTP file/dir server with **Range** + permissive **CORS** (answers `OPTIONS`). Used to serve a local file or an HLS output dir to the device. **Not** the engine server. |
| `spike-basic.mjs` | Discover + list devices (model + resolved profile); with `--device`, connect → launch DMR → LOAD → report state transitions → optional `--seek` after 10s → STOP. General smoke test. |
| `spike-load.mjs` | LOAD an arbitrary URL with explicit `--content-type` / `--hls-segment-format` / `--hls-video-segment-format`, print the **full MEDIA_STATUS** and **any error payload verbatim**. This is the G1 gate tool. |
| `spike-hls-selftest.mjs` | **No device needed.** Stands up the real `MediaServer` + `HlsSession` for a file, acts as the HLS client itself over `127.0.0.1`, and validates the output (ffprobe + an ffmpeg decode pass, plus init-stability and boundary-drift checks). Answers "is *our* stream valid?" independently of any receiver. |

## Typical flow

1. Find your Mac's LAN IP and start the file server (pick a folder or file):
   ```
   node scripts/spikes/static-server.mjs --dir /path/to/hls-out --port 8010
   # prints e.g. http://192.168.1.23:8010/<path-under-dir>
   ```
2. List devices and confirm the profile mapping:
   ```
   node scripts/spikes/spike-basic.mjs
   ```
3. Drive a device end-to-end (uses a public sample MP4 if you omit `--url`):
   ```
   node scripts/spikes/spike-basic.mjs --device "Living Room" --seek 120
   ```

## Device-free: is our own HLS stream valid?

Everything above needs hardware, which confounds two variables at once: *is our
HLS output valid?* and *does this receiver accept it?* `spike-hls-selftest.mjs`
settles the first question on its own — no Chromecast in the room.

```
node scripts/spikes/spike-hls-selftest.mjs --file fixtures/lima_mp4-h264-aac51.mp4
node scripts/spikes/spike-hls-selftest.mjs --file <f> --profile ultra --segments 5
node scripts/spikes/spike-hls-selftest.mjs --file <f> --keep --no-validate
```

| Flag | |
| --- | --- |
| `--file <path>` | (required) media file to run through the pipeline |
| `--profile <key>` | profile to plan against — default `unknown`, which is what an NVIDIA Shield's mDNS `md` resolves to |
| `--segments <n>` | segments to fetch (default 3) |
| `--keep` | leave the fetched bytes on disk for inspection |
| `--no-validate` | skip the ffmpeg decode pass |

It probes the file, builds the plan with the engine's own `buildPlaybackPlan`
(**bails** if the plan is direct play — nothing to test), wires up `MediaServer`
+ `HlsSession` exactly the way `PlaybackSessionImpl.prepare()` does, then plays
client:

- prints the synthesized playlist **verbatim**;
- fetches `init.mp4` + `seg0…segN` and prints status / content-type / bytes /
  **latency** for each — the seg0 number is what tells you whether a device would
  starve waiting for the first segment;
- ffprobes the *fetched* bytes (`init.mp4`, and `init.mp4 + seg0` joined, since a
  bare fMP4 fragment is not parsable alone);
- **init stability**: `init.mp4` is not written atomically and
  `HlsSession.fileReady()` only guards `size > 0`, so it stats the on-disk init
  twice a beat apart at first-fetch time and flags a partially-written init;
- **boundary drift**: compares each advertised `#EXTINF` (from `computeBoundaries`
  on the keyframe index) against the segment ffmpeg actually cut (`-hls_time`),
  flagging deltas over 0.1s — drift there desyncs the advertised timeline from
  the media on a video-copy tier;
- runs `ffmpeg -i <playlist-url> -t 20 -f null -` against the served playlist and
  prints ffmpeg's stderr verbatim on failure. This is the single strongest signal
  that the stream is well-formed.

Exit `0` = PASS, `1` = a fetch/validation failure or flagged drift, `2` = usage
error or a direct-play plan. The `HlsSession` is always disposed (ffmpeg killed,
work dir removed) — on success, failure and Ctrl-C alike.

## The two hardware-gate questions

### R1 — HEVC-in-HLS on Ultra / Chromecast with Google TV
Serve an HLS master that references HEVC segments, then:
```
node scripts/spikes/spike-load.mjs --device Ultra \
  --url http://192.168.1.23:8010/hevc/master.m3u8 \
  --content-type application/vnd.apple.mpegurl \
  --hls-segment-format FMP4 --hls-video-segment-format FMP4
```
- **Plays** (MEDIA_STATUS reaches `PLAYING`) → `hevcInHls: true` for that profile.
- **LOAD_FAILED / ERROR** → capture the printed `detailedErrorCode` + `reason`
  verbatim; that's the evidence to set `hevcInHls: false`.

Repeat on **Chromecast with Google TV** (`ccgtv`).

### R2 — fMP4 vs TS segments on gen2 / gen3
Serve the same content packaged two ways and compare on a **gen2/gen3** device:
```
# fMP4 (CMAF)
node scripts/spikes/spike-load.mjs --device Chromecast \
  --url http://192.168.1.23:8010/fmp4/master.m3u8 \
  --content-type application/vnd.apple.mpegurl \
  --hls-segment-format FMP4 --hls-video-segment-format FMP4

# TS fallback
node scripts/spikes/spike-load.mjs --device Chromecast \
  --url http://192.168.1.23:8010/ts/master.m3u8 \
  --content-type application/vnd.apple.mpegurl \
  --hls-segment-format TS_AAC --hls-video-segment-format MPEG2_TS
```
- Whichever reaches `PLAYING` cleanly informs `fmp4` and `segmentFormatFallback`
  in the device profile (`packages/engine/src/devices/profiles.ts`).

## Recording results

`spike-load.mjs` prints the exact `LoadMediaInformation` it sent, the full
`MEDIA_STATUS`, and any error payload. Paste those blocks into the gate notes so
the `hls` fields in each `DeviceProfile` can move off `'untested'` with a source.
