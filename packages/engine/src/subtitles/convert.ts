/**
 * subtitles/convert.ts — turn subtitle sources into WebVTT with ffmpeg.
 *
 *  - convertToVtt(): a sidecar srt/ass → WebVTT (`ffmpeg -i in -f webvtt out`).
 *    A `.vtt` input is validated (must carry a WEBVTT header) and copied as-is.
 *  - extractEmbeddedToVtt(): pull one embedded subtitle stream out of a container
 *    to WebVTT (`ffmpeg -i media -map 0:<idx> -f webvtt out`). Works for
 *    subrip / ass / mov_text; a webvtt stream passes straight through.
 *
 * ffmpeg's webvtt muxer strips ASS/SSA inline styling down to plain cue text,
 * which is exactly what a Cast receiver wants.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, copyFile } from 'node:fs/promises';

import { resolveFfmpeg } from '../ffmpeg/binary.js';
import type { SubtitleFormat } from './discover.js';

const execFileAsync = promisify(execFile);

/** ffmpeg can print a fair amount even at -loglevel error; give it room. */
const MAX_BUFFER = 8 * 1024 * 1024;

async function ffmpegBinary(explicit?: string): Promise<string> {
  if (explicit && explicit.length > 0) return explicit;
  return (await resolveFfmpeg()).ffmpeg;
}

/** Throw unless `path` begins with a valid WEBVTT header (optionally BOM-prefixed). */
async function assertWebVttHeader(path: string): Promise<void> {
  const buf = await readFile(path);
  // Strip a leading UTF-8 BOM, then require the "WEBVTT" signature.
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const head = buf.subarray(start, start + 6).toString('utf8');
  if (head !== 'WEBVTT') {
    throw new Error(`not a valid WebVTT file (missing WEBVTT header): ${path}`);
  }
}

/**
 * Convert a sidecar subtitle file to WebVTT at `outPath`.
 * `.vtt` inputs are validated and copied; srt/ass are muxed via ffmpeg.
 */
export async function convertToVtt(
  inputPath: string,
  format: SubtitleFormat,
  outPath: string,
  ffmpeg?: string,
): Promise<void> {
  if (format === 'vtt') {
    await assertWebVttHeader(inputPath);
    await copyFile(inputPath, outPath);
    return;
  }
  const bin = await ffmpegBinary(ffmpeg);
  await execFileAsync(
    bin,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'webvtt', outPath],
    { maxBuffer: MAX_BUFFER },
  );
}

/**
 * Extract embedded subtitle stream `streamIndex` (ffprobe absolute index) from
 * `mediaPath` to WebVTT at `outPath`.
 */
export async function extractEmbeddedToVtt(
  mediaPath: string,
  streamIndex: number,
  outPath: string,
  ffmpeg?: string,
): Promise<void> {
  const bin = await ffmpegBinary(ffmpeg);
  await execFileAsync(
    bin,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-map', `0:${streamIndex}`, '-f', 'webvtt', outPath],
    { maxBuffer: MAX_BUFFER },
  );
}
