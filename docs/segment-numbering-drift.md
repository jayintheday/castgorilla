# Segment-numbering drift — a seek-restart can serve segment N with segment N+1's content

**Status:** FIXED IN CODE, **NOT yet verified on hardware.** Direction 2 (keyframe-align
the transcode grid) landed 2026-07-23 with unit + integration coverage that fails
against the previous engine. Whether it cures the receiver's death under sustained
scrubbing is unknown until a human watches a TV — see §8.
**Opened:** 2026-07-23, from the third hardware run of the seek-restart storm.
**Scope:** `packages/engine` — ffmpeg arg building + boundary selection. Not a server issue.
**Tier affected:** `video-transcode` only (see §5). That is the tier the maintainer's
HEVC-heavy library always plans, and the tier of all three hardware failures.

> §1–§5 are the original diagnosis and are unchanged. §6 records which fix
> direction was taken and why. **§9 is new and is the part to read before
> touching any of this again**: it holds the ffmpeg behaviour the fix depends
> on, all of it measured on this machine, plus one bug the investigation
> uncovered in the COPY tiers that is deliberately left open.

> This is the root cause the seek-restart storm investigation was circling.
> `docs/seek-restart-storm.md` is the parent document; read §3 of it for the failure
> symptom and §6 for the (real, but non-curative) fix that preceded this finding.

---

## 1. The claim

On the `video-transcode` tier, boundaries are a **fixed 6 s grid** that has nothing to
do with the source's keyframes. A seek-restart runs ffmpeg with `-ss <boundary+0.25>
-noaccurate_seek`, which snaps **backwards to the preceding source keyframe**. The HLS
muxer then numbers the first emitted segment `-start_number <boundaryIndex>`.

So the first segment of every restart is labelled as if it began at its boundary, while
it actually begins at the keyframe before it. When two adjacent boundaries fall inside
the **same source GOP**, two different restarts produce **byte-identical video under
different segment numbers** — a full 6-second shift in what the receiver believes it is
playing.

Because segments are written into a shared work dir, a later restart **overwrites**
earlier segments with content 6 s later. The same segment number therefore holds
different media time depending on which run last wrote it, and a receiver that caches
segments across seeks ends up with overlapping and duplicated PTS ranges.

---

## 2. The reproduction (run it, it takes 60 seconds)

Source: a 1080p HEVC Main 10 MKV, ~978 MB, planned as `video-transcode` / `segFmt=ts`.
Both commands are the engine's own argv, copied verbatim from the failing session log —
only `-ss` and `-start_number` differ, and they differ **consistently** (boundary 353 =
2118 s, boundary 354 = 2124 s, `SEEK_EPSILON_SEC` = 0.25).

```bash
# Run A — restart at boundary 354
ffmpeg -y -ss 2124.25 -noaccurate_seek -copyts -start_at_zero -avoid_negative_ts disabled \
  -i <source> -map 0:0 -map 0:1 -c:v h264_videotoolbox -q:v 50 \
  -force_key_frames expr:gte(t,n_forced*6) -g 240 -c:a aac_at -b:a 192k -ac 2 \
  -af channelmap=channel_layout=5.1 -sn -dn -f hls -hls_segment_type mpegts -hls_time 6 \
  -hls_list_size 0 -hls_segment_filename seg%d.ts \
  -hls_flags independent_segments+temp_file -start_number 354 playlist.m3u8

# Run B — restart at boundary 353, into a DIFFERENT directory
#   ...identical except:  -ss 2118.25  ...  -start_number 353
```

### What comes out

| | run A (`-ss 2124.25`, `start_number 354`) | run B (`-ss 2118.25`, `start_number 353`) |
|---|---|---|
| 1st segment | `seg354.ts` 882848 B | `seg353.ts` 882848 B |
| 2nd | `seg355.ts` 979292 B | `seg354.ts` 979292 B |
| 3rd | `seg356.ts` 1151876 B | `seg355.ts` 1151876 B |
| 4th | `seg357.ts` 1032684 B | `seg356.ts` 1032684 B |
| … | … | … |

The whole sequence is the same, shifted by one index. Verified stronger than by size:

```
md5:  runB/seg354 == runA/seg355   IDENTICAL
      runB/seg355 == runA/seg356   IDENTICAL
      runB/seg360 == runA/seg361   IDENTICAL
      runB/seg370 == runA/seg371   IDENTICAL
