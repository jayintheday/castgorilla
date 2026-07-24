/**
 * heartbeat.ts — the tp.heartbeat namespace + liveness watchdog.
 *
 * Protocol: send PING every `intervalMs`; the receiver replies PONG. If no PONG
 * arrives for `timeoutMs` (default 10s), the link is dead → emit 'timeout',
 * which drives the client's reconnect. We also PONG any PING the receiver sends
 * us (receivers ping too).
 *
 * The watchdog is fed ONLY by PONGs (not arbitrary traffic): "silence" in the
 * protocol sense means the peer stopped answering our pings. This also makes the
 * MockCastReceiver.stopAnsweringPings() fault deterministic in tests.
 */

import { TypedEmitter } from '../../util/emitter.js';
import type { Logger } from '../../util/logger.js';
import type { CastBus, RawInbound } from '../bus.js';
import { NS } from '../constants.js';
import { HEARTBEAT_TYPES, envelopeSchema } from '../messages.js';
import { Watchdog, type WatchdogTimers } from '../reconnect.js';

export type HeartbeatEvents = {
  /** No PONG within the timeout window — the link is presumed dead. */
  timeout: () => void;
};

export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Injectable timers for the watchdog (tests). */
  timers?: WatchdogTimers;
}

export class HeartbeatChannel extends TypedEmitter<HeartbeatEvents> {
  private readonly unsubscribe: () => void;
  private readonly watchdog: Watchdog;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly bus: CastBus,
    private readonly remoteId: string,
    private readonly log: Logger,
    private readonly opts: HeartbeatOptions,
  ) {
    super();
    this.watchdog = new Watchdog(
      opts.timeoutMs,
      () => {
        this.log.debug(`heartbeat timeout: no PONG from ${this.remoteId} in ${opts.timeoutMs}ms`);
        this.stop();
        this.emit('timeout');
      },
      opts.timers,
    );
    this.unsubscribe = bus.subscribe((m) => this.onRaw(m));
  }

  /** Begin pinging + arm the watchdog. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchdog.start();
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.opts.intervalMs);
    this.pingTimer.unref?.();
  }

  /** Stop pinging + disarm the watchdog. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.watchdog.stop();
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }

  private ping(): void {
    try {
      this.bus.send(this.bus.senderId, this.remoteId, NS.heartbeat, { type: HEARTBEAT_TYPES.ping });
    } catch (err) {
      // Send failed — the socket is gone; let the watchdog / socket 'close' win.
      this.log.debug('heartbeat PING send failed:', String(err));
    }
  }

  private onRaw(m: RawInbound): void {
    if (m.namespace !== NS.heartbeat) return;
    if (m.sourceId !== this.remoteId) return;
    let obj: unknown;
    try {
      obj = JSON.parse(m.data);
    } catch {
      return;
    }
    const env = envelopeSchema.safeParse(obj);
    if (!env.success) return;
    if (env.data.type === HEARTBEAT_TYPES.pong) {
      this.watchdog.feed();
    } else if (env.data.type === HEARTBEAT_TYPES.ping) {
      // The receiver pinged us — answer so it doesn't drop us.
      try {
        this.bus.send(this.bus.senderId, this.remoteId, NS.heartbeat, { type: HEARTBEAT_TYPES.pong });
      } catch {
        /* socket gone */
      }
    }
  }
}
