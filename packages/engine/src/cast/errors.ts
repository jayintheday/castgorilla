/**
 * errors.ts — typed error hierarchy for the cast transport.
 *
 * Every in-flight command promise rejects with one of these (never a bare Error,
 * never an unhandled rejection). Callers can branch on `.code`.
 */

export type CastErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION_LOST'
  | 'NOT_CONNECTED'
  | 'SESSION_LOST'
  | 'NO_MEDIA_SESSION'
  | 'COMMAND_REJECTED'
  | 'PROTOCOL';

/** Base class for all cast transport errors. */
export class CastError extends Error {
  readonly code: CastErrorCode;
  constructor(code: CastErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A request did not receive a matching response within its timeout window. */
export class CastTimeoutError extends CastError {
  readonly requestType: string;
  readonly requestId: number;
  readonly timeoutMs: number;
  constructor(requestType: string, timeoutMs: number, requestId: number) {
    super('TIMEOUT', `Cast request '${requestType}' (requestId ${requestId}) timed out after ${timeoutMs}ms`);
    this.requestType = requestType;
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

/** The underlying TLS connection dropped (close / ECONNRESET / heartbeat timeout). */
export class CastConnectionError extends CastError {
  constructor(message = 'Cast connection lost', code: Extract<CastErrorCode, 'CONNECTION_LOST' | 'NOT_CONNECTED'> = 'CONNECTION_LOST') {
    super(code, message);
  }
}

/** The receiver app we were driving is gone; the media session cannot be resumed. */
export class SessionLostError extends CastError {
  constructor(message = 'Cast receiver application/session is no longer running') {
    super('SESSION_LOST', message);
  }
}

/** A media command was issued before a media session exists (no LOAD yet). */
export class NoMediaSessionError extends CastError {
  constructor(message = 'No active media session (LOAD has not completed)') {
    super('NO_MEDIA_SESSION', message);
  }
}

/** The device answered a request with an explicit error payload (e.g. LOAD_FAILED). */
export class CastCommandError extends CastError {
  /** The receiver message `type`, e.g. 'LOAD_FAILED' | 'INVALID_PLAYER_STATE' | 'ERROR'. */
  readonly responseType: string;
  /** The raw error payload from the device, preserved verbatim for diagnostics. */
  readonly payload: unknown;
  readonly detailedErrorCode?: number;
  readonly reason?: string;
  constructor(responseType: string, payload: unknown, detailedErrorCode?: number, reason?: string) {
    const detail = reason ?? (detailedErrorCode !== undefined ? `code ${detailedErrorCode}` : '');
    super('COMMAND_REJECTED', `Cast device rejected request with ${responseType}${detail ? `: ${detail}` : ''}`);
    this.responseType = responseType;
    this.payload = payload;
    this.detailedErrorCode = detailedErrorCode;
    this.reason = reason;
  }
}

/** Coerce an unknown throwable into an Error. */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
