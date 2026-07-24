/**
 * engine-service.ts — the main-process orchestration layer, with ZERO Electron
 * dependencies so it is unit-testable against the MockEngine directly.
 *
 * It owns:
 *  - device discovery wiring (pushes a full device snapshot on every change),
 *  - exactly ONE active PlaybackSession at a time,
 *  - a 1Hz authoritative status push while a session is live,
 *  - the power assertion that keeps macOS from idle-sleeping mid-playback
 *    (see `power.ts`; the session's lifetime IS the assertion's lifetime),
 *  - and event fan-out (state / position / warning / ended / error) to the UI.
 *
 * The Electron glue in `ipc.ts` is a thin adapter over this class: it feeds
 * `push` into `webContents.send`, injects the real `powerSaveBlocker`, and maps
 * `ipcMain.handle` calls onto these methods (see `handlers.ts`).
 */

import { createNoopSleepBlocker, type SleepBlocker } from './power.js';
import { logError, logInfo, logWarn } from './log.js';
import type { Engine, PlaybackSession } from '../shared/engine-types.js';
import type {
  EngineMode,
  EventChannel,
  EventMap,
  PlanRequest,
  StartSessionRequest,
} from '../shared/ipc.js';
import { EVT } from '../shared/ipc.js';

/** Loosely-typed push sink so a plain spy can stand in for `webContents.send`. */
export type PushFn = (channel: EventChannel, payload: unknown) => void;

const STATUS_PUSH_MS = 1000;

export class EngineService {
  private session: PlaybackSession | undefined;
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(
    private readonly engine: Engine,
    private readonly mode: EngineMode,
    private readonly push: PushFn,
    /**
     * The idle-sleep assertion, injected by `ipc.ts` (the Electron boundary) so
     * this class keeps its zero-Electron-dependency property. Defaults to a
     * no-op so a service built without one behaves exactly as before.
     */
    private readonly power: SleepBlocker = createNoopSleepBlocker(),
  ) {}

