/**
 * contracts.ts — the seam between `main.ts` and `views/*`.
 *
 * `main.ts` owns the engine (it is the only file that touches
 * `window.castgorilla`) and the store; the views own the DOM and know nothing
 * about IPC. Everything they are allowed to say to each other is declared here,
 * which is what keeps a view from quietly growing an engine dependency.
 *
 * Type-only, so this module contributes nothing to the bundle.
 */

import type { AppState } from '../store.js';

/**
 * A mounted view. `render` is called on every store notification and must be
 * cheap and idempotent — it is the only rendering entry point.
 *
 * `renderPosition` is the OPTIONAL per-frame hook, called from the rAF loop with
 * the store's interpolated position. Only the player bar implements it: the
 * whole point of splitting it out is that the rest of the DOM is NOT touched
 * sixty times a second.
 */
export interface View {
  render(state: Readonly<AppState>): void;
  renderPosition?(state: Readonly<AppState>, positionSec: number): void;
}

/**
 * The keyed, persistent banner slots.
 *
 * Deliberately a closed union rather than `string`: the whole value of the keyed
 * banner system is that these four conditions coexist and update in place
 * instead of clobbering one another, and a typo'd fifth key would silently
 * become a fifth banner that nothing ever clears.
 *
 *  - `probe`   — the file could not be read (this is where a missing ffmpeg bites)
 *  - `plan`    — the planner refused this file on this device
 *  - `session` — the receiver dropped the session, or a start failed
 *  - `mode`    — we wanted the real engine and fell back to the mock
 */
export type BannerKey = 'probe' | 'plan' | 'session' | 'mode';

export type BannerSeverity = 'error' | 'warn';

/** Persistent banners + transient toasts. Implemented by `views/feedback.ts`. */
export interface Feedback {
  setBanner(key: BannerKey, message: string, severity: BannerSeverity): void;
  clearBanner(key: BannerKey): void;
  toast(message: string, isError?: boolean): void;
}

/**
 * A request for a still frame — the view-facing shape of `ThumbnailRequest` from
 * the IPC contract, redeclared here so views never import from `shared/ipc.ts`
 * (they know nothing about IPC; `main.ts` owns that boundary).
 */
export interface ThumbnailQuery {
  file: string;
  atSec?: number;
  variant?: 'thumb' | 'backdrop';
}

/**
 * Fetch a still frame as a `data:image/jpeg;base64,…` URI, or `null` when one
 * could not be produced. Injected into the views that render artwork (the file
 * card, the casting backdrop, the recents cards) so they never touch the engine
 * surface directly. `main.ts` wraps `window.castgorilla.getThumbnail` in a cache
 * and passes it here.
 */
export type ThumbnailFetcher = (query: ThumbnailQuery) => Promise<string | null>;

/**
 * Everything a view can ask the app to DO. Each of these is fire-and-forget from
 * the view's point of view: `main.ts` owns the promise, the error handling and
 * the banner/toast that results, because that is where `cleanErr` and the
 * `CommandResult` contract live.
 */
export interface AppActions {
  /** Open the native picker; a chosen file is loaded exactly like a dropped one. */
  openFileDialog(): void;
  /** Probe + plan a path that has already been validated by the caller. */
  loadPath(path: string): void;
  /** Back to the empty state. */
  clearFile(): void;

  selectDevice(id: string | null): void;
  /** Re-run discovery on demand (the sidebar refresh button). */
  refreshDevices(): void;
  setSurround(on: boolean): void;
  setHdrPolicy(policy: 'warn' | 'block'): void;

  /** Forget the recently-played list (the recents "Clear" button). */
  clearRecents(): void;
  /** Forget a single recent by path (the per-card dismiss X). */
  removeRecent(path: string): void;

  /** Start a brand-new session from the current file/device/plan. */
  start(): void;
  resume(): void;
  pause(): void;
  stop(): void;
  seek(positionSec: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  selectAudio(streamIndex: number): void;
  selectSubtitle(trackId: number | null): void;
}
