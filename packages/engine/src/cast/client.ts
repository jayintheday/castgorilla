/**
 * client.ts — CastClient: the sender-side CASTV2 stack.
 *
 * Owns one TLS socket to a device and the four channels layered on it. Exposes:
 *  - CastClient.connect(host, opts): TLS + CONNECT(receiver-0) + heartbeat.
 *  - .receiver: ReceiverController (launch / stopApp / getStatus / setVolume).
 *  - .launchDefaultMediaReceiver(): LAUNCH the DMR, CONNECT its transportId, and
 *    return a MediaController (load / play / pause / stop / seek / tracks).
 *  - events: close | error | reconnecting | reconnected | session-lost.
 *
 * Reconnect (the piece the legacy castv2-client lacked): on socket close /
 * ECONNRESET / heartbeat timeout we emit 'reconnecting', reject every in-flight
 * command with a typed CastConnectionError (never an unhandled rejection),
 * back off, reconnect, re-CONNECT receiver-0, GET_STATUS, and — if our app is
 * still running — re-CONNECT its transportId + media GET_STATUS resync and emit
 * 'reconnected'; if the app is gone, emit 'session-lost'.
 *
 * Every step of that is logged at INFO ("reconnecting to…", "reconnect attempt
 * n/m", "reconnected after n attempt(s) in Xms", or "reconnect gave up…").
 * It used to log NOTHING on the success path, so a laptop that idle-slept
 * mid-episode produced one 'connection lost' warning and then silence — the
 * recovery ran, worked at the transport level, and was invisible.
 *
 * 'reconnected' means THE TRANSPORT is back, not that playback is. A receiver
 * that kept the app across the drop routinely discards the media session, so
 * the old mediaSessionId is dead (INVALID_MEDIA_SESSION_ID) and the session
 * owner must issue a fresh LOAD.
 *
 * CastClient itself is the CastBus: channel objects hold a stable reference to
 * it, so the ReceiverController / MediaController handed to callers survive a
 * reconnect (only the underlying socket is swapped).
 */

import { Client } from 'castv2';

import { TypedEmitter } from '../util/emitter.js';
import { createLogger, type Logger } from '../util/logger.js';
import type { LoadMediaInformation, MediaStatus } from '../types/cast.js';
import type { CastBus, RawInbound } from './bus.js';
import { ensureCastv2Ready } from './castv2-ready.js';
import {
  CAST_PORT,
  DEFAULTS,
  DEFAULT_MEDIA_RECEIVER_APP_ID,
  DEFAULT_SENDER_ID,
  NS,
  PLATFORM_RECEIVER_ID,
} from './constants.js';
import { CastCommandError, CastConnectionError, SessionLostError, asError } from './errors.js';
import { ConnectionChannel } from './channels/connection.js';
import { HeartbeatChannel } from './channels/heartbeat.js';
import { ReceiverChannel } from './channels/receiver.js';
import { MediaChannel, type LoadOptions } from './channels/media.js';
import type { ReceiverStatus } from './messages.js';
import { Backoff, type BackoffOptions } from './reconnect.js';

export type CastClientEvents = {
  /** The connection is permanently closed (intentional close, or reconnect gave up). */
  close: () => void;
  /** A fatal error (reconnect exhausted). Attach a listener to avoid the default throw. */
  error: (err: Error) => void;
  /** The link dropped; a reconnect sequence has begun. */
  reconnecting: () => void;
  /** Reconnected and resynced (media session, if any, resumed). */
  reconnected: () => void;
  /** Reconnected, but the receiver app we were driving is gone. */
  'session-lost': () => void;
};

export interface ReconnectOptions extends Partial<BackoffOptions> {
  /** Give up after this many failed attempts. */
  maxAttempts?: number;
}

export interface CastClientOptions {
  port?: number;
  senderId?: string;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  loadTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** false disables auto-reconnect; an object tunes the backoff. Default: enabled. */
  reconnect?: boolean | ReconnectOptions;
}

type Phase = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface ActiveMedia {
  controller: MediaController;
  channel: MediaChannel;
  connectionApp: ConnectionChannel;
  appId: string;
}

interface SessionRef {
  appId: string;
  sessionId: string;
  transportId: string;
}

// --- Public controllers ----------------------------------------------------

export type ReceiverEvents = { status: (status: ReceiverStatus) => void };

/** Thin, stable-across-reconnect handle to the platform receiver. */
export class ReceiverController extends TypedEmitter<ReceiverEvents> {
  constructor(private readonly channel: ReceiverChannel) {
    super();
    channel.on('status', (s) => this.emit('status', s));
  }
  get lastStatus(): ReceiverStatus | undefined {
    return this.channel.lastStatus;
  }
  launch(appId: string): Promise<ReceiverStatus> {
    return this.channel.launch(appId);
  }
  stopApp(sessionId: string): Promise<ReceiverStatus> {
    return this.channel.stopApp(sessionId);
  }
  getStatus(): Promise<ReceiverStatus> {
    return this.channel.getStatus();
  }
  setVolume(level?: number, muted?: boolean): Promise<ReceiverStatus> {
    return this.channel.setVolume(level, muted);
  }
}

