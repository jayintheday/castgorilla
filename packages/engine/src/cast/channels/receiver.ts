/**
 * receiver.ts — the cast.receiver namespace (platform receiver, receiver-0).
 *
 * LAUNCH / STOP / GET_STATUS / SET_VOLUME → RECEIVER_STATUS. The status carries
 * `applications[]` (each with appId / sessionId / transportId) and `volume`.
 * Unsolicited RECEIVER_STATUS (requestId 0, e.g. someone changes the volume from
 * the Google Home app) is surfaced as a 'status' event.
 */

import type { Logger } from '../../util/logger.js';
import type { CastBus } from '../bus.js';
import { NS } from '../constants.js';
import { RequestChannel } from './base.js';
import {
  ERROR_TYPES,
  envelopeSchema,
  errorMessageSchema,
  receiverStatusMessageSchema,
  type ReceiverStatus,
} from '../messages.js';
import { CastCommandError } from '../errors.js';

export type ReceiverEvents = {
  /** A RECEIVER_STATUS was observed (solicited or unsolicited). */
  status: (status: ReceiverStatus) => void;
};

export class ReceiverChannel extends RequestChannel<ReceiverEvents> {
  private _lastStatus: ReceiverStatus | undefined;

  constructor(bus: CastBus, log: Logger, private readonly requestTimeoutMs: number) {
    super(bus, 'receiver-0', NS.receiver, log);
  }

  get lastStatus(): ReceiverStatus | undefined {
    return this._lastStatus;
  }

  getStatus(): Promise<ReceiverStatus> {
    return this.sendRequest<ReceiverStatus>({ type: 'GET_STATUS' }, 'GET_STATUS', this.requestTimeoutMs);
  }

  launch(appId: string): Promise<ReceiverStatus> {
    // LAUNCH can be slow while the app cold-starts; give it a bit more room.
    return this.sendRequest<ReceiverStatus>({ type: 'LAUNCH', appId }, 'LAUNCH', Math.max(this.requestTimeoutMs, 10_000));
  }

  stopApp(sessionId: string): Promise<ReceiverStatus> {
    return this.sendRequest<ReceiverStatus>({ type: 'STOP', sessionId }, 'STOP', this.requestTimeoutMs);
  }

  setVolume(level?: number, muted?: boolean): Promise<ReceiverStatus> {
    const volume: { level?: number; muted?: boolean } = {};
    if (level !== undefined) volume.level = Math.max(0, Math.min(1, level));
    if (muted !== undefined) volume.muted = muted;
    return this.sendRequest<ReceiverStatus>({ type: 'SET_VOLUME', volume }, 'SET_VOLUME', this.requestTimeoutMs);
  }

  protected onMessage(obj: unknown): void {
    const env = envelopeSchema.safeParse(obj);
    if (!env.success) {
      this.log.debug('receiver: payload without a type, ignoring');
      return;
    }
    const type = env.data.type;

    if (type === 'RECEIVER_STATUS') {
      const parsed = receiverStatusMessageSchema.safeParse(obj);
      if (!parsed.success) {
        this.log.debug('receiver: malformed RECEIVER_STATUS, ignoring');
        return;
      }
      const status = parsed.data.status;
      this._lastStatus = status;
      // Resolve the awaiting command (if this echoes its requestId)...
      this.resolveRequest(parsed.data.requestId, status);
      // ...and always surface the observed state.
      this.emit('status', status);
      return;
    }

    if (ERROR_TYPES.has(type)) {
      const err = errorMessageSchema.safeParse(obj);
      const requestId = err.success ? err.data.requestId : env.data.requestId;
      const cmdErr = new CastCommandError(type, obj, err.success ? err.data.detailedErrorCode : undefined, err.success ? err.data.reason : undefined);
      if (requestId === undefined || !this.rejectRequest(requestId, cmdErr)) {
        this.log.debug(`receiver: unmatched error ${type}`);
      }
      return;
    }

    this.log.debug(`receiver: ignoring unhandled message type ${type}`);
  }
}
