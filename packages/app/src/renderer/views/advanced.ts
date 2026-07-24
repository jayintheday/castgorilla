/**
 * advanced.ts — the `<details id="advanced">` body: the two preferences that
 * trigger a replan, and the technical plan they produce.
 *
 * `#advanced` itself needs no wiring at all. It is a native `<details>`, so the
 * UA owns open/closed, the keyboard interaction and the ARIA — which is the
 * whole reason the markup uses one.
 *
 * One deliberate change from the previous build is documented at `#options`
 * below.
 */

import { formatPlanSummary } from '../plan-format.js';
import type { HdrOutcome } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { AppActions, View } from './contracts.js';
import { el } from './dom.js';

/**
 * The HDR badge's text and colour per outcome.
 *
 * Still inline `style.color` / `style.borderColor`, which the element contract
 * permits while noting a modifier class would be nicer. It stays inline because
 * the stylesheet defines exactly one badge modifier (`.badge--mock`) and adding
 * `.badge--error` / `--warn` / `--ok` would mean editing `styles/base.css`,
 * which is out of scope for this wave. Flagged rather than fudged.
 *
 * A `Record` over the frozen `HdrOutcome` union means a new outcome upstream is
 * a compile error here instead of an unlabelled badge.
 */
const HDR_BADGE: Record<HdrOutcome, { text: string; color: string }> = {
  refused: { text: 'HDR refused', color: 'var(--error)' },
  'washed-out-warning': { text: 'HDR → SDR', color: 'var(--warn)' },
  preserved: { text: 'HDR preserved', color: 'var(--tier-direct)' },
};

export interface AdvancedDeps {
  actions: AppActions;
}

export function mountAdvanced(deps: AdvancedDeps): View {
  const { actions } = deps;

  const options = el<HTMLElement>('options');
  const surround = el<HTMLInputElement>('surround');
  const hdrPolicy = el<HTMLSelectElement>('hdr-policy');
  const planSection = el<HTMLElement>('plan-section');
  const planSummary = el<HTMLSpanElement>('plan-summary');
  const hdrBadge = el<HTMLSpanElement>('hdr-badge');
  const reasonsList = el<HTMLUListElement>('reasons-list');

  surround.addEventListener('change', () => actions.setSurround(surround.checked));
  hdrPolicy.addEventListener('change', () => {
    actions.setHdrPolicy(hdrPolicy.value === 'block' ? 'block' : 'warn');
  });

  function render(state: Readonly<AppState>): void {
    // CHANGED FROM THE PREVIOUS BUILD, deliberately: `#options` used to be hidden
    // unless there was a PLAN. But a refused plan sets `plan = null` — so the two
    // controls that could rescue the refusal (turning HDR policy back to "warn",
    // turning surround off) were hidden by the very failure they fix. Gating on
    // `media` instead keeps them reachable exactly when they are needed.
    options.hidden = state.media === null;

    if (!state.plan || !state.media) {
      planSection.hidden = true;
      // Reflect prefs even with no plan — see above.
      surround.checked = state.prefs.surround;
      hdrPolicy.value = state.prefs.hdrPolicy;
      return;
    }

    planSection.hidden = false;

    const summary = formatPlanSummary(state.plan, state.media);
    planSummary.textContent = summary.text;
    planSummary.dataset.tier = summary.tier;

    // Widened on purpose: `hdrOutcome` arrives over IPC from an engine `dist`
    // that is not necessarily the one these types were built against, so an
    // unknown value should blank the badge rather than print `undefined`.
    const badge: { text: string; color: string } | undefined =
      HDR_BADGE[state.plan.hdrOutcome];
    if (badge) {
      hdrBadge.hidden = false;
      hdrBadge.textContent = badge.text;
      hdrBadge.style.color = badge.color;
      hdrBadge.style.borderColor = badge.color;
    } else {
      hdrBadge.hidden = true;
    }

    reasonsList.replaceChildren(
      ...state.plan.reasons.map((reason) => {
        const li = document.createElement('li');
        li.textContent = reason;
        return li;
      }),
    );

    surround.checked = state.prefs.surround;
    hdrPolicy.value = state.prefs.hdrPolicy;
  }

  return { render };
}
