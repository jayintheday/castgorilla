/**
 * _shared.mjs — helpers shared by the cast spike scripts.
 *
 * The spikes drive the REAL engine cast stack (compiled to packages/engine/dist),
 * so run `npm run build` first. Engine modules are imported lazily so `--help`
 * works even before a build exists.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../packages/engine/dist');

/** Lazily import the built engine cast stack. */
export async function loadEngine() {
  const clientPath = path.join(DIST, 'cast/client.js');
  if (!fs.existsSync(clientPath)) {
    throw new Error(
      `engine build not found at ${DIST}. Run \`npm run build\` from the repo root first.`,
    );
  }
  const [{ CastClient }, { CastDiscovery }, profiles] = await Promise.all([
    import(path.join(DIST, 'cast/client.js')),
    import(path.join(DIST, 'devices/discovery.js')),
    import(path.join(DIST, 'devices/profiles.js')),
  ]);
  return { CastClient, CastDiscovery, resolveProfile: profiles.resolveProfile };
}

/** Minimal flag parser: `--key value` and boolean `--flag`. */
export function parseArgs(argv, booleanFlags = []) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (booleanFlags.includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

/** Browse for Chromecasts for `timeoutMs`, resolving the deduped device list. */
export async function discoverDevices({ timeoutMs = 4000, onFound } = {}) {
  const { CastDiscovery } = await loadEngine();
  const discovery = new CastDiscovery();
  const byId = new Map();
  discovery.on('device', (d) => {
    const isNew = !byId.has(d.id);
    byId.set(d.id, d);
    if (isNew && onFound) onFound(d);
  });
  discovery.on('error', (err) => console.error('discovery error:', err.message));
  discovery.start();
  await new Promise((r) => setTimeout(r, timeoutMs));
  discovery.stop();
  return [...byId.values()];
}

/** Select a device by --device name/id substring (case-insensitive), or the sole device. */
export function pickDevice(devices, name) {
  if (devices.length === 0) return undefined;
  if (!name) {
    if (devices.length === 1) return devices[0];
    return undefined; // ambiguous — caller should list and ask
  }
  const q = name.toLowerCase();
  return (
    devices.find((d) => d.friendlyName.toLowerCase() === q || d.id.toLowerCase() === q) ??
    devices.find((d) => d.friendlyName.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
  );
}

/** Pretty one-liner for a discovered device. */
export function describeDevice(d) {
  return `${d.friendlyName}  [${d.model || 'unknown model'} -> profile ${d.profile.key}]  ${d.host}:${d.port}  id=${d.id}`;
}

/** JSON with stable, readable formatting (used to print status verbatim). */
export function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}
