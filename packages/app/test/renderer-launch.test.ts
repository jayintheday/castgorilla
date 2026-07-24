/**
 * renderer-launch.test.ts — `#play-primary`, the loaded state's one action.
 *
 * The property worth pinning is that this button and `#play-pause` can never
 * disagree about whether Play is available, because both derive from the single
 * `canStartSession()`. The "Casting" label is tested for a reason that is easy
 * to lose in a refactor: while a session is live this button is disabled, and a
 * large accent button greyed out with no explanation reads as broken.
 */

import { describe, expect, it } from 'vitest';
import type { MediaInfo, SessionState, SessionStatus } from '../src/shared/engine-types.js';
import type { AppState } from '../src/renderer/store.js';
import { deriveLaunch } from '../src/renderer/views/launch.js';
import { ACTIVE_STATES, canStartSession } from '../src/renderer/views/player-bar.js';

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

function withState(sessionState: SessionState): AppState {
  return state({ status: { state: sessionState } as unknown as SessionStatus });
}

describe('deriveLaunch', () => {
  it('is enabled and says Play when everything is chosen', () => {
    expect(deriveLaunch(state())).toEqual({ disabled: false, label: 'Play' });
  });

  it('is disabled without a device', () => {
    expect(deriveLaunch(state({ selectedDeviceId: null })).disabled).toBe(true);
  });

  it('is disabled without a plan', () => {
    expect(deriveLaunch(state({ plan: null })).disabled).toBe(true);
  });

  it('is disabled without media', () => {
    expect(deriveLaunch(state({ media: null })).disabled).toBe(true);
  });

  it('says Play, not Casting, before anything starts', () => {
    // The disabled-but-ready case must not borrow the live session's wording.
    expect(deriveLaunch(state({ media: null })).label).toBe('Play');
  });

  it('reads Casting and is disabled in every active state', () => {
    for (const sessionState of ACTIVE_STATES) {
      expect(deriveLaunch(withState(sessionState))).toEqual({
        disabled: true,
        label: 'Casting',
      });
    }
  });

  it('offers Play again once a session is over', () => {
    // `stopped` and `error` are terminal and deliberately NOT active states, so
    // the bar drops and this button takes the action back.
    for (const sessionState of ['stopped', 'error'] as const) {
      expect(deriveLaunch(withState(sessionState))).toEqual({
        disabled: false,
        label: 'Play',
      });
    }
  });

  it('never disagrees with canStartSession', () => {
    const cases: AppState[] = [
      state(),
      state({ media: null }),
      state({ plan: null }),
      state({ selectedDeviceId: null }),
      ...[...ACTIVE_STATES].map(withState),
      withState('stopped'),
      withState('error'),
    ];
    for (const s of cases) {
      expect(deriveLaunch(s).disabled).toBe(!canStartSession(s));
    }
  });
});
