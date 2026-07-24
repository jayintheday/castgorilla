/**
 * decide-plan.test.ts — buildPlaybackPlan: table-driven over probed fixtures
 * plus hand-doctored MediaInfo for the tricky corners.
 *
 * The pure planner is exercised against real probe output crossed with the six
 * device profiles and prefs (surround on/off, hdrPolicy warn/block), then with
 * synthetic MediaInfo objects for cases no fixture produces (Dolby Vision, Hi10P,
 * AV1, pathological GOP, forceTranscode).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from '../src/probe/ffprobe.js';
import { buildPlaybackPlan, PlanRefusedError } from '../src/decide/decision.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { DeviceProfile } from '../src/types/device.js';
import type { MediaInfo } from '../src/types/media.js';
import type { PlaybackPrefs } from '../src/types/plan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIX = path.join(ROOT, 'fixtures');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-fixtures.sh');
const TEN_MIN = 600_000;

const media: Record<string, MediaInfo> = {};

const FILES = [
  'alpha_mp4-h264-aac.mp4',
  'lima_mp4-h264-aac51.mp4',
  'charlie_mp4-h264-l51-4k.mp4',
  'echo_mkv-h264-dts.mkv',
  'golf_mkv-h264-ac3.mkv',
  'delta_mkv-h264-aac.mkv',
  'kilo_mkv-hevc8-aac.mkv',
  'hotel_mkv-hevc10-truehd.mkv',
  'juliett_webm-vp8-vorbis.webm',
  'india_webm-vp9-opus.webm',
  'oscar_avi-mpeg4-mp3.avi',
];

function prefs(p: Partial<PlaybackPrefs> = {}): PlaybackPrefs {
  return { surround: false, hdrPolicy: 'warn', ...p };
}

/**
 * A doctored profile that POSITIVELY asserts fMP4 HLS support.
 *
 * No real profile does (fMP4 wedges the Google Cast Default Media Receiver — see
 * resolveSegmentFormat in decide/container-rules.ts), so this is the only way to
 * exercise the planner's fMP4 branch: HEVC can be copied into fMP4 HLS but never
 * into MPEG-TS. The engine deliberately retains that capability for a future
 * custom receiver, so it stays under test.
 */
function withProvenFmp4(profile: DeviceProfile): DeviceProfile {
  return { ...profile, hls: { ...profile.hls, fmp4: true, segmentFormatFallback: null } };
}

beforeAll(async () => {
  execFileSync('bash', [SCRIPT], { stdio: 'inherit', timeout: TEN_MIN });
  for (const f of FILES) media[f] = await probe(path.join(FIX, f));
}, TEN_MIN);

