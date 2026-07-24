/**
 * server-media (integration): the full path a real Cast client walks —
 *  - MediaServer routes an HlsSession's playlist / init / segments with correct
 *    content-types and 404s out-of-range segments;
 *  - per-route request counters (statsFor) attribute every fetch to the right
 *    resource kind — this is what lets a stalled session say WHAT the device did;
 *  - a segment abandoned by a seek-restart is accounted as routine control flow
 *    (debug log, NOT counted in errors) while a genuine failure still is not;
 *  - a client that disconnects mid-wait drains its waiter AND cancels the ffmpeg
 *    restart it had armed (the end-to-end proof the AbortSignal is wired);
 *  - (f) a real HLS client (ffmpeg) decodes 8s straight off the live server URL.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { HlsSession, SupersededError } from '../src/hls/session.js';
import { MediaServer } from '../src/server/media-server.js';
import { fixedBoundaries } from '../src/hls/boundaries.js';
import type { MediaInfo, PlaybackPlan, VideoAction, AudioAction } from '../src/types/index.js';
import type { Logger } from '../src/util/logger.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

let ff: FfmpegTools;
const cleanups: Array<() => Promise<void>> = [];
const sessionsList: HlsSession[] = [];

beforeAll(async () => {
  ff = await resolveFfmpeg();
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  // No stray session ffmpeg — per-session so parallel test files don't collide.
  for (const s of sessionsList.splice(0)) expect(s.aliveFfmpegCount).toBe(0);
});

function baseMedia(file: string, durationSec: number, w = 1920, h = 1080): MediaInfo {
  return {
    path: path.join(FIX, file),
    container: 'mkv',
    durationSec,
    video: [{ index: 0, codec: 'h264', width: w, height: h, fps: 30, bitDepth: 8, hdr: { type: 'none' } }],
    audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    subtitles: [],
  };
}

function hlsPlan(video: VideoAction, audio: AudioAction, durationSec: number): PlaybackPlan {
  return {
    method: 'hls', tier: 'video-transcode', reasons: [], video, audio,
    videoStreamIndex: 0, audioStreamIndex: 1, segmentFormat: 'fmp4',
    contentType: 'application/vnd.apple.mpegurl', durationSec, hdrOutcome: 'preserved', subtitles: [],
  };
}

async function setup(id: string, video: VideoAction, audio: AudioAction): Promise<{ server: MediaServer; base: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), `ss-srv-${id}-`));
  const m = baseMedia('delta_mkv-h264-aac.mkv', 60.021);
  const bounds = fixedBoundaries(m.durationSec, 6);
  const session = new HlsSession({ media: m, plan: hlsPlan(video, audio, m.durationSec), boundaries: bounds, input: m.path, workDir: dir, ff });
  sessionsList.push(session);
  const server = new MediaServer();
  const port = await server.listen();
  server.registerHls(id, session);
  cleanups.push(async () => {
    server.unregister(id);
    await session.dispose();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { server, base: `http://127.0.0.1:${port}/hls/${id}` };
}

/** Captures every log line with its level, using the sink pattern from hls-session.test.ts. */
function logSink(): { lines: Array<{ level: string; text: string }>; sink: Logger; at(level: string): string[] } {
  const lines: Array<{ level: string; text: string }> = [];
  const push = (level: string) => (...a: unknown[]): void => {
    lines.push({ level, text: a.map(String).join(' ') });
  };
  const sink: Logger = {
    level: 'debug',
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
    debug: push('debug'),
    trace: push('trace'),
    child: () => sink,
  };
  return { lines, sink, at: (level) => lines.filter((l) => l.level === level).map((l) => l.text) };
}

/**
 * Minimal HlsSession stand-in whose getSegment() fails on demand, so BOTH failure
 * modes can be induced deterministically side by side. That the REAL session
 * rejects with SupersededError is proved separately by hls-session.test.ts (e),
 * and end-to-end over HTTP by the live-scrub test below.
 */
function stubSession(fail: (i: number) => Error): HlsSession {
  return {
    playlistText: () => '#EXTM3U\n#EXT-X-ENDLIST\n',
    segmentCount: 1,
    warmup: () => undefined,
    getInitSegment: () => Promise.reject(new Error('stub: no init')),
    getSegment: (i: number) => Promise.reject(fail(i)),
    dispose: () => Promise.resolve(),
  } as unknown as HlsSession;
}

