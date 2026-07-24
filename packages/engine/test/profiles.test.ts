import { describe, it, expect } from 'vitest';
import { resolveProfile, PROFILES } from '../src/devices/profiles.js';
import { resolveSegmentFormat } from '../src/decide/container-rules.js';
import type { DeviceHlsCaps, DeviceProfile } from '../src/types/device.js';

describe('resolveProfile — mDNS md matching', () => {
  it('maps bare "Chromecast" to gen2 (gen1/2/3 are indistinguishable)', () => {
    expect(resolveProfile('Chromecast').key).toBe('gen2');
  });

  it('maps "Chromecast Ultra" to ultra (exact beats the Chromecast prefix)', () => {
    expect(resolveProfile('Chromecast Ultra').key).toBe('ultra');
  });

  it('maps "Google TV Streamer" to gtv-streamer', () => {
    expect(resolveProfile('Google TV Streamer').key).toBe('gtv-streamer');
  });

  it('maps both Google TV dongle md variants to ccgtv', () => {
    expect(resolveProfile('Chromecast with Google TV').key).toBe('ccgtv');
    expect(resolveProfile('Chromecast Google TV').key).toBe('ccgtv');
  });

  it('is case-insensitive', () => {
    expect(resolveProfile('chromecast ultra').key).toBe('ultra');
    expect(resolveProfile('GOOGLE TV STREAMER').key).toBe('gtv-streamer');
    expect(resolveProfile('CHROMECAST').key).toBe('gen2');
  });

  it('prefix-matches more specific model strings, longest-first', () => {
    expect(resolveProfile('Chromecast Ultra (2nd gen)').key).toBe('ultra');
    expect(resolveProfile('Chromecast with Google TV 4K').key).toBe('ccgtv');
    expect(resolveProfile('Google TV Streamer 4K').key).toBe('gtv-streamer');
  });

  it('falls back to gen2 for an unrecognized "Chromecast …" prefix', () => {
    expect(resolveProfile('Chromecast HD').key).toBe('gen2');
  });

  it('maps smart displays / unrelated devices to unknown', () => {
    expect(resolveProfile('Google Nest Hub').key).toBe('unknown');
    expect(resolveProfile('Nest Audio').key).toBe('unknown');
  });

  it('maps the confirmed Shield md "SHIELD Android TV" to shield', () => {
    expect(resolveProfile('SHIELD Android TV').key).toBe('shield');
  });

  it('resolves Shield case-insensitively', () => {
    expect(resolveProfile('shield android tv').key).toBe('shield');
    expect(resolveProfile('SHIELD ANDROID TV').key).toBe('shield');
  });

  it('prefix-matches longer Shield SKU strings, and the bare "SHIELD" catch-all', () => {
    expect(resolveProfile('SHIELD Android TV Pro').key).toBe('shield');
    expect(resolveProfile('SHIELD Android TV (2019)').key).toBe('shield');
    // The bare 'SHIELD' entry catches SKUs whose md we have not observed.
    expect(resolveProfile('SHIELD TV').key).toBe('shield');
  });

  it('maps empty / whitespace md to unknown', () => {
    expect(resolveProfile('').key).toBe('unknown');
    expect(resolveProfile('   ').key).toBe('unknown');
  });

  it('shield neither shadows nor is shadowed: every other md still resolves as before', () => {
    // The longest-prefix pass is order-sensitive; adding 'SHIELD' + 'SHIELD
    // Android TV' to MATCHABLE must not perturb any pre-existing resolution.
    const expected: [string, string][] = [
      ['Chromecast', 'gen2'],
      ['Chromecast HD', 'gen2'],
      ['Chromecast Ultra', 'ultra'],
      ['Chromecast Ultra (2nd gen)', 'ultra'],
      ['Chromecast with Google TV', 'ccgtv'],
      ['Chromecast with Google TV 4K', 'ccgtv'],
      ['Chromecast Google TV', 'ccgtv'],
      ['Google TV Streamer', 'gtv-streamer'],
      ['Google TV Streamer 4K', 'gtv-streamer'],
      ['Google Nest Hub', 'unknown'],
      ['Nest Audio', 'unknown'],
      ['', 'unknown'],
    ];
    for (const [md, key] of expected) expect(resolveProfile(md).key).toBe(key);
  });

  it('does not match unrelated devices that merely contain "shield"', () => {
    // Matching is prefix-based, never substring.
    expect(resolveProfile('Acme Shielded Speaker').key).toBe('unknown');
  });
});

