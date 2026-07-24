# Seek-restart storm — receiver quits under sustained scrubbing

**Status:** OPEN. Three contributing bugs found and fixed; **none of them cures the
failure.** Run 3 (2026-07-23, post-§6-fix) died again. The ROOT CAUSE candidate
was segment-numbering drift — fixed in code (`d498b13`); see
**`docs/segment-numbering-drift.md`**. **Hardware 2026-07-24 on the 1.0.0 packaged
app (first build containing that fix) still failed a burst scrub** — frozen frame
+ spinner ~50:30 on SHIELD, recoverable with a small nudge. Full evidence and
next-agent brief: **`docs/phase0-1.0.0-hardware.md`**. Come back here for older
symptom/protocol/killed hypotheses.

> This document is self-contained. It is written for an agent starting in a fresh
> context with no memory of the investigation. The prompt at the end is ready to
> use as-is. Read the whole file before acting — several plausible-looking fixes
> were already tried and rejected on evidence.

> **Read this first if you are picking the bug up:** everything below is a correct
> account of contributing bugs that were real, measurable, and worth fixing — and
> none of which stopped the receiver quitting. The thing that actually explains
> "dies while being served correctly" is segment-numbering drift on the
> `video-transcode` tier, confirmed by reproduction in the companion document. Go
> there. Come back here only for the symptom, the protocol, and the killed
> hypotheses.

---

## 1. What castgorilla is (minimum you need)

A macOS app that casts a local video file to a Chromecast /
Android TV on the LAN. Pipeline: probe (ffprobe) → decide (pure planner) → serve
over a local HTTP server → cast via CASTV2 to the Google **Default Media
Receiver**.

Four playback tiers, cheapest first: `direct` (byte-for-byte over HTTP Range),
`remux`, `audio-transcode`, `video-transcode`. The last three are delivered as
**on-demand HLS VOD**: a synthetic playlist plus an `HlsSession` that runs ffmpeg
and serves segments as they land on disk.

Seeking on an HLS tier is implemented as a **seek-restart**: kill the running
ffmpeg, relaunch it with a new `-ss` and `-start_number` at the target segment.
There is no other seek mechanism.

Read `CLAUDE.md` at the repo root before touching anything — it carries the
project's working agreement and a long list of hard-won empirical constraints.

Relevant source:

| Path | Role |
|---|---|
| `packages/engine/src/hls/session.ts` | `HlsSession`: ffmpeg lifecycle, segment waiters, seek-restart |
| `packages/engine/src/server/media-server.ts` | HTTP server; segment routes, `SupersededError` handling |
| `packages/engine/test/hls-session.test.ts` | Integration tests, incl. seek-storm, backward-seek and abandoned-probe cases |
| `packages/engine/test/server-media.test.ts` | Server-level integration, incl. the live scrub and client-disconnect cases |

Constants in `hls/session.ts`:

```ts
const NEAR_WINDOW = 3;            // segments of read-ahead treated as "will exist soon"
const RESTART_DEBOUNCE_MS = 250;  // burst coalescing window for seek-restarts
const WAIT_TIMEOUT_MS = 30_000;   // how long a segment request may wait
const POLL_MS = 200;              // disk readiness scan interval
```

---

## 2. The symptom

Scrub backwards through a film repeatedly and the receiver eventually gives up:
the TV returns to the **Chromecast backdrop** (confirmed by a human watching —
not a freeze, not a black screen), and the engine surfaces:

```
ERROR [session] ss-xxxxxxxx error — receiver reported a playback error
```

That string comes from `playback-session.ts`, emitted when the receiver reports
`playerState: IDLE` with `idleReason: 'ERROR'`. The backdrop means the receiver
tore down its media session and unloaded the app — so nothing can be recovered in
place; only a fresh LOAD would resume, and the user's position is lost.

Normal viewing does not obviously trigger this. Sustained scrubbing does.

---

## 3. Evidence

Two hardware runs, same device, same class of media (1080p HEVC → H.264,
`video-transcode` tier, `segFmt=ts`). Run 2 was taken *after* the fix in §4.

