/**
 * media-format.ts — pure formatters for the media-player chrome.
 *
 * `plan-format.ts` speaks the *engineering* dialect: it exists so a maintainer
 * can read a line of UI and know exactly which ffmpeg path ran. This module is
 * its counterpart for the surfaces a viewer looks at while watching something —
 * the file card and the player bar — where the same facts have to land as
 * ordinary English. The two are deliberately separate vocabularies over one
 * shared set of unions (imported from `plan-format.ts`, never redeclared), so
 * that softening a user-facing phrase can never quietly change what the
 * technical summary reports.
 *
 * Everything here is pure and DOM-free: no element construction, no CSS class
 * names, no `document`. Callers own the markup.
 */

import type {
  AudioStreamInfo,
  HdrType,
  MediaInfo,
  PlaybackPlan,
  PlaybackTier,
  SessionState,
  SessionStatus,
  VideoStreamInfo,
} from '../shared/engine-types.js';
import {
  AUDIO_CODEC_LABEL,
  VIDEO_CODEC_LABEL,
  formatTime,
  heightToLabel,
} from './plan-format.js';

/** The separator between facts on a single metadata line. */
const SEP = ' · ';

/**
 * Extracts the final path component.
 *
 * The renderer is a browser context with no `node:path`, and we refuse to ship a
 * second copy of the engine just to get `basename` — so this does it by hand.
 * A trailing separator is dropped first, because a directory path arriving here
 * (from a drag-and-drop of a folder, say) should read as the folder's name and
 * not as an empty string.
 */
export function formatFileName(path: string): string {
  // Windows paths are not a target — this is a macOS app and every path we see
  // originates from an Electron dialog or an engine probe — but tolerating '\'
  // costs one character and avoids a mystery if a path is ever pasted in.
  const trimmed = path.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  // Falling back to the original keeps a pathological input ('/' alone) visible
  // rather than collapsing the card's title to nothing.
  return base || path;
}

/**
 * HDR marker shown after the codec. `none` maps to the empty string so callers
 * can filter on truthiness; a `Record` over the frozen union means a new HDR
 * flavour is a compile error here rather than a silently unlabelled file.
 */
const HDR_LABEL: Record<HdrType, string> = {
  none: '',
  hdr10: 'HDR10',
  hlg: 'HLG',
  dovi: 'Dolby Vision',
};

/**
 * Channel layouts as a viewer would say them.
 *
 * ffmpeg distinguishes `5.1` from `5.1(side)` because the speaker mapping
 * genuinely differs (and that distinction is load-bearing in the transcode
 * args — see the PCE trap in CLAUDE.md), but it means nothing to someone
 * reading a file card, so the parenthetical is dropped here only.
 */
function channelLabel(audio: AudioStreamInfo): string {
  const layout = audio.channelLayout.replace(/\(.*\)$/, '').trim();
  if (layout === 'stereo') return 'Stereo';
  if (layout === 'mono') return 'Mono';
  if (layout) return layout;
  // Layout can be absent on an oddly-tagged stream; the channel count still is not.
  if (audio.channels === 2) return 'Stereo';
  if (audio.channels === 1) return 'Mono';
  return audio.channels > 0 ? `${audio.channels}ch` : '';
}

/** `1080p HEVC HDR10` — resolution, codec, and HDR flavour when there is one. */
function videoLabel(video: VideoStreamInfo): string {
  const parts: string[] = [];
  // A zero height means the probe could not read the stream geometry; claiming
  // "0p" would be worse than saying nothing.
  if (video.height > 0) parts.push(heightToLabel(video.height));
  parts.push(VIDEO_CODEC_LABEL[video.codec]);
  const hdr = HDR_LABEL[video.hdr.type];
  if (hdr) parts.push(hdr);
  return parts.join(' ');
}

/** `AC-3 5.1` — codec then channel layout. */
function audioLabel(audio: AudioStreamInfo): string {
  return [AUDIO_CODEC_LABEL[audio.codec], channelLabel(audio)].filter(Boolean).join(' ');
}

/**
 * The one-line summary under the filename in the file card, e.g.
 * `49:07 · 1080p HEVC · AC-3 5.1`.
 *
 * When a `plan` is available it describes the streams the *plan chose*, not the
 * first ones in the file: a multi-track MKV can carry a commentary track or a
 * second language ahead of the one that will actually be cast, and a card that
 * disagrees with what comes out of the speakers is worse than no card. With no
 * plan yet (the window between drop and probe completing) it falls back to the
 * first video stream and the default-or-first audio stream — the same choice
 * the planner will most likely make.
 *
 * Note there is no file size here, and deliberately no IPC call to fetch one:
 * `MediaInfo` is the whole contract this card gets, and it carries no size
 * field.
 *
 * Any part that cannot be described is omitted rather than rendered as a
 * placeholder — a file with no audio, no video, or a plan whose stream indices
 * match nothing (possible after a track selection races a re-probe) still
 * produces a clean, shorter line.
 */
export function formatFileMeta(media: MediaInfo, plan: PlaybackPlan | null): string {
  const video = plan
    ? media.video.find((v) => v.index === plan.videoStreamIndex)
    : media.video[0];
  const audio = plan
    ? media.audio.find((a) => a.index === plan.audioStreamIndex)
    : (media.audio.find((a) => a.isDefault) ?? media.audio[0]);

  const parts: string[] = [];
  // Duration is guarded because it reaches the UI before anything validates it,
  // and formatTime(NaN) would render the literal string 'NaN:NaN'.
  if (Number.isFinite(media.durationSec) && media.durationSec > 0) {
    parts.push(formatTime(media.durationSec));
  }
  if (video) parts.push(videoLabel(video));
  if (audio) parts.push(audioLabel(audio));

  return parts.filter(Boolean).join(SEP);
}

