/**
 * hls-boundaries: fixed grid + segment duration math (pure).
 */
import { describe, it, expect } from 'vitest';
import { fixedBoundaries, segmentDuration } from '../src/hls/boundaries.js';

describe('fixedBoundaries', () => {
  it('60s @ 6s → [0,6,…,54] (10 segments)', () => {
    expect(fixedBoundaries(60, 6)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
  });

  it('a partial final segment still gets a boundary', () => {
    // 61s → 11 segments, last is [60,61]
    const b = fixedBoundaries(61, 6);
    expect(b).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60]);
  });

  it('exact multiple does not add a trailing empty segment', () => {
    expect(fixedBoundaries(6, 6)).toEqual([0]);
    expect(fixedBoundaries(12, 6)).toEqual([0, 6]);
  });

  it('sub-target and zero durations degrade to [0]', () => {
    expect(fixedBoundaries(5, 6)).toEqual([0]);
    expect(fixedBoundaries(0, 6)).toEqual([0]);
  });
});

describe('segmentDuration', () => {
  const b = fixedBoundaries(60, 6);
  it('interior segments are targetSec', () => {
    expect(segmentDuration(b, 60, 0)).toBe(6);
    expect(segmentDuration(b, 60, 5)).toBe(6);
  });
  it('final segment runs to duration', () => {
    // last boundary is 54 → [54,60] = 6
    expect(segmentDuration(b, 60, 9)).toBe(6);
    // uneven: duration 58, last boundary 54 → [54,58]=4
    expect(segmentDuration(b, 58, 9)).toBe(4);
  });
});
