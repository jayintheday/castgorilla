/**
 * connection.ts — the tp.connection namespace.
 *
 * A CASTV2 "virtual connection" must be opened (CONNECT) to each destination we
 * address before it will talk to us: receiver-0 first, then the app transportId
 * after LAUNCH. The receiver can tear a virtual connection down by sending CLOSE
 * (e.g. when its app stops), which we surface as a 'closed' event.
 */

import { TypedEmitter } from '../../util/emitter.js';
import type { Logger } from '../../util/logger.js';
import type { CastBus, RawInbound } from '../bus.js';
import { NS } from '../constants.js';
import { CONNECTION_TYPES, envelopeSchema } from '../messages.js';
import { asError } from '../errors.js';

export type ConnectionEvents = {
  /** The peer sent CLOSE for this virtual connection. */
  closed: () => void;
};

export class ConnectionChannel extends TypedEmitter<ConnectionEvents> {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bus: CastBus,
    private remoteId: string,
    private readonly log: Logger,
  ) {
    super();
    this.unsubscribe = bus.subscribe((m) => this.onRaw(m));
  }

  setRemoteId(remoteId: string): void {
    this.remoteId = remoteId;
  }

  /** Open the virtual connection to the peer. */
  connect(): void {
    this.bus.send(this.bus.senderId, this.remoteId, NS.connection, {
      type: CONNECTION_TYPES.connect,
      userAgent: 'castgorilla',
      connType: 0,
      origin: {},
      senderInfo: { sdkType: 2, version: '0.0.0', platform: 4 },
    });
  }

  /** Politely close the virtual connection. */
  close(): void {
    try {
      this.bus.send(this.bus.senderId, this.remoteId, NS.connection, { type: CONNECTION_TYPES.close });
    } catch (err) {
      // Best-effort: the socket may already be gone.
      this.log.debug('connection CLOSE send failed:', asError(err).message);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  private onRaw(m: RawInbound): void {
    if (m.namespace !== NS.connection) return;
    if (m.sourceId !== this.remoteId) return;
    if (m.destinationId !== this.bus.senderId && m.destinationId !== '*') return;
    let obj: unknown;
    try {
      obj = JSON.parse(m.data);
    } catch {
      return;
    }
    const env = envelopeSchema.safeParse(obj);
    if (env.success && env.data.type === CONNECTION_TYPES.close) {
      this.log.debug(`peer ${this.remoteId} closed the virtual connection`);
      this.emit('closed');
    }
  }
}