export type MediaControllerEvents = { status: (status: MediaStatus) => void };

/** Stable-across-reconnect handle to a running media session on the DMR. */
export class MediaController extends TypedEmitter<MediaControllerEvents> {
  private lost = false;
  constructor(private readonly channel: MediaChannel) {
    super();
    channel.on('status', (s) => this.emit('status', s));
  }
  get lastStatus(): MediaStatus | undefined {
    return this.channel.lastStatus;
  }
  get mediaSessionId(): number | undefined {
    return this.channel.mediaSessionId;
  }
  /** Marked when the underlying receiver app is gone (session-lost). */
  markLost(): void {
    this.lost = true;
  }
  private ensureAlive(): void {
    if (this.lost) throw new SessionLostError();
  }
  async load(media: LoadMediaInformation, opts: LoadOptions = {}): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.load(media, opts);
  }
  async play(): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.play();
  }
  async pause(): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.pause();
  }
  async stop(): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.stop();
  }
  async seek(sec: number): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.seek(sec);
  }
  async setActiveTracks(activeTrackIds: number[]): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.setActiveTracks(activeTrackIds);
  }
  async getStatus(): Promise<MediaStatus> {
    this.ensureAlive();
    return this.channel.getStatus();
  }
}

// --- CastClient ------------------------------------------------------------

export class CastClient extends TypedEmitter<CastClientEvents> implements CastBus {
  readonly senderId: string;
  private readonly host: string;
  private readonly port: number;
  private readonly log: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly backoffOpts: Partial<BackoffOptions>;
  private readonly maxAttempts: number;

  private socket: Client | undefined;
  private phase: Phase = 'new';
  private requestIdCounter = 0;
  private readonly subscribers = new Set<(msg: RawInbound) => void>();

  private readonly connectionReceiver: ConnectionChannel;
  private readonly heartbeat: HeartbeatChannel;
  private readonly receiverChannel: ReceiverChannel;
  readonly receiver: ReceiverController;

  private session: SessionRef | undefined;
  private activeMedia: ActiveMedia | undefined;

  private constructor(host: string, opts: CastClientOptions) {
    super();
    this.host = host;
    this.port = opts.port ?? CAST_PORT;
    this.senderId = opts.senderId ?? DEFAULT_SENDER_ID;
    this.log = (opts.logger ?? createLogger('castgorilla')).child('cast');
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? DEFAULTS.loadTimeoutMs;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;

    const rc = opts.reconnect ?? true;
    this.reconnectEnabled = rc !== false;
    this.backoffOpts = typeof rc === 'object' ? rc : {};
    this.maxAttempts = (typeof rc === 'object' && rc.maxAttempts) || 8;

    // Channels bind to `this` (the bus) once; they outlive socket swaps.
    this.connectionReceiver = new ConnectionChannel(this, PLATFORM_RECEIVER_ID, this.log.child('conn'));
    this.heartbeat = new HeartbeatChannel(this, PLATFORM_RECEIVER_ID, this.log.child('hb'), {
      intervalMs: this.heartbeatIntervalMs,
      timeoutMs: this.heartbeatTimeoutMs,
    });
    this.heartbeat.on('timeout', () => this.handleConnectionLost('heartbeat-timeout'));
    this.receiverChannel = new ReceiverChannel(this, this.log.child('recv'), this.requestTimeoutMs);
    this.receiver = new ReceiverController(this.receiverChannel);
  }

  /** Connect TLS, open the receiver-0 virtual connection, and start heartbeats. */
  static async connect(host: string, opts: CastClientOptions = {}): Promise<CastClient> {
    const client = new CastClient(host, opts);
    await client.open();
    return client;
  }

  private async open(): Promise<void> {
    this.phase = 'connecting';
    try {
      await this.establish();
    } catch (err) {
      this.phase = 'closed';
      throw err;
    }
    this.connectionReceiver.connect();
    this.heartbeat.start();
    this.phase = 'connected';
  }

  // --- CastBus -------------------------------------------------------------

  isConnected(): boolean {
    return this.socket !== undefined;
  }

  nextRequestId(): number {
    // Reserve 0 for unsolicited broadcasts.
    this.requestIdCounter = (this.requestIdCounter % 1_000_000_000) + 1;
    return this.requestIdCounter;
  }

