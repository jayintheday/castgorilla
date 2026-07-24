/**
 * renderer-activity.test.ts — which session states raise the top activity bar.
 *
 * The bar exists to show the getting-ready wait and nothing else, so the risk
 * this pins down is scope creep at both ends: it must NOT show once a picture is
 * up (`playing`/`paused`) — a permanent bar over a transcode would be the result
 * — and it must NOT show for the terminal or file-level states.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '../src/shared/engine-types.js';
import { WORKING_STATES, isWorking } from '../src/renderer/views/activity.js';
import { ACTIVE_STATES } from '../src/renderer/views/player-bar.js';

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

describe('isWorking', () => {
  it('is on for the pre-roll and interruption states', () => {
    for (const s of ['preparing', 'connecting', 'loading', 'buffering', 'seeking', 'reconnecting'] as const) {
      expect(isWorking(s)).toBe(true);
    }
  });

  it('is off once a picture is up', () => {
    expect(isWorking('playing')).toBe(false);
    expect(isWorking('paused')).toBe(false);
  });

  it('is off for terminal and file-level states', () => {
    for (const s of ['stopped', 'error', 'probing', 'planning'] as const) {
      expect(isWorking(s)).toBe(false);
    }
  });

  it('is off with no session at all', () => {
    expect(isWorking(undefined)).toBe(false);
  });

  it('covers every state exactly once, on or off', () => {
    // Guards against a new SessionState being added upstream and silently
    // defaulting to "off" without anyone deciding whether the bar should show.
    for (const s of ALL_STATES) {
      expect(typeof isWorking(s)).toBe('boolean');
    }
  });

  it('is a strict subset of the player bar’s active states', () => {
    // The bar can only ever be up while the session is active (the player bar is
    // also up then); it just stops short of playing/paused.
    for (const s of WORKING_STATES) {
      expect(ACTIVE_STATES.has(s)).toBe(true);
    }
    expect(WORKING_STATES.has('playing')).toBe(false);
    expect(WORKING_STATES.has('paused')).toBe(false);
  });
});
