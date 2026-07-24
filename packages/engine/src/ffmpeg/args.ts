/**
 * ffmpeg/args.ts — PURE ffmpeg argv builders for the HLS streamer.
 *
 * Every recipe decision lives here, with a comment citing *why*. Nothing in this
 * file does IO: it maps a (frozen) PlaybackPlan + MediaInfo to an exact argv
 * array that FfmpegProcess spawns. All decisions were verified empirically
 * against Homebrew ffmpeg 8.1.1 (Apple Silicon, VideoToolbox) — see the
 * `ffmpeg-args` unit tests and the WS3 report for the experiments behind them.
 *
 * Path model (VERIFIED): ffmpeg is spawned with `cwd = workDir` and every output
 * name (init.mp4, seg%d.<ext>, playlist.m3u8) is emitted RELATIVE. Absolute
 * `-hls_fmp4_init_filename` fails on this build ("Failed to open segment"), so we
 * rely on cwd rather than absolute output paths. `workDir` is therefore the
 * process cwd, not embedded in the argv.
 */

import type { PlaybackPlan, MediaInfo, SegmentFormat, VideoAction, AudioAction } from '../types/index.js';

/**
 * Seconds added to the seek target on a restart so ffmpeg's keyframe seek lands
 * ON the intended boundary keyframe rather than the one *before* it.
 *
 * WHY: `-ss <t> -noaccurate_seek` before -i does a backward keyframe/cue seek. On
 * Matroska, seeking to a timestamp that is *exactly* a keyframe reliably lands on
 * the PREVIOUS keyframe (float/cue-granularity off-by-one).
 *
 * RE-DERIVED 2026-07-23, because keyframe-aligned boundaries make this constant
 * load-bearing in a way it was not before: EVERY restart target is now exactly a
 * source keyframe, so landing one keyframe early no longer costs a slightly
 * early segment — it costs the whole run's numbering (ffmpeg would emit a short
 * segment under `-start_number N` and then the real segment N under N+1). It is
 * now the single guarantee that `-start_number` is right.
 *
 * LOWER BOUND, measured by sweeping the epsilon at a known keyframe (`-ss X`,
 * first frame out) across two Matroska fixtures at DIFFERENT frame rates and
 * one MP4:
 *
 *     mkv, 30fps      keyframe 240.000  : +0.128 early, +0.130 ok
 *     mkv, 24000/1001 keyframe  24.024  : +0.128 early, +0.130 ok
 *     mp4, 30fps      keyframe  16.666  : +0.000 early, +0.010 ok
 *
 * So on Matroska the threshold is a CONSTANT ~0.129s — it does NOT scale with
 * the frame rate, and an earlier reading of it as "4 frames at 30fps" was a
 * coincidence of the one fixture it was measured on. MP4 needs only a nonzero
 * nudge. 0.25s clears both with roughly 2x margin and is the number verified on
 * hardware (a real Matroska seek-restart landed on `-start_number 95` exactly).
 * The mechanism behind the Matroska constant is NOT established — treat 0.129
 * as an observation, not a formula, and re-measure before trusting a smaller
 * value.
 *
 * UPPER BOUND, and how it changed. It used to be "far below the smallest
 * keyframe gap (6s grid / ~8.3s copy GOP)". That is weaker now: real content
 * can carry two source keyframes a few frames apart at a scene cut, and if one
 * falls in (boundary, boundary+0.25] the seek lands on IT instead. The residual
 * damage is bounded and small — the run then starts up to 0.25s late, so the
 * first segment of that run is up to 0.25s short at the front. Numbering is
 * NOT affected, because the forced-keyframe list buildHlsArgs emits is in
 * absolute media time and pins every later split to its declared boundary
 * regardless of where the run began.
 */
export const SEEK_EPSILON_SEC = 0.25;

