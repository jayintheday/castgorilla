/**
 * nav.ts — `#nav`, the breadcrumb stepper in the title bar (Home › Clip › Now
 * Playing) and the `body[data-page]` attribute it drives.
 *
 * The stepper is PURE NAVIGATION. Clicking a step never touches the engine — it
 * does not stop the cast (Stop does) and does not clear the clip (the file card's
 * X does). It only changes which of the three pages the Mac window shows, so you
 * can glance at the drop zone (Home) or the plan (Clip) while a cast keeps
 * running on the TV. The X and Stop still do what they always did.
 *
 * WHY A SEPARATE `page` MODEL. The three pages map to three raw facts — a file is
 * loaded, a session is active — but they are NOT the facts. If the view swap read
 * the facts directly you could never navigate back: the instant a session went
 * active the window would jump to Playing and stay pinned there. So `page` is an
 * explicit remembered value that AUTO-ADVANCES when a stage becomes newly
 * reachable (edge-triggered) yet STICKS when the user steps back, and only CLAMPS
 * down when the page it is on stops being reachable (the clip is cleared, or the
 * session ends). All of that lives in the pure `deriveNavPage` below so it can be
 * unit-tested without a DOM — the same shape `deriveDeviceState` / `derivePrimary`
 * use elsewhere.
 *
 * `page` is view state, not store state — like the tray's collapsed bit. No view
 * renders it into AppState and the engine has no opinion about it, so it lives in
 * this closure and on `body[data-page]`, nowhere else. The one state change with
 * no store event behind it (the user clicking a step) is pushed back through
 * `requestRender()`, exactly as the device picker's grace timer is.
 */

import type { AppState } from '../store.js';
import type { View } from './contracts.js';
import { el } from './dom.js';
import { isActiveState } from './player-bar.js';

/** The three pages, low to high. Also the `data-page` values and each step's `data-page`. */
export type Page = 'home' | 'clip' | 'playing';

/**
 * Which stages are reachable right now. `home` is always true (it is only carried
 * for symmetry and so `isReachable` needs no special case); `clip` and `playing`
 * are the two that actually gate.
 */
export interface NavReach {
  home: boolean;
  clip: boolean;
  playing: boolean;
}

/**
 * Reachability derived from the raw facts:
 *  - `clip`    — a file is loaded (`state.file !== null`, which is true while it
 *                is still probing, so the Clip page appears the instant you drop).
 *  - `playing` — a session is in an active state (the same predicate that gates
 *                the transport controls).
 */
export function navReach(state: Readonly<AppState>): NavReach {
  return {
    home: true,
    clip: state.file !== null,
    playing: isActiveState(state.status?.state),
  };
}

/** Whether a page can be shown, given current reachability. */
export function isReachable(page: Page, reach: NavReach): boolean {
  switch (page) {
    case 'home':
      return true;
    case 'clip':
      return reach.clip;
    case 'playing':
      return reach.playing;
    default: {
      const exhaustive: never = page;
      return exhaustive;
    }
  }
}

/** The furthest-along page currently reachable — where a clamp-down lands. */
export function highestReachable(reach: NavReach): Page {
  if (reach.playing) return 'playing';
  if (reach.clip) return 'clip';
  return 'home';
}

/**
 * The page to show next, given the page we are on, the reachability from the
 * previous render, and the reachability now.
 *
 * The three rules, in order:
 *  1. AUTO-ADVANCE (edge-triggered). The instant a higher stage becomes NEWLY
 *     reachable — reachable now, not reachable last render — jump to it. Checking
 *     `playing` before `clip` means that if two edges ever land on the same tick
 *     (a boot straight into a live session), the furthest stage wins. Edge-, not
 *     level-triggered is the whole trick: a level test (`reach.playing → playing`)
 *     would re-pin Playing on every subsequent tick and manual-back could never
 *     stick.
 *  2. CLAMP DOWN. No new edge, but the page we are on is no longer reachable (the
 *     clip was cleared, or the session ended) — drop to the highest stage that
 *     still is.
 *  3. STICK. Otherwise keep the current page. This is what makes a manual step
 *     back hold: once the user is on Home mid-cast, every later tick sees no new
 *     edge and Home still reachable, so Home stays until another NEW edge fires.
 *
 * Pure: `current` is the remembered page, `prev`/`reach` are the two reachability
 * snapshots. No DOM, no clock.
 */
export function deriveNavPage(current: Page, prev: NavReach, reach: NavReach): Page {
  // 1. Auto-advance on a newly-reachable stage, furthest first.
  if (reach.playing && !prev.playing) return 'playing';
  if (reach.clip && !prev.clip) return 'clip';

  // 2. Clamp down if the current page fell out of reach.
  if (!isReachable(current, reach)) return highestReachable(reach);

  // 3. Otherwise the current page sticks.
  return current;
}

export interface NavDeps {
  /**
   * Ask for a re-render. A step click is the one state change here that no store
   * event corresponds to (the page lives in this closure, not the store), so the
   * click updates `page` and pokes the render loop — mirroring how the device
   * picker drives its grace-timer render.
   */
  requestRender(): void;
}

export function mountNav(deps: NavDeps): View {
  const { requestRender } = deps;

  const homeBtn = el<HTMLButtonElement>('nav-home');
  const clipBtn = el<HTMLButtonElement>('nav-clip');
  const playingBtn = el<HTMLButtonElement>('nav-playing');

  const steps: ReadonlyArray<readonly [HTMLButtonElement, Page]> = [
    [homeBtn, 'home'],
    [clipBtn, 'clip'],
    [playingBtn, 'playing'],
  ];

  /** The remembered page. Starts at Home; a file/session already present at boot auto-advances it. */
  let page: Page = 'home';
  /**
   * Reachability from the previous render, for the edge test. Seeded with clip
   * and playing FALSE so a file or session that is somehow already present on the
   * very first render reads as a rising edge and auto-advances (the desired
   * behaviour if the app ever boots straight into a live session).
   */
  let prevReach: NavReach = { home: true, clip: false, playing: false };

  for (const [button, target] of steps) {
    button.addEventListener('click', () => {
      // A disabled (unreachable) button never fires this, so the set is safe;
      // deriveNavPage's clamp-down is the belt-and-braces if one ever did.
      page = target;
      requestRender();
    });
  }

  function render(state: Readonly<AppState>): void {
    const reach = navReach(state);
    page = deriveNavPage(page, prevReach, reach);
    prevReach = reach;

    document.body.dataset.page = page;

    for (const [button, target] of steps) {
      button.disabled = !isReachable(target, reach);
      if (target === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  return { render };
}
