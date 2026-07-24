/**
 * media.ts — the cast.media namespace (addressed to the app transportId).
 *
 * LOAD / PLAY / PAUSE / STOP / SEEK / GET_STATUS / EDIT_TRACKS_INFO → MEDIA_STATUS.
 * The receiver also pushes MEDIA_STATUS unsolicited (requestId 0) as playback
 * progresses (BUFFERING → PLAYING, position ticks, IDLE at end). Those pushes
 * are MERGED into lastStatus (pushes often omit `media`/`tracks` that only the
 * initial status carried) and surfaced via 'status'.
 *
 * All commands after LOAD require the mediaSessionId learned from the LOAD
 * response; calling one before a session exists rejects with NoMediaSessionError.
 *
 * EMPTY status arrays: a MEDIA_STATUS whose `status` array is `[]` is legitimate
 * for GET_STATUS while the receiver is idle and for STOP acknowledgements — but
 * as the answer to a LOAD it means the receiver took the request and created NO
 * media session. Resolving the LOAD with `undefined` there is what parks a
 * PlaybackSession in 'loading' forever with no error anywhere (OPEN BUG #1
 * symptom), so LOAD — and only LOAD — rejects on it.
 */

import type { Logger } from '../../util/logger.js';
import type { CastBus } from '../bus.js';
import type { LoadMediaInformation, MediaStatus } from '../../types/cast.js';
import { NS } from '../constants.js';
import { RequestChannel } from './base.js';
import {
  ERROR_TYPES,
  envelopeSchema,
  errorMessageSchema,
  mediaStatusMessageSchema,
} from '../messages.js';
import { CastCommandError, NoMediaSessionError } from '../errors.js';

export type MediaEvents = {
  /** A MEDIA_STATUS was observed (solicited or unsolicited); carries merged lastStatus. */
  status: (status: MediaStatus) => void;
};

export interface LoadOptions {
  autoplay?: boolean;
  currentTime?: number;
  activeTrackIds?: number[];
}

/**
 * Sentinel a pending request is resolved with when the MEDIA_STATUS that
 * answered it carried an EMPTY `status` array. It never escapes this file:
 * every command unwraps it (to the previous lastStatus, preserving the old
 * behaviour) except LOAD, which rejects.
 */
const EMPTY_STATUS = Symbol('empty-media-status');
type StatusOrEmpty = MediaStatus | typeof EMPTY_STATUS | undefined;

export class MediaChannel extends RequestChannel<MediaEvents> {
  private _lastStatus: MediaStatus | undefined;
  private _mediaSessionId: number | undefined;
  /** Raw payload of the most recent EMPTY-status MEDIA_STATUS (verbatim, for diagnostics). */
  private lastEmptyStatusPayload: unknown;

  constructor(
    bus: CastBus,
    transportId: string,
    log: Logger,
    private readonly requestTimeoutMs: number,
    private readonly loadTimeoutMs: number,
  ) {
    super(bus, transportId, NS.media, log);
  }

  get lastStatus(): MediaStatus | undefined {
    return this._lastStatus;
  }

  get mediaSessionId(): number | undefined {
    return this._mediaSessionId;
  }

  /** Reset session state (used when the app is torn down / relaunched). */
  resetSession(): void {
    this._lastStatus = undefined;
    this._mediaSessionId = undefined;
  }

  async load(media: LoadMediaInformation, opts: LoadOptions = {}): Promise<MediaStatus> {
    const payload: Record<string, unknown> = {
      type: 'LOAD',
      media,
      autoplay: opts.autoplay ?? true,
    };
    if (opts.currentTime !== undefined) payload['currentTime'] = opts.currentTime;
    if (opts.activeTrackIds !== undefined) payload['activeTrackIds'] = opts.activeTrackIds;
    const res = await this.sendRequest<StatusOrEmpty>(payload, 'LOAD', this.loadTimeoutMs);
    if (res === EMPTY_STATUS || res === undefined) {
      // The device answered our LOAD but reported no media session at all. Left
      // unhandled this resolves with `undefined` and the caller waits forever.
      const raw = this.lastEmptyStatusPayload;
      this.log.warn(
        'media: LOAD was answered with an EMPTY MEDIA_STATUS status array — the receiver ' +
          'accepted the request but created no media session. Raw payload:',
        raw ?? '(unavailable)',
      );
      throw new CastCommandError(
        'MEDIA_STATUS',
        raw,
        undefined,
        'LOAD was answered with an empty MEDIA_STATUS (no media session created; ' +
          'the receiver dropped the content without an explicit error)',
      );
    }
    return res;
  }

