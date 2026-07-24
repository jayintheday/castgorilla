/**
 * power-blocker.test.ts — the idle-sleep assertion.
 *
 * Two layers:
 *  1. `SleepBlocker` itself against a fake `powerSaveBlocker` (the real Electron
 *     power API is never touched in a unit test);
 *  2. `EngineService` session lifecycle — the assertion must be taken when a
 *     session goes live and dropped on EVERY exit route, because a leaked
 *     assertion keeps the user's Mac awake indefinitely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEngine } from '../../engine/dist/mock/mock-engine.js';
import { EngineService } from '../src/main/engine-service.js';
import { SleepBlocker, type PowerSaveBlockerApi } from '../src/main/power.js';
import type { Engine, PlaybackPrefs } from '../src/shared/engine-types.js';

const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

/** A recording stand-in for Electron's `powerSaveBlocker`. */
function fakePowerApi() {
  const started = new Set<number>();
  const startCalls: string[] = [];
  const stopCalls: number[] = [];
  let nextId = 1;
  const api: PowerSaveBlockerApi = {
    start(type) {
      startCalls.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      stopCalls.push(id);
      started.delete(id);
    },
    isStarted: (id) => started.has(id),
  };
  return { api, started, startCalls, stopCalls };
}

function blocker() {
  const fake = fakePowerApi();
  // Silent log sink — the acquire/release lines are asserted separately.
  return { ...fake, sleep: new SleepBlocker(fake.api, () => undefined) };
}

