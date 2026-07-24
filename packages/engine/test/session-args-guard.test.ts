/**
 * session-args-guard — the WS4 fix to buildHlsArgs: an audio-less plan
 * (audioStreamIndex: -1) must NOT emit `-map 0:-1` (invalid argv) or any audio
 * codec args; it maps only video and disables audio with `-an`. A normal plan
 * still maps + encodes audio.
 */
import { describe, it, expect } from 'vitest';
import { buildHlsArgs } from '../src/ffmpeg/args.js';
import type { MediaInfo, PlaybackPlan } from '../src/types/index.js';

function media(): MediaInfo {
  return {
    path: '/tmp/x.mkv',
    container: 'mkv',
    durationSec: 60,
    video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, bitDepth: 8, hdr: { type: 'none' } }],
    audio: [],
    subtitles: [],
  };
}

function plan(audioStreamIndex: number, audio: PlaybackPlan['audio']): PlaybackPlan {
  return {
    method: 'hls',
    tier: audioStreamIndex < 0 ? 'video-transcode' : 'remux',
    reasons: [],
    video: { kind: 'copy' },
    audio,
    videoStreamIndex: 0,
    audioStreamIndex,
    segmentFormat: 'fmp4',
    contentType: 'application/vnd.apple.mpegurl',
    durationSec: 60,
    hdrOutcome: 'preserved',
    subtitles: [],
  };
}

const opts = (p: PlaybackPlan) => ({
  input: '/tmp/x.mkv',
  plan: p,
  media: media(),
  workDir: '/tmp/wd',
  startBoundaryIndex: 0,
  boundaries: [0, 6, 12],
});

describe('buildHlsArgs audio-less guard', () => {
  it('audioStreamIndex -1: no audio -map, no audio codec args, uses -an', () => {
    const args = buildHlsArgs(opts(plan(-1, { kind: 'copy' })));
    expect(args).not.toContain('0:-1');
    // exactly one -map (video only)
    expect(args.filter((a) => a === '-map')).toHaveLength(1);
    const mapIdx = args.indexOf('-map');
    expect(args[mapIdx + 1]).toBe('0:0');
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('normal plan: maps + encodes audio', () => {
    const args = buildHlsArgs(opts(plan(1, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 })));
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
    expect(args).toContain('0:1');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac_at');
    expect(args).not.toContain('-an');
  });
});