  send(sourceId: string, destinationId: string, namespace: string, payload: unknown): void {
    const socket = this.socket;
    if (!socket) throw new CastConnectionError('not connected', 'NOT_CONNECTED');
    let data: string;
    try {
      data = JSON.stringify(payload);
    } catch (err) {
      throw asError(err);
    }
    socket.send(sourceId, destinationId, namespace, data);
  }

  subscribe(handler: (msg: RawInbound) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  // --- Public API ----------------------------------------------------------

  /** LAUNCH the Default Media Receiver and return a controller for it. */
  async launchDefaultMediaReceiver(): Promise<MediaController> {
    if (this.activeMedia) {
      // Replace any prior session cleanly.
      this.activeMedia.connectionApp.dispose();
      this.activeMedia.channel.dispose();
      this.activeMedia = undefined;
    }
    const status = await this.receiverChannel.launch(DEFAULT_MEDIA_RECEIVER_APP_ID);
    const app =
      status.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER_APP_ID) ?? status.applications?.[0];
    if (!app) {
      throw new CastCommandError('LAUNCH', status, undefined, 'no application present in RECEIVER_STATUS after LAUNCH');
    }
    this.session = { appId: app.appId, sessionId: app.sessionId, transportId: app.transportId };

    const connectionApp = new ConnectionChannel(this, app.transportId, this.log.child('conn:app'));
    connectionApp.connect();
    const channel = new MediaChannel(
      this,
      app.transportId,
      this.log.child('media'),
      this.requestTimeoutMs,
      this.loadTimeoutMs,
    );
    const controller = new MediaController(channel);
    this.activeMedia = { controller, channel, connectionApp, appId: app.appId };
    return controller;
  }

  /** The current running-app session reference, if any. */
  getSession(): Readonly<SessionRef> | undefined {
    return this.session;
  }

