/**
 * store.ts — the renderer's pure state store.
 *
 * Holds everything the UI renders and, critically, interpolates the playback
 * position between the engine's ~1Hz updates so the seek bar moves smoothly.
 * All time-dependent methods take an explicit `now` (ms since epoch) so they are
 * deterministic under test; callers in the browser pass `Date.now()` /
 * `performance.now()`-derived values.
 *
 * No DOM, no IPC — the UI layer (`main.ts`) subscribes and feeds it events.
 */

import type {
  DiscoveredDevice,
  MediaInfo,
  PlaybackPlan,
  PlaybackPrefs,
  SessionState,
  SessionStatus,
} from '../shared/engine-types.js';
import type { EngineMode } from '../shared/ipc.js';
import type { RecentEntry } from './recents.js';

export interface AppState {
  mode: EngineMode | null;
  devices: DiscoveredDevice[];
  selectedDeviceId: string | null;
  file: string | null;
  media: MediaInfo | null;
  /** True between choosing a file and the probe resolving (or failing). */
  probing: boolean;
  plan: PlaybackPlan | null;
  prefs: PlaybackPrefs;
  status: SessionStatus | null;
  /** Baseline for interpolation: position + the clock at which it was observed. */
  positionBaseSec: number;
  positionBaseAt: number;
  warnings: string[];
  /** Recently-played files, newest first (empty-state "pick up where you left off"). */
  recents: RecentEntry[];
}

const DEFAULT_PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

/**
 * Whether the MOCK MODE badge should be visible for a given engine mode. The
 * badge shows whenever we are on the mock engine (deliberate override OR
 * real-engine fallback); it stays hidden on the real engine and before the mode
 * is known. Pure so the visibility rule is unit-tested without the DOM.
 */
export function shouldShowMockBadge(mode: EngineMode | null): boolean {
  return mode?.mock === true;
}

/** States in which the position clock is advancing. */
function isAdvancing(state: SessionState | undefined): boolean {
  return state === 'playing';
}

/**
 * Which device should be selected, given what discovery currently sees.
 *
 * Precedence, and the reason for each step:
 *  1. KEEP the current selection, if it is still being discovered. Callers pass
 *     `null` here for a selection the STORE made rather than the user — see
 *     `Store.deviceIsExplicit`. That distinction is the whole subtlety: an
 *     auto-picked first device must not outrank the remembered one, or the
 *     preference would only ever apply on a launch where discovery happened to
 *     be empty at the time.
 *  2. Otherwise the REMEMBERED device from the last session, if it is on the
 *     network right now. This is the case that makes launching fast: the TV you
 *     always use is already chosen by the time you have read the filename.
 *  3. Otherwise the first device found, which is the previous behaviour and the
 *     only sensible answer when we have nothing to go on.
 *
 * Pure, so the precedence is unit-tested without a DOM or a storage backend.
 * A remembered id that is not on the network is silently ignored rather than
 * held open — the engine ids differ between the mock and real engines, so a
 * stale id is an ordinary occurrence, not an error.
 */
export function pickDevice(
  devices: readonly DiscoveredDevice[],
  current: string | null,
  preferred: string | null,
): string | null {
  if (current !== null && devices.some((d) => d.id === current)) return current;
  if (preferred !== null && devices.some((d) => d.id === preferred)) return preferred;
  return devices[0]?.id ?? null;
}

export class Store {
  private state: AppState = {
    mode: null,
    devices: [],
    selectedDeviceId: null,
    file: null,
    media: null,
    probing: false,
    plan: null,
    prefs: { ...DEFAULT_PREFS },
    status: null,
    positionBaseSec: 0,
    positionBaseAt: 0,
    warnings: [],
    recents: [],
  };

  /**
   * The device to fall back to when nothing is selected — the last one actually
   * cast to, restored from storage at boot by `main.ts`.
   *
   * Deliberately NOT part of `AppState`: no view renders it, and it is not a
   * fact about the current session. It is only ever an input to `pickDevice`.
   */
  private preferredDeviceId: string | null = null;

  /**
   * Whether `selectedDeviceId` is a USER's choice rather than one the store made.
   *
   * Without this the two selection rules fight: `setDevices` auto-picks the first
   * device, and that auto-pick then looks exactly like a deliberate choice to
   * every later call, so the remembered device could never win. Only
   * `selectDevice()` — which is only ever called from the picker's `change`
   * event — sets it.
   */
  private deviceIsExplicit = false;

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  // --- interpolation --------------------------------------------------------

