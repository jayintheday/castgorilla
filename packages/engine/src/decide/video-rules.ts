/**
 * video-rules.ts — the video verdict.
 *
 * Given a source video stream, a device profile, and prefs, decide whether the
 * stream can be copied (device decodes it natively, within caps, HDR handled) or
 * must be re-encoded — and if re-encoded, exactly how (encoder, 10-bit HDR
 * preservation, downscale, fps cap).
 *
 * The verdict is "base": it does not yet know the delivery method. The HLS-only
 * copy restrictions (VP8/VP9/AV1 can't be HLS-copied; HEVC can't ride MPEG-TS)
 * are applied later, in decision.ts, which can call buildTranscodeAction() to
 * demote a copy to a transcode.
 */

import type { DeviceProfile, HdrOutcome, PlaybackPrefs, VideoAction } from '../types/index.js';
import type { VideoStreamInfo } from '../types/media.js';

export type TranscodeAction = Extract<VideoAction, { kind: 'transcode' }>;

export type VideoBaseVerdict =
  | { kind: 'refuse'; reason: string }
  | { kind: 'copy'; hdrOutcome: HdrOutcome; reasons: string[] }
  | { kind: 'transcode'; action: TranscodeAction; hdrOutcome: HdrOutcome; reasons: string[] };

interface DimsCaps {
  maxW: number;
  maxH: number;
  maxFps: number;
  maxLevel?: number;
}

/** fps tolerance: 23.976 vs a 24 cap etc. shouldn't trip the check. */
const FPS_SLOP = 0.51;

/**
 * Does the stream exceed the caps? Dimensions are authoritative; level is only
 * consulted when width/height are missing (0) — some streams report level but
 * not resolution.
 */
function exceedsCaps(v: VideoStreamInfo, caps: DimsCaps): string | null {
  if (v.width > 0 && v.height > 0) {
    if (v.width > caps.maxW || v.height > caps.maxH) {
      return `${v.width}x${v.height} exceeds device max ${caps.maxW}x${caps.maxH}`;
    }
  } else if (caps.maxLevel !== undefined && v.level !== undefined && v.level > caps.maxLevel) {
    return `level ${v.level} exceeds device max level ${caps.maxLevel}`;
  }
  if (v.fps > caps.maxFps + FPS_SLOP) {
    return `${v.fps}fps exceeds device max ${caps.maxFps}fps`;
  }
  return null;
}

/** VP9 profile number implied by bit depth (10-bit VP9 is profile 2). */
function vp9ProfileNumber(v: VideoStreamInfo): 0 | 2 {
  return v.bitDepth >= 10 ? 2 : 0;
}

/** Can the device natively decode this stream (codec present, profile+caps ok)? */
function capabilityCheck(v: VideoStreamInfo, profile: DeviceProfile): string | null {
  const caps = profile.video;
  switch (v.codec) {
    case 'h264':
      return exceedsCaps(v, caps.h264);
    case 'hevc': {
      if (!caps.hevc) return 'device cannot decode HEVC';
      if (v.bitDepth >= 10 && !caps.hevc.profiles.includes('main10')) {
        return 'HEVC 10-bit (Main 10) not supported by device';
      }
      return exceedsCaps(v, caps.hevc);
    }
    case 'vp8':
      if (!caps.vp8) return 'device cannot decode VP8';
      return exceedsCaps(v, caps.vp8);
    case 'vp9': {
      if (!caps.vp9) return 'device cannot decode VP9';
      const prof = vp9ProfileNumber(v);
      if (!caps.vp9.profiles.includes(prof)) return `VP9 profile ${prof} not supported by device`;
      return exceedsCaps(v, caps.vp9);
    }
    case 'av1':
      if (!caps.av1) return 'device cannot decode AV1';
      return exceedsCaps(v, caps.av1);
    default:
      return 'codec not directly playable';
  }
}

/**
 * Build the transcode action for this stream on this device.
 * - Targets HEVC (VideoToolbox) when the device supports it AND the source is
 *   10-bit or >=4K wide; otherwise H.264. HEVC of a 10-bit source preserves
 *   depth (main10 / p010le).
 * - Downscales to the target codec's max dimensions preserving aspect (even
 *   dims), and caps fps.
 */
