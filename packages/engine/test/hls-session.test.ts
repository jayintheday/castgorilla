/**
 * hls-session (integration — real ffmpeg on fixtures):
 *  (a) remux golden-shape + seg0 codecs + EXTINF≈duration
 *  (b) hevc remux → hvc1 tag on produced segment
 *  (c) ac3 copy muxes OK (reports whether extra flags are needed → they are NOT)
 *  (d) seek-restart: relaunch at boundary 40, first PTS ≈ boundary ±0.5s
 *  (p) seek-restart onto a boundary that is NOT a source keyframe (transcode,
 *      fixed grid): first PTS must still be the boundary — (d) generalised
 *  (q) keyframe-aligned transcode grid: EVERY segment of a restart run starts
 *      at its declared boundary, not just the first
 *  (r) byte-identity regression: restarts at adjacent boundaries must not emit
 *      the same video under two different segment numbers
 *  (e) seek-storm: one surviving ffmpeg, last index wins
 *  (j) BACKWARD seek-storm: waiters AHEAD of the new start are superseded too
 *  (k) read-ahead boundary: newStart/+1/+3 survive, +4/+10 are superseded
 *  (l) forward seek still supersedes everything below the new start
 *  (m) an abandoned probe does NOT steer ffmpeg (the restart is skipped)
 *  (n) a live request wins over a dead NEWER one
 *  (o) an all-live burst is still last-wins (liveness must not reorder)
 *  (g) transcode speed: 30s of 4K → hevc HLS < 30s wall
 *  (h) lifecycle timing: ffmpeg launch / init.mp4 ready / seg0 ready are logged
 *      at info with an elapsed-ms figure (the first-segment latency)
 *
 * (f) end-to-end decode through the MediaServer lives in server-media.test.ts.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { HlsSession, SupersededError, RequestAbandonedError } from '../src/hls/session.js';
import { fixedBoundaries } from '../src/hls/boundaries.js';
import { computeTranscodeBoundaries } from '../src/decide/decision.js';
import { extractKeyframeIndex } from '../src/probe/keyframes.js';
import type { MediaInfo, PlaybackPlan, VideoAction, AudioAction, VideoCodec, HdrType } from '../src/types/index.js';
import type { Logger } from '../src/util/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');
/** Mirrors RESTART_DEBOUNCE_MS in src/hls/session.ts (deliberately not exported). */
const DEBOUNCE_MS = 250;

let ff: FfmpegTools;
const sessions: HlsSession[] = [];

beforeAll(async () => {
  ff = await resolveFfmpeg();
});

afterEach(async () => {
  const live = sessions.splice(0);
  await Promise.all(live.map((s) => s.dispose()));
  // No stray ffmpeg left behind — checked per-session so we don't collide with
  // other test files that vitest runs in parallel.
  for (const s of live) expect(s.aliveFfmpegCount).toBe(0);
});

async function workdir(tag: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `ss-hls-${tag}-`));
}

function media(file: string, durationSec: number, videoCodec: VideoCodec, hdr: HdrType = 'none', dims = { w: 1920, h: 1080 }): MediaInfo {
  return {
    path: path.join(FIX, file),
    container: file.endsWith('.mp4') ? 'mp4' : 'mkv',
    durationSec,
    video: [{ index: 0, codec: videoCodec, width: dims.w, height: dims.h, fps: 30, bitDepth: hdr === 'none' ? 8 : 10, hdr: { type: hdr } }],
    audio: [{ index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, isDefault: true }],
    subtitles: [],
  };
}

function plan(video: VideoAction, audio: AudioAction, durationSec: number, extra: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    method: 'hls', tier: 'remux', reasons: [], video, audio,
    videoStreamIndex: 0, audioStreamIndex: 1, segmentFormat: 'fmp4',
    contentType: 'application/vnd.apple.mpegurl', durationSec, hdrOutcome: 'preserved', subtitles: [], ...extra,
  };
}

function newSession(m: MediaInfo, p: PlaybackPlan, boundaries: number[], dir: string): HlsSession {
  const s = new HlsSession({ media: m, plan: p, boundaries, input: m.path, workDir: dir, ff });
  sessions.push(s);
  return s;
}

/** Concatenate init + segment into a probeable temp file, return its path. */
async function combineInitSeg(dir: string, segFile: string, suffix: string): Promise<string> {
  const init = await readFile(path.join(dir, 'init.mp4'));
  const seg = await readFile(path.join(dir, segFile));
  const combined = path.join(dir, `${segFile}.${suffix}.mp4`);
  await writeFile(combined, Buffer.concat([init, seg]));
  return combined;
}

/** ffprobe a stream property of a produced fmp4 segment (default format, no commas). */
async function probeSegment(dir: string, segFile: string, streamSel: string, entries: string): Promise<string> {
  const combined = await combineInitSeg(dir, segFile, 'probe');
  return execFileSync(
    ff.ffprobe,
    ['-v', 'error', '-select_streams', streamSel, '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', combined],
    { encoding: 'utf8' },
  ).trim();
}