| | Run 1 (pre-fix) | Run 2 (post-fix) |
|---|---|---|
| seeks before failure | 11 | **59** |
| stranded waiters at death | **63** | **2** |
| requests abandoned at debug (healthy) | ~17 | **569** |
| unique client TCP connections | 351 | 875 |
| requests ABORTED by receiver | 323 | 775 |
| total segment GETs | 438 | 1074 |
| zero-length `200`s | 291 | 646 |
| — of those, NOT client-aborted | **0** | **0** |
| `500`s on the wire | 7 | 19 |

### 3.1 We are not serving corrupt or empty data

Every zero-length response was aborted by the client before a byte was written.
`0` non-aborted zero-length responses in both runs. **Do not spend time on this** —
it looks alarming in a log and is a red herring.

### 3.2 The receiver dies while being served correctly

Run 1, the four responses immediately before it quit:

```
seg173.ts -> 200 1732796B 896ms
seg174.ts -> 200 2037920B 514ms
seg175.ts -> 200 1794648B  53ms
seg176.ts -> 200 1722644B  42ms
15:56:35.736  media: unmatched error ERROR   <- receiver gives up here
15:56:35.816  hls segment 389 failed: HlsSession disposed   (x63, teardown)
15:56:36.057  state buffering -> error
```

Note the ordering: the disposal avalanche arrives **80ms after** the receiver
already quit. It is a consequence of teardown, not a cause. Reading the log
without the `ERROR [session]` anchor makes it look causal, and it is not.

### 3.3 The remaining pathology is connection churn

Run 2, the last second before failure — note the client port on each line:

```
seg370.ts -> 200 196608B 105ms remote=...:52346 ABORTED
seg367.ts -> 200 196608B  14ms remote=...:52348 ABORTED
seg365.ts -> 200 851968B  57ms remote=...:52350 ABORTED
seg363.ts -> 200 196608B  11ms remote=...:52352 ABORTED
seg362.ts -> 200 655360B  45ms remote=...:52354 ABORTED
seg360.ts -> 200 393216B  32ms remote=...:52356 ABORTED
...
```

A **new TCP connection per segment**, nearly all aborted mid-transfer. 875
connections in one session. The churn is proportional to seeking: roughly **13
aborted connections per seek** (59 × 13 ≈ 775, which matches the measured 775).

Each seek restarts ffmpeg; the receiver responds by dumping everything in flight
and re-requesting. Sixty seeks is more than it tolerates.

> **Correction (2026-07-23).** This paragraph used to read "restarts ffmpeg *and
> rewrites the playlist*". **The playlist half is false.**
> `HlsSession.playlistText()` calls `synthesizeVodPlaylist()`, a pure function of
> `boundaries` / `durationSec` / `segmentFormat` — it is byte-identical across
> every restart in a session, and ffmpeg's own `playlist.m3u8` in the work dir is
> never served. Nothing the receiver sees changes at a restart except which
> segments happen to be on disk. This is why §7.4 has been retired.

### 3.4 Seeks do not coalesce in practice

`RESTART_DEBOUNCE_MS` is **250ms**. Deliberate human seeks in both runs were
~300ms–1.8s apart, so the debounce almost never fires. 59 seeks produced 59
ffmpeg restarts. The burst-coalescing logic is real but only catches
within-drag storms, not a human hunting for a scene.

### 3.5 Most restarts served nobody — the abandoned-request amplifier

Re-measuring the same two logs against the code turned up a **fifth cause that is
a plain bug, not a design trade-off**, and it is the one fixed in §6. It was not
on the original candidate list because the log reads as if the restarts were
wanted.

`MediaServer.serveHls()` awaited `session.getSegment(i)` and **never observed
client disconnect**. By then `HlsSession.getSegment()` had already called
`scheduleRestart(i)`, which set `pendingIndex = i` (last write wins) and armed
the 250ms timer. When that timer fired, `flushLaunch()` → `launchAt()` killed the
running ffmpeg and relaunched at `pendingIndex` **with no check that anyone was
still waiting for it.** During a scrub the receiver probes segments and abandons
each in ~53ms — far inside the debounce — so abandoned probes steered the encoder
to positions the user never landed on.

