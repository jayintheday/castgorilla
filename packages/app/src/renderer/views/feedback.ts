/**
 * feedback.ts — everything the app says to the user that is not a control:
 * the keyed persistent banners, the transient toasts, and the MOCK badge.
 *
 * The banner/toast split is the load-bearing distinction here and it is NOT
 * cosmetic:
 *
 *  - A TOAST is for something that happened and is over — "Playback ended",
 *    "Seek failed". It disappears on its own.
 *  - A BANNER is for a condition that is still TRUE — ffmpeg is missing, this
 *    file cannot be played on this device, the receiver dropped the session.
 *    It is keyed so independent conditions coexist and update in place, and it
 *    stays until the condition resolves.
 *
 * Putting a probe failure in a 6s toast was the original mistake: the engine's
 * ffmpeg-install instructions are the single most actionable string the app can
 * ever produce, and they used to vanish before they could be read.
 */

import type { EngineMode } from '../../shared/ipc.js';
import type { AppState } from '../store.js';
import { shouldShowMockBadge } from '../store.js';
import type { BannerKey, BannerSeverity, Feedback, View } from './contracts.js';
import { el } from './dom.js';

/** How long a toast stays on screen. Long enough to read a sentence. */
const TOAST_MS = 6000;

/**
 * Electron rejects `ipcRenderer.invoke` with a message wrapped as
 * `Error invoking remote method 'chan': <Name>: <original>`. Strip the wrapper
 * so the engine's own (carefully worded) message — e.g. the ffmpeg-install
 * instructions or a plan-refusal reason — reaches the user intact.
 *
 * Pure and exported so the unwrapping is unit-tested rather than inspected by
 * eye in a running app, which is the only other way to see it.
 */
export function cleanErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const marker = "Error invoking remote method '";
  if (msg.startsWith(marker)) {
    const afterColon = msg.indexOf("': ");
    if (afterColon !== -1) {
      let rest = msg.slice(afterColon + 3);
      // Drop a leading "SomeError: " / "Error: " name prefix if present.
      const nameMatch = rest.match(/^[A-Za-z]*Error:\s*/);
      if (nameMatch) rest = rest.slice(nameMatch[0].length);
      return rest;
    }
  }
  return msg;
}

/**
 * Whether this engine mode is the SURPRISING one — we wanted the real engine and
 * got the mock.
 *
 * A deliberate `CASTGORILLA_MOCK=1` run is not surprising and gets the badge
 * alone; explaining a thing the user just asked for is noise. A fallback, on the
 * other hand, means nothing will ever reach a TV, and the reason string is the
 * only clue as to why.
 */
export function isEngineFallback(mode: EngineMode | null): boolean {
  return mode?.mock === true && mode.reason?.startsWith('real engine unavailable') === true;
}

export interface FeedbackView extends Feedback, View {
  /** Called with each engine-mode push, including the one at boot. */
  applyMode(mode: EngineMode | null): void;
}

export function mountFeedback(): FeedbackView {
  const bannerHost = el<HTMLElement>('banner');
  const toastHost = el<HTMLElement>('toasts');
  const modeBadge = el<HTMLSpanElement>('mode-badge');

  function setBanner(key: BannerKey, message: string, severity: BannerSeverity): void {
    let div = bannerHost.querySelector<HTMLDivElement>(`[data-key="${key}"]`);
    if (!div) {
      div = document.createElement('div');
      div.dataset.key = key;
      bannerHost.append(div);
    }
    div.className = `banner-item banner-item--${severity}`;
    div.textContent = message;
    bannerHost.hidden = false;
  }

  function clearBanner(key: BannerKey): void {
    const div = bannerHost.querySelector(`[data-key="${key}"]`);
    if (div) div.remove();
    if (bannerHost.childElementCount === 0) bannerHost.hidden = true;
  }

  function toast(message: string, isError = false): void {
    const div = document.createElement('div');
    div.className = isError ? 'toast toast--error' : 'toast';
    div.textContent = message;
    toastHost.append(div);
    setTimeout(() => div.remove(), TOAST_MS);
  }

  function applyMode(mode: EngineMode | null): void {
    if (isEngineFallback(mode) && mode?.reason) {
      setBanner('mode', `Running on the mock engine — ${mode.reason}`, 'warn');
    } else {
      clearBanner('mode');
    }
  }

  function render(state: Readonly<AppState>): void {
    // The badge shows for BOTH mock cases (deliberate override and fallback);
    // only the banner distinguishes them.
    modeBadge.hidden = !shouldShowMockBadge(state.mode);
    modeBadge.title = state.mode?.reason ?? '';
  }

  return { setBanner, clearBanner, toast, applyMode, render };
}
