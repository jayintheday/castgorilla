/**
 * ffmpeg-args: exact-argv unit tests for buildHlsArgs (pure).
 */
import { describe, it, expect } from 'vitest';
import { buildHlsArgs, SEEK_EPSILON_SEC } from '../src/ffmpeg/args.js';
import { fixedBoundaries } from '../src/hls/boundaries.js';
import type { MediaInfo, PlaybackPlan, VideoAction, AudioAction, HdrType, SegmentFormat } from '../src/types/index.js';

const INPUT = '/media/movie.mkv';
const WORKDIR = '/tmp/ss-work';

function media(opts: {
  videoCodec?: MediaInfo['video'][number]['codec'];
  hdr?: HdrType;
  bitDepth?: 8 | 10 | 12;
} = {}): MediaInfo {
  return {
    path: INPUT,
    container: 'mkv',
    durationSec: 60,
    video: [
      {
        index: 0,
        codec: opts.videoCodec ?? 'h264',
        width: 1920,
        height: 1080,
        fps: 30,
        bitDepth: opts.bitDepth ?? 8,
        hdr: { type: opts.hdr ?? 'none' },
      },
    ],
    audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    subtitles: [],
  };
}

function plan(video: VideoAction, audio: AudioAction, extra: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    method: 'hls',
    tier: 'remux',
    reasons: [],
    video,
    audio,
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    segmentFormat: 'fmp4',
    contentType: 'application/vnd.apple.mpegurl',
    durationSec: 60,
    hdrOutcome: 'preserved',
    subtitles: [],
    ...extra,
  };
}

function build(m: MediaInfo, p: PlaybackPlan, startIdx = 0, bounds = fixedBoundaries(60, 6)): string[] {
  return buildHlsArgs({ input: INPUT, plan: p, media: m, workDir: WORKDIR, startBoundaryIndex: startIdx, boundaries: bounds });
}

const HLS_TAIL_FMP4 = [
  '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '6', '-hls_list_size', '0',
  '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%d.m4s',
  '-hls_flags', 'independent_segments+temp_file', '-start_number', '0', 'playlist.m3u8',
];

describe('buildHlsArgs — copy tiers', () => {
  it('remux: h264 + aac copy (exact argv, no -ss on initial)', () => {
    const args = build(media(), plan({ kind: 'copy' }, { kind: 'copy' }));
    expect(args).toEqual([
      '-y', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled',
      '-i', INPUT,
      '-map', '0:0', '-map', '0:1',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-sn', '-dn',
      ...HLS_TAIL_FMP4,
    ]);
    expect(args).not.toContain('-ss');
  });

  it('hevc copy: -tag:v hvc1 is present', () => {
    const args = build(media({ videoCodec: 'hevc' }), plan({ kind: 'copy' }, { kind: 'copy' }));
    const vIdx = args.indexOf('-c:v');
    expect(args.slice(vIdx, vIdx + 4)).toEqual(['-c:v', 'copy', '-tag:v', 'hvc1']);
  });

  it('audio transcode: eac3 5.1 (video copied)', () => {
    const args = build(media(), plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }));
    const i = args.indexOf('-c:a');
    expect(args.slice(i, i + 6)).toEqual(['-c:a', 'eac3', '-b:a', '640k', '-ac', '6']);
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('audio transcode: aac_at stereo with channelmap filter (-af)', () => {
    const args = build(
      media(),
      plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2, filters: ['channelmap=channel_layout=5.1'] }),
    );
    const i = args.indexOf('-c:a');
    expect(args.slice(i, i + 6)).toEqual(['-c:a', 'aac_at', '-b:a', '256k', '-ac', '2']);
    const af = args.indexOf('-af');
    expect(af).toBeGreaterThan(0);
    expect(args[af + 1]).toBe('channelmap=channel_layout=5.1');
  });
});

