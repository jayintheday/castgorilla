/**
 * mock-cast-receiver.ts — an in-process CASTV2 TLS receiver (a scripted Default
 * Media Receiver stand-in) for testing the cast stack WITHOUT a real Chromecast.
 *
 * Speaks real CASTV2 framing via the same `castv2` package the client uses, over
 * TLS on an ephemeral 127.0.0.1 port with a committed, test-only self-signed cert
 * (`test-only-cert.pem` / `test-only-key.pem`, valid ~10 years). The client
 * connects with rejectUnauthorized:false (as it does to real devices), so the
 * self-signed cert is accepted.
 *
 * Behaviors:
 *  - CONNECT (any dest): virtual connection accepted (no reply, like a real DMR).
 *  - PING → PONG (unless stopAnsweringPings()).
 *  - receiver GET_STATUS/LAUNCH/STOP/SET_VOLUME → RECEIVER_STATUS.
 *  - media LOAD → MEDIA_STATUS(BUFFERING) then a scheduled unsolicited PLAYING;
 *    PLAY/PAUSE/SEEK/STOP/EDIT_TRACKS_INFO mutate the scripted state and reply
 *    MEDIA_STATUS; GET_STATUS returns the current status.
 *
 * Fault injection: dropConnection(), stopAnsweringPings()/resumeAnsweringPings(),
 * sendMalformed(), delayNextResponse(ms), killApp(), discardMediaSession(),
 * stallAfterLoad() and emptyStatusOnLoad(). Plus pushMediaStatus() to emit an
 * unsolicited status and enablePeriodicPushes(ms) for progress ticks.
 *
 * Every LOAD is recorded in `loads` (contentId + currentTime + autoplay), which
 * is how the recovery tests prove a post-reconnect re-LOAD happened AND that it
 * carried the last known position rather than 0.
 */

import { Server } from 'castv2';
import type { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCastv2Ready } from '../../src/cast/castv2-ready.js';
import { NS } from '../../src/cast/constants.js';
import type { CastPlayerState, CastIdleReason, LoadMediaInformation } from '../../src/types/cast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CERT = readFileSync(join(HERE, 'test-only-cert.pem'));
const KEY = readFileSync(join(HERE, 'test-only-key.pem'));

/** A generous, plausible supportedMediaCommands bitmask (pause|seek|volume|...). */
const SUPPORTED_MEDIA_COMMANDS = 12303;

export interface MockReceiverOptions {
  friendlyName?: string;
  appId?: string;
  sessionId?: string;
  transportId?: string;
  /** Delay (ms) between the LOAD BUFFERING reply and the unsolicited PLAYING push. */
  loadTransitionMs?: number;
}

interface AppState {
  appId: string;
  sessionId: string;
  transportId: string;
  displayName: string;
}

interface MediaState {
  mediaSessionId: number;
  playerState: CastPlayerState;
  idleReason?: CastIdleReason;
  currentTime: number;
  media: LoadMediaInformation;
  activeTrackIds: number[];
}

/** What a LOAD asked for (the recovery tests assert on currentTime). */
export interface LoadRecord {
  contentId: string;
  currentTime: number | undefined;
  autoplay: boolean | undefined;
  activeTrackIds: number[] | undefined;
}

interface CastServerInternal {
  server: { address(): { port: number } | null };
  clients: Record<string, { socket: Socket }>;
}

export class MockCastReceiver {
  private server: Server | undefined;
  private _port = 0;
  private readonly opts: Required<MockReceiverOptions>;

  private app: AppState | undefined;
  private media: MediaState | undefined;
  private volume = { level: 1, muted: false };

  /** Every LOAD this receiver has been sent, oldest first. */
  readonly loads: LoadRecord[] = [];

