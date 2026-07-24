/**
 * session-lifecycle (integration — real ffmpeg on fixtures + MockCastReceiver):
 * the full pipeline per tier (direct / remux / audio-transcode / video-transcode).
 *
 * Each tier: PlaybackSession.start() → reaches 'playing' (mock pushes PLAYING
 * after LOAD); the exact LoadMediaInformation is asserted (contentType, duration,
 * streamType, hlsSegmentFormat on HLS, contentId host:port); for HLS the live
 * playlist + first segment are fetched over HTTP (200); then stop() leaves no
 * ffmpeg alive, the work dir removed, and the server route unregistered.
 *
 * Plus the LOAD-stall diagnostics: the watchdog names the stalled stage when the
 * receiver acknowledges a LOAD and then never reports a player state, stays
 * silent through healthy playback, and an empty-status LOAD fails start() fast.
 *
 * No real Chromecast: the transport talks to the in-process MockCastReceiver.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockCastReceiver } from './helpers/mock-cast-receiver.js';
import { PlaybackSessionImpl } from '../src/session/playback-session.js';
import { MediaServer } from '../src/server/media-server.js';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { DeviceProfile, DiscoveredDevice, PlaybackPrefs } from '../src/types/index.js';
import type { CastClientOptions } from '../src/cast/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };
const FAST: Partial<CastClientOptions> = {
  heartbeatIntervalMs: 500,
  heartbeatTimeoutMs: 2000,
  requestTimeoutMs: 3000,
  loadTimeoutMs: 10_000,
  connectTimeoutMs: 4000,
  reconnect: { initialMs: 20, maxMs: 100, factor: 2, jitter: 0, maxAttempts: 25 },
};

let ff: FfmpegTools;
beforeAll(async () => {
  ff = await resolveFfmpeg();
});

function makeDevice(host: string, port: number, profile: DeviceProfile = PROFILES.ultra): DiscoveredDevice {
  return {
    id: `test-${port}`,
    friendlyName: 'Test TV',
    model: 'Chromecast Ultra',
    host,
    port,
    profile,
  };
}

/**
 * A doctored profile that POSITIVELY asserts fMP4 HLS support. No shipped
 * profile does — fMP4 wedges the Google Cast Default Media Receiver (2026-07-23,
 * proven on Shield, Chromecast HD, and Apple's own reference fMP4 stream) — so
 * this is how the retained end-to-end fMP4 path stays covered.
 */
function withProvenFmp4(profile: DeviceProfile): DeviceProfile {
  return { ...profile, hls: { ...profile.hls, fmp4: true, segmentFormatFallback: null } };
}

function waitForState(
  session: PlaybackSessionImpl,
  target: string,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (session.status().state === target) return resolve();
    const timer = setTimeout(() => {
      session.off('state', handler);
      reject(new Error(`timeout waiting for state '${target}' (last=${session.status().state})`));
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

interface Harness {
  mock: MockCastReceiver;
  server: MediaServer;
  host: string;
  session: PlaybackSessionImpl;
}

async function startTier(
  file: string,
  opts: {
    arm?: (mock: MockCastReceiver) => void;
    watchdog?: { warnMs?: number; failMs?: number } | false;
    profile?: DeviceProfile;
  } = {},
): Promise<Harness> {
  const mock = new MockCastReceiver({ loadTransitionMs: 15 });
  opts.arm?.(mock);
  const { host, port } = await mock.start();
  const server = new MediaServer();
  await server.listen();
  const device = makeDevice(host, port, opts.profile);
  const session = await PlaybackSessionImpl.start({
    file: path.join(FIX, file),
    device,
    prefs: PREFS,
    server,
    ff,
    cast: FAST,
    ...(opts.watchdog !== undefined ? { watchdog: opts.watchdog } : {}),
  });
  return { mock, server, host, session };
}

/** Resolve on the session's next 'error' event (or reject on timeout). */
function waitForError(session: PlaybackSessionImpl, timeoutMs = 10_000): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('error', handler);
      reject(new Error(`timeout waiting for an 'error' event (state=${session.status().state})`));
    }, timeoutMs);
    const handler = (err: Error): void => {
      clearTimeout(timer);
      session.off('error', handler);
      resolve(err);
    };
    session.on('error', handler);
  });
}

