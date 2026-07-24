/**
 * media-info.ts — pure ffprobe-JSON → MediaInfo parsing.
 *
 * No I/O: takes the parsed ffprobe JSON (streams + format) plus the source path
 * and produces the normalized, frozen MediaInfo shape. Every quirk of ffprobe's
 * output (comma-lists, string numbers, sentinel levels, side-channel HDR
 * metadata) is normalized here so downstream code reads clean enums.
 */

import path from 'node:path';
import type {
  AudioCodec,
  AudioStreamInfo,
  HdrInfo,
  MediaContainer,
  MediaInfo,
  SubtitleCodec,
  SubtitleStreamInfo,
  VideoCodec,
  VideoStreamInfo,
  DoviProfile,
} from '../types/media.js';

// --- Raw ffprobe JSON shapes (only the fields we read) ---------------------

export interface RawSideData {
  side_data_type?: string;
  dv_profile?: number;
  [k: string]: unknown;
}

export interface RawDisposition {
  default?: number;
  forced?: number;
  [k: string]: unknown;
}

export interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  duration?: string;
  disposition?: RawDisposition;
  tags?: Record<string, string>;
  side_data_list?: RawSideData[];
}

export interface RawFormat {
  format_name?: string;
  duration?: string;
}

export interface FfprobeOutput {
  streams?: RawStream[];
  format?: RawFormat;
}

// --- Small helpers ----------------------------------------------------------

/** Case-insensitive tag lookup (mkv often uppercases LANGUAGE/TITLE). */
function tag(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return undefined;
  const lower = key.toLowerCase();
  for (const k of Object.keys(tags)) {
    if (k.toLowerCase() === lower) {
      const v = tags[k];
      return v && v.length > 0 ? v : undefined;
    }
  }
  return undefined;
}

/** Parse an ffprobe "num/den" rational to a number; 0 on div-by-zero/garbage. */
function parseRational(r: string | undefined): number {
  if (!r) return 0;
  const [nStr, dStr] = r.split('/');
  const n = Number(nStr);
  const d = dStr === undefined ? 1 : Number(dStr);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** Round to 3 decimals so 24000/1001 reads as 23.976 rather than a long tail. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// --- Container --------------------------------------------------------------

export function parseContainer(formatName: string | undefined, filePath: string): MediaContainer {
  const names = new Set((formatName ?? '').split(',').map((s) => s.trim().toLowerCase()));
  const ext = path.extname(filePath).toLowerCase();
  // mov/mp4 family: 'mov,mp4,m4a,3gp,3g2,mj2'
  if (names.has('mp4') || names.has('mov') || names.has('m4a')) {
    return ext === '.mov' ? 'mov' : 'mp4';
  }
  // matroska/webm family: 'matroska,webm'
  if (names.has('matroska') || names.has('webm')) {
    return ext === '.webm' ? 'webm' : 'mkv';
  }
  if (names.has('mpegts')) return 'ts';
  if (names.has('avi')) return 'avi';
  return 'other';
}

// --- Video ------------------------------------------------------------------

function mapVideoCodec(name: string | undefined): VideoCodec {
  switch (name) {
    case 'h264':
      return 'h264';
    case 'hevc':
      return 'hevc';
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return 'vp9';
    case 'av1':
      return 'av1';
    case 'mpeg4':
      return 'mpeg4';
    case 'mpeg2video':
    case 'mpeg2':
      return 'mpeg2';
    default:
      return 'other';
  }
}

function bitDepthFromPixFmt(pixFmt: string | undefined, profile: string | undefined): 8 | 10 | 12 {
  const p = (pixFmt ?? '').toLowerCase();
  let depth: 8 | 10 | 12 = 8;
  if (/10(le|be)/.test(p)) depth = 10;
  else if (p.includes('12')) depth = 12;
  const prof = profile ?? '';
  if (depth < 10 && (prof === 'Main 10' || prof === 'High 10')) depth = 10;
  return depth;
}

function detectHdr(s: RawStream): HdrInfo {
  // Dolby Vision configuration record wins over any PQ transfer flag.
  for (const sd of s.side_data_list ?? []) {
    if ((sd.side_data_type ?? '').toLowerCase().includes('dovi configuration record')) {
      const raw = typeof sd.dv_profile === 'number' ? sd.dv_profile : 7;
      const doviProfile: DoviProfile = raw === 5 ? 5 : raw === 8 ? 8 : 7;
      return { type: 'dovi', doviProfile };
    }
  }
  const trc = (s.color_transfer ?? '').toLowerCase();
  if (trc === 'smpte2084') return { type: 'hdr10' };
  if (trc === 'arib-std-b67') return { type: 'hlg' };
  return { type: 'none' };
}

function parseVideoStream(s: RawStream): VideoStreamInfo {
  let fps = parseRational(s.avg_frame_rate);
  if (fps <= 0) fps = parseRational(s.r_frame_rate);
  const level = typeof s.level === 'number' && s.level > 0 ? s.level : undefined;
  const info: VideoStreamInfo = {
    index: s.index,
    codec: mapVideoCodec(s.codec_name),
    width: typeof s.width === 'number' ? s.width : 0,
    height: typeof s.height === 'number' ? s.height : 0,
    fps: round3(fps),
    bitDepth: bitDepthFromPixFmt(s.pix_fmt, s.profile),
    hdr: detectHdr(s),
  };
  if (s.profile !== undefined) info.profile = s.profile;
  if (level !== undefined) info.level = level;
  return info;
}

// --- Audio ------------------------------------------------------------------

function mapAudioCodec(name: string | undefined): AudioCodec {
  if (!name) return 'other';
  if (name === 'dca') return 'dts';
  if (name.startsWith('pcm')) return 'pcm';
  switch (name) {
    case 'aac':
    case 'ac3':
    case 'eac3':
    case 'dts':
    case 'truehd':
    case 'flac':
    case 'mp3':
    case 'opus':
    case 'vorbis':
      return name;
    default:
      return 'other';
  }
}

function parseAudioStream(s: RawStream): AudioStreamInfo {
  const info: AudioStreamInfo = {
    index: s.index,
    codec: mapAudioCodec(s.codec_name),
    channels: typeof s.channels === 'number' ? s.channels : 0,
    channelLayout: s.channel_layout ?? 'unknown',
    sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) || 0 : 0,
    isDefault: s.disposition?.default === 1,
  };
  const language = tag(s.tags, 'language');
  const title = tag(s.tags, 'title');
  if (language !== undefined) info.language = language;
  if (title !== undefined) info.title = title;
  return info;
}