describe('SleepBlocker', () => {
  it('takes prevent-app-suspension (never prevent-display-sleep)', () => {
    const { sleep, startCalls } = blocker();
    sleep.acquire();
    expect(startCalls).toEqual(['prevent-app-suspension']);
  });

  it('is idempotent — a second acquire() does not start a second blocker', () => {
    const { sleep, startCalls, started } = blocker();
    sleep.acquire();
    sleep.acquire();
    sleep.acquire();
    expect(startCalls).toHaveLength(1);
    expect(started.size).toBe(1);
    expect(sleep.held).toBe(true);
  });

  it('releases, and a second release() does not stop anything', () => {
    const { sleep, stopCalls, started } = blocker();
    sleep.acquire();
    const id = sleep.blockerId!;
    sleep.release();
    sleep.release();
    expect(stopCalls).toEqual([id]);
    expect(started.size).toBe(0);
    expect(sleep.held).toBe(false);
  });

  it('release() without acquire() is a no-op', () => {
    const { sleep, stopCalls } = blocker();
    sleep.release();
    expect(stopCalls).toEqual([]);
  });

  it('never stops an id that is not running any more', () => {
    const { api, sleep, stopCalls } = blocker();
    sleep.acquire();
    api.stop(sleep.blockerId!); // something else stopped it behind our back
    stopCalls.length = 0;
    sleep.release();
    expect(stopCalls).toEqual([]);
    expect(sleep.held).toBe(false);
  });

  it('can be re-acquired after release', () => {
    const { sleep, startCalls } = blocker();
    sleep.acquire();
    const first = sleep.blockerId;
    sleep.release();
    sleep.acquire();
    expect(startCalls).toHaveLength(2);
    expect(sleep.blockerId).not.toBe(first);
  });

  it('logs the id on acquire and release so it can be matched to pmset', () => {
    const fake = fakePowerApi();
    const lines: string[] = [];
    const sleep = new SleepBlocker(fake.api, (m) => lines.push(m));
    sleep.acquire();
    const id = sleep.blockerId!;
    sleep.release();
    expect(lines[0]).toContain(`acquired prevent-app-suspension id=${id}`);
    expect(lines[1]).toContain(`released prevent-app-suspension id=${id}`);
  });

  it('survives a throwing power API rather than breaking playback', () => {
    const throwing: PowerSaveBlockerApi = {
      start: () => {
        throw new Error('no power API here');
      },
      stop: () => undefined,
      isStarted: () => false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sleep = new SleepBlocker(throwing, () => undefined);
    expect(() => sleep.acquire()).not.toThrow();
    expect(sleep.held).toBe(false);
    expect(() => sleep.release()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// --- EngineService lifecycle -------------------------------------------------

function setup() {
  const fake = fakePowerApi();
  const sleep = new SleepBlocker(fake.api, () => undefined);
  const engine = createMockEngine();
  const service = new EngineService(engine, { mock: true }, () => {}, sleep);
  return { ...fake, sleep, engine, service };
}

async function startOne(service: EngineService) {
  const media = await service.probe('/movie.mkv');
  const deviceId = service.listDevices()[0]!.id;
  const plan = service.plan({ deviceId, media, prefs: PREFS });
  return service.startSession({ deviceId, media, plan, prefs: PREFS });
}

/**
 * A hand-rolled engine whose single session we can drive directly: the mock
 * engine has no way to make a session fail, and the failure paths are exactly
 * what must be proven here.
 */
function scriptedEngine(stop: () => Promise<void> = async () => undefined) {
  const listeners: Record<string, Array<(payload: never) => void>> = {};
  const session = {
    on(event: string, cb: (payload: never) => void) {
      (listeners[event] ??= []).push(cb);
      return session;
    },
    status: () => ({ state: 'playing' }),
    stop,
  };
  const engine = {
    discovery: {
      on: () => engine.discovery,
      start: () => undefined,
      list: () => [{ id: 'd1', name: 'Scripted', profile: {} }],
      rescan: () => undefined,
    },
    play: async () => session,
    shutdown: async () => undefined,
  };
  const fire = (event: string, payload?: unknown): void => {
    for (const cb of listeners[event] ?? []) cb(payload as never);
  };
  return { engine: engine as unknown as Engine, session, fire };
}

const SCRIPTED_START = {
  deviceId: 'd1',
  media: {} as never,
  plan: {} as never,
  prefs: PREFS,
};

describe('EngineService holds the assertion for the session lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('acquires when a session becomes active and releases on a clean stop', async () => {
    const { service, sleep, startCalls, started } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    expect(sleep.held).toBe(false);
    await startOne(service);
    expect(sleep.held).toBe(true);
    expect(startCalls).toEqual(['prevent-app-suspension']);

    await service.stop();
    expect(sleep.held).toBe(false);
    expect(started.size).toBe(0);
  });

  it('releases when the session ends on its own', async () => {
    const fake = fakePowerApi();
    const power = new SleepBlocker(fake.api, () => undefined);
    const { engine, fire } = scriptedEngine();
    const service = new EngineService(engine, { mock: false }, () => {}, power);

    await service.startSession(SCRIPTED_START);
    expect(power.held).toBe(true);

    fire('ended');
    await vi.advanceTimersByTimeAsync(10);
    expect(power.held).toBe(false);
    expect(fake.started.size).toBe(0);
  });

  it('releases on the ERROR path, not just the clean one', async () => {
    const fake = fakePowerApi();
    const power = new SleepBlocker(fake.api, () => undefined);
    const { engine, fire } = scriptedEngine();
    const service = new EngineService(engine, { mock: false }, () => {}, power);

    await service.startSession(SCRIPTED_START);
    expect(power.held).toBe(true);

    // The session errors out — the app never gets a stop() from the user.
    fire('error', new Error('receiver died'));
    await vi.advanceTimersByTimeAsync(10);
    expect(power.held).toBe(false);
    expect(fake.started.size).toBe(0);
  });

  it('releases when engine.play() itself rejects (a session that never started)', async () => {
    const fake = fakePowerApi();
    const power = new SleepBlocker(fake.api, () => undefined);
    const { engine } = scriptedEngine();
    (engine as unknown as { play: () => Promise<never> }).play = async () => {
      throw new Error('ffmpeg exploded');
    };
    const service = new EngineService(engine, { mock: false }, () => {}, power);

    await expect(service.startSession(SCRIPTED_START)).rejects.toThrow(/ffmpeg exploded/);
    expect(power.held).toBe(false);
    expect(fake.started.size).toBe(0);
  });

  it('releases even when the receiver rejects session.stop() during teardown', async () => {
    const fake = fakePowerApi();
    const power = new SleepBlocker(fake.api, () => undefined);
    const { engine } = scriptedEngine(async () => {
      throw Object.assign(new Error('Cast device rejected request'), {
        reason: 'INVALID_MEDIA_SESSION_ID',
      });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new EngineService(engine, { mock: false }, () => {}, power);

    await service.startSession(SCRIPTED_START);
    expect(power.held).toBe(true);

    // A rejecting stop() must neither throw out of teardown nor strand the
    // assertion — that combination is exactly what leaves a Mac awake forever.
    await expect(service.stop()).resolves.toBeUndefined();
    expect(power.held).toBe(false);
    expect(fake.started.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not double-start when a second session replaces a live one', async () => {
    const { service, sleep, startCalls, started } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);

    await startOne(service);
    await vi.advanceTimersByTimeAsync(500); // first session reaches playing
    await startOne(service);

    expect(sleep.held).toBe(true);
    // One assertion at a time, always: the replacement released the first.
    expect(started.size).toBe(1);
    expect(startCalls).toHaveLength(2);

    await service.stop();
    expect(started.size).toBe(0);
  });

  it('releases on shutdown (window close / app quit)', async () => {
    const { service, sleep, started } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);
    await startOne(service);
    expect(sleep.held).toBe(true);

    await service.shutdown();
    expect(sleep.held).toBe(false);
    expect(started.size).toBe(0);
  });

  it('holds nothing when no session was ever started', async () => {
    const { service, sleep, startCalls } = setup();
    service.init();
    await vi.advanceTimersByTimeAsync(600);
    await service.stop();
    await service.shutdown();
    expect(sleep.held).toBe(false);
    expect(startCalls).toEqual([]);
  });
});
