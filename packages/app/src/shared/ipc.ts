/**
 * ipc.ts — the ONE shared IPC contract.
 *
 * Both the main process (handlers) and the renderer (via the preload bridge)
 * import channel names and payload types from here so the two sides can never
 * drift. The surface mirrors the engine's `Engine` + `PlaybackSession` API.
 *
 * Two kinds of channel:
 *  - REQUEST channels  — renderer → main, request/response (`ipcRenderer.invoke`
 *    ↔ `ipcMain.handle`). One payload object in, one typed result out.
 *  - EVENT channels     — main → renderer, fire-and-forget pushes
 *    (`webContents.send` → `ipcRenderer.on`).
 */

import type {
  DiscoveredDevice,
  MediaInfo,
  PlaybackPlan,
  PlaybackPrefs,
  SessionState,
  SessionStatus,
} from './engine-types.js';

/** Whether the app is running on the canned MockEngine, and why. */
export interface EngineMode {
  mock: boolean;
  /** Present when we *wanted* the real engine but fell back to the mock. */
  reason?: string;
}

// --- Command results --------------------------------------------------------

/**
 * The result of a TRANSPORT command (pause/resume/seek/stop/volume/mute/track
 * selection). These used to resolve `void` and let a rejected engine promise
 * escape the `ipcMain.handle` callback, which Electron reports as an uncaught
 * main-process error:
 *
 *   Error occurred in handler for 'session:pause': CastCommandError: Cast device
 *   rejected request with INVALID_REQUEST: INVALID_MEDIA_SESSION_ID
 *
 * A command aimed at a session the receiver has already discarded is a *state*,
 * not a crash — so the handlers contain the rejection and resolve this instead.
 * `message` mirrors the shape already used by the `EVT.error` payload.
 */
export interface CommandResult {
  ok: boolean;
  /** Present only when `ok` is false. */
  error?: {
    message: string;
    /** The receiver's own rejection reason, when it gave one (e.g.
     *  `INVALID_MEDIA_SESSION_ID`). */
    reason?: string;
  };
  /**
   * True when the failure means the receiver has thrown the media session away
   * (`INVALID_MEDIA_SESSION_ID`): the media is genuinely gone, so the UI should
   * drop back to an idle state rather than showing a transient error.
   */
  sessionGone?: boolean;
}

// --- Request payloads -------------------------------------------------------

export interface ProbeRequest {
  file: string;
}

/**
 * Ask main for a still frame from a video, as a `data:image/jpeg;base64,…`
 * string, or `null` when a frame could not be produced (unreadable file, no
 * decodable frame at the offset, ffmpeg missing). Used by the empty-state
 * recents thumbnails and the casting-view backdrop.
 *
 * `atSec` is the timestamp to grab (default: an early-but-past-the-intro offset
 * chosen by main). `variant` distinguishes a small poster-ish thumbnail from a
 * larger, blurred backdrop, so main can pick dimensions/quality accordingly.
 */
export interface ThumbnailRequest {
  file: string;
  atSec?: number;
  variant?: 'thumb' | 'backdrop';
}

export interface PlanRequest {
  deviceId: string;
  media: MediaInfo;
  prefs: PlaybackPrefs;
}

export interface StartSessionRequest {
  deviceId: string;
  media: MediaInfo;
  plan: PlaybackPlan;
  prefs: PlaybackPrefs;
}

export interface SeekRequest {
  positionSec: number;
}

export interface VolumeRequest {
  volume: number;
}

export interface MutedRequest {
  muted: boolean;
}

export interface SelectAudioRequest {
  index: number;
}

export interface SelectSubtitleRequest {
  trackId: number | null;
}

// --- Request channel names --------------------------------------------------

export const REQ = {
  getMode: 'engine:getMode',
  listDevices: 'discovery:list',
  rescanDevices: 'discovery:rescan',
  openVideoDialog: 'dialog:openVideo',
  probe: 'engine:probe',
  getThumbnail: 'engine:getThumbnail',
  plan: 'engine:plan',
  startSession: 'session:start',
  pause: 'session:pause',
  resume: 'session:resume',
  seek: 'session:seek',
  stop: 'session:stop',
  setVolume: 'session:setVolume',
  setMuted: 'session:setMuted',
  selectAudio: 'session:selectAudio',
  selectSubtitle: 'session:selectSubtitle',
  getStatus: 'session:getStatus',
} as const;

export type RequestChannel = (typeof REQ)[keyof typeof REQ];

/**
 * The typed request table: for every REQUEST channel, the payload it accepts
 * and the result it resolves to. `void` payloads take no argument.
 */
