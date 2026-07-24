/**
 * probe-media.test.ts — probe() integration over every fixture.
 *
 * Probes each generated fixture and asserts the essential parsed MediaInfo:
 * container, video codec / bitDepth / HDR, audio codec / channels / layout,
 * subtitle codecs + isText, and a positive duration. The HEVC10 fixture gets
 * extra HDR-specific assertions (the whole point of that fixture).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from '../src/probe/ffprobe.js';
import type { MediaInfo } from '../src/types/media.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIX = path.join(ROOT, 'fixtures');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-fixtures.sh');
const TEN_MIN = 600_000;

function fx(name: string): string {
  return path.join(FIX, name);
}

describe('probe() — fixture integration', () => {
  beforeAll(() => {
    // Idempotent: no-op when fixtures already exist.
    execFileSync('bash', [SCRIPT], { stdio: 'inherit', timeout: TEN_MIN });
  }, TEN_MIN);

  it('alpha_mp4-h264-aac: H.264 8-bit SDR + AAC stereo in mp4', async () => {
    const m = await probe(fx('alpha_mp4-h264-aac.mp4'));
    expect(m.container).toBe('mp4');
    expect(m.durationSec).toBeGreaterThan(0);
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.video[0]!.bitDepth).toBe(8);
    expect(m.video[0]!.hdr.type).toBe('none');
    expect(m.video[0]!.width).toBe(1920);
    expect(m.video[0]!.height).toBe(1080);
    expect(m.video[0]!.fps).toBeCloseTo(30, 1);
    expect(m.audio[0]!.codec).toBe('aac');
    expect(m.audio[0]!.channels).toBe(2);
    expect(m.audio[0]!.channelLayout).toBe('stereo');
    expect(m.audio[0]!.sampleRate).toBe(48000);
    expect(m.subtitles).toHaveLength(0);
  });

  it('bravo_mp4-h264-aac-nofaststart: parses identically to the faststart variant', async () => {
    const m = await probe(fx('bravo_mp4-h264-aac-nofaststart.mp4'));
    expect(m.container).toBe('mp4');
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.audio[0]!.codec).toBe('aac');
  });

  it('charlie_mp4-h264-l51-4k: H.264 at 3840x2160', async () => {
    const m = await probe(fx('charlie_mp4-h264-l51-4k.mp4'));
    expect(m.container).toBe('mp4');
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.video[0]!.width).toBe(3840);
    expect(m.video[0]!.height).toBe(2160);
    expect(m.video[0]!.level).toBe(51);
  });

  it('delta_mkv-h264-aac: mkv container, H.264 + AAC stereo', async () => {
    const m = await probe(fx('delta_mkv-h264-aac.mkv'));
    expect(m.container).toBe('mkv');
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.audio[0]!.codec).toBe('aac');
    expect(m.audio[0]!.channels).toBe(2);
  });

  it('echo_mkv-h264-dts: DTS 5.1(side) — layout kept verbatim', async () => {
    const m = await probe(fx('echo_mkv-h264-dts.mkv'));
    expect(m.audio[0]!.codec).toBe('dts');
    expect(m.audio[0]!.channels).toBe(6);
    expect(m.audio[0]!.channelLayout).toBe('5.1(side)');
  });

  it('foxtrot_mkv-h264-dts-45min: long content, duration >= 2600s', async () => {
    const m = await probe(fx('foxtrot_mkv-h264-dts-45min.mkv'));
    expect(m.durationSec).toBeGreaterThanOrEqual(2600);
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.audio[0]!.codec).toBe('dts');
  });

  it('golf_mkv-h264-ac3: AC-3 5.1', async () => {
    const m = await probe(fx('golf_mkv-h264-ac3.mkv'));
    expect(m.audio[0]!.codec).toBe('ac3');
    expect(m.audio[0]!.channels).toBe(6);
  });

  it('hotel_mkv-hevc10-truehd: HEVC Main 10 HDR10 (10-bit) + TrueHD 5.1(side)', async () => {
    const m = await probe(fx('hotel_mkv-hevc10-truehd.mkv'));
    expect(m.container).toBe('mkv');
    const v = m.video[0]!;
    expect(v.codec).toBe('hevc');
    expect(v.profile).toBe('Main 10');
    expect(v.bitDepth).toBe(10);
    expect(v.hdr).toEqual({ type: 'hdr10' });
    expect(m.audio[0]!.codec).toBe('truehd');
    expect(m.audio[0]!.channels).toBe(6);
    expect(m.audio[0]!.channelLayout).toBe('5.1(side)');
  });

  it('kilo_mkv-hevc8-aac: HEVC 8-bit SDR (Main, no HDR)', async () => {
    const m = await probe(fx('kilo_mkv-hevc8-aac.mkv'));
    expect(m.video[0]!.codec).toBe('hevc');
    expect(m.video[0]!.bitDepth).toBe(8);
    expect(m.video[0]!.hdr.type).toBe('none');
    expect(m.audio[0]!.codec).toBe('aac');
  });

  it('india_webm-vp9-opus: VP9 8-bit + Opus (mono)', async () => {
    const m = await probe(fx('india_webm-vp9-opus.webm'));
    expect(m.container).toBe('webm');
    expect(m.video[0]!.codec).toBe('vp9');
    expect(m.video[0]!.bitDepth).toBe(8);
    expect(m.audio[0]!.codec).toBe('opus');
  });

  it('juliett_webm-vp8-vorbis: VP8 + Vorbis stereo', async () => {
    const m = await probe(fx('juliett_webm-vp8-vorbis.webm'));
    expect(m.container).toBe('webm');
    expect(m.video[0]!.codec).toBe('vp8');
    expect(m.audio[0]!.codec).toBe('vorbis');
    expect(m.audio[0]!.channels).toBe(2);
  });

  it('lima_mp4-h264-aac51: multichannel AAC (6ch, 5.1)', async () => {
    const m = await probe(fx('lima_mp4-h264-aac51.mp4'));
    expect(m.audio[0]!.codec).toBe('aac');
    expect(m.audio[0]!.channels).toBe(6);
    expect(m.audio[0]!.channelLayout).toMatch(/^5\.1/);
  });

  it('mike_mkv-h264-subs: two embedded text subtitle streams (subrip + ass)', async () => {
    const m = await probe(fx('mike_mkv-h264-subs.mkv'));
    expect(m.subtitles).toHaveLength(2);
    const codecs = m.subtitles.map((s) => s.codec).sort();
    expect(codecs).toEqual(['ass', 'subrip']);
    // Both are text-based.
    for (const s of m.subtitles) expect(s.isText).toBe(true);
    expect(existsSync(fx('mike_mkv-h264-subs.srt'))).toBe(true);
  });

  it('oscar_avi-mpeg4-mp3: MPEG-4 Part 2 + MP3 in AVI', async () => {
    const m = await probe(fx('oscar_avi-mpeg4-mp3.avi'));
    expect(m.container).toBe('avi');
    expect(m.video[0]!.codec).toBe('mpeg4');
    expect(m.audio[0]!.codec).toBe('mp3');
  });

  it('relative input path: MediaInfo.path comes back ABSOLUTE (OPEN BUG #2)', async () => {
    const abs = fx('alpha_mp4-h264-aac.mp4');
    const rel = path.relative(process.cwd(), abs);
    expect(path.isAbsolute(rel)).toBe(false);

    const m = await probe(rel);
    // Absolutised at the probe boundary: the HLS ffmpeg runs with cwd=workDir
    // (a temp dir), so a relative media.path reaching `-i` kills every HLS tier.
    expect(path.isAbsolute(m.path)).toBe(true);
    expect(m.path).toBe(abs);
    // …and it really probed that same file.
    expect(m.container).toBe('mp4');
    expect(m.video[0]!.codec).toBe('h264');
    expect(m.durationSec).toBeGreaterThan(0);
  });

  it('every fixture: absolute stream indices, positive duration', async () => {
    const files = [
      'alpha_mp4-h264-aac.mp4',
      'echo_mkv-h264-dts.mkv',
      'hotel_mkv-hevc10-truehd.mkv',
      'mike_mkv-h264-subs.mkv',
    ];
    for (const f of files) {
      const m: MediaInfo = await probe(fx(f));
      expect(m.durationSec).toBeGreaterThan(0);
      const all = [...m.video, ...m.audio, ...m.subtitles].map((s) => s.index);
      // Indices are unique and ascending (absolute ffprobe order).
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort((a, b) => a - b)).toEqual(all);
    }
  });
});
