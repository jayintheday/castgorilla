/**
 * net.ts — LAN interface selection.
 *
 * When streaming to a Cast device we must advertise a URL the device can reach,
 * i.e. an address on the *same subnet* as the device. pickLanIp compares the
 * host's IPv4 interfaces (with netmask math) against the device host and returns
 * the best local address, falling back to the first non-internal IPv4.
 */

import os from 'node:os';

/** A minimal shape compatible with os.NetworkInterfaceInfo (IPv4 subset we need). */
export interface InterfaceAddr {
  address: string;
  netmask: string;
  family: string | number; // Node reports 'IPv4' (newer) or 4 (older)
  internal: boolean;
}

export type InterfaceMap = Record<string, InterfaceAddr[] | undefined>;

function isIPv4(a: InterfaceAddr): boolean {
  return a.family === 'IPv4' || a.family === 4;
}

/** Parse a dotted-quad IPv4 string to a uint32, or null if malformed. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = (acc << 8) | n;
  }
  // Coerce to unsigned 32-bit.
  return acc >>> 0;
}

function sameSubnet(a: string, b: string, mask: string): boolean {
  const ai = ipv4ToInt(a);
  const bi = ipv4ToInt(b);
  const mi = ipv4ToInt(mask);
  if (ai === null || bi === null || mi === null) return false;
  return ((ai & mi) >>> 0) === ((bi & mi) >>> 0);
}

/**
 * Choose the local interface IP on the same subnet as `deviceHost`.
 * Falls back to the first non-internal IPv4 address when no subnet matches
 * (or when deviceHost is not a parseable IPv4). Throws only if the machine has
 * no usable non-internal IPv4 interface at all.
 *
 * `ifaces` is injectable for testing; defaults to os.networkInterfaces().
 */
export function pickLanIp(deviceHost: string, ifaces: InterfaceMap = os.networkInterfaces()): string {
  const candidates: InterfaceAddr[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (isIPv4(addr) && !addr.internal) candidates.push(addr);
    }
  }

  if (candidates.length === 0) {
    throw new Error('pickLanIp: no non-internal IPv4 interface available on this host');
  }

  // Prefer an interface on the same subnet as the device.
  for (const addr of candidates) {
    if (sameSubnet(addr.address, deviceHost, addr.netmask)) return addr.address;
  }

  // Fallback: first non-internal IPv4.
  return candidates[0]!.address;
}
