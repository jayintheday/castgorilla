/**
 * subs-session (integration — real ffmpeg + MockCastReceiver): subtitles wired
 * through the live PlaybackSession, following the session-lifecycle pattern.
 *
 * Playing mike_mkv-h264-subs.mkv:
 *  - the LOAD carries 4 TEXT tracks with ABSOLUTE http .vtt URLs, the default
 *    textTrackStyle, and activeTrackIds = [1] (the default-flagged embedded sub).
 *  - one advertised VTT URL is fetched off the live server → 200 + WEBVTT + CORS.
 *  - selectSubtitleTrack(2) drives EDIT_TRACKS_INFO → the receiver holds [2];
 *    selectSubtitleTrack(null) → [].
 *  - stop() unregisters the VTT routes → 404.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockCastReceiver } from './helpers/mock-cast-receiver.js';
import { PlaybackSessionImpl } from '../src/session/playback-session.js';
import { MediaServer } from '../src/server/media-server.js';
import { SUBTITLE_STYLE } from '../src/subtitles/style.js';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { DiscoveredDevice, PlaybackPrefs } from '../src/types/index.js';
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

function makeDevice(host: string, port: number): DiscoveredDevice {
  return { id: `test-${port}`, friendlyName: 'Test TV', model: 'Chromecast Ultra', host, port, profile: PROFILES.ultra };
}

/** Read the mock receiver's currently-held activeTrackIds (private field). */
function mockActiveTrackIds(mock: MockCastReceiver): number[] {
  return (mock as unknown as { media?: { activeTrackIds: number[] } }).media?.activeTrackIds ?? [];
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

describe('PlaybackSession subtitles (integration)', () => {
  it('LOADs 4 TEXT tracks, serves VTT, switches + turns off tracks, cleans up on stop', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    const { host, port } = await mock.start();
    const server = new MediaServer();
    await server.listen();
    const device = makeDevice(host, port);

    const session = await PlaybackSessionImpl.start({
      file: path.join(FIX, 'mike_mkv-h264-subs.mkv'),
      device,
      prefs: PREFS,
      server,
      ff,
      cast: FAST,
    });

    try {
      await waitForState(session, 'playing');
      const diag = session.diagnostics();
      const tracks = diag.load?.tracks ?? [];

      // 4 TEXT tracks, all with absolute http .vtt URLs + text/vtt content type.
      expect(tracks).toHaveLength(4);
      for (const t of tracks) {
        expect(t.type).toBe('TEXT');
        expect(t.subtype).toBe('SUBTITLES');
        expect(t.trackContentType).toBe('text/vtt');
        expect(t.trackContentId).toMatch(/^http:\/\/.+\.vtt$/);
      }
      expect(tracks.map((t) => t.trackId)).toEqual([1, 2, 3, 4]);

      // The default textTrackStyle rode along, and the default sub (track 1) is active.
      expect(diag.load?.textTrackStyle).toEqual(SUBTITLE_STYLE);
      expect(session.status().activeSubtitleTrackId).toBe(1);
      expect(mockActiveTrackIds(mock)).toEqual([1]);

      // Fetch one advertised VTT off the live server (via loopback + its path).
      const url = new URL(tracks[0]!.trackContentId!);
      const res = await fetch(`http://127.0.0.1:${server.port}${url.pathname}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const body = await res.text();
      expect(body.startsWith('WEBVTT')).toBe(true);

      // Switch to track 2 → the receiver holds [2].
      await session.selectSubtitleTrack(2);
      expect(session.status().activeSubtitleTrackId).toBe(2);
      expect(mockActiveTrackIds(mock)).toEqual([2]);

      // Turn subtitles off → empty activeTrackIds.
      await session.selectSubtitleTrack(null);
      expect(session.status().activeSubtitleTrackId).toBeNull();
      expect(mockActiveTrackIds(mock)).toEqual([]);

      // stop() unregisters the VTT routes → 404.
      await session.stop();
      const gone = await fetch(`http://127.0.0.1:${server.port}${url.pathname}`);
      expect(gone.status).toBe(404);
      await gone.text();
    } finally {
      await session.stop().catch(() => undefined);
      await server.close();
      await mock.stop();
    }
  }, 40_000);
});
