/**
 * decide-boundaries.test.ts — boundary-math unit tests.
 *
 * Pure, no fixtures. computeBoundaries (copy tiers): grid-to-keyframe snapping,
 * mandatory 0 inclusion, dedupe of both input keyframes and snapped duplicates,
 * custom targetSec. computeTranscodeBoundaries (video-transcode tier): the
 * minimum-spacing guarantee the HLS muxer's split rule depends on.
 */
import { describe, it, expect } from 'vitest';
import { computeBoundaries, computeTranscodeBoundaries } from '../src/decide/decision.js';

describe('computeBoundaries', () => {
  it('snaps a clean 6s grid to the matching keyframes (no trailing end boundary)', () => {
    const kf = [0, 6, 12, 18, 24, 30];
    expect(computeBoundaries(kf, 30, 6)).toEqual([0, 6, 12, 18, 24]);
  });

  it('picks the nearest keyframe to each grid point when keyframes are off-grid', () => {
    const kf = [0, 5, 7, 11, 13, 19];
    // grid 0,6,12,18 → nearest 0, {5|7}, {11|13}, 19
    const b = computeBoundaries(kf, 24, 6);
    expect(b[0]).toBe(0);
    expect(b).toEqual([...b].sort((a, c) => a - c)); // ascending
    expect(new Set(b).size).toBe(b.length); // unique
  });

  it('always includes 0 even when the first keyframe is later', () => {
    const kf = [3, 9, 15, 21];
    const b = computeBoundaries(kf, 24, 6);
    expect(b[0]).toBe(0);
    expect(b).toEqual([0, 3, 9, 15, 21]);
  });

  it('dedupes repeated input keyframes', () => {
    const kf = [0, 0, 6, 6, 6, 12];
    expect(computeBoundaries(kf, 12, 6)).toEqual([0, 6]);
  });

  it('dedupes when a long GOP snaps many grid points to the same keyframe', () => {
    const kf = [0, 20, 40];
    expect(computeBoundaries(kf, 42, 6)).toEqual([0, 20, 40]);
  });

  it('honors a custom targetSec', () => {
    const kf = [0, 3, 6, 9, 12];
    expect(computeBoundaries(kf, 12, 3)).toEqual([0, 3, 6, 9]);
  });

  it('returns [0] for an empty keyframe list', () => {
    expect(computeBoundaries([], 60, 6)).toEqual([0]);
  });

  it('defaults targetSec to 6', () => {
    const kf = [0, 6, 12, 18];
    expect(computeBoundaries(kf, 18)).toEqual([0, 6, 12]);
  });
});

describe('computeTranscodeBoundaries', () => {
  it('every boundary is a real source keyframe', () => {
    // The whole point: a seek-restart enters the file at a source keyframe
    // whatever the plan says, so a boundary that is not one can never be an
    // entry point and `-start_number` would mislabel the run.
    const kf = [0, 2.1, 4.8, 7.3, 9.6, 14.2, 16.9, 21.4, 25.0];
    const b = computeTranscodeBoundaries(kf, 30, 6);
    for (const t of b.slice(1)) expect(kf).toContain(t);
  });

  it('never emits a gap below targetSec (the muxer would merge those segments)', () => {
    // Measured muxer rule: a segment ends at the first keyframe >= hls_time * n
    // from the run start. A boundary closer than that to its predecessor is
    // skipped, and two playlist entries collapse into one file.
    const kf = Array.from({ length: 200 }, (_, i) => Number((i * 0.7).toFixed(3)));
    const b = computeTranscodeBoundaries(kf, 140, 6);
    for (let i = 1; i < b.length; i++) expect(b[i]! - b[i - 1]!).toBeGreaterThanOrEqual(6);
  });

  it('contrast with computeBoundaries: nearest-snap CAN go below targetSec', () => {
    // Not a hypothetical — this is why the transcode tier needs its own rule
    // rather than reusing the copy tier's.
    const kf = [0, 4.8, 9.6, 14.4, 19.2, 24];
    const snapped = computeBoundaries(kf, 30, 6);
    const minSnappedGap = Math.min(...snapped.slice(1).map((t, i) => t - snapped[i]!));
    expect(minSnappedGap).toBeLessThan(6);

    const greedy = computeTranscodeBoundaries(kf, 30, 6);
    expect(greedy).toEqual([0, 9.6, 19.2]);
  });

  it('always starts at 0 — the initial run has no -ss and begins at the first frame', () => {
    expect(computeTranscodeBoundaries([3.5, 10, 20], 30, 6)[0]).toBe(0);
    expect(computeTranscodeBoundaries([], 60, 6)).toEqual([0]);
  });

  it('a pathological GOP yields one long segment rather than an unreachable boundary', () => {
    // Accepted cost, asserted rather than hidden: subdividing this 20s gap would
    // mean a boundary that is not a source keyframe, i.e. the original defect.
    expect(computeTranscodeBoundaries([0, 6, 26, 32], 40, 6)).toEqual([0, 6, 26, 32]);
  });

  it('drops keyframes at or past the duration (they would size a zero-length segment)', () => {
    expect(computeTranscodeBoundaries([0, 6, 12, 18], 12, 6)).toEqual([0, 6]);
  });

  it('dedupes repeated input keyframes and defaults targetSec to 6', () => {
    expect(computeTranscodeBoundaries([0, 0, 6, 6, 6, 12], 18)).toEqual([0, 6, 12]);
  });
});
