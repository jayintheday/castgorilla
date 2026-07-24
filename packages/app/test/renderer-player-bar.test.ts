/**
 * renderer-player-bar.test.ts — the transport derivation and the scrubber maths.
 *
 * `derivePrimary` matters most. Merging `#play` and `#pause` into one button
 * means a single function now decides whether the app can pause AT ALL: there is
 * no second control to fall back on if the `playing` branch is ever dropped. The
 * three-way split (playing → pause, paused → resume, otherwise → start) is what
 * makes the merge lossless, so it is pinned here state by state.
 *
 * The seek maths is tested for a specific class of input: the degenerate one. A
 * duration of 0 is the normal state of the app before a probe returns, and
 * `position / 0` is `Infinity`, which reaches the DOM as `--progress: Infinity%`
 * and a slider value of `"Infinity"`.
 */

import { describe, expect, it } from 'vitest';
import type { MediaInfo, SessionState, SessionStatus } from '../src/shared/engine-types.js';
import type { AppState } from '../src/renderer/store.js';
import {
  ACTIVE_STATES,
  SEEK_MAX,
  VOLUME_SETTLE_MS,
  VOLUME_THROTTLE_MS,
  canStartSession,
  derivePrimary,
  isActiveState,
  planVolumeSend,
  positionFromSlider,
  progressPercent,
  scrubberHover,
  shouldAcceptEngineVolume,
  sliderFromPosition,
  volumeIconHref,
} from '../src/renderer/views/player-bar.js';
import { volumeLevel } from '../src/renderer/media-format.js';

const ALL_STATES: SessionState[] = [
  'probing',
  'planning',
  'preparing',
  'connecting',
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
  'reconnecting',
  'stopped',
  'error',
];

// --- active states ----------------------------------------------------------

describe('ACTIVE_STATES', () => {
  it('excludes exactly the two terminal states', () => {
    const inactive = ALL_STATES.filter((s) => !ACTIVE_STATES.has(s));
    expect(inactive).toEqual(['stopped', 'error']);
  });

  it('treats "no session yet" as inactive', () => {
    expect(isActiveState(undefined)).toBe(false);
  });

  it('covers every non-terminal state', () => {
    for (const state of ALL_STATES) {
      if (state === 'stopped' || state === 'error') continue;
      expect(isActiveState(state)).toBe(true);
    }
  });
});

// --- the primary button -----------------------------------------------------

describe('derivePrimary', () => {
  it('offers PAUSE while playing — without this branch the app cannot pause at all', () => {
    // #pause no longer exists, so this is the only route to a pause command.
    expect(derivePrimary('playing', false)).toEqual({
      action: 'pause',
      disabled: false,
      icon: '#icon-pause',
      label: 'Pause',
    });
  });

  it('offers RESUME while paused', () => {
    expect(derivePrimary('paused', false)).toEqual({
      action: 'resume',
      disabled: false,
      icon: '#icon-play',
      label: 'Play',
    });
  });

  it('offers START when idle and everything is chosen', () => {
    expect(derivePrimary(undefined, true)).toEqual({
      action: 'start',
      disabled: false,
      icon: '#icon-play',
      label: 'Play',
    });
  });

  it('is disabled and inert when idle with nothing chosen', () => {
    const face = derivePrimary(undefined, false);
    expect(face.action).toBeNull();
    expect(face.disabled).toBe(true);
  });

  it('shows the ACTION, not the state — the icon and label always agree', () => {
    for (const state of ALL_STATES) {
      const face = derivePrimary(state, true);
      expect(face.icon).toBe(face.label === 'Pause' ? '#icon-pause' : '#icon-play');
    }
  });

  it('never enables the button with no action attached', () => {
    for (const state of [...ALL_STATES, undefined]) {
      for (const canStart of [true, false]) {
        const face = derivePrimary(state, canStart);
        if (!face.disabled) expect(face.action).not.toBeNull();
        if (face.action === null) expect(face.disabled).toBe(true);
      }
    }
  });

  it('stays disabled mid-startup — a second LOAD into a connecting session is not wanted', () => {
    // canStart is false during any active state (see canStartSession), so these
    // reduce to the inert case.
    for (const state of ['connecting', 'loading', 'buffering', 'seeking'] as const) {
      expect(derivePrimary(state, false).disabled).toBe(true);
    }
  });

  it('offers a fresh start after a session has stopped or failed', () => {
    expect(derivePrimary('stopped', true).action).toBe('start');
    expect(derivePrimary('error', true).action).toBe('start');
  });
});

