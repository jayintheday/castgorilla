/**
 * plan.ts — FROZEN CONTRACT
 *
 * PlaybackPlan is the output of the planner (WS2): a fully-resolved recipe the
 * preparer/streamer (WS3) executes to get bytes onto the device. VideoAction /
 * AudioAction encode the exact ffmpeg intent per stream.
 */

/** What to do with the video stream. */
export type VideoAction =
  | {
      kind: 'copy';
      /** Force the 'hvc1' tag on copied HEVC so Cast/Safari recognizes it (vs 'hev1'). */
      tag?: 'hvc1';
    }
  | {
      kind: 'transcode';
      encoder: 'h264_videotoolbox' | 'hevc_videotoolbox';
      /** Only set when producing 10-bit HDR output. */
      profile?: 'main10';
      /** Only set when producing 10-bit output. */
      pixFmt?: 'p010le';
      /** Encoder quality knob (VideoToolbox -q:v scale, roughly 1..100). */
      quality: number;
      scale?: { w: number; h: number };
      maxFps?: number;
    };

/** What to do with the audio stream. */
export type AudioAction =
  | { kind: 'copy' }
  | {
      kind: 'transcode';
      encoder: 'aac_at' | 'eac3';
      /** ffmpeg bitrate string, e.g. '256k', '640k'. */
      bitrate: string;
      /** 2 = stereo downmix, 6 = 5.1. */
      channels: 2 | 6;
      /** Extra ffmpeg audio filters (e.g. loudness normalization). */
      filters?: string[];
    };

export type PlaybackMethod = 'direct' | 'hls';

/**
 * Tier of intervention, cheapest first:
 * - direct: play the file bytes as-is
 * - remux: repackage container, no re-encode
 * - audio-transcode: re-encode audio only, copy video
 * - video-transcode: re-encode video (the expensive path)
 */
export type PlaybackTier = 'direct' | 'remux' | 'audio-transcode' | 'video-transcode';

export type SegmentFormat = 'fmp4' | 'ts';

export interface SegmentationPlan {
  mode: 'keyframe' | 'fixed';
  targetSec: 6;
  /** Explicit segment boundary timestamps (seconds), when mode === 'keyframe'. */
  boundaries?: number[];
}

/** Outcome of applying the HDR policy to this plan. */
export type HdrOutcome = 'preserved' | 'washed-out-warning' | 'refused';

export interface SubtitlePlanEntry {
  trackId: number;
  /** URL the device will fetch the (WebVTT) subtitle track from. */
  url: string;
  language?: string;
  label: string;
  source: 'embedded' | 'sidecar';
}

export interface PlaybackPlan {
  method: PlaybackMethod;
  tier: PlaybackTier;
  /** Human-readable justifications for why this plan was chosen. */
  reasons: string[];
  video: VideoAction;
  audio: AudioAction;
  /** ffprobe absolute index of the chosen video stream. */
  videoStreamIndex: number;
  /** ffprobe absolute index of the chosen audio stream. */
  audioStreamIndex: number;
  segmentation?: SegmentationPlan;
  segmentFormat?: SegmentFormat;
  /** MIME content type presented to the device for the primary media. */
  contentType: string;
  durationSec: number;
  hdrOutcome: HdrOutcome;
  subtitles: SubtitlePlanEntry[];
}

export interface PlaybackPrefs {
  /** Attempt surround (multichannel) rather than a stereo downmix. */
  surround: boolean;
  /** 'warn' = preserve HDR but warn about washout on SDR sinks; 'block' = refuse HDR-lossy paths. */
  hdrPolicy: 'warn' | 'block';
  preferredAudioLang?: string;
  preferredSubLang?: string;
  /** Force the video-transcode path even when direct/remux would work. */
  forceTranscode?: boolean;
}
