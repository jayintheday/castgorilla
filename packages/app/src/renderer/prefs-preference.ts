/**
 * prefs-preference.ts — remembering the two Advanced preferences across launches.
 *
 * `surround` and `hdrPolicy` are the only prefs the UI exposes, and both drive a
 * replan. Persisting them means a user who always wants surround, or always wants
 * HDR blocked, does not re-set it on every launch. Same injected-storage, fully
 * guarded pattern as `device-preference.ts` — a blocked-storage policy or a
 * `file://` origin must never keep the app from booting.
 *
 * Only the two persisted fields are stored; the rest of `PlaybackPrefs`
 * (`preferredAudioLang`, `forceTranscode`, …) has no UI and no default worth
 * remembering, so it is deliberately not round-tripped.
 */

import type { PlaybackPrefs } from '../shared/engine-types.js';
import type { KeyValueStorage } from './device-preference.js';

export const PREFS_KEY = 'castgorilla.prefs';

/** The subset of prefs the UI owns and this module persists. */
export type StoredPrefs = Pick<PlaybackPrefs, 'surround' | 'hdrPolicy'>;

export interface PrefsPreference {
  /** The stored prefs, or `null` when nothing valid is stored. */
  read(): StoredPrefs | null;
  write(prefs: StoredPrefs): void;
}

export function createPrefsPreference(storage: KeyValueStorage | null): PrefsPreference {
  return {
    read(): StoredPrefs | null {
      if (!storage) return null;
      try {
        const raw = storage.getItem(PREFS_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const p = parsed as Record<string, unknown>;
        // Coerce to the known-good defaults rather than trusting the JSON: a
        // hand-edited or half-written blob must not put an invalid pref in flight.
        return {
          surround: p.surround === true,
          hdrPolicy: p.hdrPolicy === 'block' ? 'block' : 'warn',
        };
      } catch {
        return null;
      }
    },

    write(prefs: StoredPrefs): void {
      if (!storage) return;
      try {
        storage.setItem(
          PREFS_KEY,
          JSON.stringify({ surround: prefs.surround, hdrPolicy: prefs.hdrPolicy }),
        );
      } catch {
        // Deliberately silent — a failed pref write is a minor inconvenience and
        // happens on every toggle.
      }
    },
  };
}
