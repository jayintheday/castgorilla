import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockCastReceiver } from './helpers/mock-cast-receiver.js';
import { CastClient, MediaController, type CastClientOptions } from '../src/cast/client.js';
import { CastCommandError, CastConnectionError, SessionLostError } from '../src/cast/errors.js';
import type { LoadMediaInformation } from '../src/types/cast.js';

/** Timings tuned for fast, deterministic tests. */
const FAST: CastClientOptions = {
  heartbeatIntervalMs: 40,
  heartbeatTimeoutMs: 200,
  requestTimeoutMs: 1500,
  loadTimeoutMs: 2500,
  connectTimeoutMs: 2000,
  reconnect: { initialMs: 20, maxMs: 80, factor: 2, jitter: 0, maxAttempts: 25 },
};

function sampleMedia(): LoadMediaInformation {
  return {
    contentId: 'http://127.0.0.1:0/master.m3u8',
    contentType: 'application/vnd.apple.mpegurl',
    streamType: 'BUFFERED',
    duration: 5400,
    hlsSegmentFormat: 'FMP4',
    hlsVideoSegmentFormat: 'FMP4',
    metadata: { metadataType: 1, title: 'Sample' },
  };
}

/** Resolve on the next matching emitter event (or reject on timeout). */
function waitFor<T = unknown[]>(
  emitter: { on(e: string, l: (...a: unknown[]) => void): unknown; off(e: string, l: (...a: unknown[]) => void): unknown },
  event: string,
  predicate?: (...args: unknown[]) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    function handler(...args: unknown[]): void {
      if (predicate && !predicate(...args)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(args as unknown as T);
    }
    emitter.on(event, handler);
  });
}

