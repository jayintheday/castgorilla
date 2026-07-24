/**
 * discovery.ts — mDNS Chromecast discovery (WS1).
 *
 * Browses `_googlecast._tcp` via bonjour-service and maps each service to a
 * DiscoveredDevice (types/device.ts) using resolveProfile(md). Implements the
 * frozen DeviceDiscovery interface (types/session.ts): 'device' on appear/update,
 * 'removed' on disappear, plus start/stop/list.
 *
 * TXT keys used: `id` (stable device id — the dedupe key), `fn` (friendly name),
 * `md` (model, e.g. "Chromecast Ultra"). A device visible on several interfaces
 * announces multiple times with the same `id`; we key our map on `id` so the
 * list holds exactly one entry per physical device. host = first IPv4 address;
 * port from the SRV record (8009).
 *
 * The mDNS provider is injectable so the unit tests can drive found/lost/dedupe
 * without touching the network.
 */

import Bonjour from 'bonjour-service';

import { TypedEmitter } from '../util/emitter.js';
import { createLogger, type Logger } from '../util/logger.js';
import { resolveProfile } from './profiles.js';
import type { DeviceDiscovery, DiscoveredDevice, DiscoveryEvents } from '../types/index.js';
import { asError } from '../cast/errors.js';

/** The subset of a bonjour Service we depend on. */
export interface CastMdnsService {
  name: string;
  fqdn?: string;
  host?: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
}

/** The subset of a bonjour Browser we depend on (an EventEmitter of these events). */
export interface CastMdnsBrowser {
  on(event: 'up' | 'down', listener: (service: CastMdnsService) => void): void;
  on(event: 'txt-update' | 'srv-update', listener: (next: CastMdnsService, existing: CastMdnsService) => void): void;
  start?(): void;
  stop?(): void;
  /**
   * Re-send the mDNS query on the wire, prompting responsive services to
   * re-announce. bonjour-service's `Browser` implements this; the interface
   * marks it optional so a fake/older provider without it is still valid and
   * `rescan()` simply no-ops.
   */
  update?(): void;
}

/** Factory + lifecycle for an mDNS browser. Injectable for tests. */
export interface CastMdnsProvider {
  find(): CastMdnsBrowser;
  destroy(): void;
}

export interface CastDiscoveryOptions {
  provider?: CastMdnsProvider;
  logger?: Logger;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** The default provider: a real bonjour-service browse of `_googlecast._tcp`. */
function defaultProvider(): CastMdnsProvider {
  const bonjour = new Bonjour();
  return {
    find(): CastMdnsBrowser {
      return bonjour.find({ type: 'googlecast', protocol: 'tcp' }) as unknown as CastMdnsBrowser;
    },
    destroy(): void {
      bonjour.destroy();
    },
  };
}

export class CastDiscovery extends TypedEmitter<DiscoveryEvents> implements DeviceDiscovery {
  private readonly log: Logger;
  private provider: CastMdnsProvider | undefined;
  private browser: CastMdnsBrowser | undefined;
  private started = false;

  /** Known devices, keyed by TXT `id` (the dedupe key). */
  private readonly byId = new Map<string, DiscoveredDevice>();
  /** Maps an mDNS fqdn/name back to its device id, so 'down' can resolve the id. */
  private readonly nameToId = new Map<string, string>();

  constructor(private readonly opts: CastDiscoveryOptions = {}) {
    super();
    this.log = (opts.logger ?? createLogger('castgorilla')).child('discovery');
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.provider = this.opts.provider ?? defaultProvider();
    try {
      this.browser = this.provider.find();
    } catch (err) {
      this.started = false;
      this.emitError(asError(err));
      return;
    }
    this.browser.on('up', (s) => this.onUp(s));
    this.browser.on('down', (s) => this.onDown(s));
    this.browser.on('txt-update', (next) => this.onUp(next));
    this.browser.on('srv-update', (next) => this.onUp(next));
    this.browser.start?.();
    this.log.debug('discovery started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.browser?.stop?.();
      this.provider?.destroy();
    } catch (err) {
      this.log.debug('error while stopping discovery:', asError(err).message);
    }
    this.browser = undefined;
    this.provider = undefined;
    this.byId.clear();
    this.nameToId.clear();
    this.log.debug('discovery stopped');
  }

  list(): DiscoveredDevice[] {
    return [...this.byId.values()];
  }

  /**
   * Re-issue the mDNS query. Deliberately does NOT clear `byId` — dropping the
   * current list on every manual Refresh would make a device vanish mid-use.
   * Instead we prompt responsive devices to re-announce; each re-announcement
   * flows through the existing 'up' → onUp() → 'device' path and the engine
   * pushes a fresh snapshot. A no-op before start() (no browser yet) or against
   * a provider whose browser has no `update`.
   */
  rescan(): void {
    if (!this.started) return;
    this.browser?.update?.();
    this.log.debug('discovery rescan (re-query sent)');
  }

  private onUp(service: CastMdnsService): void {
    const device = this.toDevice(service);
    if (!device) {
      this.log.debug('ignoring cast service with no usable id/host', service.name);
      return;
    }
    this.byId.set(device.id, device);
    if (service.fqdn) this.nameToId.set(service.fqdn, device.id);
    if (service.name) this.nameToId.set(service.name, device.id);
    // 'device' is emitted for both first-appearance and updates (the frozen
    // DiscoveryEvents map has only device/removed/error).
    this.emit('device', device);
  }

  private onDown(service: CastMdnsService): void {
    const id = this.resolveId(service);
    if (id === undefined || !this.byId.has(id)) {
      this.log.debug('down event for unknown service', service.name);
      return;
    }
    this.byId.delete(id);
    if (service.fqdn) this.nameToId.delete(service.fqdn);
    if (service.name) this.nameToId.delete(service.name);
    this.emit('removed', id);
  }

  private resolveId(service: CastMdnsService): string | undefined {
    const txtId = str(service.txt?.['id']);
    if (txtId && this.byId.has(txtId)) return txtId;
    if (service.fqdn && this.nameToId.has(service.fqdn)) return this.nameToId.get(service.fqdn);
    if (service.name && this.nameToId.has(service.name)) return this.nameToId.get(service.name);
    return txtId;
  }

  private toDevice(service: CastMdnsService): DiscoveredDevice | undefined {
    const txt = service.txt ?? {};
    const id = str(txt['id']) || service.fqdn || service.name;
    if (!id) return undefined;
    const host = firstIPv4(service.addresses) ?? (service.host && IPV4_RE.test(service.host) ? service.host : undefined);
    if (!host) return undefined;
    const model = str(txt['md']) ?? '';
    return {
      id,
      friendlyName: str(txt['fn']) || service.name || id,
      model,
      host,
      port: service.port || 8009,
      profile: resolveProfile(model),
    };
  }

  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.log.error('discovery error (no listener attached):', err);
  }
}

/** Coerce an mDNS TXT value (string | Buffer | other) to a trimmed string, or undefined. */
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** First IPv4 dotted-quad in an addresses list. */
function firstIPv4(addresses: string[] | undefined): string | undefined {
  if (!addresses) return undefined;
  return addresses.find((a) => IPV4_RE.test(a));
}