  /**
   * The position to render right now. While `playing`, this advances linearly
   * from the last observed baseline; otherwise it holds. Always clamped to
   * [0, duration].
   */
  getPosition(now: number): number {
    const { status, positionBaseSec, positionBaseAt } = this.state;
    if (!status) return 0;
    const elapsed = isAdvancing(status.state) ? Math.max(0, (now - positionBaseAt) / 1000) : 0;
    const pos = positionBaseSec + elapsed;
    const dur = status.durationSec || Infinity;
    return Math.max(0, Math.min(pos, dur));
  }

  private setBaseline(positionSec: number, now: number): void {
    this.state.positionBaseSec = positionSec;
    this.state.positionBaseAt = now;
  }

  // --- mutations (each returns after notifying subscribers) -----------------

  setMode(mode: EngineMode): void {
    this.state.mode = mode;
    this.notify();
  }

  setDevices(devices: DiscoveredDevice[]): void {
    this.state.devices = devices;
    this.reselectDevice(devices);
    this.notify();
  }

  /**
   * Restore the last-used device id (from storage, at boot).
   *
   * Re-runs the selection rather than only seeding it, so it is correct whether
   * it lands before or after the first device list.
   */
  setPreferredDeviceId(id: string | null): void {
    this.preferredDeviceId = id;
    this.reselectDevice(this.state.devices);
    this.notify();
  }

  selectDevice(id: string | null): void {
    this.state.selectedDeviceId = id;
    // From here on this selection outranks both the remembered device and the
    // first-found default, for as long as it stays on the network.
    this.deviceIsExplicit = id !== null;
    this.notify();
  }

  /**
   * Re-run the selection precedence against a device list.
   *
   * An explicit choice that has dropped off the network stops being explicit:
   * whatever we fall back to is the store's pick, not the user's, and must not
   * inherit the authority of a choice they can no longer see.
   */
  private reselectDevice(devices: readonly DiscoveredDevice[]): void {
    const current = this.state.selectedDeviceId;
    const explicitAndPresent =
      this.deviceIsExplicit && current !== null && devices.some((d) => d.id === current);
    if (this.deviceIsExplicit && !explicitAndPresent) this.deviceIsExplicit = false;

    this.state.selectedDeviceId = pickDevice(
      devices,
      explicitAndPresent ? current : null,
      this.preferredDeviceId,
    );
  }

  setFile(file: string | null): void {
    this.state.file = file;
    this.state.media = null;
    this.state.plan = null;
    // Choosing a file always kicks off a probe; clearing one cannot be probing.
    this.state.probing = file !== null;
    this.notify();
  }

  /**
   * Apply the probe result. `null` is the FAILURE path (see `main.ts`), so this
   * always ends the probing state — there is deliberately no separate
   * `setProbeFailed`: every route out of a probe passes through here.
   */
  setMedia(media: MediaInfo | null): void {
    this.state.media = media;
    this.state.probing = false;
    this.notify();
  }

  setPlan(plan: PlaybackPlan | null): void {
    this.state.plan = plan;
    this.notify();
  }

  setPrefs(patch: Partial<PlaybackPrefs>): void {
    this.state.prefs = { ...this.state.prefs, ...patch };
    this.notify();
  }

  /** Apply an authoritative status snapshot; this resets the interpolation baseline. */
  applyStatus(status: SessionStatus, now: number): void {
    this.state.status = status;
    this.setBaseline(status.positionSec, now);
    this.notify();
  }

  /** Apply a state transition without a full snapshot; re-baselines cleanly. */
  applyState(state: SessionState, now: number): void {
    if (!this.state.status) return;
    // Freeze the currently-interpolated position before flipping state so a
    // play → pause transition holds exactly where the bar was.
    const frozen = this.getPosition(now);
    this.state.status = { ...this.state.status, state };
    this.setBaseline(frozen, now);
    this.notify();
  }

  /** Apply a discrete position update (engine tick / post-seek); re-baselines. */
  applyPosition(positionSec: number, now: number): void {
    if (this.state.status) {
      this.state.status = { ...this.state.status, positionSec };
    }
    this.setBaseline(positionSec, now);
    this.notify();
  }

  /** Clear the live session (ended / stopped / error). */
  clearSession(now: number): void {
    this.state.status = null;
    this.setBaseline(0, now);
    this.notify();
  }

  /** Replace the recently-played list (loaded at boot, updated on each record/clear). */
  setRecents(recents: RecentEntry[]): void {
    this.state.recents = recents;
    this.notify();
  }

  addWarning(warning: string): void {
    this.state.warnings = [...this.state.warnings, warning];
    this.notify();
  }

  removeWarning(warning: string): void {
    const idx = this.state.warnings.indexOf(warning);
    if (idx === -1) return;
    const next = this.state.warnings.slice();
    next.splice(idx, 1);
    this.state.warnings = next;
    this.notify();
  }
}