| Measure | Run 2 | Run 1 |
|---|---|---|
| ffmpeg launches with **no live request** for that index at launch time | **38 / 60 (63%)** | 13 / 25 (52%) |
| segment GETs abandoned **while we were still waiting** (200, 0 B, ABORTED) | **646 / 1103 (59%)** | — |
| …average time the receiver held those before walking away | **53 ms** | — |
| segments served from disk in <10 ms | 107 | — |

Two verbatim instances from the last two seconds before the receiver quit:

```
15:13:32.530  seg373.ts -> 200 0B 46ms ABORTED      <- receiver gives up on 373
15:13:32.861  ffmpeg launched: run@seg373           <- we restart for it 331ms later
15:13:33.241  seg350.ts -> 200 0B  9ms ABORTED      <- receiver gives up on 350
15:13:33.665  ffmpeg launched: run@seg350           <- we restart for it 424ms later
```

Meanwhile the receiver had actually settled at **342** and was being served
342/343/344 from disk in 1–2ms. The `run@seg350` restart killed the run at 373 to
serve a request that had been dead for 424ms, eight segments past where the user
was.

**The discriminator that makes this self-consistent is hold time.** When the
receiver has genuinely settled it *holds* the request — `seg380.ts -> 200 286700B
1362ms` at 15:13:30.628. Abandoned in ~50ms = scan probe. Held for over a second
= real playback request. The 250ms debounce already separates the two; the engine
simply did not use the information.

Note this does **not** contradict §3.2 or §3.3: the receiver still died while
being served four clean 200s, and the connection churn is still receiver-driven.
What this adds is that most of the ffmpeg restarts paying for that churn were
never wanted by anybody.

---

## 4. Already fixed — do not redo this (fix 1 of 2; the other is §6)

`supersedeWaiters()` rejected only waiters **below** the new start index. Its doc
comment said "waiters the run cannot produce", which was true below `newStart`
and false above it: a run restarting at seg173 *can* technically still emit
seg389, after ~21.6 minutes of encoding. So backward seeks stranded every
already-issued forward request — mostly the receiver's own read-ahead, roughly
five per seek.

Fixed by rejecting in both directions, keeping a `NEAR_WINDOW` (3 segments, 18s)
read-ahead allowance:

```ts
private supersedeWaiters(newStart: number): void {
  const reachableThrough = newStart + NEAR_WINDOW;
  for (const [idx, set] of this.waiters) {
    if (idx >= newStart && idx <= reachableThrough) continue; // satisfiable soon
    if (this.segmentExists(idx)) continue;                    // on disk already
    ...reject with SupersededError
  }
}
```

Effect, measured on hardware: stranded waiters **63 → 2**, proper abandonment
**~17 → 569**, seeks-to-failure **11 → 59**. A real improvement; not a cure.

The waiter at `newStart` is the request that *triggered* the restart and must
survive — it is inside the window by construction. Breaking that boundary breaks
all playback, so any change here needs the boundary tests in
`hls-session.test.ts` cases (j)/(k)/(l).

---

## 5. Hypotheses already killed by evidence

Do not re-open these without new data:

1. **"Superseded segments answered with 500 upset the receiver."** `CLAUDE.md`
   flags 500-vs-404 as an untested open question, and it was the first
   hypothesis. Dead for this failure: only 7 (run 1) and 19 (run 2) 500s in
   entire sessions, none adjacent to the failure, and the receiver quit while
   being served four clean 200s. The 500-vs-404 A/B remains genuinely open as a
   *separate* question — it is simply not what causes this.
2. **"We serve empty or truncated segments."** Zero non-aborted zero-length
   responses in both runs (§3.1).
3. **"The disposal avalanche kills the receiver."** It happens 80ms after the
   receiver has already errored (§3.2).
4. **"First-segment latency starves it."** Restart-to-first-segment was ~800ms
   throughout, and segments were served in 1–2ms from disk when already encoded.

---

## 6. Fix landed 2026-07-23 — abandoned requests no longer steer ffmpeg (PENDING HARDWARE)

