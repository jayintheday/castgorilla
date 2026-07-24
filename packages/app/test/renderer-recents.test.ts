/**
 * renderer-recents.test.ts — the "pick up where you left off" model.
 *
 * Three things are worth pinning, all of them easy to "simplify" wrong:
 *  - upsert ordering + cap: replaying a file moves it to the front (not a second
 *    card), and the list never grows past its cap.
 *  - the human formatting: "yesterday · 34% in" / "today · finished". The percent
 *    and the relative day are what the card actually says, so their wording is a
 *    behaviour, not an implementation detail.
 *  - persistence resilience: a blocked-storage policy must yield [] and never
 *    throw, exactly like device-preference.
 */

import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/renderer/device-preference.js';
import type { RecentEntry } from '../src/renderer/recents.js';
import {
  RECENTS_CAP,
  createRecents,
  formatRecentMeta,
  isFinished,
  relativeDay,
  resumePercent,
  upsertRecent,
} from '../src/renderer/recents.js';

function entry(over: Partial<RecentEntry> = {}): RecentEntry {
  return {
    path: '/x/a.mkv',
    name: 'a.mkv',
    lastPlayedAt: 0,
    positionSec: 34,
    durationSec: 100,
    ...over,
  };
}

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function hostileStorage(): KeyValueStorage {
  return {
    getItem() {
      throw new Error('access denied');
    },
    setItem() {
      throw new Error('access denied');
    },
    removeItem() {
      throw new Error('access denied');
    },
  };
}

// Local-noon timestamps a whole number of calendar days apart, so the day math is
// stable regardless of the machine's timezone (July has no DST transition).
const NOW = new Date(2026, 6, 23, 12, 0, 0).getTime();
const daysAgo = (n: number): number => new Date(2026, 6, 23 - n, 12, 0, 0).getTime();

describe('upsertRecent', () => {
  it('adds a new entry at the front', () => {
    const list = upsertRecent([entry({ path: '/a' })], entry({ path: '/b' }));
    expect(list.map((e) => e.path)).toEqual(['/b', '/a']);
  });

  it('moves an existing path to the front instead of duplicating it', () => {
    const list = upsertRecent(
      [entry({ path: '/a' }), entry({ path: '/b' }), entry({ path: '/c' })],
      entry({ path: '/b', positionSec: 90 }),
    );
    expect(list.map((e) => e.path)).toEqual(['/b', '/a', '/c']);
    expect(list[0]?.positionSec).toBe(90);
  });

  it('caps the list length, dropping the oldest', () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENTS_CAP + 5; i += 1) {
      list = upsertRecent(list, entry({ path: `/f${i}` }));
    }
    expect(list.length).toBe(RECENTS_CAP);
    expect(list[0]?.path).toBe(`/f${RECENTS_CAP + 4}`); // newest first
  });

  it('honours an explicit cap', () => {
    const list = upsertRecent(
      [entry({ path: '/a' }), entry({ path: '/b' })],
      entry({ path: '/c' }),
      2,
    );
    expect(list.map((e) => e.path)).toEqual(['/c', '/a']);
  });
});

describe('resumePercent', () => {
  it('is the position as a percentage of duration', () => {
    expect(resumePercent(50, 100)).toBe(50);
  });

  it('is 0 for an unknown or zero duration', () => {
    expect(resumePercent(50, 0)).toBe(0);
    expect(resumePercent(50, Number.NaN)).toBe(0);
  });

  it('clamps past the end to 100', () => {
    expect(resumePercent(150, 100)).toBe(100);
  });
});

describe('isFinished', () => {
  it('is true near the very end', () => {
    expect(isFinished(entry({ positionSec: 99, durationSec: 100 }))).toBe(true);
  });

  it('is false partway through', () => {
    expect(isFinished(entry({ positionSec: 34, durationSec: 100 }))).toBe(false);
  });

  it('is false when the duration is unknown', () => {
    expect(isFinished(entry({ positionSec: 34, durationSec: 0 }))).toBe(false);
  });
});