  /** Permanently close the connection (disables reconnect). */
  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.heartbeat.stop();
    try {
      this.activeMedia?.connectionApp.close();
    } catch {
      /* ignore */
    }
    try {
      this.connectionReceiver.close();
    } catch {
      /* ignore */
    }
    this.failInFlight(new CastConnectionError('client closed', 'NOT_CONNECTED'));
    this.teardownSocket();
    this.connectionReceiver.dispose();
    this.heartbeat.dispose();
    this.receiverChannel.dispose();
    this.activeMedia?.connectionApp.dispose();
    this.activeMedia?.channel.dispose();
    this.emit('close');
  }

  // --- Socket lifecycle ----------------------------------------------------

  private establish(): Promise<void> {
    return ensureCastv2Ready().then(
      () =>
        new Promise<void>((resolve, reject) => {
          const client = new Client();
          let settled = false;

          const cleanupTemp = (): void => {
            client.removeListener('connect', onConnect);
            client.removeListener('error', onEarlyError);
            client.removeListener('close', onEarlyClose);
          };
          const onConnect = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanupTemp();
            this.socket = client;
            client.on('message', this.onSocketMessage);
            client.on('error', this.onSocketError);
            client.once('close', this.onSocketClose);
            resolve();
          };
          const onEarlyError = (err: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanupTemp();
            reject(asError(err));
          };
          const onEarlyClose = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanupTemp();
            reject(new CastConnectionError('socket closed before connect', 'NOT_CONNECTED'));
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanupTemp();
            try {
              client.close();
            } catch {
              /* ignore */
            }
            reject(new CastConnectionError('TLS connect timed out', 'NOT_CONNECTED'));
          }, this.connectTimeoutMs);
          timer.unref?.();

          client.once('connect', onConnect);
          client.on('error', onEarlyError);
          client.once('close', onEarlyClose);

          try {
            client.connect({ host: this.host, port: this.port });
          } catch (err) {
            onEarlyError(err);
          }
        }),
    );
  }

  private readonly onSocketMessage = (
    sourceId: string,
    destinationId: string,
    namespace: string,
    data: string | Buffer,
  ): void => {
    if (typeof data !== 'string') {
      // Binary payloads (auth) are not used by the DMR flow; ignore.
      this.log.trace(`ignoring binary payload on ${namespace}`);
      return;
    }
    const msg: RawInbound = { sourceId, destinationId, namespace, data };
    for (const handler of [...this.subscribers]) {
      try {
        handler(msg);
      } catch (err) {
        this.log.debug('subscriber threw:', asError(err).message);
      }
    }
  };

  private readonly onSocketError = (err: unknown): void => {
    // Transient socket errors precede 'close', which drives reconnect. Just log.
    this.log.debug('socket error:', asError(err).message);
  };

  private readonly onSocketClose = (): void => {
    this.socket = undefined;
    this.failInFlight(new CastConnectionError());
    if (this.phase === 'connected') {
      this.handleConnectionLost('socket-close');
    }
  };

  private teardownSocket(): void {
    const s = this.socket;
    this.socket = undefined;
    if (!s) return;
    s.removeListener('message', this.onSocketMessage);
    s.removeListener('error', this.onSocketError);
    s.removeListener('close', this.onSocketClose);
    // Swallow post-teardown errors from the discarded socket.
    s.on('error', () => {});
    try {
      s.close();
    } catch {
      /* socket may already be destroyed */
    }
  }

  private failInFlight(err: Error): void {
    this.receiverChannel.failAll(err);
    this.activeMedia?.channel.failAll(err);
  }

  // --- Reconnect -----------------------------------------------------------

  private handleConnectionLost(reason: string): void {
    if (this.phase !== 'connected') return;
    this.phase = 'reconnecting';
    this.log.warn(`connection lost (${reason})`);
    this.heartbeat.stop();
    this.teardownSocket();
    this.failInFlight(new CastConnectionError());

    if (!this.reconnectEnabled) {
      this.phase = 'closed';
      this.log.error('reconnect is disabled — the connection is gone for good');
      this.emitError(new CastConnectionError('connection lost and reconnect is disabled'));
      this.emit('close');
      return;
    }
    // Recovery must be VISIBLE: a silent reconnect is indistinguishable from a
    // session that simply died (2026-07-23, laptop idle-sleep mid-episode).
    this.log.info(`reconnecting to ${this.host}:${this.port} (up to ${this.maxAttempts} attempts)`);
    this.emit('reconnecting');
    void this.runReconnect();
  }

  private async runReconnect(): Promise<void> {
    const backoff = new Backoff(this.backoffOpts);
    const startedAt = Date.now();
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const delayMs = backoff.nextDelay();
      await sleep(delayMs);
      if (this.phase !== 'reconnecting') return; // closed mid-backoff
      this.log.info(`reconnect attempt ${attempt}/${this.maxAttempts} (after ${delayMs}ms backoff)`);
      try {
        await this.establish();
        this.connectionReceiver.connect();
        const status = await this.receiverChannel.getStatus();
        const outcome = await this.resyncSession(status);
        this.phase = 'connected';
        // Re-arm liveness only once the link is fully back. Started earlier, a
        // heartbeat timeout landing while phase is still 'reconnecting' is
        // swallowed by handleConnectionLost's guard — and since the watchdog
        // stops itself when it fires, the link would never be watched again.
        this.heartbeat.start();
        this.log.info(
          `${outcome === 'reconnected' ? 'reconnected' : 'reconnected but the receiver app is gone'} ` +
            `after ${attempt} attempt(s) in ${Date.now() - startedAt}ms`,
        );
        this.emit(outcome);
        return;
      } catch (err) {
        lastError = asError(err);
        this.log.warn(`reconnect attempt ${attempt}/${this.maxAttempts} failed:`, lastError.message);
        this.heartbeat.stop();
        this.teardownSocket();
      }
    }
    this.phase = 'closed';
    const why = lastError ? `: ${lastError.message}` : '';
    this.log.error(`reconnect gave up after ${this.maxAttempts} attempts${why}`);
    this.emitError(new CastConnectionError(`reconnect failed after ${this.maxAttempts} attempts${why}`));
    this.emit('close');
  }

  /**
   * Re-attach to the app we were driving. Returns the event the caller must
   * emit — emitting is deferred so listeners never observe a half-restored
   * client (phase still 'reconnecting', heartbeat not yet re-armed).
   */
  private async resyncSession(status: ReceiverStatus): Promise<'reconnected' | 'session-lost'> {
    if (!this.session || !this.activeMedia) {
      return 'reconnected';
    }
    const app = status.applications?.find((a) => a.sessionId === this.session!.sessionId);
    if (!app) {
      this.log.warn('receiver app gone after reconnect — session lost');
      this.activeMedia.controller.markLost();
      this.session = undefined;
      return 'session-lost';
    }
    if (app.transportId !== this.session.transportId) {
      this.session.transportId = app.transportId;
      this.activeMedia.connectionApp.setRemoteId(app.transportId);
      this.activeMedia.channel.setRemoteId(app.transportId);
    }
    this.activeMedia.connectionApp.connect();
    try {
      // Best-effort resync only. NOTE: a receiver that kept the app but dropped
      // its media session answers this with an EMPTY status array, which
      // MediaChannel resolves to the STALE last status — so a healthy-looking
      // resync does NOT mean the old mediaSessionId is still valid. Restoring
      // the transport is not restoring playback; the owner of the session must
      // re-LOAD (see PlaybackSessionImpl.resumeAfterReconnect).
      await this.activeMedia.channel.getStatus();
    } catch (err) {
      this.log.warn('media resync GET_STATUS failed:', asError(err).message);
    }
    return 'reconnected';
  }

  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      this.log.error('cast client error (no listener attached):', err);
    }
  }
}

/** Promise sleep whose timer never keeps the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export { NS };
