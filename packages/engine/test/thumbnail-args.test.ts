/**
 * thumbnail-args: pure unit tests for the still-frame argv builder and the
 * timestamp chooser. No ffmpeg is spawned.
 */

import { describe, it, expect } from 'vitest';
import { buildStillArgs, pickStillTimestamp } from '../src/thumbnail/generate.js';

const INPUT = '/media/movie.mkv';

/** Read the value that follows the first occurrence of `flag`. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildStillArgs', () => {
  it('emits a single-frame MJPEG-to-pipe recipe for the thumb variant', () => {
    const args = buildStillArgs({ input: INPUT, atSec: 30, variant: 'thumb' });

    // Fast input seek BEFORE -i (seek precedes the input in the argv).
    expect(valueAfter(args, '-ss')).toBe('30');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(valueAfter(args, '-i')).toBe(INPUT);

    // First video stream, exactly one frame.
    expect(valueAfter(args, '-map')).toBe('0:v:0');
    expect(valueAfter(args, '-frames:v')).toBe('1');

    // Downscale-to-fit box for the thumb variant, aspect preserved, no upscale.
    const vf = valueAfter(args, '-vf') ?? '';
    expect(vf).toContain("min(320,iw)");
    expect(vf).toContain("min(180,ih)");
    expect(vf).toContain('force_original_aspect_ratio=decrease');

    // MJPEG through image2pipe to stdout.
    expect(valueAfter(args, '-f')).toBe('image2pipe');
    expect(valueAfter(args, '-c:v')).toBe('mjpeg');
    expect(args[args.length - 1]).toBe('pipe:1');

    // A JPEG quality knob is present.
    expect(valueAfter(args, '-q:v')).toBe('3');
  });

  it('uses the larger box (and softer quality) for the backdrop variant', () => {
    const args = buildStillArgs({ input: INPUT, atSec: 12, variant: 'backdrop' });
    const vf = valueAfter(args, '-vf') ?? '';
    expect(vf).toContain('min(960,iw)');
    expect(vf).toContain('min(540,ih)');
    expect(valueAfter(args, '-q:v')).toBe('5');
  });

  it('defaults to the thumb variant when none is given', () => {
    const args = buildStillArgs({ input: INPUT, atSec: 5 });
    const vf = valueAfter(args, '-vf') ?? '';
    expect(vf).toContain('min(320,iw)');
  });

  it('clamps a negative/NaN timestamp to 0', () => {
    expect(valueAfter(buildStillArgs({ input: INPUT, atSec: -5 }), '-ss')).toBe('0');
    expect(valueAfter(buildStillArgs({ input: INPUT, atSec: NaN }), '-ss')).toBe('0');
  });
});

describe('pickStillTimestamp', () => {
  it('honours an explicit atSec when duration is unknown', () => {
    expect(pickStillTimestamp({ atSec: 42 })).toBe(42);
  });

  it('clamps an explicit atSec to just before a known end', () => {
    expect(pickStillTimestamp({ atSec: 500, durationSec: 100 })).toBe(99);
  });

  it('clamps a negative explicit atSec to 0', () => {
    expect(pickStillTimestamp({ atSec: -10 })).toBe(0);
  });

  it('takes ~20% of a known duration, capped at 60s', () => {
    expect(pickStillTimestamp({ durationSec: 100 })).toBeCloseTo(20, 5); // 20% of 100
    expect(pickStillTimestamp({ durationSec: 5400 })).toBe(60); // capped
  });

  it('falls back to a small fixed offset when duration is unknown', () => {
    expect(pickStillTimestamp({})).toBe(15);
    expect(pickStillTimestamp()).toBe(15);
  });

  it('grabs frame 0 for a very short file, even with an explicit atSec', () => {
    expect(pickStillTimestamp({ durationSec: 1.5 })).toBe(0);
    expect(pickStillTimestamp({ atSec: 30, durationSec: 1.5 })).toBe(0);
  });

  it('never returns a negative or non-finite value', () => {
    expect(pickStillTimestamp({ atSec: Number.NEGATIVE_INFINITY })).toBe(15); // non-finite → ignored
    expect(pickStillTimestamp({ durationSec: -100 })).toBe(15); // invalid dur → fixed offset
  });
});