/**
 * `-g` for the keyframe-aligned transcode grid: large enough that the encoder
 * never inserts a keyframe of its own.
 *
 * NOT cosmetic. Measured: with `-force_key_frames <boundary list>` AND the old
 * `-g 240` backstop, h264_videotoolbox emitted extra IDRs every 240 frames, the
 * HLS muxer split at each of them, and the segment numbering drifted apart from
 * the playlist within four segments — the exact defect this file is fixing. The
 * backstop has to go: on this path a stray keyframe is worse than a long GOP.
 * (`-g` cannot simply be omitted — AVCodecContext defaults gop_size to 12.)
 */
const ALIGNED_GOP_FRAMES = 100_000;

/**
 * `-hls_time` for the keyframe-aligned transcode grid.
 *
 * Measured muxer rule (ffmpeg 8.1.1): a segment ends at the first keyframe whose
 * offset from the RUN START is >= `hls_time * n`. Boundaries are >= TARGET_SEC
 * apart by construction (computeTranscodeBoundaries), so any value below
 * TARGET_SEC guarantees the running target can never overshoot the next
 * boundary — including when microsecond truncation makes a nominally-6.000s gap
 * measure 5.999999s. Staying close to TARGET_SEC (rather than dropping to, say,
 * 1s) also means a stray keyframe inside a segment would be ignored rather than
 * split on.
 */
const ALIGNED_HLS_TIME_SEC = 5.9;

/**
 * Nudge applied to each forced-keyframe request.
 *
 * ffmpeg forces a keyframe on the first frame whose pts is >= the requested
 * time. Requesting the boundary exactly makes that decision hostage to sub-
 * millisecond rounding in both `formatSeconds()` and the container timebase; a
 * request that rounds even 1µs LATE selects the following frame instead. Asking
 * 1ms early cannot select the previous frame (a whole frame interval — >=4ms at
 * any sane rate — away) and removes the rounding question entirely.
 */
const KEYFRAME_GUARD_SEC = 0.001;

/** The fmp4 init segment file name (relative to workDir). */
export const INIT_SEGMENT_NAME = 'init.mp4';

/** The synthesized/served playlist name (relative to workDir). */
export const PLAYLIST_NAME = 'playlist.m3u8';

/** Segment file extension for a given segment format. */
export function segmentExt(format: SegmentFormat): 'm4s' | 'ts' {
  return format === 'fmp4' ? 'm4s' : 'ts';
}

/** Segment file name for a produced segment index, e.g. seg7.m4s / seg7.ts. */
export function segmentName(index: number, format: SegmentFormat): string {
  return `seg${index}.${segmentExt(format)}`;
}

/** ffmpeg's `-hls_segment_filename` template for a given format. */
export function segmentTemplate(format: SegmentFormat): string {
  return `seg%d.${segmentExt(format)}`;
}

export interface BuildHlsArgsOpts {
  /** Absolute path to the source media file. */
  input: string;
  plan: PlaybackPlan;
  media: MediaInfo;
  /** Directory ffmpeg runs in (its cwd); output names are relative to it. */
  workDir: string;
  /** Segment index this run should begin emitting (0 = initial start). */
  startBoundaryIndex: number;
  /** Absolute segment-boundary times in seconds, index-aligned with segment numbers. */
  boundaries: number[];
}

/**
 * Build the exact ffmpeg argv for one HLS run (initial start OR seek restart).
 *
 * The same builder produces both: startBoundaryIndex 0 is the initial start
 * (no -ss, -start_number 0); any other index is a seek restart at
 * boundaries[startBoundaryIndex] (+ SEEK_EPSILON) with that -start_number.
 */
