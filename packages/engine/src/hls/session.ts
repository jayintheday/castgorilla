/**
 * hls/session.ts — HlsSession: the on-demand HLS producer.
 *
 * One ffmpeg process produces fmp4/ts segments sequentially into a work dir. The
 * session translates the Cast client's segment requests into ffmpeg lifecycle:
 *
 *  - Requests for the segment ffmpeg is about to emit (the "near window") simply
 *    WAIT for the atomic rename (temp_file flag) to land the file.
 *  - Requests far from the play head trigger a SINGLE-FLIGHT restart: ffmpeg is
 *    killed and relaunched (via buildHlsArgs) seeking to that boundary. Rapid
 *    scrubbing is debounced so a burst coalesces to the LAST requested index and
 *    spawns exactly one ffmpeg.
 *  - Already-produced segments (tracked in a Set) serve instantly with no restart.
 *  - A request whose client disconnects while we wait is dropped (its caller
 *    passes an AbortSignal), and a debounced restart whose every candidate has
 *    been dropped that way is NOT launched — otherwise a receiver's scan probes,
 *    which it abandons in ~53ms during a scrub, steer the encoder to positions
 *    the user never lands on. See RequestAbandonedError and pickLaunchTarget().
 *
 * Readiness signal: ffmpeg runs with `-hls_flags …+temp_file`, so a finished
 * segment appears via an atomic rename to its final name. We detect that with
 * fs.watch on the work dir plus an existence re-check (and a low-frequency poll
 * as a backstop against missed watch events).
 *
 * ffmpeg starts lazily on the first getInitSegment()/getSegment(), or eagerly via
 * warmup().
 */

