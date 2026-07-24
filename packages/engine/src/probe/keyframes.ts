/**
 * keyframes.ts — keyframe (I-frame) PTS index extraction.
 *
 * Used by the streamer to place HLS segment boundaries on real keyframes so a
 * copy (no re-encode) segmentation is seekable. Extraction is a pure demux scan
 * (NO decode): ffprobe reads packet headers only, so even a 45-minute file
 * finishes in well under a second.
 *
 * Strategy: `-show_entries packet=pts_time,dts_time,flags -of csv`, keep packets
 * whose flags begin with 'K' (keyframe). Falls back to dts_time when a keyframe
 * packet has no pts_time. Result is ascending, deduped, and starts at/near 0.
 */

import { runFfprobe } from './ffprobe.js';

/**
 * Extract the ascending list of keyframe PTS (seconds) for the given video
 * stream (absolute ffprobe index).
 */
export async function extractKeyframeIndex(
  filePath: string,
  videoStreamIndex: number,
): Promise<number[]> {
  const out = await runFfprobe([
    '-v',
    'error',
    '-select_streams',
    String(videoStreamIndex),
    '-show_entries',
    'packet=pts_time,dts_time,flags',
    '-of',
    'csv',
    filePath,
  ]);

  const times: number[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    // csv rows: "packet,<pts_time>,<dts_time>,<flags>"
    const parts = line.split(',');
    if (parts[0] !== 'packet') continue;
    const flags = parts[3] ?? '';
    if (flags.charAt(0) !== 'K') continue; // keyframe flag is the leading char
    const pts = parts[1];
    const dts = parts[2];
    let t = Number(pts);
    if (!Number.isFinite(t) || pts === 'N/A' || pts === undefined) {
      t = Number(dts);
    }
    if (Number.isFinite(t)) times.push(t);
  }

  times.sort((a, b) => a - b);
  // Dedupe (adjacent equal timestamps can appear at container boundaries).
  const out2: number[] = [];
  for (const t of times) {
    if (out2.length === 0 || out2[out2.length - 1] !== t) out2.push(t);
  }
  return out2;
}