describe('canStartSession', () => {
  function state(over: Partial<AppState> = {}): AppState {
    return {
      mode: null,
      devices: [],
      selectedDeviceId: 'dev-1',
      file: '/x/clip.mkv',
      media: { path: '/x/clip.mkv' } as unknown as MediaInfo,
      probing: false,
      plan: { tier: 'direct' } as unknown as AppState['plan'],
      prefs: { surround: false, hdrPolicy: 'warn' },
      status: null,
      positionBaseSec: 0,
      positionBaseAt: 0,
      warnings: [],
      recents: [],
      ...over,
    };
  }

  it('needs media, a plan and a device', () => {
    expect(canStartSession(state())).toBe(true);
    expect(canStartSession(state({ media: null }))).toBe(false);
    expect(canStartSession(state({ plan: null }))).toBe(false);
    expect(canStartSession(state({ selectedDeviceId: null }))).toBe(false);
  });

  it('is false while a session is already active', () => {
    const active = { state: 'playing' } as unknown as SessionStatus;
    expect(canStartSession(state({ status: active }))).toBe(false);
  });

  it('is true again once the session has stopped', () => {
    const stopped = { state: 'stopped' } as unknown as SessionStatus;
    expect(canStartSession(state({ status: stopped }))).toBe(true);
  });

  it('is false when a plan refusal cleared the plan (Play must stay disabled)', () => {
    expect(canStartSession(state({ plan: null }))).toBe(false);
  });
});

// --- scrubber maths ---------------------------------------------------------