Chosen because §3.5 shows it is a plain bug rather than a trade-off, and because
it costs **nothing in seek latency** — the felt interaction is untouched. It was
not one of the four candidates below; those remain available if this proves
insufficient.

**The rule:** a request whose client has gone away must neither arm a restart nor
win one.

- `HlsSession.getSegment(i, signal?)` / `getInitSegment(signal?)` take the
  caller's client-disconnect `AbortSignal`. An already-aborted signal throws
  before `scheduleRestart()`; an abort *during* the wait clears the timeout,
  removes the waiter and rejects.
- The rejection is a new `RequestAbandonedError`, deliberately distinct from
  `SupersededError`: **superseded** = the engine dropped it for a newer seek,
  **abandoned** = the client walked away. `SupersededError` and its semantics are
  unchanged (see the constraints in §9).
- The single debounced `pendingIndex` became `pendingForced` (set only by
  `ensureStarted()`/`warmup()`, which legitimately have no waiter) plus
  `pendingOrder` (a most-recent-last list of `scheduleRestart()` candidates).
  `pickLaunchTarget()` returns `pendingForced` if set, else walks `pendingOrder`
  **from the end** and takes the newest index that still has a live waiter.
  Walking from the end preserves last-write-wins exactly; the only behavioural
  change is that dead indices are stepped over.
- When every candidate is dead, `flushLaunch()` **skips the launch entirely** —
  the running ffmpeg is left alone to keep producing near where the user is.
  That skip is logged at info (`restart to seg<N> skipped — no request still
  waiting (abandoned during scrub)`) and counted by the new `restartsSkipped` /
  `restartsLaunched` diagnostic getters.
- `MediaServer` builds one `AbortController` per request, aborts it on premature
  `close`, and threads the signal through `serveHls()`. A `RequestAbandonedError`
  is logged at debug and answered with nothing — the socket is already gone. The
  request has by then been logged and accounted as `200 0B … ABORTED`, and 200 is
  2xx, so `RouteStats.errors` cannot be inflated by this path. **The 500 wire
  status for superseded segments is unchanged** (§5.1 — still a separate open
  question).

Tests: `hls-session.test.ts` (m)/(n)/(o) and a client-disconnect test in
`server-media.test.ts`. Cases (e)/(j)/(k)/(l) are untouched and still pass, which
is the evidence that the supersede boundary in §4 was not disturbed.

### 6.1 Hardware verdict (run 3, 2026-07-23): the mechanism was real, the fix is NOT curative

Same device as run 2 (`SHIELD`, same LAN address), same tier
(`video-transcode`, `segFmt=ts`), 84 s session. **The receiver quit again.** Every
mechanical prediction in this section held; the failure did not move.

| | run 2 (pre-fix) | run 3 (post-fix) | |
|---|---|---|---|
| ffmpeg launches | 60 | **22** | as predicted |
| launches serving **nobody** | 38 (63%) | **5 (23%)** | as predicted |
| client-disconnect drops | path did not exist | **362** | new path firing |
| restarts skipped | — | **8** | new path firing |
| 500s on the wire | 19 | **3** | as predicted |
| segment GETs / unique conns | 1103 / 875 | 508 / 414 | churn still receiver-driven |
| **outcome** | **died** | **died** | ✗ |

**And the headline metric in §8 was measuring the wrong thing.** "Seeks survived =
59" came from `grep -c start_number`, i.e. **ffmpeg restarts**. Pre-fix those were
~1:1 with seeks so it read as a seek count; §6 deliberately decouples them, so 22
vs 60 is not a comparison. The like-for-like proxy for a genuine settle point is
*launches that served a live request*:

- run 2: **22** real seeks before death
- run 3: **17** real seeks before death (the human counted "about 15")

So: **no improvement, within one-run noise.** Corrected in §8 — use the live-request
count, or no future run is comparable to any past one.

The death signature was identical to §3.2, and sharper: playing, four segments
served off disk in 2–4 ms on ONE keep-alive connection, zero aborts, zero 500s, no
restart in the window, then `ERROR` 112 ms later. That is what sent the
investigation at the segment *content*, and found the root cause —
**`docs/segment-numbering-drift.md`**.