export function buildTranscodeAction(
  v: VideoStreamInfo,
  profile: DeviceProfile,
  opts: { forceH264?: boolean } = {},
): { action: TranscodeAction; reasons: string[] } {
  const reasons: string[] = [];
  const hasHevc = !!profile.video.hevc;
  const useHevc = !opts.forceH264 && hasHevc && (v.bitDepth >= 10 || v.width >= 3840);
  const caps = useHevc ? profile.video.hevc! : profile.video.h264;

  const action: TranscodeAction = {
    kind: 'transcode',
    encoder: useHevc ? 'hevc_videotoolbox' : 'h264_videotoolbox',
    quality: 50,
  };

  if (useHevc && v.bitDepth >= 10) {
    action.profile = 'main10';
    action.pixFmt = 'p010le';
    reasons.push('transcoding to HEVC Main 10 (p010le) to preserve 10-bit');
  } else {
    reasons.push(`transcoding to ${useHevc ? 'HEVC' : 'H.264'} (VideoToolbox)`);
  }

  // Downscale preserving aspect if the source exceeds the target's max dims.
  if (v.width > 0 && v.height > 0 && (v.width > caps.maxW || v.height > caps.maxH)) {
    const ratio = Math.min(caps.maxW / v.width, caps.maxH / v.height);
    let w = Math.floor(v.width * ratio);
    let h = Math.floor(v.height * ratio);
    w -= w % 2;
    h -= h % 2;
    action.scale = { w, h };
    reasons.push(`downscaling ${v.width}x${v.height} -> ${w}x${h}`);
  }

  if (v.fps > caps.maxFps + FPS_SLOP) {
    action.maxFps = caps.maxFps;
    reasons.push(`capping ${v.fps}fps -> ${caps.maxFps}fps`);
  }

  return { action, reasons };
}

/**
 * Apply the HDR policy gate. Returns the resolved HdrOutcome, may add reasons,
 * or asks the caller to refuse (typed error thrown in decision.ts).
 */
function hdrGate(
  v: VideoStreamInfo,
  profile: DeviceProfile,
  prefs: PlaybackPrefs,
  reasons: string[],
): { refuse: string } | { outcome: HdrOutcome } {
  const hdr = v.hdr;
  if (hdr.type === 'none') return { outcome: 'preserved' };

  // Dolby Vision.
  if (hdr.type === 'dovi') {
    const p = hdr.doviProfile ?? 7;
    if (p === 5) {
      if (!profile.hdr.dv) {
        return {
          refuse:
            'Dolby Vision Profile 5 on a device without DV support would render as green/purple garbage',
        };
      }
      reasons.push('Dolby Vision Profile 5 preserved (device supports DV)');
      return { outcome: 'preserved' };
    }
    // P7 / P8: fall through to the HDR10 base-layer path.
    reasons.push('DV P7/P8 → HDR10 base layer');
  }

  // hdr10 / hlg (including DV P7/P8 mapped above).
  if (!profile.hdr.hdr10) {
    if (prefs.hdrPolicy === 'block') {
      return { refuse: `HDR (${hdr.type}) not supported by device and hdrPolicy=block` };
    }
    reasons.push(`HDR (${hdr.type}) not supported by device; proceeding with washout warning`);
    return { outcome: 'washed-out-warning' };
  }
  reasons.push(`HDR (${hdr.type}) preserved (device supports HDR10)`);
  return { outcome: 'preserved' };
}

/**
 * The base video verdict: copy vs transcode vs refuse, independent of delivery
 * method. HLS-only copy restrictions are layered on later by decision.ts.
 */
export function decideVideoBase(
  v: VideoStreamInfo,
  profile: DeviceProfile,
  prefs: PlaybackPrefs,
): VideoBaseVerdict {
  const reasons: string[] = [];

  // Codecs no Cast device decodes, or bit-depth traps → always transcode.
  const hardTranscode =
    v.codec === 'mpeg4' || v.codec === 'mpeg2' || v.codec === 'other'
      ? `${v.codec} is not decodable by any Cast device`
      : v.codec === 'h264' && v.bitDepth === 10
        ? 'H.264 High 10 (Hi10P) is not hardware-decodable'
        : null;

  let mustTranscode = hardTranscode;
  if (!mustTranscode) {
    // Native capability check.
    mustTranscode = capabilityCheck(v, profile);
  }

  // HDR gate runs regardless (it can refuse even when the codec is copyable).
  const gate = hdrGate(v, profile, prefs, reasons);
  if ('refuse' in gate) return { kind: 'refuse', reason: gate.refuse };
  const hdrOutcome = gate.outcome;

  if (prefs.forceTranscode) {
    mustTranscode ??= 'forceTranscode requested';
  }

  if (mustTranscode) {
    reasons.unshift(`video: ${mustTranscode}`);
    const { action, reasons: tReasons } = buildTranscodeAction(v, profile);
    return { kind: 'transcode', action, hdrOutcome, reasons: [...reasons, ...tReasons] };
  }

  reasons.unshift(`video: ${v.codec} within device capability; copy`);
  return { kind: 'copy', hdrOutcome, reasons };
}
