/**
 * renderer-device-picker.test.ts — the `data-state` inference.
 *
 * Discovery is a subscription with no completion event, so "no devices" is never
 * something the app is told — only something it may infer from silence. These
 * tests pin the two properties that inference must have:
 *
 *  1. It NEVER says "none" at startup. CLAUDE.md records that a device in
 *     screensaver state routinely misses a 5s window and appears on a retry, and
 *     that the failure "will read as 'the app doesn't see my TV'". An amber hint
 *     in the first second of every launch would manufacture exactly that.
 *  2. It is not sticky. A device arriving after the grace period flips straight
 *     back to "found", because devices genuinely do keep arriving.
 */

import { describe, expect, it } from 'vitest';
import type { DeviceProfile, DiscoveredDevice } from '../src/shared/engine-types.js';
import {
  DEVICE_SEARCH_GRACE_MS,
  REFRESH_MIN_MS,
  buildDeviceRows,
  deviceCountText,
  deriveDeviceState,
  deviceHintText,
  effectiveDeviceState,
} from '../src/renderer/views/device-picker.js';

const PROFILE: DeviceProfile = {
  key: 'gen2',
  matchModels: ['Chromecast'],
  video: { h264: { maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 } },
  hdr: { hdr10: false, dv: false },
  audioCodecs: ['aac', 'mp3'],
  surroundPassthrough: false,
  hls: { fmp4: 'untested', hevcInHls: 'untested', segmentFormatFallback: 'ts' },
};

function device(over: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    id: 'device-1',
    friendlyName: 'Living Room',
    model: 'Chromecast HD',
    host: '192.168.1.50',
    port: 8009,
    profile: PROFILE,
    ...over,
  };
}

describe('deriveDeviceState', () => {
  it('starts at "searching", never at "none"', () => {
    expect(deriveDeviceState(0, 0)).toBe('searching');
    expect(deriveDeviceState(0, 250)).toBe('searching');
  });

  it('stays "searching" for the whole grace period', () => {
    expect(deriveDeviceState(0, DEVICE_SEARCH_GRACE_MS - 1)).toBe('searching');
  });

  it('falls to "none" only once the grace period has elapsed', () => {
    expect(deriveDeviceState(0, DEVICE_SEARCH_GRACE_MS)).toBe('none');
    expect(deriveDeviceState(0, DEVICE_SEARCH_GRACE_MS + 5000)).toBe('none');
  });

  it('grace period is comfortably longer than the CLI 5s window that is documented as too short', () => {
    expect(DEVICE_SEARCH_GRACE_MS).toBeGreaterThan(5000);
  });

  it('goes to "found" the instant any device appears, however early', () => {
    expect(deriveDeviceState(1, 0)).toBe('found');
    expect(deriveDeviceState(1, 10)).toBe('found');
  });

  it('goes to "found" from "none" — a late device is still a device', () => {
    expect(deriveDeviceState(0, DEVICE_SEARCH_GRACE_MS + 30_000)).toBe('none');
    expect(deriveDeviceState(2, DEVICE_SEARCH_GRACE_MS + 30_000)).toBe('found');
  });

  it('honours an explicit grace period', () => {
    expect(deriveDeviceState(0, 100, 1000)).toBe('searching');
    expect(deriveDeviceState(0, 1000, 1000)).toBe('none');
  });
});

describe('deviceHintText', () => {
  it('is calm while searching', () => {
    expect(deviceHintText('searching', 0)).toBe('Looking for devices on your network…');
  });

  it('does NOT claim discovery failed — nothing told us that', () => {
    const text = deviceHintText('none', 0);
    expect(text.toLowerCase()).not.toContain('no devices found');
    expect(text.toLowerCase()).not.toContain('failed');
    expect(text).toContain('Still looking');
  });

  it('suggests the same-network check, which is the fix that actually works', () => {
    expect(deviceHintText('none', 0)).toContain('Wi-Fi');
  });

  it('counts devices grammatically when found', () => {
    expect(deviceHintText('found', 1)).toBe('1 device found');
    expect(deviceHintText('found', 3)).toBe('3 devices found');
  });
});

describe('buildDeviceRows', () => {
  it('renders a device as id, friendly name and a friendly TYPE label', () => {
    // The type label comes from the matched profile (gen2 → "Chromecast"), NOT
    // the raw model string — see device-labels.ts.
    expect(buildDeviceRows([device()], 'device-1')).toEqual([
      { id: 'device-1', name: 'Living Room', type: 'Chromecast', selected: true },
    ]);
  });

  it('marks exactly the selected row', () => {
    const rows = buildDeviceRows([device({ id: 'a' }), device({ id: 'b' })], 'b');
    expect(rows.map((r) => r.selected)).toEqual([false, true]);
  });

  it('marks nothing selected when the id matches no device', () => {
    const rows = buildDeviceRows([device({ id: 'a' }), device({ id: 'b' })], 'gone');
    expect(rows.some((r) => r.selected)).toBe(false);
  });

  it('yields no rows for an empty list — the hint and count carry the message', () => {
    expect(buildDeviceRows([], null)).toEqual([]);
  });

  it('uses the device id (the engine looks devices up by it)', () => {
    const rows = buildDeviceRows([device({ id: 'abc' }), device({ id: 'def' })], null);
    expect(rows.map((r) => r.id)).toEqual(['abc', 'def']);
  });
});

describe('deviceCountText', () => {
  it('counts ready devices grammatically', () => {
    expect(deviceCountText('found', 1)).toBe('1 device ready');
    expect(deviceCountText('found', 3)).toBe('3 devices ready');
  });

  it('says it is searching before the grace period expires', () => {
    expect(deviceCountText('searching', 0)).toBe('Searching…');
  });

  it('does not claim discovery failed once the grace period elapses', () => {
    expect(deviceCountText('none', 0).toLowerCase()).not.toContain('failed');
  });
});

describe('effectiveDeviceState (manual-refresh feedback)', () => {
  it('forces "searching" while a refresh is in flight, whatever the derived state', () => {
    // The point of Refresh is visible feedback, so it pins "searching" even when
    // devices are already found — a re-query genuinely might surface more.
    expect(effectiveDeviceState('found', true)).toBe('searching');
    expect(effectiveDeviceState('none', true)).toBe('searching');
    expect(effectiveDeviceState('searching', true)).toBe('searching');
  });

  it('passes the derived state straight through when no refresh is in flight', () => {
    expect(effectiveDeviceState('found', false)).toBe('found');
    expect(effectiveDeviceState('none', false)).toBe('none');
    expect(effectiveDeviceState('searching', false)).toBe('searching');
  });
});

describe('REFRESH_MIN_MS', () => {
  it('is a visible minimum — long enough that an instant rescan still reads as an action', () => {
    expect(REFRESH_MIN_MS).toBeGreaterThanOrEqual(2000);
  });
});
