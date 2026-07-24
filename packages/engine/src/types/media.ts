/**
 * media.ts — FROZEN CONTRACT
 *
 * Probe output: the normalized description of a local media file, produced by
 * the engine's ffprobe wrapper. Every downstream decision (planning, casting,
 * subtitle handling) reads from these shapes. Do not rename fields.
 */

export type MediaContainer = 'mp4' | 'mkv' | 'webm' | 'mov' | 'ts' | 'avi' | 'other';

export type VideoCodec =
  | 'h264'
  | 'hevc'
  | 'vp8'
  | 'vp9'
  | 'av1'
  | 'mpeg4'
  | 'mpeg2'
  | 'other';

export type AudioCodec =
  | 'aac'
  | 'ac3'
  | 'eac3'
  | 'dts'
  | 'truehd'
  | 'flac'
  | 'mp3'
  | 'opus'
  | 'vorbis'
  | 'pcm'
  | 'other';

export type SubtitleCodec =
  | 'subrip'
  | 'ass'
  | 'mov_text'
  | 'webvtt'
  | 'hdmv_pgs'
  | 'dvd_sub'
  | 'other';

export type HdrType = 'none' | 'hdr10' | 'hlg' | 'dovi';

/** Dolby Vision profile number, when hdr.type === 'dovi'. */
export type DoviProfile = 5 | 7 | 8;

export interface HdrInfo {
  type: HdrType;
  /** Present only for Dolby Vision streams. */
  doviProfile?: DoviProfile;
}

export interface VideoStreamInfo {
  /** ffprobe stream index (absolute, across all streams in the file). */
  index: number;
  codec: VideoCodec;
  /** Codec profile string as reported by ffprobe, e.g. 'High', 'Main 10'. */
  profile?: string;
  /** Codec level, e.g. 41 for H.264 Level 4.1 (level number * 10, no dot). */
  level?: number;
  width: number;
  height: number;
  /** Frames per second (may be fractional, e.g. 23.976). */
  fps: number;
  bitDepth: 8 | 10 | 12;
  hdr: HdrInfo;
}

export interface AudioStreamInfo {
  /** ffprobe stream index (absolute). */
  index: number;
  codec: AudioCodec;
  channels: number;
  /** ffmpeg channel layout string, e.g. 'stereo', '5.1', '5.1(side)'. */
  channelLayout: string;
  sampleRate: number;
  /** ISO 639 language tag when present in stream metadata. */
  language?: string;
  title?: string;
  isDefault: boolean;
}

export interface SubtitleStreamInfo {
  /** ffprobe stream index (absolute). */
  index: number;
  codec: SubtitleCodec;
  /** True for text-based formats (subrip/ass/webvtt/mov_text); false for bitmap (pgs/dvd_sub). */
  isText: boolean;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
}

export interface MediaInfo {
  /** Absolute path to the source file on disk. */
  path: string;
  container: MediaContainer;
  durationSec: number;
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
}