// A live cast connection test suite. Every test asserts NO unhandled rejection
// escaped (the reconnect/loss paths must always reject in-flight promises).
describe('CastClient (against MockCastReceiver)', () => {
  let mock: MockCastReceiver;
  let client: CastClient | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(async () => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    mock = new MockCastReceiver({ loadTransitionMs: 15 });
    await mock.start();
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    await mock.stop();
    // Let any stray microtasks flush so unhandledRejection would surface.
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled, 'no unhandled promise rejections').toEqual([]);
  });

  async function connect(opts: CastClientOptions = FAST): Promise<CastClient> {
    client = await CastClient.connect('127.0.0.1', { ...opts, port: mock.port });
    return client;
  }

  it('connects, launches the DMR, and loads media (happy path)', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    expect(c.getSession()?.appId).toBe('CC1AD845');
    expect(c.getSession()?.transportId).toBe('transport-1');

    const status = await media.load(sampleMedia(), { autoplay: true });
    expect(status.playerState).toBe('BUFFERING');
    expect(status.mediaSessionId).toBe(1);
    expect(status.media?.contentId).toBe(sampleMedia().contentId);
    expect(media.mediaSessionId).toBe(1);
  });

  it('applies the scripted BUFFERING -> PLAYING transition as an unsolicited push, merging lastStatus', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    // The mock pushes PLAYING (requestId 0) ~15ms after LOAD, WITHOUT the media block.
    const [pushed] = await waitFor<[{ playerState: string }]>(media, 'status', (s) => (s as { playerState: string }).playerState === 'PLAYING');
    expect(pushed.playerState).toBe('PLAYING');
    // Merge preserved the media block that only the initial status carried.
    expect(media.lastStatus?.playerState).toBe('PLAYING');
    expect(media.lastStatus?.media?.contentId).toBe(sampleMedia().contentId);
  });

  it('round-trips play / pause / seek and receiver volume', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    const paused = await media.pause();
    expect(paused.playerState).toBe('PAUSED');

    const played = await media.play();
    expect(played.playerState).toBe('PLAYING');

    const seeked = await media.seek(123.5);
    expect(seeked.currentTime).toBe(123.5);

    const active = await media.setActiveTracks([3]);
    expect(active.activeTrackIds).toEqual([3]);

    const vol = await c.receiver.setVolume(0.3, false);
    expect(vol.volume?.level).toBeCloseTo(0.3);
    expect(c.receiver.lastStatus?.volume?.level).toBeCloseTo(0.3);
  });

  it('surfaces an unsolicited MEDIA_STATUS push (updates lastStatus + emits status)', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });
    await waitFor(media, 'status', (s) => (s as { playerState: string }).playerState === 'PLAYING');

    const evt = waitFor<[{ currentTime: number }]>(media, 'status', (s) => (s as { currentTime: number }).currentTime === 42);
    mock.pushMediaStatus({ playerState: 'PLAYING', currentTime: 42 });
    const [s] = await evt;
    expect(s.currentTime).toBe(42);
    expect(media.lastStatus?.currentTime).toBe(42);
    // media block still preserved through repeated sparse pushes
    expect(media.lastStatus?.media?.contentId).toBe(sampleMedia().contentId);
  });

  it('recovers from a heartbeat timeout: reconnecting -> reconnected with media resync', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    const reconnecting = waitFor(c, 'reconnecting');
    const reconnected = waitFor(c, 'reconnected', undefined, 5000);
    mock.stopAnsweringPings();
    await reconnecting;
    // Let the device answer again so the reconnect settles.
    mock.resumeAnsweringPings();
    await reconnected;

    // Session survived: commands still work on the same controller.
    const played = await media.play();
    expect(played.playerState).toBe('PLAYING');
  });

  it('recovers from a hard socket drop (ECONNRESET-style): reconnected, app still running', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    const reconnected = waitFor(c, 'reconnected', undefined, 5000);
    mock.dropConnection();
    await reconnected;
    const status = await media.getStatus();
    expect(status.mediaSessionId).toBe(1);
  });

  it('emits session-lost when the app is gone after a reconnect; further media commands reject', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    const sessionLost = waitFor(c, 'session-lost', undefined, 5000);
    mock.killApp();
    mock.dropConnection();
    await sessionLost;

    await expect(media.play()).rejects.toBeInstanceOf(SessionLostError);
  });

  it('rejects an in-flight command with a typed CastConnectionError on connection loss (no unhandled rejection)', async () => {
    // Disable reconnect + heartbeat noise so the delayed-response slot is ours.
    const c = await connect({
      ...FAST,
      heartbeatIntervalMs: 100_000,
      heartbeatTimeoutMs: 100_000,
      reconnect: false,
    });
    await c.launchDefaultMediaReceiver();

    const errorEvt = waitFor(c, 'error');
    mock.delayNextResponse(1000); // the GET_STATUS response will never arrive in time
    const pending = c.receiver.getStatus();
    mock.dropConnection();

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await expect(pending).rejects.toBeInstanceOf(CastConnectionError);
    await errorEvt; // 'error' fired because reconnect is disabled
  });

  it('ignores a malformed inbound payload without crashing (subsequent commands still work)', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();
    await media.load(sampleMedia(), { autoplay: true });

    mock.sendMalformed();
    await new Promise((r) => setTimeout(r, 30));

    // Still fully functional after the garbage frame.
    const status = await media.getStatus();
    expect(status.mediaSessionId).toBe(1);
  });

  it('rejects a media command issued before LOAD with NoMediaSession', async () => {
    const c = await connect();
    const media: MediaController = await c.launchDefaultMediaReceiver();
    await expect(media.play()).rejects.toMatchObject({ code: 'NO_MEDIA_SESSION' });
  });

  // --- empty MEDIA_STATUS status arrays -------------------------------------
  // An empty `status: []` is normal for an idle GET_STATUS and for a STOP ack,
  // but as the answer to a LOAD it means the receiver created no media session.
  // Resolving THAT with `undefined` is what parks a session in 'loading' forever
  // (OPEN BUG #1), so LOAD — and only LOAD — must reject.

  it('rejects a LOAD answered with an EMPTY MEDIA_STATUS status array', async () => {
    mock.emptyStatusOnLoad();
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();

    await expect(media.load(sampleMedia(), { autoplay: true })).rejects.toBeInstanceOf(CastCommandError);
    await expect(media.load(sampleMedia(), { autoplay: true })).rejects.toMatchObject({
      code: 'COMMAND_REJECTED',
      responseType: 'MEDIA_STATUS',
    });
    // The raw device payload is preserved verbatim for diagnostics.
    const err = await media.load(sampleMedia(), {}).catch((e: unknown) => e as CastCommandError);
    expect((err.payload as { type?: string; status?: unknown[] }).type).toBe('MEDIA_STATUS');
    expect((err.payload as { status?: unknown[] }).status).toEqual([]);
    // No media session was learned from a failed LOAD.
    expect(media.mediaSessionId).toBeUndefined();
  });

  it('still RESOLVES an empty-status GET_STATUS (idle receiver) and an empty-status STOP ack', async () => {
    const c = await connect();
    const media = await c.launchDefaultMediaReceiver();

    // Idle receiver: nothing loaded yet → MEDIA_STATUS with status: [].
    await expect(media.getStatus()).resolves.toBeUndefined();

    // Now load, then make the receiver forget its media session so the STOP
    // acknowledgement comes back with an empty status array. It must resolve.
    await media.load(sampleMedia(), { autoplay: true });
    await waitFor(media, 'status', (s) => (s as { playerState: string }).playerState === 'PLAYING');
    mock.killApp();

    const stopped = await media.stop();
    expect(stopped?.playerState).toBe('PLAYING'); // last known status, as before
    // And an idle GET_STATUS after that still resolves rather than rejecting.
    await expect(media.getStatus()).resolves.toBeDefined();
  });
});
