/**
 * tracks.ts — audio and subtitle selection, EVERYWHERE it appears.
 *
 * This view deliberately owns four selects and a button that live in three
 * different parts of the window: `#audio-track` / `#sub-track` in the setup
 * section, `#audio-track-mini` / `#sub-track-mini` in the player bar's settings
 * popover, and `#cc` in the player bar itself. Ownership follows the CONCERN,
 * not the layout — the element contract's requirement that the mini pickers can
 * "never show different lists" from the main ones is satisfied structurally
 * here, by there being exactly one builder and one place that applies it, rather
 * than by two views agreeing to stay in step.
 *
 * The subtitle list is the part with history. It prefers `plan.subtitles` over
 * the probed embedded tracks because the plan's entries are the authoritative
 * ones: each carries the `trackId` the device will actually fetch, matching
 * `session.selectSubtitleTrack` and `status.activeSubtitleTrackId`. The probed
 * list is the fallback for the mock/plan-less path, and the `Array.isArray`
 * guard is there because `plan.subtitles` may be absent from an older engine
 * `dist` — both are preserved from the previous build verbatim in effect.
 */

import type { MediaInfo, PlaybackPlan } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { AppActions, Feedback, View } from './contracts.js';
import type { OptionModel } from './dom.js';
import { applyOptions, el } from './dom.js';

/** The sentinel value for "no subtitles". Unchanged from the previous build. */
export const SUBTITLE_OFF = 'off';

// --- pure option models (unit-tested; no DOM) -------------------------------

/** `AAC 5.1 eng "Commentary"` — codec, layout, then whatever else is known. */
export function buildAudioOptions(media: MediaInfo): OptionModel[] {
  return media.audio.map((a) => {
    const lang = a.language ? ` ${a.language}` : '';
    const title = a.title ? ` "${a.title}"` : '';
    return {
      value: String(a.index),
      label: `${a.codec.toUpperCase()} ${a.channelLayout}${lang}${title}`,
    };
  });
}

/**
 * The subtitle list, always led by the `off` sentinel.
 *
 * Preference order (see the module header): the plan's resolved subtitle
 * entries, else the probed EMBEDDED TEXT tracks. Image-based subtitles
 * (`isText === false` — PGS, VobSub) are filtered out of the fallback because
 * nothing in the pipeline can turn them into WebVTT, so offering them would
 * produce a track that silently never appears.
 */
export function buildSubtitleOptions(
  media: MediaInfo,
  plan: PlaybackPlan | null,
): OptionModel[] {
  const off: OptionModel = { value: SUBTITLE_OFF, label: 'Off' };

  const planSubs = plan && Array.isArray(plan.subtitles) ? plan.subtitles : [];
  if (planSubs.length > 0) {
    return [
      off,
      ...planSubs.map((sub) => {
        const lang =
          sub.language && !sub.label.toLowerCase().includes(sub.language.toLowerCase())
            ? ` [${sub.language}]`
            : '';
        const src = sub.source === 'sidecar' ? ' (sidecar)' : '';
        return { value: String(sub.trackId), label: `${sub.label}${lang}${src}`.trim() };
      }),
    ];
  }

  return [
    off,
    ...media.subtitles
      .filter((sub) => sub.isText)
      .map((sub) => {
        const lang = sub.language ? ` ${sub.language}` : '';
        const title = sub.title ? ` "${sub.title}"` : '';
        return { value: String(sub.index), label: `${sub.codec}${lang}${title}` };
      }),
  ];
}

/** The selectable track ids from a built subtitle list (i.e. everything but `off`). */
export function subtitleTrackIds(options: readonly OptionModel[]): number[] {
  return options
    .filter((o) => o.value !== SUBTITLE_OFF)
    .map((o) => Number(o.value))
    .filter((n) => Number.isFinite(n));
}

/**
 * What `#cc` should switch to.
 *
 * A CC button is only useful if it can turn subtitles back ON, which means
 * remembering what was on before it turned them off — otherwise the second press
 * has nothing to restore and the control is one-way. The remembered track is
 * re-validated against what is currently available, because the file (and
 * therefore the track ids) can change underneath the memory.
 *
 * Returns `null` for "off", including the case where there is nothing to turn
 * on; the caller distinguishes that by the fact that `current` was already null.
 */
export function nextSubtitleSelection(
  current: number | null,
  remembered: number | null,
  available: readonly number[],
): number | null {
  if (current !== null) return null;
  if (remembered !== null && available.includes(remembered)) return remembered;
  return available[0] ?? null;
}