**Keep this fix.** It is a genuine bug (63% → 23% wasted restarts, 2.7× less ffmpeg
work, 6× fewer 500s, and it stops the encoder being dragged to positions nobody
watches). It is simply not the cure, and must not be recorded as one.

---

## 7. Candidate directions still available (unvalidated)

If §6 proves insufficient, the remaining cost is a **design** property rather
than a leak: every deliberate seek that a user does settle on still costs a full
ffmpeg restart, and the receiver pays in dumped connections. Options, roughly
cheapest first:

1. **Don't restart when the target is already on disk.** In run 2, segments
   342–348 were served from disk in 1–2ms while ffmpeg was simultaneously
   restarted to 373 and then 350. If a seek lands where segments already exist
   and are contiguous enough to play from, the restart may be unnecessary.
   Likely the highest value-to-risk ratio. Needs a rule for "enough runway".
2. **Raise / adapt `RESTART_DEBOUNCE_MS`.** 250ms never fires for human seeking.
   A larger window (or one that grows while seeks keep arriving) would collapse a
   hunt into fewer restarts. Trade-off: directly adds latency to a single
   deliberate seek, which is the most felt interaction in the product. Measure
   before choosing.
3. **Keep the previous ffmpeg run alive briefly across a restart.** Currently
   `launchAt` kills the previous run *first* so at most one ffmpeg is ever alive.
   Overlapping would let in-flight requests complete instead of being dumped —
   at the cost of CPU and the single-run invariant, which exists deliberately.
4. ~~**Reduce playlist churn.**~~ **RETIRED — there is no playlist churn.**
   `HlsSession.playlistText()` is `synthesizeVodPlaylist()`, a pure function of
   `boundaries` / `durationSec` / `segmentFormat`; it returns byte-identical text
   across every restart in a session, and ffmpeg's own `playlist.m3u8` in the
   work dir is never served. The premise was a misreading (see the correction in
   §3.3). Left listed, struck through, so nobody re-derives it from the same
   wrong sentence.

None of 1–3 is obviously correct. Expect to prototype and measure on hardware.

---

## 8. How to reproduce and verify

**Logs cannot tell you whether something played. Only a human watching the TV
can.** This is the project's hardware protocol (see `CLAUDE.md`) and it applies
here: `playerState` is a calibrated proxy only for the crude wedged-vs-playing
question.

Run the app in dev with debug logging:

```bash
LOG_LEVEL=debug npm run dev -w packages/app 2>&1 | tee /tmp/cg-seek.log
```

Cast an HLS-tier file (any HEVC source forces `video-transcode`; a Cast-legal
H.264 MP4 will direct-play and is useless here). Confirm the tier in the log:
`tier=video-transcode, segFmt=ts`.

Then scrub **backwards** repeatedly — imitate hunting for a scene, roughly one
seek per second, 30+ seeks. Then:

```bash
grep -c "ERROR \[session\]"                /tmp/cg-seek.log   # 0 = survived
grep -c "HlsSession disposed"              /tmp/cg-seek.log   # stranded waiters
grep -c "abandoned (expected during seek)" /tmp/cg-seek.log   # healthy abandonment
grep -c "dropped (client disconnected"     /tmp/cg-seek.log   # §6: waits the client left
grep -c "restart to seg.* skipped"         /tmp/cg-seek.log   # §6: restarts NOT launched
grep -c "ffmpeg launched"                  /tmp/cg-seek.log   # baseline 60
grep -oE "remote=[0-9.]+:[0-9]+" /tmp/cg-seek.log | sort -u | wc -l   # connections
grep -c "ABORTED"                          /tmp/cg-seek.log
grep -oE "start_number [0-9]+" /tmp/cg-seek.log | awk '{print $2}' | tr '\n' ' '
```

> **CORRECTED after run 3 — do NOT count seeks with `start_number`.** That line
> counts **ffmpeg restarts**, which were ~1:1 with seeks only until the §6 fix
> deliberately decoupled them. Using it across that change compares two different
> quantities and flatters any fix that reduces restarts. The published "59 seeks
> survived" baseline was never 59 human seeks.

