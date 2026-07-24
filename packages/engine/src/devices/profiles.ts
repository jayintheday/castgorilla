/**
 * profiles.ts — device capability table.
 *
 * Research-verified decode capabilities per Chromecast / Google TV class.
 * The planner (WS2) reads these to decide direct-play vs. remux vs. transcode.
 *
 * Notes encoded here (do not "simplify" without a hardware spike):
 *  - opus is deliberately ABSENT from audioCodecs: video Chromecasts do not
 *    decode Opus, and DTS/TrueHD are never decoded. audioCodecs lists only what
 *    the device decodes natively.
 *  - surroundPassthrough is true everywhere, but that only means AC-3/E-AC-3
 *    *passthrough* is possible; it is sink-dependent and gated by a user toggle
 *    elsewhere.
 *  - hls fields are 'untested' until a hardware spike fills them in. `shield` and
 *    `gen2` are the two entries with real hardware evidence behind their hls
 *    blocks (2026-07-23, OPEN BUG #1); see the comments on those profiles.
 *    IMPORTANT: 'untested' is NOT a soft yes. resolveSegmentFormat()
 *    (decide/container-rules.ts) selects fMP4 ONLY for `fmp4: true`, so every
 *    'untested' profile gets MPEG-TS — the safe, universally-working container.
 *    That is deliberate: fMP4 HLS does not play on the Google Cast Default Media
 *    Receiver on ANY device we can test, not even for Apple's own reference fMP4
 *    stream. Setting `fmp4: true` anywhere is a claim that a human watched that
 *    device render fMP4 HLS on a TV.
 *  - hevcInHls is currently DECORATIVE: no engine/app/cli source reads it. HEVC
 *    is instead gated by segment format in decide/decision.ts (HEVC cannot ride
 *    MPEG-TS on this receiver — the Shield rejects it with IDLE/ERROR), so with
 *    TS as the default every HEVC source is transcoded to H.264 for HLS.
 *  - vp8 fps is held at 30 across devices (VP8 is legacy; no device advertises
 *    >30 for it) — see DECISIONS note in the WS0 report.
 */

import type { DeviceAudioCodec, DeviceHlsCaps, DeviceProfile } from '../types/device.js';

/** Native decode audio codecs — identical across all current Cast hardware. */
const AUDIO_CODECS: DeviceAudioCodec[] = ['aac', 'mp3', 'flac', 'vorbis', 'pcm'];

/**
 * HLS capability placeholder — 'untested' until hardware spikes confirm.
 *
 * Behaviourally this now means MPEG-TS: resolveSegmentFormat() treats
 * 'untested' as "fMP4 not proven" and returns 'ts'. Leaving a profile on this
 * placeholder is therefore the SAFE state, not an unknown-risk state.
 */
const HLS_UNTESTED: DeviceHlsCaps = {
  fmp4: 'untested',
  hevcInHls: 'untested',
  segmentFormatFallback: null,
};

/**
 * Chromecast (1st gen). mDNS md reports "Chromecast" — indistinguishable from
 * gen2/gen3, so resolveProfile() never returns this directly (it returns gen2).
 * Kept in the table for completeness / documentation.
 */
