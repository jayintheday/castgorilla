/**
 * hls/playlist.ts — synthesize a VOD HLS playlist.
 *
 * We do NOT serve ffmpeg's own live playlist. Because ffmpeg is (re)started on
 * demand at arbitrary boundaries, its playlist only ever describes the segments
 * it has emitted so far. Instead we synthesize the COMPLETE VOD playlist up front
 * from the boundary list + total duration, so the Cast device sees the whole
 * timeline immediately and can seek anywhere (each seek → a getSegment() the
 * session satisfies on demand).
 *
 * Pure + golden-file tested.
 */

import type { SegmentFormat } from '../types/index.js';
import { INIT_SEGMENT_NAME, segmentName } from '../ffmpeg/args.js';
import { segmentDuration } from './boundaries.js';

/** Fixed-point seconds, ffmpeg-style (6 decimals) — e.g. 6 → "6.000000". */
function extinf(sec: number): string {
  return sec.toFixed(6);
}

/**
 * Build a full VOD m3u8.
 *
 * @param boundaries      absolute segment start times, index-aligned with seg numbers
 * @param durationSec     total media duration (bounds the final segment)
 * @param segmentFormat   'fmp4' (adds #EXT-X-MAP + init.mp4, version 7) or 'ts' (version 3)
 * @param urlPrefix       prepended to each segment/init URI ('' → relative to the playlist URL)
 */
export function synthesizeVodPlaylist(
  boundaries: number[],
  durationSec: number,
  segmentFormat: SegmentFormat,
  urlPrefix = '',
): string {
  const isFmp4 = segmentFormat === 'fmp4';
  const n = boundaries.length;

  const durations: number[] = [];
  for (let i = 0; i < n; i++) durations.push(segmentDuration(boundaries, durationSec, i));
  const targetDuration = Math.max(1, Math.ceil(Math.max(0, ...durations)));

  const lines: string[] = [];
  lines.push('#EXTM3U');
  // v7: required for fmp4 (#EXT-X-MAP). ts can be v3.
  lines.push(`#EXT-X-VERSION:${isFmp4 ? 7 : 3}`);
  lines.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
  lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (isFmp4) {
    lines.push(`#EXT-X-MAP:URI="${urlPrefix}${INIT_SEGMENT_NAME}"`);
  }

  for (let i = 0; i < n; i++) {
    lines.push(`#EXTINF:${extinf(durations[i] ?? 0)},`);
    lines.push(`${urlPrefix}${segmentName(i, segmentFormat)}`);
  }

  lines.push('#EXT-X-ENDLIST');
  // Trailing newline — some strict clients expect the file to end with one.
  return lines.join('\n') + '\n';
}