describe('PROFILES — capability facts', () => {
  it('unknown is a conservative gen2-equivalent baseline', () => {
    const u = PROFILES.unknown;
    expect(u.video.h264).toEqual({ maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 });
    expect(u.video.hevc).toBeUndefined();
    expect(u.video.vp9).toBeUndefined();
    expect(u.hdr).toEqual({ hdr10: false, dv: false });
  });

  it('gen1/gen2 have H.264 L4.1 1080p30 + VP8, no HDR', () => {
    for (const p of [PROFILES.gen1, PROFILES.gen2]) {
      expect(p.video.h264).toEqual({ maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 });
      expect(p.video.vp8).toEqual({ maxW: 1920, maxH: 1080, maxFps: 30 });
      expect(p.video.hevc).toBeUndefined();
      expect(p.hdr).toEqual({ hdr10: false, dv: false });
    }
  });

  it('gen3 bumps H.264 to L4.2 1080p60', () => {
    expect(PROFILES.gen3.video.h264).toEqual({ maxLevel: 42, maxW: 1920, maxH: 1080, maxFps: 60 });
  });

  it('ultra: HEVC main+main10 4K60, VP9 [0,2] 4K60, HDR10+DV', () => {
    const u = PROFILES.ultra;
    expect(u.video.h264.maxFps).toBe(60);
    expect(u.video.hevc).toEqual({ profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(u.video.vp9).toEqual({ profiles: [0, 2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(u.video.av1).toBeUndefined();
    expect(u.hdr).toEqual({ hdr10: true, dv: true });
  });

  it('ccgtv: H.264 4K30, HEVC 4K60, VP9 [2], no AV1, HDR10+DV', () => {
    const c = PROFILES.ccgtv;
    expect(c.video.h264).toEqual({ maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 30 });
    expect(c.video.hevc?.profiles).toEqual(['main', 'main10']);
    expect(c.video.vp9?.profiles).toEqual([2]);
    expect(c.video.av1).toBeUndefined();
    expect(c.hdr).toEqual({ hdr10: true, dv: true });
  });

  it('gtv-streamer: ccgtv + AV1 4K60 + H.264 L5.2 4K60', () => {
    const g = PROFILES['gtv-streamer'];
    expect(g.video.h264).toEqual({ maxLevel: 52, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(g.video.av1).toEqual({ maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(g.video.hevc?.profiles).toEqual(['main', 'main10']);
    expect(g.hdr).toEqual({ hdr10: true, dv: true });
  });

  it('shield: H.264 4K30 L5.1, HEVC main+main10 4K60, VP9 [0,2] 4K60, VP8, no AV1', () => {
    const s = PROFILES.shield;
    expect(s.key).toBe('shield');
    expect(s.video.h264).toEqual({ maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 30 });
    expect(s.video.hevc).toEqual({ profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(s.video.vp9).toEqual({ profiles: [0, 2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 });
    expect(s.video.vp8).toEqual({ maxW: 1920, maxH: 1080, maxFps: 30 });
    // Tegra X1 has no hardware AV1 decode on any Shield generation.
    expect(s.video.av1).toBeUndefined();
  });

  it('shield: HDR10 yes, Dolby Vision NO (DV is 2019-only and md cannot distinguish generations)', () => {
    // Guard: flipping dv to true would send DV P5 to a 2015/2017 Shield, which
    // renders as green/purple garbage. Do not "fix" without a generation signal.
    expect(PROFILES.shield.hdr).toEqual({ hdr10: true, dv: false });
  });

  it('shield: fMP4 HLS is NOT supported, TS is the segment fallback (OPEN BUG #1, 2026-07-23)', () => {
    // Hardware evidence: identical spike runs off the same pre-baked source
    // differing only in segment container. FMP4/FMP4 stuck at IDLE +
    // extendedStatus "LOADING" for 20s and wedged the receiver (STOP timed out);
    // TS_AAC/MPEG2_TS reached PLAYING in 0.63s and a human watching the TV saw
    // the clip.
    expect(PROFILES.shield.hls.fmp4).toBe(false);
    // The explicit veto is kept as belt-and-braces: it forces TS even if someone
    // later flips fmp4 to true on this profile.
    expect(PROFILES.shield.hls.segmentFormatFallback).toBe('ts');
  });

  it('gen2: fMP4 HLS is NOT supported — proven on a real Chromecast HD (2026-07-23)', () => {
    // "Chromecast HD" prefix-matches gen2. Every fMP4 LOAD wedged the receiver
    // with the same signature as the Shield (playlist x2 + init x1 + ~3 segments,
    // all HTTP 200, then IDLE/LOADING forever and a STOP that timed out at 5s).
    // Observed by a human at the TV: "delta is loading. but does not playback".
    // Our TS output played on the same unit.
    expect(resolveProfile('Chromecast HD').key).toBe('gen2');
    expect(PROFILES.gen2.hls.fmp4).toBe(false);
    // No explicit veto needed: fmp4:false alone now selects TS.
    expect(PROFILES.gen2.hls.segmentFormatFallback).toBeNull();
    expect(resolveSegmentFormat(PROFILES.gen2)).toBe('ts');
  });

  it('shield: hevcInHls stays untested — HEVC-in-HLS was never exercised on the device', () => {
    // The fMP4-vs-TS spike used H.264 only. Do not infer HEVC from it.
    expect(PROFILES.shield.hls.hevcInHls).toBe('untested');
  });

  it('shield: the recorded facts actually change the planned segment format', () => {
    // This is the behavioural consequence that matters: resolveSegmentFormat()
    // feeds plan.segmentFormat, which buildLoadMedia() turns into
    // TS_AAC / MPEG2_TS instead of FMP4 / FMP4 in the CASTV2 LOAD.
    expect(resolveSegmentFormat(PROFILES.shield)).toBe('ts');
  });

  it('PROFILES keys are self-consistent (each entry key matches its record slot)', () => {
    for (const [slot, profile] of Object.entries(PROFILES)) {
      expect(profile.key).toBe(slot);
    }
    expect(Object.keys(PROFILES)).toContain('shield');
  });

  it('every profile: audioCodecs = aac/mp3/flac/vorbis/pcm (opus deliberately absent), surroundPassthrough true', () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.audioCodecs).toEqual(['aac', 'mp3', 'flac', 'vorbis', 'pcm']);
      expect(p.audioCodecs as string[]).not.toContain('opus');
      expect(p.surroundPassthrough).toBe(true);
    }
  });

  it('every profile EXCEPT shield/gen2 still has untested hls caps (those two are the ones with hardware evidence)', () => {
    for (const p of Object.values(PROFILES)) {
      if (p.key === 'shield' || p.key === 'gen2') continue;
      expect(p.hls).toEqual({ fmp4: 'untested', hevcInHls: 'untested', segmentFormatFallback: null });
    }
  });

  it('EVERY profile currently plans MPEG-TS segments — no profile has proven fMP4', () => {
    // The shipped default after the 2026-07-23 inversion. If this ever fails,
    // someone set hls.fmp4 = true on a profile: that is a claim that a HUMAN
    // watched that device render fMP4 HLS on a TV. Apple's own reference fMP4
    // stream wedges the Default Media Receiver, so the bar is hardware proof.
    for (const p of Object.values(PROFILES)) {
      expect(resolveSegmentFormat(p)).toBe('ts');
      expect(p.hls.fmp4).not.toBe(true);
    }
  });
});

describe('resolveSegmentFormat — fMP4 requires PROVEN support', () => {
  /** A minimal profile carrying only the hls block under test. */
  function withHls(hls: DeviceHlsCaps): DeviceProfile {
    return { ...PROFILES.unknown, hls };
  }

  it("'untested' means NOT PROVEN → ts (untested must never select fMP4)", () => {
    expect(
      resolveSegmentFormat(withHls({ fmp4: 'untested', hevcInHls: 'untested', segmentFormatFallback: null })),
    ).toBe('ts');
  });

  it('fmp4: false → ts', () => {
    expect(
      resolveSegmentFormat(withHls({ fmp4: false, hevcInHls: 'untested', segmentFormatFallback: null })),
    ).toBe('ts');
  });

  it('fmp4: true → fmp4 (the ONLY value that selects fMP4)', () => {
    // fMP4 support is retained in the builders for a future custom receiver;
    // this is the switch that would turn it back on for a proven device.
    expect(
      resolveSegmentFormat(withHls({ fmp4: true, hevcInHls: 'untested', segmentFormatFallback: null })),
    ).toBe('fmp4');
  });

  it("segmentFormatFallback: 'ts' overrides even fmp4: true", () => {
    // The explicit per-device veto survives someone optimistically flipping fmp4.
    expect(
      resolveSegmentFormat(withHls({ fmp4: true, hevcInHls: true, segmentFormatFallback: 'ts' })),
    ).toBe('ts');
  });
});
