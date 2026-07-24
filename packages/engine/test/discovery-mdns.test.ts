import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CastDiscovery,
  type CastMdnsBrowser,
  type CastMdnsProvider,
  type CastMdnsService,
} from '../src/devices/discovery.js';
import type { DiscoveredDevice } from '../src/types/index.js';

/** A fake bonjour Browser we can drive by emitting up/down/txt-update. */
class FakeBrowser extends EventEmitter {
  started = false;
  stopped = false;
  /** How many times the browser was asked to re-send the mDNS query. */
  updates = 0;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  update(): void {
    this.updates += 1;
  }
}

class FakeProvider implements CastMdnsProvider {
  readonly browser = new FakeBrowser();
  destroyed = false;
  find(): CastMdnsBrowser {
    return this.browser as unknown as CastMdnsBrowser;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function svc(overrides: Partial<CastMdnsService> = {}): CastMdnsService {
  return {
    name: 'Chromecast-abc123',
    fqdn: 'Chromecast-abc123._googlecast._tcp.local',
    host: 'chromecast.local',
    port: 8009,
    addresses: ['192.168.1.50'],
    txt: { id: 'abc123deadbeef', fn: 'Living Room', md: 'Chromecast Ultra' },
    ...overrides,
  };
}

function setup() {
  const provider = new FakeProvider();
  const discovery = new CastDiscovery({ provider });
  const found: DiscoveredDevice[] = [];
  const removed: string[] = [];
  discovery.on('device', (d) => found.push(d));
  discovery.on('removed', (id) => removed.push(id));
  discovery.start();
  return { provider, discovery, found, removed, browser: provider.browser };
}

describe('CastDiscovery', () => {
  it('maps a discovered cast service to a DiscoveredDevice with resolved profile', () => {
    const { discovery, found, browser } = setup();
    browser.emit('up', svc());
    expect(found).toHaveLength(1);
    const d = found[0]!;
    expect(d.id).toBe('abc123deadbeef');
    expect(d.friendlyName).toBe('Living Room');
    expect(d.model).toBe('Chromecast Ultra');
    expect(d.host).toBe('192.168.1.50');
    expect(d.port).toBe(8009);
    expect(d.profile.key).toBe('ultra');
    expect(discovery.list()).toHaveLength(1);
    discovery.stop();
  });

  it('emits removed with the device id on a down event', () => {
    const { discovery, removed, browser } = setup();
    browser.emit('up', svc());
    browser.emit('down', svc());
    expect(removed).toEqual(['abc123deadbeef']);
    expect(discovery.list()).toHaveLength(0);
    discovery.stop();
  });

  it('dedupes a device seen on multiple interfaces by TXT id (one list entry)', () => {
    const { discovery, found, browser } = setup();
    browser.emit('up', svc({ addresses: ['192.168.1.50'] }));
    browser.emit('up', svc({ addresses: ['10.0.0.9'], fqdn: 'Chromecast-abc123._googlecast._tcp.local.eth' }));
    // Two 'up's (appear + update) but a single deduped device.
    expect(found).toHaveLength(2);
    expect(discovery.list()).toHaveLength(1);
    expect(discovery.list()[0]!.id).toBe('abc123deadbeef');
    discovery.stop();
  });

  it('re-emits device with an updated profile on a txt-update', () => {
    const { found, browser } = setup();
    browser.emit('up', svc({ txt: { id: 'x1', fn: 'TV', md: 'Chromecast' } }));
    expect(found[0]!.profile.key).toBe('gen2');
    browser.emit('txt-update', svc({ txt: { id: 'x1', fn: 'TV', md: 'Google TV Streamer' } }), svc());
    expect(found).toHaveLength(2);
    expect(found[1]!.profile.key).toBe('gtv-streamer');
  });

  it('resolves the model to unknown for a non-cast-looking md', () => {
    const { found, browser } = setup();
    browser.emit('up', svc({ txt: { id: 'nest1', fn: 'Kitchen', md: 'Google Nest Hub' } }));
    expect(found[0]!.profile.key).toBe('unknown');
  });

  it('ignores a service with no usable IPv4 address', () => {
    const { discovery, found, browser } = setup();
    browser.emit('up', svc({ addresses: ['fe80::1'], host: 'chromecast.local' }));
    expect(found).toHaveLength(0);
    expect(discovery.list()).toHaveLength(0);
    discovery.stop();
  });

  it('falls back to the SRV host when it is a bare IPv4 and addresses are absent', () => {
    const { found, browser } = setup();
    browser.emit('up', svc({ addresses: undefined, host: '192.168.1.77' }));
    expect(found[0]!.host).toBe('192.168.1.77');
  });

  it('rescan() re-queries via the browser update WITHOUT dropping the current list', () => {
    const { discovery, browser } = setup();
    browser.emit('up', svc());
    expect(discovery.list()).toHaveLength(1);
    discovery.rescan();
    expect(browser.updates).toBe(1);
    // A rescan must not clear known devices — a device that is mid-use must not
    // vanish on a manual Refresh. Responsive devices simply re-announce.
    expect(discovery.list()).toHaveLength(1);
    discovery.rescan();
    expect(browser.updates).toBe(2);
    discovery.stop();
  });

  it('rescan() before start() is a no-op (no browser to query yet)', () => {
    const provider = new FakeProvider();
    const discovery = new CastDiscovery({ provider });
    expect(() => discovery.rescan()).not.toThrow();
    expect(provider.browser.updates).toBe(0);
  });

  it('start() is idempotent and stop() tears down the provider', () => {
    const provider = new FakeProvider();
    const findSpy = vi.spyOn(provider, 'find');
    const discovery = new CastDiscovery({ provider });
    discovery.start();
    discovery.start();
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(provider.browser.started).toBe(true);
    discovery.stop();
    expect(provider.browser.stopped).toBe(true);
    expect(provider.destroyed).toBe(true);
  });
});
