/**
 * hls-playlist: synthesized VOD playlist (pure, golden-file).
 */
import { describe, it, expect } from 'vitest';
import { synthesizeVodPlaylist } from '../src/hls/playlist.js';
import { fixedBoundaries } from '../src/hls/boundaries.js';

describe('synthesizeVodPlaylist', () => {
  it('fmp4 60s @ 6s → exact golden playlist', () => {
    const text = synthesizeVodPlaylist(fixedBoundaries(60, 6), 60, 'fmp4', '');
    const expected =
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        ...Array.from({ length: 10 }, (_, i) => [`#EXTINF:6.000000,`, `seg${i}.m4s`]).flat(),
        '#EXT-X-ENDLIST',
      ].join('\n') + '\n';
    expect(text).toBe(expected);
  });

  it('ts variant: version 3, no #EXT-X-MAP, .ts segments', () => {
    const text = synthesizeVodPlaylist(fixedBoundaries(18, 6), 18, 'ts', '');
    expect(text).toContain('#EXT-X-VERSION:3');
    expect(text).not.toContain('#EXT-X-MAP');
    expect(text).toContain('seg0.ts');
    expect(text).toContain('seg2.ts');
    expect(text).toContain('#EXT-X-ENDLIST');
  });

  it('urlPrefix is prepended to init + segment URIs', () => {
    const text = synthesizeVodPlaylist(fixedBoundaries(12, 6), 12, 'fmp4', 'https://cast.local/hls/x/');
    expect(text).toContain('#EXT-X-MAP:URI="https://cast.local/hls/x/init.mp4"');
    expect(text).toContain('https://cast.local/hls/x/seg0.m4s');
  });

  it('TARGETDURATION = ceil(max real segment duration); last EXTINF = duration - last boundary', () => {
    // keyframe-style uneven boundaries (8.333s GOP)
    const bounds = [0, 8.333, 16.667];
    const text = synthesizeVodPlaylist(bounds, 20, 'fmp4', '');
    // max seg = 8.334 (16.667-8.333) → ceil = 9
    expect(text).toContain('#EXT-X-TARGETDURATION:9');
    // last segment: 20 - 16.667 = 3.333
    expect(text).toContain('#EXTINF:3.333000,');
    // EXTINF sum ≈ duration
    const sum = [...text.matchAll(/#EXTINF:([\d.]+),/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(sum).toBeCloseTo(20, 2);
  });
});