// --- Subtitles --------------------------------------------------------------

function mapSubtitleCodec(name: string | undefined): SubtitleCodec {
  switch (name) {
    case 'subrip':
      return 'subrip';
    case 'ass':
    case 'ssa':
      return 'ass';
    case 'mov_text':
      return 'mov_text';
    case 'webvtt':
      return 'webvtt';
    case 'hdmv_pgs_subtitle':
      return 'hdmv_pgs';
    case 'dvd_subtitle':
      return 'dvd_sub';
    default:
      return 'other';
  }
}

function parseSubtitleStream(s: RawStream): SubtitleStreamInfo {
  const codec = mapSubtitleCodec(s.codec_name);
  const isText = !(codec === 'hdmv_pgs' || codec === 'dvd_sub' || codec === 'other');
  const info: SubtitleStreamInfo = {
    index: s.index,
    codec,
    isText,
    isDefault: s.disposition?.default === 1,
    isForced: s.disposition?.forced === 1,
  };
  const language = tag(s.tags, 'language');
  const title = tag(s.tags, 'title');
  if (language !== undefined) info.language = language;
  if (title !== undefined) info.title = title;
  return info;
}

// --- Duration ---------------------------------------------------------------

function parseDuration(raw: FfprobeOutput): number {
  const fmt = Number(raw.format?.duration);
  if (Number.isFinite(fmt) && fmt > 0) return fmt;
  let max = 0;
  for (const s of raw.streams ?? []) {
    const d = Number(s.duration);
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}

// --- Top-level parse --------------------------------------------------------

/** Parse raw ffprobe JSON (already frame-HDR-merged) into MediaInfo. */
export function parseMediaInfo(raw: FfprobeOutput, filePath: string): MediaInfo {
  const streams = raw.streams ?? [];
  const video: VideoStreamInfo[] = [];
  const audio: AudioStreamInfo[] = [];
  const subtitles: SubtitleStreamInfo[] = [];
  for (const s of streams) {
    switch (s.codec_type) {
      case 'video':
        // Skip attached-pic "video" streams (cover art) — they are not playable video.
        if (s.disposition?.['attached_pic'] === 1) continue;
        video.push(parseVideoStream(s));
        break;
      case 'audio':
        audio.push(parseAudioStream(s));
        break;
      case 'subtitle':
        subtitles.push(parseSubtitleStream(s));
        break;
      default:
        break;
    }
  }
  return {
    path: filePath,
    container: parseContainer(raw.format?.format_name, filePath),
    durationSec: parseDuration(raw),
    video,
    audio,
    subtitles,
  };
}