describe('relativeDay', () => {
  it('reads today / yesterday for recent days', () => {
    expect(relativeDay(NOW, NOW)).toBe('today');
    expect(relativeDay(daysAgo(1), NOW)).toBe('yesterday');
  });

  it('counts days within the week', () => {
    expect(relativeDay(daysAgo(3), NOW)).toBe('3 days ago');
  });

  it('softens to weeks and beyond', () => {
    expect(relativeDay(daysAgo(9), NOW)).toBe('last week');
    expect(relativeDay(daysAgo(20), NOW)).toBe('2 weeks ago');
    expect(relativeDay(daysAgo(45), NOW)).toBe('last month');
    expect(relativeDay(daysAgo(400), NOW)).toBe('a while ago');
  });
});

describe('formatRecentMeta', () => {
  it('joins the relative day with the resume percent', () => {
    expect(formatRecentMeta(entry({ lastPlayedAt: daysAgo(1) }), NOW)).toBe(
      'yesterday · 34% in',
    );
  });

  it('says "finished" instead of a percent near the end', () => {
    expect(
      formatRecentMeta(entry({ lastPlayedAt: NOW, positionSec: 99, durationSec: 100 }), NOW),
    ).toBe('today · finished');
  });

  it('drops the resume clause when nothing has been watched yet', () => {
    expect(
      formatRecentMeta(entry({ lastPlayedAt: NOW, positionSec: 0, durationSec: 100 }), NOW),
    ).toBe('today');
  });
});

describe('createRecents persistence', () => {
  it('records and lists newest-first', () => {
    const store = createRecents(fakeStorage());
    store.record(entry({ path: '/a' }));
    store.record(entry({ path: '/b' }));
    expect(store.list().map((e) => e.path)).toEqual(['/b', '/a']);
  });

  it('round-trips through storage', () => {
    const backing = fakeStorage();
    createRecents(backing).record(entry({ path: '/a' }));
    expect(createRecents(backing).list().map((e) => e.path)).toEqual(['/a']);
  });

  it('clears the list', () => {
    const store = createRecents(fakeStorage());
    store.record(entry({ path: '/a' }));
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('removes exactly one entry by path, preserving the order of the rest', () => {
    const store = createRecents(fakeStorage());
    store.record(entry({ path: '/a' }));
    store.record(entry({ path: '/b' }));
    store.record(entry({ path: '/c' })); // list is now [c, b, a]
    const after = store.remove('/b');
    expect(after.map((e) => e.path)).toEqual(['/c', '/a']);
    // persisted, not just returned
    expect(store.list().map((e) => e.path)).toEqual(['/c', '/a']);
  });

  it('removing the only entry yields []', () => {
    const store = createRecents(fakeStorage());
    store.record(entry({ path: '/a' }));
    expect(store.remove('/a')).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it('removing an unknown path is a no-op', () => {
    const store = createRecents(fakeStorage());
    store.record(entry({ path: '/a' }));
    expect(store.remove('/missing').map((e) => e.path)).toEqual(['/a']);
  });

  it('drops corrupt entries rather than blanking the whole grid', () => {
    const backing = fakeStorage({
      'castgorilla.recents': JSON.stringify([
        entry({ path: '/good' }),
        { path: 42 }, // malformed
        { path: '/bad', name: 'x', lastPlayedAt: 'nope', positionSec: 1, durationSec: 2 },
      ]),
    });
    expect(createRecents(backing).list().map((e) => e.path)).toEqual(['/good']);
  });

  it('returns [] and never throws under a blocked-storage policy', () => {
    const store = createRecents(hostileStorage());
    expect(store.list()).toEqual([]);
    expect(() => store.record(entry())).not.toThrow();
    expect(() => store.remove('/x/a.mkv')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('is inert with no storage at all', () => {
    const store = createRecents(null);
    expect(store.list()).toEqual([]);
    expect(() => store.record(entry())).not.toThrow();
  });
});