describe('buildPlaybackPlan — probed fixtures × profiles × prefs', () => {
  it('alpha_mp4-h264-aac: direct play on every profile', () => {
    for (const key of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
      const plan = buildPlaybackPlan(media['alpha_mp4-h264-aac.mp4']!, PROFILES[key], prefs());
      expect(plan.method).toBe('direct');
      expect(plan.tier).toBe('direct');
      expect(plan.video.kind).toBe('copy');
      expect(plan.audio.kind).toBe('copy');
      expect(plan.contentType).toBe('video/mp4');
      expect(plan.segmentation).toBeUndefined();
      expect(plan.segmentFormat).toBeUndefined();
      expect(plan.hdrOutcome).toBe('preserved');
    }
  });

  it('lima_mp4-h264-aac51: multichannel AAC forces audio transcode (never copy)', () => {
    const sur = buildPlaybackPlan(media['lima_mp4-h264-aac51.mp4']!, PROFILES.ultra, prefs({ surround: true }));
    expect(sur.tier).toBe('audio-transcode');
    expect(sur.method).toBe('hls');
    expect(sur.video.kind).toBe('copy');
    expect(sur.audio).toMatchObject({ kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 });
    // TS is the shipped default: no profile has proven fMP4 support.
    expect(sur.segmentFormat).toBe('ts');
    // …and a profile that DID prove fMP4 would get fMP4 for the same media.
    expect(
      buildPlaybackPlan(media['lima_mp4-h264-aac51.mp4']!, withProvenFmp4(PROFILES.ultra), prefs({ surround: true }))
        .segmentFormat,
    ).toBe('fmp4');

    const stereo = buildPlaybackPlan(media['lima_mp4-h264-aac51.mp4']!, PROFILES.ultra, prefs({ surround: false }));
    expect(stereo.audio).toMatchObject({ kind: 'transcode', encoder: 'aac_at', bitrate: '192k', channels: 2 });
    // Layout is '5.1' (not '(side)') → no channelmap PCE filter.
    expect((stereo.audio as { filters?: string[] }).filters).toBeUndefined();
  });

  it('charlie_mp4-h264-l51-4k: copy on 4K-capable H.264, scale on 1080p devices, HEVC on Ultra', () => {
    const gen2 = buildPlaybackPlan(media['charlie_mp4-h264-l51-4k.mp4']!, PROFILES.gen2, prefs());
    expect(gen2.tier).toBe('video-transcode');
    expect(gen2.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox', scale: { w: 1920, h: 1080 } });

    const ccgtv = buildPlaybackPlan(media['charlie_mp4-h264-l51-4k.mp4']!, PROFILES.ccgtv, prefs());
    expect(ccgtv.method).toBe('direct');
    expect(ccgtv.tier).toBe('direct');

    const streamer = buildPlaybackPlan(media['charlie_mp4-h264-l51-4k.mp4']!, PROFILES['gtv-streamer'], prefs());
    expect(streamer.method).toBe('direct');

    // Ultra: 4K exceeds H.264 1080p cap but Ultra has HEVC → HEVC transcode (no downscale needed at 4K).
    const ultra = buildPlaybackPlan(media['charlie_mp4-h264-l51-4k.mp4']!, PROFILES.ultra, prefs());
    expect(ultra.tier).toBe('video-transcode');
    expect(ultra.video).toMatchObject({ kind: 'transcode', encoder: 'hevc_videotoolbox' });
    expect((ultra.video as { scale?: unknown }).scale).toBeUndefined();
  });

  it('echo_mkv-h264-dts: audio transcode; 5.1(side) triggers channelmap on AAC downmix only', () => {
    const sur = buildPlaybackPlan(media['echo_mkv-h264-dts.mkv']!, PROFILES.ultra, prefs({ surround: true }));
    expect(sur.tier).toBe('audio-transcode');
    expect(sur.video.kind).toBe('copy');
    expect(sur.audio).toMatchObject({ kind: 'transcode', encoder: 'eac3', channels: 6 });
    expect((sur.audio as { filters?: string[] }).filters).toBeUndefined(); // eac3 unaffected by PCE trap

    const stereo = buildPlaybackPlan(media['echo_mkv-h264-dts.mkv']!, PROFILES.ultra, prefs({ surround: false }));
    expect(stereo.audio).toMatchObject({ kind: 'transcode', encoder: 'aac_at', bitrate: '192k', channels: 2 });
    expect((stereo.audio as { filters?: string[] }).filters).toEqual(['channelmap=channel_layout=5.1']);
  });

  it('golf_mkv-h264-ac3: remux when surround kept, audio-transcode when downmixed', () => {
    const sur = buildPlaybackPlan(media['golf_mkv-h264-ac3.mkv']!, PROFILES.ultra, prefs({ surround: true }));
    expect(sur.tier).toBe('remux');
    expect(sur.method).toBe('hls');
    expect(sur.video.kind).toBe('copy');
    expect(sur.audio.kind).toBe('copy');

    const stereo = buildPlaybackPlan(media['golf_mkv-h264-ac3.mkv']!, PROFILES.ultra, prefs({ surround: false }));
    expect(stereo.tier).toBe('audio-transcode');
    expect(stereo.audio).toMatchObject({ kind: 'transcode', encoder: 'aac_at' });
  });

  it('delta_mkv-h264-aac: mkv container is never direct → remux (HLS copy+copy)', () => {
    const plan = buildPlaybackPlan(media['delta_mkv-h264-aac.mkv']!, PROFILES.gen2, prefs());
    expect(plan.method).toBe('hls');
    expect(plan.tier).toBe('remux');
    expect(plan.video.kind).toBe('copy');
    expect(plan.audio.kind).toBe('copy');
    expect(plan.segmentation).toMatchObject({ mode: 'keyframe', targetSec: 6 });
  });

  it('kilo_mkv-hevc8-aac: HEVC copy (hvc1) only on an HEVC device with PROVEN fMP4; TS forces H.264', () => {
    // HEVC cannot ride MPEG-TS on this receiver (the Shield rejects it outright:
    // IDLE / idleReason ERROR ~0.6s after LOAD), so the HEVC-copy path exists
    // only when the segment format is fMP4. Repointed at a doctored fmp4:true
    // profile because since 2026-07-23 no shipped profile selects fMP4.
    const fmp4Ultra = buildPlaybackPlan(
      media['kilo_mkv-hevc8-aac.mkv']!,
      withProvenFmp4(PROFILES.ultra),
      prefs(),
    );
    expect(fmp4Ultra.segmentFormat).toBe('fmp4');
    expect(fmp4Ultra.tier).toBe('remux');
    expect(fmp4Ultra.video).toEqual({ kind: 'copy', tag: 'hvc1' });

    // Stock ultra now plans TS → the HEVC copy is demoted to an H.264 transcode,
    // with the reason spelled out. This is CORRECT and must be preserved.
    const ultra = buildPlaybackPlan(media['kilo_mkv-hevc8-aac.mkv']!, PROFILES.ultra, prefs());
    expect(ultra.segmentFormat).toBe('ts');
    expect(ultra.tier).toBe('video-transcode');
    expect(ultra.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox' });
    expect(ultra.reasons.join(' ')).toMatch(/HEVC cannot ride MPEG-TS HLS/);

    // A device that cannot decode HEVC at all transcodes for the other reason.
    const gen2 = buildPlaybackPlan(media['kilo_mkv-hevc8-aac.mkv']!, PROFILES.gen2, prefs());
    expect(gen2.tier).toBe('video-transcode');
    expect(gen2.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox' });
    expect(gen2.reasons.join(' ')).toMatch(/device cannot decode HEVC/);
  });

  it('hotel_mkv-hevc10-truehd: HDR preserved+copy on capable, washed-out warn / block-refuse otherwise', () => {
    // Ultra with PROVEN fMP4: HEVC Main10 HDR10 copyable → preserved; TrueHD →
    // audio transcode. Repointed at a doctored fmp4:true profile because the
    // HEVC-copy path only exists for fMP4 segments, and no shipped profile
    // selects fMP4 any more (see resolveSegmentFormat).
    const ultra = buildPlaybackPlan(
      media['hotel_mkv-hevc10-truehd.mkv']!,
      withProvenFmp4(PROFILES.ultra),
      prefs({ surround: true }),
    );
    expect(ultra.tier).toBe('audio-transcode');
    expect(ultra.video).toEqual({ kind: 'copy', tag: 'hvc1' });
    expect(ultra.hdrOutcome).toBe('preserved');
    expect(ultra.audio).toMatchObject({ kind: 'transcode', encoder: 'eac3' });

    // Stock ultra (TS): HEVC cannot ride MPEG-TS → forced H.264 transcode.
    // NOTE the known wart this exposes — hdrOutcome is decided in step 1, before
    // the segment format is known, so it still reads 'preserved' even though the
    // forced H.264 output is 8-bit SDR. Asserted here so the inconsistency is
    // recorded rather than hidden; see the report accompanying this change.
    const ultraTs = buildPlaybackPlan(
      media['hotel_mkv-hevc10-truehd.mkv']!,
      PROFILES.ultra,
      prefs({ surround: true }),
    );
    expect(ultraTs.segmentFormat).toBe('ts');
    expect(ultraTs.tier).toBe('video-transcode');
    expect(ultraTs.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox' });
    expect(ultraTs.hdrOutcome).toBe('preserved');

    // gen2 (no HEVC, no HDR) + warn: transcode to H.264 SDR, washed-out warning.
    const gen2Warn = buildPlaybackPlan(media['hotel_mkv-hevc10-truehd.mkv']!, PROFILES.gen2, prefs({ hdrPolicy: 'warn' }));
    expect(gen2Warn.tier).toBe('video-transcode');
    expect(gen2Warn.hdrOutcome).toBe('washed-out-warning');

    // gen2 + block: refuse HDR on a non-HDR device.
    expect(() =>
      buildPlaybackPlan(media['hotel_mkv-hevc10-truehd.mkv']!, PROFILES.gen2, prefs({ hdrPolicy: 'block' })),
    ).toThrow(PlanRefusedError);
  });

  it('juliett_webm-vp8-vorbis: direct on VP8 devices, transcode on ccgtv/streamer (no VP8 decode)', () => {
    const gen2 = buildPlaybackPlan(media['juliett_webm-vp8-vorbis.webm']!, PROFILES.gen2, prefs());
    expect(gen2.method).toBe('direct');
    expect(gen2.tier).toBe('direct');
    expect(gen2.contentType).toBe('video/webm');

    const ccgtv = buildPlaybackPlan(media['juliett_webm-vp8-vorbis.webm']!, PROFILES.ccgtv, prefs());
    expect(ccgtv.tier).toBe('video-transcode');
    // vorbis in HLS re-evaluates to AAC 256k stereo.
    expect(ccgtv.audio).toMatchObject({ kind: 'transcode', encoder: 'aac_at', bitrate: '256k' });
  });

  it('india_webm-vp9-opus: Opus forces HLS → VP9 cannot be HLS-copied → video-transcode everywhere', () => {
    for (const key of ['gen2', 'ultra', 'ccgtv', 'gtv-streamer'] as (keyof typeof PROFILES)[]) {
      const plan = buildPlaybackPlan(media['india_webm-vp9-opus.webm']!, PROFILES[key], prefs());
      expect(plan.tier).toBe('video-transcode');
      expect(plan.method).toBe('hls');
      expect(plan.audio).toMatchObject({ kind: 'transcode', encoder: 'aac_at' });
    }
  });

  it('oscar_avi-mpeg4-mp3: MPEG-4 always transcodes; MP3 copies', () => {
    const plan = buildPlaybackPlan(media['oscar_avi-mpeg4-mp3.avi']!, PROFILES.gen2, prefs());
    expect(plan.tier).toBe('video-transcode');
    expect(plan.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox' });
    expect(plan.audio.kind).toBe('copy');
  });

  it('forceTranscode: overrides direct play into a video transcode', () => {
    const plan = buildPlaybackPlan(media['alpha_mp4-h264-aac.mp4']!, PROFILES.gen2, prefs({ forceTranscode: true }));
    expect(plan.tier).toBe('video-transcode');
    expect(plan.method).toBe('hls');
    expect(plan.video.kind).toBe('transcode');
  });

  it('reasons[]: every plan carries a non-empty human-readable trail', () => {
    const plan = buildPlaybackPlan(media['echo_mkv-h264-dts.mkv']!, PROFILES.ultra, prefs({ surround: false }));
    expect(plan.reasons.length).toBeGreaterThan(0);
    expect(plan.reasons.join(' ')).toMatch(/channelmap|aac|dts/i);
  });
});

// --- Doctored MediaInfo: corners no fixture produces ------------------------

function baseMedia(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: '/synthetic.mkv',
    container: 'mkv',
    durationSec: 120,
    video: [],
    audio: [],
    subtitles: [],
    ...over,
  };
}

function withDv(profile: DeviceProfile, hdr10: boolean, dv: boolean): DeviceProfile {
  return { ...profile, hdr: { hdr10, dv } };
}

describe('buildPlaybackPlan — doctored MediaInfo', () => {
  it('Dolby Vision Profile 5 on a device without DV support is refused', () => {
    const m = baseMedia({
      container: 'mp4',
      video: [{ index: 0, codec: 'hevc', profile: 'Main 10', width: 3840, height: 2160, fps: 24, bitDepth: 10, hdr: { type: 'dovi', doviProfile: 5 } }],
      audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    });
    // ccgtv normally supports DV; doctor it off.
    expect(() => buildPlaybackPlan(m, withDv(PROFILES.ccgtv, true, false), prefs())).toThrow(PlanRefusedError);
    // With DV support, P5 is preserved (not refused).
    const ok = buildPlaybackPlan(m, PROFILES.ccgtv, prefs());
    expect(ok.hdrOutcome).toBe('preserved');
  });

  it('Dolby Vision Profile 8 maps to the HDR10 base layer', () => {
    const m = baseMedia({
      video: [{ index: 0, codec: 'hevc', profile: 'Main 10', width: 1920, height: 1080, fps: 24, bitDepth: 10, hdr: { type: 'dovi', doviProfile: 8 } }],
      audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    });
    const ccgtv = buildPlaybackPlan(m, PROFILES.ccgtv, prefs());
    expect(ccgtv.hdrOutcome).toBe('preserved');
    expect(ccgtv.reasons.join(' ')).toMatch(/HDR10 base layer/);

    // On a non-HDR device with block policy → refused (treated as hdr10).
    expect(() => buildPlaybackPlan(m, PROFILES.gen2, prefs({ hdrPolicy: 'block' }))).toThrow(PlanRefusedError);
  });

  it('Hi10P (H.264 10-bit) always transcodes — HEVC main10 on HEVC devices, H.264 on others', () => {
    const m = baseMedia({
      video: [{ index: 0, codec: 'h264', profile: 'High 10', width: 1920, height: 1080, fps: 24, bitDepth: 10, hdr: { type: 'none' } }],
      audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    });
    const ccgtv = buildPlaybackPlan(m, PROFILES.ccgtv, prefs());
    expect(ccgtv.tier).toBe('video-transcode');
    expect(ccgtv.video).toMatchObject({ kind: 'transcode', encoder: 'hevc_videotoolbox', profile: 'main10', pixFmt: 'p010le' });

    const gen2 = buildPlaybackPlan(m, PROFILES.gen2, prefs());
    expect(gen2.video).toMatchObject({ kind: 'transcode', encoder: 'h264_videotoolbox' });
    expect((gen2.video as { profile?: string }).profile).toBeUndefined();
  });

  it('AV1 in mp4: direct on Google TV Streamer, transcode on ccgtv (no AV1 decode)', () => {
    const m = baseMedia({
      container: 'mp4',
      video: [{ index: 0, codec: 'av1', profile: 'Main', width: 1920, height: 1080, fps: 24, bitDepth: 8, hdr: { type: 'none' } }],
      audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    });
    const streamer = buildPlaybackPlan(m, PROFILES['gtv-streamer'], prefs());
    expect(streamer.method).toBe('direct');
    expect(streamer.video.kind).toBe('copy');

    const ccgtv = buildPlaybackPlan(m, PROFILES.ccgtv, prefs());
    expect(ccgtv.tier).toBe('video-transcode');
    expect(ccgtv.method).toBe('hls');
  });

  it('VP9 in mkv: container forces HLS → VP9 cannot be HLS-copied → transcode', () => {
    const m = baseMedia({
      container: 'mkv',
      video: [{ index: 0, codec: 'vp9', profile: 'Profile 0', width: 1920, height: 1080, fps: 24, bitDepth: 8, hdr: { type: 'none' } }],
      audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    });
    // Ultra decodes VP9 natively, but mkv → HLS → copy disallowed for VP9.
    const ultra = buildPlaybackPlan(m, PROFILES.ultra, prefs());
    expect(ultra.tier).toBe('video-transcode');
    expect(ultra.video.kind).toBe('transcode');
  });

  it('pathological GOP (>12s) demotes a copy to transcode, still keyframe-segmented', () => {
    const m = media['delta_mkv-h264-aac.mkv']!; // h264 + aac → normally remux on ultra
    // Realistic keyframes span the whole ~60s clip at 6s spacing.
    const evenKf = Array.from({ length: 11 }, (_, i) => i * 6); // 0,6,...,60
    const good = buildPlaybackPlan(m, PROFILES.ultra, prefs(), { keyframePts: evenKf });
    expect(good.tier).toBe('remux');
    expect(good.video.kind).toBe('copy');
    expect(good.segmentation).toMatchObject({ mode: 'keyframe', targetSec: 6 });
    expect(good.segmentation!.boundaries).toBeDefined();

    const bad = buildPlaybackPlan(m, PROFILES.ultra, prefs(), { keyframePts: [0, 15, 30, 45] });
    expect(bad.tier).toBe('video-transcode');
    expect(bad.video.kind).toBe('transcode');
    expect(bad.reasons.join(' ')).toMatch(/pathological GOP/i);

    // THIS USED TO ASSERT `{ mode: 'fixed' }`, and that assertion was the bug in
    // documented form (docs/segment-numbering-drift.md): a fixed 6s grid on a
    // transcode means a seek-restart enters at the preceding SOURCE keyframe and
    // `-start_number` labels it as if it had entered at the boundary. The
    // transcode tier now segments on source keyframes too.
    expect(bad.segmentation).toMatchObject({ mode: 'keyframe', targetSec: 6 });
    // And here is the cost, stated rather than hidden: the worst content
    // produces the longest segments. A 15s GOP means a 15s segment, because the
    // only way to shorten it would be to introduce a boundary that is not a
    // source keyframe — i.e. to put the defect back.
    expect(bad.segmentation!.boundaries).toEqual([0, 15, 30, 45]);
  });

  it('a transcode with NO keyframe index falls back to the fixed grid', () => {
    // The fallback is not safe on its own — buildHlsArgs() compensates by
    // switching this case to an accurate seek. Pinned so the fallback cannot be
    // silently widened into the default again.
    const m = media['kilo_mkv-hevc8-aac.mkv']!; // HEVC → gen2 cannot decode it
    const p = buildPlaybackPlan(m, PROFILES.gen2, prefs(), { keyframePts: [] });
    expect(p.video.kind).toBe('transcode');
    expect(p.segmentation).toMatchObject({ mode: 'fixed', targetSec: 6 });
    expect(p.segmentation!.boundaries).toBeUndefined();

    // …and WITH an index the same plan is keyframe-segmented.
    const withKf = buildPlaybackPlan(m, PROFILES.gen2, prefs(), { keyframePts: [0, 7, 14, 21, 28] });
    expect(withKf.segmentation).toMatchObject({ mode: 'keyframe', targetSec: 6 });
    expect(withKf.segmentation!.boundaries).toEqual([0, 7, 14, 21, 28]);
  });

  it('explicit stream selection overrides default first/default picking', () => {
    const m = baseMedia({
      container: 'mp4',
      video: [{ index: 0, codec: 'h264', profile: 'High', width: 1280, height: 720, fps: 30, bitDepth: 8, hdr: { type: 'none' } }],
      audio: [
        { index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true, language: 'eng' },
        { index: 2, codec: 'ac3', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: false, language: 'fra' },
      ],
    });
    // Default → track 1 (aac, isDefault).
    expect(buildPlaybackPlan(m, PROFILES.ultra, prefs()).audioStreamIndex).toBe(1);
    // Explicit override → track 2.
    expect(buildPlaybackPlan(m, PROFILES.ultra, prefs(), { audioStreamIndex: 2 }).audioStreamIndex).toBe(2);
    // Language preference → French track 2.
    expect(buildPlaybackPlan(m, PROFILES.ultra, prefs({ preferredAudioLang: 'fra' })).audioStreamIndex).toBe(2);
  });
});
