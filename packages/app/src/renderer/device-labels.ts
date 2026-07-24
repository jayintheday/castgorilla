/**
 * device-labels.ts — a friendly TYPE sub-label for a discovered device.
 *
 * The sidebar device row shows two lines: the user's own name for the device
 * (`friendlyName`, e.g. "Living Room") and, under it, what KIND of device it is.
 * The kind is derived from the profile the planner matched, not from the raw
 * mDNS `md` string — "Chromecast" reads better than "Chromecast Ultra 4K" and,
 * more importantly, it is the same vocabulary the rest of the UI uses.
 *
 * The map is EXHAUSTIVE over the frozen `DeviceKey` union (a `Record`), so a new
 * device class added to the contract is a compile error here rather than a blank
 * sub-label. `unknown` is the one key with no friendly name — the profile table
 * could not place it — so it falls back to the device's own reported model, and
 * to a generic label only if even that is empty.
 */

import type { DeviceKey, DiscoveredDevice } from '../shared/engine-types.js';

/**
 * The friendly type label per profile key, or `null` for "no better name than
 * the device's own model string". Exhaustive over `DeviceKey`.
 */
const DEVICE_TYPE_LABEL: Record<DeviceKey, string | null> = {
  gen1: 'Chromecast',
  gen2: 'Chromecast',
  gen3: 'Chromecast',
  ultra: 'Chromecast Ultra',
  ccgtv: 'Google TV',
  'gtv-streamer': 'Google TV',
  shield: 'Android TV',
  // The profile table could not classify this device, so the raw model is the
  // most honest thing to show — see the fallback in deviceTypeLabel.
  unknown: null,
};

/**
 * A short, human "what is this" label for a device row's sub-line.
 *
 * Falls back to the device's raw `model` for the `unknown` profile, and to a
 * generic "Cast device" only when that is blank too (an oddly-tagged device with
 * no usable `md`).
 */
export function deviceTypeLabel(device: DiscoveredDevice): string {
  const label = DEVICE_TYPE_LABEL[device.profile.key];
  if (label) return label;
  return device.model.trim() || 'Cast device';
}
