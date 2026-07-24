/**
 * probe-keyframes.test.ts — keyframe index extraction: correctness + perf.
 *
 * Correctness on a known ~10s-GOP fixture and a shorter-GOP fixture, plus a
 * performance assertion: the 45-minute fixture must extract in well under the
 * <5s budget (asserted at a generous <10s CI margin, with the real time logged).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from '../src/probe/ffprobe.js';
import { extractKeyframeIndex } from '../src/probe/keyframes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIX = path.join(ROOT, 'fixtures');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-fixtures.sh');
const TEN_MIN = 600_000;

function fx(name: string): string {
  return path.join(FIX, name);
}

/** Assert a sorted, deduped, non-negative array starting at/near 0. */
function assertWellFormed(pts: number[]): void {
  expect(pts.length).toBeGreaterThan(0);
  expect(pts[0]!).toBeLessThanOrEqual(0.5); // starts at/near 0
  for (let i = 1; i < pts.length; i++) {
    expect(pts[i]!).toBeGreaterThan(pts[i - 1]!); // strictly ascending (sorted + deduped)
    expect(pts[i]!).toBeGreaterThanOrEqual(0);
  }
}

describe('extractKeyframeIndex', () => {
  beforeAll(() => {
    execFileSync('bash', [SCRIPT], { stdio: 'inherit', timeout: TEN_MIN });
  }, TEN_MIN);

  it('november_mkv-h264-longgop: ~10s keyframe spacing over a 60s clip', async () => {
    const m = await probe(fx('november_mkv-h264-longgop.mkv'));
    const pts = await extractKeyframeIndex(fx('november_mkv-h264-longgop.mkv'), m.video[0]!.index);
    assertWellFormed(pts);
    expect(pts[0]!).toBeCloseTo(0, 2);
    // ~10s spacing → 6 keyframes across [0,50].
    expect(pts.length).toBe(6);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]! - pts[i - 1]!).toBeCloseTo(10, 1);
    }
  });

  it('delta_mkv-h264-aac: keyframes present, well-formed, span the clip', async () => {
    const m = await probe(fx('delta_mkv-h264-aac.mkv'));
    const pts = await extractKeyframeIndex(fx('delta_mkv-h264-aac.mkv'), m.video[0]!.index);
    assertWellFormed(pts);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[pts.length - 1]!).toBeLessThanOrEqual(m.durationSec + 0.1);
  });

  it('PERF: 45-min fixture extracts fast (budget <5s; asserted <10s CI margin)', async () => {
    const m = await probe(fx('foxtrot_mkv-h264-dts-45min.mkv'));
    const t0 = performance.now();
    const pts = await extractKeyframeIndex(fx('foxtrot_mkv-h264-dts-45min.mkv'), m.video[0]!.index);
    const elapsedMs = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[keyframes] 45-min fixture: ${pts.length} keyframes in ${elapsedMs.toFixed(0)}ms`,
    );
    assertWellFormed(pts);
    expect(pts.length).toBeGreaterThan(100);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 20_000);
});
