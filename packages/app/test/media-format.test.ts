/**
 * media-format.test.ts — the pure formatters behind the file card and player bar.
 *
 * These functions are the only place the app turns engine facts into words a
 * viewer reads, so the tests care about two things beyond "does it return a
 * string": that every member of a frozen union is covered (no raw `buffering`
 * token, no empty chip), and that a degenerate file — no audio, no video, a
 * plan pointing at a stream that is not there — shortens the line instead of
 * printing `undefined`.
 */

import { describe, expect, it } from 'vitest';
import type {
  AudioStreamInfo,
  MediaInfo,
  PlaybackPlan,
  PlaybackTier,
  SessionState,
  SessionStatus,
  VideoStreamInfo,
} from '../src/shared/engine-types.js';
import {
  castingStatusDetail,
  formatDeviceStatus,
  formatFileMeta,
  formatFileName,
  formatTierChip,
  volumeLevel,
} from '../src/renderer/media-format.js';

// --- fixtures ---------------------------------------------------------------

function video(over: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    index: 0,
    codec: 'h264',
    profile: 'High',
    level: 41,
    width: 1920,
    height: 1080,
    fps: 23.976,
    bitDepth: 8,
    hdr: { type: 'none' },
    ...over,
  };
}

function audio(over: Partial<AudioStreamInfo> = {}): AudioStreamInfo {
  return {
    index: 1,
    codec: 'ac3',
    channels: 6,
    channelLayout: '5.1',
    sampleRate: 48000,
    isDefault: true,
    ...over,
  };
}

function media(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: '/Volumes/media/Show/episode.mkv',
    container: 'mkv',
    durationSec: 2947, // 49:07
    video: [video()],
    audio: [audio()],
    subtitles: [],
    ...over,
  };
}

function plan(over: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    method: 'hls',
    tier: 'video-transcode',
    reasons: [],
    video: { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 50 },
    audio: { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 },
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    segmentFormat: 'ts',
    contentType: 'application/vnd.apple.mpegurl',
    durationSec: 2947,
    hdrOutcome: 'preserved',
    subtitles: [],
    ...over,
  };
}

function status(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'playing',
    positionSec: 12,
    durationSec: 2947,
    volume: 0.8,
    muted: false,
    tier: 'video-transcode',
    deviceName: 'Living Room',
    activeSubtitleTrackId: null,
    activeAudioStreamIndex: 1,
    warnings: [],
    ...over,
  };
}

const ALL_TIERS: PlaybackTier[] = ['direct', 'remux', 'audio-transcode', 'video-transcode'];

const ALL_STATES: SessionState[] = [
  'probing',
  'planning',
  'preparing',
  'connecting',
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
  'reconnecting',
  'stopped',
  'error',
];

// --- formatFileName ---------------------------------------------------------

describe('formatFileName', () => {
  const cases: Array<[string, string]> = [
    ['/Volumes/media/Show/episode.mkv', 'episode.mkv'],
    ['episode.mkv', 'episode.mkv'],
    ['./fixtures/alpha_mp4-h264-aac.mp4', 'alpha_mp4-h264-aac.mp4'],
    ['/Volumes/media/Show/', 'Show'],
    ['/Volumes/media/Show///', 'Show'],
    ['/leading-slash-only.mkv', 'leading-slash-only.mkv'],
    ['a name with spaces & punctuation!.mkv', 'a name with spaces & punctuation!.mkv'],
  ];

  it.each(cases)('%s -> %s', (input, expected) => {
    expect(formatFileName(input)).toBe(expected);
  });

  it('never collapses to an empty title, even for a bare separator', () => {
    // '/' has no basename at all; showing the raw input beats an empty card.
    expect(formatFileName('/')).not.toBe('');
    expect(formatFileName('')).toBe('');
  });
});

// --- formatFileMeta ---------------------------------------------------------

