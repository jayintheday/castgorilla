/**
 * activity.ts — `#activity`, the indeterminate bar at the top of the window.
 *
 * It answers one question visually: is the app busy getting something ready to
 * play? It is on during the pre-roll states (preparing → buffering) and during
 * seek/reconnect, and off otherwise — including during steady `playing`, where
 * the player bar's scrubber is the status surface and a permanent top bar would
 * just be noise.
 *
 * Why NOT during `playing` even though a transcode keeps running: the transcode
 * is on-demand and never "finishes" separately from playback, so a bar that
 * meant "still transcoding" would be up for the entire runtime of every
 * transcoded file. The honest, useful signal is the wait the user actually feels
 * — the gap between pressing Play and the picture appearing — not the invisible
 * work that continues behind a playing picture.
 *
 * The bar carries no percentage on purpose: the engine reports neither transcode
 * progress nor buffer level, so motion (not a fill level) is the whole message.
 * See the ACTIVITY block in components.css.
 */

import type { SessionState } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { View } from './contracts.js';
import { el } from './dom.js';

/**
 * The states in which the bar is shown: the session exists and is working
 * towards a picture, but a picture is not yet up (or has been interrupted by a
 * seek/reconnect).
 *
 * Deliberately a subset of `ACTIVE_STATES` (player-bar.ts): it drops `playing`
 * and `paused` (a picture is up), and the terminal `stopped`/`error`. It also
 * drops `probing`/`planning`, which describe reading and planning the FILE — the
 * drop-zone spinner already covers that phase, and it happens before a device is
 * even contacted.
 */
export const WORKING_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'preparing',
  'connecting',
  'loading',
  'buffering',
  'seeking',
  'reconnecting',
]);

export function isWorking(state: SessionState | undefined): boolean {
  return state !== undefined && WORKING_STATES.has(state);
}

export function mountActivity(): View {
  const bar = el<HTMLElement>('activity');

  function render(state: Readonly<AppState>): void {
    const working = isWorking(state.status?.state);
    bar.classList.toggle('is-working', working);

    // Tint by tier while working, so the bar's colour says what kind of work is
    // happening (the vocabulary the old pill carried). Cleared when idle so a
    // stale colour cannot flash on the next unrelated activity.
    if (working && state.status) bar.dataset.tier = state.status.tier;
    else delete bar.dataset.tier;
  }

  return { render };
}
