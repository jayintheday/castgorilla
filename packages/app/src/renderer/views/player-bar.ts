/**
 * player-bar.ts — the fixed footer: transport, scrubber, times, status line,
 * volume, and the settings popover.
 *
 * (The `#cc` button and the popover's two mini selects live in `views/tracks.ts`
 * — ownership follows the concern, not the layout. This view opens and closes
 * the popover; it never looks inside it.)
 *
 * Two things worth reading before changing anything here.
 *
 * THE SEEKING GUARD. `input` fires continuously while the thumb is dragged;
 * `change` fires once when it is released. Only `change` commits. This is not a
 * nicety — every `input` would otherwise be a real seek, and a seek restarts the
 * ffmpeg process at a new keyframe. CLAUDE.md documents what that storm looks
 * like from the engine's side (dozens of abandoned in-flight segment requests,
 * `SupersededError`, 75 error lines in one short session); the guard is the
 * renderer's half of not causing it. While `seeking` is true the rAF loop leaves
 * the bar alone so the thumb does not fight the interpolated position.
 *
 * THE --progress PROPERTY. The filled part of both sliders is painted by a CSS
 * gradient stop, NOT by the native `value`. They are separate and both must be
 * set, every frame for the seek bar. Miss it and the seek bar renders
 * permanently empty while the thumb moves over it (and the volume bar renders
 * permanently full) — see section D of the element contract.
 */

import { castingStatusDetail, volumeLevel } from '../media-format.js';
import { formatTime } from '../plan-format.js';
import type { SessionState } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { AppActions, View } from './contracts.js';
import { el, setProgress } from './dom.js';

/**
 * The states in which a session exists and the transport should be live.
 *
 * Carried over unchanged. Note what is NOT in it: `stopped` and `error`, which
 * are terminal — a session in either is over, so Stop is pointless and the
 * primary button should offer to start a new one.
 */
export const ACTIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
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
]);

export function isActiveState(state: SessionState | undefined): boolean {
  return state !== undefined && ACTIVE_STATES.has(state);
}

/** `#seek-bar`'s `max`, fixed by the element contract. */
export const SEEK_MAX = 1000;

// --- the primary button -----------------------------------------------------

export type PrimaryAction = 'start' | 'resume' | 'pause';

export interface PrimaryFace {
  /** What a click does, or null when the button is inert. */
  action: PrimaryAction | null;
  disabled: boolean;
  /** `href` for `#play-pause-icon`. */
  icon: '#icon-play' | '#icon-pause';
  /** `aria-label` for `#play-pause`. */
  label: 'Play' | 'Pause';
}

/**
 * Everything `#play-pause` looks like and does, from the session state.
 *
 * The old build had a `#play` and a `#pause` sitting side by side, one of which
 * was always disabled. Merging them means this function has to cover a case the
 * wave brief did not spell out: `playing` → PAUSE. Without that branch the app
 * would have no way to pause at all, since `#pause` no longer exists — so the
 * merge is only sound with three branches, not two.
 *
 * The icon shows the ACTION, not the state (pause glyph while playing), which is
 * the convention every media player uses and the one the `aria-label` has to
 * agree with.
 */
export function derivePrimary(
  state: SessionState | undefined,
  canStart: boolean,
): PrimaryFace {
  if (state === 'playing') {
    return { action: 'pause', disabled: false, icon: '#icon-pause', label: 'Pause' };
  }
  if (state === 'paused') {
    return { action: 'resume', disabled: false, icon: '#icon-play', label: 'Play' };
  }
  return {
    action: canStart ? 'start' : null,
    disabled: !canStart,
    icon: '#icon-play',
    label: 'Play',
  };
}

/**
 * Whether a fresh session can be started: everything the engine needs is chosen,
 * and nothing is already running.
 */
export function canStartSession(state: Readonly<AppState>): boolean {
  const hasEverything = Boolean(state.media && state.plan && state.selectedDeviceId);
  return hasEverything && !isActiveState(state.status?.state);
}

