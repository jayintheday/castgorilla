/**
 * decision.ts — buildPlaybackPlan: the product's brain.
 *
 * PURE and deterministic: MediaInfo × DeviceProfile × PlaybackPrefs → PlaybackPlan.
 * No I/O. Orchestrates the per-stream rule modules (video-rules, audio-rules,
 * container-rules), resolves the delivery method, applies HLS-only copy
 * restrictions and pathological-GOP demotion, and assembles the final plan with
 * a human-readable reasons[] trail for every branch taken.
 */

import type {
  AudioAction,
  DeviceProfile,
  HdrOutcome,
  PlaybackMethod,
  PlaybackPlan,
  PlaybackPrefs,
  PlaybackTier,
  SegmentFormat,
  SegmentationPlan,
  VideoAction,
} from '../types/index.js';
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from '../types/media.js';
import {
  comboLegalForDirect,
  directContentType,
  resolveSegmentFormat,
} from './container-rules.js';
import { buildTranscodeAction, decideVideoBase } from './video-rules.js';
import { decideAudio } from './audio-rules.js';

/**
 * Thrown when no acceptable plan exists (a lossy path the policy forbids, or
 * content that would render as garbage on the target). Carries the reason and a
 * 'refused' HdrOutcome for callers that surface it.
 */
export class PlanRefusedError extends Error {
  readonly hdrOutcome: HdrOutcome = 'refused';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'PlanRefusedError';
    this.reason = reason;
  }
}

export interface PlanOptions {
  /** Explicit video stream override (absolute ffprobe index). */
  videoStreamIndex?: number;
  /** Explicit audio stream override (absolute ffprobe index). */
  audioStreamIndex?: number;
  /** Keyframe PTS (seconds) of the chosen video stream, for keyframe segmentation
   *  and pathological-GOP detection. */
  keyframePts?: number[];
}

const TARGET_SEC = 6;
/** A GOP whose keyframe spacing exceeds this (seconds) can't be cleanly
 *  keyframe-segmented for copy → demote to transcode. */
const MAX_GOP_GAP_SEC = 12;

// --- Stream selection (step 0) ---------------------------------------------

function selectVideo(media: MediaInfo, opts: PlanOptions): VideoStreamInfo | undefined {
  if (opts.videoStreamIndex !== undefined) {
    const found = media.video.find((v) => v.index === opts.videoStreamIndex);
    if (found) return found;
  }
  return media.video[0];
}

function selectAudio(
  media: MediaInfo,
  prefs: PlaybackPrefs,
  opts: PlanOptions,
): AudioStreamInfo | undefined {
  if (media.audio.length === 0) return undefined;
  if (opts.audioStreamIndex !== undefined) {
    const found = media.audio.find((a) => a.index === opts.audioStreamIndex);
    if (found) return found;
  }
  if (prefs.preferredAudioLang) {
    const lang = prefs.preferredAudioLang.toLowerCase();
    const found = media.audio.find((a) => (a.language ?? '').toLowerCase() === lang);
    if (found) return found;
  }
  const def = media.audio.find((a) => a.isDefault);
  if (def) return def;
  return media.audio[0];
}

// --- Keyframe helpers (exposed for the streamer) ---------------------------