  /** Typed wrapper around the loose push sink. */
  private emit<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
    this.push(channel, payload);
  }

  /** Announce the current mode and start discovery. Idempotent. */
  init(): void {
    if (this.started) return;
    this.started = true;

    // Announce the mode FIRST, before anything that can throw. A late renderer
    // may miss this push (it also pulls the mode on boot via REQ.getMode), but
    // emitting up front guarantees the badge/banner get the mode even if
    // discovery.start() below blows up.
    this.emit(EVT.mode, this.mode);

    this.engine.discovery.on('device', () => this.emit(EVT.devices, this.engine.discovery.list()));
    this.engine.discovery.on('removed', () => this.emit(EVT.devices, this.engine.discovery.list()));
    this.engine.discovery.on('error', (err: Error) =>
      this.emit(EVT.warning, `Discovery error: ${err.message}`),
    );

    // A discovery.start() failure must not abort init(): the mode is already
    // announced and the request handlers are live, so degrade to a warning
    // toast rather than crashing the main process.
    try {
      this.engine.discovery.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(EVT.warning, `Discovery failed to start: ${message}`);
    }
  }

  getMode(): EngineMode {
    return this.mode;
  }

  listDevices() {
    return this.engine.discovery.list();
  }

  /**
   * Re-issue the mDNS query, then return the current snapshot. `rescan()` prompts
   * responsive devices to re-announce; any that were not already known arrive
   * asynchronously and reach the UI through the same `EVT.devices` push as normal
   * discovery, so the value returned here is whatever is known synchronously (a
   * lower bound), not a "settled" list.
   */
  rescanDevices() {
    this.engine.discovery.rescan();
    return this.engine.discovery.list();
  }

  async probe(file: string) {
    return this.engine.probe(file);
  }

  plan(req: PlanRequest) {
    const device = this.requireDevice(req.deviceId);
    return this.engine.plan(req.media, device.profile, req.prefs);
  }

  async startSession(req: StartSessionRequest) {
    const device = this.requireDevice(req.deviceId);

    // Only one session at a time — tear down any previous one first (which
    // releases the previous assertion).
    await this.teardownSession();

    // Take the assertion BEFORE play(): bringing a session up can take a while
    // on the transcode tiers (ffmpeg start + first segments), and the machine
    // must not doze off during that window either.
    this.power.acquire();

    let session: PlaybackSession;
    try {
      session = await this.engine.play({
        device,
        media: req.media,
        plan: req.plan,
        prefs: req.prefs,
      });
    } catch (err) {
      // A failed start leaves no session to tear down, so nothing else would
      // ever drop the assertion — release it here or it leaks forever.
      this.power.release();
      throw err;
    }
    this.session = session;
    this.wireSession(session);
    this.startStatusPushes();

    const status = session.status();
    // The header line for everything that follows. `session.id` is the SAME id
    // the engine builds its own log prefix from (`[castgorilla:session:<id>:…]`),
    // so the app's lines and the engine's can be correlated in one file.
    logInfo(
      'session',
      `${session.id} started — device="${status.deviceName}" tier=${status.tier} method=${req.plan.method}`,
    );
    this.emit(EVT.status, status);
    return status;
  }

  async pause() {
    await this.session?.pause();
    this.pushStatus();
  }

  async resume() {
    await this.session?.resume();
    this.pushStatus();
  }

  async seek(positionSec: number) {
    await this.session?.seek(positionSec);
    this.pushStatus();
  }

  async setVolume(volume: number) {
    await this.session?.setVolume(volume);
    this.pushStatus();
  }

  async setMuted(muted: boolean) {
    await this.session?.setMuted(muted);
    this.pushStatus();
  }

  async selectAudio(index: number) {
    await this.session?.selectAudioStream(index);
    this.pushStatus();
  }

  async selectSubtitle(trackId: number | null) {
    await this.session?.selectSubtitleTrack(trackId);
    this.pushStatus();
  }

  async stop() {
    await this.teardownSession();
  }

  getStatus() {
    return this.session ? this.session.status() : null;
  }

  /**
   * Full shutdown: tear down the session and the engine. Called on window close
   * and on app quit — both of them exit routes that must drop the assertion.
   */
  async shutdown() {
    await this.teardownSession();
    // Belt and braces: teardownSession() already released, but shutdown() is
    // the last thing that runs before the app goes away, so make certain.
    this.power.release();
    await this.engine.shutdown();
  }

  // --- internals ------------------------------------------------------------

  private requireDevice(deviceId: string) {
    const device = this.engine.discovery.list().find((d) => d.id === deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId}`);
    return device;
  }

  private wireSession(session: PlaybackSession): void {
    session.on('state', (state) => {
      this.emit(EVT.state, state);
      this.pushStatus();
    });
    // NOT logged: 'position' arrives at ~1Hz for the life of the session and
    // would bury every line that matters.
    session.on('position', (positionSec) => this.emit(EVT.position, positionSec));
    // Warnings reach the user as a toast that is gone in six seconds; the log is
    // the only copy that outlives the session.
    session.on('warning', (warning) => {
      logWarn('session', `${session.id} ${warning}`);
      this.emit(EVT.warning, warning);
    });
    // Both of these are exit routes from playback: the assertion is dropped by
    // teardownSession(). They are fire-and-forget, so keep the rejection from
    // escaping as an unhandled rejection in the main process.
    session.on('ended', () => {
      // Pairs with the 'started' line: without it, "played to completion" and
      // "died" are indistinguishable after the fact — both were silent.
      logInfo('session', `${session.id} ended — playback finished`);
      this.emit(EVT.ended, undefined);
      void this.teardownSession();
    });
    session.on('error', (err) => {
      // THE line whose absence made a real failure undiagnosable. The engine
      // deliberately does not log this itself: `emitError()` only logs when no
      // listener is attached, and attaching one here is precisely what silences
      // it — so the owner of the session owes the log line.
      logError('session', `${session.id} error — ${err.message}`);
      this.emit(EVT.error, { message: err.message });
      void this.teardownSession();
    });
  }

  private startStatusPushes(): void {
    this.stopStatusPushes();
    this.statusTimer = setInterval(() => this.pushStatus(), STATUS_PUSH_MS);
  }

  private stopStatusPushes(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }

  private pushStatus(): void {
    if (this.session) this.emit(EVT.status, this.session.status());
  }

  /**
   * THE single exit route from playback — every other one funnels through here
   * (user stop, `ended`, `error`, a replacement session, window close, quit),
   * which is what makes "release the assertion here" sufficient.
   *
   * It never rejects. A receiver that has already discarded the session rejects
   * `stop()`, and that must not stop us from releasing local resources, nor
   * block the next `startSession()` that awaits this, nor bubble out of the
   * fire-and-forget `ended`/`error` callers as an unhandled rejection.
   */
  private async teardownSession(): Promise<void> {
    this.stopStatusPushes();
    const session = this.session;
    this.session = undefined;
    try {
      if (session) await session.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn('session', `stop() failed while tearing down — ${message}`);
    } finally {
      this.power.release();
    }
  }
}