const gen1: DeviceProfile = {
  key: 'gen1',
  matchModels: [],
  video: {
    h264: { maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 },
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  hdr: { hdr10: false, dv: false },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/**
 * Chromecast (2nd gen). This is what "Chromecast" mDNS md resolves to, since
 * gen1/gen2/gen3 all report the same md string — and also what the "Chromecast
 * HD" dongle prefix-matches to.
 */
const gen2: DeviceProfile = {
  key: 'gen2',
  matchModels: ['Chromecast'],
  video: {
    h264: { maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 },
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  hdr: { hdr10: false, dv: false },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  // fmp4: false is a RECORDED HARDWARE FACT, 2026-07-23, on a real Chromecast HD
  // (mDNS md "Chromecast HD", which prefix-matches this profile). Every fMP4 HLS
  // LOAD wedged the receiver with the same signature: LOAD accepted, playlist x2
  // + init x1 + ~3 segments fetched (all HTTP 200, no errors), then no BUFFERING
  // and no PLAYING — playerState IDLE / extendedStatus LOADING, and the
  // follow-up STOP timed out after 5000ms. Observed on screen by a human at the
  // TV: "delta is loading. but does not playback".
  //
  // Variations tried on this unit, all wedging: muxed a+v, video-only (no audio
  // track), without -copyts/-start_at_zero/-avoid_negative_ts, and with a master
  // playlist declaring CODECS="avc1.64001f,mp4a.40.2".
  //
  // The clincher is APPLE'S OWN REFERENCE STREAMS on this same device:
  // img_bipbop_adv_example_fmp4/master.m3u8 wedged (with and without the
  // hlsSegmentFormat LOAD hints); bipbop_16x9/bipbop_16x9_variant.m3u8 (MPEG-TS)
  // PLAYED. Same session, same network — so the device's internet was fine and
  // the fault is the Default Media Receiver's fMP4 handling, not our muxer. Our
  // own TS output likewise played here ("i saw the clip").
  //
  // segmentFormatFallback stays null on purpose: fmp4: false alone is now
  // sufficient to select TS (see resolveSegmentFormat). The fallback field is
  // reserved for an explicit veto that must survive someone setting fmp4: true.
  hls: {
    fmp4: false,
    // Not exercised on this unit; nothing reads it anyway. Do not infer it.
    hevcInHls: 'untested',
    segmentFormatFallback: null,
  },
};

/** Chromecast (3rd gen): H.264 up to Level 4.2 at 1080p60. */
const gen3: DeviceProfile = {
  key: 'gen3',
  matchModels: [],
  video: {
    h264: { maxLevel: 42, maxW: 1920, maxH: 1080, maxFps: 60 },
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  hdr: { hdr10: false, dv: false },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/**
 * Chromecast Ultra: H.264 1080p60, HEVC main/main10 4K60, VP9 profiles 0+2 4K60,
 * VP8. HDR10 + Dolby Vision.
 */
const ultra: DeviceProfile = {
  key: 'ultra',
  matchModels: ['Chromecast Ultra'],
  video: {
    h264: { maxLevel: 42, maxW: 1920, maxH: 1080, maxFps: 60 },
    hevc: { profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    vp9: { profiles: [0, 2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  hdr: { hdr10: true, dv: true },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/**
 * Chromecast with Google TV (4K): H.264 4K30, HEVC main/main10 4K60,
 * VP9 profile 2 4K60. No AV1. HDR10 + Dolby Vision.
 */
const ccgtv: DeviceProfile = {
  key: 'ccgtv',
  matchModels: ['Chromecast with Google TV', 'Chromecast Google TV'],
  video: {
    h264: { maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 30 },
    hevc: { profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    vp9: { profiles: [2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
  },
  hdr: { hdr10: true, dv: true },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/**
 * Google TV Streamer (4K): as ccgtv, plus AV1 4K60 and H.264 up to Level 5.2
 * at 4K60. HDR10 + Dolby Vision.
 */
const gtvStreamer: DeviceProfile = {
  key: 'gtv-streamer',
  matchModels: ['Google TV Streamer'],
  video: {
    h264: { maxLevel: 52, maxW: 3840, maxH: 2160, maxFps: 60 },
    hevc: { profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    vp9: { profiles: [2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    av1: { maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
  },
  hdr: { hdr10: true, dv: true },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/**
 * NVIDIA Shield TV (Tegra X1) — a third-party Android TV box with Chromecast
 * built in, not Google Cast hardware. All generations (2015 / 2017 / 2019 and
 * the 2019 Pro) share the Tegra X1 decoder block, so one profile covers the
 * family.
 *
 * mDNS md confirmed empirically off the unit on this LAN: "SHIELD Android TV".
 */
const shield: DeviceProfile = {
  key: 'shield',
  // "SHIELD Android TV" is the confirmed md. The bare "SHIELD" entry is a
  // deliberate catch-all for other Shield SKUs whose md we have not observed
  // (e.g. a "SHIELD Android TV Pro" string): every Shield is Tegra X1, so the
  // capability claims below hold for anything in the family, and mis-catching a
  // non-Shield device whose md starts with "SHIELD" is not a realistic risk.
  // resolveProfile() matches exact-then-longest-prefix, so "SHIELD Android TV"
  // still lands here via the exact pass, and longer variants prefix-match the
  // 17-char entry before the 6-char one.
  matchModels: ['SHIELD Android TV', 'SHIELD'],
  video: {
    // Tegra X1 H.264 decode tops out at 4K30 (High profile, Level 5.1);
    // 1080p60 is comfortably inside that envelope.
    h264: { maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 30 },
    // HEVC main/main10 4K60 — the Shield's headline capability (4K HDR streaming).
    hevc: { profiles: ['main', 'main10'], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    // VP9 profiles 0 + 2 at 4K60 — required for YouTube 4K/HDR, which the Shield ships.
    vp9: { profiles: [0, 2], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    // VP8 held at 1080p30 like every other entry (see the vp8 note in the header).
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  // No av1 key: Tegra X1 has no hardware AV1 decode on ANY Shield generation,
  // including the 2019 models. Absent (not zeroed) so capabilityCheck() reports
  // "device cannot decode AV1" rather than a bogus dimension failure.
  //
  // hdr10 is universal across Shield generations. dv is FALSE on purpose: Dolby
  // Vision is 2019-models-only, and the mDNS md is identical across all
  // generations, so we cannot tell a 2019 unit from a 2015/2017 one. Claiming DV
  // here would send DV Profile 5 to a 2015/2017 Shield, which renders as
  // green/purple garbage (see hdrGate() in decide/video-rules.ts). Do not flip
  // this to true without a way to distinguish the generation.
  hdr: { hdr10: true, dv: false },
  audioCodecs: AUDIO_CODECS,
  // Shield is a home-theatre device with AC-3 / E-AC-3 bitstream passthrough.
  surroundPassthrough: true,
  // OPEN BUG #1 RESOLVED, 2026-07-23, on the real unit (<device-ip>, md
  // "SHIELD Android TV"). The Shield accepts fMP4 HLS and then silently refuses
  // to present it; MPEG-TS segments play.
  //
  // NOT SHIELD-SPECIFIC — this was originally written up as a Shield quirk and
  // that framing is now known to be WRONG. Later the same day a real Chromecast
  // HD (profile `gen2`) wedged identically, and so did APPLE'S OWN REFERENCE
  // fMP4 stream on that device while Apple's MPEG-TS stream played. The defect
  // is in the Google Cast **Default Media Receiver**'s fMP4 handling and is
  // universal across every device we can test; the Shield is simply where we
  // first hit it. See the gen2 profile and resolveSegmentFormat() in
  // decide/container-rules.ts for the full evidence, and do not "fix" this by
  // narrowing it back to the Shield.
  //
  // The Shield run itself: two spike runs, identical in every respect except
  // segment container — same pre-baked source (both baked from
  // delta_mkv-h264-aac.mkv into fixtures/spike-hls/h264-fmp4 vs h264-ts), same
  // throwaway static server (scripts/spikes/static-server.mjs), same LOAD
  // (scripts/spikes/spike-load.mjs --duration 59.983):
  //
  //  - FMP4/FMP4: LOAD accepted (mediaSessionId 1), then playerState IDLE with
  //    extendedStatus.playerState "LOADING" for the whole 20s watch window —
  //    never BUFFERING, never PLAYING, no error and no idleReason. The server
  //    log shows playlist.m3u8 x2, init.mp4 x1, seg0/seg1/seg2.m4s, all HTTP 200
  //    in under 160ms with zero errors, and then the device simply went quiet.
  //    The follow-up STOP timed out after 5000ms — the receiver was wedged.
  //    A human watching the TV reported: "no video playback, just the loading
  //    state was displayed on tv".
  //  - TS_AAC/MPEG2_TS: IDLE -> BUFFERING (+0.54s) -> PLAYING (+0.63s), with the
  //    server log showing real-time paced segment pulls (seg0 +0.3s, seg1 +0.7s,
  //    seg2 +1.0s, seg3 +6.4s, seg4 +14.9s) and a clean STOP (IDLE/CANCELLED, no
  //    timeout). A human watching the TV reported: "i saw the clip".
  //
  // Because both runs used pre-baked media and a server sharing no code with the
  // engine, this also exonerates our own HLS pipeline: the fault is receiver-side.
  //
  // fmp4: false is the recorded fact, and since the default inverted it is on
  // its own enough to select TS. segmentFormatFallback: 'ts' is KEPT as an
  // explicit belt-and-braces veto: it forces TS even if someone later flips
  // fmp4 to true. resolveSegmentFormat() (decide/container-rules.ts) returns
  // 'ts' for this profile, and buildLoadMedia() (session/playback-session.ts)
  // then sends TS_AAC / MPEG2_TS instead of FMP4 / FMP4.
  //
  // hevcInHls stays 'untested': HEVC-in-HLS was NOT exercised in these runs, and
  // no engine/app/cli source reads that field anyway (it is currently
  // decorative). Do not infer it from the H.264 result above. Separately, the
  // Shield DID explicitly reject HEVC-in-MPEG-TS (IDLE / idleReason ERROR ~0.6s
  // after LOAD), which is why decide/decision.ts forces an H.264 transcode
  // whenever the segment format is 'ts'.
  hls: {
    fmp4: false,
    hevcInHls: 'untested',
    segmentFormatFallback: 'ts',
  },
};

/** Unknown device: conservative gen2-equivalent baseline. */
const unknown: DeviceProfile = {
  key: 'unknown',
  matchModels: [],
  video: {
    h264: { maxLevel: 41, maxW: 1920, maxH: 1080, maxFps: 30 },
    vp8: { maxW: 1920, maxH: 1080, maxFps: 30 },
  },
  hdr: { hdr10: false, dv: false },
  audioCodecs: AUDIO_CODECS,
  surroundPassthrough: true,
  hls: { ...HLS_UNTESTED },
};

/** All device profiles, keyed by DeviceKey. */
export const PROFILES: Record<DeviceProfile['key'], DeviceProfile> = {
  gen1,
  gen2,
  gen3,
  ultra,
  ccgtv,
  'gtv-streamer': gtvStreamer,
  shield,
  unknown,
};

/** Profiles that participate in mDNS md matching (have non-empty matchModels). */
const MATCHABLE: DeviceProfile[] = Object.values(PROFILES).filter((p) => p.matchModels.length > 0);

/**
 * Resolve an mDNS TXT `md` value to a DeviceProfile.
 * Matching is case-insensitive: exact match first, then longest-prefix match.
 * Anything unmatched (or empty) resolves to the conservative `unknown` profile.
 */
export function resolveProfile(mdTxt: string): DeviceProfile {
  const md = (mdTxt ?? '').trim();
  if (md.length === 0) return PROFILES.unknown;
  const lower = md.toLowerCase();

  // 1. Exact match (case-insensitive).
  for (const profile of MATCHABLE) {
    for (const model of profile.matchModels) {
      if (model.toLowerCase() === lower) return profile;
    }
  }

  // 2. Prefix match, longest model string first so the most specific wins
  //    (e.g. "Chromecast Ultra ..." beats bare "Chromecast").
  const pairs: { model: string; profile: DeviceProfile }[] = [];
  for (const profile of MATCHABLE) {
    for (const model of profile.matchModels) {
      pairs.push({ model, profile });
    }
  }
  pairs.sort((a, b) => b.model.length - a.model.length);
  for (const { model, profile } of pairs) {
    if (lower.startsWith(model.toLowerCase())) return profile;
  }

  return PROFILES.unknown;
}
