/**
 * renderer-device-preference.test.ts — remembering the last-used device.
 *
 * The feature is two localStorage calls, so what is actually worth testing is
 * the failure behaviour: a renderer whose storage throws must still boot, and a
 * half-written entry must not be handed on as a device id.
 */

import { describe, expect, it } from 'vitest';
import {
  DEVICE_KEY,
  createDevicePreference,
  type KeyValueStorage,
} from '../src/renderer/device-preference.js';

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** Storage that throws on every access, as a blocked-storage policy does. */
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

describe('device preference', () => {
  it('round-trips a device id', () => {
    const pref = createDevicePreference(fakeStorage());
    pref.write('living-room');
    expect(pref.read()).toBe('living-room');
  });

  it('reads null when nothing has been stored', () => {
    expect(createDevicePreference(fakeStorage()).read()).toBeNull();
  });

  it('treats an empty stored value as absent', () => {
    // Otherwise `pickDevice` would be offered '' as a candidate device id.
    const pref = createDevicePreference(fakeStorage({ [DEVICE_KEY]: '' }));
    expect(pref.read()).toBeNull();
  });

  it('forgets on a null write', () => {
    const pref = createDevicePreference(fakeStorage({ [DEVICE_KEY]: 'living-room' }));
    pref.write(null);
    expect(pref.read()).toBeNull();
  });

  it('survives storage that throws on read', () => {
    expect(createDevicePreference(hostileStorage()).read()).toBeNull();
  });

  it('survives storage that throws on write', () => {
    // The real requirement: a failed preference write must never reach the user
    // as an exception, because it happens on every device selection.
    expect(() => createDevicePreference(hostileStorage()).write('x')).not.toThrow();
  });

  it('is inert with no storage at all', () => {
    const pref = createDevicePreference(null);
    expect(() => pref.write('x')).not.toThrow();
    expect(pref.read()).toBeNull();
  });
});