describe('buildHlsArgs — transcode tier', () => {
  it('full h264 transcode on the FIXED grid: q:v, scale, fps cap, expr keyframes, -g 240', () => {
    const v: VideoAction = { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 60, scale: { w: 1920, h: 1080 }, maxFps: 30 };
    const args = build(media(), plan(v, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 }));
    const i = args.indexOf('-c:v');
    expect(args.slice(i, i + 2)).toEqual(['-c:v', 'h264_videotoolbox']);
    expect(args[args.indexOf('-q:v') + 1]).toBe('60');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1920:1080');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*6)');
    expect(args[args.indexOf('-g') + 1]).toBe('240');
    // h264 output → NO hvc1 tag
    expect(args).not.toContain('-tag:v');
  });

  /**
   * Keyframe-aligned transcode grid (docs/segment-numbering-drift.md).
   *
   * The three assertions below are ONE mechanism and must move together: the
   * run enters the file exactly at its boundary (fast seek + SEEK_EPSILON onto
   * a real source keyframe), splits exactly at the boundaries after it (an
   * ABSOLUTE forced-keyframe list — `expr:`'s `t` is relative to the run start
   * and cannot express an absolute grid), and produces no other keyframe for
   * the muxer to split on (`-g` raised out of the way; `-g 240` was measured
   * inserting strays that drifted the numbering within four segments).
   */
  const alignedPlan = (): PlaybackPlan =>
    plan(
      { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 60 },
      { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 },
      { tier: 'video-transcode', segmentation: { mode: 'keyframe', targetSec: 6, boundaries: [0, 8.5, 17.25, 26] } },
    );

  it('keyframe-aligned transcode: absolute forced-keyframe list, no -g backstop', () => {
    const bounds = [0, 8.5, 17.25, 26];
    const args = build(media(), alignedPlan(), 0, bounds);
    // Boundaries AFTER the run start, absolute, each nudged 1ms early so no
    // rounding can push the forced keyframe onto the following frame.
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('8.499,17.249,25.999');
    expect(args[args.indexOf('-g') + 1]).toBe('100000');
    expect(args).not.toContain('expr:gte(t,n_forced*6)');
    // hls_time must stay BELOW the minimum boundary gap or the muxer's running
    // target overshoots a boundary and merges two segments into one file.
    expect(Number(args[args.indexOf('-hls_time') + 1])).toBeLessThan(6);
  });

  it('keyframe-aligned transcode restart: fast seek + epsilon, list sliced past the start', () => {
    const bounds = [0, 8.5, 17.25, 26];
    const args = build(media(), alignedPlan(), 2, bounds);
    const ss = args.indexOf('-ss');
    expect(args[ss + 1]).toBe(String(17.25 + SEEK_EPSILON_SEC));
    expect(args[ss + 2]).toBe('-noaccurate_seek');
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('25.999');
    expect(args[args.indexOf('-start_number') + 1]).toBe('2');
  });

  it('last segment of a keyframe-aligned run: no boundary left → no -force_key_frames', () => {
    const args = build(media(), alignedPlan(), 3, [0, 8.5, 17.25, 26]);
    expect(args).not.toContain('-force_key_frames');
    expect(args[args.indexOf('-g') + 1]).toBe('100000');
  });

  it('FIXED-grid transcode restart uses an ACCURATE seek (no -noaccurate_seek)', () => {
    // Only reachable when keyframe extraction produced nothing. A fast seek here
    // would land on the preceding source keyframe — up to a whole GOP before the
    // boundary — and `-start_number` would mislabel the entire run. Decoding and
    // discarding to the boundary is the cheap way to stay correct.
    const v: VideoAction = { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 60 };
    const args = build(media(), plan(v, { kind: 'copy' }, { segmentation: { mode: 'fixed', targetSec: 6 } }), 5);
    const ss = args.indexOf('-ss');
    expect(args[ss + 1]).toBe('30'); // the boundary itself, no epsilon
    expect(args).not.toContain('-noaccurate_seek');
  });

  it('COPY restart keeps the fast seek even with no keyframe index', () => {
    // A copied segment must begin on a source keyframe, so an accurate seek is
    // not available as a fallback here — the fast seek + epsilon stays.
    const args = build(media(), plan({ kind: 'copy' }, { kind: 'copy' }, { segmentation: { mode: 'fixed', targetSec: 6 } }), 5);
    const ss = args.indexOf('-ss');
    expect(args[ss + 1]).toBe(String(30 + SEEK_EPSILON_SEC));
    expect(args[ss + 2]).toBe('-noaccurate_seek');
  });

  it('HDR main10 transcode: setparams chain + p010le + hvc1 (only for hdr10 source)', () => {
    const v: VideoAction = { kind: 'transcode', encoder: 'hevc_videotoolbox', profile: 'main10', pixFmt: 'p010le', quality: 55 };
    const args = build(media({ videoCodec: 'hevc', hdr: 'hdr10', bitDepth: 10 }), plan(v, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }));
    expect(args[args.indexOf('-profile:v') + 1]).toBe('main10');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('p010le');
    expect(args).toContain('-tag:v');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toBe('setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le');
  });

  it('SDR main10 source gets NO setparams chain', () => {
    const v: VideoAction = { kind: 'transcode', encoder: 'hevc_videotoolbox', profile: 'main10', pixFmt: 'p010le', quality: 55 };
    // hdr: none → no setparams
    const args = build(media({ videoCodec: 'hevc', hdr: 'none', bitDepth: 10 }), plan(v, { kind: 'copy' }));
    expect(args).not.toContain('-vf');
  });
});

