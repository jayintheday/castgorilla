import { describe, it, expect } from 'vitest';
import { pickLanIp, ipv4ToInt, type InterfaceMap } from '../src/util/net.js';

const base: InterfaceMap = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  en1: [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
};

describe('pickLanIp', () => {
  it('selects the interface on the same /24 subnet as the device', () => {
    expect(pickLanIp('192.168.1.50', base)).toBe('192.168.1.23');
    expect(pickLanIp('10.0.0.200', base)).toBe('10.0.0.5');
  });

  it('falls back to the first non-internal IPv4 when no subnet matches', () => {
    expect(pickLanIp('172.16.9.9', base)).toBe('192.168.1.23');
  });

  it('falls back when the device host is not a valid IPv4', () => {
    expect(pickLanIp('chromecast.local', base)).toBe('192.168.1.23');
  });

  it('ignores internal and IPv6 addresses', () => {
    const m: InterfaceMap = {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
        { address: '192.168.5.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      ],
    };
    expect(pickLanIp('192.168.5.99', m)).toBe('192.168.5.10');
  });

  it('respects netmask width — a /16 match beats an unrelated /24 fallback', () => {
    const m: InterfaceMap = {
      // listed first -> would be the fallback if nothing matched
      en0: [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      // only matches 192.168.250.4 under a /16 mask
      en1: [{ address: '192.168.1.10', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
    };
    expect(pickLanIp('192.168.250.4', m)).toBe('192.168.1.10');
  });

  it('accepts the numeric family form (older Node)', () => {
    const m: InterfaceMap = {
      en0: [{ address: '192.168.9.2', netmask: '255.255.255.0', family: 4, internal: false }],
    };
    expect(pickLanIp('192.168.9.40', m)).toBe('192.168.9.2');
  });

  it('throws when no usable non-internal IPv4 interface exists', () => {
    const m: InterfaceMap = {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    };
    expect(() => pickLanIp('192.168.1.5', m)).toThrow(/no non-internal IPv4/);
  });
});

describe('ipv4ToInt', () => {
  it('parses valid dotted quads', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToInt('192.168.1.1')).toBe(0xc0a80101);
  });

  it('rejects malformed input', () => {
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('256.0.0.1')).toBeNull();
    expect(ipv4ToInt('a.b.c.d')).toBeNull();
    expect(ipv4ToInt('')).toBeNull();
  });
});
