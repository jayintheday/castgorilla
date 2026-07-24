/**
 * renderer-nav.test.ts — the breadcrumb stepper's page model.
 *
 * The stepper is PURE NAVIGATION over three pages (home › clip › playing). The
 * pages map onto two raw facts (a file is loaded, a session is active) but are
 * deliberately NOT those facts: if the view swap read the facts directly you
 * could never step back, because a live session would re-pin Playing every tick.
 * `deriveNavPage` is where that decoupling lives, so these tests pin the four
 * behaviours the design turns on:
 *
 *  1. AUTO-ADVANCE is EDGE-triggered — a stage that becomes NEWLY reachable pulls
 *     the page forward, but only on the tick of the rising edge.
 *  2. MANUAL BACK STICKS — once the user steps back, no later tick re-advances
 *     until another new edge fires. This is the property a level test would break.
 *  3. CLAMP DOWN — a page that stops being reachable (clip cleared, session ended)
 *     drops to the highest stage that still is.
 *  4. Boot is Home with no file/session.
 */

import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/renderer/store.js';
import type { SessionState } from '../src/shared/engine-types.js';
import {
  deriveNavPage,
  highestReachable,
  isReachable,
  navReach,
  type NavReach,
  type Page,
} from '../src/renderer/views/nav.js';

/** A reachability snapshot. `home` is always true. */
function reach(clip: boolean, playing: boolean): NavReach {
  return { home: true, clip, playing };
}

/** Build just enough of an AppState for navReach (it reads only file + status.state). */
function appState(file: string | null, sessionState: SessionState | undefined): AppState {
  return {
    file,
    status: sessionState ? { state: sessionState } : null,
  } as unknown as AppState;
}

describe('navReach', () => {
  it('reaches Home always, Clip iff a file is loaded, Playing iff a session is active', () => {
    expect(navReach(appState(null, undefined))).toEqual(reach(false, false));
    expect(navReach(appState('/movie.mkv', undefined))).toEqual(reach(true, false));
    expect(navReach(appState('/movie.mkv', 'playing'))).toEqual(reach(true, true));
  });

  it('treats a file that is still probing as Clip-reachable (file !== null, media pending)', () => {
    // state.file is set the instant a path is chosen, before the probe resolves.
    expect(navReach(appState('/movie.mkv', undefined)).clip).toBe(true);
  });

  it('counts only ACTIVE session states as Playing-reachable, not terminal ones', () => {
    expect(navReach(appState('/m.mkv', 'buffering')).playing).toBe(true);
    expect(navReach(appState('/m.mkv', 'paused')).playing).toBe(true);
    expect(navReach(appState('/m.mkv', 'reconnecting')).playing).toBe(true);
    // stopped / error are terminal — the session is over, so Playing is not reachable.
    expect(navReach(appState('/m.mkv', 'stopped')).playing).toBe(false);
    expect(navReach(appState('/m.mkv', 'error')).playing).toBe(false);
  });
});

describe('isReachable', () => {
  it('Home is reachable in every state', () => {
    expect(isReachable('home', reach(false, false))).toBe(true);
    expect(isReachable('home', reach(true, true))).toBe(true);
  });

  it('Clip needs a file, Playing needs an active session', () => {
    expect(isReachable('clip', reach(false, false))).toBe(false);
    expect(isReachable('clip', reach(true, false))).toBe(true);
    expect(isReachable('playing', reach(true, false))).toBe(false);
    expect(isReachable('playing', reach(true, true))).toBe(true);
  });
});

describe('highestReachable', () => {
  it('picks the furthest-along reachable stage — where a clamp-down lands', () => {
    expect(highestReachable(reach(false, false))).toBe('home');
    expect(highestReachable(reach(true, false))).toBe('clip');
    expect(highestReachable(reach(true, true))).toBe('playing');
  });
});

describe('deriveNavPage — auto-advance (edge-triggered)', () => {
  it('home → clip the tick a file loads', () => {
    expect(deriveNavPage('home', reach(false, false), reach(true, false))).toBe('clip');
  });

  it('clip → playing the tick a session becomes active', () => {
    expect(deriveNavPage('clip', reach(true, false), reach(true, true))).toBe('playing');
  });

  it('prefers the FURTHEST stage when two edges land on the same tick', () => {
    // Boot straight into a live session: both clip and playing rise at once.
    expect(deriveNavPage('home', reach(false, false), reach(true, true))).toBe('playing');
  });

  it('does NOT advance when the stage was ALREADY reachable last tick (no rising edge)', () => {
    // playing has been reachable for a while; the user is on Home. A level test
    // ("reach.playing → playing") would wrongly yank them to Playing here.
    expect(deriveNavPage('home', reach(true, true), reach(true, true))).toBe('home');
  });
});

describe('deriveNavPage — manual back sticks', () => {
  it('Home held mid-cast stays Home across a steady tick', () => {
    expect(deriveNavPage('home', reach(true, true), reach(true, true))).toBe('home');
  });

  it('Clip held mid-cast stays Clip across a steady tick', () => {
    expect(deriveNavPage('clip', reach(true, true), reach(true, true))).toBe('clip');
  });

  it('Clip held mid-cast survives the session ending (it is still reachable)', () => {
    // On Clip, watching the plan, when playback ends: stay on Clip, do not bounce.
    expect(deriveNavPage('clip', reach(true, true), reach(true, false))).toBe('clip');
  });
});

