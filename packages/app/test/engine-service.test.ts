/**
 * engine-service.test.ts — the main-side handler logic exercised directly
 * against the MockEngine, with no Electron runtime. Fake timers drive the mock's
 * discovery (~500ms) and session state machine (60ms/step, 1Hz position).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEngine } from '../../engine/dist/mock/mock-engine.js';
import { EngineService } from '../src/main/engine-service.js';
import { EVT } from '../src/shared/ipc.js';
import type { Engine, PlaybackPrefs, PlaybackSession } from '../src/shared/engine-types.js';

const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

function setup() {
  const events: Array<{ channel: string; payload: unknown }> = [];
  const push = (channel: string, payload: unknown): void => {
    events.push({ channel, payload });
  };
  const engine = createMockEngine();
  const service = new EngineService(engine, { mock: true }, push);
  const eventsOf = (channel: string): unknown[] =>
    events.filter((e) => e.channel === channel).map((e) => e.payload);
  return { engine, service, events, eventsOf };
}

/** A fake engine whose discovery.start() throws, to prove init() survives it. */
function throwingDiscoveryEngine(startError: Error): Engine {
  const discovery = {
    on: () => discovery,
    once: () => discovery,
    off: () => discovery,
    start: () => {
      throw startError;
    },
    stop: () => undefined,
    list: () => [],
    rescan: () => undefined,
  };
  return { discovery } as unknown as Engine;
}

/**
 * The live session is owned privately by the service, so to drive the engine's
 * own 'error' / 'warning' / 'ended' channels we wrap `engine.play()` and keep a
 * handle on the very session the service wired. Emitting on that handle is the
 * same EventEmitter path the real PlaybackSession uses.
 */
type Emittable = PlaybackSession & { emit(event: string, ...args: unknown[]): boolean };

function setupCapturing() {
  const events: Array<{ channel: string; payload: unknown }> = [];
  const push = (channel: string, payload: unknown): void => {
    events.push({ channel, payload });
  };
  const engine = createMockEngine();
  let captured: Emittable | undefined;
  const realPlay = engine.play.bind(engine);
  engine.play = async (opts) => {
    const session = await realPlay(opts);
    captured = session as Emittable;
    return session;
  };
  const service = new EngineService(engine, { mock: true }, push);
  const eventsOf = (channel: string): unknown[] =>
    events.filter((e) => e.channel === channel).map((e) => e.payload);
  return { engine, service, events, eventsOf, session: () => captured! };
}

/** init → discover → probe → plan → startSession, the shortest route to a live session. */
async function startSession(service: EngineService) {
  service.init();
  await vi.advanceTimersByTimeAsync(600);
  const media = await service.probe('/movie.mkv');
  const deviceId = service.listDevices()[0]!.id;
  const plan = service.plan({ deviceId, media, prefs: PREFS });
  return service.startSession({ deviceId, media, plan, prefs: PREFS });
}

describe('EngineService.init() robustness', () => {
  it('emits mode before discovery.start() and survives a start() failure', () => {
    const events: Array<{ channel: string; payload: unknown }> = [];
    const push = (channel: string, payload: unknown): void => {
      events.push({ channel, payload });
    };
    const service = new EngineService(
      throwingDiscoveryEngine(new Error('mdns unavailable')),
      { mock: false },
      push,
    );

    // A discovery.start() failure must not abort init().
    expect(() => service.init()).not.toThrow();

    const eventsOf = (channel: string): unknown[] =>
      events.filter((e) => e.channel === channel).map((e) => e.payload);

    // Mode is still announced despite the start() failure.
    expect(eventsOf(EVT.mode).at(-1)).toEqual({ mock: false });

    // The failure degrades to a warning toast rather than crashing.
    const warnings = eventsOf(EVT.warning) as string[];
    expect(warnings.some((w) => w.includes('mdns unavailable'))).toBe(true);

    // Ordering: mode is emitted BEFORE discovery.start() runs (hence before the
    // warning it raises) — the whole point of the reorder.
    const modeIdx = events.findIndex((e) => e.channel === EVT.mode);
    const warnIdx = events.findIndex((e) => e.channel === EVT.warning);
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(modeIdx).toBeLessThan(warnIdx);
  });

  it('is idempotent — a second init() re-emits nothing', () => {
    const events: Array<{ channel: string; payload: unknown }> = [];
    const push = (channel: string, payload: unknown): void => {
      events.push({ channel, payload });
    };
    const service = new EngineService(
      throwingDiscoveryEngine(new Error('mdns unavailable')),
      { mock: false },
      push,
    );
    service.init();
    const countAfterFirst = events.length;
    service.init();
    expect(events.length).toBe(countAfterFirst);
  });
});