/**
 * Plain-language tier labels for the file card's chip.
 *
 * Deliberately NOT `TIER_LABEL` from `plan-format.ts`. "Remux" is precise and
 * meaningless to a viewer; what they want to know is whether the app is about
 * to do something expensive to their file. The technical vocabulary stays
 * available in the plan summary for anyone who wants it.
 *
 * Typed as an exhaustive `Record` over the frozen `PlaybackTier` union so that
 * adding a tier upstream fails the build here instead of falling through to an
 * empty chip.
 */
const TIER_CHIP: Record<PlaybackTier, string> = {
  direct: 'Plays as-is',
  remux: 'Repackaging',
  'audio-transcode': 'Converting audio',
  'video-transcode': 'Converting video',
};

export function formatTierChip(tier: PlaybackTier): string {
  return TIER_CHIP[tier];
}

/**
 * The player bar's right-hand status line, e.g. `Casting to Living Room ·
 * Converting video` or `Buffering on Living Room…`.
 *
 * Every member of `SessionState` is handled explicitly and the switch ends in a
 * `never` check, so a new state added to the frozen contract is a compile error
 * rather than a raw token like `buffering` leaking onto the screen — which is
 * exactly what the old bare `idle`/state-name label used to do.
 *
 * The tier is appended only while playing. Before then it is either unknown or
 * irrelevant to the thing the user is waiting on, and during the pre-roll
 * states a second clause competes with the progress message.
 */
export function formatDeviceStatus(status: SessionStatus | null): string {
  if (!status) return 'Not casting';

  // deviceName is contractually populated, but an empty string would otherwise
  // produce a dangling "Connecting to …" with nothing after the preposition.
  const device = status.deviceName.trim() || 'the device';
  const state: SessionState = status.state;

  switch (state) {
    case 'probing':
      return 'Reading the file…';
    case 'planning':
      return 'Working out how to play this…';
    case 'preparing':
      return `Preparing the stream for ${device}…`;
    case 'connecting':
      return `Connecting to ${device}…`;
    case 'loading':
      return `Starting playback on ${device}…`;
    case 'buffering':
      return `Buffering on ${device}…`;
    case 'playing':
      return `Casting to ${device}${SEP}${formatTierChip(status.tier)}`;
    case 'paused':
      return `Paused on ${device}`;
    case 'seeking':
      return `Jumping to a new position on ${device}…`;
    case 'reconnecting':
      return `Reconnecting to ${device}…`;
    case 'stopped':
      return `Stopped casting to ${device}`;
    case 'error':
      return `Playback failed on ${device}`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * The casting view's activity DETAIL — the muted line that sits beside the mono
 * "CASTING TO <device>" caps line (`#status-line`, kept `aria-live`).
 *
 * This is the device-FREE counterpart to `formatDeviceStatus`. The device name
 * is already on screen in the caps line (`#casting-device`), so writing the full
 * "Casting to <device> · …" sentence here rendered the name TWICE ("Casting to
 * SHIELD … Casting to SHIELD · Converting video"). So this returns only what the
 * session is DOING — the part after the "· " in the old sentence.
 *
 * `formatDeviceStatus` is deliberately left intact (and still tested) for any
 * surface that wants the full device-qualified sentence; this is additive.
 *
 * Exhaustive over `SessionState` with a `never` guard, so a new state is a
 * compile error rather than a blank detail leaking onto the screen.
 */
export function castingStatusDetail(status: SessionStatus | null): string {
  if (!status) return 'Not casting';

  const state: SessionState = status.state;

  switch (state) {
    case 'probing':
      return 'Reading the file…';
    case 'planning':
      return 'Working out how to play this…';
    case 'preparing':
      return 'Preparing the stream…';
    case 'connecting':
      return 'Connecting…';
    case 'loading':
      return 'Starting playback…';
    case 'buffering':
      return 'Buffering…';
    case 'playing':
      // Once a picture is up the meaningful activity is the tier — "Converting
      // video", "Repackaging", "Plays as-is" — which is what the design shows
      // beside the CASTING TO line.
      return formatTierChip(status.tier);
    case 'paused':
      return 'Paused';
    case 'seeking':
      return 'Jumping to a new position…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Playback failed';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Volume band driving which speaker glyph the player bar shows.
 *
 * Three bands, not a continuum, because that is all the icon set distinguishes:
 * crossed-out, one wave, two waves. The low/high boundary sits at 0.5 — the
 * midpoint of the contractual 0..1 range, so the glyph flips exactly when the
 * slider passes its own halfway mark and the change reads as intentional.
 *
 * `muted` wins over any level: a muted session at full volume is silent, and
 * showing two waves next to silence is the one genuinely misleading option.
 *
 * The value arrives over IPC from a receiver, so it is treated as untrusted:
 * anything non-finite (NaN, ±Infinity) is read as `muted`. That is the honest
 * reading of "we have no figure" — we cannot claim sound is coming out — and it
 * shows the one glyph a user's instinct is to click.
 */
export function volumeLevel(volume: number, muted: boolean): 'muted' | 'low' | 'high' {
  if (muted || !Number.isFinite(volume)) return 'muted';
  const clamped = Math.min(1, Math.max(0, volume));
  if (clamped === 0) return 'muted';
  return clamped < 0.5 ? 'low' : 'high';
}
