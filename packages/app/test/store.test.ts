/**
 * store.test.ts — pure renderer store: position interpolation, state
 * transitions, and device selection logic. All time is injected as an explicit
 * `now` so the math is deterministic.
 */

import { describe, expect, it } from 'vitest';
import { Store, shouldShowMockBadge } from '../src/renderer/store.js';
import type {
  DiscoveredDevice,
  MediaInfo,
  SessionStatus,
} from '../src/shared/engine-types.js';

function status(partial: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'playing',
    positionSec: 10,
    durationSec: 100,
    volume: 1,
    muted: false,
    tier: 'direct',
    deviceName: 'Dev',
    activeSubtitleTrackId: null,
    activeAudioStreamIndex: 1,
    warnings: [],
    ...partial,
  };
}

function dev(id: string): DiscoveredDevice {
  return {
    id,
    friendlyName: id,
    model: 'model',
    host: '10.0.0.1',
    port: 8009,
    profile: { key: 'ultra' } as unknown as DiscoveredDevice['profile'],
  };
}

/** Minimal stand-in — the store treats MediaInfo as an opaque payload. */
function media(): MediaInfo {
  return { path: '/x/clip.mkv', container: 'mkv' } as unknown as MediaInfo;
}

describe('Store position interpolation', () => {
  it('advances linearly while playing', () => {
    const store = new Store();
    store.applyStatus(status({ state: 'playing', positionSec: 10 }), 1000);
    expect(store.getPosition(1000)).toBe(10);
    expect(store.getPosition(4000)).toBe(13); // +3s
  });

  it('clamps to duration', () => {
    const store = new Store();
    store.applyStatus(status({ state: 'playing', positionSec: 10, durationSec: 100 }), 1000);
    expect(store.getPosition(1_000_000)).toBe(100);
  });

  it('does not advance while paused', () => {
    const store = new Store();
    store.applyStatus(status({ state: 'paused', positionSec: 20 }), 1000);
    expect(store.getPosition(5000)).toBe(20);
  });

  it('freezes at the interpolated position when playing -> paused', () => {
    const store = new Store();
    store.applyStatus(status({ state: 'playing', positionSec: 10 }), 1000);
    expect(store.getPosition(4000)).toBe(13);
    store.applyState('paused', 4000);
    expect(store.getPosition(9000)).toBe(13); // held
  });

  it('re-baselines on a discrete position update (seek)', () => {
    const store = new Store();
    store.applyStatus(status({ state: 'playing', positionSec: 10 }), 1000);
    store.applyPosition(50, 2000);
    expect(store.getPosition(2000)).toBe(50);
    expect(store.getPosition(5000)).toBe(53); // resumes advancing from 50
  });

  it('clearSession resets position to 0', () => {
    const store = new Store();
    store.applyStatus(status(), 1000);
    store.clearSession(2000);
    expect(store.get().status).toBeNull();
    expect(store.getPosition(3000)).toBe(0);
  });
});

describe('Store device selection', () => {
  it('auto-selects the first device when none chosen', () => {
    const store = new Store();
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('a');
  });

  it('keeps a valid explicit selection across snapshots', () => {
    const store = new Store();
    store.setDevices([dev('a'), dev('b')]);
    store.selectDevice('b');
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('b');
  });

  it('re-selects when the chosen device disappears', () => {
    const store = new Store();
    store.setDevices([dev('a'), dev('b')]);
    store.selectDevice('b');
    store.setDevices([dev('a')]); // b gone
    expect(store.get().selectedDeviceId).toBe('a');
  });

  it('selects null when the device list empties', () => {
    const store = new Store();
    store.setDevices([dev('a')]);
    store.setDevices([]);
    expect(store.get().selectedDeviceId).toBeNull();
  });
});