describe('deriveNavPage — clamp down', () => {
  it('playing → clip when the session ends but the file is still loaded', () => {
    expect(deriveNavPage('playing', reach(true, true), reach(true, false))).toBe('clip');
  });

  it('playing → home when both the session and the file are gone', () => {
    expect(deriveNavPage('playing', reach(true, true), reach(false, false))).toBe('home');
  });

  it('clip → home when the file is cleared', () => {
    expect(deriveNavPage('clip', reach(true, false), reach(false, false))).toBe('home');
  });
});

describe('deriveNavPage — steady state', () => {
  it('playing stays playing while nothing changes', () => {
    expect(deriveNavPage('playing', reach(true, true), reach(true, true))).toBe('playing');
  });

  it('home stays home on boot with no file and no session', () => {
    expect(deriveNavPage('home', reach(false, false), reach(false, false))).toBe('home');
  });
});

describe('deriveNavPage — full lifecycle threaded like the view does', () => {
  // Mirror mountNav's loop: carry `page` + `prevReach`, feed a sequence of reach
  // snapshots (and the occasional manual click), and assert the page at each step.
  function driver() {
    let page: Page = 'home';
    let prev: NavReach = { home: true, clip: false, playing: false };
    return {
      tick(next: NavReach): Page {
        page = deriveNavPage(page, prev, next);
        prev = next;
        return page;
      },
      click(target: Page): Page {
        // The view sets the remembered page and re-renders against unchanged reach.
        page = deriveNavPage(target, prev, prev);
        return page;
      },
      /**
       * Intentional file load (`NavView.goTo('clip')` from `loadPath`): set the
       * remembered page, then re-derive against the post-load reachability.
       * Distinct from `click` only in that the next reach snapshot may already
       * have changed (setFile ran first); for these tests they are equivalent.
       */
      goTo(target: Page, next: NavReach = prev): Page {
        page = deriveNavPage(target, prev, next);
        prev = next;
        return page;
      },
    };
  }

  it('drop → probe → cast → step Home → stop → clear returns cleanly to Home', () => {
    const nav = driver();

    // First render, nothing loaded.
    expect(nav.tick(reach(false, false))).toBe('home');
    // A file is dropped (still probing) → auto-advance to Clip.
    expect(nav.tick(reach(true, false))).toBe('clip');
    // Session goes active → auto-advance to Playing.
    expect(nav.tick(reach(true, true))).toBe('playing');
    // A steady playing tick holds.
    expect(nav.tick(reach(true, true))).toBe('playing');
    // User clicks Home mid-cast — pure navigation, the session is untouched.
    expect(nav.click('home')).toBe('home');
    // ...and Home STICKS across further playing ticks (no re-advance).
    expect(nav.tick(reach(true, true))).toBe('home');
    expect(nav.tick(reach(true, true))).toBe('home');
    // Playback stops (file still loaded). Home is still reachable, so it holds.
    expect(nav.tick(reach(true, false))).toBe('home');
    // File cleared. Still Home.
    expect(nav.tick(reach(false, false))).toBe('home');
  });

  it('re-advances on a NEW edge after a manual step back', () => {
    const nav = driver();
    expect(nav.tick(reach(true, false))).toBe('clip'); // file loaded
    expect(nav.click('home')).toBe('home'); // stepped back to Home
    expect(nav.tick(reach(true, false))).toBe('home'); // holds (no new edge)
    // Session now goes active — a fresh rising edge — so it advances to Playing.
    expect(nav.tick(reach(true, true))).toBe('playing');
  });

  it('a manual step to Clip while casting holds, then clamps to Home only when the clip clears', () => {
    const nav = driver();
    expect(nav.tick(reach(true, false))).toBe('clip');
    expect(nav.tick(reach(true, true))).toBe('playing');
    expect(nav.click('clip')).toBe('clip'); // step back to Clip mid-cast
    expect(nav.tick(reach(true, true))).toBe('clip'); // holds while casting
    expect(nav.tick(reach(true, false))).toBe('clip'); // session ended, clip stays
    expect(nav.tick(reach(false, false))).toBe('home'); // clip cleared → clamp home
  });

  it('stop → Home → drop another file advances to Clip via goTo (post-stop DnD bug)', () => {
    // Without goTo, deriveNavPage alone keeps Home: clip was already reachable,
    // so there is no rising edge, and Home always paints the empty drop face —
    // which is exactly the "drag and drop does nothing" report after a stop.
    const nav = driver();
    expect(nav.tick(reach(false, false))).toBe('home');
    expect(nav.tick(reach(true, false))).toBe('clip'); // first drop
    expect(nav.tick(reach(true, true))).toBe('playing'); // cast
    expect(nav.tick(reach(true, false))).toBe('clip'); // stop → clamp to clip
    expect(nav.click('home')).toBe('home'); // user steps Home; file still loaded
    expect(nav.tick(reach(true, false))).toBe('home'); // no edge — would stick forever
    // loadPath: setFile (clip still true) then goTo('clip') — must land on Clip.
    expect(nav.goTo('clip', reach(true, false))).toBe('clip');
  });
});
