/**
 * session/playback-session.ts — PlaybackSession: the live state machine that
 * wires probe → plan → prepare (direct/HLS) → connect → LOAD → track playback.
 *
 * One PlaybackSession owns everything for a single playing item:
 *  - a plan (re-derived from media × device profile × prefs, so it can refuse
 *    unplayable content and can resolve real keyframe boundaries for copy tiers),
 *  - the server-side media route (a direct file registration or an HlsSession),
 *  - a CastClient + MediaController driving the Default Media Receiver.
 *
 * State walk (frozen SessionState): probing → planning → preparing → connecting →
 * loading → buffering → playing, with paused/seeking/reconnecting/stopped/error
 * reached from playback. MEDIA_STATUS pushes from the receiver are the source of
 * truth for buffering/playing/paused/ended/error; local commands optimistically
 * set 'loading'/'seeking' and let the reply settle the terminal state.
 *
 * Every exit path — clean stop(), natural end, receiver error, connection loss,
 * or a failed startup — funnels through cleanup(), which disposes the HlsSession
 * (kills ffmpeg + removes its work dir), unregisters the server route, and closes
 * the cast client. No orphan ffmpeg processes or work dirs are left behind.
 *
 * CONNECTION RECOVERY: a laptop that sleeps mid-episode kills the link (this Mac
 * IS the media server, so streaming through the nap is impossible — resuming a
 * few seconds after wake is not). On 'reconnecting' the session says so at info;
 * on 'reconnected' it does NOT simply restore the old state, because the receiver
 * discards the media session across the drop and the old mediaSessionId answers
 * INVALID_MEDIA_SESSION_ID. Recovery is a fresh doLoad() at the last OBSERVED
 * position (`lastPos`, never the wall-clock interpolation — that would add the
 * whole sleep), bounded by MAX_RESUME_ATTEMPTS and refused outright for a session
 * the user stopped or one already cleaned up.
 *
 * LOAD WATCHDOG: a receiver can accept a LOAD and then simply never report a
 * player state, which parks the session in 'loading' with nothing logged and the
 * UI stuck on "loading" forever. After LOAD we therefore arm a two-stage timer:
 * a 'warning' at ~10s and a hard failure at ~45s, both narrated from the media
 * server's per-route counters (MediaServer.statsFor) so the message names the
 * stage that actually stalled — nothing fetched at all (LAN/firewall), playlist
 * fetched but no segments (segment-format signalling), or segments fetched but
 * never played (receiver-side decode). A hang must name itself.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import { TypedEmitter } from '../util/emitter.js';
import { createLogger, type Logger } from '../util/logger.js';
import { probe } from '../probe/ffprobe.js';
import { extractKeyframeIndex } from '../probe/keyframes.js';
import {
  buildPlaybackPlan,
  computeBoundaries,
  computeTranscodeBoundaries,
} from '../decide/decision.js';
import { fixedBoundaries } from '../hls/boundaries.js';
import { HlsSession } from '../hls/session.js';
import { MediaServer, type RouteStats } from '../server/media-server.js';
import { CastClient, MediaController, type CastClientOptions } from '../cast/client.js';
import { resolveSubtitles, pickDefaultTrack } from '../subtitles/resolve.js';
import { SUBTITLE_STYLE } from '../subtitles/style.js';
import type { FfmpegTools } from '../ffmpeg/binary.js';
import type { LoadMediaInformation, MediaStatus, Track } from '../types/cast.js';
import type {
  DiscoveredDevice,
  MediaInfo,
  PlaybackPlan,
  PlaybackPrefs,
  PlaybackSession,
  SessionEvents,
  SessionState,
  SessionStatus,
  SubtitlePlanEntry,
} from '../types/index.js';

const TARGET_SEC = 6;

/** LOAD watchdog: warn if no player state has arrived this long after LOAD. */
const WATCHDOG_WARN_MS = 10_000;
/** LOAD watchdog: fail the session if no player state has arrived this long after LOAD. */
const WATCHDOG_FAIL_MS = 45_000;

/**
 * How many consecutive post-reconnect LOADs may fail before the session gives
 * up and reports a real error. Reset the moment playback is actually observed
 * again, so this bounds a *failing* recovery, not a long-lived session that
 * survives many drops.
 */
const MAX_RESUME_ATTEMPTS = 3;
/** Pause between resume attempts (the receiver may still be settling). */
const RESUME_RETRY_MS = 1000;

/** Tunable LOAD-watchdog thresholds (tests inject fast values; `false` disables). */
export interface WatchdogOptions {
  warnMs?: number;
  failMs?: number;
}