  play(): Promise<MediaStatus> {
    return this.command('PLAY');
  }

  pause(): Promise<MediaStatus> {
    return this.command('PAUSE');
  }

  stop(): Promise<MediaStatus> {
    return this.command('STOP');
  }

  seek(currentTime: number): Promise<MediaStatus> {
    return this.command('SEEK', { currentTime });
  }

  setActiveTracks(activeTrackIds: number[]): Promise<MediaStatus> {
    return this.command('EDIT_TRACKS_INFO', { activeTrackIds });
  }

  async getStatus(): Promise<MediaStatus> {
    // GET_STATUS is valid even without a known mediaSessionId (returns [] when idle).
    const res = await this.sendRequest<StatusOrEmpty>(
      { type: 'GET_STATUS' },
      'GET_STATUS',
      this.requestTimeoutMs,
    );
    return this.unwrap(res);
  }

  private async command(type: string, extra: Record<string, unknown> = {}): Promise<MediaStatus> {
    if (this._mediaSessionId === undefined) {
      throw new NoMediaSessionError();
    }
    const res = await this.sendRequest<StatusOrEmpty>(
      { type, mediaSessionId: this._mediaSessionId, ...extra },
      type,
      this.requestTimeoutMs,
    );
    return this.unwrap(res);
  }

  /**
   * Non-LOAD commands keep the historical behaviour for an empty status array:
   * resolve with the last status we knew (which may itself be undefined). An
   * empty array is normal here — an idle GET_STATUS and a STOP acknowledgement
   * both produce one.
   */
  private unwrap(res: StatusOrEmpty): MediaStatus {
    return (res === EMPTY_STATUS || res === undefined ? this._lastStatus : res) as MediaStatus;
  }

  protected onMessage(obj: unknown): void {
    const env = envelopeSchema.safeParse(obj);
    if (!env.success) {
      this.log.debug('media: payload without a type, ignoring');
      return;
    }
    const type = env.data.type;

    if (type === 'MEDIA_STATUS') {
      const parsed = mediaStatusMessageSchema.safeParse(obj);
      if (!parsed.success) {
        this.log.debug('media: malformed MEDIA_STATUS, ignoring');
        return;
      }
      const first = parsed.data.status[0];
      if (!first) {
        // EMPTY status array. Legitimate for an idle GET_STATUS / a STOP ack,
        // fatal as the answer to a LOAD — so hand the waiter a sentinel and let
        // each command decide (see load() vs unwrap()).
        this.lastEmptyStatusPayload = obj;
        this.log.debug('media: MEDIA_STATUS with an EMPTY status array', obj);
        this.resolveRequest(parsed.data.requestId, EMPTY_STATUS);
        return;
      }
      const merged = this.mergeStatus(first);
      // Resolve the awaiting command with the freshest status.
      this.resolveRequest(parsed.data.requestId, merged);
      this.emit('status', merged);
      return;
    }

    if (ERROR_TYPES.has(type)) {
      const err = errorMessageSchema.safeParse(obj);
      const requestId = err.success ? err.data.requestId : env.data.requestId;
      const cmdErr = new CastCommandError(
        type,
        obj,
        err.success ? err.data.detailedErrorCode : undefined,
        err.success ? err.data.reason : undefined,
      );
      if (requestId === undefined || !this.rejectRequest(requestId, cmdErr)) {
        this.log.debug(`media: unmatched error ${type}`);
      }
      return;
    }

    this.log.debug(`media: ignoring unhandled message type ${type}`);
  }

  /** Overlay a new status onto lastStatus, preserving fields the push omitted. */
  private mergeStatus(next: MediaStatus): MediaStatus {
    const prev = this._lastStatus;
    const merged: MediaStatus = prev
      ? { ...prev, ...next, media: next.media ?? prev.media, volume: next.volume ?? prev.volume }
      : next;
    this._lastStatus = merged;
    if (merged.mediaSessionId !== undefined) this._mediaSessionId = merged.mediaSessionId;
    return merged;
  }
}