```

And the timestamps say the same thing:

```
playlist declares   seg353 starts at 2118.000   seg354 starts at 2124.000
actual first PTS    runA/seg354 = 2117.180333   <- 6.8s EARLIER than declared
                    runB/seg353 = 2117.180333   <- same content, different number
                    runB/seg354 = 2123.186333
actual duration     runA/seg354 = 6.278322s     (EXTINF claims 6.000000)
```

**`runA/seg354` and `runB/seg353` are the same video.** Whichever run wrote last decides
what segment number 354 contains.

### Why both runs land in the same place

Source keyframes around the failure point, from `ffprobe -skip_frame nokey`:

```
… 2097.345  2102.309  2105.353  2117.180  2126.207  2132.005  2133.506  2139.304 …
```

`-noaccurate_seek` snaps to the preceding keyframe. `2118.25 → 2117.180`. And
`2124.25 → 2117.180` as well, because the next keyframe is not until 2126.207. Two
boundaries, one GOP, one starting point, two numbers.

(The 2123.186 keyframe in run B's `seg354` is an **encoder-forced** keyframe from
`-force_key_frames`, not a source keyframe — do not mistake it for one when re-deriving
this.)

---

## 3. How often it fires

Sampled over a 600 s window of the same source:

| Measure | Value |
|---|---|
| source GOP length | mean **4.8 s**, max **20.9 s** |
| 6 s boundaries in the window | 100 |
| …landing on the **same keyframe as the previous boundary** | **17 (17%)** |

So roughly **one in six** seek-restarts on this content produces a whole-segment
collision. That is the extreme case; the milder one is universal — with an irregular
GOP and a fixed grid, the first segment of *every* restart starts early of its declared
boundary, by up to a full GOP (20.9 s on this file).

---

## 4. Why this explains "dies while being served correctly"

The parent document's §3.2 records that the receiver quits while being served clean
`200`s, and the third hardware run reproduced it exactly: playing, four segments served
off disk in 2–4 ms on one keep-alive connection, zero aborts, zero 500s, no restart in
the window — then `ERROR`.

The bytes were never the problem. **The timeline was.** From the failing session:

```
16:22:35.626  ffmpeg launched: run@seg354      <- writes seg354 = content @2117.18
16:22:39.178  ffmpeg launched: run@seg353      <- OVERWRITES seg354 = content @2123.19
                                                  and writes seg353 = content @2117.18