/** Options for PlaybackSession.start(). Engine.play() maps PlayOptions onto this. */
export interface SessionStartOptions {
  device: DiscoveredDevice;
  prefs: PlaybackPrefs;
  server: MediaServer;
  ff: FfmpegTools;
  /** Pre-probed media. If omitted, `file` is probed. */
  media?: MediaInfo;
  /** Source file — required when `media` is not supplied. */
  file?: string;
  /**
   * A caller-supplied plan (e.g. from Engine.plan()). Advisory only: the session
   * re-derives the authoritative plan from media × profile × prefs so it can
   * resolve keyframe boundaries and refuse unplayable content at play time.
   */
  plan?: PlaybackPlan;
  logger?: Logger;
  /** CastClient tuning (timeouts / reconnect) — the tests inject fast values. */
  cast?: Partial<CastClientOptions>;
  /** Initial audio stream override (absolute ffprobe index). */
  audioStreamIndex?: number;
  /** Start position in seconds. */
  startSec?: number;
  /** Explicit extra sidecar subtitle files (e.g. the CLI's `--sub <path>`). */
  extraSubtitlePaths?: string[];
  /**
   * LOAD watchdog thresholds. Omit for the 10s/45s defaults; pass `false` to
   * disable it entirely (nothing in the product does — the tests do).
   */
  watchdog?: WatchdogOptions | false;
}

