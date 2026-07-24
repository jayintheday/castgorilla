/**
 * ffprobe.ts — low-level ffprobe invocation + the public probe() entry point.
 *
 * Runs `ffprobe -v error -print_format json -show_format -show_streams` and
 * hands the raw JSON to the pure parser in media-info.ts. Handles the one bit of
 * I/O the parser cannot: a targeted second probe of the first video frame to
 * recover HDR transfer characteristics when the container omits them at the
 * stream level (bt2020 content with color_trc unset/unknown).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpeg, type FfmpegTools } from '../ffmpeg/binary.js';
import type { MediaInfo } from '../types/media.js';
import { parseMediaInfo, type FfprobeOutput, type RawStream } from './media-info.js';

const execFileAsync = promisify(execFile);

/** ffprobe JSON can be large (long files with many packets); give it headroom. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Cache the resolved ffmpeg tools. resolveFfmpeg() validates version + encoders
 * on every call (two child spawns); probing many files should not pay that tax
 * repeatedly. The cache holds the in-flight promise so concurrent callers share
 * one resolution.
 */
let toolsPromise: Promise<FfmpegTools> | undefined;

/** Resolve (and cache) the ffprobe binary path via the shared ffmpeg resolver. */
export async function getFfprobe(): Promise<string> {
  toolsPromise ??= resolveFfmpeg();
  return (await toolsPromise).ffprobe;
}

/** Run ffprobe with the given args and return stdout. */
export async function runFfprobe(args: string[]): Promise<string> {
  const ffprobe = await getFfprobe();
  const { stdout } = await execFileAsync(ffprobe, args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Run the standard format+streams probe and parse the JSON. */
export async function probeRaw(filePath: string): Promise<FfprobeOutput> {
  const out = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return JSON.parse(out) as FfprobeOutput;
}

/**
 * Does this video stream need a frame-level HDR probe? Only when the stream
 * omits its transfer characteristic (missing or 'unknown') AND the content is
 * flagged bt2020 — the fingerprint of PQ/HLG content that some muxers leave off
 * the stream header but stamp on the first frame's side data.
 */
function needsFrameHdrProbe(s: RawStream): boolean {
  const trc = (s.color_transfer ?? '').toLowerCase();
  if (trc && trc !== 'unknown') return false;
  const primaries = (s.color_primaries ?? '').toLowerCase();
  const space = (s.color_space ?? '').toLowerCase();
  return primaries === 'bt2020' || space.startsWith('bt2020');
}

interface RawFrame {
  color_transfer?: string;
  side_data_list?: { side_data_type?: string }[];
}

/**
 * Second targeted probe: read the first frame of the given (absolute) stream
 * index and return its color_transfer, if the container carried transfer info
 * at frame level rather than stream level. Best-effort — returns undefined on
 * any failure so probing degrades to the stream-level verdict.
 */
async function probeFrameColorTransfer(
  filePath: string,
  streamIndex: number,
): Promise<string | undefined> {
  try {
    const out = await runFfprobe([
      '-v',
      'error',
      '-read_intervals',
      '%+#1',
      '-select_streams',
      String(streamIndex),
      '-show_frames',
      '-show_entries',
      'frame=color_transfer,side_data_list',
      '-print_format',
      'json',
      filePath,
    ]);
    const parsed = JSON.parse(out) as { frames?: RawFrame[] };
    const frame = parsed.frames?.[0];
    if (!frame) return undefined;
    const trc = (frame.color_transfer ?? '').toLowerCase();
    if (trc && trc !== 'unknown') return trc;
    // No frame-level transfer, but mastering-display / light-level metadata is a
    // strong HDR10 (PQ) signal; report smpte2084 so detection lights up.
    for (const sd of frame.side_data_list ?? []) {
      const t = (sd.side_data_type ?? '').toLowerCase();
      if (t.includes('mastering display') || t.includes('content light level')) {
        return 'smpte2084';
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe a local media file into a normalized MediaInfo.
 *
 * Runs the standard format+streams probe, then — only for video streams whose
 * HDR transfer is unresolved but flagged bt2020 — fills it in from a frame-level
 * probe before parsing.
 *
 * The incoming path is RESOLVED TO ABSOLUTE first, and the absolute form is what
 * gets stamped onto MediaInfo.path. This is the single boundary every caller
 * (CLI probe/play, Electron app, PlaybackSession) passes through, and downstream
 * consumers are not cwd-safe:
 *  - the HLS ffmpeg runs with `cwd = workDir` (a temp dir — see ffmpeg/args.ts
 *    "Path model"), so a relative `-i` resolves against that temp dir and dies
 *    instantly with "No such file or directory"; the segment waiters then burn
 *    the full 30s timeout and the receiver just spins ("loading forever").
 *  - sidecar-subtitle discovery keys off dirname(media.path).
 */
export async function probe(filePath: string): Promise<MediaInfo> {
  const absPath = path.resolve(filePath);
  const raw = await probeRaw(absPath);
  for (const s of raw.streams ?? []) {
    if (s.codec_type !== 'video') continue;
    if (needsFrameHdrProbe(s)) {
      const trc = await probeFrameColorTransfer(absPath, s.index);
      if (trc) s.color_transfer = trc;
    }
  }
  return parseMediaInfo(raw, absPath);
}
