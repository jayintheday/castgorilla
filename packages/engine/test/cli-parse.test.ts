/**
 * cli-parse — unit tests for the CLI's pure helpers (timecode / volume / hdr
 * parsing) and the `probe --json` payload shape built from a real fixture probe.
 *
 * Imports the CLI source directly (cross-package relative path) so no build step
 * is required and the pure helpers are exercised in isolation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTimecode, formatTimecode, parseVolume, parseHdrPolicy, formatPercent } from '../../cli/src/parse.js';
import { buildProbeJson } from '../../cli/src/render.js';
import { probe } from '../src/probe/ffprobe.js';
import { buildPlaybackPlan } from '../src/decide/decision.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { MediaInfo } from '../src/types/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

describe('cli parse helpers', () => {
  it('parseTimecode: seconds, mm:ss, hh:mm:ss', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('90.5')).toBe(90.5);
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('0:00')).toBe(0);
    expect(parseTimecode('1:23:45')).toBe(5025);
    expect(parseTimecode('12:34')).toBe(754);
  });

  it('parseTimecode: rejects garbage and out-of-range fields', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:60')).toBeNull(); // seconds field must be < 60
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('1:aa')).toBeNull();
  });

  it('formatTimecode: m:ss under an hour, h:mm:ss over', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(90)).toBe('1:30');
    expect(formatTimecode(3599)).toBe('59:59');
    expect(formatTimecode(3600)).toBe('1:00:00');
    expect(formatTimecode(5025)).toBe('1:23:45');
  });

  it('parseVolume: clamps to 0..1, rejects non-numbers', () => {
    expect(parseVolume('0.4')).toBeCloseTo(0.4);
    expect(parseVolume('2')).toBe(1);
    expect(parseVolume('-1')).toBe(0);
    expect(parseVolume('nope')).toBeNull();
  });

  it('parseHdrPolicy: default warn, validates the enum', () => {
    expect(parseHdrPolicy(undefined)).toBe('warn');
    expect(parseHdrPolicy('warn')).toBe('warn');
    expect(parseHdrPolicy('block')).toBe('block');
    expect(parseHdrPolicy('loud')).toBeNull();
  });

  it('formatPercent: rounds to whole percent', () => {
    expect(formatPercent(0.4)).toBe('40%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('probe --json payload shape', () => {
  let media: MediaInfo;
  beforeAll(async () => {
    media = await probe(path.join(FIX, 'echo_mkv-h264-dts.mkv'));
  });

  it('has stable top-level + plan keys', () => {
    const plan = buildPlaybackPlan(media, PROFILES.unknown, { surround: false, hdrPolicy: 'warn' });
    const json = buildProbeJson(media, plan);

    expect(Object.keys(json).sort()).toEqual(['device', 'file', 'media', 'plan']);
    expect(json.file).toBe(media.path);

    const p = json.plan as Record<string, unknown>;
    for (const key of [
      'method',
      'tier',
      'video',
      'audio',
      'videoStreamIndex',
      'audioStreamIndex',
      'segmentation',
      'segmentFormat',
      'contentType',
      'durationSec',
      'hdrOutcome',
      'reasons',
      'subtitles',
    ]) {
      expect(p, `plan.${key}`).toHaveProperty(key);
    }
    expect(Array.isArray(p.reasons)).toBe(true);
    expect(typeof p.tier).toBe('string');
    expect(p.method).toBe('hls');
  });
});