describe('MediaServer + HlsSession', () => {
  it('serves playlist / init / segment with correct content-types; 404 out-of-range', async () => {
    const { base } = await setup('movie', { kind: 'copy' }, { kind: 'copy' });

    const pl = await fetch(`${base}/playlist.m3u8`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(pl.headers.get('access-control-allow-origin')).toBe('*');
    const text = await pl.text();
    expect(text).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(text).toContain('seg0.m4s');

    const init = await fetch(`${base}/init.mp4`);
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toBe('video/mp4');
    expect(Number(init.headers.get('content-length'))).toBeGreaterThan(0);

    const seg = await fetch(`${base}/seg0.m4s`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('video/iso.segment');
    expect(seg.headers.get('accept-ranges')).toBe('bytes');
    expect(Number(seg.headers.get('content-length'))).toBeGreaterThan(0);

    // out-of-range segment index → 404
    const oob = await fetch(`${base}/seg9999.m4s`);
    expect(oob.status).toBe(404);
  }, 30_000);

  it('counts every request per resource kind (statsFor); unknown ids and unregistered routes are not counted', async () => {
    const { server, base } = await setup('counters', { kind: 'copy' }, { kind: 'copy' });

    // Nothing fetched yet.
    const zero = server.statsFor('counters');
    expect(zero).toBeDefined();
    expect(zero).toMatchObject({ playlist: 0, init: 0, segments: 0, other: 0, errors: 0, bytes: 0 });
    expect(zero?.lastPath).toBeUndefined();
    expect(zero?.firstAt).toBeUndefined();

    await (await fetch(`${base}/playlist.m3u8`)).text();
    await (await fetch(`${base}/init.mp4`)).arrayBuffer();
    await (await fetch(`${base}/seg0.m4s`)).arrayBuffer();
    await (await fetch(`${base}/seg1.m4s`)).arrayBuffer();
    // Out of range → a 404, still a segment request.
    await (await fetch(`${base}/seg9999.m4s`)).text();
    // An unknown sub-path under a known id lands in `other`.
    await (await fetch(`${base}/nonsense`)).text();
    // Give the server's response 'close' handlers a tick to record bytes/errors.
    await new Promise((r) => setTimeout(r, 100));

    const s = server.statsFor('counters');
    expect(s).toBeDefined();
    expect(s?.playlist).toBe(1);
    expect(s?.init).toBe(1);
    expect(s?.segments).toBe(3); // seg0 + seg1 + the out-of-range one
    expect(s?.other).toBe(1);
    expect(s?.errors).toBe(2); // seg9999 and /nonsense both 404
    expect(s?.bytes).toBeGreaterThan(0);
    expect(s?.lastPath).toBe('/hls/counters/nonsense');
    expect(s?.lastRemote).toMatch(/^.+:\d+$/);
    expect(s?.firstAt).toBeTypeOf('number');
    expect(s?.lastAt).toBeGreaterThanOrEqual(s!.firstAt!);

    // Ids we never registered have no stats at all.
    expect(server.statsFor('no-such-id')).toBeUndefined();

    // After unregister the stats are gone too (the route no longer exists).
    server.unregister('counters');
    expect(server.statsFor('counters')).toBeUndefined();
  }, 30_000);

  it('counts a direct registration under `other` and records the requester', async () => {
    const server = new MediaServer();
    const port = await server.listen();
    cleanups.push(async () => {
      await server.close();
    });
    const local = server.registerDirect('direct-1', path.join(FIX, 'alpha_mp4-h264-aac.mp4'), 'video/mp4');

    const res = await fetch(`http://127.0.0.1:${port}${local}`, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 100));

    const s = server.statsFor('direct-1');
    expect(s?.other).toBe(1);
    expect(s?.playlist).toBe(0);
    expect(s?.segments).toBe(0);
    expect(s?.errors).toBe(0);
    expect(s?.bytes).toBe(1024);
    expect(s?.lastPath).toBe(local);
    expect(s?.lastRemote).toContain('127.0.0.1');
  }, 20_000);

  it('a superseded segment logs at debug and is NOT counted in errors; a genuine failure is both', async () => {
    const { sink, at } = logSink();
    const server = new MediaServer(sink);
    const port = await server.listen();
    cleanups.push(async () => {
      await server.close();
    });

    // Same shape as the real scrub that motivated this: seg125 abandoned for a seek to 172.
    server.registerHls('scrub', stubSession((i) => new SupersededError(i, 172)));
    server.registerHls('broken', stubSession(() => new Error('ffmpeg run@seg7 exited code=254')));

    const superseded = await fetch(`http://127.0.0.1:${port}/hls/scrub/seg125.m4s`);
    // DELIBERATELY unchanged: this fix is observability-only. We have no hardware
    // evidence for how a receiver reacts to 404/204 mid-scrub, so the wire stays 500.
    expect(superseded.status).toBe(500);
    await superseded.text();

    const genuine = await fetch(`http://127.0.0.1:${port}/hls/broken/seg7.m4s`);
    expect(genuine.status).toBe(500);
    await genuine.text();

    // Let the response 'close' handlers record bytes/errors.
    await new Promise((r) => setTimeout(r, 100));

    // --- counters: only the genuine failure feeds diagnoseStall()'s "N error response(s)".
    expect(server.statsFor('scrub')?.segments).toBe(1);
    expect(server.statsFor('scrub')?.errors).toBe(0);
    expect(server.statsFor('broken')?.segments).toBe(1);
    expect(server.statsFor('broken')?.errors).toBe(1);

    // --- logs: nothing about the superseded segment at error OR warn…
    const errors = at('error');
    const warns = at('warn');
    expect(errors.some((t) => /superseded/.test(t)), `errors were:\n${errors.join('\n')}`).toBe(false);
    expect(errors.some((t) => /seg125/.test(t))).toBe(false);
    expect(warns.some((t) => /seg125/.test(t)), `warns were:\n${warns.join('\n')}`).toBe(false);

    // …it lands at debug, worded as expected control flow rather than a failure.
    const debugs = at('debug');
    const line = debugs.find((t) => /segment 125 superseded by seek to 172/.test(t));
    expect(line, `debug lines were:\n${debugs.join('\n')}`).toBeDefined();
    expect(line).toContain('expected during seek');
    expect(line).not.toContain('failed');

    // --- the real path is untouched: still error-logged and still counted.
    expect(errors.some((t) => /hls segment 7 failed: ffmpeg run@seg7 exited code=254/.test(t))).toBe(true);
    expect(warns.some((t) => /\/hls\/broken\/seg7\.m4s/.test(t))).toBe(true);
  }, 20_000);

  it('live scrub: a real seek-restart abandons the in-flight segment without inflating errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ss-srv-scrub-'));
    const m = baseMedia('foxtrot_mkv-h264-dts-45min.mkv', 2760);
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const plan = hlsPlan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec);
    const session = new HlsSession({ media: m, plan, boundaries: bounds, input: m.path, workDir: dir, ff });
    sessionsList.push(session);

    const { sink, at } = logSink();
    const server = new MediaServer(sink);
    const port = await server.listen();
    server.registerHls('scrub-live', session);
    cleanups.push(async () => {
      server.unregister('scrub-live');
      await session.dispose();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}/hls/scrub-live`;

    // Both far from the (nonexistent) play head, both inside the 250ms restart
    // debounce, so the launch collapses to seg250 and seg50 is superseded. The
    // 50ms gap only fixes the ARRIVAL ORDER at the server; it is well under the
    // debounce, so no ffmpeg has run and seg50 cannot be on disk.
    const pOld = fetch(`${base}/seg50.m4s`);
    await new Promise((r) => setTimeout(r, 50));
    const pNew = fetch(`${base}/seg250.m4s`);
    const [oldRes, newRes] = await Promise.all([pOld, pNew]);

    expect(oldRes.status).toBe(500); // unchanged on the wire
    await oldRes.text();
    expect(newRes.status).toBe(200);
    expect((await newRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));

    const s = server.statsFor('scrub-live');
    expect(s?.segments).toBe(2);
    // The whole point: a scrub that abandons in-flight segments must leave the
    // counter diagnoseStall() quotes at zero.
    expect(s?.errors).toBe(0);

    const errors = at('error');
    expect(errors.some((t) => /superseded/.test(t)), `errors were:\n${errors.join('\n')}`).toBe(false);
    expect(at('debug').some((t) => /segment 50 superseded by seek to 250/.test(t))).toBe(true);
  }, 40_000);

  /**
   * The end-to-end proof that the client-disconnect signal is actually WIRED.
   * A session-only test cannot catch a MediaServer that never threads the
   * AbortSignal through serveHls() — it would pass with the server unchanged,
   * and the bug this fixes is precisely that the server never observed
   * disconnect. Measured on hardware: 646 of 1103 segment GETs were abandoned
   * mid-wait (average hold 53ms) and 38 of 60 ffmpeg launches served nobody.
   */
  it('a client that disconnects mid-wait drains its waiter and cancels the armed restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ss-srv-abandon-'));
    const m = baseMedia('foxtrot_mkv-h264-dts-45min.mkv', 2760);
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const plan = hlsPlan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec);
    // One sink for BOTH: the server logs the dropped request, the session logs
    // the skipped restart, and the test's whole claim is that both happen.
    const { sink, at } = logSink();
    const session = new HlsSession({ media: m, plan, boundaries: bounds, input: m.path, workDir: dir, ff, logger: sink });
    sessionsList.push(session);

    const server = new MediaServer(sink);
    const port = await server.listen();
    server.registerHls('abandon-live', session);
    cleanups.push(async () => {
      server.unregister('abandon-live');
      await session.dispose();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    // A far segment on a cold session: no ffmpeg is running, so this arms the
    // 250ms restart debounce and parks a waiter — exactly a receiver scan probe.
    // node:http rather than fetch(): we need to destroy the SOCKET mid-wait,
    // which is what makes the server response emit 'close' with
    // writableFinished === false — the exact signal the fix keys on.
    const req = httpRequest(`http://127.0.0.1:${port}/hls/abandon-live/seg300.m4s`);
    req.on('error', () => undefined); // destroy() below surfaces as ECONNRESET
    req.end();
    const t0 = Date.now();
    while (session.pendingWaiterIndices.length === 0) {
      expect(Date.now() - t0, 'the server never parked a waiter for seg300').toBeLessThan(5_000);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session.pendingWaiterIndices).toEqual([300]);

    // Walk away, as the receiver does in ~53ms.
    req.destroy();

    while (session.pendingWaiterIndices.length > 0) {
      expect(Date.now() - t0, 'the waiter was never drained').toBeLessThan(5_000);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session.pendingWaiterIndices).toEqual([]);

    // Past the debounce: the restart it armed must have been skipped, and no
    // ffmpeg spawned to serve a request that no longer exists.
    await new Promise((r) => setTimeout(r, 750));
    expect(session.restartsSkipped).toBe(1);
    expect(session.restartsLaunched).toBe(0);
    expect(session.aliveFfmpegCount).toBe(0);
    expect(session.runStart).toBe(-1);

    // Never an error or a warn: this is the receiver's own behaviour.
    const errors = at('error');
    expect(errors.some((t) => /seg300/.test(t)), `errors were:\n${errors.join('\n')}`).toBe(false);
    expect(at('debug').some((t) => /hls segment 300 dropped \(client disconnected mid-wait\)/.test(t))).toBe(true);
    expect(at('info').some((t) => /restart to seg300 skipped/.test(t))).toBe(true);
    // …and the abandoned request cannot inflate the counter diagnoseStall() quotes.
    expect(server.statsFor('abandon-live')?.errors).toBe(0);
  }, 30_000);

  it('(f) a real HLS client (ffmpeg) decodes 8s off the live server URL', async () => {
    const v: VideoAction = { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 60 };
    const { base } = await setup('decode', v, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 });

    // Proves a genuine HLS client can pull + decode from the on-demand server.
    // NOTE: must be async — a sync child would block this process's event loop
    // and the in-process MediaServer could never answer the client (deadlock).
    let ok = true;
    let detail = '';
    try {
      await execFileAsync(
        ff.ffmpeg,
        [
          '-hide_banner',
          '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
          '-allowed_extensions', 'ALL',
          '-i', `${base}/playlist.m3u8`,
          '-t', '8', '-f', 'null', '-',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? `${e.message}\n${(e as { stderr?: string }).stderr ?? ''}` : String(e);
    }
    expect(ok, detail).toBe(true);
  }, 40_000);
});