describe('formatFileMeta', () => {
  it('describes duration, video and audio on one line', () => {
    expect(formatFileMeta(media(), null)).toBe('49:07 · 1080p H.264 · AC-3 5.1');
  });

  it('marks HDR10 after the codec', () => {
    const m = media({ video: [video({ codec: 'hevc', hdr: { type: 'hdr10' } })] });
    expect(formatFileMeta(m, null)).toBe('49:07 · 1080p HEVC HDR10 · AC-3 5.1');
  });

  it('spells out Dolby Vision rather than "dovi"', () => {
    const m = media({
      video: [
        video({ codec: 'hevc', width: 3840, height: 2160, hdr: { type: 'dovi', doviProfile: 8 } }),
      ],
    });
    expect(formatFileMeta(m, null)).toContain('2160p HEVC Dolby Vision');
    expect(formatFileMeta(m, null)).not.toContain('dovi');
  });

  it('labels HLG', () => {
    const m = media({ video: [video({ codec: 'hevc', hdr: { type: 'hlg' } })] });
    expect(formatFileMeta(m, null)).toContain('1080p HEVC HLG');
  });

  it('omits the audio clause for a file with no audio streams', () => {
    const result = formatFileMeta(media({ audio: [] }), null);
    expect(result).toBe('49:07 · 1080p H.264');
    expect(result).not.toContain('undefined');
  });

  it('omits the video clause for a file with no video streams', () => {
    const result = formatFileMeta(media({ video: [] }), null);
    expect(result).toBe('49:07 · AC-3 5.1');
    expect(result).not.toContain('undefined');
  });

  it('survives a file with neither video nor audio', () => {
    expect(formatFileMeta(media({ video: [], audio: [] }), null)).toBe('49:07');
  });

  it('follows the streams the PLAN chose, not the first ones in the file', () => {
    const m = media({
      video: [video({ index: 0 }), video({ index: 2, codec: 'hevc', height: 2160 })],
      audio: [
        audio({ index: 1, codec: 'eac3', isDefault: true }),
        audio({ index: 3, codec: 'aac', channels: 2, channelLayout: 'stereo', isDefault: false }),
      ],
    });
    expect(formatFileMeta(m, plan({ videoStreamIndex: 2, audioStreamIndex: 3 }))).toBe(
      '49:07 · 2160p HEVC · AAC Stereo',
    );
  });

  it('omits both clauses when the plan indices match no stream', () => {
    const result = formatFileMeta(media(), plan({ videoStreamIndex: 99, audioStreamIndex: 98 }));
    expect(result).toBe('49:07');
    expect(result).not.toContain('undefined');
  });

  it('prefers the default audio track over the first when there is no plan', () => {
    const m = media({
      audio: [
        audio({ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', isDefault: false }),
        audio({ index: 2, codec: 'dts', isDefault: true }),
      ],
    });
    expect(formatFileMeta(m, null)).toContain('DTS 5.1');
  });

  it('drops the ffmpeg (side)/(back) parenthetical from a channel layout', () => {
    const m = media({ audio: [audio({ channelLayout: '5.1(side)' })] });
    expect(formatFileMeta(m, null)).toContain('AC-3 5.1');
    expect(formatFileMeta(m, null)).not.toContain('side');
  });

  it('falls back to the channel count when the layout string is empty', () => {
    const m = media({ audio: [audio({ channels: 8, channelLayout: '' })] });
    expect(formatFileMeta(m, null)).toContain('AC-3 8ch');
  });

  it('says Stereo and Mono rather than the raw ffmpeg words', () => {
    const stereo = media({ audio: [audio({ channels: 2, channelLayout: 'stereo' })] });
    const mono = media({ audio: [audio({ channels: 1, channelLayout: 'mono' })] });
    expect(formatFileMeta(stereo, null)).toContain('AC-3 Stereo');
    expect(formatFileMeta(mono, null)).toContain('AC-3 Mono');
  });

  it('omits a resolution it cannot read instead of printing "0p"', () => {
    const m = media({ video: [video({ width: 0, height: 0 })] });
    expect(formatFileMeta(m, null)).toBe('49:07 · H.264 · AC-3 5.1');
  });

  it('omits an unusable duration rather than rendering NaN', () => {
    for (const durationSec of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const result = formatFileMeta(media({ durationSec }), null);
      expect(result).toBe('1080p H.264 · AC-3 5.1');
      expect(result).not.toContain('NaN');
    }
  });

  it('formats a feature-length duration with hours', () => {
    expect(formatFileMeta(media({ durationSec: 6628 }), null)).toContain('1:50:28');
  });
});

// --- formatTierChip ---------------------------------------------------------

describe('formatTierChip', () => {
  const expected: Record<PlaybackTier, string> = {
    direct: 'Plays as-is',
    remux: 'Repackaging',
    'audio-transcode': 'Converting audio',
    'video-transcode': 'Converting video',
  };

  it.each(ALL_TIERS)('%s reads as plain language', (tier) => {
    expect(formatTierChip(tier)).toBe(expected[tier]);
  });

  it('never leaks the engineering vocabulary or a raw tier token', () => {
    for (const tier of ALL_TIERS) {
      const chip = formatTierChip(tier);
      expect(chip).toBeTruthy();
      expect(chip).not.toContain(tier);
      expect(chip).not.toMatch(/remux|transcode/i);
    }
  });
});

// --- formatDeviceStatus -----------------------------------------------------

describe('formatDeviceStatus', () => {
  it('reads as "Not casting" with no session', () => {
    expect(formatDeviceStatus(null)).toBe('Not casting');
  });

  it('names the device and the tier while playing', () => {
    expect(formatDeviceStatus(status())).toBe('Casting to Living Room · Converting video');
  });

  it('reports the tier that is actually running', () => {
    expect(formatDeviceStatus(status({ tier: 'direct' }))).toBe(
      'Casting to Living Room · Plays as-is',
    );
  });

  it.each(ALL_STATES)('%s produces plain English with no raw state token', (state) => {
    const text = formatDeviceStatus(status({ state }));
    expect(text).toBeTruthy();
    expect(text).not.toContain('undefined');
    // The raw union member must never reach the screen verbatim — that is the
    // bare `idle`-style label this function replaced.
    expect(text).not.toContain(state);
  });

  it.each(['connecting', 'loading', 'preparing', 'buffering', 'reconnecting', 'seeking'] as const)(
    '%s reads as progress and names the device',
    (state) => {
      const text = formatDeviceStatus(status({ state }));
      expect(text).toContain('Living Room');
      expect(text.endsWith('…')).toBe(true);
    },
  );

  it('phrases the pre-device states without a device name', () => {
    // Nothing has been chosen to cast to yet, so naming one would be a lie.
    expect(formatDeviceStatus(status({ state: 'probing' }))).toBe('Reading the file…');
    expect(formatDeviceStatus(status({ state: 'planning' }))).toBe(
      'Working out how to play this…',
    );
  });

  it('handles the settled states', () => {
    expect(formatDeviceStatus(status({ state: 'paused' }))).toBe('Paused on Living Room');
    expect(formatDeviceStatus(status({ state: 'stopped' }))).toBe(
      'Stopped casting to Living Room',
    );
    expect(formatDeviceStatus(status({ state: 'error' }))).toBe('Playback failed on Living Room');
  });

  it('never dangles a preposition when the device name is blank', () => {
    for (const state of ALL_STATES) {
      const text = formatDeviceStatus(status({ state, deviceName: '   ' }));
      expect(text).not.toMatch(/\bto\s*…$/);
      expect(text).not.toMatch(/\bon\s*…?$/);
    }
    expect(formatDeviceStatus(status({ state: 'paused', deviceName: '' }))).toBe(
      'Paused on the device',
    );
  });
});

// --- castingStatusDetail ----------------------------------------------------

describe('castingStatusDetail', () => {
  it('reads as "Not casting" with no session', () => {
    expect(castingStatusDetail(null)).toBe('Not casting');
  });

  it('carries ONLY the activity — never the device name (which is on the caps line)', () => {
    // The whole point of this helper: the device is already shown once, so the
    // detail beside it must not repeat it.
    for (const state of ALL_STATES) {
      const text = castingStatusDetail(status({ state, deviceName: 'Living Room' }));
      expect(text).not.toContain('Living Room');
      expect(text.toLowerCase()).not.toContain('casting to');
    }
  });

  it('shows the tier as the activity while playing', () => {
    expect(castingStatusDetail(status({ state: 'playing', tier: 'video-transcode' }))).toBe(
      'Converting video',
    );
    expect(castingStatusDetail(status({ state: 'playing', tier: 'direct' }))).toBe('Plays as-is');
  });

  it('gives a short activity phrase for the settled states', () => {
    expect(castingStatusDetail(status({ state: 'paused' }))).toBe('Paused');
    expect(castingStatusDetail(status({ state: 'stopped' }))).toBe('Stopped');
    expect(castingStatusDetail(status({ state: 'error' }))).toBe('Playback failed');
  });

  it.each(ALL_STATES)('%s produces plain English with no raw state token', (state) => {
    const text = castingStatusDetail(status({ state }));
    expect(text).toBeTruthy();
    expect(text).not.toContain('undefined');
    expect(text).not.toContain(state);
  });
});

// --- volumeLevel ------------------------------------------------------------

describe('volumeLevel', () => {
  const cases: Array<[number, boolean, 'muted' | 'low' | 'high']> = [
    [0, false, 'muted'],
    [0.01, false, 'low'],
    [0.49, false, 'low'],
    [0.5, false, 'high'],
    [0.51, false, 'high'],
    [1, false, 'high'],
    // muted wins over any level, including full volume
    [1, true, 'muted'],
    [0.3, true, 'muted'],
    [0, true, 'muted'],
    // out of contractual range — clamped, not trusted
    [-0.5, false, 'muted'],
    [2, false, 'high'],
    // no usable figure at all
    [Number.NaN, false, 'muted'],
    [Number.POSITIVE_INFINITY, false, 'muted'],
    [Number.NEGATIVE_INFINITY, false, 'muted'],
  ];

  it.each(cases)('volume=%s muted=%s -> %s', (volume, muted, expected) => {
    expect(volumeLevel(volume, muted)).toBe(expected);
  });

  it('only ever returns one of the three glyph bands', () => {
    for (let v = 0; v <= 1.0001; v += 0.05) {
      expect(['muted', 'low', 'high']).toContain(volumeLevel(v, false));
    }
  });
});
