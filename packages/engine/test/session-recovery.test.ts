/**
 * session-recovery (integration — MockCastReceiver, no ffmpeg): what happens to
 * a playing session when the link dies and comes back — the laptop-idle-sleep
 * case from 2026-07-23.
 *
 * The bug this pins down: the reconnect machinery DID run and DID succeed, but
 * it logged nothing on the success path and the session merely restored its old
 * state, so a 49-minute episode "just stopped" with a single WARN in the log and
 * every later command answered INVALID_MEDIA_SESSION_ID (the receiver keeps the
 * app but discards the media session across a long outage).
 *
 * Covered here:
 *  - a dropped connection visibly attempts recovery (info logs, 'reconnecting');
 *  - after the transport is back a FRESH LOAD is issued at the LAST KNOWN
 *    POSITION, not 0;
 *  - recovery is bounded: a receiver that keeps refusing ends in a real error
 *    after MAX_RESUME_ATTEMPTS, not an infinite re-LOAD loop;
 *  - a session the user stopped (or one already cleaned up) never resumes.
 *
 * Media is a synthetic 49-minute direct-play MediaInfo, so these tests never
 * touch ffmpeg or the disk — they are about the transport, not the pipeline.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { MockCastReceiver } from './helpers/mock-cast-receiver.js';
import { PlaybackSessionImpl } from '../src/session/playback-session.js';
import { MediaServer } from '../src/server/media-server.js';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { Logger, LogLevel } from '../src/util/logger.js';
import type { DiscoveredDevice, MediaInfo, PlaybackPrefs } from '../src/types/index.js';
import type { CastClientOptions } from '../src/cast/client.js';

const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

const FAST: Partial<CastClientOptions> = {
  heartbeatIntervalMs: 300,
  heartbeatTimeoutMs: 1500,
  requestTimeoutMs: 3000,
  loadTimeoutMs: 5000,
  connectTimeoutMs: 4000,
  reconnect: { initialMs: 30, maxMs: 120, factor: 2, jitter: 0, maxAttempts: 25 },
};

/** A 49-minute H.264/AAC episode — direct play on every profile, no ffmpeg. */
const EPISODE: MediaInfo = {
  path: '/fake/episode-49min.mp4',
  container: 'mp4',
  durationSec: 2940,
  video: [
    {
      index: 0,
      codec: 'h264',
      profile: 'High',
      level: 40,
      width: 1920,
      height: 1080,
      fps: 25,
      bitDepth: 8,
      hdr: { type: 'none' },
    },
  ],
  audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
  subtitles: [],
};

let ff: FfmpegTools;
beforeAll(async () => {
  ff = await resolveFfmpeg();
});

interface LogLine {
  level: string;
  namespace: string;
  text: string;
}

/** A Logger that records instead of writing, so tests can assert observability. */
function recordingLogger(lines: LogLine[], namespace = ''): Logger {
  const fmt = (a: unknown): string => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a));
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push({ level, namespace, text: args.map(fmt).join(' ') });
    };
  return {
    level: 'debug' as LogLevel,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: (child: string) => recordingLogger(lines, namespace ? `${namespace}:${child}` : child),
  };
}

function makeDevice(host: string, port: number): DiscoveredDevice {
  return { id: `test-${port}`, friendlyName: 'Test TV', model: 'Chromecast Ultra', host, port, profile: PROFILES.ultra };
}

interface Harness {
  mock: MockCastReceiver;
  server: MediaServer;
  session: PlaybackSessionImpl;
  logs: LogLine[];
}

async function startHarness(cast: Partial<CastClientOptions> = FAST): Promise<Harness> {
  const mock = new MockCastReceiver({ loadTransitionMs: 15 });
  const { host, port } = await mock.start();
  const server = new MediaServer();
  await server.listen();
  const logs: LogLine[] = [];
  const session = await PlaybackSessionImpl.start({
    media: EPISODE,
    device: makeDevice(host, port),
    prefs: PREFS,
    server,
    ff,
    cast,
    logger: recordingLogger(logs),
  });
  return { mock, server, session, logs };
}