describe('EngineService against MockEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pushes device snapshots as discovery emits', async () => {
    const { service, eventsOf } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    const snaps = eventsOf(EVT.devices);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(service.listDevices()).toHaveLength(2);
    expect((snaps.at(-1) as unknown[]).length).toBe(2);
  });

  it('announces mode on init', () => {
    const { service, eventsOf } = setup();
    service.init();
    expect(eventsOf(EVT.mode).at(-1)).toEqual({ mock: true });
    expect(service.getMode()).toEqual({ mock: true });
  });

  it('probes and plans', async () => {
    const { service } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    const media = await service.probe('/movie.mkv');
    expect(media.container).toBe('mkv');

    const deviceId = service.listDevices()[0]!.id;
    const plan = service.plan({ deviceId, media, prefs: PREFS });
    expect(plan.tier).toBe('video-transcode');
    expect(plan.method).toBe('hls');
  });

  it('plan() throws for an unknown device', async () => {
    const { service } = setup();
    service.init();
    const media = await service.probe('/movie.mkv');
    expect(() => service.plan({ deviceId: 'nope', media, prefs: PREFS })).toThrow(
      /Unknown device/,
    );
  });

  it('drives a session through the state machine with 1Hz status', async () => {
    const { service, eventsOf } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    const media = await service.probe('/movie.mkv');
    const deviceId = service.listDevices()[0]!.id;
    const plan = service.plan({ deviceId, media, prefs: PREFS });

    const status0 = await service.startSession({ deviceId, media, plan, prefs: PREFS });
    expect(status0.state).toBe('probing');
    expect(status0.deviceName).toContain('Mock');

    // Walk to playing (7 states * 60ms).
    await vi.advanceTimersByTimeAsync(500);
    expect(eventsOf(EVT.state)).toContain('playing');

    // Position + 1Hz status ticks.
    await vi.advanceTimersByTimeAsync(1500);
    const positions = eventsOf(EVT.position) as number[];
    expect(positions.some((p) => p >= 1)).toBe(true);
    expect(eventsOf(EVT.status).length).toBeGreaterThan(1);

    // Pause.
    await service.pause();
    expect((eventsOf(EVT.state) as string[]).at(-1)).toBe('paused');
    expect(service.getStatus()?.state).toBe('paused');

    // Resume + seek.
    await service.resume();
    await service.seek(120);
    expect(service.getStatus()?.positionSec).toBe(120);

    // Volume / mute / track selection.
    await service.setVolume(0.4);
    await service.setMuted(true);
    await service.selectAudio(2);
    await service.selectSubtitle(null);

    const st = service.getStatus()!;
    expect(st.volume).toBeCloseTo(0.4);
    expect(st.muted).toBe(true);
    expect(st.activeAudioStreamIndex).toBe(2);
    expect(st.activeSubtitleTrackId).toBeNull();

    await service.stop();
    expect(service.getStatus()).toBeNull();
  });

  it('keeps only one active session', async () => {
    const { service } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    const media = await service.probe('/a.mkv');
    const deviceId = service.listDevices()[0]!.id;
    const plan = service.plan({ deviceId, media, prefs: PREFS });

    await service.startSession({ deviceId, media, plan, prefs: PREFS });
    await vi.advanceTimersByTimeAsync(500); // first session reaches playing
    await service.startSession({ deviceId, media, plan, prefs: PREFS });

    // The replacement session starts fresh at 'probing'.
    expect(service.getStatus()?.state).toBe('probing');

    await service.stop();
  });
});