describe('Store remembered device', () => {
  it('prefers the remembered device over the first one found', () => {
    const store = new Store();
    store.setPreferredDeviceId('b');
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('b');
  });

  it('applies the preference to a list that already arrived', () => {
    // The boot-time race: an mDNS push can beat the storage read.
    const store = new Store();
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('a');
    store.setPreferredDeviceId('b');
    expect(store.get().selectedDeviceId).toBe('b');
  });

  it('falls back to the first device when the remembered one is absent', () => {
    // Routine, not exceptional: mock and real engines mint different ids.
    const store = new Store();
    store.setPreferredDeviceId('gone');
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('a');
  });

  it('does not override an explicit choice when the list refreshes', () => {
    const store = new Store();
    store.setPreferredDeviceId('b');
    store.setDevices([dev('a'), dev('b')]);
    store.selectDevice('a');
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('a');
  });

  it('claims the remembered device when it appears late', () => {
    // The common case, not an edge one: CLAUDE.md records that a device in
    // screensaver/ambient state routinely misses the discovery window and turns
    // up on a later push. If the auto-picked first device held on, the whole
    // feature would only work when your TV happened to answer first.
    const store = new Store();
    store.setPreferredDeviceId('b');
    store.setDevices([dev('a')]);
    expect(store.get().selectedDeviceId).toBe('a');
    store.setDevices([dev('a'), dev('b')]);
    expect(store.get().selectedDeviceId).toBe('b');
  });

  it('does not claim it back over a choice the user made since', () => {
    const store = new Store();
    store.setPreferredDeviceId('b');
    store.setDevices([dev('a')]);
    store.selectDevice('a'); // user picks the one that is there
    store.setDevices([dev('a'), dev('b')]); // remembered device shows up late
    expect(store.get().selectedDeviceId).toBe('a');
  });

  it('stops treating a vanished explicit choice as explicit', () => {
    const store = new Store();
    store.setPreferredDeviceId('c');
    store.setDevices([dev('a'), dev('b'), dev('c')]);
    store.selectDevice('b');
    store.setDevices([dev('a')]); // b and c both gone; fall back to a
    expect(store.get().selectedDeviceId).toBe('a');
    store.setDevices([dev('a'), dev('c')]); // c returns
    // 'a' was the store's fallback, not the user's pick, so the remembered
    // device outranks it again.
    expect(store.get().selectedDeviceId).toBe('c');
  });
});

describe('Mock badge visibility', () => {
  it('is hidden before the mode is known', () => {
    expect(shouldShowMockBadge(null)).toBe(false);
  });

  it('is shown on the deliberate CASTGORILLA_MOCK override', () => {
    expect(shouldShowMockBadge({ mock: true, reason: 'forced by CASTGORILLA_MOCK=1' })).toBe(true);
  });

  it('is shown on a real-engine fallback', () => {
    expect(shouldShowMockBadge({ mock: true, reason: 'real engine unavailable — boom' })).toBe(true);
  });

  it('is hidden on the real engine', () => {
    expect(shouldShowMockBadge({ mock: false })).toBe(false);
  });

  it('tracks the store mode as it is set', () => {
    const store = new Store();
    expect(shouldShowMockBadge(store.get().mode)).toBe(false); // initial: null
    store.setMode({ mock: false });
    expect(shouldShowMockBadge(store.get().mode)).toBe(false);
    store.setMode({ mock: true });
    expect(shouldShowMockBadge(store.get().mode)).toBe(true);
  });
});

describe('Store probing lifecycle', () => {
  it('is false before any file is chosen', () => {
    const store = new Store();
    expect(store.get().probing).toBe(false);
  });

  it('setFile(path) starts probing', () => {
    const store = new Store();
    store.setFile('/x/clip.mkv');
    expect(store.get().probing).toBe(true);
  });

  it('setMedia(info) ends probing on the success path', () => {
    const store = new Store();
    store.setFile('/x/clip.mkv');
    store.setMedia(media());
    expect(store.get().probing).toBe(false);
    expect(store.get().media).not.toBeNull();
  });

  it('setMedia(null) ends probing on the FAILURE path', () => {
    // main.ts reports a failed probe as setMedia(null); there is no separate
    // setProbeFailed, so this must clear the flag or the UI spins forever.
    const store = new Store();
    store.setFile('/x/clip.mkv');
    store.setMedia(null);
    expect(store.get().probing).toBe(false);
    expect(store.get().media).toBeNull();
  });

  it('setFile(null) clears probing', () => {
    const store = new Store();
    store.setFile('/x/clip.mkv');
    store.setFile(null);
    expect(store.get().probing).toBe(false);
    expect(store.get().file).toBeNull();
  });

  it('re-probes when a second file is chosen after a completed probe', () => {
    const store = new Store();
    store.setFile('/x/one.mkv');
    store.setMedia(media());
    store.setFile('/x/two.mkv');
    expect(store.get().probing).toBe(true);
    // setFile still clears the previous probe result.
    expect(store.get().media).toBeNull();
    expect(store.get().plan).toBeNull();
  });

  it('notifies subscribers on each probing transition', () => {
    const store = new Store();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setFile('/x/clip.mkv');
    store.setMedia(media());
    expect(calls).toBe(2);
  });
});

describe('Store prefs + warnings', () => {
  it('merges pref patches', () => {
    const store = new Store();
    store.setPrefs({ surround: true });
    store.setPrefs({ hdrPolicy: 'block' });
    expect(store.get().prefs).toEqual({ surround: true, hdrPolicy: 'block' });
  });

  it('adds and removes warnings', () => {
    const store = new Store();
    store.addWarning('w1');
    store.addWarning('w2');
    expect(store.get().warnings).toEqual(['w1', 'w2']);
    store.removeWarning('w1');
    expect(store.get().warnings).toEqual(['w2']);
  });
});