export function buildHlsArgs(opts: BuildHlsArgsOpts): string[] {
  const { plan, media, startBoundaryIndex, boundaries } = opts;
  const segFmt: SegmentFormat = plan.segmentFormat ?? 'fmp4';
  const isFmp4 = segFmt === 'fmp4';
  const isInitial = startBoundaryIndex === 0;
  const boundarySec = boundaries[startBoundaryIndex] ?? 0;

  const srcVideo = media.video.find((v) => v.index === plan.videoStreamIndex);

  /**
   * Is this a transcode whose boundaries are real source keyframes?
   *
   * That question decides three things at once — the seek mode, the forced
   * keyframe placement and the `-g` backstop — because they are one mechanism:
   * "the run starts exactly at boundaries[startBoundaryIndex] and splits
   * exactly at the boundaries after it".
   */
  const keyframeAligned =
    plan.video.kind === 'transcode' && plan.segmentation?.mode === 'keyframe';

  const args: string[] = [];

  // --- Global options -----------------------------------------------------
  args.push('-y'); // overwrite the playlist/segments in the (freshly cleaned) workDir
  args.push('-nostats'); // machine-readable progress only, no human stats spam
  args.push('-loglevel', 'error'); // keep stderr to real errors (feeds the ring buffer)
  args.push('-progress', 'pipe:1'); // key=value progress on stdout (out_time_us → position)

  // --- Seek (restart only) ------------------------------------------------
  // Jellyfin-style fast seek: keyframe seek BEFORE -i, no accurate (re-decode) seek.
  // + SEEK_EPSILON so we land ON the boundary keyframe (see constant above).
  //
  // THE ONE EXCEPTION is a transcode with no keyframe index — segmentation
  // mode 'fixed', a 6s grid that owes nothing to the source. A fast seek there
  // lands on the preceding source keyframe, up to a full GOP before the
  // boundary, and `-start_number` then mislabels every segment of the run (this
  // is the whole of docs/segment-numbering-drift.md). Since we are re-encoding
  // anyway we can pay for correctness with an ACCURATE seek: ffmpeg decodes
  // from that keyframe and discards until the boundary.
  //
  // WHAT THAT BUYS, precisely — an earlier version of this comment claimed "the
  // first output frame is the boundary exactly", which is true only at integer
  // frame rates and was measured on a 30fps fixture. Corrected by sweeping
  // frame rate and codec independently:
  //
  //   30fps      (8-bit H.264 AND 10-bit HEVC)  : delta 0.000000, exact
  //   24000/1001 (8-bit H.264 AND 10-bit HEVC)  : +0.006 .. +0.066, sawtooth
  //
  // The codec and bit depth are irrelevant; the FRAME RATE is the variable. At
  // 24000/1001 no multiple of 6 is a frame time, so the first output frame is
  // the first frame AT OR AFTER the boundary (one quantisation), and the
  // `expr:` forced keyframes quantise to the same grid from the run's own start
  // (a second). Hence: never early, and strictly under TWO frame intervals late
  // (~83ms at 23.976fps). Never early is the property that matters — early is
  // what served segment N with segment N-1's content.
  //
  // It is also RESTART-INVARIANT in video: segment N holds the same media time
  // whichever run wrote it (verified by first-PTS to 3 decimals — the video ES
  // is NOT bit-comparable here because h264_videotoolbox is a hardware encoder
  // and not deterministic across runs). So different boundaries land on
  // different content: no byte-identical collision, no catastrophic overwrite.
  // Audio framing is phase-dependent across runs by up to one AAC frame (~21ms).
  //
  // Measured cost on the 45-min fixture: 0.46s to a complete first segment vs
  // 0.42s for the fast seek; a 720p10 HEVC source decodes at ~39x realtime, so
  // even a pathological 20.9s GOP is ~0.5s. Cheap insurance on a path we only
  // reach when keyframe extraction failed.
  if (!isInitial) {
    if (plan.video.kind === 'transcode' && !keyframeAligned) {
      args.push('-ss', formatSeconds(boundarySec));
    } else {
      args.push('-ss', formatSeconds(boundarySec + SEEK_EPSILON_SEC), '-noaccurate_seek');
    }
  }

  // --- Timestamp handling (EVERY run, all tiers) --------------------------
  // VERIFIED to work for copy AND transcode. Keeps output PTS = absolute media
  // time so: (a) copied segments carry true timestamps across a seek restart,
  // and (b) the transcode force-keyframe grid lands on absolute 6s boundaries.
  // (My earlier "breakage" was a test-only `-t` interacting with copyts, not
  // these flags.)
  args.push('-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled');

  // --- Input --------------------------------------------------------------
  args.push('-i', opts.input);

  // --- Stream mapping (absolute ffprobe indices from the plan) ------------
  // The planner emits audioStreamIndex: -1 for audio-less files. Mapping a
  // negative index (and emitting audio codec args) produces invalid argv, so
  // the audio stream is only mapped/encoded when a real audio stream exists.
  const hasAudio = plan.audioStreamIndex >= 0;
  args.push('-map', `0:${plan.videoStreamIndex}`);
  if (hasAudio) args.push('-map', `0:${plan.audioStreamIndex}`);

  // --- Video --------------------------------------------------------------
  pushVideoArgs(args, plan.video, srcVideo?.hdr.type ?? 'none', srcVideo?.codec === 'hevc', {
    keyframeAligned,
    // Only the boundaries this run will actually reach; the earlier ones are
    // harmless (ffmpeg walks past them) but pointless argv.
    forcedKeyframes: keyframeAligned ? boundaries.slice(startBoundaryIndex + 1) : [],
  });

  // --- Audio --------------------------------------------------------------
  if (hasAudio) pushAudioArgs(args, plan.audio);
  else args.push('-an'); // no audio stream to carry

  // No subtitles / data in the media stream (subs are served as sidecar VTT).
  args.push('-sn', '-dn');

  // --- HLS muxer ----------------------------------------------------------
  args.push('-f', 'hls');
  args.push('-hls_segment_type', isFmp4 ? 'fmp4' : 'mpegts');
  args.push('-hls_time', keyframeAligned ? String(ALIGNED_HLS_TIME_SEC) : '6');
  args.push('-hls_list_size', '0'); // VOD: keep the full list
  if (isFmp4) {
    // fmp4: a single shared init segment; ts tiers are self-initializing.
    args.push('-hls_fmp4_init_filename', INIT_SEGMENT_NAME);
  }
  args.push('-hls_segment_filename', segmentTemplate(segFmt));
  // independent_segments: every segment starts on a keyframe (Cast/Safari need this).
  // temp_file: segments are written to a temp name and atomically renamed into
  // place — that rename is HlsSession's readiness signal (no half-written reads).
  args.push('-hls_flags', 'independent_segments+temp_file');
  args.push('-start_number', String(startBoundaryIndex));

  // --- Output (relative; ffmpeg cwd === workDir) --------------------------
  // ffmpeg writes its own playlist here; HlsSession serves a SYNTHESIZED VOD
  // playlist instead, so this file is effectively a scratch output.
  args.push(PLAYLIST_NAME);

  return args;
}

