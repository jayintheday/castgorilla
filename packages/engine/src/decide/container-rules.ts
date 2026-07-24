/**
 * container-rules.ts — container / method legality.
 *
 * Two responsibilities:
 *  - decide whether a (video, audio, container) combination is legal for DIRECT
 *    play (bytes streamed as-is, no repackaging), and
 *  - pick the HLS segment format for a device.
 *
 * Direct-play legality is deliberately strict: only the codec/container pairs
 * Chromecast reliably plays without an HLS wrapper qualify.
 */

import type { AudioCodec, MediaContainer, VideoCodec } from '../types/media.js';
import type { DeviceProfile, SegmentFormat } from '../types/index.js';

/** Video codecs legal inside an mp4 for direct play. */
const MP4_VIDEO: ReadonlySet<VideoCodec> = new Set(['h264', 'hevc', 'av1']);
/** Audio codecs legal inside an mp4 for direct play. */
const MP4_AUDIO: ReadonlySet<AudioCodec> = new Set(['aac', 'mp3', 'ac3', 'eac3']);
/** Video codecs legal inside a webm for direct play. */
const WEBM_VIDEO: ReadonlySet<VideoCodec> = new Set(['vp8', 'vp9']);
/** Audio codecs legal inside a webm for direct play (opus excluded — Cast can't decode it). */
const WEBM_AUDIO: ReadonlySet<AudioCodec> = new Set(['vorbis']);

/**
 * Is this (video, audio, container) combo legal for direct play? Assumes the
 * caller has already decided both streams are copy-eligible.
 */
export function comboLegalForDirect(
  video: VideoCodec,
  audio: AudioCodec,
  container: MediaContainer,
): boolean {
  if (container === 'mp4') return MP4_VIDEO.has(video) && MP4_AUDIO.has(audio);
  if (container === 'webm') return WEBM_VIDEO.has(video) && WEBM_AUDIO.has(audio);
  return false;
}

/** MIME content type for a direct-played container. */
export function directContentType(container: MediaContainer): string {
  return container === 'webm' ? 'video/webm' : 'video/mp4';
}

/**
 * HLS segment format for a device: **MPEG-TS unless the profile has PROVEN fMP4
 * support** (`hls.fmp4 === true`). An explicit `segmentFormatFallback: 'ts'`
 * always wins and forces TS regardless.
 *
 * Field semantics after this inversion:
 *  - `hls.fmp4 === true`      — fMP4 (CMAF) HLS is PROVEN to render on this
 *    receiver, on real hardware, with a human confirming picture on the TV.
 *    Only this value selects fMP4.
 *  - `hls.fmp4 === false`     — proven broken. TS.
 *  - `hls.fmp4 === 'untested'`— NOT PROVEN, which is not the same as "probably
 *    fine". TS. Untested must never select fMP4: shipping fMP4 to an unproven
 *    receiver is exactly what wedged both devices we own.
 *  - `hls.segmentFormatFallback === 'ts'` — an explicit override that forces TS
 *    even if something later sets `fmp4: true`. Kept honoured (and kept in the
 *    FROZEN type) so a per-device veto stays expressible.
 *
 * WHY THE DEFAULT INVERTED (2026-07-23) — do NOT "restore" fMP4 as the default
 * on the assumption that CMAF is the more modern/obvious choice:
 *
 * fMP4 HLS does not play on the Google Cast **Default Media Receiver** at all,
 * on any device we can test, for ANY media. The failure signature is always
 * identical: LOAD is accepted, the receiver fetches playlist x2 + init x1 +
 * ~3 segments (every request HTTP 200, zero errors), then never emits BUFFERING
 * or PLAYING — it sits at `playerState: IDLE` / `extendedStatus: LOADING` and a
 * follow-up STOP times out after 5000ms. The receiver is wedged.
 *
 * The decisive control is **Apple's own reference HLS streams**, played from the
 * Chromecast HD with nothing of ours in the loop:
 *  - Apple fMP4 (`img_bipbop_adv_example_fmp4/master.m3u8`) — WEDGE.
 *  - Apple MPEG-TS (`bipbop_16x9/bipbop_16x9_variant.m3u8`) — PLAYS.
 * Same device, same session, same network. The TS control proves the device had
 * working internet, so the fMP4 wedge is real and not a network artefact, and it
 * proves the fault is not in our muxing: if Apple's reference fMP4 cannot play,
 * no fMP4 we produce will either.
 *
 * Our own runs agree: our fMP4 wedged on BOTH the Shield and the Chromecast HD,
 * while our TS played on both (a human watching the TV reported "i saw the clip"
 * for TS; "no video playback, just the loading state" for fMP4).
 *
 * Hypotheses tested and REFUTED along the way — do not re-run these hoping fMP4
 * can be coaxed into working:
 *  - muxed audio+video (video-only fMP4 wedged too),
 *  - non-conformant fragmentation (`tfhd` carries default-base-is-moof; box
 *    layout is styp/sidx/moof(mfhd,traf(tfhd,tfdt,trun))/mdat),
 *  - `-copyts -start_at_zero -avoid_negative_ts disabled` timestamps (removing
 *    them still wedged; seg0 starts at 0.046s, which is normal),
 *  - a missing `CODECS` attribute (a master playlist with
 *    CODECS="avc1.64001f,mp4a.40.2" still wedged),
 *  - the `hlsSegmentFormat` / `hlsVideoSegmentFormat` LOAD hints (wedged with
 *    and without them, including on Apple's stream).
 *
 * fMP4 support is deliberately RETAINED in the builders (`hls/playlist.ts`,
 * `ffmpeg/args.ts`) — a future custom receiver (rather than the Default Media
 * Receiver) may well want CMAF. Only the *selection* changed here: a profile
 * must earn fMP4 with `fmp4: true`.
 *
 * Note the interaction with HEVC: `decision.ts` forces an H.264 transcode when
 * the segment format is 'ts', because HEVC cannot ride MPEG-TS on this receiver
 * (the Shield rejected HEVC-in-TS explicitly — IDLE/ERROR ~0.6s after LOAD).
 * That behaviour is correct and load-bearing; with TS now the default, it simply
 * applies more often.
 */
export function resolveSegmentFormat(profile: DeviceProfile): SegmentFormat {
  // Explicit per-device veto always wins.
  if (profile.hls.segmentFormatFallback === 'ts') return 'ts';
  // Otherwise fMP4 requires a positive, hardware-proven assertion.
  return profile.hls.fmp4 === true ? 'fmp4' : 'ts';
}
