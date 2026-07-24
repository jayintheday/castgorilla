/**
 * engine-host.test.ts — the engine GATE (WS6b): real engine by DEFAULT,
 * `CASTGORILLA_MOCK=1` forces the mock, and any real-engine load failure falls
 * back to the mock with a visible reason instead of crashing.
 *
 * The real `@castgorilla/engine` is mocked so these assertions exercise the gate's
 * branching only — not the real engine's mDNS / ffmpeg / socket wiring.
 * `vi.resetModules()` + `vi.doMock` + a dynamic re-import let each case install a
 * different fake (or a throwing one) before `engine-host` reads it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../src/shared/engine-types.js';

const ENGINE_MODULE = '@castgorilla/engine';

/** A minimal sentinel we can assert identity against. */
function sentinelEngine(): Engine {
  return { shutdown: async () => undefined } as unknown as Engine;
}

async function loadHost() {
  return import('../src/main/engine-host.js');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock(ENGINE_MODULE);
  delete process.env.CASTGORILLA_MOCK;
});

describe('createEngineForApp gate', () => {
  it('uses the REAL engine by default', async () => {
    const engine = sentinelEngine();
    const createEngine = vi.fn(() => engine);
    vi.doMock(ENGINE_MODULE, () => ({ createEngine }));

    const { createEngineForApp } = await loadHost();
    const handle = await createEngineForApp();

    expect(createEngine).toHaveBeenCalledOnce();
    expect(handle.engine).toBe(engine);
    expect(handle.mode).toEqual({ mock: false });
  });

  it('forces the MOCK engine on CASTGORILLA_MOCK=1 without importing the real one', async () => {
    process.env.CASTGORILLA_MOCK = '1';
    const createEngine = vi.fn(() => sentinelEngine());
    vi.doMock(ENGINE_MODULE, () => ({ createEngine }));

    const { createEngineForApp } = await loadHost();
    const handle = await createEngineForApp();

    expect(createEngine).not.toHaveBeenCalled();
    expect(handle.mode.mock).toBe(true);
    expect(handle.mode.reason).toMatch(/CASTGORILLA_MOCK/);
    // The fallback is a real, usable mock engine (exposes a discovery surface).
    expect(handle.engine.discovery.list()).toEqual([]);
  });

  it('falls back to the mock (with reason) when createEngine() throws', async () => {
    vi.doMock(ENGINE_MODULE, () => ({
      createEngine: () => {
        throw new Error('boom-not-implemented');
      },
    }));

    const { createEngineForApp } = await loadHost();
    const handle = await createEngineForApp();

    expect(handle.mode.mock).toBe(true);
    expect(handle.mode.reason).toContain('real engine unavailable');
    expect(handle.mode.reason).toContain('boom-not-implemented');
    expect(handle.engine.discovery.list()).toEqual([]);
  });

  it('falls back to the mock when the real engine module cannot be imported', async () => {
    vi.doMock(ENGINE_MODULE, () => {
      throw new Error('module-load-failure');
    });

    const { createEngineForApp } = await loadHost();
    const handle = await createEngineForApp();

    expect(handle.mode.mock).toBe(true);
    expect(handle.mode.reason).toContain('real engine unavailable');
    expect(handle.engine.discovery.list()).toEqual([]);
  });
});