/**
 * The observability contract. A real cast session once died with the user seeing
 * only a six-second toast: the main-process log for that whole session contained
 * no error line at all, because the engine's `emitError()` logs ONLY when no
 * listener is attached — and the app attaches one. These pin the lines that were
 * missing, on the real `EngineService`, in the exact text a maintainer greps.
 *
 * Asserted against the console rather than an injected sink deliberately: the
 * `LEVEL [area] message` shape IS the thing under test, so the assertions should
 * see the same finished string the log file gets.
 */
describe('EngineService session logging', () => {
  let out: { log: string[]; warn: string[]; error: string[] };

  beforeEach(() => {
    vi.useFakeTimers();
    out = { log: [], warn: [], error: [] };
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.log.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(
      (...a: unknown[]) => void out.warn.push(a.join(' ')),
    );
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void out.error.push(a.join(' ')),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('logs session start with the SAME id the engine logs under, plus device and tier', async () => {
    const { service, session } = setupCapturing();
    const status = await startSession(service);

    const line = out.log.find((l) => l.includes('started'))!;
    expect(line).toBeDefined();
    // Correlation is the whole point: the engine prefixes its own lines with
    // this id (`[castgorilla:session:<id>:hls]`). Different id, useless log.
    expect(line).toContain(session().id);
    expect(line).toContain(`device="${status.deviceName}"`);
    expect(line).toContain(`tier=${status.tier}`);
    expect(line).toMatch(/^INFO \[session\] /);

    await service.stop();
  });

  it('logs a session error at ERROR, still emits EVT.error, and still tears down', async () => {
    const { service, session, eventsOf } = setupCapturing();
    await startSession(service);
    await vi.advanceTimersByTimeAsync(500);

    // The exact error the engine raises for `IDLE` + `idleReason: 'ERROR'`.
    session().emit('error', new Error('receiver reported a playback error'));
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget teardown settle

    // 1. The line that did not exist.
    const line = out.error.find((l) => l.includes('receiver reported a playback error'))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/^ERROR \[session\] /);
    expect(line).toContain(session().id);

    // 2. Control flow is unchanged — the renderer still gets its toast...
    expect(eventsOf(EVT.error)).toContainEqual({ message: 'receiver reported a playback error' });
    // ...and the session is still torn down (which releases the assertion).
    expect(service.getStatus()).toBeNull();
  });

  it('logs session end at INFO and still emits EVT.ended', async () => {
    const { service, session, eventsOf } = setupCapturing();
    await startSession(service);
    await vi.advanceTimersByTimeAsync(500);

    session().emit('ended');
    await vi.advanceTimersByTimeAsync(0);

    const line = out.log.find((l) => l.includes('ended'))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/^INFO \[session\] /);
    expect(line).toContain(session().id);

    expect(eventsOf(EVT.ended)).toHaveLength(1);
    expect(service.getStatus()).toBeNull();
  });

  it('logs a session warning at WARN and still emits EVT.warning', async () => {
    const { service, session, eventsOf } = setupCapturing();
    await startSession(service);
    await vi.advanceTimersByTimeAsync(500);

    session().emit('warning', 'audio downmixed to stereo');
    await vi.advanceTimersByTimeAsync(0);

    const line = out.warn.find((l) => l.includes('audio downmixed to stereo'))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/^WARN \[session\] /);
    expect(line).toContain(session().id);

    expect(eventsOf(EVT.warning)).toContain('audio downmixed to stereo');

    await service.stop();
  });

  it('does NOT log per-position-tick — 1Hz ticks would bury everything else', async () => {
    const { service, eventsOf } = setupCapturing();
    await startSession(service);
    await vi.advanceTimersByTimeAsync(500);

    const before = out.log.length;
    await vi.advanceTimersByTimeAsync(5000); // 5s of position + status ticks
    expect((eventsOf(EVT.position) as number[]).length).toBeGreaterThan(2);
    expect(out.log.length).toBe(before);

    await service.stop();
  });
});