function dedupeSorted(arr: number[]): number[] {
  const s = [...arr].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) {
    if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

/**
 * Snap the target grid (0, targetSec, 2·targetSec, …) to the nearest real
 * keyframe, producing segment boundary timestamps. Always includes 0, deduped
 * and ascending. Uses a forward-only pointer since both grid and keyframes are
 * monotonic.
 *
 * COPY TIERS ONLY. The video stream is passed through untouched, so every
 * source keyframe survives into the output and the HLS muxer is free to split
 * at any of them — see computeTranscodeBoundaries() for why that matters and
 * why the transcode tier needs a different rule.
 */
export function computeBoundaries(
  keyframePts: number[],
  durationSec: number,
  targetSec: number = TARGET_SEC,
): number[] {
  const kf = dedupeSorted(keyframePts);
  if (kf.length === 0) return [0];
  const limit = durationSec > 0 ? durationSec : kf[kf.length - 1]! + targetSec;
  const set = new Set<number>([0]);
  let i = 0;
  for (let g = 0; g < limit; g += targetSec) {
    while (i + 1 < kf.length && Math.abs(kf[i + 1]! - g) <= Math.abs(kf[i]! - g)) i++;
    set.add(kf[i]!);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Segment boundaries for the VIDEO-TRANSCODE tier: a forward-greedy walk that
 * takes the first source keyframe at least `targetSec` past the previous
 * boundary. Always starts at 0, ascending, every entry a real source keyframe,
 * and every gap >= targetSec by construction.
 *
 * WHY THIS EXISTS AT ALL (see docs/segment-numbering-drift.md):
 * a seek-restart runs `-ss <boundary>+SEEK_EPSILON -noaccurate_seek`, which
 * snaps BACKWARDS to the preceding source keyframe. With the old fixed 6s grid
 * the entry point was therefore almost never the boundary the playlist
 * declared, and `-start_number <boundaryIndex>` labelled it as if it were:
 * segment N was served with segment N-1's video. When two adjacent 6s
 * boundaries fell inside one source GOP (17% of them on real content) two
 * restarts produced BYTE-IDENTICAL first segments under different numbers.
 * Making every boundary a source keyframe makes the entry point correct by
 * construction — that is the whole fix.
 *
 * WHY GREEDY-FORWARD AND NOT computeBoundaries() (nearest-snap):
 * measured against ffmpeg 8.1.1, the HLS muxer ends a segment at the first
 * keyframe whose offset from the RUN START is >= `hls_time * n`. A boundary
 * closer than `hls_time` to its predecessor is therefore silently skipped and
 * two playlist segments get merged into one file. Nearest-snap can emit gaps
 * well under targetSec (a 4.8s mean GOP snapped to a 6s grid routinely does);
 * greedy-forward cannot. The transcode tier can afford this because it also
 * gets to CHOOSE its output keyframes (buildHlsArgs forces one at each
 * boundary and nowhere else), so the muxer has no other split point to pick.
 *
 * KNOWN COST — segments are as long as the source GOP that carries them. A
 * pathological 20.9s GOP (measured on real content) yields a 20.9s segment and
 * an EXT-X-TARGETDURATION to match. Accepted deliberately: the encoder sustains
 * ~7.5x realtime on this class of content (6s segment in ~800ms, measured), so
 * the worst case costs ~2.8s to first segment rather than ~0.8s, and the
 * alternative — subdividing a long GOP — reintroduces boundaries that are not
 * source keyframes, i.e. the bug this function exists to remove.
 */
export function computeTranscodeBoundaries(
  keyframePts: number[],
  durationSec: number,
  targetSec: number = TARGET_SEC,
): number[] {
  const kf = dedupeSorted(keyframePts);
  if (kf.length === 0) return [0];
  const out: number[] = [0];
  let last = 0;
  for (const t of kf) {
    if (durationSec > 0 && t >= durationSec) break;
    if (t >= last + targetSec) {
      out.push(t);
      last = t;
    }
  }
  return out;
}

/** Largest spacing between successive keyframes, bracketed by [0, durationSec]. */
function computeMaxGap(keyframePts: number[], durationSec: number): number {
  const kf = dedupeSorted(keyframePts);
  if (kf.length === 0) return durationSec > 0 ? durationSec : Infinity;
  const pts = [...kf];
  if (pts[0]! > 0) pts.unshift(0);
  if (durationSec > 0 && durationSec > pts[pts.length - 1]!) pts.push(durationSec);
  let max = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i]! - pts[i - 1]!;
    if (gap > max) max = gap;
  }
  return max;
}

// --- Assembly helpers -------------------------------------------------------

function copyVideoAction(v: VideoStreamInfo): VideoAction {
  return v.codec === 'hevc' ? { kind: 'copy', tag: 'hvc1' } : { kind: 'copy' };
}

// --- The planner ------------------------------------------------------------

export function buildPlaybackPlan(
  media: MediaInfo,
  profile: DeviceProfile,
  prefs: PlaybackPrefs,
  opts: PlanOptions = {},
): PlaybackPlan {
  const videoStream = selectVideo(media, opts);
  if (!videoStream) {
    throw new PlanRefusedError('no video stream to plan');
  }
  const audioStream = selectAudio(media, prefs, opts);
  const reasons: string[] = [];

  // Step 1 — video base verdict.
  const vb = decideVideoBase(videoStream, profile, prefs);
  if (vb.kind === 'refuse') throw new PlanRefusedError(vb.reason);
  reasons.push(...vb.reasons);
  const hdrOutcome = vb.hdrOutcome;

  // Step 2 — audio verdict (phase 1: evaluated as if direct).
  let audioAction: AudioAction = { kind: 'copy' };
  let audioReasonsDirect: string[] = [];
  if (audioStream) {
    const ad = decideAudio(audioStream, prefs, 'direct');
    audioAction = ad.action;
    audioReasonsDirect = ad.reasons;
  }

  // Step 3 — delivery method.
  const container = media.container;
  const directOk =
    vb.kind === 'copy' &&
    audioAction.kind === 'copy' &&
    (container === 'mp4' || container === 'webm') &&
    audioStream !== undefined &&
    comboLegalForDirect(videoStream.codec, audioStream.codec, container);

  let method: PlaybackMethod;
  let videoAction: VideoAction;
  let segmentation: SegmentationPlan | undefined;
  let segmentFormat: SegmentFormat | undefined;
  let contentType: string;
  let tier: PlaybackTier;

  if (directOk) {
    method = 'direct';
    videoAction = copyVideoAction(videoStream);
    // audioAction is the phase-1 copy.
    contentType = directContentType(container);
    tier = 'direct';
    reasons.push(...audioReasonsDirect);
    reasons.push(`method: direct play (${container}, no repackaging)`);
  } else {
    method = 'hls';
    segmentFormat = resolveSegmentFormat(profile);

    // Recompute audio for HLS (flac/pcm/vorbis flip from copy to transcode).
    if (audioStream) {
      const ah = decideAudio(audioStream, prefs, 'hls');
      audioAction = ah.action;
      reasons.push(...ah.reasons);
    }

    // Resolve video for HLS.
    if (vb.kind === 'copy') {
      const codec = videoStream.codec;
      if (codec === 'vp8' || codec === 'vp9' || codec === 'av1') {
        const t = buildTranscodeAction(videoStream, profile);
        videoAction = t.action;
        reasons.push(`video: ${codec} cannot be copied into HLS; transcoding`, ...t.reasons);
      } else if (codec === 'hevc' && segmentFormat === 'ts') {
        const t = buildTranscodeAction(videoStream, profile, { forceH264: true });
        videoAction = t.action;
        reasons.push('video: HEVC cannot ride MPEG-TS HLS; transcoding to H.264', ...t.reasons);
      } else {
        videoAction = copyVideoAction(videoStream);
      }
    } else {
      videoAction = vb.action;
    }

    contentType = 'application/vnd.apple.mpegurl';

    // Pathological-GOP demotion: a copy that can't be cleanly keyframe-segmented.
    if (videoAction.kind === 'copy' && opts.keyframePts && opts.keyframePts.length > 0) {
      const maxGap = computeMaxGap(opts.keyframePts, media.durationSec);
      if (maxGap > MAX_GOP_GAP_SEC) {
        const t = buildTranscodeAction(
          videoStream,
          profile,
          segmentFormat === 'ts' ? { forceH264: true } : {},
        );
        videoAction = t.action;
        reasons.push(
          `video: pathological GOP (>${MAX_GOP_GAP_SEC}s keyframe spacing); demoting copy to transcode`,
          ...t.reasons,
        );
      }
    }

    // Segmentation.
    //
    // BOTH tiers segment on source keyframes now. For a copy that is obvious
    // (a segment must start on a keyframe to be independently decodable). For a
    // transcode it is less obvious but just as necessary: a seek-restart enters
    // the file with `-noaccurate_seek`, which lands on the preceding SOURCE
    // keyframe whatever the plan says, so any boundary that is not one is a
    // boundary the encoder can never actually start at — and `-start_number`
    // then mislabels the whole run. See docs/segment-numbering-drift.md.
    //
    // 'fixed' survives only as the no-keyframe-index fallback. It is NOT safe
    // on its own; buildHlsArgs() compensates by switching that case to an
    // accurate (decode-and-discard) seek so the first output frame is the
    // boundary exactly.
    if (videoAction.kind === 'copy') {
      segmentation = { mode: 'keyframe', targetSec: TARGET_SEC };
      if (opts.keyframePts && opts.keyframePts.length > 0) {
        segmentation.boundaries = computeBoundaries(opts.keyframePts, media.durationSec, TARGET_SEC);
      }
    } else if (opts.keyframePts && opts.keyframePts.length > 0) {
      segmentation = {
        mode: 'keyframe',
        targetSec: TARGET_SEC,
        boundaries: computeTranscodeBoundaries(opts.keyframePts, media.durationSec, TARGET_SEC),
      };
    } else {
      segmentation = { mode: 'fixed', targetSec: TARGET_SEC };
    }

    // Tier.
    if (videoAction.kind === 'transcode') tier = 'video-transcode';
    else if (audioAction.kind === 'transcode') tier = 'audio-transcode';
    else tier = 'remux';

    reasons.push(`method: HLS (${segmentFormat}, ${tier})`);
  }

  const plan: PlaybackPlan = {
    method,
    tier,
    reasons,
    video: videoAction,
    audio: audioAction,
    videoStreamIndex: videoStream.index,
    audioStreamIndex: audioStream ? audioStream.index : -1,
    contentType,
    durationSec: media.durationSec,
    hdrOutcome,
    subtitles: [],
  };
  if (segmentation) plan.segmentation = segmentation;
  if (segmentFormat) plan.segmentFormat = segmentFormat;
  return plan;
}
