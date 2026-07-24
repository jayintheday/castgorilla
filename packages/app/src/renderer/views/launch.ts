/**
 * launch.ts — `#play-primary`, the button this whole state exists for.
 *
 * It does exactly one thing: start a session. It is never a pause toggle and
 * never changes its icon, because the moment a session is live the player bar
 * rises and `#play-pause` there owns pause/resume/seek. Keeping the two apart is
 * why neither has to know about the other's state machine.
 *
 * The readiness rule is NOT duplicated here — `canStartSession()` in
 * `player-bar.ts` is the single definition of "everything the engine needs is
 * chosen and nothing is already running", and both buttons ask it. Two buttons
 * disagreeing about whether Play is available would be a genuinely confusing
 * bug, and the only way to guarantee they cannot is for there to be one answer.
 */

import type { AppState } from '../store.js';
import type { AppActions, View } from './contracts.js';
import { el } from './dom.js';
import { canStartSession, isActiveState } from './player-bar.js';

export interface LaunchFace {
  disabled: boolean;
  label: string;
}

/**
 * What `#play-primary` looks like.
 *
 * The `Casting` face matters more than it looks. Once a session is live this
 * button is disabled — `canStartSession()` is false for every active state — and
 * a large accent button that is simply greyed out with no explanation reads as
 * broken. Naming the reason costs one word.
 *
 * Everything else is deliberately left to say "Play". The device row already
 * owns the vocabulary for "still looking for devices" and states it carefully
 * (see `device-picker.ts`); a second control editorialising about discovery
 * would be two sources of truth for one fact.
 */
export function deriveLaunch(state: Readonly<AppState>): LaunchFace {
  if (isActiveState(state.status?.state)) return { disabled: true, label: 'Casting' };
  return { disabled: !canStartSession(state), label: 'Play' };
}

export interface LaunchDeps {
  actions: AppActions;
}

export function mountLaunch(deps: LaunchDeps): View {
  const { actions } = deps;

  const button = el<HTMLButtonElement>('play-primary');
  const label = el<HTMLSpanElement>('play-primary-label');

  button.addEventListener('click', () => actions.start());

  function render(state: Readonly<AppState>): void {
    const face = deriveLaunch(state);
    button.disabled = face.disabled;
    label.textContent = face.label;
    // The accessible name is the visible label plus the file, so a screen-reader
    // user gets the same confirmation the sighted user gets from the card above
    // ("Play My Movie…" rather than a bare "Play").
    button.setAttribute(
      'aria-label',
      state.media ? `${face.label} ${state.media.path.split('/').pop() ?? ''}`.trim() : face.label,
    );
  }

  return { render };
}