describe('progressPercent', () => {
  it('converts a position to a percentage', () => {
    expect(progressPercent(0, 100)).toBe(0);
    expect(progressPercent(25, 100)).toBe(25);
    expect(progressPercent(100, 100)).toBe(100);
  });

  it('returns 0 rather than Infinity for an unknown duration', () => {
    // This is the state of the app for the whole window before a probe returns.
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(10, Number.NaN)).toBe(0);
    expect(progressPercent(10, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clamps beyond the ends', () => {
    expect(progressPercent(-5, 100)).toBe(0);
    expect(progressPercent(500, 100)).toBe(100);
  });

  it('returns 0 for a non-finite position', () => {
    expect(progressPercent(Number.NaN, 100)).toBe(0);
  });
});

describe('sliderFromPosition / positionFromSlider', () => {
  it('maps across the contract range of 0..1000', () => {
    expect(SEEK_MAX).toBe(1000);
    expect(sliderFromPosition(0, 200)).toBe(0);
    expect(sliderFromPosition(100, 200)).toBe(500);
    expect(sliderFromPosition(200, 200)).toBe(1000);
  });

  it('yields an integer, because the input has step=1', () => {
    for (const pos of [1, 7, 33.3, 99.9]) {
      expect(Number.isInteger(sliderFromPosition(pos, 187))).toBe(true);
    }
  });

  it('round-trips within one step', () => {
    const duration = 6628; // a real 1:50:28 episode
    for (const pos of [0, 1, 570.25, 3600, 6628]) {
      const back = positionFromSlider(sliderFromPosition(pos, duration), duration);
      expect(Math.abs(back - pos)).toBeLessThanOrEqual(duration / SEEK_MAX);
    }
  });

  it('collapses to 0 for an unknown duration in both directions', () => {
    expect(sliderFromPosition(30, 0)).toBe(0);
    expect(positionFromSlider(500, 0)).toBe(0);
    expect(sliderFromPosition(30, Number.NaN)).toBe(0);
  });

  it('clamps out-of-range values', () => {
    expect(sliderFromPosition(-10, 100)).toBe(0);
    expect(sliderFromPosition(1000, 100)).toBe(1000);
    expect(positionFromSlider(-50, 100)).toBe(0);
    expect(positionFromSlider(5000, 100)).toBe(100);
  });
});

describe('scrubberHover', () => {
  const rect = { left: 100, width: 400 };

  it('positions the tooltip under the pointer, relative to the scrubber', () => {
    expect(scrubberHover(100, rect, 200)).toEqual({ leftPx: 0, seconds: 0 });
    expect(scrubberHover(300, rect, 200)).toEqual({ leftPx: 200, seconds: 100 });
    expect(scrubberHover(500, rect, 200)).toEqual({ leftPx: 400, seconds: 200 });
  });

  it('clamps a pointer that has slid past either end', () => {
    // Happens constantly at the moment of release; without the clamp the tooltip
    // parks outside the window and reports a negative time.
    expect(scrubberHover(0, rect, 200)).toEqual({ leftPx: 0, seconds: 0 });
    expect(scrubberHover(9999, rect, 200)).toEqual({ leftPx: 400, seconds: 200 });
  });

  it('reports 0s with an unknown duration rather than NaN', () => {
    expect(scrubberHover(300, rect, 0).seconds).toBe(0);
    expect(scrubberHover(300, rect, Number.NaN).seconds).toBe(0);
  });

  it('survives a zero-width scrubber (a hidden or not-yet-laid-out bar)', () => {
    expect(scrubberHover(50, { left: 0, width: 0 }, 200)).toEqual({
      leftPx: 0,
      seconds: 0,
    });
  });
});

// --- volume -----------------------------------------------------------------

describe('volumeIconHref', () => {
  it('maps the three bands onto the three sprite symbols in the contract', () => {
    expect(volumeIconHref('muted')).toBe('#icon-volume-muted');
    expect(volumeIconHref('low')).toBe('#icon-volume-low');
    expect(volumeIconHref('high')).toBe('#icon-volume-high');
  });

  it('produces a valid symbol for every value volumeLevel can return', () => {
    const symbols = new Set([
      '#icon-volume-muted',
      '#icon-volume-low',
      '#icon-volume-high',
    ]);
    for (const volume of [0, 0.01, 0.49, 0.5, 0.99, 1, Number.NaN]) {
      for (const muted of [true, false]) {
        expect(symbols.has(volumeIconHref(volumeLevel(volume, muted)))).toBe(true);
      }
    }
  });
});

// --- volume throttle (planVolumeSend) ---------------------------------------
//
// The bug: `#volume-bar`'s `input` handler sent a Cast command on EVERY input
// event — dozens per drag — flooding the receiver's RECEIVER channel. That burst
// made the slider feel unresponsive/"not representative" and destabilised the
// live session (the trigger behind the casting view blanking). This is the pure
// half of the fix: cap the outbound rate to one send per window, leading, with a
// trailing fallback; the view sends the authoritative final value on release.

describe('planVolumeSend', () => {
  it('sends immediately from a never-sent baseline', () => {
    expect(planVolumeSend(Number.NEGATIVE_INFINITY, 0)).toEqual({
      send: true,
      scheduleInMs: 0,
    });
  });

  it('sends (leading edge) once the throttle window has elapsed', () => {
    expect(planVolumeSend(0, VOLUME_THROTTLE_MS)).toEqual({ send: true, scheduleInMs: 0 });
    expect(planVolumeSend(0, VOLUME_THROTTLE_MS + 50)).toEqual({
      send: true,
      scheduleInMs: 0,
    });
  });

  it('defers a value that lands inside the window, scheduling the remainder', () => {
    // A fast drag: last send at t=0, this input at t=40 → hold, retry in 90ms.
    expect(planVolumeSend(0, 40)).toEqual({
      send: false,
      scheduleInMs: VOLUME_THROTTLE_MS - 40,
    });
  });

  it('never asks for a negative delay (clock wobble / same instant)', () => {
    expect(planVolumeSend(100, 100)).toEqual({
      send: false,
      scheduleInMs: VOLUME_THROTTLE_MS,
    });
    expect(planVolumeSend(100, 90).scheduleInMs).toBeGreaterThanOrEqual(0);
  });

  it('caps a fast drag to roughly one send per window', () => {
    // Simulate 60 inputs over ~1s (an ~16ms cadence). Count leading sends plus
    // the trailing sends the caller would fire when a scheduled window expires.
    let lastSent = Number.NEGATIVE_INFINITY;
    let pending = false;
    let sends = 0;
    for (let t = 0; t <= 1000; t += 16) {
      const plan = planVolumeSend(lastSent, t);
      if (plan.send) {
        sends += 1;
        lastSent = t;
        pending = false;
      } else {
        pending = true; // a trailing send is now owed
      }
    }
    if (pending) sends += 1; // the final trailing flush
    // 60 raw inputs collapse to about ceil(1000/130) ≈ 8 — an order of magnitude
    // fewer commands, never one-per-pixel.
    expect(sends).toBeLessThanOrEqual(10);
    expect(sends).toBeGreaterThanOrEqual(6);
  });
});

// --- volume reconcile (shouldAcceptEngineVolume) ----------------------------
//
// The engine pushes an authoritative (lagged, quantised) volume at ~1Hz. Writing
// it onto the slider mid-gesture snaps the thumb backwards. This gates that: the
// user's position wins during a drag and for a short settle window after, then
// the engine is trusted again. Time-based, NOT `activeElement === bar`, because a
// range input keeps focus after release and would block reconcile forever.

describe('shouldAcceptEngineVolume', () => {
  it('never accepts while the user is dragging', () => {
    expect(shouldAcceptEngineVolume(true, 1000, 1000)).toBe(false);
    expect(shouldAcceptEngineVolume(true, 1000, 1_000_000)).toBe(false);
  });

  it('holds the user position through the settle window after release', () => {
    const released = 1000;
    expect(shouldAcceptEngineVolume(false, released, released + 100)).toBe(false);
    expect(shouldAcceptEngineVolume(false, released, released + VOLUME_SETTLE_MS - 1)).toBe(
      false,
    );
  });

  it('reconciles to the engine once idle past the settle window', () => {
    const released = 1000;
    expect(shouldAcceptEngineVolume(false, released, released + VOLUME_SETTLE_MS)).toBe(true);
    expect(shouldAcceptEngineVolume(false, released, released + 5000)).toBe(true);
  });

  it('accepts immediately from an untouched baseline, so the first status paints', () => {
    expect(shouldAcceptEngineVolume(false, Number.NEGATIVE_INFINITY, 0)).toBe(true);
  });
});
