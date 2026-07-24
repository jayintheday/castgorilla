/**
 * device-preference.ts — remembering which device you last cast to.
 *
 * The whole feature is two lines of `localStorage`, so the reason this is a
 * module rather than two inline calls in `main.ts` is testability: `main.ts` is
 * the one file with no tests (it is pure wiring against `window.castgorilla`),
 * and "the app forgot my TV" is exactly the kind of regression that is invisible
 * until someone launches it twice.
 *
 * Storage is injected rather than reached for. In Electron `localStorage` is
 * backed by the app's user-data directory, so it survives quit and relaunch —
 * but note CLAUDE.md's rename caveat: `appId` moved from `co.sickstream.app` to
 * `co.castgorilla.app`, which moved the user-data directory with it, so anything
 * stored under the old identity is orphaned and will read as "no preference".
 * That is correct behaviour, not a bug to chase.
 *
 * Every operation is guarded. `localStorage` throws rather than returning null
 * in two real situations — a renderer running from a `file://` origin, and a
 * Chromium profile with site data disabled — and a preference that cannot be
 * saved must never take the app down with it. Failing to remember a device is a
 * minor inconvenience; failing to boot is not.
 */

/** The subset of the `Storage` API this needs. Lets a test pass a plain object. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The storage key. Namespaced because the renderer's origin is shared with
 * anything else that might later want localStorage in this window.
 */
export const DEVICE_KEY = 'castgorilla.lastDeviceId';

export interface DevicePreference {
  /** The remembered device id, or null if there is none (or storage is unusable). */
  read(): string | null;
  /** Remember a device id. `null` forgets, which is what deselecting means. */
  write(id: string | null): void;
}

export function createDevicePreference(storage: KeyValueStorage | null): DevicePreference {
  return {
    read(): string | null {
      if (!storage) return null;
      try {
        const value = storage.getItem(DEVICE_KEY);
        // An empty string is not a device id; treat it as absent so a corrupted
        // or half-written entry cannot be handed to `pickDevice` as a candidate.
        return value !== null && value !== '' ? value : null;
      } catch {
        return null;
      }
    },

    write(id: string | null): void {
      if (!storage) return;
      try {
        if (id === null || id === '') storage.removeItem(DEVICE_KEY);
        else storage.setItem(DEVICE_KEY, id);
      } catch {
        // Deliberately silent. There is no user-actionable failure here and a
        // toast saying "could not remember your device" would be noise on every
        // single selection.
      }
    },
  };
}

/**
 * The browser's `localStorage`, or null when it is not reachable.
 *
 * Merely *accessing* `window.localStorage` throws under a blocked-storage
 * policy, so the access itself is what has to be guarded — not just the later
 * get/set calls.
 */
export function defaultStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
