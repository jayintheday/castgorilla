/**
 * plan-format.ts — pure formatting helpers for the plan summary line.
 *
 * Turns a PlaybackPlan (+ the probed MediaInfo it was built from) into the short
 * tier-colored summary the UI shows, e.g. "Transcode video · MKV → fMP4 · video
 * → H.264 1080p · audio copy E-AC-3". Kept pure and DOM-free for unit testing.
 */

import type {
  AudioCodec,
  MediaInfo,
  PlaybackPlan,
  PlaybackTier,
  VideoCodec,
} from '../shared/engine-types.js';

/**
 * Engineering vocabulary for the tier — what the *pipeline* did.
 *
 * Exported (rather than module-private) so `media-format.ts` can key its
 * plain-language chip labels off the same union without the tier vocabulary
 * existing in two places that can drift apart. The two label sets are
 * deliberately different — see `formatTierChip` for why.
 */
export const TIER_LABEL: Record<PlaybackTier, string> = {
  direct: 'Direct play',
  remux: 'Remux',
  'audio-transcode': 'Transcode audio',
  'video-transcode': 'Transcode video',
};

/** Display names for the frozen codec unions. Exported for reuse by `media-format.ts`. */
export const VIDEO_CODEC_LABEL: Record<VideoCodec, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4',
  mpeg2: 'MPEG-2',
  other: 'video',
};

export const AUDIO_CODEC_LABEL: Record<AudioCodec, string> = {
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
  flac: 'FLAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  pcm: 'PCM',
  other: 'audio',
};

function encoderLabel(encoder: string): string {
  if (encoder.startsWith('h264')) return 'H.264';
  if (encoder.startsWith('hevc')) return 'HEVC';
  if (encoder.startsWith('aac')) return 'AAC';
  if (encoder === 'eac3') return 'E-AC-3';
  return encoder;
}

/**
 * Frame height → the resolution shorthand people actually recognise.
 *
 * Bucketed by `>=` rather than matched exactly because real files are rarely
 * the nominal height: the validated library includes 1920x1040 and 1920x960
 * letterboxed masters, both of which a user calls "1080p".
 *
 * Exported so the file card's metadata line describes resolution identically to
 * the plan summary.
 */
export function heightToLabel(h: number): string {
  if (h >= 2160) return '2160p';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  return `${h}p`;
}

export interface PlanSummary {
  tier: PlaybackTier;
  tierLabel: string;
  text: string;
}

export function formatPlanSummary(plan: PlaybackPlan, media: MediaInfo): PlanSummary {
  const srcVideo = media.video.find((v) => v.index === plan.videoStreamIndex);
  const srcAudio = media.audio.find((a) => a.index === plan.audioStreamIndex);

  const parts: string[] = [];

  // Container → target
  const container = media.container.toUpperCase();
  if (plan.method === 'hls') {
    const target = plan.segmentFormat === 'ts' ? 'HLS/TS' : 'HLS/fMP4';
    parts.push(`${container} → ${target}`);
  } else {
    parts.push(container);
  }

  // Video
  if (plan.video.kind === 'copy') {
    const label = srcVideo ? VIDEO_CODEC_LABEL[srcVideo.codec] : 'video';
    parts.push(`video copy ${label}${plan.video.tag ? ` (${plan.video.tag})` : ''}`.trim());
  } else {
    const size = plan.video.scale ? ` ${heightToLabel(plan.video.scale.h)}` : '';
    parts.push(`video → ${encoderLabel(plan.video.encoder)}${size}`);
  }

  // Audio
  if (plan.audio.kind === 'copy') {
    const label = srcAudio ? AUDIO_CODEC_LABEL[srcAudio.codec] : 'audio';
    parts.push(`audio copy ${label}`);
  } else {
    const ch = plan.audio.channels === 6 ? ' 5.1' : ' stereo';
    parts.push(`audio → ${encoderLabel(plan.audio.encoder)}${ch}`);
  }

  return {
    tier: plan.tier,
    tierLabel: TIER_LABEL[plan.tier],
    text: `${TIER_LABEL[plan.tier]} · ${parts.join(' · ')}`,
  };
}

/** mm:ss / h:mm:ss formatter for the time display. */
export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