// --- scrubber maths ---------------------------------------------------------

/** Percentage for `--progress`, clamped and safe for a zero/unknown duration. */
export function progressPercent(positionSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  if (!Number.isFinite(positionSec)) return 0;
  return Math.min(100, Math.max(0, (positionSec / durationSec) * 100));
}

/** Seconds → the integer 0..1000 the range input wants. */
export function sliderFromPosition(
  positionSec: number,
  durationSec: number,
  max: number = SEEK_MAX,
): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const raw = Math.round((positionSec / durationSec) * max);
  return Math.min(max, Math.max(0, raw));
}

/** The inverse. Kept next to its partner so the two cannot drift. */
export function positionFromSlider(
  value: number,
  durationSec: number,
  max: number = SEEK_MAX,
): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const clamped = Math.min(max, Math.max(0, value));
  return (clamped / max) * durationSec;
}

export interface ScrubberHover {
  /** `style.left` in px, relative to the scrubber. CSS centres with translateX(-50%). */
  leftPx: number;
  /** The time under the pointer. */
  seconds: number;
}

/**
 * Where the hover tooltip goes and what it says.
 *
 * Clamped to the track so a pointer that has slid a few pixels past either end
 * (which happens constantly at the moment of release) does not park the tooltip
 * outside the window or report a negative time.
 */
export function scrubberHover(
  clientX: number,
  rect: { left: number; width: number },
  durationSec: number,
): ScrubberHover {
  if (!Number.isFinite(rect.width) || rect.width <= 0) return { leftPx: 0, seconds: 0 };
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return { leftPx: fraction * rect.width, seconds: fraction * duration };
}

/** The `#volume-icon` symbol for a volume band. 1:1 with `volumeLevel()`. */
export function volumeIconHref(level: ReturnType<typeof volumeLevel>): string {
  return `#icon-volume-${level}`;
}

// --- volume throttle + reconcile --------------------------------------------

/**
 * Minimum gap between OUTBOUND volume commands during a drag.
 *
 * The `#volume-bar` `input` event fires once per pixel of thumb travel — dozens
 * of events for one gesture. Forwarding each one to the engine floods the
 * receiver's RECEIVER channel with `SET_VOLUME` requests (a burst the receiver
 * answers late, out of order, or not at all), which is what made the slider feel
 * unresponsive and "not representative", and destabilised the live cast. So the
 * outbound rate is capped: at most one command per this window while dragging,
 * plus a trailing send and one authoritative send on release. ~130ms is below
 * the threshold a hand perceives as lag yet an order of magnitude fewer commands.
 */
export const VOLUME_THROTTLE_MS = 130;

/**
 * How long after the user's last volume touch the slider keeps ITS position
 * before deferring to the engine again.
 *
 * The engine pushes an authoritative status at ~1Hz, carrying the receiver's own
 * (quantised, slightly lagged) volume. Writing that straight onto the slider the
 * instant after the user set it snaps the thumb backwards — the classic "it won't
 * stay where I put it". During a drag, and for this settle window after it, the
 * user's position wins; once idle beyond the window the engine value is trusted
 * again (so an external change — another remote, a mute — still reconciles).
 */
export const VOLUME_SETTLE_MS = 600;

export interface VolumeSendPlan {
  /** Send the current value to the engine now. */
  send: boolean;
  /**
   * When `send` is false, the delay after which a trailing send should fire so a
   * value that landed inside the throttle window is not lost if the drag stalls
   * without releasing. 0 when `send` is true.
   */
  scheduleInMs: number;
}

/**
 * Decide what to do with one drag `input`, given when we last actually sent.
 *
 * Leading-throttle with a trailing fallback: if the window has elapsed, send now;
 * otherwise ask the caller to schedule a trailing send for the remainder. A
 * never-sent baseline (`-Infinity`) always sends. Pure so the timing is unit-
 * tested without a DOM or a clock.
 */