import { existsSync, statSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { PlaybackPlan, MediaInfo, SegmentFormat } from '../types/index.js';
import type { FfmpegTools } from '../ffmpeg/binary.js';
import { createLogger, type Logger } from '../util/logger.js';
import { buildHlsArgs, segmentName, INIT_SEGMENT_NAME } from '../ffmpeg/args.js';
import { FfmpegProcess } from '../ffmpeg/process.js';
import { synthesizeVodPlaylist } from './playlist.js';

/** How near the play head a request must be to WAIT rather than restart. */
const NEAR_WINDOW = 3;
/** Scrub coalescing window: a burst of far requests within this collapses to one restart. */
const RESTART_DEBOUNCE_MS = 250;
/** Max time to wait for a segment/init file to appear before giving up. */
const WAIT_TIMEOUT_MS = 30_000;
/** Backstop poll interval for the readiness scan. */
const POLL_MS = 200;

export interface HlsSessionOpts {
  media: MediaInfo;
  plan: PlaybackPlan;
  /** Absolute segment boundary times (seconds), index-aligned with segment numbers. */
  boundaries: number[];
  /** Path to the source file; resolved to absolute by the constructor (see why there). */
  input: string;
  /** Caller-owned work dir (e.g. a tmp dir). Created if missing; removed on dispose. */
  workDir: string;
  /** Resolved ffmpeg tools (for the binary path). */
  ff: FfmpegTools;
  logger?: Logger;
}

interface Waiter {
  resolve: (p: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Rejection for a segment request that a seek-restart deliberately abandoned.
 *
 * This is ROUTINE CONTROL FLOW, not a fault: when the user scrubs, the receiver
 * can have dozens of segment fetches in flight for the old play head, and
 * supersedeWaiters() drops every one that the new ffmpeg run cannot produce.
 * A single scrub used to emit ~24 `ERROR … failed` lines, which buried real
 * faults and made a working session look broken in the very logs we ask users
 * to send us.
 *
 * It is its own class (rather than a bare Error) purely so the media server can
 * `instanceof`-detect it and downgrade the log to debug + keep it out of the
 * RouteStats.errors counter — exactly how the segment handler already detects
 * the `RangeError` thrown for an out-of-range index. The message text is
 * unchanged; it is genuinely useful at debug level.
 */
export class SupersededError extends Error {
  /** The segment index that was abandoned. */
  readonly segmentIndex: number;
  /** start_number of the ffmpeg run that superseded it. */
  readonly newStartIndex: number;

  constructor(segmentIndex: number, newStartIndex: number) {
    super(`segment ${segmentIndex} superseded by seek to ${newStartIndex}`);
    this.name = 'SupersededError';
    this.segmentIndex = segmentIndex;
    this.newStartIndex = newStartIndex;
  }
}

/**
 * Rejection for a segment request whose CLIENT walked away before it was ready.
 *
 * The distinction from SupersededError is the direction of the decision, and it
 * matters because the two are diagnosed differently:
 *  - SUPERSEDED — *we* dropped the request: a newer seek arrived and the run we
 *    are about to launch cannot serve this index promptly.
 *  - ABANDONED  — *the client* dropped the request: the receiver closed the
 *    socket while we were still waiting. Measured during a scrub, the receiver
 *    holds a scan probe for ~53ms and then walks away — well inside the 250ms
 *    restart debounce — whereas a request it has genuinely settled on is held
 *    for over a second. So an abandoned wait is positive evidence that nobody
 *    wants that segment, and the restart it scheduled must not be launched.
 *
 * Like SupersededError this is ROUTINE CONTROL FLOW, not a fault: MediaServer
 * `instanceof`-detects it, logs at debug and writes nothing (the socket is
 * already gone), so it can never reach RouteStats.errors — the counter
 * diagnoseStall() quotes back to the user.
 */
export class RequestAbandonedError extends Error {
  /** The segment index that was abandoned, or -1 for the init segment. */
  readonly segmentIndex: number;

  constructor(segmentIndex: number) {
    super(
      segmentIndex < 0
        ? 'init segment abandoned: client disconnected before it was ready'
        : `segment ${segmentIndex} abandoned: client disconnected before it was ready`,
    );
    this.name = 'RequestAbandonedError';
    this.segmentIndex = segmentIndex;
  }
}

export class HlsSession {
  private readonly media: MediaInfo;
  private readonly plan: PlaybackPlan;
  private readonly boundaries: number[];
  private readonly input: string;
  private readonly workDir: string;
  private readonly ffTools: FfmpegTools;
  private readonly log: Logger;
  private readonly segFmt: SegmentFormat;

  private ff: FfmpegProcess | undefined;
  /** Every ffmpeg we've spawned that has not yet exited (for leak detection). */
  private readonly spawned: FfmpegProcess[] = [];
  /** start_number of the current ffmpeg run, or -1 when none. */
  private currentRunStart = -1;
  /** Next segment index the current run is expected to emit. */
  private head = -1;
  /** Every segment index that has ever landed on disk. */
  private readonly produced = new Set<number>();

  /**
   * Lifecycle timing for the CURRENT ffmpeg run (logged at info). First-segment
   * latency is the number that says whether a receiver is being starved; the
   * measured baselines on this machine are ~50ms (remux), ~100ms (audio
   * transcode) and ~1000ms (video transcode — the encoder's first frame).
   */
  private runLaunchedAt = 0;
  private loggedInitReady = false;
  private loggedFirstSegment = false;

  /**
   * A restart target that is NOT liveness-checked: it comes from ensureStarted()
   * / warmup(), which legitimately have no waiter parked on them (nothing has
   * asked for a segment yet — we are starting the encoder eagerly). If set, it
   * always wins at flush time.
   */
  private pendingForced: number | undefined;
  /**
   * Debounced restart candidates from scheduleRestart(), most recent LAST and
   * deduped by move-to-end. Walking it backwards at flush time reproduces the
   * old last-write-wins behaviour exactly, while allowing indices whose waiter
   * has gone away to be stepped over. See pickLaunchTarget().
   */
  private readonly pendingOrder: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes launches so at most one ffmpeg is ever alive. */
  private launchLock: Promise<void> = Promise.resolve();
  private starting = false;
  /** Diagnostic counters; see the restartsLaunched / restartsSkipped getters. */
  private launchedCount = 0;
  private skippedCount = 0;

  private readonly waiters = new Map<number, Set<Waiter>>();
  private readonly initWaiters = new Set<Waiter>();
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(opts: HlsSessionOpts) {
    this.media = opts.media;
    this.plan = opts.plan;
    this.boundaries = opts.boundaries;
    // NOT redundant, do not "simplify" away: ffmpeg is spawned with
    // `cwd = workDir` (a fresh temp dir) because this build rejects an absolute
    // -hls_fmp4_init_filename, so every OUTPUT name must be relative. That same
    // cwd is what a relative INPUT would resolve against — ffmpeg would die in
    // ~20ms with "No such file or directory" (code 254), the segment waiters
    // would burn the 30s timeout, and the receiver would spin forever on a
    // stream of 500s. probe() already absolutises MediaInfo.path; this covers
    // every other route into HlsSession (test helpers, mock/canned MediaInfo,
    // future callers) so a relative path can never reach `-i`.
    this.input = path.resolve(opts.input);
    this.workDir = opts.workDir;
    this.ffTools = opts.ff;
    this.log = opts.logger ?? createLogger('hls');
    this.segFmt = opts.plan.segmentFormat ?? 'fmp4';

    mkdirSync(this.workDir, { recursive: true });
    this.startWatch();
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
    this.pollTimer.unref?.();
  }

  // --- public API ---------------------------------------------------------

  /** The synthesized VOD playlist (relative segment URIs, resolved against its URL). */
  playlistText(): string {
    const duration = this.plan.durationSec || this.media.durationSec || 0;
    return synthesizeVodPlaylist(this.boundaries, duration, this.segFmt, '');
  }

  /** Number of segments in the playlist. */
  get segmentCount(): number {
    return this.boundaries.length;
  }

  /** Eagerly start ffmpeg at boundary 0 (optional; otherwise it starts lazily). */
  warmup(): void {
    this.ensureStarted(0);
  }

  /**
   * Path to init.mp4 once ready (fmp4 only).
   *
   * `signal` is the caller's client-disconnect signal (MediaServer aborts it
   * when the receiver drops the socket). fmp4 is not currently selected for any
   * device, so this has no hardware impact today — it exists so the two entry
   * points stay consistent.
   */
  async getInitSegment(signal?: AbortSignal): Promise<string> {
    if (this.segFmt !== 'fmp4') {
      throw new Error('getInitSegment() is only valid for fmp4 segments');
    }
    if (this.disposed) throw new Error('HlsSession disposed');
    if (signal?.aborted) throw new RequestAbandonedError(-1);
    const initPath = path.join(this.workDir, INIT_SEGMENT_NAME);
    if (this.fileReady(initPath)) return initPath;
    this.ensureStarted(0);
    return this.waitForInit(initPath, signal);
  }

  /**
   * Path to seg<i> once ready. Drives ffmpeg lifecycle (wait vs. restart).
   *
   * `signal` is the caller's client-disconnect signal. It is load-bearing, not
   * decorative: a request that has already been abandoned must never reach
   * scheduleRestart(), and one abandoned WHILE waiting must drop its waiter, or
   * a scan probe the receiver held for 53ms will still drag the encoder to a
   * position the user never landed on.
   */
  async getSegment(i: number, signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new Error('HlsSession disposed');
    if (!Number.isInteger(i) || i < 0 || i >= this.boundaries.length) {
      throw new RangeError(`segment index out of range: ${i}`);
    }
    // Before ANY lifecycle decision: a dead request must not arm the debounce.
    if (signal?.aborted) throw new RequestAbandonedError(i);

    // 1. Already on disk → instant.
    if (this.segmentExists(i)) {
      this.produced.add(i);
      return this.segPath(i);
    }

    // 2. Decide: wait on the current run, or (re)start ffmpeg.
    const running = this.ff !== undefined || this.starting;
    const inNearWindow = running && this.head >= 0 && i >= this.head && i <= this.head + NEAR_WINDOW;

    if (!running) {
      // Cold: play from the front if near-0, else seek straight to i.
      if (i <= NEAR_WINDOW) this.ensureStarted(0);
      else this.scheduleRestart(i);
    } else if (!inNearWindow) {
      // Far seek (ahead of the window or behind the head): restart.
      this.scheduleRestart(i);
    }
    // else: near window — just wait for the atomic rename.

    return this.waitForSegment(i, signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = undefined;

    const err = new Error('HlsSession disposed');
    this.rejectAllWaiters(err);

    const ff = this.ff;
    this.ff = undefined;
    if (ff) await ff.kill();

    await rm(this.workDir, { recursive: true, force: true }).catch(() => {
      /* best effort */
    });
  }

  // --- launch / restart ---------------------------------------------------

  /** Lazy first start (immediate, no debounce). No-op if a run exists/pending. */
  private ensureStarted(preferIndex: number): void {
    if (this.disposed) return;
    if (
      this.ff ||
      this.starting ||
      this.pendingForced !== undefined ||
      this.pendingOrder.length > 0 ||
      this.restartTimer
    ) {
      return;
    }
    const start = preferIndex <= NEAR_WINDOW ? 0 : preferIndex;
    this.pendingForced = start;
    this.starting = true;
    this.flushLaunch();
  }

  /** Debounced restart; a burst coalesces to the last STILL-WANTED index. */
  private scheduleRestart(index: number): void {
    if (this.disposed) return;
    const at = this.pendingOrder.indexOf(index);
    if (at >= 0) this.pendingOrder.splice(at, 1); // dedupe by move-to-end
    this.pendingOrder.push(index); // most recent last
    this.starting = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.flushLaunch();
    }, RESTART_DEBOUNCE_MS);
    this.restartTimer.unref?.();
  }

  /**
   * Which index (if any) the next launch should seek to.
   *
   * A forced start (warmup / lazy first start) always wins — nothing is waiting
   * on it by definition, so liveness-checking it would mean never starting.
   *
   * Otherwise walk the debounced candidates from the END, which preserves
   * last-write-wins, and take the newest one that still has a waiter parked on
   * it. The single behavioural change is that DEAD indices are stepped over: a
   * receiver scan probe abandoned inside the debounce window can no longer
   * steer the encoder to a position nobody is watching. If every candidate is
   * dead we return undefined and the caller leaves the running ffmpeg alone,
   * which is the whole point — it keeps producing near where the user is.
   */
  private pickLaunchTarget(): number | undefined {
    if (this.pendingForced !== undefined) return this.pendingForced;
    for (let k = this.pendingOrder.length - 1; k >= 0; k--) {
      const i = this.pendingOrder[k]!;
      if ((this.waiters.get(i)?.size ?? 0) > 0) return i;
    }
    return undefined;
  }

  /** Chain a launch that reads the LATEST live target, so intermediates collapse. */
  private flushLaunch(): void {
    this.launchLock = this.launchLock
      .then(async () => {
        if (this.disposed) return;
        const newest = this.pendingOrder[this.pendingOrder.length - 1];
        const target = this.pickLaunchTarget();
        this.pendingForced = undefined;
        this.pendingOrder.length = 0;
        if (target === undefined) {
          // Nothing to do at all (a debounce that fired after an earlier flush
          // already drained the queue) vs. every candidate abandoned — only the
          // latter is worth a line, and it is the line the hardware run needs
          // to attribute a result.
          if (newest !== undefined) {
            this.skippedCount++;
            this.log.info(
              `restart to seg${newest} skipped — no request still waiting (abandoned during scrub)`,
            );
          }
          return;
        }
        this.launchedCount++;
        await this.launchAt(target);
      })
      .catch((e) => this.log.error('launch failed', e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        // Only clear "starting" once no further launch is queued.
        if (this.pendingOrder.length === 0 && this.pendingForced === undefined) this.starting = false;
      });
  }

  private async launchAt(index: number): Promise<void> {
    // Kill the current run FIRST so at most one ffmpeg is ever alive.
    const prev = this.ff;
    this.ff = undefined;
    if (prev) await prev.kill();
    if (this.disposed) return;

    // Waiters this run cannot satisfy PROMPTLY are stale — those behind the new
    // start (never emitted) and those far ahead of it (reachable only after
    // minutes of encoding, i.e. long past their own 30s timeout). See there.
    this.supersedeWaiters(index);

    const args = buildHlsArgs({
      input: this.input,
      plan: this.plan,
      media: this.media,
      workDir: this.workDir,
      startBoundaryIndex: index,
      boundaries: this.boundaries,
    });

    const proc = new FfmpegProcess({
      ffmpeg: this.ffTools.ffmpeg,
      args,
      cwd: this.workDir,
      logger: this.log.child('ff'),
    });

    proc.on('error', (e) => {
      if (this.ff !== proc) return; // stale process (already replaced)
      this.log.error(
        `ffmpeg run@seg${index} FAILED after ${Date.now() - this.runLaunchedAt}ms: ${e.message}`,
      );
      this.log.error(`ffmpeg stderr tail:\n${proc.stderrTail().slice(-15).join('\n')}`);
      this.rejectAllWaiters(e);
    });
    proc.on('exit', (e) => {
      // A clean kill (restart/dispose) or natural end — nothing to do for the
      // waiters (they're driven by the readiness scan) but the exit code + the
      // stderr tail are exactly what we need when a run dies without producing.
      const idx = this.spawned.indexOf(proc);
      if (idx >= 0) this.spawned.splice(idx, 1);
      if (this.ff !== proc) return; // we killed it deliberately (restart/dispose)
      const elapsed = Date.now() - this.runLaunchedAt;
      if (e.code === 0 && e.signal === null) {
        this.log.info(`ffmpeg run@seg${index} exited cleanly after ${elapsed}ms`);
      } else {
        this.log.error(
          `ffmpeg run@seg${index} exited code=${e.code} signal=${e.signal} after ${elapsed}ms; stderr tail:\n` +
            proc.stderrTail().slice(-15).join('\n'),
        );
      }
    });

    this.spawned.push(proc);
    this.currentRunStart = index;
    this.head = index;
    this.ff = proc;
    this.runLaunchedAt = Date.now();
    this.loggedInitReady = false;
    this.loggedFirstSegment = false;
    proc.start();
    this.log.info(
      `ffmpeg launched: run@seg${index} (t=${(this.boundaries[index] ?? 0).toFixed(3)}s, ` +
        `tier=${this.plan.tier}, segFmt=${this.segFmt}, pid=${proc.pid ?? '?'})`,
    );
    this.scan();
  }

  // --- readiness ----------------------------------------------------------

  private startWatch(): void {
    try {
      this.watcher = watch(this.workDir, () => this.scan());
    } catch (e) {
      // fs.watch can fail on some FSes; the poll backstop still covers us.
      this.log.warn('fs.watch unavailable; relying on poll', e instanceof Error ? e.message : String(e));
    }
  }

  /** Re-check disk: advance the head over contiguous new segments and resolve waiters. */
  private scan(): void {
    if (this.disposed) return;

    // init.mp4 readiness (fmp4 only) — timed whether or not anyone is waiting.
    // Checked BEFORE the segment scan so the log reads in production order.
    const initPath = path.join(this.workDir, INIT_SEGMENT_NAME);
    if (!this.loggedInitReady && this.segFmt === 'fmp4' && this.currentRunStart >= 0) {
      if (this.fileReady(initPath)) {
        this.loggedInitReady = true;
        this.log.info(`init.mp4 ready +${Date.now() - this.runLaunchedAt}ms after ffmpeg launch`);
      }
    }

    // Advance head over contiguous produced segments of the current run.
    if (this.currentRunStart >= 0) {
      while (this.segmentExists(this.head)) {
        this.produced.add(this.head);
        this.head++;
      }
      if (!this.loggedFirstSegment && this.head > this.currentRunStart) {
        this.loggedFirstSegment = true;
        this.log.info(
          `seg${this.currentRunStart} ready +${Date.now() - this.runLaunchedAt}ms after ffmpeg launch ` +
            '(first-segment latency — this is what starves a receiver)',
        );
      }
    }

    // Resolve init waiters.
    if (this.initWaiters.size > 0) {
      if (this.fileReady(initPath)) {
        for (const w of this.initWaiters) {
          clearTimeout(w.timer);
          w.resolve(initPath);
        }
        this.initWaiters.clear();
      }
    }

    // Resolve segment waiters whose file has landed.
    if (this.waiters.size > 0) {
      for (const [idx, set] of this.waiters) {
        if (this.segmentExists(idx)) {
          this.produced.add(idx);
          const p = this.segPath(idx);
          for (const w of set) {
            clearTimeout(w.timer);
            w.resolve(p);
          }
          this.waiters.delete(idx);
        }
      }
    }
  }

  private waitForSegment(i: number, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.segmentExists(i)) {
        this.produced.add(i);
        resolve(this.segPath(i));
        return;
      }
      if (signal?.aborted) {
        reject(new RequestAbandonedError(i));
        return;
      }

      // The listener must come off on EVERY settle path (resolve, reject,
      // timeout, abort). MediaServer's signal lives as long as the request, but
      // a caller holding one long-lived signal across many segments would
      // otherwise accumulate a listener per request.
      let onAbort: (() => void) | undefined;
      const detach = (): void => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      };

      const timer = setTimeout(() => {
        detach();
        this.removeWaiter(i, w);
        reject(new Error(`timeout waiting for segment ${i} (30s)`));
      }, WAIT_TIMEOUT_MS);
      timer.unref?.();
      const w: Waiter = {
        resolve: (p) => {
          detach();
          resolve(p);
        },
        reject: (e) => {
          detach();
          reject(e);
        },
        timer,
      };
      let set = this.waiters.get(i);
      if (!set) {
        set = new Set<Waiter>();
        this.waiters.set(i, set);
      }
      set.add(w);

      if (signal) {
        onAbort = (): void => {
          clearTimeout(timer);
          detach();
          // Dropping the waiter is what makes pickLaunchTarget() skip this
          // index at the next flush.
          this.removeWaiter(i, w);
          reject(new RequestAbandonedError(i));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.scan();
    });
  }

  private waitForInit(initPath: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.fileReady(initPath)) {
        resolve(initPath);
        return;
      }
      if (signal?.aborted) {
        reject(new RequestAbandonedError(-1));
        return;
      }

      let onAbort: (() => void) | undefined;
      const detach = (): void => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      };

      const timer = setTimeout(() => {
        detach();
        this.initWaiters.delete(w);
        reject(new Error('timeout waiting for init segment (30s)'));
      }, WAIT_TIMEOUT_MS);
      timer.unref?.();
      const w: Waiter = {
        resolve: (p) => {
          detach();
          resolve(p);
        },
        reject: (e) => {
          detach();
          reject(e);
        },
        timer,
      };
      this.initWaiters.add(w);

      if (signal) {
        onAbort = (): void => {
          clearTimeout(timer);
          detach();
          this.initWaiters.delete(w);
          reject(new RequestAbandonedError(-1));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.scan();
    });
  }

  /**
   * Reject every waiter that the run starting at `newStart` cannot satisfy
   * PROMPTLY — in BOTH directions. "Promptly" is the operative word: the old
   * guard tested only `idx < newStart`, i.e. direction, and the doc comment's
   * "cannot produce" was therefore wrong above the start index.
   *
   * BELOW `newStart` is the easy half: ffmpeg only ever encodes forward from its
   * `-start_number`, so those indices are never emitted at all.
   *
   * ABOVE `newStart` is the half that killed a real session. A run at seg173
   * *can* technically still emit seg389 — after (389-173) x 6s = ~21.6 minutes
   * of encoding. Nothing waits that long: WAIT_TIMEOUT_MS is 30s, so such a
   * waiter is guaranteed to fail anyway, having first pinned a receiver
   * connection open for 30s. Failing it immediately is strictly better.
   *
   * Observed 2026-07-23: ten backward seeks in eleven seconds (targets 339 396
   * 394 348 324 306 268 254 216 215 183 173) left 63 stranded waiters —
   * min=185, max=389, and ZERO below the final start_number of 173. Every one
   * was ahead of the play head, so the old guard superseded none of them. The
   * receiver then dropped its media session and returned to the backdrop while
   * being served perfectly (last four responses 200 in 896/514/53/42ms, only
   * 7x500 in the whole run). ~63 simultaneously open segment requests is the
   * pathology regardless of which receiver limit it actually tripped.
   *
   * THE READ-AHEAD ALLOWANCE IS `NEAR_WINDOW` (3 segments = 18s of content).
   * Two independent arguments pick the same number:
   *
   *  - Reachability inside the waiter's own timeout. Worst measured cold start
   *    after a restart is ~800ms (1080p HEVC -> H.264, the video-transcode
   *    tier), and that tier sustains at least 1x realtime (test (g): 30s of 4K
   *    encoded in <30s wall). Reaching index newStart+N therefore costs about
   *    0.8s + (N+1) x 6s at 1x realtime:
   *        N=3 -> 0.8 + 24 = 24.8s   (inside the 30s timeout)
   *        N=4 -> 0.8 + 30 = 30.8s   (past it — the waiter would time out
   *                                   anyway, after holding a connection 30s)
   *    So 3 is the largest allowance that is provably satisfiable in the worst
   *    tier we ship. In practice the encoder runs well ahead of realtime (a
   *    later segment served in 3ms while playback fetched at ~6s intervals), so
   *    this is a floor, not a typical case.
   *  - Consistency with getSegment(), which already treats `head + NEAR_WINDOW`
   *    as the edge of "will exist soon": a request beyond it triggers a restart
   *    rather than a wait. A waiter above `newStart + NEAR_WINDOW` is one this
   *    session would never have deliberately parked there.
   *
   * CRITICAL: the waiter at exactly `newStart` is normally the request that
   * TRIGGERED this restart (getSegment() calls scheduleRestart(i) and then
   * synchronously registers its own waiter on i). Rejecting it would break
   * every seek. It is inside the window by construction, since NEAR_WINDOW >= 0.
   *
   * A waiter whose segment is already on disk is never superseded in either
   * direction — the next scan() resolves it for free.
   *
   * Rejections use SupersededError deliberately: MediaServer instanceof-detects
   * it to log at debug and keep it out of RouteStats.errors (which
   * diagnoseStall() quotes back to the user). A fresh error type here would
   * report a healthy scrub as dozens of genuine faults.
   */
  private supersedeWaiters(newStart: number): void {
    const reachableThrough = newStart + NEAR_WINDOW;
    for (const [idx, set] of this.waiters) {
      if (idx >= newStart && idx <= reachableThrough) continue; // satisfiable soon
      if (this.segmentExists(idx)) continue; // already on disk — scan() will resolve it
      const err = new SupersededError(idx, newStart);
      for (const w of set) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiters.delete(idx);
    }
  }

  private rejectAllWaiters(err: Error): void {
    for (const set of this.waiters.values()) {
      for (const w of set) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    }
    this.waiters.clear();
    for (const w of this.initWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.initWaiters.clear();
  }

  private removeWaiter(i: number, w: Waiter): void {
    const set = this.waiters.get(i);
    if (!set) return;
    set.delete(w);
    if (set.size === 0) this.waiters.delete(i);
  }

  // --- helpers ------------------------------------------------------------

  private segPath(i: number): string {
    return path.join(this.workDir, segmentName(i, this.segFmt));
  }

  /**
   * A file is "ready" only when it exists AND is non-empty. Segments arrive via
   * atomic rename (temp_file), so this is belt-and-braces for them — but init.mp4
   * is NOT written atomically (ffmpeg creates it 0-byte, then fills it once the
   * first frame is encoded on the transcode path), so the size guard is what
   * stops us serving an empty init (which a Range request answers with 416).
   */
  private fileReady(p: string): boolean {
    try {
      return statSync(p).size > 0;
    } catch {
      return false;
    }
  }

  private segmentExists(i: number): boolean {
    return this.produced.has(i) || this.fileReady(this.segPath(i));
  }

  /** Test/diagnostic: is an ffmpeg child currently alive? */
  get ffmpegRunning(): boolean {
    return this.ff?.running ?? false;
  }

  /** Test/diagnostic: pid of the current ffmpeg, if any. */
  get ffmpegPid(): number | undefined {
    return this.ff?.pid;
  }

  /** Test/diagnostic: the start_number of the current run. */
  get runStart(): number {
    return this.currentRunStart;
  }

  /**
   * Test/diagnostic: segment indices with at least one waiter parked on them,
   * ascending. Exposed because the failure mode supersedeWaiters() guards
   * against is SILENT — a stranded waiter throws nothing and logs nothing, it
   * just holds a receiver connection open until its 30s timeout. Asserting on
   * rejections alone cannot distinguish "drained" from "still pending".
   */
  get pendingWaiterIndices(): number[] {
    return [...this.waiters.keys()].sort((a, b) => a - b);
  }

  /**
   * Test/diagnostic: how many ffmpeg children this session has alive right now.
   * Single-flight guarantees this is ≤ 1. Precise per-session (unlike a global
   * pgrep, which collides with other test files running in parallel).
   */
  get aliveFfmpegCount(): number {
    return this.spawned.filter((p) => p.running).length;
  }

  /**
   * Test/diagnostic: ffmpeg launches this session actually performed (including
   * the first, lazy/warmup one). Pairs with restartsSkipped: on the run-2
   * hardware trace 38 of 60 launches had NO live request for their target, so
   * the ratio between these two is how a hardware run attributes the fix rather
   * than merely observing that the receiver survived longer.
   */
  get restartsLaunched(): number {
    return this.launchedCount;
  }

  /**
   * Test/diagnostic: debounced restarts dropped because every candidate index
   * had been abandoned by its client before the timer fired. Each one is a
   * running ffmpeg that was NOT killed for a request that no longer existed.
   */
  get restartsSkipped(): number {
    return this.skippedCount;
  }
}