…
16:23:09.964  seg353 -> 200 882848B 2ms        <- content @2117.18
16:23:10.028  seg354 -> 200 877584B 4ms        <- content @2123.19
16:23:10.197  seg356 -> 200 1151876B 4ms
16:23:10.309  media: unmatched error ERROR
```

The receiver had already fetched `seg354` earlier, when it contained the **@2117.18**
content. It now holds two different versions of segment 354, and a `seg353` that
duplicates the older one. Overlapping PTS across segments it believes are consecutive is
exactly the kind of incoherence a player rejects — with no network error to report,
which is why every log-based hypothesis in the parent document came up empty.

This also retro-explains why more scrubbing makes it worse: each restart is another
chance to overwrite a cached segment with different content. It is not a resource limit.

---

## 5. Why only the video-transcode tier

- **`remux` / `audio-transcode`** copy the video stream, so their boundaries are
  **keyframe-aligned** by construction. `-ss keyframe+0.25 -noaccurate_seek` snaps back
  to that same keyframe, the first segment starts exactly where the playlist says, and
  the numbering is correct. These tiers are not affected.
- **`video-transcode`** re-encodes, so it uses the **fixed 6 s grid** — which is free to
  fall anywhere inside a GOP. This is the affected tier.
- **`direct`** has no segments at all.

This is also why test (d) in `hls-session.test.ts` never caught it: it seeks to
`bounds[40] = 240`, and the fixture was deliberately chosen so that **240 is a keyframe**.
The test pins the keyframe-aligned case — the one that works.

---

## 6. Fix directions — DIRECTION 2 TAKEN (2026-07-23)

**What landed:** the `video-transcode` tier now segments on source keyframes, exactly
as the copy tiers do, so a restart's entry point is a real keyframe and
`-start_number` is correct by construction.

| File | Change |
|---|---|
| `decide/decision.ts` | new `computeTranscodeBoundaries()` — forward-greedy walk taking the first source keyframe at least 6s past the previous boundary. The `else` branch that emitted `{ mode: 'fixed' }` for every transcode now emits keyframe boundaries whenever an index is available. |
| `ffmpeg/args.ts` | keyframe-aligned runs get an **absolute** `-force_key_frames` list (the boundaries after the run start), `-g 100000`, and `-hls_time 5.9`. Fixed-grid transcode restarts switch to an **accurate** seek. `SEEK_EPSILON_SEC` re-derived, unchanged at 0.25. |
| `session/playback-session.ts` | `needsKeyframes()` widened to every HLS tier; `resolveBoundaries()` dispatches on `plan.video.kind` and warns when it has to fall back to the fixed grid. |

Four ffmpeg behaviours make or break this, all measured — **read §9 before changing
any of them**, because three of the four are counter-intuitive and one of them
(`-g`) silently reintroduces the bug.

### Why not the other two

- **Direction 1 (accurate seek everywhere) is not the shipped default**, but it *is*
  what now runs on the no-keyframe-index fallback, where nothing else can work. It is
  **not exact, and the exactness claim in an earlier draft was wrong** — see §9.5 for
  what it actually delivers (never early; under two frame intervals late at fractional
  rates; restart-invariant in video). Measured on the 45-min fixture: 0.46s to a
  complete first segment vs 0.42s for the fast seek, and a 720p10 HEVC source decodes
  at ~39x realtime, so the doc's feared "20.9s of decode" is ~0.5s of wall clock. The
  latency fear was overstated. It remains the simpler fix and should be reconsidered if
  §9's ffmpeg dependencies ever become a maintenance burden.
- **Direction 3 (derive `-start_number` from where ffmpeg landed)** was called a
  probable dead end for the wrong reason — the landing point is *predictable* from
  the keyframe index, so it need not be discovered after the fact. It is dead for a
  different and fatal reason, measured in §9.2: with `expr:`-forced keyframes the
  output segment grid is anchored to the RUN START, so a run entering off-grid emits
  segments at `landing + 6k`, which no choice of `-start_number` can map onto a
  uniform 6s playlist grid. That also kills the "keep a uniform grid, start at the
  preceding keyframe" refinement.

## 6b. Fix directions as originally written (unvalidated — kept for the record)

1. **Accurate seek on the transcode tier.** Drop `-noaccurate_seek` when the video action
   is `transcode`, so ffmpeg decodes from the preceding keyframe and the first *output*
   frame is exactly the boundary. Correct by construction and a small argv change. Cost:
   decode-and-discard of up to one GOP (mean 4.8 s, worst 20.9 s of decode) added to
   first-segment latency, which is currently ~800 ms and is the number that decides
   whether a receiver starves. **Must be measured before it is believed.**
2. **Keyframe-align the transcode grid too.** Use the existing keyframe index (`probe/`)
   to place boundaries on source keyframes for `video-transcode` as well, as the copy
   tiers already do. Removes the mismatch at the source rather than papering over it.
   Cost: variable segment durations, and `EXTINF` must then be derived from the real
   boundaries (it already is — `hls/boundaries.ts` `segmentDuration()`).
3. **Derive `-start_number` from where ffmpeg actually landed** rather than from the
   requested boundary index. Cheapest in CPU, but it makes the segment→time mapping
   depend on a value only known after ffmpeg starts, and the synthesized VOD playlist is
   built up front — so the playlist would still be lying. Probably a dead end; recorded
   so nobody re-derives it.

`SEEK_EPSILON_SEC` (0.25) exists because `-ss` on Matroska lands one GOP **early** when
the target is exactly a keyframe (see `CLAUDE.md`). If direction 1 is taken, re-derive
whether the epsilon is still needed or now actively harmful — do not carry it forward
unexamined.

### 6c. `SEEK_EPSILON_SEC` re-derived — still 0.25, and now load-bearing

It was carried forward, but not unexamined. Under the keyframe-aligned grid EVERY
restart target is exactly a source keyframe, so landing one keyframe early no longer
costs a slightly-early segment — it costs the run's numbering. The epsilon is now the
single guarantee that `-start_number` is right.

Epsilon swept at a known keyframe across two Matroska fixtures at DIFFERENT frame
rates and one MP4, `-ss X` → first frame out:

```
mkv, 30fps      keyframe 240.000 :  +0.128 -> 238.333 (early)   +0.130 -> 240.000 (ok)
mkv, 24000/1001 keyframe  24.024 :  +0.128 ->  20.020 (early)   +0.130 ->  24.024 (ok)
mp4, 30fps      keyframe  16.666 :  +0.000 ->   8.333 (early)   +0.010 ->  16.666 (ok)
```

On Matroska the threshold is a **constant ~0.129s** — it does NOT scale with frame
rate. An earlier draft of this section read it as "4 frames at 30fps"; that was a
coincidence of the single 30fps fixture it was measured on, and the 24000/1001 fixture
refutes it (same 0.129, not the 0.167 a frame-count model predicts). MP4 needs only a
nonzero nudge. 0.25 clears both with ~2x margin and is the value verified on hardware
(a real Matroska restart landed on `-start_number 95` exactly). The mechanism behind
the Matroska constant is not established — this is an observation, not a formula.

Its *upper* bound got weaker and that is worth knowing. It used to be "far below the
smallest keyframe gap"; real content can carry two keyframes a few frames apart at a
scene cut, and if one falls in `(boundary, boundary+0.25]` the seek lands on it. The
residual damage is small and bounded — the run starts up to 0.25s late, so its first
segment is up to 0.25s short at the front — and **numbering is unaffected**, because
the forced-keyframe list is in absolute media time (§9.2) and pins every later split
regardless of where the run began.

---

## 7. Verification — what the tests now pin

All three run against the real ffmpeg on a committed fixture, and all three were
confirmed to FAIL against the previous engine before the fix was written.

| Test | Asserts | Pre-fix failure |
|---|---|---|
| `hls-session` **(p)** | transcode, fixed grid, restart at `bounds[41]=246` (not a keyframe): first video PTS is 246 | `expected 240 to be close to 246` |
| `hls-session` **(q)** | transcode, keyframe-aligned grid: segments N, N+1 and N+2 of ONE run each start at their declared boundary | `computeTranscodeBoundaries is not a function`; with the old argv, N+1 came out at `bounds[N]+6` |
| `hls-session` **(r)** | restarts at adjacent boundaries 40/41 do not emit the same media twice | audio-ES md5 **identical**, video PTS gap **0** |

**No new fixture was needed, and adding one would have been worse.** `foxtrot` has an
8.333s GOP against a 6s grid, so ~39% of its GOPs contain two grid points — the exact
collision condition from §3, already committed and already used by the slow HLS
tests. `bounds[40]=240` is a keyframe (which is why test (d) passed for the wrong
reason) and `bounds[41]=246` is not: one fixture expresses both the working case and
the broken one, six seconds apart.

**Which hash matters, in test (r), was measured rather than assumed** — the obvious
choice is wrong:

| Compared | Pre-fix (same media, two numbers) | Verdict |
|---|---|---|
| whole `.ts` file | **differs** (mpegts framing) | asserting "not equal" passes for free |
| video elementary stream | **differs** — `h264_videotoolbox` is a hardware encoder and is not bit-deterministic across runs | useless |
| **audio elementary stream** | **bit-identical** | the discriminator; `aac_at` is deterministic, so this hash tracks media time and nothing else |
| file size | identical (609496 B both) | works here, easiest to pass by luck elsewhere |

### Hardware — STILL REQUIRED, and nothing above substitutes for it

The parent document's §8 protocol applies unchanged, and the honest metric is the one
corrected there: seeks survived counted as *launches that served a live request*, not
`grep -c start_number`. Baselines to beat: **22** real seeks (run 2), **17** (run 3).
Ask the person at the TV what is on screen, naming the device, and wait for the answer.

Two mechanisms in §6 have never run against a receiver and are the first things to
suspect if it still dies: the longer, variable segment durations (a pathological GOP
now produces a segment as long as itself, with `EXT-X-TARGETDURATION` to match), and
`-hls_time 5.9`, which is new argv on the tier that fails.

Raw logs are not committed (absolute paths to the maintainer's library). Describe media
by characteristics — codec, resolution, duration, tier — never by title.

---

## 8. What is still open

1. **The receiver.** Nothing here proves the seek-restart storm is cured. It proves the
   engine no longer serves segment N with segment N-1's content. §6.1 of the parent
   document is the standing warning: a confirmed mechanism is not a load-bearing one.
2. **The COPY tiers drift too** — a new finding, deliberately not fixed. See §9.4.
3. **Long segments on pathological content.** Accepted, not solved. See §9.3.
4. **`NEAR_WINDOW`'s arithmetic assumed 6s segments.** Its justification in
   `hls/session.ts` reads "0.8s + (N+1) x 6s at 1x realtime = 24.8s, inside the 30s
   waiter timeout". Keyframe-aligned segments average ~8.4s on a 4.8s-GOP source, which
   makes that worst case ~34s. It only bites at 1x realtime (the 4K→HEVC tier); the
   measured 1080p transcode runs ~7.5x. Left alone because changing `NEAR_WINDOW`
   touches the supersede boundary that tests (j)/(k)/(l) pin, and this is a
   single-variable change on a bug that has already survived two "confirmed" fixes.

---

## 9. ffmpeg behaviour the fix depends on (all measured, ffmpeg 8.1.1, Apple Silicon)

### 9.1 The HLS muxer's split rule is CUMULATIVE from the run start

A segment ends at the first keyframe whose offset from the **run start** is
`>= hls_time * n`, where n counts segments already written. Not "at the first keyframe
6s after the previous split".

Copy of the 45-min fixture (8.333s GOP), `-hls_time 6`, splits at:

```
8.333  16.667  25  33.333  41.667  50  58.333  60  68.333  76.667  85 …
```

The `60` is the tell. A per-segment rule would have skipped it (only 1.667s after
58.333); the cumulative target had fallen to 48 by then, so any keyframe split. Two
consequences the fix is built on:

- **Once the target lags, EVERY keyframe splits.** So the boundary list must be the
  output keyframe list — which is achievable only where we choose the keyframes, i.e.
  on a transcode.
- **A boundary closer than `hls_time` to its predecessor is silently skipped** and two
  playlist entries collapse into one file. That is why the transcode tier needs
  `computeTranscodeBoundaries()`' minimum-gap guarantee instead of `computeBoundaries()`'
  nearest-snap, and why `-hls_time` is 5.9 rather than 6 (µs truncation can make a
  nominally-6.000s gap measure 5.999999s).

### 9.2 `expr:` forced keyframes are RELATIVE; an explicit list is ABSOLUTE

Same argv, two different anchors — this is the fact that kills fix direction 3 and the
"uniform grid, keyframe entry point" refinement.

| `-force_key_frames` | run entered at | output keyframes |
|---|---|---|
| `expr:gte(t,n_forced*6)` | 240.0 (on the 6s grid) | 240, 246, 252 — looks absolute |
| `expr:gte(t,n_forced*6)` | **25.0** (off the grid) | **25, 31, 37, 43** — anchored to the run start |
| `33.333,43.333,51.667,60,…` | 25.0 | **33.333, 43.333, 51.667, 60** — exactly as listed |

`CLAUDE.md` recorded the first row as proof that the expr "lands on the absolute grid".
It does not; that run merely started on a grid point. Only the explicit list is
absolute, which is why the fix uses one.

Each requested time is nudged **1ms earlier** (`KEYFRAME_GUARD_SEC`): ffmpeg forces a
keyframe on the first frame with `pts >= request`, so a request that rounds even 1µs
late selects the following frame. 1ms cannot reach the previous frame (>=4ms away at
any sane rate).

### 9.3 `-g 240` reintroduces the bug, so it had to go

With the explicit boundary list AND the old `-g 240` backstop, `h264_videotoolbox`
inserted its own IDRs every 240 frames, the muxer split at each of them, and the
numbering drifted within four segments:

```
expected  33.333  41.667  50      58.333  68.333 …
-g 240    33.067  41.333  43.333  51.333  59.700 …   (strays at 33.067, 41.333, …)
-g 100000 33.333  41.667  50      58.333  68.333 …   (exact, incl. the 10s gap)
```

On this path a stray keyframe is worse than a long GOP. `-g` cannot simply be omitted —
`AVCodecContext` defaults `gop_size` to 12.

**Accepted cost: segments are as long as the source GOP that carries them.** A
pathological 20.9s GOP (measured on real content) yields a 20.9s segment and an
`EXT-X-TARGETDURATION` to match. The alternative — subdividing a long GOP — puts back
boundaries that are not source keyframes, i.e. the defect itself, unless `HlsSession`
gains a launch-index indirection (launch at the preceding keyframe, encode forward,
number from there). That is a bigger change and is the obvious follow-up if hardware
says long segments hurt. The encoder sustains ~7.5x realtime on this content (6s
segment in ~800ms, measured), so 20.9s costs ~2.8s to first segment against ~0.8s today.

### 9.4 NEW, UNFIXED: the COPY tiers drift as well

Found while measuring 9.1, on the same fixture. `computeBoundaries()` (nearest-snap)
does not describe what the muxer does:

```
computeBoundaries  … 41.667  50  60      68.333 …
ffmpeg actually    … 41.667  50  58.333  60     …
```

`boundaries[7]` says 60; the file called `seg7` holds 58.333–60. And because the
mismatch is a mismatch, a restart at index 7 (`-ss 60.25` → keyframe 60) rewrites
`seg7` with 60–68.333 — **the same overwrite hazard as §4, on the remux and
audio-transcode tiers.**

Not fixed here, deliberately:

- It cannot be fixed by choosing better boundaries. Per 9.1 the muxer's targets fall
  behind and it splits at every source keyframe, so the only self-consistent copy-tier
  boundary list is **the full keyframe list** — one segment per GOP.
- That is a product change, not a bug fix: it roughly doubles the segment count on a
  4.8s-GOP source (and much more on scene-cut-heavy content), inflates the playlist,
  and raises the request rate. It needs its own hardware validation.
- Both copy tiers are hardware-verified working on two devices, and all three recorded
  storm failures were on `video-transcode`. Bundling this in would have made the one
  measurement that matters — does the receiver survive scrubbing — unattributable.

### 9.5 The fallback is UNIFORMLY LATE at fractional frame rates, not exact

An earlier draft of §6 and the `args.ts` comment said the no-keyframe-index fallback's
accurate seek makes "the first output frame the boundary exactly", citing 0.46s-vs-0.42s
on the 45-min fixture. A reviewer re-measured on 10-bit HEVC and found it **+1.43s
late**, consistently, across a whole run. Both readings were real; the exactness claim
was the one that generalised wrongly. Two variables were confounded.

**Variable 1 — the mpegts muxer's initial PCR delay (~1.4s), present on EVERY tier and
path.** `-hls_segment_type mpegts` stamps the first PTS ~1.400s in. The 45-min "exact"
reading was on **fmp4** (no such offset); the HEVC "+1.43" reading was on **ts**.
Subtract the muxdelay and +1.43 becomes +0.03. This offset is not the fallback's and is
not new — it is on the keyframe-aligned path too (§9's shipped-path PTS all carry it).

**Variable 2 — the frame rate, which IS the fallback's own residual.** Swept with codec
and bit depth held constant, fmp4 (no muxdelay), fixed-grid fallback argv:

```
30fps      8-bit H.264  : delta 0.000000  (exact)
30fps     10-bit HEVC   : delta 0.000000  (exact)
24000/1001 8-bit H.264  : +0.006 .. +0.066  (sawtooth, never >2 frame intervals)
24000/1001 10-bit HEVC  : +0.006 .. +0.066  (identical to H.264 — codec irrelevant)
```

So the codec and bit depth are red herrings — the reviewer's HEVC sample was fractional,
the "exact" one was 30fps. At 24000/1001 no multiple of 6 is a frame time, so the
boundary is unreachable and ffmpeg emits the first frame **at or after** it (one
quantisation), while the `expr:` forced keyframes quantise to the same grid from the
run's own start (a second). The sawtooth is those two beating; it is bounded by two
frame intervals (~83ms at 23.976fps) and **resets each restart** because the run
re-bases from the seek point. The fixture `quebec_mkv-h264-23976fps.mkv` and test (s)
pin this.

**Separately, the INITIAL run (no `-ss`) is uniformly shifted by a small amount** even
on the keyframe-aligned path — measured +0.044s on this fixture. It is audio-derived:
ffmpeg rebases output on the earliest mapped stream, the AAC starts at -0.021 (encoder
priming) and re-encoding adds another frame. Measured +0.000 with `-an`, +0.021 with
audio copied, +0.044 with audio transcoded. A `-ss` restart does not carry it. It is a
UNIFORM shift of the whole initial run — every segment equally, EXTINF spacing intact,
no numbering error — and is pinned by test (s) as a known quantity.

**The property that actually matters, and it holds: restart-invariance.** Two runs
restarting at adjacent boundaries on the fractional fixture produce, for a given segment
number, the **same video first-PTS** (verified to 3 decimals) — so different boundaries
land on different content, there is no byte-identical collision, and a receiver caching
across a seek does not see the timeline move under it. Audio framing across two runs can
differ by up to one AAC frame (~21ms), which is why test (r) hashes audio only on the
keyframe-aligned path (exact there) and test (s) asserts restart-invariance in **video**
on the fallback. "Uniformly shifted but self-consistent" is the honest guarantee for the
fallback; "exact" is only true of the keyframe-aligned path at integer rates, and only
the former is what the fallback promises.
