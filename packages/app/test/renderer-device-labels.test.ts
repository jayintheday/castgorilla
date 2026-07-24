/**
 * renderer-device-labels.test.ts — the DeviceKey → friendly TYPE label map.
 *
 * The sidebar device row shows a "what kind of device is this" sub-line derived
 * from the matched profile, not the raw mDNS `md` string. Two properties matter:
 * the map is exhaustive over the frozen `DeviceKey` union (so a new device class
 * cannot silently render a blank sub-label), and the one key with no friendly
 * name — `unknown` — falls back to the device's own model, then to a generic
 * label when even that is blank.
 */

import { describe, expect, it } from 'vitest';
import type { DeviceKey, DeviceProfile, DiscoveredDevice } from '../src/shared/engine-types.js';
import { deviceTypeLabel } from '../src/renderer/device-labels.js';

function device(key: DeviceKey, model = 'Some Model'): DiscoveredDevice {
  return {
    id: 'd',
    friendlyName: 'TV',
    model,
    host: '10.0.0.2',
    port: 8009,
    profile: { key } as unknown as DeviceProfile,
  };
}

describe('deviceTypeLabel', () => {
  it('labels the Chromecast generations plainly', () => {
    for (const key of ['gen1', 'gen2', 'gen3'] as const) {
      expect(deviceTypeLabel(device(key))).toBe('Chromecast');
    }
  });

  it('names the Ultra', () => {
    expect(deviceTypeLabel(device('ultra'))).toBe('Chromecast Ultra');
  });

  it('labels Google TV hardware', () => {
    expect(deviceTypeLabel(device('ccgtv'))).toBe('Google TV');
    expect(deviceTypeLabel(device('gtv-streamer'))).toBe('Google TV');
  });

  it('labels the Shield as Android TV', () => {
    expect(deviceTypeLabel(device('shield'))).toBe('Android TV');
  });

  it('falls back to the raw model for an unclassified device', () => {
    expect(deviceTypeLabel(device('unknown', 'Fancy Box 9000'))).toBe('Fancy Box 9000');
  });

  it('uses a generic label when an unknown device has no usable model', () => {
    expect(deviceTypeLabel(device('unknown', '   '))).toBe('Cast device');
  });
});
