/**
 * hls/boundaries.ts — segment boundary math.
 *
 * A "boundary" is the absolute start time (seconds) of a segment; boundaries are
 * index-aligned with segment numbers (boundaries[i] = start of seg<i>). Segment i
 * spans [boundaries[i], boundaries[i+1]) and the final segment runs to duration.
 *
 * Only the FIXED grid lives here. Keyframe-aligned boundaries are produced by
 * another workstream (the planner/decider); this module and everything
 * downstream simply consume a number[].
 */

/**
 * Fixed grid: [0, targetSec, 2*targetSec, …] up to (but not including) duration.
 * A 60s file at 6s → [0,6,12,18,24,30,36,42,48,54] (10 segments; last is [54,60]).
 */
export function fixedBoundaries(durationSec: number, targetSec = 6): number[] {
  if (durationSec <= 0 || targetSec <= 0) return [0];
  const count = Math.max(1, Math.ceil(durationSec / targetSec));
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i * targetSec);
  return out;
}

/** Duration of segment i given the boundary list and the total media duration. */
export function segmentDuration(boundaries: number[], durationSec: number, i: number): number {
  const start = boundaries[i];
  if (start === undefined) return 0;
  const next = boundaries[i + 1] ?? durationSec;
  return Math.max(0, next - start);
}
