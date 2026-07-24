/**
 * base.ts — RequestChannel: request/response correlation over a namespace.
 *
 * Handles the mechanics every command channel (receiver, media) shares:
 *  - allocate a requestId, send, and return a Promise that resolves when a
 *    response echoing that requestId arrives (or rejects on timeout);
 *  - route only messages on this channel's namespace from this channel's peer;
 *  - reject ALL in-flight promises on connection loss (failAll) so a dropped
 *    socket never produces an unhandled rejection.
 *
 * Subclasses implement onMessage(obj) to validate + dispatch parsed payloads,
 * calling resolveRequest / rejectRequest / emitting unsolicited events.
 */

import { TypedEmitter, type EventMap } from '../../util/emitter.js';
import type { Logger } from '../../util/logger.js';
import type { CastBus, RawInbound } from '../bus.js';
import { CastConnectionError, CastTimeoutError, asError } from '../errors.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
}

export abstract class RequestChannel<E extends EventMap> extends TypedEmitter<E> {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  protected constructor(
    protected readonly bus: CastBus,
    /** Peer id we exchange with (e.g. 'receiver-0' or a transportId). Mutable across reconnects. */
    protected remoteId: string,
    protected readonly namespace: string,
    protected readonly log: Logger,
  ) {
    super();
    this.unsubscribe = bus.subscribe((m) => this.onRaw(m));
  }

  /** Update the peer id (transportId can change when an app relaunches). */
  setRemoteId(remoteId: string): void {
    this.remoteId = remoteId;
  }

  private onRaw(m: RawInbound): void {
    if (this.disposed) return;
    if (m.namespace !== this.namespace) return;
    if (m.sourceId !== this.remoteId) return;
    if (m.destinationId !== this.bus.senderId && m.destinationId !== '*') return;
    let obj: unknown;
    try {
      obj = JSON.parse(m.data);
    } catch {
      this.log.debug(`ignoring non-JSON payload on ${this.namespace}`);
      return;
    }
    try {
      this.onMessage(obj);
    } catch (err) {
      // A handler bug must never take down the socket read loop.
      this.log.debug(`handler error on ${this.namespace}:`, asError(err).message);
    }
  }

  /** Validate + dispatch a parsed inbound payload. */
  protected abstract onMessage(obj: unknown): void;

  /** Send a fire-and-forget message on this channel. */
  protected sendRaw(payload: object): void {
    this.bus.send(this.bus.senderId, this.remoteId, this.namespace, payload);
  }

  /** Send a request and await a response echoing its requestId. */
  protected sendRequest<T>(payload: object, type: string, timeoutMs: number): Promise<T> {
    const requestId = this.bus.nextRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CastTimeoutError(type, timeoutMs, requestId));
      }, timeoutMs);
      // Don't let a pending request keep the event loop alive.
      timer.unref?.();
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer, type });
      try {
        this.bus.send(this.bus.senderId, this.remoteId, this.namespace, { ...payload, requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(asError(err));
      }
    });
  }

  /** Resolve the pending request with this id, if any. Returns whether one matched. */
  protected resolveRequest(requestId: number, value: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(value);
    return true;
  }

  /** Reject the pending request with this id, if any. Returns whether one matched. */
  protected rejectRequest(requestId: number, err: Error): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.reject(err);
    return true;
  }

  protected hasPending(requestId: number): boolean {
    return this.pending.has(requestId);
  }

  /** Reject every in-flight request (connection loss). */
  failAll(err: Error = new CastConnectionError()): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Tear down: unsubscribe from the bus and fail any stragglers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.failAll(new CastConnectionError('channel disposed', 'NOT_CONNECTED'));
  }
}