export function planVolumeSend(
  lastSentAt: number,
  now: number,
  throttleMs: number = VOLUME_THROTTLE_MS,
): VolumeSendPlan {
  const elapsed = now - lastSentAt;
  if (!Number.isFinite(lastSentAt) || elapsed >= throttleMs) {
    return { send: true, scheduleInMs: 0 };
  }
  return { send: false, scheduleInMs: Math.max(0, throttleMs - elapsed) };
}

/**
 * Whether an engine-reported volume should be written onto the slider, or the
 * user's current position left alone.
 *
 * False while dragging and for `settleMs` after the last touch; true once idle.
 * A never-touched baseline (`-Infinity`) accepts immediately, so the first
 * status paints the slider. Pure, and deliberately time-based rather than
 * `document.activeElement === volumeBar`: a range input KEEPS focus after a
 * mouse release, so the old focus test blocked reconciliation forever until the
 * user clicked elsewhere.
 */
export function shouldAcceptEngineVolume(
  interacting: boolean,
  lastInteractionAt: number,
  now: number,
  settleMs: number = VOLUME_SETTLE_MS,
): boolean {
  if (interacting) return false;
  if (!Number.isFinite(lastInteractionAt)) return true;
  return now - lastInteractionAt >= settleMs;
}

// --- the view ---------------------------------------------------------------

export interface PlayerBarDeps {
  actions: AppActions;
}

