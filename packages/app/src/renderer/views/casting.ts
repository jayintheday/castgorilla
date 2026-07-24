/**
 * casting.ts — the now-casting screen's METADATA (device, title, subtitle,
 * backdrop). The transport controls inside `#casting-view` are NOT this view's:
 * `player-bar.ts` owns them (same ids, new home) and owns `body.is-casting`,
 * which is what actually reveals `#casting-view`. This view only fills the text
 * around the transport and paints the backdrop.
 *
 * `#status-line` is likewise NOT touched here — it is the accessible status
 * sentence and `player-bar.ts` is its single writer. Two views writing one
 * element is exactly the kind of split ownership the contract exists to prevent.
 *
 * The backdrop is fetched once per file and guarded: a slow frame that resolves
 * after the user has moved on must not paint itself over the next file.
 */

import { formatFileName } from '../media-format.js';
import { AUDIO_CODEC_LABEL, VIDEO_CODEC_LABEL, heightToLabel } from '../plan-format.js';
import type { MediaInfo, PlaybackPlan } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { ThumbnailFetcher, View } from './contracts.js';
import { el } from './dom.js';

/** The H.264/HEVC name a video encoder id resolves to (for the "→ H.264" clause). */
function targetVideoCodec(encoder: string): string {
  if (encoder.startsWith('hevc')) return 'HEVC';
  if (encoder.startsWith('h264')) return 'H.264';
  return encoder;
}

/** The AAC/E-AC-3 name an audio encoder id resolves to. */
function targetAudioCodec(encoder: string): string {
  if (encoder.startsWith('aac')) return 'AAC';
  if (encoder === 'eac3') return 'E-AC-3';
  return encoder;
}

/**
 * The sub-line under the casting title, e.g. `1080p HEVC → H.264 · AC-3 → AAC`
 * or, when nothing is converted, `1080p H.264 · AAC`.
 *
 * Describes the streams the PLAN chose (not the file's first streams), and shows
 * the codec transition only where the plan actually transcodes — so a copy tier
 * reads as the plain source format. Pure and exported for readability/reuse.
 */
export function castingSubtitle(media: MediaInfo | null, plan: PlaybackPlan | null): string {
  if (!media) return '';

  const video = plan
    ? media.video.find((v) => v.index === plan.videoStreamIndex)
    : media.video[0];
  const audio = plan
    ? media.audio.find((a) => a.index === plan.audioStreamIndex)
    : (media.audio.find((a) => a.isDefault) ?? media.audio[0]);

  const parts: string[] = [];

  if (video) {
    const res = video.height > 0 ? `${heightToLabel(video.height)} ` : '';
    let clause = `${res}${VIDEO_CODEC_LABEL[video.codec]}`;
    if (plan && plan.video.kind === 'transcode') {
      clause += ` → ${targetVideoCodec(plan.video.encoder)}`;
    }
    parts.push(clause);
  }

  if (audio) {
    let clause = AUDIO_CODEC_LABEL[audio.codec];
    if (plan && plan.audio.kind === 'transcode') {
      clause += ` → ${targetAudioCodec(plan.audio.encoder)}`;
    }
    parts.push(clause);
  }

  return parts.join(' · ');
}

export interface CastingDeps {
  getThumbnail: ThumbnailFetcher;
}

export function mountCasting(deps: CastingDeps): View {
  const { getThumbnail } = deps;

  const deviceName = el<HTMLSpanElement>('casting-device');
  const title = el<HTMLHeadingElement>('casting-title');
  const subtitle = el<HTMLParagraphElement>('casting-subtitle');
  const backdrop = el<HTMLImageElement>('casting-backdrop');

  /** The file the backdrop currently reflects, so we fetch once and guard races. */
  let backdropFor: string | null = null;

  function render(state: Readonly<AppState>): void {
    const path = state.media?.path ?? state.file;

    // The device name: the live session's is authoritative; before that (the view
    // is hidden anyway) fall back to the selected device so the value is ready.
    const name =
      state.status?.deviceName?.trim() ||
      state.devices.find((d) => d.id === state.selectedDeviceId)?.friendlyName ||
      '…';
    deviceName.textContent = name;

    title.textContent = path ? formatFileName(path) : '';
    subtitle.textContent = castingSubtitle(state.media, state.plan);

    if (!path) {
      backdropFor = null;
      backdrop.removeAttribute('src');
      return;
    }
    if (path === backdropFor) return;

    backdropFor = path;
    backdrop.removeAttribute('src');
    const target = path;
    void getThumbnail({ file: target, variant: 'backdrop' }).then((src) => {
      // Only paint if this is still the file the backdrop is meant to show.
      if (src && backdropFor === target) backdrop.src = src;
    });
  }

  return { render };
}