The metric that matters is **seeks survived before failure**, and the honest proxy
for one genuine seek is a **launch that served a live request** — the `IN FLIGHT`
figure from §8.1, not the launch count. On that basis the baselines are:

| run | real seeks before death | ffmpeg launches |
|---|---|---|
| run 2 (pre-§6) | **22** | 60 |
| run 3 (post-§6) | **17** | 22 |

Record connection count and abort count alongside it — if a change reduces
failures without reducing connection churn, the mechanism is not what you think it
is.

### 8.1 Attribution — the number that says whether §6 was the mechanism

This pairs every `ffmpeg launched: run@segN` with the segment GETs that were open
across that instant. On the run-2 baseline it prints `IN FLIGHT=22 / NOBODY=38`.
**After the §6 fix, `NOBODY` must be ~0.**

```bash
awk '
function ts2ms(s,  a,b,sec){ split(s,a,"T"); split(a[2],b,":"); sec=b[3]; sub("Z","",sec);
  return (b[1]*3600+b[2]*60+sec)*1000 }
/GET \/hls\/.*\/seg[0-9]+\.ts/ { t=ts2ms($1); match($0,/seg[0-9]+\.ts/); n=substr($0,RSTART+3,RLENGTH-6)+0;
  match($0,/[0-9]+ms/); el=substr($0,RSTART,RLENGTH-2)+0;
  k=++c; RN[k]=n; RE[k]=t; RS_[k]=t-el; next }
/ffmpeg launched: run@seg[0-9]+/ { t=ts2ms($1); match($0,/run@seg[0-9]+/);
  n=substr($0,RSTART+7,RLENGTH-7)+0; L=++lc; LN[L]=n; LT[L]=t }
END{ for(i=1;i<=lc;i++){ f=0; for(j=1;j<=c;j++) if(RN[j]==LN[i]&&RS_[j]<=LT[i]&&RE[j]>=LT[i]){f=1;break}
  if(f)live++; else dead++ }
  printf "launches=%d IN FLIGHT=%d NOBODY=%d\n", lc, live, dead }' /tmp/cg-seek.log
```

**Falsifiability guard, and how it actually resolved.** Connection churn is
receiver-driven — it opens a socket per scan probe and aborts it — so §6 was *not*
predicted to reduce the connection count much. It was predicted to drive `NOBODY`
toward 0, cut ffmpeg launches by roughly 60%, and reduce 500s.

Run 3 printed `launches=22 IN FLIGHT=17 NOBODY=5` — every prediction held (63% →
23% waste, 60 → 22 launches, 19 → 3 five-hundreds) **and the receiver died anyway**.
That is the outcome the guard was written for: the mechanism was real but not
load-bearing. It is recorded as such in §6.1 rather than banked as a win, and it is
what redirected the investigation to `docs/segment-numbering-drift.md`.

**Ask the person at the TV what is on screen**, naming the device, and wait for
the answer before drawing conclusions. If the failure cannot be reproduced at all
on the current build, report that plainly — an unreproducible baseline makes any
fix unfalsifiable.

> Raw logs are not committed: they contain absolute paths to the maintainer's
> media library. Follow the existing convention — describe file *characteristics*
> (codec, resolution, duration, tier), never titles. `NOTES.local.md` (gitignored)
> is where machine-specific detail belongs.

---

## 9. Prompt for the agent picking this up