export function mountPlayerBar(deps: PlayerBarDeps): View {
  const { actions } = deps;

  const playPause = el<HTMLButtonElement>('play-pause');
  const playPauseIcon = el<SVGUseElement>('play-pause-icon');
  const stopButton = el<HTMLButtonElement>('stop');
  const seekBar = el<HTMLInputElement>('seek-bar');
  const seekTooltip = el<HTMLElement>('seek-tooltip');
  // The tooltip's `style.left` is specified as being relative to the SCRUBBER,
  // but the contract gives the scrubber a class and no id — so it is the one
  // contract element that cannot go through `el()`. Fatal for the same reason
  // `el()` is: a missing scrubber means a permanently dead hover readout, and a
  // silent one is far harder to notice than a failed boot.
  const scrubber = seekBar.closest<HTMLElement>('.scrubber');
  if (!scrubber) throw new Error('Missing .scrubber wrapper around #seek-bar');
  const timePos = el<HTMLSpanElement>('time-pos');
  const timeDur = el<HTMLSpanElement>('time-dur');
  const statusLine = el<HTMLParagraphElement>('status-line');
  const muteButton = el<HTMLButtonElement>('mute');
  const volumeIcon = el<SVGUseElement>('volume-icon');
  const volumeBar = el<HTMLInputElement>('volume-bar');
  const volumeLabel = el<HTMLSpanElement>('volume-label');
  const settingsButton = el<HTMLButtonElement>('settings');
  const settingsPopover = el<HTMLElement>('settings-popover');

  /** True while the user is dragging the thumb. See the module header. */
  let seeking = false;
  let face: PrimaryFace = derivePrimary(undefined, false);
  /** The duration currently on screen, so pointer handlers need no store access. */
  let duration = 0;
  let muted = false;

  // Volume-drag bookkeeping (see VOLUME_THROTTLE_MS / VOLUME_SETTLE_MS). All in
  // this closure, none in the store — the slider position mid-gesture is view
  // state, exactly like `seeking`.
  let volumeDragging = false;
  let lastVolumeInteractionAt = Number.NEGATIVE_INFINITY;
  let lastVolumeSentAt = Number.NEGATIVE_INFINITY;
  let pendingVolume: number | null = null;
  let volumeTrailingTimer: ReturnType<typeof setTimeout> | undefined;

  function clearVolumeTrailing(): void {
    if (volumeTrailingTimer !== undefined) {
      clearTimeout(volumeTrailingTimer);
      volumeTrailingTimer = undefined;
    }
  }

  function sendVolume(fraction: number, now: number): void {
    lastVolumeSentAt = now;
    pendingVolume = null;
    actions.setVolume(fraction);
  }

  // ---- transport ----

  playPause.addEventListener('click', () => {
    switch (face.action) {
      case 'pause':
        actions.pause();
        break;
      case 'resume':
        actions.resume();
        break;
      case 'start':
        actions.start();
        break;
      default:
        break;
    }
  });

  stopButton.addEventListener('click', () => actions.stop());

  // ---- scrubbing ----

  seekBar.addEventListener('input', () => {
    seeking = true;
    const pos = positionFromSlider(Number(seekBar.value), duration);
    timePos.textContent = formatTime(pos);
    setProgress(seekBar, progressPercent(pos, duration));
  });

  seekBar.addEventListener('change', () => {
    seeking = false;
    if (duration <= 0) return;
    actions.seek(positionFromSlider(Number(seekBar.value), duration));
  });

  scrubber.addEventListener('mousemove', (event) => {
    const rect = scrubber.getBoundingClientRect();
    const hover = scrubberHover(event.clientX, rect, duration);
    seekTooltip.style.left = `${hover.leftPx}px`;
    seekTooltip.textContent = formatTime(hover.seconds);
    // Nothing useful to show before a duration is known — an unmoving "0:00"
    // following the cursor reads as broken.
    seekTooltip.classList.toggle('is-visible', duration > 0);
  });

  scrubber.addEventListener('mouseleave', () => {
    seekTooltip.classList.remove('is-visible');
  });

  // ---- volume ----

  // `input` fires per pixel of thumb travel. The LOCAL readout (label, fill,
  // icon) updates on every one for zero-latency feedback; the OUTBOUND command
  // is throttled so a single drag is a handful of `SET_VOLUME`s, not dozens. See
  // planVolumeSend and the module constants.
  volumeBar.addEventListener('input', () => {
    const percent = Number(volumeBar.value);
    const fraction = percent / 100;
    volumeLabel.textContent = `${percent}%`;
    setProgress(volumeBar, percent);
    volumeIcon.setAttribute('href', volumeIconHref(volumeLevel(fraction, muted)));

    const now = Date.now();
    volumeDragging = true;
    lastVolumeInteractionAt = now;
    pendingVolume = fraction;

    const plan = planVolumeSend(lastVolumeSentAt, now);
    if (plan.send) {
      clearVolumeTrailing();
      sendVolume(fraction, now);
    } else if (volumeTrailingTimer === undefined) {
      // A value inside the throttle window: schedule ONE trailing send for the
      // remainder. Later inputs keep updating `pendingVolume`, so the trailing
      // send carries the latest position without re-arming the timer each pixel.
      volumeTrailingTimer = setTimeout(() => {
        volumeTrailingTimer = undefined;
        if (pendingVolume === null) return;
        const at = Date.now();
        lastVolumeInteractionAt = at;
        sendVolume(pendingVolume, at);
      }, plan.scheduleInMs);
    }
  });

  // Release: the authoritative final value, always sent, bypassing the throttle.
  volumeBar.addEventListener('change', () => {
    const fraction = Number(volumeBar.value) / 100;
    const now = Date.now();
    volumeDragging = false;
    lastVolumeInteractionAt = now;
    clearVolumeTrailing();
    sendVolume(fraction, now);
  });

  muteButton.addEventListener('click', () => actions.setMuted(!muted));

  // ---- settings popover ----

  function setPopover(open: boolean): void {
    settingsPopover.classList.toggle('is-open', open);
    settingsButton.setAttribute('aria-expanded', String(open));
  }

  settingsButton.addEventListener('click', () => {
    setPopover(!settingsPopover.classList.contains('is-open'));
  });

  // Outside click. The gear's own click bubbles up to here, so it has to be
  // excluded explicitly or the popover would close in the same tick it opened.
  document.addEventListener('click', (event) => {
    if (!settingsPopover.classList.contains('is-open')) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (settingsButton.contains(target) || settingsPopover.contains(target)) return;
    setPopover(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!settingsPopover.classList.contains('is-open')) return;
    setPopover(false);
    // Focus would otherwise be stranded on a now-invisible select inside the
    // popover, which `visibility: hidden` also removes from the tab order.
    settingsButton.focus();
  });

  // ---- rendering ----

  function render(state: Readonly<AppState>): void {
    const sessionState = state.status?.state;
    const active = isActiveState(sessionState);

    // `.is-casting` on <body> is what raises the bar and reserves its space
    // (`--player-inset`). Set here because this view owns the bar, and set from
    // the SAME `active` flag that gates the transport controls — so the bar can
    // never be on screen with everything inside it disabled, which is exactly
    // what it looked like before it learned to hide.
    document.body.classList.toggle('is-casting', active);

    face = derivePrimary(sessionState, canStartSession(state));
    playPause.disabled = face.disabled;
    playPause.setAttribute('aria-label', face.label);
    playPauseIcon.setAttribute('href', face.icon);

    stopButton.disabled = !active;

    // The session's duration wins; before a session exists the probe's is the
    // best available, so the bar shows a real length as soon as a file is loaded.
    duration = state.status?.durationSec ?? state.media?.durationSec ?? 0;
    timeDur.textContent = formatTime(duration);
    seekBar.disabled = !active || duration <= 0;

    // Only the ACTIVITY detail — the device name is already in the mono caps
    // line (#casting-device), so the full "Casting to <device>" sentence would
    // render the name twice. `formatDeviceStatus` stays for any full-sentence use.
    statusLine.textContent = castingStatusDetail(state.status ?? null);

    if (state.status) {
      muted = state.status.muted;
      const percent = Math.round(state.status.volume * 100);
      // Reconcile the slider to the engine only once the user has stopped
      // touching it (drag + a short settle window) — otherwise the ~1Hz status
      // would snap the thumb back to its own lagged, quantised value the instant
      // after the user set it. The MUTED icon still tracks the engine every
      // frame: it is a separate control the slider drag cannot have changed.
      if (shouldAcceptEngineVolume(volumeDragging, lastVolumeInteractionAt, Date.now())) {
        volumeBar.value = String(percent);
        setProgress(volumeBar, percent);
        volumeLabel.textContent = `${percent}%`;
        volumeIcon.setAttribute(
          'href',
          volumeIconHref(volumeLevel(state.status.volume, muted)),
        );
      } else {
        // Mid-interaction: keep the user's slider position, but let a mute state
        // arriving over IPC repaint the icon against that on-screen position.
        volumeIcon.setAttribute(
          'href',
          volumeIconHref(volumeLevel(Number(volumeBar.value) / 100, muted)),
        );
      }
      muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    } else {
      // No session: keep the slider's fill matching whatever it is showing,
      // rather than leaving the CSS default of 100%.
      setProgress(volumeBar, Number(volumeBar.value));
    }
  }

  /**
   * The per-frame hook. Deliberately tiny: it writes three properties on two
   * elements and touches nothing else, which is what makes a 60Hz loop over a
   * store that updates at 1Hz affordable.
   */
  function renderPosition(_state: Readonly<AppState>, positionSec: number): void {
    // While dragging, the `input` handler owns all three of these. The previous
    // build returned early only for the BAR and still overwrote `#time-pos` from
    // the interpolated position every frame, which meant the drag preview it went
    // to the trouble of computing was clobbered ~60 times a second and never
    // actually appeared.
    if (seeking) return;
    timePos.textContent = formatTime(positionSec);
    seekBar.value = String(sliderFromPosition(positionSec, duration));
    setProgress(seekBar, progressPercent(positionSec, duration));
  }

  return { render, renderPosition };
}
