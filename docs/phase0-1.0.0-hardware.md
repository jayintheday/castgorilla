# Phase 0 hardware — Cast Gorilla 1.0.0 (2026-07-24)

Written for the next agent. Self-contained. Human eyes + INFO log from the
packaged app. Full packaging context: `CLAUDE.md` → RELEASE PACKAGING,
`docs/release-1.0.0-handoff.md`, `docs/DISTRIBUTION.md`.

**Session log (may still be on disk):** `/tmp/cg-1.0.0.log`  
**Launch used:** `open --stdout /tmp/cg-1.0.0.log --stderr /tmp/cg-1.0.0.log "/Applications/Cast Gorilla.app"`  
**Note:** INFO only — no per-request MediaServer lines, no `playerState`. Do not
infer on-screen state from this log alone.

---

## 1. Verdict (read this first)

| Gate | Result |
|---|---|
| Signed 1.0.0 app on real engine (`[engine-gate] {"mock":false}`) | **PASS** |
| Local Network TCC after Developer ID | **Needed a grant** (devices empty until Allow); then OK |
| Test A — bundled ffmpeg (Homebrew `ffmpeg`/`ffprobe` renamed away) | **PASS** |
| Cast real HEVC on **SHIELD** (`video-transcode` HLS TS) | **PASS** (human: video playing) |
| Sustained scrub (~11 seek-restarts) | **PARTIAL FAIL** — see §3 |
| Recovery | **Small nudge resumed**; then kept playing without new ffmpeg launches in the INFO log |

**Ship implication:** Gumroad / “plays from official DMG” is justified. Do **not**
claim scrub-safe. Segment-numbering drift fix (`d498b13`) is in this build but
**did not fully clear** the seek-storm symptom on this run (symptom shape changed:
frozen frame + spinner, not backdrop).

---

## 2. Environment

- **App:** `/Applications/Cast Gorilla.app` — 1.0.0, Developer ID `Intheday Ltd
  (29UYFH4USR)`, same build as `packages/app/release/mac-arm64/Cast Gorilla.app`.
- **Old ad-hoc** `/Applications/castgorilla.app` was removed before the run.
- **Device:** **SHIELD** (`shield` profile). Human watched this device only.
- **File:** real-library **1080p HEVC (H.265) MKV**, multichannel surround audio
  (downmixed per default prefs). Titles/paths intentionally omitted — record
  codec/container characteristics only. Plan: `tier=video-transcode method=hls
  segFmt=ts`.
- **seg0 latency:** +1223ms after ffmpeg launch.
- **Branch at time of test:** `release/1.0.0` (docs/distribution work may be
  uncommitted on top — check `git status`).

CLI `devices` still saw SHIELD + the Chromecast HD (`gen2`) when the app showed
none → network fine; app-only TCC.

---

## 3. Scrub failure (the open bug for the next agent)

### On screen (authoritative)

After a burst of timeline jumps (~15–20, mixed forward/back):

1. Video stopped around **50:30** (UI/remote).
2. **Frozen frame + spinner** (not Chromecast backdrop / home).
3. A **small nudge** (±10s class) **resumed** playback.
4. Playback continued for several minutes afterward.

### In the INFO log (supporting)

Honest seek-restart count = ffmpeg launches that served a live request after
cold start = **11** (do **not** use `grep -c start_number`):

| UTC | Launch |
|---|---|
| 10:15:38 | seg0 (cold) |
| 10:17:37–10:18:50 | seg205, 277, 154, 303, 370, 191, 264, 401, 179, 274, **379** |

Every restart: seg ready ~**1100–1170ms**. **Zero** ERROR/WARN lines in this log.

Last lines:

```
10:18:50  ffmpeg launched: run@seg379 (t=3035.032s, …)   # ≈ 50:35
10:18:51  seg379 ready +1130ms
10:19:28  ffmpeg run@seg379 exited cleanly after 37482ms
```

Then **silence**. No further launches. While the TV was spinning, and later while
it was playing again after the nudge, the INFO log did **not** grow and **no
ffmpeg process** was observed. Post-nudge play was almost certainly from
**segments already on disk** from the seg379 run (or receiver buffer) — not a
fresh encode visible at INFO.

### How this differs from older seek-storm reports

| | Older runs (`docs/seek-restart-storm.md`) | This 1.0.0 packaged run |
|---|---|---|
| On screen | Often Chromecast backdrop / quit | **Frozen frame + spinner** |
| Recoverable? | Often needed full re-LOAD / new session | **Small seek nudge resumed** |
| Host log | Varied; sometimes looked “healthy” | All restarts clean; then idle |
| Build | Pre- / mixed with drift fix | **First DMG containing `d498b13`** + bundled LGPL ffmpeg 8.1.2 |

### Hypotheses for the next investigator (do not assume)

1. **Segment-drift fix incomplete / different failure** — variable keyframe
   segments + `-hls_time 5.9` still stress the Default Media Receiver under burst
   seek (`docs/segment-numbering-drift.md`). Byte-level fix ≠ receiver cured.
2. **Starvation after last run exits** — ffmpeg exits “cleanly” after ~37s of
   ahead work; if the receiver stalls mid-GOP / mid-buffer and stops requesting,
   the host never relaunches until a new seek forces a segment miss.
3. **COPY-tier drift is unrelated here** — this file was **video-transcode** only.
4. **Logging gap** — reproduce with `LOG_LEVEL=debug` so MediaServer request
   lines and cast status appear; INFO alone cannot show whether the Shield kept
   fetching 200s while spinning.

### Reproduction protocol (next run)

Per `CLAUDE.md` hardware protocol — one variable, human at **named** device:

1. Packaged 1.0.0 app (or newer), `LOG_LEVEL=debug`, stdout to a file.
2. Same class of file: HEVC → `video-transcode` on **SHIELD**.
3. Play until stable; then **N** seeks (try N=5, then N=10 — don’t only do 15+).
4. After stall: note timecode, on-screen state, whether one nudge recovers.
5. Correlate debug HTTP + `playerState` with the last `ffmpeg launched` line.
6. Ask the human what is on **SHIELD** before reading the log as truth.

Related docs: `docs/seek-restart-storm.md` (symptom/protocol/killed hypotheses),
`docs/segment-numbering-drift.md` (drift fix + open COPY-tier §9.4).

---

## 4. What Phase 0 closed

- First **cast from the notarized 1.0.0 / Developer ID** app (post-rename era).
- **Bundled ffmpeg independence** proven (Homebrew renamed during probe+cast).
- Local Network TCC under new signature: expect prompt / Settings toggle.
- Distribution policy (Gumroad-only binaries) is documented; Phase 0 play gate is
  satisfied for upload. Scrub caveat should be honest in release notes if any.

---

## 5. Suggested next work (priority)

1. **Product/ship:** merge `release/1.0.0` → `main`, tag `v1.0.0` (source only),
   upload DMG to Gumroad; replace `YOUR_GUMROAD_PRODUCT_URL` in README /
   `docs/DISTRIBUTION.md`. Optional: note known scrub limitation.
2. **Bug session:** debug-logged scrub repro (§3) — determine if failure is
   receiver stall without host relaunch, residual drift, or new `-hls_time 5.9`
   behaviour.
3. **Do not** close seek-storm / milestone “scrub verified” until a burst scrub
   ends with sustained play **without** needing a recovery nudge — or the
   failure is understood and accepted as known limitation.
4. Unrelated backlog unchanged: latent bugs, COPY-tier §9.4, custom receiver,
   `--surround`, etc. (`CLAUDE.md` → Next milestones).