> You are investigating an open bug in the castgorilla monorepo at the repo root.
> Read `CLAUDE.md` in full first — it contains the project's working agreement and
> a list of hard-won empirical constraints, several of which bear on this work.
> Then read `docs/seek-restart-storm.md` (this file) end to end before writing any
> code.
>
> **STOP — the active work is not in this file.** The root cause was found on
> 2026-07-23 and is documented, with a 60-second reproduction, in
> **`docs/segment-numbering-drift.md`**: on the `video-transcode` tier a
> seek-restart can serve segment N with segment N+1's content, because a fixed 6 s
> boundary grid plus `-noaccurate_seek` makes two adjacent boundaries land on the
> same source keyframe. Read that document and work from its §6. This file is the
> symptom, the hardware protocol, and the list of dead ends.
>
> **The symptom:** on an HLS playback tier, sustained backward scrubbing makes the
> Google Default Media Receiver abandon playback — the TV returns to the
> Chromecast backdrop and the engine reports `receiver reported a playback error`.
> Three contributing bugs are already fixed and must not be re-done: waiters
> stranded ahead of a backward seek (§4) and restarts launched for requests the
> client had already abandoned (§6). **Both were verified to work mechanically and
> neither cured the failure** (§6.1) — they are real bug fixes that were not the
> cause. Do not re-litigate them, and do not assume the next fix will fare better
> just because its mechanism is confirmed: that is exactly the trap §6 fell into.
>
> **Your scope** depends on which document you are working from. For this one:
> `packages/engine/src/hls/session.ts`,
> `packages/engine/src/server/media-server.ts`, and
> `packages/engine/test/hls-*.test.ts`. Do NOT modify
> `packages/engine/src/types/` — it is a FROZEN contract layer. Do not touch the
> app or renderer; this is not a UI problem.
>
> **Before proposing a fix**, confirm the mechanism yourself against the code.
> Section 5 lists four hypotheses already killed by evidence — if you find
> yourself reasoning toward one of them, re-read the evidence in §3 first. The
> log-derived diagnosis in this document has already been wrong twice in ways the
> code settled (a mis-scoped device conclusion, and the "playlist rewrite" claim
> in §3.3), so treat it as well-supported but not sacred: if the code says
> otherwise, say so.
>
> **Then pick one direction from §7 and argue for it** before implementing —
> ideally to the human, since these are genuine trade-offs and option 2 in
> particular degrades the most-felt interaction in the product. Do not implement
> several at once: the only meaningful metric is seeks-survived on real hardware,
> and stacked changes cannot be attributed.
>
> **Constraints that will bite you:**
> - Keep `SupersededError` for supersede rejections, and `RequestAbandonedError`
>   for client-disconnect rejections. `MediaServer` `instanceof`-detects both to
>   log at debug and keep them out of `RouteStats.errors`; a rejection type it
>   does not know would be miscounted as a genuine fault and `diagnoseStall()`
>   would report nonsense to the user. One scrub once produced 75 ERROR lines,
>   all superseded, zero real faults.
> - Do not change the 500 wire status for superseded segments. 500-vs-404 needs
>   its own hardware A/B and is a separate open question.
> - `launchAt` kills the previous ffmpeg first so at most one is ever alive. That
>   invariant is deliberate. If you break it (option 3), you own the consequences
>   for CPU and for the `aliveFfmpegCount` assertions in the tests.
> - The waiter at `newStart` is the request that triggered the restart and must
>   survive any change to `supersedeWaiters`. Cases (j)/(k)/(l) in
>   `hls-session.test.ts` pin this.
> - A forced start (`warmup()` / `ensureStarted()`) has no waiter by definition,
>   so it must stay OUT of the liveness check in `pickLaunchTarget()` — that is
>   what `pendingForced` is for. Liveness-checking it would mean never starting.
> - The full gate is `npx tsc -b && npm run typecheck -w packages/app && npx vitest run`.
>   `tsc -b` alone does NOT cover `packages/app`. Everything must stay green.
> - The HLS integration tests are slow (~21s) and legitimately so. Do not
>   "optimise" them.
>
> **Verification:** unit tests are necessary and insufficient — this bug was
> invisible to the entire suite, including an existing seek-storm test, and the
> §6 cause was invisible to it too. You must validate on real hardware using the
> procedure in §8, and you must ask the human watching the TV what is on screen
> rather than inferring it from the log. Report seeks-survived against the
> baseline of 59, with connection count, abort count and the §8.1 `NOBODY` figure
> alongside.
>
> If you cannot reproduce the failure at all, say so plainly rather than declaring
> it fixed — an unreproducible baseline means any "fix" is unfalsifiable.