interface KeyframeOpts {
  /** Boundaries are real source keyframes → force one at each, and nowhere else. */
  keyframeAligned: boolean;
  /** Absolute boundary times this run must split at (already sliced past the start). */
  forcedKeyframes: number[];
}

/** Emit the video codec + filter + keyframe args for the chosen action. */
function pushVideoArgs(
  args: string[],
  video: VideoAction,
  srcHdr: MediaInfo['video'][number]['hdr']['type'],
  srcIsHevc: boolean,
  kf: KeyframeOpts,
): void {
  if (video.kind === 'copy') {
    args.push('-c:v', 'copy');
    // hvc1 (not hev1) so Cast/Safari recognize copied HEVC. Tag when the source
    // stream is HEVC or the plan explicitly asks for it.
    if (srcIsHevc || video.tag === 'hvc1') args.push('-tag:v', 'hvc1');
    return;
  }

  // transcode
  args.push('-c:v', video.encoder);
  args.push('-q:v', String(video.quality)); // VideoToolbox constant-quality knob

  if (video.profile === 'main10') args.push('-profile:v', 'main10');
  if (video.pixFmt === 'p010le') args.push('-pix_fmt', 'p010le');

  // Output is HEVC → tag hvc1 (applies to transcode as well as copy).
  if (video.encoder === 'hevc_videotoolbox') args.push('-tag:v', 'hvc1');

  // Video filter chain: scale first, then HDR color-tag preservation.
  const vf: string[] = [];
  if (video.scale) vf.push(`scale=${video.scale.w}:${video.scale.h}`);
  if (srcHdr === 'hdr10' && video.profile === 'main10') {
    // VideoToolbox DROPS color tags set as output options, so we must stamp them
    // through the filtergraph (WS0-verified). Only for a true HDR10 (PQ/BT.2020)
    // source; SDR sources get NO setparams. The trailing format=p010le keeps the
    // 10-bit pixel format after the tag stamp.
    vf.push('setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc');
    vf.push('format=p010le');
  }
  if (vf.length > 0) args.push('-vf', vf.join(','));

  if (video.maxFps !== undefined) args.push('-r', String(video.maxFps));

  if (kf.keyframeAligned) {
    // KEYFRAME-ALIGNED GRID: force a keyframe at each declared boundary, in
    // ABSOLUTE media time, and let nothing else produce one.
    //
    // The absolute form is essential and is NOT interchangeable with the expr
    // below. Measured against ffmpeg 8.1.1: an explicit `-force_key_frames`
    // list is matched against absolute output timestamps (which `-copyts`
    // keeps as true media time), whereas `expr:`'s `t` is relative to the RUN
    // START. A restart landing at 25.0s with the expr produced keyframes at
    // 25/31/37/43 — a 6s grid anchored to the seek point, not to the playlist —
    // which is why a fixed grid could never be made restart-invariant.
    //
    // An empty list is legitimate: the run has no boundary left to split at
    // (last segment), so it should emit exactly one segment and stop.
    if (kf.forcedKeyframes.length > 0) {
      args.push(
        '-force_key_frames',
        kf.forcedKeyframes.map((t) => formatSeconds(t - KEYFRAME_GUARD_SEC)).join(','),
      );
    }
    args.push('-g', String(ALIGNED_GOP_FRAMES));
    return;
  }

  // FIXED GRID (no keyframe index available). Force keyframes every 6s from the
  // run start; combined with the accurate seek buildHlsArgs() uses on this path,
  // the run starts exactly on a boundary so that grid is the boundary grid.
  // -g 240 is a hard backstop if the expression ever misses.
  args.push('-force_key_frames', 'expr:gte(t,n_forced*6)');
  args.push('-g', '240');
}

/** Emit the audio codec / bitrate / channel / filter args for the chosen action. */
function pushAudioArgs(args: string[], audio: AudioAction): void {
  if (audio.kind === 'copy') {
    // AC-3 / E-AC-3 copy into fmp4 HLS needs NO extra movflags (delay_moov is
    // only required for PROGRESSIVE single-file fmp4; the HLS segment muxer
    // handles the init timing itself). Verified with the ac3 fixture.
    args.push('-c:a', 'copy');
    return;
  }

  args.push('-c:a', audio.encoder);
  args.push('-b:a', audio.bitrate);
  args.push('-ac', String(audio.channels));
  if (audio.filters && audio.filters.length > 0) {
    args.push('-af', audio.filters.join(','));
  }
}

/**
 * Format a seconds value for `-ss`. Rounds to millisecond precision so exact-argv
 * tests stay stable (240 → "240", 240.25 → "240.25"), avoiding float noise like
 * 240.25000000001.
 */
export function formatSeconds(sec: number): string {
  return String(Math.round(sec * 1000) / 1000);
}