async function teardown(h: Harness): Promise<void> {
  await h.session.stop().catch(() => undefined);
  await h.server.close();
  await h.mock.stop();
}

describe('PlaybackSession lifecycle (integration)', () => {
  it('direct tier (alpha_mp4-h264-aac): reaches playing, LOAD is a direct video/mp4, stop cleans up', async () => {
    const h = await startTier('alpha_mp4-h264-aac.mp4');
    try {
      await waitForState(h.session, 'playing');
      const diag = h.session.diagnostics();

      expect(diag.method).toBe('direct');
      expect(diag.tier).toBe('direct');
      expect(diag.load?.contentType).toBe('video/mp4');
      expect(diag.load?.streamType).toBe('BUFFERED');
      expect(diag.load?.duration).toBeGreaterThan(0);
      expect(diag.load?.hlsSegmentFormat).toBeUndefined();
      expect(diag.load?.contentId).toBe(h.server.urlFor(diag.localPath!, h.host));
      expect(diag.load?.metadata?.title).toBe('alpha_mp4-h264-aac.mp4');
      expect(diag.workDir).toBeUndefined(); // direct play has no ffmpeg work dir

      const localPath = diag.localPath!;
      await h.session.stop();
      expect(h.session.status().state).toBe('stopped');

      // Route unregistered → 404.
      const res = await fetch(`http://127.0.0.1:${h.server.port}${localPath}`);
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('remux tier (delta_mkv-h264-aac): HLS ts copy/copy, serves playlist+seg0, stop kills ffmpeg + removes workdir', async () => {
    const h = await startTier('delta_mkv-h264-aac.mkv');
    try {
      await waitForState(h.session, 'playing');
      const diag = h.session.diagnostics();

      expect(diag.method).toBe('hls');
      expect(diag.tier).toBe('remux');
      expect(diag.load?.contentType).toBe('application/vnd.apple.mpegurl');
      // MPEG-TS is the shipped default (no profile has proven fMP4). The
      // fMP4 LOAD signalling is covered by the fmp4-device test below.
      expect(diag.load?.hlsSegmentFormat).toBe('TS_AAC');
      expect(diag.load?.hlsVideoSegmentFormat).toBe('MPEG2_TS');
      expect(diag.load?.duration).toBeGreaterThan(0);
      expect(diag.load?.contentId).toBe(h.server.urlFor(diag.localPath!, h.host));

      // Fetch the live playlist + first segment off the running server.
      const base = `http://127.0.0.1:${h.server.port}`;
      const pl = await fetch(`${base}${diag.localPath}`);
      expect(pl.status).toBe(200);
      expect(pl.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      const text = await pl.text();
      expect(text).toContain('#EXTM3U');
      expect(text).toContain('seg0.ts');
      // TS playlists are v3 and carry no init segment.
      expect(text).not.toContain('#EXT-X-MAP');

      const segBase = diag.localPath!.replace('/playlist.m3u8', '');
      const seg = await fetch(`${base}${segBase}/seg0.ts`);
      expect(seg.status).toBe(200);
      expect(Number(seg.headers.get('content-length'))).toBeGreaterThan(0);
      await seg.arrayBuffer();

      // Capture the work dir + HlsSession before stop; both must be gone/dead after.
      const workDir = diag.workDir!;
      const hls = h.session.hlsSession!;
      expect(existsSync(workDir)).toBe(true);

      await h.session.stop();
      expect(h.session.status().state).toBe('stopped');
      expect(hls.aliveFfmpegCount).toBe(0);
      expect(existsSync(workDir)).toBe(false);

      const gone = await fetch(`${base}${diag.localPath}`);
      expect(gone.status).toBe(404);
      await gone.text();
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('audio-transcode tier (echo_mkv-h264-dts): HLS video-copy + audio-transcode, serves + cleans up', async () => {
    const h = await startTier('echo_mkv-h264-dts.mkv');
    try {
      await waitForState(h.session, 'playing');
      const diag = h.session.diagnostics();

      expect(diag.method).toBe('hls');
      expect(diag.tier).toBe('audio-transcode');
      expect(diag.load?.contentType).toBe('application/vnd.apple.mpegurl');
      expect(diag.load?.hlsSegmentFormat).toBe('TS_AAC');

      const base = `http://127.0.0.1:${h.server.port}`;
      const pl = await fetch(`${base}${diag.localPath}`);
      expect(pl.status).toBe(200);
      const segBase = diag.localPath!.replace('/playlist.m3u8', '');
      const seg = await fetch(`${base}${segBase}/seg0.ts`);
      expect(seg.status).toBe(200);
      await seg.arrayBuffer();

      const workDir = diag.workDir!;
      const hls = h.session.hlsSession!;
      await h.session.stop();
      expect(hls.aliveFfmpegCount).toBe(0);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('video-transcode tier (oscar_avi-mpeg4-mp3): HLS fixed-grid transcode, serves + cleans up', async () => {
    const h = await startTier('oscar_avi-mpeg4-mp3.avi');
    try {
      await waitForState(h.session, 'playing');
      const diag = h.session.diagnostics();

      expect(diag.method).toBe('hls');
      expect(diag.tier).toBe('video-transcode');
      expect(diag.load?.hlsSegmentFormat).toBe('TS_AAC');

      const base = `http://127.0.0.1:${h.server.port}`;
      const pl = await fetch(`${base}${diag.localPath}`);
      expect(pl.status).toBe(200);
      const segBase = diag.localPath!.replace('/playlist.m3u8', '');
      const seg = await fetch(`${base}${segBase}/seg0.ts`);
      expect(seg.status).toBe(200);
      await seg.arrayBuffer();

      const workDir = diag.workDir!;
      const hls = h.session.hlsSession!;
      await h.session.stop();
      expect(hls.aliveFfmpegCount).toBe(0);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('a device with PROVEN fMP4 still gets the full fMP4 path end to end (init.mp4 + .m4s + FMP4 LOAD hints)', async () => {
    // No shipped profile selects fMP4 any more, but the engine must RETAIN the
    // ability to produce it for a future custom receiver. This is the coverage
    // the three tier tests above used to provide before the default inverted.
    const h = await startTier('delta_mkv-h264-aac.mkv', { profile: withProvenFmp4(PROFILES.ultra) });
    try {
      await waitForState(h.session, 'playing');
      const diag = h.session.diagnostics();

      expect(diag.method).toBe('hls');
      expect(diag.tier).toBe('remux');
      expect(diag.load?.hlsSegmentFormat).toBe('FMP4');
      expect(diag.load?.hlsVideoSegmentFormat).toBe('FMP4');
      expect(diag.load?.duration).toBeGreaterThan(0);

      const base = `http://127.0.0.1:${h.server.port}`;
      const pl = await fetch(`${base}${diag.localPath}`);
      expect(pl.status).toBe(200);
      const text = await pl.text();
      expect(text).toContain('#EXT-X-MAP');
      expect(text).toContain('init.mp4');
      expect(text).toContain('seg0.m4s');

      const segBase = diag.localPath!.replace('/playlist.m3u8', '');
      const init = await fetch(`${base}${segBase}/init.mp4`);
      expect(init.status).toBe(200);
      await init.arrayBuffer();
      const seg = await fetch(`${base}${segBase}/seg0.m4s`);
      expect(seg.status).toBe(200);
      expect(Number(seg.headers.get('content-length'))).toBeGreaterThan(0);
      await seg.arrayBuffer();

      const workDir = diag.workDir!;
      const hls = h.session.hlsSession!;
      await h.session.stop();
      expect(hls.aliveFfmpegCount).toBe(0);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);
});

describe('PlaybackSession LOAD-stall diagnostics', () => {
  it('watchdog: warns then FAILS the session when no player state ever arrives, naming the LAN as the suspect (0 requests served)', async () => {
    const h = await startTier('alpha_mp4-h264-aac.mp4', {
      arm: (m) => m.stallAfterLoad(), // LOAD is acknowledged, playback never starts
      watchdog: { warnMs: 150, failMs: 600 },
    });
    try {
      const warnings: string[] = [];
      h.session.on('warning', (w) => warnings.push(w));
      const errP = waitForError(h.session);

      // Still armed, and no player state seen: the session is genuinely stuck.
      expect(h.session.diagnostics().sawPlayerState).toBe(false);
      expect(h.session.diagnostics().watchdogArmed).toBe(true);
      expect(h.session.status().state).toBe('loading');

      const err = await errP;
      expect(h.session.status().state).toBe('error');
      expect(err.message).toContain('accepted the LOAD but reported no player state');
      // Nothing was ever fetched → the LAN/firewall branch of the diagnosis.
      expect(err.message).toContain('not one HTTP request reached the media server');
      expect(err.message).toContain(String(h.server.port));

      // The 10s-equivalent warning fired first and summarised the server activity.
      expect(warnings.some((w) => /no player state from "Test TV"/.test(w))).toBe(true);
      expect(warnings.some((w) => /served 0 requests/.test(w))).toBe(true);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('watchdog: an HLS stall where the playlist WAS fetched but no segments were blames segment-format signalling', async () => {
    const h = await startTier('delta_mkv-h264-aac.mkv', {
      arm: (m) => m.stallAfterLoad(),
      watchdog: { warnMs: 400, failMs: 1_500 },
    });
    try {
      const errP = waitForError(h.session);
      // Act like a receiver that pulled the playlist and then gave up.
      const pl = await fetch(`http://127.0.0.1:${h.server.port}${h.session.diagnostics().localPath}`);
      expect(pl.status).toBe(200);
      await pl.text();

      const err = await errP;
      expect(err.message).toContain('requested NO segments');
      // The diagnosis quotes the LOAD hints actually sent — TS_AAC / MPEG2_TS
      // since the 2026-07-23 default inversion.
      expect(err.message).toContain('hlsSegmentFormat=TS_AAC');
      expect(err.message).toContain('hlsVideoSegmentFormat=MPEG2_TS');
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('watchdog: stays SILENT through healthy playback even with an aggressive budget, and disarms itself', async () => {
    // A watchdog that fires during normal playback would be worse than none:
    // the mock reaches PLAYING in ~15ms, so 40ms/120ms must never trip.
    const h = await startTier('alpha_mp4-h264-aac.mp4', { watchdog: { warnMs: 40, failMs: 120 } });
    try {
      const warnings: string[] = [];
      const errors: Error[] = [];
      h.session.on('warning', (w) => warnings.push(w));
      h.session.on('error', (e) => errors.push(e));

      await waitForState(h.session, 'playing');
      // Well past both thresholds.
      await new Promise((r) => setTimeout(r, 500));

      expect(errors).toEqual([]);
      expect(warnings.filter((w) => /no player state/.test(w))).toEqual([]);
      expect(h.session.status().state).toBe('playing');
      const diag = h.session.diagnostics();
      expect(diag.sawPlayerState).toBe(true);
      expect(diag.watchdogArmed).toBe(false);
    } finally {
      await teardown(h);
    }
  }, 40_000);

  it('an empty-status LOAD fails start() immediately instead of parking in `loading` forever', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    mock.emptyStatusOnLoad();
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    try {
      await expect(
        PlaybackSessionImpl.start({
          file: path.join(FIX, 'alpha_mp4-h264-aac.mp4'),
          device: makeDevice(host, port),
          prefs: PREFS,
          server,
          ff,
          cast: FAST,
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
    } finally {
      await server.close();
      await mock.stop();
    }
  }, 40_000);
});
