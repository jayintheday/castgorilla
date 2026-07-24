/**
 * tray.ts — `#tray-toggle`, the drag-strip control that collapses the device
 * tray (the sidebar).
 *
 * This is the one piece of UI state that is NOT in the store: whether the tray
 * is open is a pure presentation concern with no bearing on what the engine
 * does, so it lives as a single class on `<body>` (`tray-collapsed`) and nowhere
 * else. Keeping it out of `AppState` keeps the store — and its tests — about
 * playback, not chrome.
 *
 * The default is EXPANDED on every launch (the class is simply absent in the
 * markup), so the first thing a user sees is the device list and they can pick a
 * device before a file is even chosen. It is deliberately NOT persisted: a tray
 * a previous session happened to leave closed should not hide the device list on
 * the next launch.
 *
 * `aria-expanded` describes the TRAY, not the button — true when the sidebar is
 * open. The collapse animation and the removal of the collapsed sidebar from the
 * tab order (via `visibility`) are entirely in CSS; this module only flips the
 * class and keeps the button's ARIA in step with it.
 */

import type { AppState } from '../store.js';
import type { View } from './contracts.js';
import { el } from './dom.js';

const COLLAPSED_CLASS = 'tray-collapsed';

export function mountTray(): View {
  const toggle = el<HTMLButtonElement>('tray-toggle');

  /** Reflect the body class onto the button's ARIA (expanded === NOT collapsed). */
  function syncAria(): void {
    const open = !document.body.classList.contains(COLLAPSED_CLASS);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle.addEventListener('click', () => {
    document.body.classList.toggle(COLLAPSED_CLASS);
    syncAria();
  });

  // `render` takes no state: the tray flag is not derived from AppState. It runs
  // on every store notification only to keep `aria-expanded` authoritative even
  // if the class were ever changed by something other than the click above.
  function render(): void {
    syncAria();
  }

  return { render };
}
