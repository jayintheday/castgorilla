/**
 * recents.ts — "Pick up where you left off": the recently-played list.
 *
 * Two halves, both pure of the DOM (the VIEW is in `views/recents.ts`):
 *
 *  - the SHAPE and the FORMATTERS — what a recent entry is, and how its resume
 *    position and last-played time read as ordinary English on a card. These are
 *    unit-tested (`renderer-recents.test.ts`) so the "34% in" / "yesterday"
 *    wording cannot silently rot.
 *  - the PERSISTENCE — a `localStorage`-backed list, following the same injected,
 *    guarded pattern as `device-preference.ts`: storage can be unreachable (a
 *    `file://` origin, a blocked-storage policy) and a recents feature must never
 *    take the app down with it.
 *
 * The list is capped and de-duplicated by path: replaying a file moves it to the
 * front rather than adding a second card, and the oldest fall off the end.
 */

import type { KeyValueStorage } from './device-preference.js';

export interface RecentEntry {
  /** Absolute path of the file, and the identity used for de-duplication. */
  path: string;
  /** The display name (`formatFileName(path)`), cached at record time. */
  name: string;
  /** When this entry was last recorded, epoch ms. */
  lastPlayedAt: number;
  /** The last OBSERVED playback position, seconds (never the interpolated one). */
  positionSec: number;
  /** The media duration, seconds; 0 when unknown. */
  durationSec: number;
}

/** localStorage key. Namespaced like `DEVICE_KEY`. */
export const RECENTS_KEY = 'castgorilla.recents';
/** How many entries are retained on disk. */
export const RECENTS_CAP = 12;
/** How many cards the empty-state grid shows (it is a 3-up grid). */
export const RECENTS_SHOWN = 6;

/** At or beyond this fraction of the runtime, a file reads as "finished". */
const FINISHED_FRACTION = 0.97;

const MS_PER_DAY = 86_400_000;

// --- pure model + formatters (unit-tested; no DOM, no storage) ---------------

/**
 * Insert `entry` at the front, drop any earlier entry for the same path, and cap
 * the length. Pure: the caller owns reading and writing.
 */
export function upsertRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  cap: number = RECENTS_CAP,
): RecentEntry[] {
  const rest = list.filter((e) => e.path !== entry.path);
  return [entry, ...rest].slice(0, cap);
}

/** Resume position as a 0..100 percentage, clamped and safe for an unknown duration. */
export function resumePercent(positionSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  if (!Number.isFinite(positionSec) || positionSec <= 0) return 0;
  return Math.min(100, Math.max(0, (positionSec / durationSec) * 100));
}

/** Whether the entry is effectively watched to the end. */
export function isFinished(entry: RecentEntry): boolean {
  if (!Number.isFinite(entry.durationSec) || entry.durationSec <= 0) return false;
  return entry.positionSec / entry.durationSec >= FINISHED_FRACTION;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A relative CALENDAR-day phrase ("today", "yesterday", "3 days ago", …).
 *
 * Bucketed by whole days between local midnights, not by elapsed hours: a file
 * played at 11pm and looked at again at 1am is "yesterday", which is how a person
 * reads it, whereas an hours-based delta would call it "today".
 */
export function relativeDay(then: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(then)) / MS_PER_DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 31) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 61) return 'last month';
  return 'a while ago';
}

/**
 * The card's meta line, e.g. `yesterday · 34% in` or `today · finished`.
 *
 * The resume clause is dropped when the position is at (or below) zero — a card
 * that has never been past 0:00 has nothing to resume, so `today` alone is the
 * honest line.
 */
export function formatRecentMeta(entry: RecentEntry, now: number): string {
  const day = relativeDay(entry.lastPlayedAt, now);
  if (isFinished(entry)) return `${day} · finished`;
  const pct = Math.round(resumePercent(entry.positionSec, entry.durationSec));
  if (pct <= 0) return day;
  return `${day} · ${pct}% in`;
}

// --- persistence (localStorage-backed; guarded) ------------------------------

function isValidEntry(value: unknown): value is RecentEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.path === 'string' &&
    e.path.length > 0 &&
    typeof e.name === 'string' &&
    typeof e.lastPlayedAt === 'number' &&
    Number.isFinite(e.lastPlayedAt) &&
    typeof e.positionSec === 'number' &&
    Number.isFinite(e.positionSec) &&
    typeof e.durationSec === 'number' &&
    Number.isFinite(e.durationSec)
  );
}

export interface RecentsStore {
  /** The stored list, newest first (or `[]` when storage is empty/unusable). */
  list(): RecentEntry[];
  /** Upsert an entry, persist, and return the new list. */
  record(entry: RecentEntry): RecentEntry[];
  /** Drop the entry for `path` (if any), persist, and return the new list. */
  remove(path: string): RecentEntry[];
  /** Forget everything. */
  clear(): void;
}

export function createRecents(
  storage: KeyValueStorage | null,
  cap: number = RECENTS_CAP,
): RecentsStore {
  function read(): RecentEntry[] {
    if (!storage) return [];
    try {
      const raw = storage.getItem(RECENTS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // A corrupt or partially-written entry is dropped rather than handed on —
      // one bad card must not blank the whole grid.
      return parsed.filter(isValidEntry).slice(0, cap);
    } catch {
      return [];
    }
  }

  function write(list: readonly RecentEntry[]): void {
    if (!storage) return;
    try {
      storage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, cap)));
    } catch {
      // Deliberately silent — a failed recents write is a minor inconvenience,
      // and it can happen on every position tick.
    }
  }

  return {
    list: read,
    record(entry: RecentEntry): RecentEntry[] {
      const next = upsertRecent(read(), entry, cap);
      write(next);
      return next;
    },
    remove(path: string): RecentEntry[] {
      const next = read().filter((e) => e.path !== path);
      write(next);
      return next;
    },
    clear(): void {
      if (!storage) return;
      try {
        storage.removeItem(RECENTS_KEY);
      } catch {
        // See write(): storage may be unreachable; that is not the user's problem.
      }
    },
  };
}
