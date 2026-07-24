/**
 * renderer-tracks.test.ts — the track option models and the CC toggle's memory.
 *
 * The subtitle list has a preference order that is easy to "simplify" and
 * expensive to get wrong: `plan.subtitles` beats the probed embedded tracks,
 * because the plan's entries carry the `trackId` the DEVICE will fetch and that
 * matches `status.activeSubtitleTrackId`, whereas a probed stream's ffprobe
 * index does not. Pick the probed list and subtitles appear to select but never
 * show up. These tests pin the order, the `Array.isArray` guard, and the fact
 * that both selects are built from one call so the popover can never disagree
 * with the setup section.
 */

import { describe, expect, it } from 'vitest';
import type {
  AudioStreamInfo,
  MediaInfo,
  PlaybackPlan,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../src/shared/engine-types.js';
import {
  SUBTITLE_OFF,
  buildAudioOptions,
  buildSubtitleOptions,
  createSubtitleMemory,
  nextSubtitleSelection,
  subtitleTrackIds,
} from '../src/renderer/views/tracks.js';

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
    codec: 'eac3',
    channels: 6,
    channelLayout: '5.1',
    sampleRate: 48000,
    isDefault: true,
    ...over,
  };
}

function subtitle(over: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo {
  return {
    index: 3,
    codec: 'subrip',
    isText: true,
    isDefault: false,
    isForced: false,
    ...over,
  };
}

function media(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: '/Volumes/media/Show/episode.mkv',
    container: 'mkv',
    durationSec: 6628,
    video: [video()],
    audio: [audio()],
    subtitles: [],
    ...over,
  };
}

function plan(over: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    method: 'hls',
    tier: 'audio-transcode',
    reasons: [],
    video: { kind: 'copy' },
    audio: { kind: 'transcode', encoder: 'aac_at', bitrate: '192k', channels: 2 },
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    segmentFormat: 'ts',
    contentType: 'application/vnd.apple.mpegurl',
    durationSec: 6628,
    hdrOutcome: 'preserved',
    subtitles: [],
    ...over,
  };
}

// --- audio ------------------------------------------------------------------

describe('buildAudioOptions', () => {
  it('uses the ffprobe stream index as the value (that is what selectAudio takes)', () => {
    const options = buildAudioOptions(media({ audio: [audio({ index: 1 }), audio({ index: 2 })] }));
    expect(options.map((o) => o.value)).toEqual(['1', '2']);
  });

  it('labels codec, layout, language and title when present', () => {
    const options = buildAudioOptions(
      media({ audio: [audio({ language: 'eng', title: 'Commentary' })] }),
    );
    expect(options[0]?.label).toBe('EAC3 5.1 eng "Commentary"');
  });

  it('omits the language and title when the stream has neither', () => {
    expect(buildAudioOptions(media())[0]?.label).toBe('EAC3 5.1');
  });

  it('returns an empty list for a file with no audio rather than a placeholder', () => {
    expect(buildAudioOptions(media({ audio: [] }))).toEqual([]);
  });
});

// --- subtitles --------------------------------------------------------------