/** Read-only diagnostics for tests / debugging (not part of the frozen surface). */
export interface SessionDiagnostics {
  state: SessionState;
  method: PlaybackPlan['method'] | undefined;
  tier: PlaybackPlan['tier'] | undefined;
  workDir: string | undefined;
  localPath: string | undefined;
  contentId: string | undefined;
  aliveFfmpegCount: number;
  ffmpegRunning: boolean;
  runStart: number;
  segmentCount: number;
  hasClient: boolean;
  cleaned: boolean;
  mediaSessionId: number | undefined;
  /** The exact LoadMediaInformation last sent to the receiver. */
  load: LoadMediaInformation | undefined;
  /** LOAD watchdog: still armed (no usable playerState seen yet)? */
  watchdogArmed: boolean;
  /** LOAD watchdog: has a MEDIA_STATUS with a usable playerState arrived? */
  sawPlayerState: boolean;
  /** Consecutive failed post-reconnect resume LOADs (0 once playback resumes). */
  resumeAttempts: number;
  /** A post-reconnect resume is in flight. */
  resuming: boolean;
  /** Last position observed from a MEDIA_STATUS (the resume anchor). */
  lastObservedPositionSec: number;
  /** What the media server has served for this session's route. */
  serverStats: RouteStats | undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** h:mm:ss / m:ss — log lines about position must be readable at a glance. */
function formatPos(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Promise sleep whose timer never keeps the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export class PlaybackSessionImpl extends TypedEmitter<SessionEvents> implements PlaybackSession {
  readonly id: string;

  private readonly device: DiscoveredDevice;
  private readonly prefs: PlaybackPrefs;
  private readonly server: MediaServer;
  private readonly ff: FfmpegTools;
  private readonly castOpts: Partial<CastClientOptions>;
  private readonly log: Logger;
  private readonly startSec: number;

  private file: string | undefined;
  private media: MediaInfo | undefined;
  private plan: PlaybackPlan | undefined;
  private keyframePts: number[] | undefined;
  private audioOverride: number | undefined;

  // Server-side media (either a direct registration or an HlsSession).
  private hls: HlsSession | undefined;
  private workDir: string | undefined;
  private routeId: string | undefined;
  private localPath: string | undefined;
  private contentId: string | undefined;
  private loadGen = 0;

  // Subtitles (WS5): resolved WebVTT tracks + their server routes.
  private readonly extraSubtitlePaths: string[] | undefined;
  private subWorkDir: string | undefined;
  private subRouteIds: string[] = [];
  private subtitleEntries: SubtitlePlanEntry[] = [];
  private defaultSubTrackId: number | null = null;

  // Cast transport.
  private client: CastClient | undefined;
  private controller: MediaController | undefined;
  private lastLoad: LoadMediaInformation | undefined;

  // Observable state.
  private _state: SessionState = 'probing';
  private prevState: SessionState = 'probing';
  private durationSec = 0;
  private volume = 1;
  private muted = false;
  private activeSub: number | null = null;
  private activeAudio = -1;
  private readonly warnings: string[] = [];

  // Position interpolation anchor.
  private lastPos = 0;
  private lastPosWall = 0;
  private posTimer: ReturnType<typeof setInterval> | undefined;

  // LOAD watchdog.
  private readonly watchdogWarnMs: number;
  private readonly watchdogFailMs: number;
  private watchdogTimers: Array<ReturnType<typeof setTimeout>> = [];
  private watchdogArmedAt = 0;
  /** True once a MEDIA_STATUS carrying a usable playerState has arrived. */
  private sawPlayerState = false;

  // Post-reconnect recovery.
  private resumeAttempts = 0;
  private resuming = false;
  /** Set by stop(): a session the user ended must never be resumed. */
  private stoppedByUser = false;

  private cleaned = false;

  private constructor(opts: SessionStartOptions) {
    super();
    this.id = `ss-${randomUUID().slice(0, 8)}`;
    this.device = opts.device;
    this.prefs = opts.prefs;
    this.server = opts.server;
    this.ff = opts.ff;
    this.castOpts = opts.cast ?? {};
    this.log = (opts.logger ?? createLogger('castgorilla')).child(`session:${this.id}`);
    this.file = opts.file;
    this.media = opts.media;
    this.plan = opts.plan;
    this.audioOverride = opts.audioStreamIndex;
    this.startSec = opts.startSec ?? 0;
    this.extraSubtitlePaths = opts.extraSubtitlePaths;
    if (opts.watchdog === false) {
      this.watchdogWarnMs = 0;
      this.watchdogFailMs = 0;
    } else {
      this.watchdogWarnMs = opts.watchdog?.warnMs ?? WATCHDOG_WARN_MS;
      this.watchdogFailMs = opts.watchdog?.failMs ?? WATCHDOG_FAIL_MS;
    }
    if (!this.media && !this.file) {
      throw new Error('PlaybackSession.start requires either `media` or `file`');
    }
  }

  /** Probe → plan → prepare → connect → LOAD. Rejects (after cleanup) on any failure. */
  static async start(opts: SessionStartOptions): Promise<PlaybackSessionImpl> {
    const session = new PlaybackSessionImpl(opts);
    try {
      await session.run();
    } catch (err) {
      await session.cleanup();
      session._state = 'error';
      throw err;
    }
    return session;
  }

  // --- Startup pipeline -----------------------------------------------------

  private async run(): Promise<void> {
    // 1 — probe.
    this.setState('probing');
    if (!this.media) this.media = await probe(this.file!);
    const media = this.media;
    this.durationSec = media.durationSec;

    // 2 — plan (authoritative; throws PlanRefusedError on unplayable content).
    this.setState('planning');
    let plan = this.planFor(media, this.audioOverride);
    if (this.needsKeyframes(plan)) {
      this.keyframePts = await extractKeyframeIndex(media.path, plan.videoStreamIndex);
      plan = this.planFor(media, this.audioOverride);
    }
    this.applyPlanWarnings(plan);

    // 3 — prepare the server-side media (direct file or HLS session).
    this.setState('preparing');
    // Resolve + publish subtitle tracks first, then attach them to the plan so
    // the LOAD carries TEXT tracks (works for direct-play AND HLS alike).
    await this.resolveSubtitleTracks(media);
    plan.subtitles = this.subtitleEntries;
    await this.prepare(plan);
    this.activeAudio = plan.audioStreamIndex;
    this.activeSub = this.defaultSubTrackId;

    // 4 — connect to the device + launch the Default Media Receiver.
    this.setState('connecting');
    const client = await CastClient.connect(this.device.host, {
      ...this.castOpts,
      port: this.device.port,
      logger: this.log.child('cast'),
    });
    this.client = client;
    this.attachClientEvents(client);
    const controller = await client.launchDefaultMediaReceiver();
    this.controller = controller;
    controller.on('status', (s) => this.onMediaStatus(s));

    // 5 — LOAD.
    await this.doLoad(this.startSec);
  }

  /** Build a plan for `media`, threading the current keyframe index + audio override. */
  private planFor(media: MediaInfo, audioStreamIndex: number | undefined): PlaybackPlan {
    const plan = buildPlaybackPlan(media, this.device.profile, this.prefs, {
      ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
      ...(this.keyframePts && this.keyframePts.length > 0 ? { keyframePts: this.keyframePts } : {}),
    });
    // The planner leaves subtitles empty; carry the session's resolved tracks so
    // an audio-switch re-plan (selectAudioStream) keeps the same TEXT tracks.
    plan.subtitles = this.subtitleEntries;
    return plan;
  }

  /**
   * EVERY HLS tier needs a real keyframe index to segment on.
   *
   * This used to be gated on `plan.video.kind === 'copy'`, on the reasoning
   * that only a copy has to start its segments on a source keyframe. A
   * transcode does not — but a seek-RESTART does: `-noaccurate_seek` enters the
   * file at the preceding source keyframe whatever the plan says, so a
   * transcode boundary that is not a keyframe is a boundary ffmpeg can never
   * start at, and `-start_number` mislabels the run (see
   * docs/segment-numbering-drift.md).
   *
   * Note the gate cannot be "plan is in keyframe mode": the planner only emits
   * keyframe mode for a transcode ONCE it has been given an index, so gating on
   * the mode would never trigger the extraction that produces it. Cost of
   * asking unconditionally: a header-only demux scan, measured at 0.43s for a
   * 45-minute file.
   */
  private needsKeyframes(plan: PlaybackPlan): boolean {
    if (plan.method !== 'hls') return false;
    return !(this.keyframePts && this.keyframePts.length > 0);
  }

  private applyPlanWarnings(plan: PlaybackPlan): void {
    const next: string[] = [];
    if (plan.hdrOutcome === 'washed-out-warning') {
      next.push('HDR content will be tone-mapped to SDR (may look washed out)');
    }
    for (const reason of plan.reasons) {
      if (/pathological GOP|demoting/i.test(reason)) next.push(reason);
    }
    for (const w of next) {
      if (!this.warnings.includes(w)) {
        this.warnings.push(w);
        this.emit('warning', w);
      }
    }
  }

  // --- Server-side media ----------------------------------------------------

  private async prepare(plan: PlaybackPlan): Promise<void> {
    await this.teardownMedia();
    const media = this.media!;
    const id = `${this.id}-${this.loadGen++}`;
    this.routeId = id;

    if (plan.method === 'direct') {
      this.localPath = this.server.registerDirect(id, media.path, plan.contentType);
    } else {
      const boundaries = this.resolveBoundaries(plan);
      const workDir = await mkdtemp(join(tmpdir(), 'ss-session-'));
      this.workDir = workDir;
      const hls = new HlsSession({
        media,
        plan,
        boundaries,
        input: media.path,
        workDir,
        ff: this.ff,
        logger: this.log.child('hls'),
      });
      this.hls = hls;
      this.localPath = this.server.registerHls(id, hls);
      hls.warmup(); // start ffmpeg now so seg0 is ready ASAP
    }

    this.contentId = this.server.urlFor(this.localPath, this.device.host);
    this.plan = plan;
  }

  /**
   * The boundary list the HlsSession and the synthesized playlist share.
   *
   * The planner normally decides this and puts it in `plan.segmentation`; the
   * recompute branch only fires for a plan that reached us in keyframe mode
   * without boundaries (a test double, or a re-plan racing the extraction).
   * Note the two tiers need DIFFERENT functions and must not be collapsed —
   * a copy passes every source keyframe through to the muxer, a transcode gets
   * to choose its own, and computeTranscodeBoundaries() guarantees the minimum
   * spacing that choice depends on.
   *
   * THE FALLBACK, deliberately. `fixedBoundaries()` is reached only when there
   * is no keyframe index at all — ffprobe failed, or the container reports no
   * keyframe flags. It is the grid that caused the segment-numbering drift, so
   * it is no longer trusted on its own:
   *  - video-transcode: buildHlsArgs() switches this case to an ACCURATE seek,
   *    which makes the first output frame the boundary exactly, so numbering is
   *    correct again at the cost of decoding (not encoding) up to one GOP.
   *  - copy tiers: there is no equivalent trick — a copied segment must begin on
   *    a source keyframe and we do not know where those are. The stream is
   *    still watchable, but a seek-restart can serve a segment whose content
   *    starts up to a GOP early. Warn loudly rather than fail: a degraded play
   *    beats no play, and the warning is what makes the log readable afterwards.
   */
  private resolveBoundaries(plan: PlaybackPlan): number[] {
    const dur = plan.durationSec || this.durationSec;
    if (plan.segmentation?.mode === 'keyframe') {
      if (plan.segmentation.boundaries && plan.segmentation.boundaries.length > 0) {
        return plan.segmentation.boundaries;
      }
      if (this.keyframePts && this.keyframePts.length > 0) {
        return plan.video.kind === 'copy'
          ? computeBoundaries(this.keyframePts, dur, TARGET_SEC)
          : computeTranscodeBoundaries(this.keyframePts, dur, TARGET_SEC);
      }
    }
    if (plan.method === 'hls') {
      this.log.warn(
        `no keyframe index for this file — falling back to a fixed ${TARGET_SEC}s segment grid` +
          (plan.video.kind === 'transcode'
            ? ' (restarts will use an accurate seek to keep segment numbering correct)'
            : ' (a seek-restart may serve a segment that starts up to one GOP early)'),
      );
    }
    return fixedBoundaries(dur, TARGET_SEC);
  }

  private async teardownMedia(): Promise<void> {
    const hls = this.hls;
    this.hls = undefined;
    if (this.routeId) {
      this.server.unregister(this.routeId);
      this.routeId = undefined;
    }
    if (hls) await hls.dispose();
    this.workDir = undefined;
    this.localPath = undefined;
    this.contentId = undefined;
  }

  // --- Subtitles ------------------------------------------------------------

  /**
   * Resolve embedded + sidecar subtitles into local WebVTT files, publish each as
   * a server route, and record the absolute-URL SubtitlePlanEntry list + default
   * selection. Never throws — subtitle trouble must not sink playback.
   */
  private async resolveSubtitleTracks(media: MediaInfo): Promise<void> {
    try {
      const workDir = await mkdtemp(join(tmpdir(), 'ss-subs-'));
      this.subWorkDir = workDir;
      const { resolved, unsupported } = await resolveSubtitles({
        media,
        mediaPath: media.path,
        workDir,
        prefs: this.prefs,
        ffmpeg: this.ff.ffmpeg,
        logger: this.log,
        ...(this.extraSubtitlePaths ? { extraSidecarPaths: this.extraSubtitlePaths } : {}),
      });

      const entries: SubtitlePlanEntry[] = [];
      for (const r of resolved) {
        // The .vtt suffix keeps the advertised URL looking like a VTT file for
        // receivers that sniff subtitle format by extension.
        const routeId = `${this.id}-sub${r.entry.trackId}.vtt`;
        const local = this.server.registerFile(routeId, r.entry.localPath, 'text/vtt');
        this.subRouteIds.push(routeId);
        // CRITICAL: advertise an ABSOLUTE URL — trackContentId is sent verbatim.
        const url = this.server.urlFor(local, this.device.host);
        const entry: SubtitlePlanEntry = {
          trackId: r.entry.trackId,
          url,
          label: r.entry.label,
          source: r.entry.source,
        };
        if (r.entry.language !== undefined) entry.language = r.entry.language;
        entries.push(entry);
      }
      this.subtitleEntries = entries;
      this.defaultSubTrackId = pickDefaultTrack(resolved, this.prefs.preferredSubLang);

      if (unsupported.length > 0) {
        this.addWarning(`${unsupported.length} bitmap subtitle track(s) not supported in v1`);
      }
    } catch (e) {
      this.log.warn(
        'subtitle resolution failed; continuing without subtitles:',
        e instanceof Error ? e.message : String(e),
      );
      this.subtitleEntries = [];
      this.defaultSubTrackId = null;
    }
  }

  /** Unregister every VTT route and remove the subtitle work dir. */
  private async teardownSubtitles(): Promise<void> {
    for (const id of this.subRouteIds) this.server.unregister(id);
    this.subRouteIds = [];
    const dir = this.subWorkDir;
    this.subWorkDir = undefined;
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private addWarning(w: string): void {
    if (this.warnings.includes(w)) return;
    this.warnings.push(w);
    this.emit('warning', w);
  }

  // --- LOAD -----------------------------------------------------------------

  private async doLoad(currentTime: number): Promise<void> {
    this.setState('loading');
    const loadMedia = this.buildLoadMedia();
    this.lastLoad = loadMedia;
    const opts: { autoplay: boolean; currentTime?: number; activeTrackIds?: number[] } = {
      autoplay: true,
    };
    if (currentTime > 0) opts.currentTime = currentTime;
    const active = this.activeSub !== null ? [this.activeSub] : [];
    if (active.length > 0) opts.activeTrackIds = active;
    await this.controller!.load(loadMedia, opts);
    // The initial + subsequent MEDIA_STATUS pushes drive buffering → playing.
    // If they never come, the watchdog is what turns silence into a diagnosis.
    this.armLoadWatchdog();
  }

  // --- LOAD watchdog --------------------------------------------------------

  /**
   * Arm the two-stage post-LOAD timer. Cleared by the first MEDIA_STATUS that
   * carries a usable playerState (see noteMediaStatus) and by cleanup().
   */
  private armLoadWatchdog(): void {
    this.clearLoadWatchdog();
    if (this.cleaned) return;
    if (this.watchdogFailMs <= 0 && this.watchdogWarnMs <= 0) return;
    this.sawPlayerState = false;
    this.watchdogArmedAt = Date.now();

    const schedule = (ms: number, fn: () => void): void => {
      if (ms <= 0) return;
      const t = setTimeout(() => {
        if (this.cleaned || this.sawPlayerState) return;
        fn();
      }, ms);
      // A diagnostic timer must never hold the process open.
      t.unref?.();
      this.watchdogTimers.push(t);
    };

    schedule(this.watchdogWarnMs, () => {
      const msg =
        `no player state from "${this.device.friendlyName}" ` +
        `${Math.round((Date.now() - this.watchdogArmedAt) / 1000)}s after LOAD — ${this.describeServerActivity()}`;
      this.log.warn(msg);
      this.addWarning(msg);
    });

    schedule(this.watchdogFailMs, () => {
      const msg =
        `playback never started: the receiver "${this.device.friendlyName}" accepted the LOAD but ` +
        `reported no player state within ${Math.round(this.watchdogFailMs / 1000)}s. ${this.diagnoseStall()}`;
      this.log.error(msg);
      void this.handleError(new Error(msg));
    });
  }

  private clearLoadWatchdog(): void {
    for (const t of this.watchdogTimers) clearTimeout(t);
    this.watchdogTimers = [];
  }

  /**
   * A MEDIA_STATUS carrying a playerState means the receiver IS talking to us —
   * except a bare IDLE with no terminal idleReason, which leaves the session in
   * 'loading' and is precisely the silence we are watching for.
   */
  private noteMediaStatus(s: MediaStatus): void {
    if (s.playerState === undefined) return;
    if (s.playerState === 'IDLE' && s.idleReason !== 'FINISHED' && s.idleReason !== 'ERROR') return;
    this.sawPlayerState = true;
    // The receiver is talking to us again: a recovery that got this far
    // succeeded, so the resume budget starts over for the next drop.
    this.resumeAttempts = 0;
    this.clearLoadWatchdog();
  }

  /** Counters for the route this session is currently advertising. */
  private serverStats(): RouteStats | undefined {
    return this.routeId ? this.server.statsFor(this.routeId) : undefined;
  }

  private static totalRequests(s: RouteStats): number {
    return s.playlist + s.init + s.segments + s.other;
  }

  /** One-line summary of what the device has fetched so far (for the 10s warning). */
  private describeServerActivity(): string {
    const s = this.serverStats();
    if (!s) return 'the media route is no longer registered';
    const total = PlaybackSessionImpl.totalRequests(s);
    if (total === 0) return `the media server has served 0 requests for ${this.contentId}`;
    return (
      `the media server has served ${total} request(s): playlist=${s.playlist} init=${s.init} ` +
      `segments=${s.segments} other=${s.other} errors=${s.errors} bytes=${s.bytes}; ` +
      `last=${s.lastPath} from ${s.lastRemote}`
    );
  }

  /** The discriminating diagnosis used when the watchdog fails the session. */
  private diagnoseStall(): string {
    const s = this.serverStats();
    const url = this.contentId ?? '(no content URL)';
    if (!s) {
      return `The media route was already unregistered, so nothing can be said about ${url}.`;
    }
    const total = PlaybackSessionImpl.totalRequests(s);
    if (total === 0) {
      return (
        `The device never requested ${url} — not one HTTP request reached the media server. ` +
        `Suspect the advertised LAN address or a firewall: check that ${this.device.host} can reach ` +
        `this host on port ${this.server.port} (pickLanIp picked the interface for ${this.device.host}), ` +
        'and on macOS that the app holds the local-network permission.'
      );
    }
    const method = this.plan?.method ?? 'direct';
    if (method === 'hls') {
      if (s.playlist === 0) {
        return (
          `The device made ${total} request(s) (last ${s.lastPath} from ${s.lastRemote}) but never ` +
          `fetched the playlist ${url}. Errors so far: ${s.errors}.`
        );
      }
      if (s.segments === 0) {
        const fmt = this.lastLoad?.hlsSegmentFormat ?? '(unset)';
        const vfmt = this.lastLoad?.hlsVideoSegmentFormat ?? '(unset)';
        return (
          `The device fetched the playlist ${s.playlist}x (and init ${s.init}x) from ${s.lastRemote} ` +
          `but requested NO segments. Suspect segment-format signalling ` +
          `(hlsSegmentFormat=${fmt}, hlsVideoSegmentFormat=${vfmt}) or a receiver that rejected the ` +
          'playlist — try the TS variant against this device.'
        );
      }
      return (
        `The device fetched playlist=${s.playlist} init=${s.init} segments=${s.segments} ` +
        `(${s.bytes} bytes, ${s.errors} error response(s)) from ${s.lastRemote} but never reported a ` +
        'player state — the media reached it and it still would not play (receiver-side decode or ' +
        'container refusal).'
      );
    }
    return (
      `The device made ${total} request(s) for the direct file (${s.bytes} bytes, ${s.errors} error ` +
      `response(s), last ${s.lastPath} from ${s.lastRemote}) but never reported a player state.`
    );
  }

  private buildLoadMedia(): LoadMediaInformation {
    const plan = this.plan!;
    const media: LoadMediaInformation = {
      contentId: this.contentId!,
      contentType: plan.contentType,
      streamType: 'BUFFERED',
      // fMP4 HLS carries no moov duration — ALWAYS send the known duration.
      duration: plan.durationSec || this.durationSec,
      metadata: { metadataType: 0, title: basename(this.media!.path) },
      tracks: this.buildTracks(plan),
    };
    if (plan.subtitles.length > 0) media.textTrackStyle = SUBTITLE_STYLE;
    if (plan.method === 'hls') {
      const fmt = plan.segmentFormat ?? 'fmp4';
      if (fmt === 'fmp4') {
        // Forgetting these is the classic fMP4-HLS-on-Cast failure.
        media.hlsSegmentFormat = 'FMP4';
        media.hlsVideoSegmentFormat = 'FMP4';
      } else {
        media.hlsSegmentFormat = 'TS_AAC';
        media.hlsVideoSegmentFormat = 'MPEG2_TS';
      }
    }
    return media;
  }

  /** Map plan.subtitles → Cast TEXT tracks (WS5: resolveSubtitleTracks fills them). */
  private buildTracks(plan: PlaybackPlan): Track[] {
    return plan.subtitles.map((s) => {
      const t: Track = {
        trackId: s.trackId,
        type: 'TEXT',
        trackContentId: s.url,
        trackContentType: 'text/vtt',
        subtype: 'SUBTITLES',
        name: s.label,
      };
      if (s.language !== undefined) t.language = s.language;
      return t;
    });
  }

  // --- Cast transport events ------------------------------------------------

  private attachClientEvents(client: CastClient): void {
    // ALWAYS attach 'error' — an unhandled cast error would otherwise throw.
    client.on('error', (err) => void this.handleError(err));
    client.on('reconnecting', () => {
      if (this.cleaned) return;
      if (this._state !== 'reconnecting') this.prevState = this._state;
      this.log.info(
        `cast connection to "${this.device.friendlyName}" dropped while ${this.prevState} — ` +
          `recovering, last known position ${formatPos(this.lastPos)}`,
      );
      this.setState('reconnecting');
    });
    client.on('reconnected', () => {
      if (this.cleaned) return;
      this.log.info('cast transport restored');
      void this.resumeAfterReconnect();
    });
    client.on('session-lost', () =>
      void this.handleError(new Error('cast session lost: the receiver app is gone')),
    );
  }

  /**
   * Recover playback after the transport came back.
   *
   * A restored socket is NOT restored playback: a receiver that survives the
   * drop routinely discards its media session, so the old mediaSessionId is
   * dead (INVALID_REQUEST / INVALID_MEDIA_SESSION_ID) and nothing plays. The
   * only recovery is a fresh LOAD — at the LAST OBSERVED position, which is
   * `lastPos` and never `currentPosition()`: the interpolator adds wall-clock
   * time since the last MEDIA_STATUS, and after a laptop sleep that is the
   * whole nap. Resuming a 49-minute episode at 0:00 (or at 3:00:00) is the
   * bug this guards against.
   *
   * Bounded: MAX_RESUME_ATTEMPTS consecutive failures end in a real error
   * rather than an invisible retry loop. Never runs for a session the user
   * stopped, one already cleaned up, or one already in a terminal state.
   */
  private async resumeAfterReconnect(): Promise<void> {
    if (this.cleaned || this.stoppedByUser || this.resuming) return;
    if (this._state === 'stopped' || this._state === 'error') return;
    if (!this.controller) return;

    const pos = this.durationSec > 0 ? clamp(this.lastPos, 0, this.durationSec) : Math.max(0, this.lastPos);
    this.resuming = true;
    try {
      let lastErr: Error | undefined;
      for (;;) {
        if (this.cleaned || this.stoppedByUser || !this.controller) return;
        const attempt = ++this.resumeAttempts;
        if (attempt > MAX_RESUME_ATTEMPTS) {
          const why = lastErr ? `: ${lastErr.message}` : '';
          const msg =
            `could not resume playback on "${this.device.friendlyName}" after ` +
            `${MAX_RESUME_ATTEMPTS} attempt(s) at ${formatPos(pos)}${why}`;
          this.log.error(msg);
          await this.handleError(new Error(msg));
          return;
        }
        this.log.info(
          `resuming playback on "${this.device.friendlyName}" at ${formatPos(pos)} ` +
            `(attempt ${attempt}/${MAX_RESUME_ATTEMPTS})`,
        );
        try {
          // Reuse the ordinary LOAD path (and its watchdog) — the receiver
          // discarded our media session, so this is a genuinely new one.
          await this.doLoad(pos);
          this.log.info(`resume LOAD accepted at ${formatPos(pos)}; waiting for the receiver to play`);
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          this.log.warn(
            `resume attempt ${attempt}/${MAX_RESUME_ATTEMPTS} failed:`,
            lastErr.message,
          );
          await sleep(RESUME_RETRY_MS);
        }
      }
    } finally {
      this.resuming = false;
    }
  }

  private onMediaStatus(s: MediaStatus): void {
    if (this.cleaned) return;
    this.noteMediaStatus(s);
    if (s.volume) {
      if (typeof s.volume.level === 'number') this.volume = s.volume.level;
      if (typeof s.volume.muted === 'boolean') this.muted = s.volume.muted;
    }
    if (typeof s.currentTime === 'number') {
      this.lastPos = s.currentTime;
      this.lastPosWall = Date.now();
    }
    switch (s.playerState) {
      case 'BUFFERING':
        this.setState('buffering');
        break;
      case 'PLAYING':
        this.setState('playing');
        this.ensurePositionTimer();
        break;
      case 'PAUSED':
        this.setState('paused');
        break;
      case 'IDLE':
        if (s.idleReason === 'FINISHED') void this.handleEnded();
        else if (s.idleReason === 'ERROR') void this.handleError(new Error('receiver reported a playback error'));
        // CANCELLED / INTERRUPTED accompany our own STOP / a re-LOAD — ignore.
        break;
    }
  }

  // --- Controls (frozen PlaybackSession surface) ----------------------------

  async pause(): Promise<void> {
    if (this.cleaned || !this.controller) return;
    await this.controller.pause();
  }

  async resume(): Promise<void> {
    if (this.cleaned || !this.controller) return;
    await this.controller.play();
  }

  async seek(positionSec: number): Promise<void> {
    if (this.cleaned || !this.controller) return;
    const target = clamp(positionSec, 0, this.durationSec > 0 ? this.durationSec : positionSec);
    this.setState('seeking');
    this.lastPos = target;
    this.lastPosWall = Date.now();
    this.emit('position', target);
    await this.controller.seek(target);
    // The SEEK reply's MEDIA_STATUS settles the state back to playing/paused.
  }

  /** Seek by a relative delta, clamped to [0, duration]. */
  async seekBy(deltaSec: number): Promise<void> {
    await this.seek(this.currentPosition() + deltaSec);
  }

  async setVolume(volume: number): Promise<void> {
    if (this.cleaned || !this.client) return;
    const level = clamp(volume, 0, 1);
    const st = await this.client.receiver.setVolume(level, undefined);
    this.volume = st.volume?.level ?? level;
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.cleaned || !this.client) return;
    const st = await this.client.receiver.setVolume(undefined, muted);
    this.muted = st.volume?.muted ?? muted;
  }

  async selectSubtitleTrack(trackId: number | null): Promise<void> {
    this.activeSub = trackId;
    if (this.cleaned || !this.controller) return;
    // EDIT_TRACKS_INFO — a no-op safe today (no tracks), effective once WS5 fills them.
    await this.controller.setActiveTracks(trackId === null ? [] : [trackId]).catch((e) => {
      this.log.debug('setActiveTracks failed (no tracks yet?):', e instanceof Error ? e.message : String(e));
    });
  }

  async selectAudioStream(index: number): Promise<void> {
    if (this.cleaned || !this.media || !this.controller) return;
    if (index === this.activeAudio) return;
    const pos = this.currentPosition();
    this.audioOverride = index;
    this.setState('loading');

    let plan = this.planFor(this.media, index);
    if (this.needsKeyframes(plan) && (!this.keyframePts || this.keyframePts.length === 0)) {
      this.keyframePts = await extractKeyframeIndex(this.media.path, plan.videoStreamIndex);
      plan = this.planFor(this.media, index);
    }
    await this.prepare(plan);
    this.activeAudio = plan.audioStreamIndex;
    this.applyPlanWarnings(plan);
    await this.doLoad(pos);
  }

  async stop(): Promise<void> {
    if (this.cleaned) return;
    // Latch BEFORE the awaits below: a reconnect that lands mid-teardown must
    // not resurrect a session the user deliberately ended.
    this.stoppedByUser = true;
    // Best-effort graceful teardown of the receiver-side session first.
    try {
      await this.controller?.stop();
    } catch {
      /* device may already be gone */
    }
    try {
      const sess = this.client?.getSession();
      if (sess) await this.client!.receiver.stopApp(sess.sessionId);
    } catch {
      /* best effort */
    }
    await this.cleanup();
    this.setState('stopped');
  }

  // --- Status ---------------------------------------------------------------

  status(): SessionStatus {
    return {
      state: this._state,
      positionSec: this.currentPosition(),
      durationSec: this.durationSec,
      volume: this.volume,
      muted: this.muted,
      tier: this.plan?.tier ?? 'direct',
      deviceName: this.device.friendlyName,
      activeSubtitleTrackId: this.activeSub,
      activeAudioStreamIndex: this.activeAudio,
      warnings: [...this.warnings],
    };
  }

  /** Position interpolated from the last MEDIA_STATUS anchor while playing. */
  private currentPosition(): number {
    let p = this.lastPos;
    if (this._state === 'playing' && this.lastPosWall > 0) {
      p += (Date.now() - this.lastPosWall) / 1000;
    }
    if (this.durationSec > 0) p = Math.min(p, this.durationSec);
    return Math.max(0, p);
  }

  /** Test/diagnostic snapshot (not part of the frozen surface). */
  diagnostics(): SessionDiagnostics {
    return {
      state: this._state,
      method: this.plan?.method,
      tier: this.plan?.tier,
      workDir: this.workDir,
      localPath: this.localPath,
      contentId: this.contentId,
      aliveFfmpegCount: this.hls?.aliveFfmpegCount ?? 0,
      ffmpegRunning: this.hls?.ffmpegRunning ?? false,
      runStart: this.hls?.runStart ?? -1,
      segmentCount: this.hls?.segmentCount ?? 0,
      hasClient: this.client !== undefined,
      cleaned: this.cleaned,
      mediaSessionId: this.controller?.mediaSessionId,
      load: this.lastLoad,
      watchdogArmed: this.watchdogTimers.length > 0,
      sawPlayerState: this.sawPlayerState,
      resumeAttempts: this.resumeAttempts,
      resuming: this.resuming,
      lastObservedPositionSec: this.lastPos,
      serverStats: this.serverStats(),
    };
  }

  /** Test/diagnostic: the live HlsSession (undefined for direct play or after cleanup). */
  get hlsSession(): HlsSession | undefined {
    return this.hls;
  }

  // --- Terminal transitions -------------------------------------------------

  private async handleEnded(): Promise<void> {
    if (this.cleaned) return;
    await this.cleanup();
    this.setState('stopped');
    this.emit('ended');
  }

  private async handleError(err: Error): Promise<void> {
    if (this.cleaned) return;
    await this.cleanup();
    this.setState('error');
    this.emitError(err);
  }

  /** Dispose the HLS session (kills ffmpeg + rm work dir), unregister route, close client. */
  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    this.clearLoadWatchdog();
    if (this.posTimer) {
      clearInterval(this.posTimer);
      this.posTimer = undefined;
    }
    await this.teardownMedia();
    await this.teardownSubtitles();
    const client = this.client;
    this.client = undefined;
    this.controller = undefined;
    try {
      client?.close();
    } catch {
      /* ignore */
    }
  }

  // --- Helpers --------------------------------------------------------------

  private setState(state: SessionState): void {
    if (this._state === state) return;
    // The state machine used to change silently, which is why a whole
    // reconnect cycle left no trace in the log at all.
    this.log.debug(`state ${this._state} -> ${state}`);
    this._state = state;
    this.emit('state', state);
  }

  private ensurePositionTimer(): void {
    if (this.posTimer) return;
    this.posTimer = setInterval(() => {
      if (this._state === 'playing') this.emit('position', this.currentPosition());
    }, 1000);
    this.posTimer.unref?.();
  }

  /** Emit 'error' only when a listener is attached (Node throws on a bare 'error'). */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.log.error('session error (no listener attached):', err);
  }
}