  private answerPings = true;
  /**
   * How LOAD is answered:
   *  - 'normal' — MEDIA_STATUS(BUFFERING) then the scripted PLAYING push;
   *  - 'stall'  — MEDIA_STATUS carrying `stallPlayerState` and NO transition, so
   *               the sender is acknowledged but playback never starts;
   *  - 'empty'  — MEDIA_STATUS with an EMPTY status array (the receiver accepted
   *               the request but created no media session).
   */
  private loadMode: 'normal' | 'stall' | 'empty' = 'normal';
  private stallPlayerState: CastPlayerState = 'IDLE';
  private pendingDelayMs = 0;
  private lastClientId: string | undefined;
  private lastSenderId = 'sender-0';

  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private pushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MockReceiverOptions = {}) {
    this.opts = {
      friendlyName: options.friendlyName ?? 'Mock Cast Receiver',
      appId: options.appId ?? 'CC1AD845',
      sessionId: options.sessionId ?? 'mock-session-1',
      transportId: options.transportId ?? 'transport-1',
      loadTransitionMs: options.loadTransitionMs ?? 15,
    };
  }

  get port(): number {
    return this._port;
  }

  /** Start listening; resolves with the bound host/port. */
  async start(): Promise<{ host: string; port: number }> {
    await ensureCastv2Ready();
    const server = new Server({ cert: CERT, key: KEY });
    this.server = server;
    server.on('message', (clientId, sourceId, destinationId, namespace, data) => {
      this.onMessage(clientId, sourceId, destinationId, namespace, data);
    });
    server.on('error', () => {
      /* swallow: tests assert via client-side behavior */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = (server as unknown as CastServerInternal).server.address();
    this._port = addr ? addr.port : 0;
    return { host: '127.0.0.1', port: this._port };
  }

  async stop(): Promise<void> {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.loadTimer = undefined;
    this.pushTimer = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }

  // --- Fault injection ------------------------------------------------------

  /** Hard-drop every live TLS socket (simulates ECONNRESET / device reboot). */
  dropConnection(): void {
    const clients = (this.server as unknown as CastServerInternal | undefined)?.clients ?? {};
    for (const id of Object.keys(clients)) {
      try {
        clients[id]!.socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  stopAnsweringPings(): void {
    this.answerPings = false;
  }

  resumeAnsweringPings(): void {
    this.answerPings = true;
  }

  /** Emit a deliberately malformed (non-JSON) payload on the media channel. */
  sendMalformed(): void {
    if (!this.lastClientId || !this.server) return;
    const source = this.app?.transportId ?? this.opts.transportId;
    this.server.send(this.lastClientId, source, this.lastSenderId, NS.media, '{ this is not valid json ]');
  }

  /**
   * Answer LOAD with a status carrying `playerState` (default IDLE, no
   * idleReason) and skip the scripted PLAYING push: the sender's LOAD resolves
   * but no usable player state ever arrives. This is the shape a session hangs
   * on — it is what the LOAD watchdog exists to catch.
   */
  stallAfterLoad(playerState: CastPlayerState = 'IDLE'): void {
    this.loadMode = 'stall';
    this.stallPlayerState = playerState;
  }

  /** Answer LOAD with an EMPTY MEDIA_STATUS status array (no media session). */
  emptyStatusOnLoad(): void {
    this.loadMode = 'empty';
  }

  /** Delay the next outgoing response by `ms` (one-shot). */
  delayNextResponse(ms: number): void {
    this.pendingDelayMs = ms;
  }

  /**
   * Keep the app running but throw away the media session — what a real
   * receiver does across a long sender outage (laptop sleep). GET_STATUS then
   * answers with an EMPTY status array and the sender's old mediaSessionId is
   * dead, so only a fresh LOAD can resume playback.
   */
  discardMediaSession(): void {
    this.media = undefined;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
  }

  /** Remove the running app + media session (for session-lost testing). */
  killApp(): void {
    this.app = undefined;
    this.media = undefined;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.loadTimer = undefined;
    this.pushTimer = undefined;
  }

  /** Push an unsolicited MEDIA_STATUS (requestId 0), optionally mutating state first. */
  pushMediaStatus(overrides: Partial<Pick<MediaState, 'playerState' | 'currentTime'>> = {}): void {
    if (!this.media) return;
    if (overrides.playerState) this.media.playerState = overrides.playerState;
    if (overrides.currentTime !== undefined) this.media.currentTime = overrides.currentTime;
    this.sendMediaStatus(0, false);
  }

  /** Begin periodic MEDIA_STATUS pushes while PLAYING (progress ticks). */
  enablePeriodicPushes(intervalMs = 1000): void {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = setInterval(() => {
      if (this.media && this.media.playerState === 'PLAYING') {
        this.media.currentTime += intervalMs / 1000;
        this.sendMediaStatus(0, false);
      }
    }, intervalMs);
    this.pushTimer.unref?.();
  }

  // --- Message handling -----------------------------------------------------

  private onMessage(
    clientId: string,
    sourceId: string,
    destinationId: string,
    namespace: string,
    data: string | Buffer,
  ): void {
    this.lastClientId = clientId;
    this.lastSenderId = sourceId;
    if (typeof data !== 'string') return;
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const type = msg.type;
    const requestId = typeof msg['requestId'] === 'number' ? (msg['requestId'] as number) : 0;

    switch (namespace) {
      case NS.connection:
        // CONNECT/CLOSE: a real DMR does not reply; just accept.
        return;
      case NS.heartbeat:
        if (type === 'PING' && this.answerPings) {
          this.respond(destinationId, sourceId, NS.heartbeat, { type: 'PONG' });
        }
        return;
      case NS.receiver:
        this.onReceiver(type, msg, requestId, sourceId);
        return;
      case NS.media:
        this.onMedia(type, msg, requestId, sourceId, destinationId);
        return;
      default:
        return;
    }
  }

  private onReceiver(type: string | undefined, msg: Record<string, unknown>, requestId: number, sender: string): void {
    switch (type) {
      case 'LAUNCH':
        this.app = {
          appId: this.opts.appId,
          sessionId: this.opts.sessionId,
          transportId: this.opts.transportId,
          displayName: 'Default Media Receiver',
        };
        this.sendReceiverStatus(requestId, sender);
        return;
      case 'STOP': {
        this.app = undefined;
        this.media = undefined;
        this.sendReceiverStatus(requestId, sender);
        return;
      }
      case 'SET_VOLUME': {
        const vol = msg['volume'] as { level?: number; muted?: boolean } | undefined;
        if (vol?.level !== undefined) this.volume.level = vol.level;
        if (vol?.muted !== undefined) this.volume.muted = vol.muted;
        this.sendReceiverStatus(requestId, sender);
        return;
      }
      case 'GET_STATUS':
        this.sendReceiverStatus(requestId, sender);
        return;
      default:
        return;
    }
  }

  private onMedia(
    type: string | undefined,
    msg: Record<string, unknown>,
    requestId: number,
    sender: string,
    dest: string,
  ): void {
    switch (type) {
      case 'LOAD': {
        const media = msg['media'] as LoadMediaInformation;
        this.loads.push({
          contentId: media?.contentId,
          currentTime: typeof msg['currentTime'] === 'number' ? (msg['currentTime'] as number) : undefined,
          autoplay: typeof msg['autoplay'] === 'boolean' ? (msg['autoplay'] as boolean) : undefined,
          activeTrackIds: Array.isArray(msg['activeTrackIds']) ? (msg['activeTrackIds'] as number[]) : undefined,
        });
        if (this.loadMode === 'empty') {
          // No media session at all → sendMediaStatus emits `status: []`.
          this.media = undefined;
          this.sendMediaStatus(requestId, true, sender, dest);
          return;
        }
        this.media = {
          mediaSessionId: 1,
          playerState: this.loadMode === 'stall' ? this.stallPlayerState : 'BUFFERING',
          currentTime: typeof msg['currentTime'] === 'number' ? (msg['currentTime'] as number) : 0,
          media,
          activeTrackIds: Array.isArray(msg['activeTrackIds']) ? (msg['activeTrackIds'] as number[]) : [],
        };
        this.sendMediaStatus(requestId, true, sender, dest);
        if (this.loadMode === 'stall') return; // acknowledged, but never progresses
        // Scripted transition BUFFERING -> PLAYING as an unsolicited push.
        if (this.loadTimer) clearTimeout(this.loadTimer);
        this.loadTimer = setTimeout(() => {
          if (this.media) {
            this.media.playerState = 'PLAYING';
            this.sendMediaStatus(0, false);
          }
        }, this.opts.loadTransitionMs);
        this.loadTimer.unref?.();
        return;
      }
      case 'PLAY':
        if (this.media) this.media.playerState = 'PLAYING';
        this.sendMediaStatus(requestId, false, sender, dest);
        return;
      case 'PAUSE':
        if (this.media) this.media.playerState = 'PAUSED';
        this.sendMediaStatus(requestId, false, sender, dest);
        return;
      case 'STOP':
        if (this.media) {
          this.media.playerState = 'IDLE';
          this.media.idleReason = 'CANCELLED';
        }
        this.sendMediaStatus(requestId, false, sender, dest);
        return;
      case 'SEEK':
        if (this.media && typeof msg['currentTime'] === 'number') this.media.currentTime = msg['currentTime'] as number;
        this.sendMediaStatus(requestId, false, sender, dest);
        return;
      case 'EDIT_TRACKS_INFO':
        if (this.media && Array.isArray(msg['activeTrackIds'])) this.media.activeTrackIds = msg['activeTrackIds'] as number[];
        this.sendMediaStatus(requestId, false, sender, dest);
        return;
      case 'GET_STATUS':
        this.sendMediaStatus(requestId, true, sender, dest);
        return;
      default:
        return;
    }
  }

  // --- Response builders ----------------------------------------------------

  private sendReceiverStatus(requestId: number, sender: string): void {
    const applications = this.app
      ? [
          {
            appId: this.app.appId,
            sessionId: this.app.sessionId,
            transportId: this.app.transportId,
            displayName: this.app.displayName,
            statusText: 'Ready To Cast',
            isIdleScreen: false,
            namespaces: [{ name: NS.media }, { name: NS.connection }, { name: NS.receiver }],
          },
        ]
      : [];
    this.respond('receiver-0', sender, NS.receiver, {
      type: 'RECEIVER_STATUS',
      requestId,
      status: {
        applications,
        volume: { level: this.volume.level, muted: this.volume.muted, controlType: 'attenuation', stepInterval: 0.05 },
      },
    });
  }

  private sendMediaStatus(requestId: number, includeMedia: boolean, sender?: string, dest?: string): void {
    const to = sender ?? this.lastSenderId;
    const source = dest ?? this.app?.transportId ?? this.opts.transportId;
    const status = this.media
      ? [
          {
            mediaSessionId: this.media.mediaSessionId,
            playerState: this.media.playerState,
            currentTime: this.media.currentTime,
            supportedMediaCommands: SUPPORTED_MEDIA_COMMANDS,
            volume: { level: this.volume.level, muted: this.volume.muted },
            activeTrackIds: this.media.activeTrackIds,
            ...(includeMedia ? { media: this.media.media } : {}),
            ...(this.media.playerState === 'IDLE' && this.media.idleReason ? { idleReason: this.media.idleReason } : {}),
          },
        ]
      : [];
    this.respond(source, to, NS.media, { type: 'MEDIA_STATUS', requestId, status });
  }

  private respond(sourceId: string, destinationId: string, namespace: string, payload: unknown): void {
    const clientId = this.lastClientId;
    const server = this.server;
    if (!clientId || !server) return;
    const send = (): void => {
      // The client may have been dropped in the interim.
      const clients = (server as unknown as CastServerInternal).clients;
      if (!clients[clientId]) return;
      server.send(clientId, sourceId, destinationId, namespace, JSON.stringify(payload));
    };
    if (this.pendingDelayMs > 0) {
      const ms = this.pendingDelayMs;
      this.pendingDelayMs = 0;
      const t = setTimeout(send, ms);
      t.unref?.();
    } else {
      send();
    }
  }
}