describe('buildHlsArgs — segment format + restart', () => {
  it('ts variant: mpegts, seg%d.ts, no init filename', () => {
    const args = build(media(), plan({ kind: 'copy' }, { kind: 'copy' }, { segmentFormat: 'ts' as SegmentFormat }));
    expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('mpegts');
    expect(args[args.indexOf('-hls_segment_filename') + 1]).toBe('seg%d.ts');
    expect(args).not.toContain('-hls_fmp4_init_filename');
  });

  it('restart: -ss (boundary+epsilon) -noaccurate_seek BEFORE -i, correct -start_number', () => {
    const bounds = fixedBoundaries(2760, 6); // 45-min file → boundaries[40] = 240
    const args = build(media(), plan({ kind: 'copy' }, { kind: 'copy' }), 40, bounds);
    const ssIdx = args.indexOf('-ss');
    const iIdx = args.indexOf('-i');
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    // -ss carries boundary + SEEK_EPSILON_SEC
    expect(args[ssIdx + 1]).toBe(String(240 + SEEK_EPSILON_SEC));
    expect(args[ssIdx + 2]).toBe('-noaccurate_seek');
    // ordering: -ss ... -noaccurate_seek all BEFORE -i
    expect(ssIdx).toBeLessThan(iIdx);
    expect(args.indexOf('-noaccurate_seek')).toBeLessThan(iIdx);
    expect(args[args.indexOf('-start_number') + 1]).toBe('40');
  });
});

describe('buildHlsArgs — copyts trio on EVERY variant', () => {
  const variants: Array<[string, PlaybackPlan, MediaInfo]> = [
    ['remux copy', plan({ kind: 'copy' }, { kind: 'copy' }), media()],
    ['hevc copy', plan({ kind: 'copy' }, { kind: 'copy' }), media({ videoCodec: 'hevc' })],
    ['audio transcode', plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }), media()],
    ['video transcode', plan({ kind: 'transcode', encoder: 'h264_videotoolbox', quality: 60 }, { kind: 'copy' }), media()],
    ['ts variant', plan({ kind: 'copy' }, { kind: 'copy' }, { segmentFormat: 'ts' as SegmentFormat }), media()],
  ];

  for (const [name, p, m] of variants) {
    it(`${name}: has -copyts -start_at_zero -avoid_negative_ts disabled`, () => {
      const args = build(m, p);
      const ci = args.indexOf('-copyts');
      expect(ci).toBeGreaterThanOrEqual(0);
      expect(args.slice(ci, ci + 4)).toEqual(['-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled']);
      // and it precedes -i (input-side)
      expect(ci).toBeLessThan(args.indexOf('-i'));
      // progress + mapping present
      expect(args.slice(0, 6)).toEqual(['-y', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1']);
      expect(args).toContain('-sn');
      expect(args).toContain('-dn');
    });
  }
});