export interface RequestMap {
  [REQ.getMode]: { params: void; result: EngineMode };
  [REQ.listDevices]: { params: void; result: DiscoveredDevice[] };
  /** Re-issue the mDNS query, then return the (possibly-unchanged) snapshot. */
  [REQ.rescanDevices]: { params: void; result: DiscoveredDevice[] };
  [REQ.openVideoDialog]: { params: void; result: string | null };
  [REQ.probe]: { params: ProbeRequest; result: MediaInfo };
  [REQ.getThumbnail]: { params: ThumbnailRequest; result: string | null };
  [REQ.plan]: { params: PlanRequest; result: PlaybackPlan };
  [REQ.startSession]: { params: StartSessionRequest; result: SessionStatus };
  [REQ.pause]: { params: void; result: CommandResult };
  [REQ.resume]: { params: void; result: CommandResult };
  [REQ.seek]: { params: SeekRequest; result: CommandResult };
  [REQ.stop]: { params: void; result: CommandResult };
  [REQ.setVolume]: { params: VolumeRequest; result: CommandResult };
  [REQ.setMuted]: { params: MutedRequest; result: CommandResult };
  [REQ.selectAudio]: { params: SelectAudioRequest; result: CommandResult };
  [REQ.selectSubtitle]: { params: SelectSubtitleRequest; result: CommandResult };
  [REQ.getStatus]: { params: void; result: SessionStatus | null };
}

// --- Event channel names ----------------------------------------------------

export const EVT = {
  /** Full device-list snapshot, pushed whenever discovery adds/removes a device. */
  devices: 'discovery:devices',
  /** Authoritative status snapshot, pushed at 1Hz while a session is live. */
  status: 'session:status',
  /** Session state-machine transition. */
  state: 'session:state',
  /** Position update (~1Hz from the engine); used as an interpolation baseline. */
  position: 'session:position',
  /** A human-readable warning to surface as a toast. */
  warning: 'session:warning',
  /** The active item played to completion. */
  ended: 'session:ended',
  /** A session error (message only; Errors do not survive structured clone). */
  error: 'session:error',
  /** Engine mode changed (e.g. real-engine fallback to mock). */
  mode: 'engine:mode',
} as const;

export type EventChannel = (typeof EVT)[keyof typeof EVT];

/** The payload pushed on each EVENT channel. */
export interface EventMap {
  [EVT.devices]: DiscoveredDevice[];
  [EVT.status]: SessionStatus;
  [EVT.state]: SessionState;
  [EVT.position]: number;
  [EVT.warning]: string;
  [EVT.ended]: void;
  [EVT.error]: { message: string };
  [EVT.mode]: EngineMode;
}

/**
 * The API surface the preload bridge exposes on `window.castgorilla`. Command
 * methods wrap `ipcRenderer.invoke`; the `on*` methods subscribe to EVENT
 * channels and return an unsubscribe function.
 */
export interface CastgorillaApi {
  getMode(): Promise<EngineMode>;
  listDevices(): Promise<DiscoveredDevice[]>;
  /**
   * Re-issue the mDNS query and return the resulting device snapshot. Unlike
   * `listDevices` (which just returns the cache), this re-queries the network so
   * a device that was asleep at launch can appear. Async arrivals still come
   * through the `onDevices` push, so the returned list is a lower bound.
   */
  rescanDevices(): Promise<DiscoveredDevice[]>;
  openVideoDialog(): Promise<string | null>;
  probe(file: string): Promise<MediaInfo>;
  /** A still frame as `data:image/jpeg;base64,…`, or null on failure. */
  getThumbnail(req: ThumbnailRequest): Promise<string | null>;
  plan(req: PlanRequest): Promise<PlaybackPlan>;
  startSession(req: StartSessionRequest): Promise<SessionStatus>;
  pause(): Promise<CommandResult>;
  resume(): Promise<CommandResult>;
  seek(positionSec: number): Promise<CommandResult>;
  stop(): Promise<CommandResult>;
  setVolume(volume: number): Promise<CommandResult>;
  setMuted(muted: boolean): Promise<CommandResult>;
  selectAudio(index: number): Promise<CommandResult>;
  selectSubtitle(trackId: number | null): Promise<CommandResult>;
  getStatus(): Promise<SessionStatus | null>;

  /**
   * Resolve the on-disk path of a dropped `File`. Preload-local (`webUtils`),
   * NOT an IPC channel — hence synchronous, unlike every other method here.
   *
   * Why it is different: `File.path` was REMOVED in Electron 32 (we are on 43),
   * so `webUtils.getPathForFile()` is the only supported way to get a real
   * filesystem path out of a drop. It must be called in the PRELOAD — a `File`
   * is not structured-cloneable across the IPC boundary, so there is nothing to
   * send to main and nothing to await. Returns null when the File is not backed
   * by a file on disk (`getPathForFile` returns `''`) or when it is handed
   * something that is not a File at all (it throws).
   */
  pathForFile(file: File): string | null;

  onDevices(cb: (devices: DiscoveredDevice[]) => void): () => void;
  onStatus(cb: (status: SessionStatus) => void): () => void;
  onState(cb: (state: SessionState) => void): () => void;
  onPosition(cb: (positionSec: number) => void): () => void;
  onWarning(cb: (warning: string) => void): () => void;
  onEnded(cb: () => void): () => void;
  onError(cb: (message: string) => void): () => void;
  onMode(cb: (mode: EngineMode) => void): () => void;
}

declare global {
  interface Window {
    castgorilla: CastgorillaApi;
  }
}
