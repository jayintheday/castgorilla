/**
 * session-controls (integration — MockCastReceiver, real ffmpeg where needed):
 *  - seek: an HLS-tier seek passes through 'seeking', the receiver gets the SEEK,
 *    and a far segment fetch drives the HlsSession's single-flight restart.
 *  - reconnect: a mid-playing socket drop → 'reconnecting' → 'playing' again.
 *  - session-lost: killApp + drop → the session goes to 'error' and cleans up.
 *  - refusal: DV P5 media on a dv:false profile rejects start(), leaking nothing.
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
import { PlanRefusedError } from '../src/decide/decision.js';
import type { DiscoveredDevice, MediaInfo, PlaybackPrefs } from '../src/types/index.js';
import type { CastClientOptions } from '../src/cast/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };
const FAST: Partial<CastClientOptions> = {
  heartbeatIntervalMs: 300,
  heartbeatTimeoutMs: 1500,
  requestTimeoutMs: 3000,
  loadTimeoutMs: 10_000,
  connectTimeoutMs: 4000,
  reconnect: { initialMs: 20, maxMs: 100, factor: 2, jitter: 0, maxAttempts: 40 },
};

let ff: FfmpegTools;
beforeAll(async () => {
  ff = await resolveFfmpeg();
});

function makeDevice(host: string, port: number, profileKey: keyof typeof PROFILES = 'ultra'): DiscoveredDevice {
  return { id: `test-${port}`, friendlyName: 'Test TV', model: 'Chromecast Ultra', host, port, profile: PROFILES[profileKey] };
}

function collectStates(session: PlaybackSessionImpl): string[] {
  const seen: string[] = [];
  session.on('state', (s) => seen.push(s));
  return seen;
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

describe('PlaybackSession controls (integration)', () => {
  it('seek: passes through "seeking", receiver gets SEEK, far segment restarts ffmpeg', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    const session = await PlaybackSessionImpl.start({
      file: path.join(FIX, 'foxtrot_mkv-h264-dts-45min.mkv'),
      device: makeDevice(host, port),
      prefs: PREFS,
      server,
      ff,
      cast: FAST,
    });
    try {
      await waitForState(session, 'playing');
      const states = collectStates(session);

      await session.seek(300);
      // The SEEK reply carries the new currentTime and resettles to playing.
      expect(states).toContain('seeking');
      expect(session.status().positionSec).toBeGreaterThan(290);
      expect(session.status().positionSec).toBeLessThan(310);

      // Drive the on-demand HLS far-restart: fetch a segment ~300s in (seg ≈ 50).
      const diag = session.diagnostics();
      const segBase = diag.localPath!.replace('/playlist.m3u8', '');
      const seg = await fetch(`http://127.0.0.1:${server.port}${segBase}/seg50.m4s`);
      expect(seg.status).toBe(200);
      await seg.arrayBuffer();
      // The session relaunched ffmpeg off segment 0 to serve the far segment.
      expect(session.diagnostics().runStart).toBe(50);

      const workDir = diag.workDir!;
      const hls = session.hlsSession!;
      await session.stop();
      expect(hls.aliveFfmpegCount).toBe(0);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      await session.stop().catch(() => undefined);
      await server.close();
      await mock.stop();
    }
  }, 60_000);

  it('reconnect: a mid-playing socket drop recovers to playing', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    const session = await PlaybackSessionImpl.start({
      file: path.join(FIX, 'alpha_mp4-h264-aac.mp4'), // direct — no ffmpeg
      device: makeDevice(host, port),
      prefs: PREFS,
      server,
      ff,
      cast: FAST,
    });
    try {
      await waitForState(session, 'playing');
      const reconnecting = waitForState(session, 'reconnecting', 10_000);
      mock.dropConnection();
      await reconnecting;
      await waitForState(session, 'playing', 15_000);
      expect(session.status().state).toBe('playing');
    } finally {
      await session.stop().catch(() => undefined);
      await server.close();
      await mock.stop();
    }
  }, 40_000);

  it('session-lost: killApp + drop drives the session to error and cleans up', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    const session = await PlaybackSessionImpl.start({
      file: path.join(FIX, 'alpha_mp4-h264-aac.mp4'),
      device: makeDevice(host, port),
      prefs: PREFS,
      server,
      ff,
      cast: FAST,
    });
    try {
      await waitForState(session, 'playing');
      const errored = new Promise<Error>((resolve) => session.on('error', resolve));
      mock.killApp();
      mock.dropConnection();
      const err = await Promise.race([
        errored,
        new Promise<Error>((_, rej) => setTimeout(() => rej(new Error('no error within 15s')), 15_000)),
      ]);
      expect(err).toBeInstanceOf(Error);
      expect(session.status().state).toBe('error');
      expect(session.diagnostics().hasClient).toBe(false); // cleaned up
    } finally {
      await session.stop().catch(() => undefined);
      await server.close();
      await mock.stop();
    }
  }, 40_000);

  it('refusal: DV P5 media on a dv:false profile rejects start() and leaks nothing', async () => {
    const mock = new MockCastReceiver();
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    const media: MediaInfo = {
      path: '/fake/dv.mp4',
      container: 'mp4',
      durationSec: 60,
      video: [
        { index: 0, codec: 'hevc', profile: 'dvhe.05', level: 51, width: 3840, height: 2160, fps: 24, bitDepth: 10, hdr: { type: 'dovi', doviProfile: 5 } },
      ],
      audio: [{ index: 1, codec: 'eac3', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true }],
      subtitles: [],
    };
    try {
      await expect(
        PlaybackSessionImpl.start({
          media,
          device: makeDevice(host, port, 'gen2'), // gen2: hdr.dv === false
          prefs: PREFS,
          server,
          ff,
          cast: FAST,
        }),
      ).rejects.toBeInstanceOf(PlanRefusedError);

      // Nothing was registered on the server (planning threw before prepare()).
      const res = await fetch(`http://127.0.0.1:${server.port}/hls/anything/playlist.m3u8`);
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      await server.close();
      await mock.stop();
    }
  }, 20_000);
});