describe('buildSubtitleOptions — preference order', () => {
  const withPlanSubs = plan({
    subtitles: [
      { trackId: 1, url: 'http://x/1.vtt', label: 'English', language: 'eng', source: 'embedded' },
      { trackId: 2, url: 'http://x/2.vtt', label: 'Forced', language: 'eng', source: 'sidecar' },
    ],
  });

  const probed = media({
    subtitles: [subtitle({ index: 3, language: 'eng' }), subtitle({ index: 4, language: 'fra' })],
  });

  it('always leads with the "off" sentinel', () => {
    expect(buildSubtitleOptions(probed, withPlanSubs)[0]).toEqual({
      value: SUBTITLE_OFF,
      label: 'Off',
    });
    expect(buildSubtitleOptions(probed, null)[0]?.value).toBe(SUBTITLE_OFF);
  });

  it('PREFERS the plan trackIds over the probed ffprobe indices', () => {
    // The probed indices are 3 and 4; the plan's trackIds are 1 and 2. Getting
    // this backwards produces a picker whose selections the device ignores.
    const options = buildSubtitleOptions(probed, withPlanSubs);
    expect(options.map((o) => o.value)).toEqual([SUBTITLE_OFF, '1', '2']);
  });

  it('marks a sidecar track and drops a redundant language suffix', () => {
    const options = buildSubtitleOptions(probed, withPlanSubs);
    // "English" already contains "eng", so no [eng] is appended.
    expect(options[1]?.label).toBe('English');
    expect(options[2]?.label).toBe('Forced [eng] (sidecar)');
  });

  it('falls back to the probed embedded tracks when the plan carries none', () => {
    const options = buildSubtitleOptions(probed, plan({ subtitles: [] }));
    expect(options.map((o) => o.value)).toEqual([SUBTITLE_OFF, '3', '4']);
  });

  it('falls back when there is no plan at all (the mock / plan-less path)', () => {
    expect(buildSubtitleOptions(probed, null).map((o) => o.value)).toEqual([
      SUBTITLE_OFF,
      '3',
      '4',
    ]);
  });

  it('survives a plan whose `subtitles` field is missing entirely', () => {
    // An older engine dist may not carry the field; the Array.isArray guard is
    // what stops that becoming a TypeError in the middle of a render.
    const legacy = plan();
    delete (legacy as { subtitles?: unknown }).subtitles;
    expect(() => buildSubtitleOptions(probed, legacy)).not.toThrow();
    expect(buildSubtitleOptions(probed, legacy).map((o) => o.value)).toEqual([
      SUBTITLE_OFF,
      '3',
      '4',
    ]);
  });

  it('survives `subtitles` being a non-array', () => {
    const broken = plan();
    (broken as { subtitles: unknown }).subtitles = 'nope';
    expect(() => buildSubtitleOptions(probed, broken)).not.toThrow();
  });

  it('excludes bitmap subtitles from the fallback — nothing can convert them to WebVTT', () => {
    const withPgs = media({
      subtitles: [
        subtitle({ index: 3 }),
        subtitle({ index: 5, codec: 'hdmv_pgs', isText: false }),
      ],
    });
    expect(buildSubtitleOptions(withPgs, null).map((o) => o.value)).toEqual([
      SUBTITLE_OFF,
      '3',
    ]);
  });

  it('offers only "off" for a file with no usable subtitles', () => {
    expect(buildSubtitleOptions(media(), null)).toEqual([
      { value: SUBTITLE_OFF, label: 'Off' },
    ]);
  });
});

describe('subtitleTrackIds', () => {
  it('drops the off sentinel and returns numbers', () => {
    expect(
      subtitleTrackIds([
        { value: SUBTITLE_OFF, label: 'Off' },
        { value: '1', label: 'English' },
        { value: '7', label: 'French' },
      ]),
    ).toEqual([1, 7]);
  });

  it('is empty when only "off" is available', () => {
    expect(subtitleTrackIds([{ value: SUBTITLE_OFF, label: 'Off' }])).toEqual([]);
  });
});

// --- the CC toggle ----------------------------------------------------------

describe('nextSubtitleSelection', () => {
  it('turns subtitles off when one is on', () => {
    expect(nextSubtitleSelection(2, null, [1, 2])).toBeNull();
  });

  it('restores the remembered track when turning back on', () => {
    expect(nextSubtitleSelection(null, 2, [1, 2])).toBe(2);
  });

  it('falls back to the first available track when nothing is remembered', () => {
    expect(nextSubtitleSelection(null, null, [4, 9])).toBe(4);
  });

  it('re-validates the memory — a remembered id from another file is not restored', () => {
    // Load file A (tracks 1,2), enable 2, load file B (tracks 7,8): restoring 2
    // would select a track that does not exist on B.
    expect(nextSubtitleSelection(null, 2, [7, 8])).toBe(7);
  });

  it('returns null when there is nothing to turn on', () => {
    expect(nextSubtitleSelection(null, null, [])).toBeNull();
    expect(nextSubtitleSelection(null, 3, [])).toBeNull();
  });
});

describe('createSubtitleMemory', () => {
  it('remembers the last non-off selection across an off/on cycle', () => {
    const memory = createSubtitleMemory();
    memory.remember(2);
    expect(memory.toggle(2, [1, 2])).toBeNull(); // off
    expect(memory.toggle(null, [1, 2])).toBe(2); // back on, same track
  });

  it('ignores "off" so it never overwrites the thing worth restoring', () => {
    const memory = createSubtitleMemory();
    memory.remember(2);
    memory.remember(null);
    memory.remember(null);
    expect(memory.last).toBe(2);
  });

  it('records the track being turned off, so the toggle round-trips without a prior render', () => {
    const memory = createSubtitleMemory();
    expect(memory.toggle(5, [4, 5])).toBeNull();
    expect(memory.last).toBe(5);
    expect(memory.toggle(null, [4, 5])).toBe(5);
  });

  it('tracks a selection made from the dropdown rather than the CC button', () => {
    const memory = createSubtitleMemory();
    memory.remember(9); // user picked track 9 in #sub-track
    expect(memory.toggle(9, [8, 9])).toBeNull();
    expect(memory.toggle(null, [8, 9])).toBe(9);
  });

  it('starts with nothing remembered', () => {
    expect(createSubtitleMemory().last).toBeNull();
  });
});