async function teardown(h: Harness): Promise<void> {
  await h.session.stop().catch(() => undefined);
  await h.server.close();
  await h.mock.stop();
}

function waitForState(session: PlaybackSessionImpl, target: string, timeoutMs = 20_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (session.status().state === target) return resolve();
    const timer = setTimeout(() => {
      session.off('state', handler);
      reject(new Error(`timeout waiting for '${target}' (last=${session.status().state})`));
    }, timeoutMs);
    const handler = (st: string): void => {
      if (st === target) {
        clearTimeout(timer);
        session.off('state', handler);
        resolve();
      }
    };
    session.on('state', handler);
  });
}

function waitForError(session: PlaybackSessionImpl, timeoutMs = 25_000): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('error', handler);
      reject(new Error(`timeout waiting for 'error' (state=${session.status().state})`));
    }, timeoutMs);
    const handler = (err: Error): void => {
      clearTimeout(timer);
      session.off('error', handler);
      resolve(err);
    };
    session.on('error', handler);
  });
}

const said = (logs: LogLine[], level: string, re: RegExp): boolean =>
  logs.some((l) => l.level === level && re.test(l.text));

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds (the reconnect narration lands a tick after the state flips). */
async function waitUntil(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await delay(20);
  }
}

describe('PlaybackSession connection recovery', () => {
  it('a dropped connection visibly attempts recovery: reconnecting state + info logs naming the attempt', async () => {
    const h = await startHarness();
    try {
      await waitForState(h.session, 'playing');
      h.logs.length = 0; // only what the drop produces

      const reconnecting = waitForState(h.session, 'reconnecting', 10_000);
      h.mock.dropConnection();
      await reconnecting;

      // The session says what happened, in English, at info — this is the line
      // whose absence made the sleep failure read as "it just stopped".
      expect(said(h.logs, 'info', /cast connection to "Test TV" dropped while playing/)).toBe(true);
      // And the client narrates the retry loop itself.
      expect(said(h.logs, 'info', /reconnecting to 127\.0\.0\.1:\d+ \(up to \d+ attempts\)/)).toBe(true);

      await waitUntil(
        () => said(h.logs, 'info', /reconnected after \d+ attempt\(s\) in \d+ms/),
        'the reconnect outcome to be logged',
        15_000,
      );
      expect(said(h.logs, 'info', /reconnect attempt 1\/\d+ \(after \d+ms backoff\)/)).toBe(true);
      await waitForState(h.session, 'playing', 15_000);
      expect(h.session.status().state).toBe('playing');
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('after reconnect a FRESH LOAD is issued at the last known position, not 0', async () => {
    const h = await startHarness();
    try {
      await waitForState(h.session, 'playing');
      expect(h.mock.loads).toHaveLength(1);
      expect(h.mock.loads[0]!.currentTime).toBeUndefined(); // started at 0

      // 25 minutes into a 49-minute episode, as the receiver last told us.
      h.mock.pushMediaStatus({ playerState: 'PLAYING', currentTime: 1500 });
      await delay(50);
      expect(h.session.diagnostics().lastObservedPositionSec).toBe(1500);

      // The nap: the receiver keeps the app but throws the media session away,
      // so the old mediaSessionId is dead and only a new LOAD can recover.
      h.mock.discardMediaSession();
      const reconnecting = waitForState(h.session, 'reconnecting', 10_000);
      h.mock.dropConnection();
      await reconnecting;

      await waitForState(h.session, 'playing', 20_000);

      expect(h.mock.loads).toHaveLength(2);
      const resume = h.mock.loads[1]!;
      expect(resume.currentTime).toBe(1500); // NOT 0, and NOT clamped to the end
      expect(resume.autoplay).toBe(true);
      expect(resume.contentId).toBe(h.mock.loads[0]!.contentId);
      expect(said(h.logs, 'info', /resuming playback on "Test TV" at 25:00 \(attempt 1\/3\)/)).toBe(true);
      // Recovery completed, so the budget is back for the next drop.
      expect(h.session.diagnostics().resumeAttempts).toBe(0);
      expect(h.session.diagnostics().resuming).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('the resume position is the LAST OBSERVED currentTime, never the wall-clock interpolation', async () => {
    // The interpolator advances position while 'playing'; across a real sleep it
    // would advance by the whole nap. The anchor must be the last MEDIA_STATUS.
    const h = await startHarness();
    try {
      await waitForState(h.session, 'playing');
      h.mock.pushMediaStatus({ playerState: 'PLAYING', currentTime: 600 });
      await delay(1200); // wall clock moves on; no further MEDIA_STATUS arrives

      h.mock.discardMediaSession();
      const reconnecting = waitForState(h.session, 'reconnecting', 10_000);
      h.mock.dropConnection();
      await reconnecting;
      await waitForState(h.session, 'playing', 20_000);

      expect(h.mock.loads).toHaveLength(2);
      // Exactly the observed anchor — not 600 + elapsed.
      expect(h.mock.loads[1]!.currentTime).toBe(600);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('recovery is BOUNDED: a receiver that keeps refusing the LOAD ends in a real error, not a loop', async () => {
    const h = await startHarness();
    try {
      await waitForState(h.session, 'playing');
      h.mock.pushMediaStatus({ playerState: 'PLAYING', currentTime: 900 });
      await delay(50);

      // Every LOAD from here on is answered with an empty MEDIA_STATUS: the
      // receiver accepts the request and creates no media session.
      h.mock.emptyStatusOnLoad();
      h.mock.discardMediaSession();

      const errP = waitForError(h.session);
      h.mock.dropConnection();
      const err = await errP;

      expect(err.message).toContain('could not resume playback on "Test TV"');
      expect(err.message).toContain('after 3 attempt(s) at 15:00');
      expect(h.session.status().state).toBe('error');
      expect(h.session.diagnostics().cleaned).toBe(true);

      // 1 initial LOAD + exactly 3 bounded resume attempts, then it stopped.
      expect(h.mock.loads).toHaveLength(4);
      await delay(1500);
      expect(h.mock.loads).toHaveLength(4);
      expect(said(h.logs, 'warn', /resume attempt 3\/3 failed/)).toBe(true);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('a session the user stopped is never resumed, even with a reconnect in flight', async () => {
    // Slow first backoff so stop() reliably lands while the client is retrying.
    const h = await startHarness({ ...FAST, reconnect: { initialMs: 800, maxMs: 800, factor: 1, jitter: 0, maxAttempts: 25 } });
    try {
      await waitForState(h.session, 'playing');
      h.mock.pushMediaStatus({ playerState: 'PLAYING', currentTime: 1200 });
      await delay(50);
      expect(h.mock.loads).toHaveLength(1);

      const reconnecting = waitForState(h.session, 'reconnecting', 10_000);
      h.mock.discardMediaSession();
      h.mock.dropConnection();
      await reconnecting;

      // The user hits stop while recovery is still in flight.
      await h.session.stop();
      expect(h.session.status().state).toBe('stopped');

      // Well past several backoff windows: nothing was ever re-LOADed.
      await delay(2500);
      expect(h.mock.loads).toHaveLength(1);
      expect(h.session.status().state).toBe('stopped');
      expect(said(h.logs, 'info', /resuming playback/)).toBe(false);
      expect(h.session.diagnostics().resuming).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('a cleaned-up session (already errored) does not resume on a later reconnect', async () => {
    const h = await startHarness();
    try {
      await waitForState(h.session, 'playing');
      expect(h.mock.loads).toHaveLength(1);

      // killApp + drop → 'session-lost' → the session errors and cleans up.
      const errP = waitForError(h.session, 20_000);
      h.mock.killApp();
      h.mock.dropConnection();
      await errP;
      expect(h.session.status().state).toBe('error');
      expect(h.session.diagnostics().cleaned).toBe(true);

      // Any further link churn must not raise the dead.
      h.mock.dropConnection();
      await delay(1500);
      expect(h.mock.loads).toHaveLength(1);
      expect(h.session.status().state).toBe('error');
      expect(said(h.logs, 'info', /resuming playback/)).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);
});