export interface SubtitleMemory {
  /** Record an observed selection. `null` (off) is ignored — that is the point. */
  remember(trackId: number | null): void;
  /** The remembered track, or null if none has been seen. */
  readonly last: number | null;
  /** `nextSubtitleSelection` against the remembered track, updating the memory. */
  toggle(current: number | null, available: readonly number[]): number | null;
}

export function createSubtitleMemory(): SubtitleMemory {
  let last: number | null = null;
  return {
    remember(trackId: number | null): void {
      if (trackId !== null) last = trackId;
    },
    get last(): number | null {
      return last;
    },
    toggle(current: number | null, available: readonly number[]): number | null {
      if (current !== null) last = current;
      return nextSubtitleSelection(current, last, available);
    },
  };
}

// --- the view ---------------------------------------------------------------

export interface TracksDeps {
  actions: AppActions;
  feedback: Feedback;
}

export function mountTracks(deps: TracksDeps): View {
  const { actions, feedback } = deps;

  const tracksSection = el<HTMLElement>('tracks');
  const audioSelect = el<HTMLSelectElement>('audio-track');
  const audioMini = el<HTMLSelectElement>('audio-track-mini');
  const subSelect = el<HTMLSelectElement>('sub-track');
  const subMini = el<HTMLSelectElement>('sub-track-mini');
  const ccButton = el<HTMLButtonElement>('cc');

  const memory = createSubtitleMemory();
  let availableSubs: number[] = [];
  let activeSub: number | null = null;

  /**
   * Mirror the value across a pair of selects immediately.
   *
   * The authoritative value arrives on the next status push and `render()` would
   * reconcile both anyway — but "anyway" is up to a second away, and a popover
   * showing a different track from the one behind it for that second reads as a
   * bug even though it resolves itself.
   */
  function mirror(from: HTMLSelectElement, to: HTMLSelectElement): void {
    if (to.value !== from.value) to.value = from.value;
  }

  function onAudioChange(source: HTMLSelectElement, other: HTMLSelectElement): void {
    mirror(source, other);
    const index = Number(source.value);
    if (!Number.isFinite(index)) return;
    actions.selectAudio(index);
  }

  function onSubChange(source: HTMLSelectElement, other: HTMLSelectElement): void {
    mirror(source, other);
    const trackId = source.value === SUBTITLE_OFF ? null : Number(source.value);
    if (trackId !== null && !Number.isFinite(trackId)) return;
    memory.remember(trackId);
    actions.selectSubtitle(trackId);
  }

  audioSelect.addEventListener('change', () => onAudioChange(audioSelect, audioMini));
  audioMini.addEventListener('change', () => onAudioChange(audioMini, audioSelect));
  subSelect.addEventListener('change', () => onSubChange(subSelect, subMini));
  subMini.addEventListener('change', () => onSubChange(subMini, subSelect));

  ccButton.addEventListener('click', () => {
    const next = memory.toggle(activeSub, availableSubs);
    if (next === null && activeSub === null) {
      feedback.toast('This file has no subtitle tracks.');
      return;
    }
    actions.selectSubtitle(next);
  });

  function render(state: Readonly<AppState>): void {
    // Same visibility rule as the previous build: the pickers appear once there
    // is both a probe result and a plan, because the plan is what decides which
    // subtitle tracks the device will be offered.
    tracksSection.hidden = !(state.media && state.plan);
    if (!state.media) {
      availableSubs = [];
      activeSub = null;
      ccButton.disabled = true;
      ccButton.setAttribute('aria-pressed', 'false');
      return;
    }

    const audioOptions = buildAudioOptions(state.media);
    const active = state.status?.activeAudioStreamIndex ?? state.plan?.audioStreamIndex;
    const audioValue = active === undefined ? null : String(active);
    applyOptions(audioSelect, audioOptions, audioValue);
    applyOptions(audioMini, audioOptions, audioValue);

    const subOptions = buildSubtitleOptions(state.media, state.plan);
    availableSubs = subtitleTrackIds(subOptions);
    activeSub = state.status?.activeSubtitleTrackId ?? null;
    const subValue = activeSub === null ? SUBTITLE_OFF : String(activeSub);
    applyOptions(subSelect, subOptions, subValue);
    applyOptions(subMini, subOptions, subValue);

    // Whatever the engine says is on is worth restoring later, however it got on.
    memory.remember(activeSub);

    ccButton.disabled = availableSubs.length === 0;
    // aria-pressed IS the state signal (section B) — the accent ring keys off it,
    // so assistive tech and the stylesheet read the same attribute.
    ccButton.setAttribute('aria-pressed', String(activeSub !== null));
    ccButton.setAttribute(
      'aria-label',
      activeSub !== null ? 'Turn subtitles off' : 'Turn subtitles on',
    );
  }

  return { render };
}