/** md5 of a segment's AUDIO elementary stream — see test (r) for why audio. */
async function audioStreamMd5(segPath: string): Promise<string> {
  return execFileSync(
    ff.ffmpeg,
    ['-v', 'error', '-i', segPath, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'],
    { encoding: 'utf8' },
  ).trim();
}

/** First video PTS of a self-contained MPEG-TS segment (no init to prepend). */
async function firstTsVideoPts(segPath: string): Promise<number> {
  const out = execFileSync(
    ff.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'default=noprint_wrappers=1:nokey=1', '-read_intervals', '%+#1', segPath],
    { encoding: 'utf8' },
  ).trim();
  return Number(out.split('\n')[0]);
}

async function firstVideoPts(dir: string, segFile: string): Promise<number> {
  const combined = await combineInitSeg(dir, segFile, 'pts');
  const out = execFileSync(
    ff.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'default=noprint_wrappers=1:nokey=1', '-read_intervals', '%+#1', combined],
    { encoding: 'utf8' },
  ).trim();
  return Number(out.split('\n')[0]);
}

describe('HlsSession (integration)', () => {
  it('(a) remux h264+aac: golden playlist shape, init + seg0, EXTINF≈duration', async () => {
    const dir = await workdir('remux');
    const m = media('delta_mkv-h264-aac.mkv', 60.021, 'h264');
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'copy' }, m.durationSec), bounds, dir);

    const pl = s.playlistText();
    expect(pl.startsWith('#EXTM3U')).toBe(true);
    expect(pl).toContain('#EXT-X-VERSION:7');
    expect(pl).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(pl).toContain('#EXT-X-ENDLIST');
    const sum = [...pl.matchAll(/#EXTINF:([\d.]+),/g)].reduce((a, x) => a + Number(x[1]), 0);
    expect(Math.abs(sum - m.durationSec)).toBeLessThan(1);

    const init = await s.getInitSegment();
    expect(existsSync(init)).toBe(true);
    const seg0 = await s.getSegment(0);
    expect(existsSync(seg0)).toBe(true);
    expect(await probeSegment(dir, 'seg0.m4s', 'v:0', 'stream=codec_name')).toBe('h264');
    // audio present in the segment too
    expect(await probeSegment(dir, 'seg0.m4s', 'a:0', 'stream=codec_name')).toBe('aac');
  }, 30_000);

  it('(b) hevc remux: produced segment carries the hvc1 tag', async () => {
    const dir = await workdir('hevc');
    const m = media('kilo_mkv-hevc8-aac.mkv', 60.021, 'hevc');
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy', tag: 'hvc1' }, { kind: 'copy' }, m.durationSec), bounds, dir);
    await s.getInitSegment();
    await s.getSegment(0);
    const tag = await probeSegment(dir, 'seg0.m4s', 'v:0', 'stream=codec_tag_string');
    expect(tag).toBe('hvc1');
  }, 30_000);

  it('(c) ac3 copy: muxes into fmp4 HLS with NO extra movflags', async () => {
    const dir = await workdir('ac3');
    const m = media('golf_mkv-h264-ac3.mkv', 60, 'h264');
    m.audio[0] = { index: 1, codec: 'ac3', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'copy' }, m.durationSec), bounds, dir);
    await s.getInitSegment();
    const seg0 = await s.getSegment(0);
    expect(existsSync(seg0)).toBe(true);
    // init has a valid audio config despite AC-3's delayed parse → segment probes clean
    expect(await probeSegment(dir, 'seg0.m4s', 'v:0', 'stream=codec_name')).toBe('h264');
    expect(await probeSegment(dir, 'seg0.m4s', 'a:0', 'stream=codec_name')).toBe('ac3');
  }, 30_000);

  it('(d) seek-restart: relaunch at seg40, first PTS ≈ boundary ±0.5s', async () => {
    const dir = await workdir('seek');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6); // bounds[40] = 240 (a keyframe on this fixture)
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);
    const pidBefore = s.ffmpegPid;
    expect(s.runStart).toBe(0);

    const segPath = await s.getSegment(40); // far → single-flight restart
    expect(existsSync(segPath)).toBe(true);
    expect(s.runStart).toBe(40); // relaunched at the right boundary
    expect(s.ffmpegPid).not.toBe(pidBefore);

    const pts = await firstVideoPts(dir, 'seg40.m4s');
    expect(Math.abs(pts - 240)).toBeLessThanOrEqual(0.5);
  }, 40_000);

  /**
   * (p)–(r) are the segment-numbering-drift regression set
   * (docs/segment-numbering-drift.md).
   *
   * Test (d) above passes for the wrong reason: `bounds[40] = 240` and 240
   * happens to BE a source keyframe on this fixture, so the fast seek lands on
   * it and the numbering comes out right. The fixture's real GOP is 8.333s
   * against a 6s grid, so 246 (bounds[41]) is NOT a keyframe — `-ss 246.25
   * -noaccurate_seek` snaps back to 240 and the whole run is served one index
   * late. That is the defect, and 240/246 are also the collision pair: two
   * adjacent boundaries inside one source GOP.
   *
   * They run on the video-transcode tier because that is the only tier the
   * defect reaches — the copy tiers segment on source keyframes already.
   */

  const TRANSCODE: VideoAction = { kind: 'transcode', encoder: 'h264_videotoolbox', quality: 50 };

  function transcodeMedia(): MediaInfo {
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264', 'none', { w: 640, h: 360 });
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    return m;
  }

  it('(p) restart onto a NON-keyframe boundary (fixed grid): first PTS is the boundary', async () => {
    const dir = await workdir('driftfixed');
    const m = transcodeMedia();
    const bounds = fixedBoundaries(m.durationSec, 6); // bounds[41] = 246, NOT a keyframe
    const s = newSession(
      m,
      plan(TRANSCODE, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 }, m.durationSec, {
        tier: 'video-transcode',
        segmentation: { mode: 'fixed', targetSec: 6 },
      }),
      bounds,
      dir,
    );

    expect(existsSync(await s.getSegment(41))).toBe(true);
    expect(s.runStart).toBe(41);

    // THE ASSERTION THAT FAILED BEFORE THE FIX: 240.0 came out here, because the
    // fast seek landed on the source keyframe at 240 while -start_number said 41.
    const pts = await firstVideoPts(dir, 'seg41.m4s');
    expect(pts).toBeCloseTo(246, 1);
  }, 60_000);

  it('(q) keyframe-aligned transcode grid: every segment of a run starts at its boundary', async () => {
    const dir = await workdir('driftaligned');
    const m = transcodeMedia();
    // The real thing: source keyframes off the file, then the planner's
    // transcode boundary rule. No hand-picked numbers.
    const kf = await extractKeyframeIndex(m.path, 0);
    expect(kf.length).toBeGreaterThan(50);
    const bounds = computeTranscodeBoundaries(kf, m.durationSec, 6);
    const START = 30;
    // Not vacuous: the grid must genuinely be irregular, or this proves nothing
    // that (d) did not already.
    const gaps = bounds.slice(1).map((b, i) => b - bounds[i]!);
    expect(Math.max(...gaps)).toBeGreaterThan(6.5);

    const s = newSession(
      m,
      plan(TRANSCODE, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 }, m.durationSec, {
        tier: 'video-transcode',
        segmentation: { mode: 'keyframe', targetSec: 6, boundaries: bounds },
      }),
      bounds,
      dir,
    );

    await s.getSegment(START);
    expect(s.runStart).toBe(START);
    // START+1 and +2 come from the SAME run (near window), so they test the
    // muxer's split points rather than another seek. Before the fix these came
    // out at boundary+6 and boundary+12 — the encoder's own grid, anchored to
    // the seek point instead of to the playlist.
    await s.getSegment(START + 1);
    await s.getSegment(START + 2);

    for (const i of [START, START + 1, START + 2]) {
      const pts = await firstVideoPts(dir, `seg${i}.m4s`);
      // Sub-millisecond, not "within 0.05". A loose tolerance here is how the
      // fractional-rate offset stayed hidden — see test (s).
      expect(Math.abs(pts - bounds[i]!), `seg${i} vs boundary ${bounds[i]}`).toBeLessThan(0.002);
    }
  }, 90_000);

  it('(r) two restarts at adjacent boundaries do NOT emit identical video under different numbers', async () => {
    // The reproduction from docs/segment-numbering-drift.md §2, unit-sized:
    // boundaries 40 (240s) and 41 (246s) fall inside ONE source GOP, so before
    // the fix both runs entered at 240 and `md5(runA/seg40) == md5(runB/seg41)`.
    // Whichever run wrote last then decided what segment 41 contained — which is
    // how a receiver ends up holding two different versions of one segment.
    //
    // MPEG-TS deliberately, unlike (p)/(q): it is what we actually ship, and it
    // is the only one of the two formats where byte identity is a real signal.
    // fmp4 stamps per-run sequence numbers into every `moof`, so two runs of the
    // SAME video hash differently and the check passes for free.
    const m = transcodeMedia();
    const bounds = fixedBoundaries(m.durationSec, 6);
    const p = plan(TRANSCODE, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 }, m.durationSec, {
      tier: 'video-transcode',
      segmentFormat: 'ts',
      segmentation: { mode: 'fixed', targetSec: 6 },
    });

    const dirA = await workdir('driftA');
    const dirB = await workdir('driftB');
    const a = newSession(m, p, bounds, dirA);
    const b = newSession(m, p, bounds, dirB);

    const [segA, segB] = await Promise.all([a.getSegment(40), b.getSegment(41)]);

    // HASH, NOT SIZE — and specifically the AUDIO elementary stream.
    //
    // The pre-fix signature measured on this fixture is exactly the one in the
    // doc: seg40 and seg41 came out 609496 bytes each, with an identical audio
    // ES hash, because both runs encoded the same 240s–246s of media. Which
    // hash matters, though, was worth measuring rather than assuming:
    //   - whole file: differs even pre-fix (mpegts framing) → asserting it
    //     "not equal" would pass for free.
    //   - video ES:   differs even pre-fix — h264_videotoolbox is a hardware
    //     encoder and is not bit-deterministic across runs.
    //   - audio ES:   BIT-IDENTICAL pre-fix, different post-fix. aac_at is
    //     deterministic, so this hash tracks media time and nothing else.
    // A size comparison would also have worked here, and is exactly the check
    // most likely to pass by luck on other content.
    expect(await audioStreamMd5(segA)).not.toBe(await audioStreamMd5(segB));

    // …and say WHY they differ, so a failure here is diagnosable. Asserted as a
    // DIFFERENCE because the mpegts muxer offsets every timestamp by its initial
    // PCR delay; the delay is identical in both runs and cancels, whereas
    // hard-coding it would make the test a hostage to a muxer default. Pre-fix
    // this gap was 0 — two segment numbers, one piece of video.
    const gap = (await firstTsVideoPts(segB)) - (await firstTsVideoPts(segA));
    expect(gap).toBeCloseTo(bounds[41]! - bounds[40]!, 1);
  }, 90_000);

  /**
   * (s) FRACTIONAL FRAME RATE — the variable that (p)/(q)/(r) cannot express.
   *
   * Every other fixture is 30fps, where a 6s boundary always coincides with a
   * frame. At 24000/1001 no multiple of 6 does, and the two paths behave
   * DIFFERENTLY as a result. That difference was originally mis-reported as
   * "+1.43s late on 10-bit HEVC"; single-variable measurement showed the codec
   * and bit depth are irrelevant (8-bit H.264 and 10-bit HEVC at 23.976 are
   * identical to the microsecond, and 10-bit HEVC at 30fps is exact) and that
   * 1.400s of the 1.43 was the mpegts muxer's initial PCR delay — an artifact
   * present on every tier and every path. Hence fmp4 here: no muxdelay, so the
   * numbers are the content's and not the muxer's.
   *
   * See docs/segment-numbering-drift.md §9.5.
   */
  it('(s) fractional rate 24000/1001: aligned grid is EXACT, fixed-grid fallback is late but bounded', async () => {
    const m = media('quebec_mkv-h264-23976fps.mkv', 60.021, 'h264', 'none', { w: 640, h: 360 });
    m.video[0]!.fps = 24000 / 1001;
    const FRAME = 1001 / 24000;
    const audio: AudioAction = { kind: 'transcode', encoder: 'aac_at', bitrate: '128k', channels: 2 };

    // --- the shipped path: boundaries ARE source keyframes, so they are on the
    // frame grid by construction and a RESTART enters exactly on one.
    const kf = await extractKeyframeIndex(m.path, 0);
    const bounds = computeTranscodeBoundaries(kf, m.durationSec, 6);
    const dirK = await workdir('fracaligned');
    const sK = newSession(
      m,
      plan(TRANSCODE, audio, m.durationSec, {
        tier: 'video-transcode',
        segmentation: { mode: 'keyframe', targetSec: 6, boundaries: bounds },
      }),
      bounds,
      dirK,
    );
    const START = 5; // beyond NEAR_WINDOW, so this is a real seek-restart
    await sK.getSegment(START);
    await sK.getSegment(START + 1);
    for (const i of [START, START + 1]) {
      const pts = await firstVideoPts(dirK, `seg${i}.m4s`);
      // EXACT — sub-millisecond, not "within half a second". This is the
      // guarantee the keyframe-aligned grid buys and the fallback cannot.
      expect(Math.abs(pts - bounds[i]!), `seg${i} vs boundary ${bounds[i]}`).toBeLessThan(0.002);
    }

    // …but the INITIAL run (no -ss) is a different case, and the distinction is
    // load-bearing. ffmpeg rebases the whole output on the earliest mapped
    // stream, and audio rarely starts at 0 — this fixture's AAC begins at
    // -0.021 (encoder priming), and re-encoding it adds another frame of delay.
    // Measured: +0.000 with -an, +0.021 with audio copied, +0.044 with audio
    // transcoded. A -ss restart rebases from the seek point and does not carry
    // it. The result is a UNIFORM shift of the initial run, identical on every
    // one of its segments — EXTINF spacing intact, no numbering error, three
    // orders of magnitude below the 6s defect this file is about. Pinned so it
    // stays a known quantity rather than being rediscovered as a regression.
    const dir0 = await workdir('fracinitial');
    const s0 = newSession(
      m,
      plan(TRANSCODE, audio, m.durationSec, {
        tier: 'video-transcode',
        segmentation: { mode: 'keyframe', targetSec: 6, boundaries: bounds },
      }),
      bounds,
      dir0,
    );
    await s0.getSegment(0);
    await s0.getSegment(1);
    const shift0 = (await firstVideoPts(dir0, 'seg0.m4s')) - bounds[0]!;
    const shift1 = (await firstVideoPts(dir0, 'seg1.m4s')) - bounds[1]!;
    expect(shift0).toBeGreaterThanOrEqual(0);
    expect(shift0).toBeLessThan(0.1);
    expect(shift1, 'the initial run is shifted UNIFORMLY, not drifting').toBeCloseTo(shift0, 3);

    // --- the fallback: a fixed grid whose boundaries are not reachable frames.
    const fixed = fixedBoundaries(m.durationSec, 6);
    const fallbackPlan = plan(TRANSCODE, audio, m.durationSec, {
      tier: 'video-transcode',
      segmentation: { mode: 'fixed', targetSec: 6 },
    });
    const dirA = await workdir('fracfallA');
    const dirB = await workdir('fracfallB');
    const sA = newSession(m, fallbackPlan, fixed, dirA);
    const sB = newSession(m, fallbackPlan, fixed, dirB);
    await sA.getSegment(5);
    await sA.getSegment(6);
    await sB.getSegment(6);

    for (const [dir, i] of [[dirA, 5], [dirA, 6], [dirB, 6]] as const) {
      const pts = await firstVideoPts(dir, `seg${i}.m4s`);
      const delta = pts - fixed[i]!;
      // NEVER EARLY is the correctness property — early is what served segment N
      // with segment N-1's content. Late is bounded by TWO frame intervals: one
      // for the accurate seek landing on the first frame at/after the boundary,
      // one for the forced-keyframe expression quantising to the same grid.
      expect(delta, `seg${i} must not start before its boundary`).toBeGreaterThanOrEqual(0);
      expect(delta, `seg${i} must be within 2 frame intervals`).toBeLessThan(2 * FRAME);
    }

    // RESTART-INVARIANCE, the property that actually matters on the fallback:
    // segment 6 must hold the same media time whichever run wrote it, or a
    // receiver caching across a seek sees the timeline move under it. "Uniformly
    // shifted but self-consistent" is a real guarantee; "exact" is not one the
    // fallback can make, and the two must not be confused.
    expect(await firstVideoPts(dirB, 'seg6.m4s')).toBeCloseTo(await firstVideoPts(dirA, 'seg6.m4s'), 3);
    // …and adjacent boundaries still land on different content (test (r)'s
    // property, re-checked at a fractional rate).
    expect(await firstVideoPts(dirA, 'seg6.m4s')).toBeGreaterThan((await firstVideoPts(dirA, 'seg5.m4s')) + 5.9);
  }, 90_000);

  it('(e) seek-storm: 5 far requests in one tick → one ffmpeg, last index wins', async () => {
    const dir = await workdir('storm');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    // Burst 5 far requests synchronously (well within 100ms); last (max) wins.
    const indices = [50, 100, 150, 200, 250];
    const results = await Promise.allSettled(indices.map((i) => s.getSegment(i)));

    // exactly one ffmpeg alive, at the last requested index
    expect(s.aliveFfmpegCount).toBe(1);
    expect(s.runStart).toBe(250);
    expect(s.ffmpegRunning).toBe(true);
    // the last index resolved…
    expect(results[4]?.status).toBe('fulfilled');
    // …and the superseded earlier ones were rejected (not silently hung)
    expect(results.slice(0, 4).every((r) => r.status === 'rejected')).toBe(true);

    // The rejection reason is load-bearing, not incidental: MediaServer.hlsError()
    // instanceof-detects it to log at debug and keep the response out of
    // RouteStats.errors. A bare Error here would silently restore the 24-ERROR
    // lines-per-scrub defect.
    for (const r of results.slice(0, 4)) {
      const reason = (r as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(SupersededError);
      const err = reason as SupersededError;
      expect(err.name).toBe('SupersededError');
      expect(err.newStartIndex).toBe(250);
      expect(indices).toContain(err.segmentIndex);
      // Message text deliberately unchanged — it is useful at debug level.
      expect(err.message).toBe(`segment ${err.segmentIndex} superseded by seek to 250`);
    }
  }, 40_000);

  /**
   * (j)–(l) cover supersedeWaiters()'s ABOVE-newStart half. Until 2026-07-23 it
   * only rejected waiters BELOW the new start_number, so a forward seek looked
   * fine and a BACKWARD seek stranded every already-issued forward request:
   * a run at seg173 can technically still reach seg389, but only after ~21.6
   * minutes of encoding, long past the waiter's own 30s timeout.
   *
   * These drive the real HlsSession rather than poking internals, because the
   * bug was invisible to unit-level reasoning — it only showed up as a receiver
   * holding 63 sockets open against a live server.
   */

  it('(j) BACKWARD seek-storm: far-ahead waiters are superseded, not left pending', async () => {
    const dir = await workdir('backstorm');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6); // 460 segments
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    // The exact seek targets from the 2026-07-23 hardware failure: one jump
    // forward, then monotonically backward — ten backward seeks in eleven
    // seconds. Issued in one tick so the 250ms debounce coalesces them, which
    // is what the scrub produced in practice.
    const indices = [339, 396, 394, 348, 324, 306, 268, 254, 216, 215, 183, 173];
    const FINAL = 173;
    const tracked = indices.map((i) =>
      s.getSegment(i).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
    );

    // Same tick: every request is parked as a waiter. Without this the test
    // could pass vacuously by never having created the pathology.
    expect(s.pendingWaiterIndices).toEqual([...indices].sort((a, b) => a - b));

    // Snapshot the map the instant the new run exists. launchAt() calls
    // supersedeWaiters(index) BEFORE it assigns currentRunStart, so runStart
    // flipping to 173 proves the supersede pass has already run — and seg173
    // itself cannot have landed yet (first-segment latency is ~0.5s here).
    while (s.runStart !== FINAL) await new Promise((r) => setTimeout(r, 5));
    const afterRestart = s.pendingWaiterIndices;

    // THE REGRESSION ASSERTION. Before the fix this array was all 11 stale
    // indices (185..389 in the field log), each holding a receiver connection
    // open for a full 30s before failing anyway.
    expect(afterRestart.filter((i) => i > FINAL + 3)).toEqual([]);
    // Nothing below either (there was nothing below in the field log; assert
    // the old guard still holds).
    expect(afterRestart.filter((i) => i < FINAL)).toEqual([]);

    const results = await Promise.all(tracked);

    // The final target — the request that triggered the restart — must survive.
    const last = results[indices.length - 1]!;
    expect(last.status).toBe('fulfilled');
    if (last.status === 'fulfilled') expect(existsSync(last.value)).toBe(true);
    expect(s.runStart).toBe(FINAL);
    expect(s.aliveFfmpegCount).toBe(1);

    // Every other request — all of them AHEAD of the new start — is rejected as
    // superseded. SupersededError specifically: MediaServer instanceof-detects
    // it to log at debug and keep these out of RouteStats.errors, which
    // diagnoseStall() quotes to the user. A bare Error would report a healthy
    // scrub as ~11 genuine faults.
    for (let k = 0; k < indices.length - 1; k++) {
      const r = results[k]!;
      expect(r.status, `index ${indices[k]} should have been superseded`).toBe('rejected');
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(SupersededError);
      const err = r.reason as SupersededError;
      expect(err.name).toBe('SupersededError');
      expect(err.segmentIndex).toBe(indices[k]);
      expect(err.newStartIndex).toBe(FINAL);
      // NOT a 30s timeout dressed up as a rejection — that is the buggy
      // outcome, and it produces a plain Error with this message.
      expect(err.message).toBe(`segment ${indices[k]} superseded by seek to ${FINAL}`);
    }
  }, 60_000);

  it('(k) read-ahead boundary: newStart, +1 and +3 survive a restart; +4 and beyond are superseded', async () => {
    const dir = await workdir('readahead');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    // scheduleRestart() is last-write-wins, so requesting these in one tick
    // parks five waiters and restarts at the LAST one (200). Offsets from 200:
    // +10 and +4 must go, +3 (exactly the NEAR_WINDOW allowance) +1 and 0 stay.
    const START = 200;
    const order = [START + 10, START + 4, START + 3, START + 1, START];
    const tracked = new Map(
      order.map((i) => [
        i,
        s.getSegment(i).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
      ]),
    );
    expect(s.pendingWaiterIndices).toEqual([...order].sort((a, b) => a - b));

    while (s.runStart !== START) await new Promise((r) => setTimeout(r, 5));
    const afterRestart = s.pendingWaiterIndices;

    // The boundary, both sides of it, and the trigger request itself.
    expect(afterRestart).toContain(START); // rejecting this breaks every seek
    expect(afterRestart).toContain(START + 1); // ordinary receiver read-ahead
    expect(afterRestart).toContain(START + 3); // exactly at the threshold
    expect(afterRestart).not.toContain(START + 4); // one past it
    expect(afterRestart).not.toContain(START + 10);

    for (const far of [START + 4, START + 10]) {
      const r = await tracked.get(far)!;
      expect(r.status, `seg${far} should have been superseded`).toBe('rejected');
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(SupersededError);
      expect((r.reason as SupersededError).newStartIndex).toBe(START);
    }

    // …and the survivors are genuinely served, not merely left parked: this is
    // the assertion that would fail if the threshold were set too aggressively.
    for (const near of [START, START + 1, START + 3]) {
      const r = await tracked.get(near)!;
      expect(r.status, `seg${near} must still be served after the restart`).toBe('fulfilled');
      if (r.status === 'fulfilled') expect(existsSync(r.value)).toBe(true);
    }
    expect(s.runStart).toBe(START);
  }, 60_000);

  it('(l) FORWARD seek still supersedes everything below the new start (unchanged)', async () => {
    const dir = await workdir('fwdstorm');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    const indices = [60, 120, 180, 240, 300];
    const FINAL = 300;
    const tracked = indices.map((i) =>
      s.getSegment(i).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
    );
    expect(s.pendingWaiterIndices).toEqual(indices);

    while (s.runStart !== FINAL) await new Promise((r) => setTimeout(r, 5));
    // Map drained down to the trigger request alone — the pre-existing
    // behaviour, asserted on the map rather than only on the rejections.
    expect(s.pendingWaiterIndices).toEqual([FINAL]);

    const results = await Promise.all(tracked);
    expect(results[4]!.status).toBe('fulfilled');
    for (let k = 0; k < 4; k++) {
      const r = results[k]!;
      expect(r.status).toBe('rejected');
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(SupersededError);
      expect((r.reason as SupersededError).newStartIndex).toBe(FINAL);
    }
    expect(s.aliveFfmpegCount).toBe(1);
  }, 60_000);

  /**
   * (m)–(o) cover the OTHER half of the seek-restart storm: a restart armed for
   * a request that no longer exists.
   *
   * Measured on the 2026-07-23 run-2 hardware trace: 38 of 60 ffmpeg launches
   * (63%) had NO live request for their target index at launch time, and 646 of
   * 1103 segment GETs were abandoned by the receiver while we were still
   * waiting — average hold 53ms, far inside the 250ms debounce. Verbatim:
   *
   *   15:13:33.241  seg350.ts -> 200 0B 9ms ABORTED   <- receiver gives up
   *   15:13:33.665  ffmpeg launched: run@seg350       <- we restart for it anyway
   *
   * …while the receiver had actually settled at 342 and was being served
   * 342/343/344 off disk in 1–2ms. The discriminator is hold time: a probe is
   * abandoned in ~50ms, a real playback request is held for over a second
   * (`seg380.ts -> 200 286700B 1362ms`). These tests pin the mechanism, not the
   * outcome — only hardware can say whether the receiver survives longer.
   */

  it('(m) an abandoned probe does not steer ffmpeg: the debounced restart is skipped', async () => {
    const dir = await workdir('abandon');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);
    const pidBefore = s.ffmpegPid;
    const launchedBefore = s.restartsLaunched;
    expect(s.runStart).toBe(0);

    // The receiver's scrub probe: ask for a far segment, then walk away well
    // inside the debounce window (measured hold on hardware: ~53ms).
    const ac = new AbortController();
    const probe = s.getSegment(200, ac.signal).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    // Not vacuous: the waiter really was parked before the client left.
    expect(s.pendingWaiterIndices).toContain(200);
    ac.abort();

    const r = await probe;
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toBeInstanceOf(RequestAbandonedError);
      const err = r.reason as RequestAbandonedError;
      expect(err.name).toBe('RequestAbandonedError');
      expect(err.segmentIndex).toBe(200);
      // NOT a SupersededError: nothing superseded it, the client left.
      expect(err).not.toBeInstanceOf(SupersededError);
    }
    // Dropping the waiter is what makes pickLaunchTarget() step over 200 below.
    expect(s.pendingWaiterIndices).not.toContain(200);

    await new Promise((res) => setTimeout(res, DEBOUNCE_MS * 3));

    // THE ASSERTION: the healthy run at seg0 was never killed for a request
    // that had already died. Before this fix the encoder would now be at 200.
    expect(s.runStart).toBe(0);
    expect(s.ffmpegPid).toBe(pidBefore);
    expect(s.restartsSkipped).toBe(1);
    expect(s.restartsLaunched).toBe(launchedBefore);
    expect(s.aliveFfmpegCount).toBe(1);
  }, 40_000);

  it('(n) a live request wins over a dead NEWER one', async () => {
    const dir = await workdir('livewins');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    // Both inside one debounce window: 100 is the seek the user settled on,
    // 200 is a probe the receiver abandons. Plain last-write-wins would launch
    // at 200 and leave the settled request waiting for ~10 minutes of encoding.
    const live = s.getSegment(100);
    const ac = new AbortController();
    const dead = s.getSegment(200, ac.signal).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    expect(s.pendingWaiterIndices).toEqual([100, 200]);
    ac.abort();

    const d = await dead;
    expect(d.status).toBe('rejected');
    if (d.status === 'rejected') expect(d.reason).toBeInstanceOf(RequestAbandonedError);

    // The launch lands on 100 — the newest index that still has a waiter.
    const served = await live;
    expect(existsSync(served)).toBe(true);
    expect(s.runStart).toBe(100);
    expect(s.restartsSkipped).toBe(0);
    expect(s.aliveFfmpegCount).toBe(1);
  }, 60_000);

  it('(o) an all-live burst is still last-wins (liveness must not reorder)', async () => {
    const dir = await workdir('livestorm');
    const m = media('foxtrot_mkv-h264-dts-45min.mkv', 2760, 'h264');
    m.audio[0] = { index: 1, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, isDefault: true };
    const bounds = fixedBoundaries(m.durationSec, 6);
    const s = newSession(m, plan({ kind: 'copy' }, { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 }, m.durationSec), bounds, dir);

    s.warmup();
    await s.getSegment(0);

    // Same shape as (e), but every request carries a signal that is NEVER
    // aborted. Walking the candidate list backwards must therefore behave
    // exactly as the old last-write-wins did.
    const indices = [50, 100, 150, 200, 250];
    const acs = indices.map(() => new AbortController());
    const results = await Promise.allSettled(indices.map((i, k) => s.getSegment(i, acs[k]!.signal)));

    expect(s.aliveFfmpegCount).toBe(1);
    expect(s.runStart).toBe(250);
    expect(s.restartsSkipped).toBe(0);
    expect(results[4]?.status).toBe('fulfilled');

    // Still SUPERSEDED, not abandoned — the engine dropped these for a newer
    // seek; the clients never went anywhere.
    for (const r of results.slice(0, 4)) {
      expect(r.status).toBe('rejected');
      const reason = (r as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(SupersededError);
      expect(reason).not.toBeInstanceOf(RequestAbandonedError);
      expect((reason as SupersededError).newStartIndex).toBe(250);
    }
  }, 40_000);

  it('(h) lifecycle timing: launch / init.mp4 ready / seg0 ready are logged at info with elapsed ms', async () => {
    const dir = await workdir('timing');
    const m = media('delta_mkv-h264-aac.mkv', 60.021, 'h264');
    const bounds = fixedBoundaries(m.durationSec, 6);

    const info: string[] = [];
    const sink: Logger = {
      level: 'info',
      error: () => undefined,
      warn: () => undefined,
      info: (...a: unknown[]) => info.push(a.map(String).join(' ')),
      debug: () => undefined,
      trace: () => undefined,
      child: () => sink,
    };
    const s = new HlsSession({
      media: m,
      plan: plan({ kind: 'copy' }, { kind: 'copy' }, m.durationSec),
      boundaries: bounds,
      input: m.path,
      workDir: dir,
      ff,
      logger: sink,
    });
    sessions.push(s);

    s.warmup();
    await s.getInitSegment();
    await s.getSegment(0);

    expect(info.some((l) => /ffmpeg launched: run@seg0/.test(l))).toBe(true);
    expect(info.some((l) => /init\.mp4 ready \+\d+ms after ffmpeg launch/.test(l))).toBe(true);
    // The first-segment latency line is the one that says whether a receiver starves.
    const seg0 = info.find((l) => /^seg0 ready \+\d+ms/.test(l));
    expect(seg0, `info lines were:\n${info.join('\n')}`).toBeDefined();
    expect(seg0).toContain('first-segment latency');
    // Remux tier baseline on this machine is ~50ms; a huge number means trouble.
    expect(Number(/\+(\d+)ms/.exec(seg0!)![1])).toBeLessThan(30_000);
  }, 40_000);

  it('(i) relative input: the spawned ffmpeg -i is absolutised (OPEN BUG #2)', async () => {
    const dir = await workdir('relinput');
    const m = media('delta_mkv-h264-aac.mkv', 60.021, 'h264');
    const bounds = fixedBoundaries(m.durationSec, 6);
    const rel = path.relative(process.cwd(), m.path);
    expect(path.isAbsolute(rel)).toBe(false);

    // FfmpegProcess logs `debug('spawn', <binary>, <args joined>)` — the same
    // logger-sink trick test (h) uses, here at debug level to see the argv.
    const spawns: string[][] = [];
    const sink: Logger = {
      level: 'debug',
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: (...a: unknown[]) => {
        if (a[0] === 'spawn') spawns.push(String(a[2]).split(' '));
      },
      trace: () => undefined,
      child: () => sink,
    };

    const s = new HlsSession({
      media: m,
      plan: plan({ kind: 'copy' }, { kind: 'copy' }, m.durationSec),
      boundaries: bounds,
      input: rel, // ← relative, as the documented CLI usage would produce
      workDir: dir,
      ff,
      logger: sink,
    });
    sessions.push(s);

    // ffmpeg's cwd is the temp workDir, so a relative -i would resolve against
    // it and die instantly (code 254) — these two landing files are the proof
    // that it did not, on top of the argv assertion below.
    await s.getInitSegment();
    expect(existsSync(await s.getSegment(0))).toBe(true);

    expect(spawns.length).toBeGreaterThanOrEqual(1);
    for (const argv of spawns) {
      const i = argv.indexOf('-i');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(path.isAbsolute(argv[i + 1]!)).toBe(true);
      expect(argv[i + 1]).toBe(m.path);
    }
  }, 30_000);

  // Budget note: the observed wall on an idle machine is ~19.0s, which left the
  // original 20s ceiling under 5% headroom and flaked twice under parallel load.
  // 30s still proves ≥1× realtime for 30s of 4K while surviving a busy machine.
  it('(g) transcode speed: 30s of 4K → hevc HLS in < 30s wall', async () => {
    const dir = await workdir('speed');
    const m = media('charlie_mp4-h264-l51-4k.mp4', 60, 'h264', 'none', { w: 3840, h: 2160 });
    const bounds = fixedBoundaries(m.durationSec, 6);
    const v: VideoAction = { kind: 'transcode', encoder: 'hevc_videotoolbox', quality: 55 };
    const s = newSession(m, plan(v, { kind: 'transcode', encoder: 'aac_at', bitrate: '256k', channels: 2 }, m.durationSec), bounds, dir);

    const t0 = Date.now();
    s.warmup();
    await s.getSegment(0);
    await s.getSegment(4); // segments 0..4 = 30s, produced sequentially (still in near window)
    const wall = Date.now() - t0;

    expect(existsSync(path.join(dir, 'seg4.m4s'))).toBe(true);
    expect(await probeSegment(dir, 'seg0.m4s', 'v:0', 'stream=codec_name')).toBe('hevc');
    expect(wall).toBeLessThan(30_000);
  }, 40_000);
});
