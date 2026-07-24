/**
 * engine-host.ts — the app's SINGLE runtime coupling to @castgorilla/engine.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  ENGINE GATE (WS6b: real engine is now the default)                         │
 * │                                                                             │
 * │  The real `createEngine()` from `@castgorilla/engine` (WS4) is the default. │
 * │  Set `CASTGORILLA_MOCK=1` in the environment to force the canned MockEngine │
 * │  instead — useful for demoing the shell without a Chromecast / ffmpeg on    │
 * │  the machine. Nothing else in the app imports the engine at runtime.        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * We import the mock from the engine's *built* dist by relative path
 * (`../../../engine/dist/mock/mock-engine.js`) rather than from
 * `@castgorilla/engine`'s root entry. The mock's only transitive runtime deps are
 * a pure typed emitter and the pure device-profile table — no native modules —
 * so it bundles cleanly into the Electron main bundle and is always available as
 * the fallback even if the real engine fails to load.
 *
 * The real-engine path is a *dynamic* `import('@castgorilla/engine')` guarded by
 * try/catch: if the import cannot resolve or `createEngine()` throws, we fall
 * back to the mock and surface a visible "MOCK MODE" reason rather than crashing
 * the app. (ffmpeg is resolved lazily inside the engine on the first probe/play,
 * so a missing ffmpeg does NOT trip this fallback — it surfaces later as a clear
 * renderer error toast when the user opens a file.)
 */

import { createMockEngine } from '../../../engine/dist/mock/mock-engine.js';
import type { Engine } from '../shared/engine-types.js';
import type { EngineMode } from '../shared/ipc.js';

export interface EngineHandle {
  engine: Engine;
  mode: EngineMode;
}

/**
 * The real engine is the default. `CASTGORILLA_MOCK=1` forces the mock — this is
 * the single environment switch that swaps engines.
 */
const FORCE_MOCK = process.env.CASTGORILLA_MOCK === '1';

/**
 * Build the Engine the app runs against. Returns the engine plus the mode the
 * UI shows (the MOCK MODE badge is driven off `mode.mock`; `mode.reason`
 * explains *why* we are on the mock when it is not the deliberate override).
 */
export async function createEngineForApp(): Promise<EngineHandle> {
  if (FORCE_MOCK) {
    return {
      engine: createMockEngine(),
      mode: { mock: true, reason: 'forced by CASTGORILLA_MOCK=1' },
    };
  }

  try {
    const mod: { createEngine: () => Engine } = await import('@castgorilla/engine');
    const engine = mod.createEngine();
    return { engine, mode: { mock: false } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      engine: createMockEngine(),
      mode: { mock: true, reason: `real engine unavailable — ${reason}` },
    };
  }
}
